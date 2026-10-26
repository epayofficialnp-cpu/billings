const $=s=>document.querySelector(s),Q=s=>[...document.querySelectorAll(s)],
esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let DB,editNo=null;

const PRE=[6,7,8,10,12,16,20,25,28,32],PAY={Cash:'Cash',Online:'Online',Pending:'Not paid (Pending)'};
const pn=n=>'TMT ROD '+n+' MM';
function addSize(n,st,rt,code,w){
  code=(code||'').trim().toUpperCase();
  if(!code){do{code='ROD-'+String(DB.cn++).padStart(3,'0')}while(DB.sizes.some(z=>z.code==code))}
  DB.sizes.push({code,name:n.trim().toUpperCase(),stock:+st||0,rate:+rt||0,w:+w||0,log:[]});
}
const CODE=/^[A-Z0-9_-]{1,20}$/;
let CSRF='',REV=0,TAB='bill',saving=false,dirty=false,wt=null;

/* ---------- server connection ---------- */
async function api(method,url,body){
  const r=await fetch(url,{method,credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json','X-CSRF-Token':CSRF},body:body?JSON.stringify(body):undefined});
  if(r.status===401){location.reload();throw new Error('signed out')}
  const j=await r.json().catch(()=>({}));
  return{ok:r.ok,status:r.status,j};
}
function norm(d){
  d.sizes=d.sizes||[];d.bills=d.bills||[];
  d.sizes.forEach(z=>{z.log=z.log||[];z.w=z.w||0;z.name=z.name.toUpperCase();const m=/^(?:TMT ROD\s*)?(\d+(?:\.\d+)?)\s*(?:MM)?$/i.exec(z.name);if(m)z.name=pn(m[1])});
  if(!d.shop||d.shop=='JKT ESTIMATE')d.shop='JKT ROD BILLING';d.addr=d.addr||'';
  return d;
}
function setFs(s,m){
  const e=$('#fs');if(!e)return;
  e.textContent=s=='ok'?'☁ Saved on server':s=='saving'?'Saving…':'⚠ '+(m||'Not saved – check internet');
  e.classList.toggle('neg',s=='err');
}
let tt=null;
function toast(m){const t=$('#toast');t.textContent=m;t.hidden=false;clearTimeout(tt);tt=setTimeout(()=>t.hidden=true,7000)}
function sv(){dirty=true;setFs('saving');clearTimeout(wt);wt=setTimeout(flush,250)}
async function flush(){
  if(saving||!dirty)return;saving=true;dirty=false;
  try{
    const r=await api('PUT','/api/state',{rev:REV,data:DB});
    if(r.ok){REV=r.j.rev;setFs('ok')}
    else if(r.status==409){DB=norm(r.j.data);REV=r.j.rev;setFs('ok');refresh();toast('Another device changed the data. The latest data is loaded – please check and repeat your last step.')}
    else if(r.status==403||r.status==429||r.status>=500){dirty=true;setFs('err',r.j.error)}
    else setFs('err',r.j.error||'Save rejected');
  }catch(e){dirty=true;setFs('err')}
  saving=false;
  if(dirty){clearTimeout(wt);wt=setTimeout(flush,4000)}
}
function refresh(){
  sortSizes();
  if(TAB=='dash')dash();
  else if(TAB=='bill'){rl();calc()}
  else if(TAB=='stock'){const a=document.activeElement;if(!a||!a.closest||!a.closest('#t_stock'))rs()}
}
async function poll(){
  if(document.hidden||saving||dirty)return;
  try{
    const r=await api('GET','/api/rev');
    if(r.ok&&r.j.rev!==REV){const s=await api('GET','/api/state');if(s.ok&&!dirty&&!saving){DB=norm(s.j.data);REV=s.j.rev;refresh()}}
  }catch(e){}
}
setInterval(poll,3000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll()});
addEventListener('beforeunload',e=>{if(dirty||saving){e.preventDefault();e.returnValue=''}});
async function logout(){try{await api('POST','/api/logout',{})}catch(e){}location.reload()}

/* ---------- tabs ---------- */
function show(t){TAB=t;
  ['dash','bill','stock','set'].forEach(x=>{$('#t_'+x).hidden=x!=t;$('#b_'+x).classList.toggle('on',x==t)});
  if(t=='stock')rs();
  if(t=='dash')dash();
  if(t=='bill'){rl();calc()}
  if(t=='set'){$('#sn').value=DB.shop;$('#sa').value=DB.addr||''}
}

/* ---------- billing ---------- */
const num=n=>{const m=String(n).match(/\d+(\.\d+)?/);return m?+m[0]:1e9};
function sortSizes(){DB.sizes.sort((a,b)=>num(a.name)-num(b.name)||a.name.localeCompare(b.name))}
function zc(c){return DB.sizes.find(z=>z.code==c)}
function oldQty(c){const o=editNo&&DB.bills.find(b=>b.no==editNo);return o?o.items.filter(i=>i.code==c).reduce((a,i)=>a+i.kg,0):0}
function rowCode(inp){
  const v=inp.value.trim().toLowerCase(),z=DB.sizes.find(z=>z.name.toLowerCase()==v);
  inp.dataset.code=z?z.code:'';return inp.dataset.code;
}
function used(){const u={};Q('#rows tr').forEach(r=>{const c=rowCode(r.querySelector('.sz')),w=+r.querySelector('.kg').value||0;if(c)u[c]=(u[c]||0)+w});return u}
function left(c,u){const z=zc(c);return z?z.stock+oldQty(c)-((u||used())[c]||0):0}

let SG={inp:null,list:[],i:0,moved:0};
function matches(q){
  const t=q.toLowerCase().split(/\s+/).filter(Boolean);
  if(!t.length)return DB.sizes.slice();
  return DB.sizes.filter(z=>{const w=(z.name+' '+z.code).toLowerCase().split(/[\s-]+/);return t.every(x=>w.some(y=>y.startsWith(x)))});
}
function fk(tr){const k=tr.querySelector('.kg');k.focus();k.select()}
function hideSg(){$('#sgb').hidden=true}
function showSg(inp){
  SG={inp,list:matches(inp.value),i:0,moved:0};
  const b=$('#sgb');if(!SG.list.length){b.hidden=true;return}
  const u=used(),r=inp.getBoundingClientRect();
  b.style.left=r.left+'px';b.style.top=(r.bottom+2)+'px';b.style.minWidth=r.width+'px';
  b.innerHTML=SG.list.map((z,k)=>`<div data-c="${esc(z.code)}" class="${k?'':'on'}"><span>${esc(z.name)}</span><small>${left(z.code,u).toFixed(2)} kg</small></div>`).join('');
  b.hidden=false;
}
function mv(d){
  const c=$('#sgb').children;if(!c.length)return;
  c[SG.i].classList.remove('on');SG.i=(SG.i+d+c.length)%c.length;
  c[SG.i].classList.add('on');c[SG.i].scrollIntoView({block:'nearest'});SG.moved=1;
}
function pick(inp,c){
  const z=zc(c);if(!z)return;
  inp.value=z.name;inp.dataset.code=c;
  const tr=inp.closest('tr');if(z.rate)tr.querySelector('.rt').value=z.rate;if(z.w)tr.querySelector('.kg').value=z.w;
  hideSg();calc();
}
$('#sgb').addEventListener('mousedown',e=>{
  e.preventDefault();const d=e.target.closest('div[data-c]');
  if(d&&SG.inp){pick(SG.inp,d.dataset.c);fk(SG.inp.closest('tr'))}
});
addEventListener('scroll',e=>{if(e.target===document)hideSg()},true);

function addRow(it){
  const tr=document.createElement('tr'),z=it&&zc(it.code);
  tr.innerHTML=`<td><input class="sz" placeholder="Type size e.g. 7 or TMT" autocomplete="off" value="${z?esc(z.name):''}"></td><td><input class="kg" type="number" step="any" min="0" value="${it?it.kg:''}"></td><td><input class="rt" type="number" step="any" min="0" value="${it?it.rate:''}"></td><td class="am">0.00</td><td class="lf">–</td><td><button class="dg" tabindex="-1">✕</button></td>`;
  $('#rows').appendChild(tr);
  const s=tr.querySelector('.sz');
  s.oninput=()=>showSg(s);
  s.onfocus=()=>showSg(s);
  s.onblur=()=>setTimeout(()=>{if(SG.inp===s)hideSg();calc()},150);
  tr.oninput=calc;
  tr.querySelector('button').onclick=()=>{tr.remove();if(!$('#rows').children.length)addRow();calc()};
  return tr;
}
function calc(){
  let k=0,t=0;const u=used();
  Q('#rows tr').forEach(r=>{
    const c=rowCode(r.querySelector('.sz')),w=+r.querySelector('.kg').value||0,p=+r.querySelector('.rt').value||0,l=r.querySelector('.lf');
    r.querySelector('.am').textContent=(w*p).toFixed(2);k+=w;t+=w*p;
    if(c){const v=left(c,u);l.textContent=v.toFixed(2)+' kg';l.className='lf'+(v<-1e-9?' neg':'')}else{l.textContent='–';l.className='lf'}
  });
  $('#tk').textContent=k.toFixed(2);$('#ta').textContent=t.toFixed(2);
  $('#ls').innerHTML=DB.sizes.map(z=>{const v=left(z.code,u);return `<span class="chip${v<-1e-9?' neg':''}${u[z.code]?' use':''}">${esc(z.name)}: <b>${v.toFixed(2)}</b></span>`}).join('');
}
function newBill(){
  editNo=null;$('#cn').value=$('#cp').value='';$('#py').value='Cash';$('#rows').innerHTML='';addRow();calc();
  $('#bt').textContent='New Bill #'+DB.bn;$('#sb').textContent='Save Bill';
}
/* Enter = next box */
$('#t_bill').addEventListener('keydown',e=>{
  const t=e.target;
  if(e.key=='Enter'&&e.ctrlKey){e.preventDefault();return saveBill()}
  if(t.classList&&t.classList.contains('sz')){
    const open=!$('#sgb').hidden&&SG.list.length;
    if(e.key=='ArrowDown'||e.key=='ArrowUp'){e.preventDefault();if(!open)showSg(t);else mv(e.key=='ArrowDown'?1:-1);return}
    if(e.key=='Escape'){hideSg();return}
    if(e.key=='Enter'){
      e.preventDefault();
      if(open&&(t.value.trim()||SG.moved))pick(t,SG.list[SG.i].code);
      if(!rowCode(t))return;
      fk(t.closest('tr'));return;
    }
  }
  if(e.key!='Enter'||!/INPUT|SELECT/.test(t.tagName)||t.id=='sq')return;
  e.preventDefault();
  const l=Q('#cn,#cp,#py,#rows .sz,#rows .kg,#rows .rt'),i=l.indexOf(t);
  if(i<l.length-1)l[i+1].focus();
  else addRow().querySelector('.sz').focus();
});
function saveBill(pf){
  let bad='';
  const items=Q('#rows tr').map(r=>{
    const inp=r.querySelector('.sz'),c=rowCode(inp),z=zc(c),kg=+r.querySelector('.kg').value||0,rate=+r.querySelector('.rt').value||0;
    if(inp.value.trim()&&!z)bad=inp.value.trim();
    return z&&kg>0?{code:c,size:z.name,kg,rate,amt:+(kg*rate).toFixed(2)}:null;
  }).filter(Boolean);
  if(bad)return alert('Size "'+bad+'" not found. Pick it from the list.');
  if(!items.length)return alert('Enter rod size and weight');
  const old=editNo?DB.bills.find(b=>b.no==editNo):null,av={};
  DB.sizes.forEach(s=>av[s.code]=s.stock);
  if(old)old.items.forEach(i=>{if(i.code in av)av[i.code]+=i.kg});
  for(const i of items){
    av[i.code]-=i.kg;
    if(av[i.code]<-1e-9)return alert('Not enough stock for '+i.size+'. Short by '+(-av[i.code]).toFixed(2)+' kg');
  }
  DB.sizes.forEach(s=>s.stock=+av[s.code].toFixed(3));
  const b={no:old?old.no:DB.bn++,date:old?old.date:new Date().toISOString(),cust:$('#cn').value.trim()||'Cash',ph:$('#cp').value.trim(),pay:$('#py').value,items,
    kg:+items.reduce((a,i)=>a+i.kg,0).toFixed(3),total:+items.reduce((a,i)=>a+i.amt,0).toFixed(2)};
  if(old)Object.assign(old,b);else DB.bills.unshift(b);
  sv();newBill();rl();if(pf)pr(b.no);
}

/* ---------- saved bills ---------- */
function rl(){
  const q=($('#sq').value||'').toLowerCase();
  $('#bl').innerHTML=DB.bills.filter(b=>(b.cust+' '+b.no+' '+(PAY[b.pay]||'')).toLowerCase().includes(q)).map(b=>
    `<tr tabindex="0" data-no="${b.no}"><td>#${b.no}</td><td>${new Date(b.date).toLocaleString()}</td><td>${esc(b.cust)}</td><td>${b.kg}</td><td>${b.total.toFixed(2)}</td><td class="${b.pay=='Pending'?'neg':''}">${PAY[b.pay]||'–'}</td><td class="ac"><button data-act="pr" data-no="${b.no}">Print</button><button data-act="ed" data-no="${b.no}">Edit</button><button class="dg" data-act="del" data-no="${b.no}">Delete</button></td></tr>`
  ).join('')||'<tr><td colspan="7">No bills yet</td></tr>';
}
$('#bl').addEventListener('keydown',e=>{
  const r=e.target.closest('tr');if(!r||e.target.tagName=='BUTTON')return;
  if(e.key=='ArrowDown'){e.preventDefault();r.nextElementSibling&&r.nextElementSibling.focus()}
  else if(e.key=='ArrowUp'){e.preventDefault();r.previousElementSibling&&r.previousElementSibling.focus()}
  else if(e.key=='Enter'&&r.dataset.no)ed(+r.dataset.no);
});
function ed(no){
  const b=DB.bills.find(b=>b.no==no);if(!b)return;
  editNo=no;$('#cn').value=b.cust;$('#cp').value=b.ph;$('#py').value=b.pay||'Cash';$('#rows').innerHTML='';
  b.items.forEach(i=>addRow(i));calc();
  $('#bt').textContent='Editing Bill #'+no;$('#sb').textContent='Update Bill #'+no;
  scrollTo({top:0,behavior:'smooth'});
}
function del(no){
  const b=DB.bills.find(b=>b.no==no);if(!b)return;
  if(!confirm('Delete bill #'+no+' permanently?'))return;
  if(confirm('Return the billed weight to stock?'))b.items.forEach(i=>{const z=DB.sizes.find(z=>z.code==i.code);if(z)z.stock=+(z.stock+i.kg).toFixed(3)});
  DB.bills=DB.bills.filter(x=>x.no!=no);sv();if(editNo==no)newBill();rl();
}
function words(n){
  const a=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'],
  t=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'],
  two=x=>x<20?a[x]:t[(x/10)|0]+(x%10?' '+a[x%10]:''),
  th=x=>(x>99?a[(x/100)|0]+' Hundred'+(x%100?' ':''):'')+(x%100?two(x%100):'');
  if(!n)return 'Zero Rupees Only';
  const cr=(n/1e7)|0,la=((n%1e7)/1e5)|0,tk=((n%1e5)/1e3)|0,r=n%1e3;let o='';
  if(cr)o+=th(cr)+' Crore ';if(la)o+=two(la)+' Lakh ';if(tk)o+=two(tk)+' Thousand ';if(r)o+=th(r);
  return 'Rupees '+o.trim()+' Only';
}
function pr(no){
  const b=DB.bills.find(b=>b.no==no);if(!b)return;
  const pend=b.pay=='Pending',f2=x=>(+x).toFixed(2);
  const rows=b.items.map((i,n)=>`<tr><td>${n+1}</td><td>${esc(i.size)}</td><td>${f2(i.kg)}</td><td>${f2(i.rate)}</td><td>${f2(i.amt)}</td></tr>`).join('')
    +'<tr class="e"><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(Math.max(0,8-b.items.length));
  $('#pa').innerHTML=`<div class="ph"><h1>${esc(DB.shop)}</h1><div>${esc(DB.addr||'')}</div><div class="tt">ESTIMATE / BILL</div></div>
  <div class="pm"><div><b>Customer:</b> ${esc(b.cust)}<br><b>Phone:</b> ${esc(b.ph||'-')}</div><div style="text-align:right"><b>Date:</b> ${new Date(b.date).toLocaleString()}</div></div>
  <table class="pt"><thead><tr><th style="width:36px">#</th><th>Description</th><th style="width:90px">Weight (kg)</th><th style="width:90px">Rate (₹/kg)</th><th style="width:100px">Amount (₹)</th></tr></thead><tbody>${rows}</tbody>
  <tfoot><tr><td colspan="2">Total</td><td>${f2(b.kg)}</td><td></td><td>${f2(b.total)}</td></tr></tfoot></table>
  <div class="pw"><b>Amount in words:</b> ${words(Math.round(b.total))}</div>
  <div class="pf"><div><b>Payment mode:</b> ${PAY[b.pay]||'-'}<br><b>Status:</b> <span class="st ${pend?'PENDING':'PAID'}">${pend?'PENDING':'PAID'}</span></div><div class="gt">Grand Total<br><span>₹ ${f2(b.total)}</span></div></div>
  <div class="ps"><div>For ${esc(DB.shop)}<br>Authorised signatory</div></div>
  <div class="pn">Goods once sold will not be taken back. Thank you for your business!</div>`;
  window.print();
}

/* ---------- stock ---------- */
let openL=-1;
function ledger(s){
  const r=[...(s.log||[]).map(x=>({d:x.d,a:x.t=='in'?'Stock added'+(x.n?' – '+esc(x.n):''):'Stock set to '+x.kg+' kg',c:x.t=='in'?'+'+x.kg:''})),
    ...DB.bills.flatMap(b=>b.items.filter(i=>i.code==s.code).map(i=>({d:b.date,a:'Bill #'+b.no+' – '+esc(b.cust),c:'-'+i.kg})))]
    .sort((a,b)=>a.d<b.d?1:-1);
  return `<b>${esc(s.name)} · ${esc(s.code)} · available ${s.stock.toFixed(2)} kg</b><table><tr><th>Date</th><th>Detail</th><th>Kg</th></tr>`+
    (r.map(x=>`<tr><td>${new Date(x.d).toLocaleString()}</td><td>${x.a}</td><td>${x.c}</td></tr>`).join('')||'<tr><td colspan="3">No entries yet</td></tr>')+'</table>';
}
function rs(){
  sortSizes();
  $('#zp').innerHTML=PRE.map(n=>`<option value="${pn(n)}">`).join('');
  const ov=$('#oz').value;$('#oz').innerHTML=DB.sizes.map(z=>`<option value="${esc(z.code)}">${esc(z.name)} (${esc(z.code)})</option>`).join('');if(ov)$('#oz').value=ov;
  const q=($('#zs').value||'').trim().toLowerCase();
  $('#sl').innerHTML=DB.sizes.map((s,i)=>[s,i]).filter(([s])=>!q||(s.name+' '+s.code).toLowerCase().includes(q)).map(([s,i])=>`<tr><td><input value="${esc(s.code)}" data-chg="rc" data-i="${i}" style="width:95px;text-transform:uppercase"></td><td><input value="${esc(s.name)}" data-chg="rn" data-i="${i}" style="text-transform:uppercase"></td><td><input type="number" step="any" value="${s.w||''}" data-chg="sw" data-i="${i}" style="width:75px"></td><td><input type="number" step="any" value="${s.rate}" data-chg="sr" data-i="${i}" style="width:75px"></td><td><b>${s.stock.toFixed(2)}</b> kg</td><td><input type="number" step="any" id="k${i}" placeholder="kg" style="width:85px"></td><td class="ac"><button data-act="sadd" data-i="${i}">+ Add</button><button data-act="sset" data-i="${i}">Set</button><button data-act="hist" data-i="${i}">History</button><button class="dg" data-act="dz" data-i="${i}">Delete</button></td></tr>${openL==i?`<tr><td colspan="7">${ledger(s)}</td></tr>`:''}`).join('')||'<tr><td colspan="7">No matching size</td></tr>';
}
function rn(i,v){v=v.trim().toUpperCase();if(v){DB.sizes[i].name=v;sv()}openL=-1;rs()}
function rc(i,v){
  v=v.trim().toUpperCase();const z=DB.sizes[i];
  if(!v||v==z.code){rs();return}
  if(!CODE.test(v)){alert('Rod code: use only A-Z, 0-9, - or _ (max 20 characters)');rs();return}
  if(DB.sizes.some((x,j)=>j!=i&&x.code==v)){alert('Code '+v+' is already used');rs();return}
  DB.bills.forEach(b=>b.items.forEach(it=>{if(it.code==z.code)it.code=v}));
  z.code=v;sv();rs();
}
function st(i,add){
  const v=parseFloat($('#k'+i).value);if(isNaN(v))return;
  const z=DB.sizes[i];z.stock=+(add?z.stock+v:v).toFixed(3);
  z.log.push({d:new Date().toISOString(),t:add?'in':'set',kg:v});sv();rs();
}
function dz(i){if(confirm('Delete size '+DB.sizes[i].name+'?')){DB.sizes.splice(i,1);openL=-1;sv();rs()}}
function az(){
  const n=$('#zn').value.trim().toUpperCase(),c=$('#zcode').value.trim().toUpperCase();if(!n)return;
  if(n.length>60)return alert('Size name is too long');
  if(c&&!CODE.test(c))return alert('Rod code: use only A-Z, 0-9, - or _ (max 20 characters)');
  if(DB.sizes.some(z=>z.name==n))return alert('This size already exists');
  if(c&&DB.sizes.some(z=>z.code==c))return alert('Code '+c+' is already used');
  const k=+$('#zk').value||0;addSize(n,k,$('#zr').value,c,$('#zw').value);
  if(k>0)DB.sizes[DB.sizes.length-1].log.push({d:new Date().toISOString(),t:'in',kg:k});
  sv();['zn','zcode','zw','zk','zr'].forEach(x=>$('#'+x).value='');openL=-1;rs();
}
function addPresets(){
  PRE.forEach(n=>{if(!DB.sizes.some(z=>z.name==pn(n)))addSize(pn(n),0,0)});
  sv();rs();
}

/* ---------- image weights ---------- */
function oimg(i){const f=i.files[0],m=$('#oi');if(f){m.src=URL.createObjectURL(f);m.style.display='block'}$('#ores').hidden=true;$('#os').textContent=''}
function osum(){
  const v=$('#otx').value.split(/\s+/).map(parseFloat).filter(x=>!isNaN(x));
  $('#ocnt').textContent=v.length;$('#otot').textContent=v.reduce((a,b)=>a+b,0).toFixed(2);return v;
}
function loadOcr(){return new Promise((ok,no)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js';s.onload=ok;s.onerror=no;document.head.appendChild(s)})}
async function ocr(){
  const f=$('#of').files[0];if(!f)return alert('Choose an image first');
  if(typeof Tesseract=='undefined'){try{await loadOcr()}catch(e){return alert('The image reader could not load (it needs internet, and the server must allow it).')}}
  $('#ob').disabled=true;$('#os').textContent='Reading image… 0%';
  try{
    const r=await Tesseract.recognize(f,'eng',{logger:m=>{if(m.status=='recognizing text')$('#os').textContent='Reading image… '+Math.round(m.progress*100)+'%'}});
    const n=r.data.text.replace(/(\d),(\d{3})(?!\d)/g,'$1$2').match(/\d+(?:\.\d+)?/g)||[];
    $('#otx').value=n.join('\n');$('#ores').hidden=false;osum();
    $('#os').textContent=n.length?'Check the numbers below. Delete any that are not weights, fix any misread, then add to stock.':'No numbers found. Try a clearer, closer photo.';
  }catch(e){$('#os').textContent='Could not read the image.'}
  $('#ob').disabled=false;
}
function oadd(){
  const v=osum(),t=v.reduce((a,b)=>a+b,0),z=zc($('#oz').value);
  if(!z||t<=0)return alert('Select a size and make sure there are weights');
  if(!confirm('Add '+t.toFixed(2)+' kg to '+z.name+'?'))return;
  z.stock=+(z.stock+t).toFixed(3);z.log.push({d:new Date().toISOString(),t:'in',kg:+t.toFixed(3),n:'from image, '+v.length+' weights'});
  sv();$('#otx').value='';$('#ores').hidden=true;$('#of').value='';$('#oi').style.display='none';$('#os').textContent='Added to '+z.name;rs();
}

/* ---------- dashboard ---------- */
function dash(){
  sortSizes();
  const tot=DB.sizes.reduce((a,z)=>a+z.stock,0),mx=Math.max(1,...DB.sizes.map(z=>z.stock));
  $('#dtot').innerHTML=`<span style="font-size:28px;font-weight:700">${tot.toFixed(2)} kg</span> <span class="mu">available across ${DB.sizes.length} sizes</span>`;
  $('#dgrid').innerHTML=DB.sizes.map(z=>{
    const pc=z.w?Math.floor(z.stock/z.w+1e-9):null;
    return `<div class="card dc"><div class="mu">${esc(z.code)}</div><h3>${esc(z.name)}</h3><div class="big${z.stock<=0?' neg':''}">${z.stock.toFixed(2)} kg</div>${pc!==null?`<div><b>${pc}</b> rods <small>(${z.w} kg each)</small></div>`:'<small>Set “Wt / rod” in Stock to see rod count</small>'}<div class="bar"><i style="width:${Math.max(0,z.stock)/mx*100}%"></i></div></div>`;
  }).join('')||'<div class="card">No sizes yet</div>';
  const td=new Date().toDateString(),tb=DB.bills.filter(b=>new Date(b.date).toDateString()==td),
    sm=p=>tb.filter(b=>b.pay==p).reduce((a,b)=>a+b.total,0).toFixed(2),pe=DB.bills.filter(b=>b.pay=='Pending');
  $('#dsal').innerHTML=`Today: <b>${tb.length}</b> bills · Cash ₹${sm('Cash')} · Online ₹${sm('Online')} · Not paid ₹${sm('Pending')}<br>All pending: <b class="neg">₹${pe.reduce((a,b)=>a+b.total,0).toFixed(2)}</b> in ${pe.length} bill(s)`;
}

/* ---------- settings / backup ---------- */
function ss(){DB.shop=$('#sn').value.trim()||DB.shop;DB.addr=$('#sa').value.trim();sv();alert('Saved')}
async function chpw(){
  const cur=$('#cpw').value,ni=$('#ni').value.trim(),np=$('#np').value,np2=$('#np2').value;
  if(!cur)return alert('Enter your current password');
  if(!ni&&!np)return alert('Enter a new ID or a new password');
  if(np&&np!==np2)return alert('The two new passwords do not match');
  const r=await api('POST','/api/password',{current:cur,newId:ni,newPassword:np});
  if(!r.ok)return alert(r.j.error||'Could not change login');
  ['cpw','ni','np','np2'].forEach(x=>$('#'+x).value='');
  alert('Login changed. All other devices were signed out.');
}
function bk(){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(DB)],{type:'application/json'}));
  a.download='jkt-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();
}
function rf(inp){
  const f=inp.files[0];if(!f)return;const r=new FileReader();
  r.onload=async()=>{
    try{
      const d=JSON.parse(r.result);if(!Array.isArray(d.sizes)||!Array.isArray(d.bills))throw 0;
      if(!confirm('Replace ALL data on the server with this backup file?')){inp.value='';return}
      const x=await api('PUT','/api/state',{rev:REV,data:d});
      if(x.status==409){DB=norm(x.j.data);REV=x.j.rev;refresh();alert('Data changed on another device. Please try the restore again.')}
      else if(!x.ok)alert('Backup was not accepted: '+(x.j.error||'invalid file'));
      else{const s=await api('GET','/api/state');DB=norm(s.j.data);REV=s.j.rev;alert('Backup restored.');show('set')}
    }catch(e){alert('Invalid backup file')}
    inp.value='';
  };
  r.readAsText(f);
}
function applyTheme(){
  let t;try{t=localStorage.getItem('jkt_theme')}catch(e){}
  t=t||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
  document.documentElement.dataset.theme=t;
  Q('.tgl').forEach(b=>b.textContent=t=='dark'?'☀️ Light mode':'🌙 Dark mode');
}
function tg(){
  const t=document.documentElement.dataset.theme=='dark'?'light':'dark';
  try{localStorage.setItem('jkt_theme',t)}catch(e){}applyTheme();
}

/* ---------- button wiring (no inline handlers: strict security policy) ---------- */
const ACT={
  nav:t=>show(t.dataset.t),tg,logout,
  addrow:()=>addRow().querySelector('.sz').focus(),
  save:()=>saveBill(),saveprint:()=>saveBill(true),newbill:()=>newBill(),
  pr:t=>pr(+t.dataset.no),ed:t=>ed(+t.dataset.no),del:t=>del(+t.dataset.no),
  az:()=>az(),presets:()=>addPresets(),ocr:()=>ocr(),oadd:()=>oadd(),
  ss:()=>ss(),chpw:()=>chpw(),bk:()=>bk(),restore:()=>$('#rf1').click(),
  sadd:t=>st(+t.dataset.i,1),sset:t=>st(+t.dataset.i,0),
  hist:t=>{const i=+t.dataset.i;openL=openL==i?-1:i;rs()},dz:t=>dz(+t.dataset.i)
};
document.addEventListener('click',e=>{const t=e.target.closest('[data-act]');if(t&&ACT[t.dataset.act])ACT[t.dataset.act](t)});
const INP={rl:()=>rl(),rs:()=>rs(),osum:()=>osum()};
document.addEventListener('input',e=>{const t=e.target.closest&&e.target.closest('[data-inp]');if(t&&INP[t.dataset.inp])INP[t.dataset.inp](t)});
const CHG={
  rc:t=>rc(+t.dataset.i,t.value),rn:t=>rn(+t.dataset.i,t.value),
  sw:t=>{DB.sizes[+t.dataset.i].w=+t.value;sv()},sr:t=>{DB.sizes[+t.dataset.i].rate=+t.value;sv()},
  oimg:t=>oimg(t),rf:t=>rf(t)
};
document.addEventListener('change',e=>{const t=e.target.closest&&e.target.closest('[data-chg]');if(t&&CHG[t.dataset.chg])CHG[t.dataset.chg](t)});

/* ---------- start ---------- */
async function boot(){
  try{
    const m=await(await fetch('/api/me',{cache:'no-store',credentials:'same-origin'})).json();
    if(!m.authed){location.reload();return}
    CSRF=m.csrf;
    const r=await api('GET','/api/state');
    DB=norm(r.j.data);REV=r.j.rev;sortSizes();
    $('#ld').hidden=true;$('#app').hidden=false;applyTheme();setFs('ok');show('bill');newBill();
  }catch(e){$('#ld').textContent='Could not load. Check your internet and refresh the page.'}
}
boot();
