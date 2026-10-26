(()=>{
const $=s=>document.querySelector(s);
function theme(flip){
  let t;try{t=localStorage.getItem('jkt_theme')}catch(e){}
  t=t||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
  if(flip){t=t=='dark'?'light':'dark';try{localStorage.setItem('jkt_theme',t)}catch(e){}}
  document.documentElement.dataset.theme=t;
  $('#tg').textContent=t=='dark'?'☀️ Light mode':'🌙 Dark mode';
}
theme();
$('#tg').addEventListener('click',()=>theme(true));
$('#fg').addEventListener('click',()=>alert('To reset the password, the owner sets RESET_ADMIN_PASSWORD on the server and restarts it (see README).'));
async function login(){
  $('#go').disabled=true;$('#lerr').textContent='';
  try{
    const r=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:$('#lid').value.trim(),password:$('#lpw').value})});
    const j=await r.json().catch(()=>({}));
    if(r.ok){location.reload();return}
    $('#lerr').textContent=j.error||'Wrong ID or password';$('#lpw').value='';
  }catch(x){$('#lerr').textContent='No connection. Check your internet.'}
  $('#go').disabled=false;
}
$('#go').addEventListener('click',login);
$('#lpw').addEventListener('keydown',e=>{if(e.key=='Enter')login()});
$('#lid').addEventListener('keydown',e=>{if(e.key=='Enter')$('#lpw').focus()});
})();
