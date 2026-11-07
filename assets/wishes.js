(() => {
  'use strict';
  const $=s=>document.querySelector(s), el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const t = window.MSI18N.t;
  const form=$('#wishForm'),input=$('#wishText'),submit=$('#wishSubmit'),account=$('#wishAccount'),list=$('#wishList'),status=$('#wishListStatus'),formStatus=$('#wishFormStatus'),more=$('#wishMore'),retry=$('#wishRetry');
  let session={user:null,csrf:'',loginEnabled:false},items=[],next=null,busy=false,loading=false,generation=0;
  const active=()=>location.hash.split('?')[0]==='#contribute';
  const wait=ms=>new Promise(resolveWait=>setTimeout(resolveWait,ms));
  function friendlyStatus(status){
    if(status===503)return t('error.serviceDown');
    if(status===429)return t('error.rateLimited');
    return t('error.retryLater');
  }
  async function api(path,options={}){
    // Writes (POST/DELETE) are not idempotent: a thrown fetch may have reached
    // the server, so they show error.network once and leave the draft alone.
    // GET loads keep the network retry they already had.
    for(let attempt=0;;attempt+=1){
      let r;
      try{r=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf}});}
      catch{if(!options.method&&attempt<2){await wait(400*(attempt+1));continue;}throw Error(t('error.network'));}
      if(r.status===503&&attempt<2){await wait(400*(attempt+1));continue;}
      let data;try{data=await r.json();}catch{throw Error(friendlyStatus(r.status));}
      if(!r.ok){if(r.status===401)refreshSession();throw Error(typeof data.detail==='string'?data.detail:friendlyStatus(r.status));}
      return data;
    }
  }
  function renderAccount(){
    input.disabled=!session.user;submit.disabled=!session.user||busy;account.replaceChildren();
    if(session.user){account.textContent=t('wish.as',{name:session.user.name});}
    else if(session.loginEnabled){const a=el('a',t('wish.loginCta'));a.href='/auth/login?return_to=%23contribute';a.target='_blank';a.rel='noopener';account.append(a);}
    else account.textContent=t('wish.loginSoon');
  }
  function acceptSession(value){const changed=session.user?.id!==value.user?.id;session=value;renderAccount();if(changed&&active())load();}
  async function refreshSession(){try{acceptSession(await api('/api/session'));}catch(e){formStatus.textContent=t('error.retryLater');}}
  window.addEventListener('purplebook:session',e=>acceptSession(e.detail));
  function render(){
    list.replaceChildren();
    if(!items.length)list.append(el('p',t('wish.empty'),'wish-empty'));
    for(const wish of items){
      const card=el('article',null,'wish-entry'),header=el('header'),date=el('time',new Date(wish.created*1000).toLocaleDateString(window.MSI18N.locale()));
      date.dateTime=new Date(wish.created*1000).toISOString();header.append(el('strong',wish.name),date);card.append(header,el('p',wish.text));
      if(wish.canDelete){const del=el('button',t('wish.delete'),'entry-delete');del.type='button';del.onclick=async()=>{if(!confirm(t('wish.deleteConfirm')))return;del.disabled=true;try{await api('/api/wishes/'+wish.id,{method:'DELETE'});await load();}catch(e){status.textContent=e instanceof Error&&e.message?e.message:t('error.retryLater');del.disabled=false;}};card.append(del);}
      list.append(card);
    }
    more.hidden=!next;
  }
  async function load(append=false){
    if(append&&loading)return;
    const ticket=++generation;loading=true;more.disabled=true;retry.hidden=true;status.textContent=t('wish.loading');
    try{const data=await api('/api/wishes'+(append&&next?'?before='+next:''));if(ticket!==generation)return;items=append?items.concat(data.items):data.items;next=data.next;render();status.textContent='';}
    catch(e){if(ticket!==generation)return;status.textContent=t('error.retryLater');retry.hidden=false;}
    finally{if(ticket===generation){loading=false;more.disabled=false;}}
  }
  input.addEventListener('input',()=>{$('#wishCount').textContent=t('wish.dailyCount',{count:input.value.length});});
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(busy||!session.user)return;
    if(!input.value.trim()){formStatus.textContent=t('wish.emptyValue');input.focus();return;}
    busy=true;renderAccount();formStatus.textContent=t('wish.posting');
    try{await api('/api/wishes',{method:'POST',body:JSON.stringify({text:input.value})});input.value='';$('#wishCount').textContent=t('wish.dailyCount',{count:0});formStatus.textContent=t('wish.posted');await load();}
    catch(e){formStatus.textContent=e instanceof Error&&e.message?e.message:t('error.retryLater');}
    finally{busy=false;renderAccount();}
  });
  more.onclick=()=>load(true);retry.onclick=()=>load();
  window.addEventListener('hashchange',()=>{if(active())load();});
  window.addEventListener('focus',()=>{if(active())load();});
  window.MSI18N.on(()=>{renderAccount();render();});
  refreshSession().then(()=>{if(active())load();});
})();