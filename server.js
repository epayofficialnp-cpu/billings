'use strict';
/* JKT Rod Billing – secure server. No npm packages needed (Node 20+).
   - Login required: billing app code is only sent to signed-in browsers
   - Passwords hashed with scrypt, never stored or sent in plain text
   - HttpOnly + SameSite=Strict session cookie, CSRF token, Origin check
   - Brute-force lockout, request rate limit, strict CSP + security headers
   - Data validated (whitelisted fields) and written atomically, with hourly snapshots */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt), E = process.env;

const PROD = E.NODE_ENV === 'production', PORT = +E.PORT || 3000;
const TRUST = E.TRUST_PROXY === '1', HOPS = Math.max(1, +E.TRUST_PROXY_HOPS || 1);
const DIR = path.resolve(E.DATA_DIR || path.join(__dirname, 'data'));
const IDLE = Math.max(1, +E.SESSION_DAYS || 7) * 864e5, ABS = 30 * 864e5;
const OCR = E.OCR_CDN !== 'off';
const HOSTS = (E.ALLOWED_HOSTS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const PUBLIC_ORIGIN = E.PUBLIC_URL ? new URL(E.PUBLIC_URL).origin : '';
const KDF = { N: 16384, r: 8, p: 1 };
const log = (...a) => console.log(new Date().toISOString(), ...a);

fs.mkdirSync(path.join(DIR, 'backups'), { recursive: true, mode: 0o700 });

/* ---------- files (read once at start; only whitelisted paths can ever be served) ---------- */
const rf = (d, f) => fs.readFileSync(path.join(__dirname, d, f));
const JS = 'text/javascript; charset=utf-8', CSS = 'text/css; charset=utf-8', HTML = 'text/html; charset=utf-8';
const PUB = { '/login.js': [rf('public', 'login.js'), JS], '/login.css': [rf('public', 'login.css'), CSS] };
const PRIV = { '/assets/app.js': [rf('private', 'app.js'), JS], '/assets/app.css': [rf('private', 'app.css'), CSS] };
const LOGIN_HTML = rf('public', 'login.html'), APP_HTML = rf('private', 'app.html');

const csp = ocr => ["default-src 'none'",
  "script-src 'self'" + (ocr ? " https://cdnjs.cloudflare.com https://cdn.jsdelivr.net 'wasm-unsafe-eval'" : ''),
  "style-src 'self'", "style-src-attr 'unsafe-inline'", "img-src 'self' blob: data:",
  "connect-src 'self'" + (ocr ? ' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://tessdata.projectnaptha.com' : ''),
  "worker-src 'self' blob:", "font-src 'self'", "base-uri 'none'", "form-action 'self'",
  "frame-ancestors 'none'", "object-src 'none'"].join('; ');
const CSP_LOGIN = csp(false), CSP_APP = csp(OCR);

/* ---------- storage ---------- */
const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } };
function writeJson(f, obj) {
  const p = path.join(DIR, f), t = p + '.tmp', fd = fs.openSync(t, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(t, p);
}

/* ---------- validation: only known fields, right types, sane sizes ---------- */
const bad = m => { const e = new Error(m); e.status = 422; throw e; };
const S = (v, max, req) => { if (typeof v !== 'string' || v.length > max || (req && !v.trim())) bad('Invalid text'); return v; };
const N = v => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e9) bad('Invalid number'); return v; };
const I = v => { if (!Number.isInteger(v) || v < 0 || v > 1e9) bad('Invalid counter'); return v; };
const CODE = /^[A-Z0-9_-]{1,20}$/, ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const D = v => { if (typeof v !== 'string' || !ISO.test(v)) bad('Invalid date'); return v; };
function clean(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.sizes) || !Array.isArray(d.bills)) bad('Missing data');
  if (d.sizes.length > 500 || d.bills.length > 100000) bad('Too many records');
  const codes = new Set(), nos = new Set();
  const sizes = d.sizes.map(z => {
    if (!z || typeof z !== 'object') bad('Bad size');
    const code = S(z.code, 20, 1); if (!CODE.test(code) || codes.has(code)) bad('Bad or duplicate rod code'); codes.add(code);
    const lg = z.log || []; if (!Array.isArray(lg) || lg.length > 5000) bad('Bad stock log');
    return { code, name: S(z.name, 60, 1), stock: N(z.stock), rate: N(z.rate || 0), w: N(z.w || 0),
      log: lg.map(l => { if (!l || typeof l !== 'object') bad('Bad log'); return { d: D(l.d), t: l.t === 'set' ? 'set' : 'in', kg: N(l.kg), ...(l.n !== undefined ? { n: S(l.n, 100) } : {}) }; }) };
  });
  const bills = d.bills.map(b => {
    if (!b || typeof b !== 'object' || !Array.isArray(b.items) || b.items.length > 300) bad('Bad bill');
    const no = I(b.no); if (nos.has(no)) bad('Duplicate bill number'); nos.add(no);
    return { no, date: D(b.date), cust: S(b.cust || 'Cash', 100), ph: S(b.ph || '', 30),
      pay: ['Cash', 'Online', 'Pending'].includes(b.pay) ? b.pay : 'Cash',
      items: b.items.map(i => { if (!i || typeof i !== 'object') bad('Bad item'); return { code: S(i.code, 20, 1), size: S(i.size, 60), kg: N(i.kg), rate: N(i.rate), amt: N(i.amt ?? +(i.kg * i.rate).toFixed(2)) }; }),
      kg: N(b.kg), total: N(b.total) };
  });
  return { shop: S(d.shop || 'JKT ROD BILLING', 80), addr: S(d.addr || '', 200), bn: I(d.bn ?? 1), cn: I(d.cn ?? 1), sizes, bills };
}
function freshState() {
  const sizes = [7, 8, 10, 12, 16, 20, 25].map((n, i) => ({ code: 'ROD-' + String(i + 1).padStart(3, '0'), name: `TMT ROD ${n} MM`, stock: 0, rate: 0, w: 0, log: [] }));
  return { rev: 1, data: { shop: 'JKT ROD BILLING', addr: '', bn: 1, cn: 8, sizes, bills: [] } };
}

/* ---------- accounts ---------- */
const okId = s => typeof s === 'string' && /^[A-Za-z0-9_.@-]{3,40}$/.test(s);
const WEAK = new Set(['password123', '1234567890', 'qwertyuiop', 'abcdefghij', 'password12', '0123456789']);
const pwErr = (pw, id) => typeof pw !== 'string' || pw.length < 10 ? 'Password must be at least 10 characters'
  : pw.length > 200 ? 'Password is too long' : (WEAK.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw) || pw.toLowerCase() === String(id).toLowerCase()) ? 'Password is too easy to guess' : '';
async function hashPw(pw, salt = crypto.randomBytes(16)) {
  return { salt: salt.toString('base64'), hash: (await scrypt(pw, salt, 64, KDF)).toString('base64') };
}
async function checkPw(pw, rec) {
  const h = await scrypt(String(pw).slice(0, 200), Buffer.from(rec.salt, 'base64'), 64, KDF), a = Buffer.from(rec.hash, 'base64');
  return a.length === h.length && crypto.timingSafeEqual(a, h);
}
const eq = (x, y) => { const a = Buffer.from(String(x)), b = Buffer.from(String(y)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

/* ---------- sessions (only a hash of the token is stored) ---------- */
const SESS = Object.assign(Object.create(null), readJson('sessions.json') || {});
const sh = t => crypto.createHash('sha256').update(t).digest('base64url');
let sessTimer;
const saveSess = () => { clearTimeout(sessTimer); sessTimer = setTimeout(() => { try { writeJson('sessions.json', SESS); } catch (e) { log('session save failed'); } }, 1000); };
function prune() { const n = Date.now(); for (const k in SESS) if (SESS[k].exp < n || SESS[k].abs < n) delete SESS[k]; }
const cookieName = secure => secure ? '__Host-jkt' : 'jkt';
function setCookie(res, secure, tok, ms) {
  res.setHeader('Set-Cookie', `${cookieName(secure)}=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(ms / 1000))}${secure ? '; Secure' : ''}`);
}
function getSession(req, res, secure) {
  const c = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) c[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  const tok = c['__Host-jkt'] || c['jkt']; if (!tok || tok.length > 100) return null;
  const key = sh(tok), s = SESS[key], now = Date.now();
  if (!s || s.exp < now || s.abs < now) { if (s) { delete SESS[key]; saveSess(); } return null; }
  if (now - s.t > 36e5) { s.t = now; s.exp = Math.min(now + IDLE, s.abs); setCookie(res, secure, tok, s.exp - now); saveSess(); }
  return { key, S: s };
}

/* ---------- abuse protection ---------- */
const fails = new Map(), hits = new Map();
const lockLeft = ip => { const f = fails.get(ip); return f && f.lock > Date.now() ? Math.ceil((f.lock - Date.now()) / 1000) : 0; };
function failed(ip) {
  const n = Date.now(); let f = fails.get(ip);
  if (!f || n - f.first > 9e5) f = { n: 0, first: n, lock: 0 };
  if (++f.n >= 5) f.lock = n + 9e5; fails.set(ip, f);
}
function hit(ip) { const n = Date.now(); let h = hits.get(ip); if (!h || n > h.reset) h = { c: 0, reset: n + 6e4 }; hits.set(ip, h); return ++h.c <= 240; }
setInterval(() => { const n = Date.now(); for (const [k, v] of fails) if (v.lock < n && n - v.first > 9e5) fails.delete(k); for (const [k, v] of hits) if (n > v.reset) hits.delete(k); prune(); }, 6e4).unref();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- request helpers ---------- */
function clientIp(req) {
  if (TRUST) { const p = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); if (p.length) return p[Math.max(0, p.length - HOPS)]; }
  return req.socket.remoteAddress || '?';
}
const isSecure = req => !!req.socket.encrypted || (TRUST && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
function hdr(res, secure) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', CSP_LOGIN);
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
function send(res, code, body, type, extra) {
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra }); res.end(body);
}
const json = (res, code, o, extra) => send(res, code, JSON.stringify(o), 'application/json; charset=utf-8', extra);
const httpErr = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
function body(req, limit = 8e6) {
  return new Promise((ok, no) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return no(httpErr(415, 'JSON only'));
    let n = 0, over = false; const c = [];
    req.on('data', d => { n += d.length; if (n > limit) over = true; else c.push(d); });
    req.on('end', () => { if (over) return no(httpErr(413, 'Too large')); try { ok(JSON.parse(Buffer.concat(c).toString('utf8') || '{}')); } catch { no(httpErr(400, 'Bad JSON')); } });
    req.on('error', no);
  });
}
function originOk(req) {
  const o = req.headers.origin; if (!o) return false;
  try { const u = new URL(o); return PUBLIC_ORIGIN ? u.origin === PUBLIC_ORIGIN : u.host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
}

/* ---------- state ---------- */
let AUTH = readJson('auth.json'), ST = readJson('state.json');
function saveState(next) {
  const hr = new Date().toISOString().slice(0, 13).replace(/\D/g, ''), snap = path.join(DIR, 'backups', `state-${hr}.json`);
  try {
    if (!fs.existsSync(snap)) {
      fs.writeFileSync(snap, JSON.stringify(ST), { mode: 0o600 });
      const all = fs.readdirSync(path.join(DIR, 'backups')).filter(f => f.startsWith('state-')).sort();
      all.slice(0, Math.max(0, all.length - 100)).forEach(f => fs.unlinkSync(path.join(DIR, 'backups', f)));
    }
  } catch (e) { log('snapshot failed', e.message); }
  writeJson('state.json', next); ST = next;
}

/* ---------- routes ---------- */
async function api(req, res, p, m, ip, secure, sess) {
  if (p === '/api/me' && m === 'GET') return json(res, 200, sess ? { authed: true, csrf: sess.S.csrf } : { authed: false });

  if (p === '/api/login' && m === 'POST') {
    const wait = lockLeft(ip);
    if (wait) return json(res, 429, { error: `Too many wrong attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` }, { 'Retry-After': String(wait) });
    const b = await body(req, 5e3), idOk = typeof b.id === 'string' && b.id.toLowerCase() === AUTH.id.toLowerCase();
    const good = (await checkPw(b.password ?? '', idOk ? AUTH : DUMMY)) && idOk;
    if (!good) { failed(ip); log('LOGIN FAIL', ip); await sleep(300 + Math.random() * 300); return json(res, 401, { error: 'Wrong ID or password' }); }
    fails.delete(ip); log('LOGIN OK', ip);
    const tok = crypto.randomBytes(32).toString('base64url'), now = Date.now();
    SESS[sh(tok)] = { exp: now + IDLE, abs: now + ABS, t: now, csrf: crypto.randomBytes(24).toString('base64url') };
    const keys = Object.keys(SESS).sort((a, b2) => SESS[a].t - SESS[b2].t); while (keys.length > 20) delete SESS[keys.shift()];
    saveSess(); setCookie(res, secure, tok, IDLE); return json(res, 200, { ok: true });
  }

  if (!sess) return json(res, 401, { error: 'Please sign in' });
  if (m !== 'GET' && !eq(req.headers['x-csrf-token'] || '', sess.S.csrf)) return json(res, 403, { error: 'Security check failed. Refresh the page.' });

  if (p === '/api/logout' && m === 'POST') { delete SESS[sess.key]; saveSess(); setCookie(res, secure, '', 0); return json(res, 200, { ok: true }); }
  if (p === '/api/rev' && m === 'GET') return json(res, 200, { rev: ST.rev });
  if (p === '/api/state' && m === 'GET') return json(res, 200, ST);
  if (p === '/api/state' && m === 'PUT') {
    const b = await body(req), data = clean(b.data);
    if (b.rev !== ST.rev) return json(res, 409, { error: 'Data changed on another device', rev: ST.rev, data: ST.data });
    saveState({ rev: ST.rev + 1, data }); return json(res, 200, { rev: ST.rev });
  }
  if (p === '/api/password' && m === 'POST') {
    const wait = lockLeft(ip); if (wait) return json(res, 429, { error: 'Too many wrong attempts. Try later.' });
    const b = await body(req, 5e3);
    if (!(await checkPw(b.current ?? '', AUTH))) { failed(ip); await sleep(400); return json(res, 403, { error: 'Current password is wrong' }); }
    const rec = { ...AUTH };
    if (b.newId) { if (!okId(b.newId)) return json(res, 422, { error: 'ID: 3-40 letters, numbers or . _ @ -' }); rec.id = b.newId; }
    if (b.newPassword) { const e = pwErr(b.newPassword, rec.id); if (e) return json(res, 422, { error: e }); Object.assign(rec, await hashPw(b.newPassword)); }
    AUTH = rec; writeJson('auth.json', AUTH);
    for (const k in SESS) if (k !== sess.key) delete SESS[k]; saveSess(); log('LOGIN CHANGED', ip);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found' });
}

async function handle(req, res) {
  const secure = isSecure(req), ip = clientIp(req), host = String(req.headers.host || '').toLowerCase();
  hdr(res, secure);
  if (HOSTS.length && !HOSTS.includes(host.split(':')[0])) return send(res, 421, 'Misdirected request', 'text/plain');
  const p = new URL(req.url, 'http://x').pathname, m = req.method;
  if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (PROD && TRUST && E.FORCE_HTTPS !== '0' && !secure) return send(res, 308, '', 'text/plain', { Location: 'https://' + host + req.url });
  if (!hit(ip)) return json(res, 429, { error: 'Too many requests' }, { 'Retry-After': '60' });
  if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain');
  if (p === '/favicon.ico') return send(res, 204, '', 'image/x-icon');
  const safe = m === 'GET' || m === 'HEAD';
  if (!safe && !originOk(req)) return json(res, 403, { error: 'Request blocked' });
  const sess = getSession(req, res, secure);
  if (p.startsWith('/api/')) return api(req, res, p, m, ip, secure, sess);
  if (!safe) return send(res, 405, 'Method not allowed', 'text/plain');
  if (p === '/' || p === '/index.html') {
    if (sess) { res.setHeader('Content-Security-Policy', CSP_APP); return send(res, 200, APP_HTML, HTML); }
    return send(res, 200, LOGIN_HTML, HTML);
  }
  const f = PUB[p] || (sess && PRIV[p]);
  if (f) { if (PRIV[p]) res.setHeader('Content-Security-Policy', CSP_APP); return send(res, 200, f[0], f[1]); }
  send(res, 404, 'Not found', 'text/plain');
}

/* ---------- start ---------- */
let DUMMY;
(async () => {
  DUMMY = await hashPw('not-a-real-password');
  if (!AUTH) {
    const id = E.ADMIN_ID, pw = E.ADMIN_PASSWORD;
    if (!okId(id) || pwErr(pw, id)) { console.error('FIRST RUN: set ADMIN_ID (3-40 chars) and ADMIN_PASSWORD (10+ chars) environment variables, then start again.'); process.exit(1); }
    AUTH = { id, ...(await hashPw(pw)) }; writeJson('auth.json', AUTH); log('Admin account created. Remove ADMIN_PASSWORD from the environment now.');
  }
  if (E.RESET_ADMIN_PASSWORD) {
    const e = pwErr(E.RESET_ADMIN_PASSWORD, AUTH.id);
    if (e) { console.error('RESET_ADMIN_PASSWORD rejected: ' + e); process.exit(1); }
    AUTH = { id: AUTH.id, ...(await hashPw(E.RESET_ADMIN_PASSWORD)) }; writeJson('auth.json', AUTH);
    for (const k in SESS) delete SESS[k]; writeJson('sessions.json', SESS);
    log('Password reset done. REMOVE the RESET_ADMIN_PASSWORD variable now and restart.');
  }
  if (!ST) { ST = freshState(); writeJson('state.json', ST); }
  prune();
  const srv = http.createServer({ maxHeaderSize: 16384 }, (req, res) =>
    handle(req, res).catch(e => {
      if (!e.status) log('ERROR', e && e.stack);
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error' }, e.status === 413 ? { Connection: 'close' } : undefined);
    }));
  srv.requestTimeout = 30000; srv.headersTimeout = 15000; srv.keepAliveTimeout = 5000;
  srv.listen(PORT, () => log(`JKT Rod Billing running on port ${PORT} (${PROD ? 'production' : 'development'})`));
  const bye = () => { try { writeJson('sessions.json', SESS); } catch {} process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
})();
process.on('uncaughtException', e => { log('FATAL', e && e.stack); process.exit(1); });
process.on('unhandledRejection', e => { log('FATAL', e && e.stack || e); process.exit(1); });
