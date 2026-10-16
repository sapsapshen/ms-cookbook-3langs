(() => {
  'use strict';
  const $=s=>document.querySelector(s), el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const t = window.MSI18N.t;
  const form=$('#wishForm'),input=$('#wishText'),submit=$('#wishSubmit'),account=$('#wishAccount'),list=$('#wishList'),status=$('#wishListStatus'),formStatus=$('#wishFormStatus'),more=$('#wishMore'),retry=$('#wishRetry');
  let session={user:null,csrf:'',loginEnabled:false},items=[],next=null,busy=false,loading=false,generation=0;
  const active=()=>location.hash.split('?')[0]==='#contribute';
  async function api(path,options={}){
    const r=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf}});
    let data;try{data=await r.json();}catch{throw Error(t('wish.offline'));}
    if(!r.ok){if(r.status===401)refreshSession();throw Error(typeof data.detail==='string'?data.detail:t('error.requestFailed'));}return data;
  }
  function renderAccount(){
    input.disabled=!session.user;submit.disabled=!session.user||busy;account.replaceChildren();
    if(session.user){account.textContent=t('wish.as',{name:session.user.name});}
    else if(session.loginEnabled){const a=el('a',t('wish.loginCta'));a.href='/auth/login?return_to=%23contribute';a.target='_blank';a.rel='noopener';account.append(a);}
    else account.textContent=t('wish.loginSoon');
  }
  function acceptSession(value){const changed=session.user?.id!==value.user?.id;session=value;renderAccount();if(changed&&active())load();}
  async function refreshSession(){try{acceptSession(await api('/api/session'));}catch(e){formStatus.textContent=e.message;}}
  window.addEventListener('purplebook:session',e=>acceptSession(e.detail));
  function render(){
    list.replaceChildren();
    if(!items.length)list.append(el('p',t('wish.empty'),'wish-empty'));
    for(const wish of items){
      const card=el('article',null,'wish-entry'),header=el('header'),date=el('time',new Date(wish.created*1000).toLocaleDateString(window.MSI18N.locale()));
      date.dateTime=new Date(wish.created*1000).toISOString();header.append(el('strong',wish.name),date);card.append(header,el('p',wish.text));
      if(wish.canDelete){const del=el('button',t('wish.delete'),'entry-delete');del.type='button';del.onclick=async()=>{if(!confirm(t('wish.deleteConfirm')))return;del.disabled=true;try{await api('/api/wishes/'+wish.id,{method:'DELETE'});await load();}catch(e){status.textContent=e.message;del.disabled=false;}};card.append(del);}
      list.append(card);
    }
    more.hidden=!next;
  }
  async function load(append=false){
    if(append&&loading)return;
    const ticket=++generation;loading=true;more.disabled=true;retry.hidden=true;status.textContent=t('wish.loading');
    try{const data=await api('/api/wishes'+(append&&next?'?before='+next:''));if(ticket!==generation)return;items=append?items.concat(data.items):data.items;next=data.next;render();status.textContent='';}
    catch(e){if(ticket!==generation)return;status.textContent=e.message;retry.hidden=false;}
    finally{if(ticket===generation){loading=false;more.disabled=false;}}
  }
  input.addEventListener('input',()=>{$('#wishCount').textContent=t('wish.dailyCount',{count:input.value.length});});
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(busy||!session.user)return;
    if(!input.value.trim()){formStatus.textContent=t('wish.emptyValue');input.focus();return;}
    busy=true;renderAccount();formStatus.textContent=t('wish.posting');
    try{await api('/api/wishes',{method:'POST',body:JSON.stringify({text:input.value})});input.value='';$('#wishCount').textContent=t('wish.dailyCount',{count:0});formStatus.textContent=t('wish.posted');await load();}
    catch(e){formStatus.textContent=e.message;}
    finally{busy=false;renderAccount();}
  });
  more.onclick=()=>load(true);retry.onclick=()=>load();
  window.addEventListener('hashchange',()=>{if(active())load();});
  window.addEventListener('focus',()=>{if(active())load();});
  window.MSI18N.on(()=>{renderAccount();render();});
  refreshSession().then(()=>{if(active())load();});
})();