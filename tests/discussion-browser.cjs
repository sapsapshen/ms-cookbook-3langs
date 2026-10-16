// NODE_PATH must resolve Playwright. Uses isolated SQLite, never the preview database.
const {chromium}=require('playwright');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'), data=fs.mkdtempSync(path.join(os.tmpdir(),'purplebook-browser-'));
 const env={...process.env,DATA_DIR:data,APP_BASE_URL:'http://127.0.0.1:7861',PYTHONPATH:root,OAUTH_CLIENT_ID:'',OAUTH_CLIENT_SECRET:''};
 const python=path.join(root,'.venv/bin/python');
 const setup=spawnSync(python,['tests/prepare_browser_fixture.py'],{cwd:root,env,encoding:'utf8'});assert.equal(setup.status,0,setup.stderr);
 const server=spawn(python,['-m','uvicorn','app:app','--host','127.0.0.1','--port','7861','--no-access-log'],{cwd:root,env,stdio:'ignore'});
 let browser;
 try{
  for(let i=0;i<50;i++){try{const r=await fetch(env.APP_BASE_URL+'/api/session');if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addCookies([{name:'purplebook_session',value:JSON.parse(fs.readFileSync(path.join(data,'browser-cookie.json'),'utf8')),url:env.APP_BASE_URL}]);
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(env.APP_BASE_URL+'/#chapter-1');await page.getByText('测试读者',{exact:true}).first().waitFor();
  await page.locator('#chapterMessage').fill('这是一条端到端测试留言');await page.getByRole('button',{name:'发表留言',exact:true}).click();
  await page.locator('.discussion-entry').getByText('这是一条端到端测试留言').waitFor();
  const select=async()=>{await page.evaluate(()=>{const p=[...document.querySelectorAll('#articleBody p')].find(p=>p.firstChild?.nodeType===3&&p.firstChild.length>15);const r=document.createRange();r.setStart(p.firstChild,0);r.setEnd(p.firstChild,10);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new KeyboardEvent('keyup',{key:'Shift',bubbles:true}));});};
  await select();await page.getByRole('button',{name:'划线 · 仅自己可见',exact:true}).click();await page.locator('.discussion-entry').getByText('仅自己可见').waitFor();
  await select();await page.getByRole('button',{name:'写想法',exact:true}).click();await page.locator('#annotationText').fill('<img src=x onerror=alert(1)> 这段很有帮助');await page.getByRole('button',{name:'公开发表',exact:true}).click();
  await page.locator('.discussion-entry').getByText('<img src=x onerror=alert(1)> 这段很有帮助',{exact:true}).waitFor();
  assert.equal(await page.locator('.discussion-entry p img').count(),0);
  await page.reload();await page.getByRole('button',{name:'划线与想法',exact:true}).click();await page.locator('.discussion-entry').getByText('仅自己可见').waitFor();
  await page.goto(env.APP_BASE_URL+'/#chapter-2');await page.getByText('还没有留言，来分享第一个想法吧。',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.goto(env.APP_BASE_URL+'/#chapter-1');await page.locator('#chapterDiscussion').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'mobile page overflow');
  await page.screenshot({path:path.join(data,'mobile.png')});
  const guest=await browser.newPage();await guest.goto(env.APP_BASE_URL+'/#chapter-1');await guest.getByRole('button',{name:'划线与想法',exact:true}).click();await guest.locator('.discussion-entry').getByText('<img src=x onerror=alert(1)> 这段很有帮助',{exact:true}).waitFor();
  assert.equal(await guest.getByText('仅自己可见',{exact:true}).count(),0);assert.equal(await guest.locator('#chapterMessage').isDisabled(),true);
  await page.setViewportSize({width:1280,height:900});await page.goto(env.APP_BASE_URL+'/#contribute');
  await page.locator('#wishText:not([disabled])').waitFor();
  await page.locator('#wishText').fill('<img src=x onerror=alert(1)> 希望补充 RAG 本地部署教程');
  await page.getByRole('button',{name:'投下愿望',exact:true}).click();
  await page.locator('.wish-entry').getByText('<img src=x onerror=alert(1)> 希望补充 RAG 本地部署教程',{exact:true}).waitFor();
  assert.equal(await page.locator('.wish-entry img').count(),0);
  await page.reload();await page.locator('.wish-entry').waitFor();
  await page.locator('#wishPool').scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/purplebook-wishes-desktop.png'});
  await guest.goto(env.APP_BASE_URL+'/#contribute');await guest.locator('.wish-entry').waitFor();
  assert.equal(await guest.locator('#wishText').isDisabled(),true);assert.equal(await guest.locator('.wish-entry button').count(),0);
  await page.setViewportSize({width:390,height:844});await page.locator('#wishPool').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'wish pool mobile overflow');
  await page.screenshot({path:'/tmp/purplebook-wishes-mobile.png'});
  page.once('dialog',d=>d.accept());await page.locator('.wish-entry button').click();
  await page.getByText('还没有人许愿。你希望紫皮书补上的第一份实践是什么？',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('PASS: browser comment, highlight, annotation, XSS text rendering, reload, chapter isolation, guest privacy, wishes publish/persist/delete/XSS/guest permissions, mobile layout');
 }finally{if(browser)await browser.close();server.kill();fs.rmSync(data,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
