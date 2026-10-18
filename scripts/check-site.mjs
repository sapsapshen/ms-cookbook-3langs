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
/* Load order is load-bearing (Task 8's M-6): a script listed before something
   it reads leaves the panel silently absent, with nothing in the console. Every
   exercise module therefore has to precede paper.js, which calls
   renderExerciseMap() during its own startup. Checked here rather than only in
   scripts/test-exercise-wiring.cjs because this is the check CI already runs. */
const indexHtml=read('index.html');
const scriptOrder=[...indexHtml.matchAll(/<script[^>]*\ssrc="assets\/([^"?]+\.js)/g)].map(m=>m[1]);
const paperIndex=scriptOrder.indexOf('paper.js');
assert(paperIndex!==-1,'index.html no longer loads paper.js');
for(const module of ['exercises.js','exercise-grader.js','exercise-store.js','exercise-sandbox.js','exercise-map.js','exercise-ui.js']){
  const at=scriptOrder.indexOf(module);
  assert(at!==-1,module+' is not loaded by index.html');
  assert(at<paperIndex,module+' must be loaded before paper.js');
}
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
