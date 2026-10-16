(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const t = window.MSI18N.t;
  const el = (tag, text, cls) => { const n=document.createElement(tag); if(text)n.textContent=text; if(cls)n.className=cls; return n; };
  let session={user:null,csrf:'',loginEnabled:false}, chapter='', blocks=[], items=[], next=null, generation=0, anchor=null, busy=false;
  const account=el('div',null,'reading-account');
  $('#headerAccountArea').append(account);
  const panel=el('section',null,'chapter-discussion'); panel.id='chapterDiscussion'; panel.setAttribute('aria-label',t('a11y.chapterDiscussion'));
  $('.chapter-pager').after(panel);
  const title=el('h2',t('discussion.title'));
  const hint=el('p',t('discussion.hint'),'discussion-hint');
  const tabs=el('div',null,'discussion-tabs');
  const notesButton=el('button',t('discussion.tabNotes')); notesButton.type='button';
  const commentsButton=el('button',t('discussion.tabComments')); commentsButton.type='button';
  tabs.append(notesButton,commentsButton);
  const list=el('div',null,'discussion-list'); list.setAttribute('aria-live','polite');
  const more=el('button',t('discussion.more'),'discussion-more'); more.type='button'; more.hidden=true;
  const form=el('form',null,'discussion-form');
  const label=el('label',t('discussion.formLabel')); label.htmlFor='chapterMessage';
  const textarea=el('textarea'); textarea.id='chapterMessage'; textarea.maxLength=2000; textarea.rows=3; textarea.placeholder=t('discussion.formPlaceholder');
  const submit=el('button',t('discussion.submit'),'discussion-primary'); submit.type='submit';
  const formHint=el('p',null,'discussion-hint');
  form.append(label,textarea,formHint,submit);
  const status=el('p',null,'discussion-status'); status.setAttribute('role','status');
  panel.append(title,hint,tabs,list,more,form,status);
  let tab='comment';
  const discussionJump=el('button',t('discussion.jump'));discussionJump.type='button';discussionJump.onclick=()=>panel.scrollIntoView({block:'start',behavior:'smooth'});$('.reading-tools').append(discussionJump);
  const toast=el('p',null,'reading-toast');toast.hidden=true;toast.setAttribute('role','status');document.body.append(toast);let toastTimer;
  function notify(message){toast.textContent=message;toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.hidden=true;},3500);}
  const selectionBar=el('div',null,'selection-actions'); selectionBar.hidden=true; selectionBar.setAttribute('aria-label',t('a11y.selectionActions'));
  const save=el('button',t('discussion.saveHighlight')), write=el('button',t('discussion.writeThought')), dismiss=el('button',t('discussion.cancel'));
  selectionBar.append(save,write,dismiss); document.body.append(selectionBar);
  const dialog=el('dialog',null,'annotation-dialog'); dialog.setAttribute('aria-labelledby','annotationTitle');
  const dTitle=el('h2',t('discussion.dialogTitle')); dTitle.id='annotationTitle';
  const quote=el('blockquote'); const dForm=el('form');
  const dLabel=el('label',t('discussion.annotationLabel')); dLabel.htmlFor='annotationText';
  const dText=el('textarea'); dText.id='annotationText';dText.rows=5;dText.maxLength=2000;dText.required=true;
  const dStatus=el('p');dStatus.setAttribute('role','status');
  const dSubmit=el('button',t('discussion.publish'),'discussion-primary');dSubmit.type='submit';
  const dClose=el('button',t('discussion.cancel')); dClose.type='button';
  dForm.append(dLabel,dText,el('p',t('discussion.annotationHint'),'discussion-hint'),dStatus,dSubmit,dClose);
  dialog.append(dTitle,quote,dForm);document.body.append(dialog);

  async function api(path,options={}) {
    const response=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf,...options.headers}});
    let data;try{data=await response.json();}catch{throw new Error(t('error.commentService'));}
    if(!response.ok){if(response.status===401)refreshSession();throw new Error(typeof data.detail==='string'?data.detail:t('error.requestFailed'));}
    return data;
  }
  function loginLink(text) {
    const a=el('a',text||t('discussion.loginLink'),'discussion-login');a.href='/auth/login?return_to='+encodeURIComponent(location.hash||'#home');
    // A top-level context is required for OAuth and SameSite cookies in Studio embeds.
    a.target='_blank';a.rel='noopener';return a;
  }
  function renderAccount() {
    account.replaceChildren();
    if(session.user){
      account.append(el('span',session.user.name,'account-name'));
      const logout=el('button',t('discussion.logout'));logout.type='button';logout.onclick=async()=>{try{await api('/api/logout',{method:'POST'});await refreshSession();await load();}catch(e){status.textContent=e.message;}};account.append(logout);
    }else if(session.loginEnabled) account.append(loginLink(t('discussion.loginShort')));
    else {const pending=el('span',t('discussion.loginShort'),'account-pending');pending.title=t('discussion.loginUnconfigured');pending.setAttribute('aria-disabled','true');account.append(pending);}
    window.dispatchEvent(new CustomEvent('purplebook:session',{detail:session}));
    textarea.disabled=!session.user;submit.disabled=!session.user;
    formHint.replaceChildren(el('span',t('discussion.formHint')));
    if(!session.user) formHint.append(' ',session.loginEnabled?loginLink(t('discussion.loginCta')):el('span',t('discussion.loginLater')));
  }
  async function refreshSession(){try{session=await api('/api/session');renderAccount();}catch(e){status.textContent=e.message;renderAccount();}}
  function chapterKey(){return location.hash.slice(1).split('?')[0].split('/')[0];}
  function collectBlocks(){
    blocks=[...$('#articleBody').querySelectorAll('p,li,h2,h3,h4,blockquote,td')].filter(n=>!n.closest('pre,.katex')&&!n.querySelector('p,li,h2,h3,h4,blockquote,td'));
  }
  function textNodes(block){const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('button,.katex,script,style')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);return nodes;}
  function blockText(block){return textNodes(block).map(n=>n.textContent).join('');}
  function rangeFor(entry){
    const block=blocks[entry.block];if(!block)return null;
    const text=blockText(block);let start=entry.start;
    if(text.slice(start,entry.end)!==entry.quote){start=text.indexOf(entry.quote);if(start<0||text.indexOf(entry.quote,start+1)>=0)return null;}
    const end=start+entry.quote.length;const range=document.createRange();let offset=0,started=false;
    for(const node of textNodes(block)){
      const last=offset+node.length;
      if(!started&&start<last){range.setStart(node,start-offset);started=true;}
      if(started&&end<=last){range.setEnd(node,end-offset);return range;}
      offset=last;
    }return null;
  }
  function paint(){
    if(!window.CSS?.highlights||!window.Highlight)return;
    const mine=[],shared=[];
    for(const entry of items){if(entry.kind==='comment')continue;const range=rangeFor(entry);if(range)(entry.kind==='highlight'?mine:shared).push(range);}
    CSS.highlights.set('reader-lines',new Highlight(...mine));CSS.highlights.set('reader-thoughts',new Highlight(...shared));
  }
  function showTab(value){tab=value;render();}
  notesButton.onclick=()=>showTab('annotation');commentsButton.onclick=()=>showTab('comment');
  function render(){
    notesButton.setAttribute('aria-pressed',String(tab==='annotation'));commentsButton.setAttribute('aria-pressed',String(tab==='comment'));
    form.hidden=tab!=='comment';list.replaceChildren();
    const visible=items.filter(i=>tab==='comment'?i.kind==='comment':i.kind!=='comment');
    if(!visible.length)list.append(el('p',tab==='comment'?t('discussion.emptyComments'):t('discussion.emptyNotes'),'discussion-empty'));
    for(const entry of visible){
      const card=el('article',null,'discussion-entry');const header=el('header');
      header.append(el('strong',entry.name),el('span',entry.kind==='highlight'?t('discussion.private'):new Date(entry.created*1000).toLocaleString(window.MSI18N.locale(),{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})));
      card.append(header);
      if(entry.quote){const jump=el('button',entry.quote,'quoted-passage');jump.type='button';jump.onclick=()=>{const r=rangeFor(entry);if(!r){status.textContent=t('discussion.quoteMissing');return;}blocks[entry.block].scrollIntoView({block:'center',behavior:'smooth'});getSelection().removeAllRanges();getSelection().addRange(r);};card.append(jump);}
      if(entry.text)card.append(el('p',entry.text));
      if(entry.canDelete){
        const highlight=entry.kind==='highlight';
        const del=el('button',highlight?t('discussion.removeHighlight'):t('discussion.delete'),'entry-delete');del.type='button';
        del.onclick=async()=>{if(!confirm(highlight?t('discussion.deleteHighlightConfirm'):t('discussion.deleteContentConfirm')))return;del.disabled=true;try{await api('/api/entries/'+entry.id,{method:'DELETE'});await load();}catch(e){status.textContent=e.message;del.disabled=false;}};card.append(del);
      }
      list.append(card);
    }
    more.hidden=!next;paint();
  }
  async function load(append=false){
    const current=chapterKey();if(!/^chapter-\d+$/.test(current)){panel.hidden=true;selectionBar.hidden=true;return;}
    const record=window.BOOK_DATA.chapters.find(c=>c.id===current);if(!record||record.status==='pending'){panel.hidden=true;return;}
    panel.hidden=false;chapter=current;collectBlocks();
    const ticket=++generation;status.textContent='';
    try{const data=await api(`/api/chapters/${current}/entries${append&&next?'?before='+next:''}`);if(ticket!==generation||chapterKey()!==current)return;items=append?items.concat(data.items):data.items;next=data.next;render();}
    catch(e){if(ticket!==generation)return;items=[];next=null;render();status.textContent=e.message;}
  }
  more.onclick=()=>load(true);
  function capture(){
    const selection=getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount){selectionBar.hidden=true;return;}
    const r=selection.getRangeAt(0),block=blocks.find(b=>b.contains(r.startContainer)&&b.contains(r.endContainer));
    if(!block||r.toString().length>2000||!r.toString().trim()||r.cloneContents().querySelector('.katex,button')){selectionBar.hidden=true;return;}
    const prefix=document.createRange();prefix.selectNodeContents(block);prefix.setEnd(r.startContainer,r.startOffset);
    const text=r.toString();const start=prefix.toString().length;
    if(blockText(block).slice(start,start+text.length)!==text){selectionBar.hidden=true;return;}
    anchor={chapter:chapterKey(),quote:text,block:blocks.indexOf(block),start,end:start+text.length};selectionBar.hidden=false;
  }
  document.addEventListener('pointerup',e=>{if(!selectionBar.contains(e.target)&&!dialog.contains(e.target))setTimeout(capture,40);});
  document.addEventListener('keyup',e=>{if(e.key==='Shift'||e.key.startsWith('Arrow'))capture();if(e.key==='Escape')selectionBar.hidden=true;});
  selectionBar.addEventListener('pointerdown',e=>e.preventDefault());dismiss.onclick=()=>{selectionBar.hidden=true;getSelection().removeAllRanges();};
  function canWrite(){if(session.user)return true;status.replaceChildren(el('span',t('discussion.loginFirst')),session.loginEnabled?loginLink():el('span',t('discussion.loginSoon')));panel.scrollIntoView({block:'start',behavior:'smooth'});selectionBar.hidden=true;return false;}
  save.onclick=async()=>{
    if(!canWrite()||!anchor||busy)return;busy=true;save.disabled=true;const selected={...anchor};
    try{await api(`/api/chapters/${selected.chapter}/entries`,{method:'POST',body:JSON.stringify({...selected,kind:'highlight'})});selectionBar.hidden=true;getSelection().removeAllRanges();showTab('annotation');await load();status.textContent=t('discussion.savedHighlight');notify(status.textContent);}catch(e){status.textContent=e.message;notify(e.message);}finally{busy=false;save.disabled=false;}
  };
  write.onclick=()=>{if(!canWrite()||!anchor)return;quote.textContent=anchor.quote;dText.value='';dStatus.textContent='';selectionBar.hidden=true;dialog.showModal();dText.focus();};
  dClose.onclick=()=>dialog.close();
  dForm.onsubmit=async e=>{e.preventDefault();if(busy||!anchor||!dText.value.trim())return;busy=true;dSubmit.disabled=true;
    try{await api(`/api/chapters/${anchor.chapter}/entries`,{method:'POST',body:JSON.stringify({...anchor,kind:'annotation',text:dText.value})});dialog.close();showTab('annotation');getSelection().removeAllRanges();await load();}catch(error){dStatus.textContent=error.message;}finally{busy=false;dSubmit.disabled=false;}
  };
  form.onsubmit=async e=>{e.preventDefault();if(!canWrite()||busy||!textarea.value.trim())return;busy=true;submit.disabled=true;const target=chapterKey();
    try{await api(`/api/chapters/${target}/entries`,{method:'POST',body:JSON.stringify({kind:'comment',text:textarea.value})});if(chapterKey()===target){textarea.value='';await load();status.textContent=t('discussion.published');}}catch(error){status.textContent=error.message;}finally{busy=false;submit.disabled=!session.user;}
  };
  window.addEventListener('hashchange',()=>{generation++;selectionBar.hidden=true;dialog.close();anchor=null;if(chapter!==chapterKey()){textarea.value='';items=[];next=null;tab='comment';render();}renderAccount();requestAnimationFrame(()=>load());});
  window.addEventListener('focus',async()=>{await refreshSession();await load();});
  // Translate every static label the panel owns when the reader switches language.
  window.MSI18N.on(()=>{
    panel.setAttribute('aria-label',t('a11y.chapterDiscussion'));
    selectionBar.setAttribute('aria-label',t('a11y.selectionActions'));
    title.textContent=t('discussion.title');hint.textContent=t('discussion.hint');
    notesButton.textContent=t('discussion.tabNotes');commentsButton.textContent=t('discussion.tabComments');
    more.textContent=t('discussion.more');label.textContent=t('discussion.formLabel');
    textarea.placeholder=t('discussion.formPlaceholder');submit.textContent=t('discussion.submit');
    discussionJump.textContent=t('discussion.jump');
    save.textContent=t('discussion.saveHighlight');write.textContent=t('discussion.writeThought');dismiss.textContent=t('discussion.cancel');
    dTitle.textContent=t('discussion.dialogTitle');dLabel.textContent=t('discussion.annotationLabel');
    dForm.querySelector('.discussion-hint').textContent=t('discussion.annotationHint');
    dSubmit.textContent=t('discussion.publish');dClose.textContent=t('discussion.cancel');
    renderAccount();render();
  });
  refreshSession().then(load);
  if(new URLSearchParams(location.search).get('login')==='failed'){status.textContent=t('discussion.loginFailed');}
})();