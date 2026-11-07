import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import vm from 'node:vm';

const root=resolve(import.meta.dirname,'..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const context={window:{}};
vm.runInNewContext(read('assets/content.js'),context);
const data=context.window.BOOK_DATA;
const manifest=JSON.parse(read('content/manifest.json'));
assert.equal(data.chapters.length,manifest.chapters.length);
assert.equal(new Set(data.chapters.map(c=>c.id)).size,data.chapterCount);
assert.deepEqual(manifest.chapters.map(c=>c.number),Array.from({length:data.chapterCount},(_,i)=>i+1),'Chapter numbers must follow book order');
assert.equal(new Set(data.chapters.map(c=>c.discussionId)).size,data.chapterCount,'Discussion storage keys must be unique');
const ids=new Set(data.chapters.map(c=>c.id));
const partIds=data.parts.flatMap(p=>p.chapters);
assert.equal(partIds.length,ids.size);
assert.equal(new Set(partIds).size,ids.size);
for(const id of partIds)assert(ids.has(id));
function imageSize(buffer){
  if(buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))
    return [buffer.readUInt32BE(16),buffer.readUInt32BE(20)];
  if(buffer.toString('latin1',0,4)==='RIFF'&&buffer.toString('latin1',8,12)==='WEBP'){
    const fourcc=buffer.toString('latin1',12,16);
    if(fourcc==='VP8X')return [1+buffer.readUIntLE(24,3),1+buffer.readUIntLE(27,3)];
    if(fourcc==='VP8 ')return [buffer.readUInt16LE(26)&0x3fff,buffer.readUInt16LE(28)&0x3fff];
    // VP8L packs width-1 then height-1 as 14 bits each; a 12-bit mask inflated
    // every height under 4096 four times and wrapped widths past 4096.
    if(fourcc==='VP8L'){const bits=buffer.readUInt32LE(21);return [(bits&0x3fff)+1,((bits>>14)&0x3fff)+1];}
  }
  return null;
}
let imageCount=0,attachmentCount=0;
function checkLinks(html,base='.'){
  for(const tag of html.matchAll(/<(?:a|img|script|link)\b[^>]*>/g))for(const m of tag[0].matchAll(/(?:src|href)="([^"]+)"/g)){
    const url=m[1];
    assert(!/^(javascript|data|vbscript):/i.test(url),'Unsafe URL');
    if(/^#chapter-/.test(url))assert(ids.has(url.slice(1).split('/')[0]),'Unknown chapter '+url);
    if(/^(?:[a-z]+:|#|\/\/)/i.test(url))continue;
    const path=decodeURIComponent(url.split(/[?#]/)[0]);
    if(path)assert(existsSync(resolve(root,base,path)),'Missing local file '+path);
  }
}
for(const chapter of data.chapters){
  assert(!/<(?:script|iframe|object|embed)\b/i.test(chapter.html));
  assert(chapter.sourceUrl.startsWith('https://github.com/modelscope/ms-cookbook/blob/main/content/chapters/'));
  assert(chapter.sourceUrl.endsWith('.md'));
  assert(chapter.editUrl.startsWith('https://github.com/modelscope/ms-cookbook/edit/main/content/source-html/'));
  assert(existsSync(resolve(root,'content/chapters',`chapter-${String(chapter.number).padStart(2,'0')}.md`)));
  const anchors=new Set([...chapter.html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
  for(const heading of chapter.headings)assert(anchors.has(heading.id));
  imageCount+=(chapter.html.match(/<img\b/g)||[]).length;
  attachmentCount+=(chapter.html.match(/class="attachment"/g)||[]).length;
  checkLinks(chapter.html);
  let articleImageIndex=0,eagerFollowers=0;
  for(const tag of chapter.html.matchAll(/<img\b[^>]*class="article-image"[^>]*>/g)){
    const src=/src="([^"]+)"/.exec(tag[0])[1];
    const width=/\swidth="(\d+)"/.exec(tag[0]), height=/\sheight="(\d+)"/.exec(tag[0]);
    assert(width&&height,`article image without intrinsic size: ${src}`);
    const size=imageSize(readFileSync(resolve(root,src.split('?')[0])));
    if(size)assert(Number(width[1])===size[0]&&Number(height[1])===size[1],
      `${src} declares ${width[1]}x${height[1]}, file is ${size[0]}x${size[1]}`);
    /* Only checking "the first image is eager" passes silently when a *later*
       image loses loading="lazy", so count every eager image after the first.
       The first one is the chapter's LCP element; the rest must stay lazy. */
    if(articleImageIndex++>0&&!/loading="lazy"/.test(tag[0]))eagerFollowers++;
  }
  assert(eagerFollowers===0,
    `chapter-${chapter.number} has ${eagerFollowers} article image(s) after the first one without loading="lazy"`);
  const firstImage=/<img\b[^>]*class="article-image"[^>]*>/.exec(chapter.html);
  if(firstImage)assert(!/loading="lazy"/.test(firstImage[0])&&/fetchpriority="high"/.test(firstImage[0]),
    `chapter-${chapter.number} first image must stay eager and high priority`);
}
assert.equal(imageCount,data.imageCount);assert.equal(attachmentCount,data.attachmentCount);
checkLinks(read('index.html'));
checkLinks(read('assets/analytics.html'));
assert(!/feishu\.cn/.test(read('index.html')),'Source UI must point to GitHub');
assert(!/art:'plane'|paper\/plane\.webp/.test(read('assets/paper.js')+read('index.html')));
checkLinks(read('README.md'));checkLinks(read('README.zh-CN.md'));
for(const css of ['assets/styles.css','assets/paper.css','assets/review.css','assets/reader-tools.css','assets/exercise.css']){
  for(const m of read(css).matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)){
    if(!/^(?:https?:|data:)/.test(m[1]))assert(existsSync(resolve(root,dirname(css),m[1].split('?')[0])),m[1]);
  }
}
/* The exercise bundle left index.html, so the old "listed before paper.js"
   rule is now the wrong contract. What still has to hold:
     1. the bundle is declared once, in paper.js, in dependency order;
     2. index.html does not ship it eagerly (a Chinese-only reader must not pay
        1.2 MB for a view they never open).
   Checked here because CI already runs this file. */
const indexHtml=read('index.html');
/* One parse, three uses: the eager/defer split below and the ordering rules
   that follow it. Two regexes would eventually disagree about what index.html
   declares, and the disagreement would be invisible -- both would still pass. */
const eager=[],deferred=[];
for(const [,attrs] of indexHtml.matchAll(/<script\b([^>]*)>/g)){
  const src=/\ssrc="assets\/([^"?]+\.js)/.exec(attrs);
  if(src)(/\sdefer\b/.test(attrs)?deferred:eager).push(src[1]);
}
const scriptOrder=[...eager,...deferred];
/* Two load-order contracts nothing else pins, added with the edit that made
   them matter. Exactly three scripts may block the parser -- the default
   dictionary, its prose and the book data, whose absence paints an empty page
   -- and they are named individually so a fourth eager tag cannot join them by
   accident. Every other script defers, and asset-loader.js goes first: every
   lazy bundle in the site is injected through it. */
assert.deepEqual(eager,['i18n.js','locale/zh.js','content.js'],
  'exactly assets/i18n.js, assets/locale/zh.js and assets/content.js may block the parser');
assert.equal(deferred[0],'asset-loader.js','asset-loader.js must be the first deferred script');
const EXERCISE_MODULES=['exercises.js','exercise-grader.js','exercise-store.js','exercise-sandbox.js','exercise-map.js','exercise-ui.js'];
for(const module of EXERCISE_MODULES){
  assert(!scriptOrder.includes(module),`index.html must not load ${module} eagerly`);
}
const bundleSource=read('assets/paper.js');
const bundleList=/const EXERCISE_BUNDLE = \[([\s\S]*?)\]/.exec(bundleSource);
assert(bundleList,'paper.js no longer declares EXERCISE_BUNDLE');
const bundle=[...bundleList[1].matchAll(/'assets\/([^'?]+)\.js/g)].map(m=>m[1]+'.js');
assert.deepEqual(bundle,EXERCISE_MODULES,'EXERCISE_BUNDLE order changed; exercises.js must stay first');
assert(scriptOrder.indexOf('asset-loader.js')<scriptOrder.indexOf('paper.js'),'asset-loader.js must load before paper.js');
const exerciseContext={window:{}};
vm.runInNewContext(read('assets/exercises.js'),exerciseContext);
const exercises=exerciseContext.window.EXERCISE_DATA;
assert(exercises&&exercises.chapters,'EXERCISE_DATA did not load');
const chapterIds=new Set(exercises.chapters?Object.keys(exercises.chapters):[]);
for(const chapterId of chapterIds)assert(ids.has(chapterId),'Exercise chapter is not in the book: '+chapterId);
const seenExercises=new Set();
for(const [chapterId,chapter] of Object.entries(exercises.chapters)){
  const counts=new Set();
  for(const lang of exercises.languages){
    const list=chapter.exercises[lang]||[];
    counts.add(list.length);
    // Ids are unique PER LANGUAGE, not globally: the localized lists carry the
    // same ids in the same order and only the prose differs, so one cross-language
    // seen-set reports every id in a three-language corpus as a duplicate. The
    // seenExercises set below therefore tracks the FIRST language only, where
    // uniqueness is a real invariant and spans chapters as well as languages.
    const seenHere=new Set();
    for(const item of list){
      assert(!seenHere.has(item.id),'Duplicate exercise id '+item.id+' in '+chapterId+'/'+lang);
      seenHere.add(item.id);
      if(lang===exercises.languages[0]){
        assert(!seenExercises.has(item.id),'Exercise id '+item.id+' is claimed by more than one chapter');
        seenExercises.add(item.id);
      }
      assert(item.chapter===chapterId,item.id+' points at the wrong chapter');
      assert(item.objective&&item.prompt&&item.explanation,item.id+' is missing required prose');
      assert(['code','predict','fill','build','reflect'].includes(item.type),item.id+' has an unknown type');
    }
  }
  assert(counts.size===1,chapterId+' language counts diverge');
}
assert(exercises.exerciseCount===seenExercises.size,'exerciseCount does not match the corpus');
const sandboxScript=read('assets/exercise-sandbox.js');
const workerScript=read('assets/exercise-worker.js');
assert(!/<script[^>]*pyodide/i.test(indexHtml),'Pyodide must stay out of index.html');
assert(workerScript.includes("importScripts('./vendor/pyodide/pyodide.js')"),'Worker must import the vendored Pyodide');
assert(sandboxScript.includes('assets/exercise-worker.js'),'Sandbox must default to the bundled worker');
console.log(`PASS: ${data.chapterCount} chapters, ${data.parts.length} parts, ${imageCount} image references, ${attachmentCount} attachments; ${seenExercises.size} exercises across ${chapterIds.size} chapters; local links and source routes valid.`);
