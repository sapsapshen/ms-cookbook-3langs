(() => {
  'use strict';
  const storageKey='purplebook-anonymous-visitor';
  let memoryId='';

  function randomId() {
    if(crypto.randomUUID)return crypto.randomUUID().replaceAll('-','');
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
  }

  function visitorId() {
    for(const name of ['localStorage','sessionStorage']) {
      try {
        const storage=window[name];
        let value=storage.getItem(storageKey);
        if(!/^[A-Za-z0-9_-]{16,128}$/.test(value||'')) {
          value=randomId();storage.setItem(storageKey,value);
        }
        return value;
      } catch {/* Continue with the next storage option. */}
    }
    if(!memoryId)memoryId=randomId();
    return memoryId;
  }

  function record(page) {
    if(!page||document.visibilityState==='hidden')return;
    fetch('/api/analytics/view',{
      method:'POST',credentials:'same-origin',keepalive:true,
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({page,visitor:visitorId()})
    }).catch(()=>{/* Reading remains available when analytics is unavailable. */});
  }

  let pending='';
  window.addEventListener('purplebook:route',event=>{
    pending=event.detail?.page||'';
    if(document.visibilityState==='visible'){record(pending);pending='';}
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible'&&pending){record(pending);pending='';}
  });
})();
