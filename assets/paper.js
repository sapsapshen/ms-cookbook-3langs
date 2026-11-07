(() => {
  'use strict';
  const data = window.BOOK_DATA;
  const chapters = new Map(data.chapters.map(c => [c.id, c]));
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const t = window.MSI18N.t;
  // Article prose is contributed in Chinese; the translated editions live in
  // assets/content-i18n/*.js keyed by the exact Chinese source, so anchors, code
  // blocks and markup stay byte-identical to the published source.
  const BLOCK_SELECTOR = 'p,li,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,dt,dd';
  const articleKey = text => String(text).replace(/\s+/g, ' ').trim();
  function articleMap(chapterId) {
    const pack = window.MS_ARTICLE && window.MS_ARTICLE[window.MSI18N.lang];
    return (pack && pack[chapterId]) || null;
  }
  function headingText(heading, chapter) {
    const value = chapter ? articleMap(chapter.id)?.[articleKey(heading.text)] : null;
    return typeof value === 'string' ? value : heading.text;
  }
  function applyArticleTranslation(chapter) {
    const map = articleMap(chapter.id);
    if (!map) return false;
    // Structural blocks plus standalone attachment links, which sit outside any block.
    $$('#articleBody :is(' + BLOCK_SELECTOR + ',a)').forEach(block => {
      if (block.closest('pre')) return;
      if (block.tagName === 'A') { if (block.closest(BLOCK_SELECTOR)) return; }
      else if (block.querySelector(BLOCK_SELECTOR)) return;
      const value = map[articleKey(block.textContent)];
      if (typeof value !== 'string') return;
      if (block.children.length) block.innerHTML = value; else block.textContent = value;
    });
    return map.__complete === true;
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const shortTitle = title => title.replace(/^第[^　\s]+章[　\s]*/, '');
  // Part names and chapter titles live in the Chinese content bundle; the locale files
  // carry the translated labels and the source text stays as the fallback.
  const partKey = index => 'partName.' + String(index + 1).padStart(2, '0');
  const chapterKey = chapter => 'chapterTitle.' + String(chapter.number).padStart(2, '0');
  function partName(index) {
    const key = partKey(index);
    return window.MSI18N.has(key) ? t(key) : (data.parts[index].shortTitle || data.parts[index].title);
  }
  function chapterTitle(chapter) {
    const key = chapterKey(chapter);
    return window.MSI18N.has(key) ? t(key) : shortTitle(chapter.title);
  }
  let paths = {};
  const PATH_ART = {beginner:'seedling', model:'mountain', application:'cubes', aigc:'palette'};
  const PATH_CHAPTERS = {beginner:[1,5,7], model:[12,13,15], application:[19,27,28], aigc:[21,22,23,25]};
  function refreshPaths() {
    const build = key => ({
      key,
      name: t('path.'+key+'.name'),
      title: t('path.'+key+'.title'),
      art: PATH_ART[key],
      desc: t('path.'+key+'.desc'),
      brief: t('path.'+key+'.brief'),
      steps: t('path.'+key+'.steps'),
      link: t('path.'+key+'.link'),
      chapters: PATH_CHAPTERS[key],
      labels: [1,2,3,4].map(i => t('path.'+key+'.label'+i)),
      notes: [1,2,3,4].map(i => t('path.'+key+'.note'+i))
    });
    paths = {beginner:build('beginner'), model:build('model'), application:build('application'), aigc:build('aigc')};
  }
  refreshPaths();
  const SCENE_ART = {16:'fitness',17:'service',18:'speech',19:'knowledge',23:'product'};
  const SCENE_TYPE = {16:'scene.type.vision',17:'scene.type.speechAnalysis',18:'scene.type.speech',19:'scene.type.rag',23:'scene.type.aigc'};
  const arrow = '<img class="arrow" src="assets/home/arrow.svg" alt="">';
  const artSource = art => `assets/editorial-art/${art}.png`;
  let currentChapter = null;
  let currentView = '';
  let currentPathKey = '';
  let activeHeading = '';
  const {chapterHash, pathStep, parseHash} = window.ReaderRoutes;
  let headingObserver;
  // Heading id -> the last entry the observer delivered for it. Entries carry
  // boundingClientRect and isIntersecting for free, so the active heading is
  // known without asking the layout where every heading sits.
  const headingPositions = new Map();
  let headingFrame = 0;
  let searchTimer;
  // Rebuilt per language: the index always carries the translated chapter title next to
  // the Chinese source, so searching works in whichever language the reader picked.
  function buildSearchIndex() {
    return new Map(data.chapters.map(c => {
      const holder = document.createElement('div'); holder.innerHTML = c.html;
      const translated = window.MSI18N.has(chapterKey(c)) ? ' '+t(chapterKey(c)) : '';
      // Translated prose is indexed too, so search works in the picked language.
      const map = articleMap(c.id);
      const prose = map ? ' ' + Object.values(map).join(' ').replace(/<[^>]+>/g, ' ') : '';
      return [c.id, (c.title+translated+' '+c.headings.map(h=>h.text).join(' ')+' '+holder.textContent+prose).toLowerCase()];
    }));
  }
  let searchIndex = buildSearchIndex();

  function renderProjectLinks() {
    const markup = `<a href="https://github.com/sapsapshen/ms-cookbook-3langs" target="_blank" rel="noopener noreferrer">${t('links.github')}</a><a href="#contribute">${t('links.contribute')}</a>`;
    $$('.project-links').forEach(el=>{el.innerHTML=markup;});
    $$('.quiet-footer').forEach(el=>{if(!el.querySelector('.project-links'))el.insertAdjacentHTML('beforeend',`<div class="project-links">${markup}</div>`);});
  }
  function renderHomePaths() {
    $('#homePaths').innerHTML = Object.entries(paths).map(([key,p]) => `<article><a class="path-art-link" href="#paths/${key}" aria-label="${esc(p.name)}"><img src="${artSource(p.art)}" alt="" width="400" height="250"></a><h3>${esc(p.name)}</h3><p class="path-brief">${esc(p.brief)}</p><p>${esc(p.steps)}</p><a class="text-link" href="#paths/${key}">${esc(p.link)} ${arrow}</a></article>`).join('');
  }
  function renderScenes() {
    $('#sceneGrid').innerHTML = Object.keys(SCENE_ART).map(id => {
      const title = t('scene.'+id+'.title');
      return `<article class="scene"><a class="scene-art" href="#chapter-${id}" aria-label="${esc(title)}"><img src="${artSource(SCENE_ART[id])}" alt="" width="320" height="260" loading="lazy"></a><div class="scene-copy"><h2><a href="#chapter-${id}">${esc(title)}</a></h2><p>${esc(t('scene.'+id+'.desc'))}</p><div class="scene-meta"><span>${esc(t('practice.sceneMeta',{n:id,type:t(SCENE_TYPE[id])}))}</span><a class="text-link" href="#chapter-${id}">${esc(chapters.get('chapter-'+id).status==='pending'?t('practice.viewChapter'):t('practice.readPractice'))} ${arrow}</a></div></div></article>`;
    }).join('');
  }
  /* The learning map is injected by assets/exercise-map.js (G1: the practice
     view is page markup, so the map is built by script like every other piece
     of exercise UI). It reads progress out of the same store the chapter panel
     writes to, so the reader's own passes are on it the moment they arrive.

     Three moments, not two. Init and a language switch come from the brief;
     the third is the reader ARRIVING here. Without it the grid would keep
     showing whatever was true when the page loaded -- a learner who passed
     three exercises in chapter 7 and then opened this view would be told they
     had done nothing. Repainting is idempotent (the map replaces its own
     contents), and it is guarded by the router's own `view === 'practice'`, so
     a reader sitting in a chapter does not pay for a grid they cannot see. */
  const EXERCISE_BUNDLE = ['assets/exercises.js?v=e08be2062f82', 'assets/exercise-grader.js?v=3c6548035306',
    'assets/exercise-store.js?v=60f13f8a96a2', 'assets/exercise-sandbox.js?v=248ef0a7613b',
    'assets/exercise-map.js?v=93478189a6bf', 'assets/exercise-ui.js?v=03b76ab6967b'];
  function ensureExerciseBundle() { return window.AssetLoader.loadSequence(EXERCISE_BUNDLE); }
  /* The practice view has nothing to show until 1.2 MB of modules land, so its
     status line goes into the map's own container -- and carries role="status",
     or a screen reader never learns the wait exists. The element itself is not
     replaced (ExerciseMap.render() swaps its children), so the role has to be
     taken off again before the grid paints, or the whole map is announced as one
     long status message on every repaint. */
  function paintPracticeStatus(text) {
    const slot=$('#exerciseMap');
    if(!slot)return;
    slot.setAttribute('role','status');
    slot.textContent=text;
  }
  /* Startup keeps the original guard: a reader who never opens #practice must not
     pay 1.2 MB for it, so the eager call sites stay a no-op until the bundle lands. */
  function renderExerciseMap() {
    const slot=$('#exerciseMap');
    if(slot)slot.removeAttribute('role');
    if (window.ExerciseMap) window.ExerciseMap.render();
  }
  /* Both #practice entries share this: the route body paints the status line (it
     has to be on the first paint), this starts the fetch. A page without the
     injection primitive can never complete the pack, so it says so instead of
     dereferencing nil. */
  function loadPracticeBundle() {
    if(!window.AssetLoader){paintPracticeStatus(t('practice.loadFailed'));return;}
    ensureExerciseBundle().then(renderExerciseMap).catch(error=>{
      paintPracticeStatus(t('practice.loadFailed'));
      console.warn('exercise bundle failed to load',error);
    });
  }
  renderProjectLinks(); renderHomePaths(); renderScenes(); renderExerciseMap();

  function highlighted(text,query) {
    if (!query) return esc(text);
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    if (index<0) return esc(text);
    return esc(text.slice(0,index))+'<mark>'+esc(text.slice(index,index+query.length))+'</mark>'+esc(text.slice(index+query.length));
  }
  function renderIndex() {
    const query = $('#chapterSearch').value.trim();
    const q = query.toLowerCase();
    let count = 0;
    $('#bookIndex').innerHTML = data.parts.map((part,i)=> {
      const ids = part.chapters.filter(id=>!q || searchIndex.get(id).includes(q) || partName(i).toLowerCase().includes(q));
      count += ids.length;
      if (!ids.length) return '';
      return `<section class="index-part"><div class="part-badge"><small>PART</small><span>${String(i+1).padStart(2,'0')}</span></div><div><h2>${esc(partName(i))}</h2><nav aria-label="${esc(partName(i))}">${ids.map(id=>{
        const c=chapters.get(id);
        const heading=q ? c.headings.find(h=>h.text.toLowerCase().includes(q)) : null;
        return `<a href="#${id}"><span class="chapter-index">${String(c.number).padStart(2,'0')}</span><span>${highlighted(chapterTitle(c),query)}${c.status==='pending'?`<small class="pending-badge">${esc(t('contents.pendingBadge'))}</small>`:''}${heading ? `<small class="search-context">${highlighted(heading.text,query)}</small>`:''}</span>${arrow}</a>`;
      }).join('')}</nav></div></section>`;
    }).join('');
    $('#searchStatus').hidden = !query;
    $('#searchStatus').textContent = t('contents.searchStatus',{query,count});
    $('#emptySearch').hidden = count>0;
  }
  $('#chapterSearch').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(renderIndex,100);});
  $('#clearSearch').addEventListener('click',()=>{$('#chapterSearch').value='';renderIndex();$('#chapterSearch').focus();});

  let bookSearchDocuments;
  let bookSearchLanguage = '';
  let bookSearchTimer;
  function createBookSearchDocuments() {
    return data.chapters.flatMap(chapter => {
      const holder=document.createElement('div');holder.innerHTML=chapter.html;
      const headings=new Map(chapter.headings.filter(h=>h.text.trim()).map(h=>[h.id,h]));
      const base={chapterId:chapter.id,number:chapter.number,title:chapterTitle(chapter),status:chapter.status};
      let section={...base,headingId:'',heading:'',text:[]};
      const sections=[section];
      const walker=document.createTreeWalker(holder,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
      let node;
      while((node=walker.nextNode())) {
        if(node.nodeType===Node.ELEMENT_NODE&&headings.has(node.id)) {
          section={...base,headingId:node.id,heading:headings.get(node.id).text,text:[]};sections.push(section);
        } else if(node.nodeType===Node.TEXT_NODE&&!headings.has(node.parentElement.closest('h2,h3,h4')?.id)) section.text.push(node.textContent);
      }
      return sections.map(s=>({...s,text:s.text.join(' ').replace(/\s+/g,' ').trim()}));
    });
  }
  function searchHighlight(text,query) {
    const tokens=query.trim().split(/\s+/).filter(Boolean).map(token=>token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    if(!tokens.length)return esc(text);
    const pattern=new RegExp(tokens.join('|'),'gi');
    let result='',end=0;
    for(const match of text.matchAll(pattern)) {
      result+=esc(text.slice(end,match.index))+'<mark>'+esc(match[0])+'</mark>';end=match.index+match[0].length;
    }
    return result+esc(text.slice(end));
  }
  function renderBookSearch() {
    clearTimeout(bookSearchTimer);bookSearchTimer=null;
    const query=$('#bookSearchInput').value.trim();
    let results,total;
    if(query) ({results,total}=window.BookSearch.search(bookSearchDocuments,query));
    else {
      const ids=[...new Set([currentChapter?.id,'chapter-1','chapter-13','chapter-19','chapter-22','chapter-27'])];
      results=ids.map(id=>bookSearchDocuments.find(d=>d.chapterId===id&&!d.headingId)).filter(Boolean);
    }
    $('#bookSearchStatus').textContent=query
      ? (total ? t('search.statusFound',{total})+(total>results.length?t('search.statusTruncated',{shown:results.length}):'') : t('search.statusNone'))
      : t('search.statusEmpty');
    $('#bookSearchResults').innerHTML=results.length?results.map(result=>{
      const label=result.heading||result.title;
      const context=result.heading?result.title:(result.chapterId===currentChapter?.id&&!query?t('search.contextReading'):result.status==='pending'?t('search.contextPending'):t('search.contextStart'));
      const pathKey=pathStep(paths,currentPathKey,result.number)?currentPathKey:'';
      return `<a class="book-search-result" href="${chapterHash(result.chapterId,result.headingId,pathKey)}"><small>${esc(t('search.chapterLabel',{n:result.number,context}))}</small><strong>${searchHighlight(label,query)}</strong>${query&&result.snippet?`<p>${searchHighlight(result.snippet,query)}</p>`:''}</a>`;
    }).join(''):`<div class="book-search-empty"><strong>${esc(t('search.emptyTitle'))}</strong>${esc(t('search.emptyDesc'))}</div>`;
    $('#bookSearchResults').scrollTop=0;
  }
  function openBookSearch() {
    if(!bookSearchDocuments||bookSearchLanguage!==window.MSI18N.lang){bookSearchDocuments=createBookSearchDocuments();bookSearchLanguage=window.MSI18N.lang;}
    clearTimeout(bookSearchTimer);renderBookSearch();openDialog('#bookSearchDialog');
    $('#bookSearchInput').focus();$('#bookSearchInput').select();
  }
  $('#readerSearchButton').addEventListener('click',openBookSearch);
  $('#bookSearchInput').addEventListener('input',()=>{clearTimeout(bookSearchTimer);bookSearchTimer=setTimeout(renderBookSearch,100);});
  $('#bookSearchDialog').addEventListener('keydown',e=>{
    if(e.isComposing)return;
    if(['ArrowDown','ArrowUp'].includes(e.key)&&bookSearchTimer)renderBookSearch();
    const results=$$('#bookSearchResults a');
    if(['ArrowDown','ArrowUp'].includes(e.key)&&results.length) {
      e.preventDefault();const index=results.indexOf(document.activeElement);
      const next=index<0?(e.key==='ArrowDown'?0:results.length-1):(index+(e.key==='ArrowDown'?1:-1)+results.length)%results.length;
      results[next].focus({preventScroll:true});results[next].scrollIntoView({block:'nearest',behavior:'instant'});
    } else if(e.key==='Enter'&&e.target===$('#bookSearchInput')) {
      e.preventDefault();clearTimeout(bookSearchTimer);renderBookSearch();$('#bookSearchResults a')?.click();
    }
  });
  $('#searchShortcut').textContent=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘ K':'Ctrl K';
  document.addEventListener('keydown',e=>{
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'&&!e.isComposing) {
      e.preventDefault();openBookSearch();
    }
  });

  function ensureCurrentChapterVisible() {
    const nav=$('#chapterNav'),active=nav.querySelector('[aria-current="page"]');
    if(!active||!nav.clientHeight)return;
    const rect=active.getBoundingClientRect(),bounds=nav.getBoundingClientRect();
    if(rect.top<bounds.top||rect.bottom>bounds.bottom)nav.scrollTop+=rect.top-bounds.top-(nav.clientHeight-rect.height)/2;
  }
  function setSidebarCollapsed(collapsed,keepPosition=false) {
    // One read pass, every element measured once, and nothing measured on the
    // startup path that keeps its position. The only read left after the writes
    // is the anchor's new position: collapsing the sidebar re-wraps the prose, so
    // where the anchor lands cannot be known before the layout has run.
    let anchor=null,before;
    if(keepPosition) {
      const top=$('.app-header').getBoundingClientRect().bottom+24;
      for(const el of $$('#article h1,#article h2,#article h3,#article p,#article pre')){
        const rect=el.getBoundingClientRect();if(rect.bottom>top){anchor=el;before=rect.top;break;}
      }
    }
    document.body.classList.toggle('sidebar-collapsed',collapsed);
    $('#bookSidebar').hidden=collapsed;$('#expandSidebar').hidden=!collapsed;
    if(anchor)window.scrollBy({top:anchor.getBoundingClientRect().top-before,behavior:'instant'});
    if(keepPosition)(collapsed?$('#expandSidebar'):$('#collapseSidebar')).focus({preventScroll:true});
    if(!collapsed)ensureCurrentChapterVisible();
    try{localStorage.setItem('ms-cookbook-sidebar-collapsed',String(collapsed));}catch{/* Storage can be disabled in embedded readers. */}
    updateProgress();
  }
  $('#collapseSidebar').addEventListener('click',()=>setSidebarCollapsed(true,true));
  $('#expandSidebar').addEventListener('click',()=>setSidebarCollapsed(false,true));
  try{setSidebarCollapsed(localStorage.getItem('ms-cookbook-sidebar-collapsed')==='true');}catch{/* Keep the default expanded view. */}

  function buildChapterNav() {
    const markup = data.parts.map((p,i)=>`<details data-part="${i}"><summary><span class="part-index">${String(i+1).padStart(2,'0')}</span><span>${esc(partName(i))}</span></summary><div class="chapter-list">${p.chapters.map(id=>{const c=chapters.get(id);return `<a href="#${id}" data-chapter="${id}"><span>${String(c.number).padStart(2,'0')}</span>${esc(chapterTitle(c))}</a>`;}).join('')}</div></details>`).join('');
    $('#chapterNav').innerHTML = markup; $('#mobileChapterNav').innerHTML = markup;
  }
  function renderPath(key) {
    const p=paths[key] || paths.beginner;
    const selected = paths[key] ? key : 'beginner';
    $$('.path-tabs button').forEach(b=>{const on=b.dataset.path===selected;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;});
    $('#pathPanel').setAttribute('aria-labelledby','tab-'+selected);
    $('#pathArt').src=artSource(p.art); $('#pathArt').alt=t('a11y.pathArt',{name:p.name});
    $('#aigcContributions').hidden=selected!=='aigc';
    $('#pathTitle').textContent=p.title; $('#pathDescription').textContent=p.desc;
    $('#pathStart').href=chapterHash('chapter-'+p.chapters[0],'',selected);
    $('#pathStations').style.setProperty('--stations',p.chapters.length);
    $('#pathStations').innerHTML=p.chapters.map((n,i)=>`<li><span class="station-number">${String(i+1).padStart(2,'0')}</span><h3>${esc(p.labels[i])}</h3><small>${esc(t('paths.chapterOf',{n}))}</small><p class="station-title">${esc(chapterTitle(chapters.get('chapter-'+n)))}</p><p>${esc(p.notes[i])}</p><a class="text-link" href="${chapterHash('chapter-'+n,'',selected)}">${esc(t('paths.readChapter'))} ${arrow}</a></li>`).join('');
  }
  function renderPathNavigation(chapter) {
    const step=pathStep(paths,currentPathKey,chapter.number);
    document.body.classList.toggle('reading-path-active',!!step);
    const panels=$$('[data-path-reader]');
    panels.forEach(panel=>{panel.hidden=!step;});
    $('#previousChapter small').textContent=step?t('reader.previousAll'):t('reader.previousChapter');
    $('#nextChapter small').textContent=step?t('reader.nextAll'):t('reader.nextChapter');
    $('#mobilePrevious').textContent=step?t('reader.pathPrevious'):t('reader.previousChapter');
    $('#mobileNext').textContent=step?t('reader.pathNext'):t('reader.nextChapter')+' →';
    if(!step)return;
    const path=paths[currentPathKey];
    const previous=step.previous?chapterHash('chapter-'+step.previous,'',currentPathKey):'';
    const next=step.next?chapterHash('chapter-'+step.next,'',currentPathKey):'';
    const markup=`<div class="path-reader-heading"><span>${t('reader.pathHeadingHtml',{name:esc(path.name)})}<small>${esc(t('reader.stepOf',{index:step.index+1,total:step.total}))}</small></span><a href="#paths/${currentPathKey}">${esc(t('reader.pathBack'))}</a></div><ol class="path-reader-steps">${path.chapters.map(n=>`<li><a href="${chapterHash('chapter-'+n,'',currentPathKey)}"${n===chapter.number?' aria-current="step"':''} title="${esc(chapterTitle(chapters.get('chapter-'+n)))}">${esc(t('reader.pathChapter',{n}))}</a></li>`).join('')}</ol><div class="path-reader-actions">${previous?`<a href="${previous}" data-path-direction="previous">${esc(t('reader.pathPreviousStep',{n:step.previous}))}</a>`:`<span>${esc(t('reader.pathStartHere'))}</span>`}${next?`<a href="${next}" data-path-direction="next">${esc(t('reader.pathNextStep',{n:step.next}))}</a>`:`<span class="path-reader-last">${esc(t('reader.pathLast'))}</span>`}</div>`;
    panels.forEach(panel=>{panel.innerHTML=markup;});
    setPager($('#mobilePrevious'),step.previous?chapters.get('chapter-'+step.previous):null);
    if(previous)$('#mobilePrevious').href=previous;
    if(next)$('#mobileNext').href=next;
    else {
      $('#mobileNext').href='#paths/'+currentPathKey;$('#mobileNext').textContent=t('reader.returnPath');$('#mobileNext').classList.remove('disabled');$('#mobileNext').removeAttribute('tabindex');$('#mobileNext').setAttribute('aria-disabled','false');
    }
  }
  $$('.path-tabs button').forEach((b,i)=> {
    b.addEventListener('click',()=>{location.hash='paths/'+b.dataset.path;});
    b.addEventListener('keydown',e=> {
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
      e.preventDefault();const list=$$('.path-tabs button');
      const next=e.key==='Home'?0:e.key==='End'?list.length-1:(i+(e.key==='ArrowRight'?1:-1)+list.length)%list.length;
      list[next].focus();list[next].click();
    });
  });
  function setPager(node,chapter) {
    node.classList.toggle('disabled',!chapter);
    node.setAttribute('aria-disabled',String(!chapter));
    if(chapter){node.href='#'+chapter.id;node.removeAttribute('tabindex');const text=node.querySelector('span');if(text)text.textContent=chapterTitle(chapter);}
    else {node.removeAttribute('href');node.tabIndex=-1;}
  }
  function closeDialogs() {$$('dialog[open]').forEach(d=>d.close());document.body.classList.remove('modal-open');}
  function openDialog(id) {
    closeDialogs();$(id).showModal();document.body.classList.add('modal-open');
    if(id==='#tocDialog')requestAnimationFrame(()=>{
      const active=$('#mobileToc [aria-current="location"]')||$('#mobileToc a');
      if(active){active.focus({preventScroll:true});active.scrollIntoView({block:'nearest',behavior:'instant'});}
    });
  }
  $$('[data-close]').forEach(b=>b.addEventListener('click',()=>$('#'+b.dataset.close).close()));
  $$('dialog').forEach(d=>{
    d.addEventListener('close',()=>document.body.classList.toggle('modal-open',!!$('dialog[open]')));
    d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});
  });
  $('#menuButton').addEventListener('click',()=>openDialog('#siteMenu'));
  $('#tocButton').addEventListener('click',()=>openDialog('#tocDialog'));
  $('#readerTocButton').addEventListener('click',()=>openDialog('#tocDialog'));
  $('#backTop').addEventListener('click',e=>{e.preventDefault();window.scrollTo({top:0,behavior:'smooth'});});

  function syncTranslationNotice(chapter) {
    const notice=$('#translationNotice');
    if(!notice)return;
    const translated=!!(chapter&&articleMap(chapter.id)?.__complete);
    notice.hidden=window.MSI18N.lang==='zh'||translated;
    if(!notice.hidden)notice.textContent=t('reader.translationNotice',{language:t('common.languageName')});
  }
  function renderChapter(chapter) {
    currentChapter=chapter;
    const index=data.chapters.indexOf(chapter);
    const partIndex=data.parts.findIndex(p=>p.chapters.includes(chapter.id));
    $('#partLabel').textContent=t('reader.partLabel',{ordinal:t('part.'+(partIndex+1)),part:partName(partIndex)});
    $('#chapterTitle').textContent=chapterTitle(chapter);
    $('#chapterNumber').textContent=t('reader.chapterNumber',{n:chapter.number});
    $('#readTime').textContent=chapter.status==='pending'?t('reader.pending'):t('reader.readMinutes',{n:chapter.minutes});
    $('#chapterSource').href=chapter.sourceUrl;
    $('#chapterEdit').href=chapter.editUrl;
    $('#articleBody').innerHTML=chapter.html;
    applyArticleTranslation(chapter);
    $$('#articleBody .arithmatex').forEach(el=>{
      const text=el.textContent, display=el.classList.contains('display-math');
      const formula=text.slice(2,-2);
      if(window.katex)window.katex.render(formula,el,{displayMode:display,throwOnError:false,strict:'ignore',trust:false});
    });
    document.title=t('doc.chapter',{title:chapterTitle(chapter)});
    const prev=data.chapters[index-1],next=data.chapters[index+1];
    setPager($('#previousChapter'),prev);setPager($('#nextChapter'),next);
    setPager($('#mobilePrevious'),prev);setPager($('#mobileNext'),next);
    renderPathNavigation(chapter);
    syncTranslationNotice(chapter);
    const emptyToc=`<p class="toc-empty">${esc(t('contents.tocEmpty'))}</p>`;
    const toc=chapter.headings.filter(h=>h.text.trim()).map(h=>`<a href="${chapterHash(chapter.id,h.id,currentPathKey)}" data-heading="${h.id}" data-level="${h.level}">${esc(headingText(h,chapter))}</a>`).join('');
    $('#localToc').innerHTML=toc || emptyToc;$('#mobileToc').innerHTML=toc || emptyToc;
    activeHeading='';headingPositions.clear();
    if(headingFrame)cancelAnimationFrame(headingFrame);
    $$('.chapter-nav details').forEach(d=>{d.open=Number(d.dataset.part)===partIndex;});
    $$('[data-chapter]').forEach(a=>{const active=a.dataset.chapter===chapter.id;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    $$('#articleBody img').forEach(img=> {
      img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label',t('a11y.zoomImage'));
      const show=()=>{$('#viewerImage').src=img.src;$('#viewerImage').alt=img.alt;openDialog('#imageViewer');};
      img.addEventListener('click',show);img.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();show();}});
    });
    $$('#articleBody pre').forEach(pre=>{
      const code=pre.querySelector('code')?.textContent||pre.textContent;
      const button=document.createElement('button');button.className='copy-code';button.textContent=t('reader.copy');button.setAttribute('aria-label',t('a11y.copyCode'));
      button.addEventListener('click',async()=>{
        try{await navigator.clipboard.writeText(code);button.textContent=t('reader.copied');}
        catch{const range=document.createRange();range.selectNodeContents(pre.querySelector('code')||pre);getSelection().removeAllRanges();getSelection().addRange(range);button.textContent=t('reader.copiedSelection');}
        setTimeout(()=>button.textContent=t('reader.copy'),2000);
      });pre.append(button);
    });
    // Everything from here on reads geometry, so it happens in one frame after
    // the writes above instead of interleaving a read with every write. The band
    // starts a million pixels above the viewport and ends on the 24% line, so
    // entry.isIntersecting is exactly "this heading is at or above the line" and
    // a heading cannot jump over the band between two samples without its
    // boolean flipping.
    if(headingObserver)headingObserver.disconnect();
    requestAnimationFrame(()=>{
      headingObserver=new IntersectionObserver(updateActiveHeading,{rootMargin:'1000000px 0px -76% 0px',threshold:0});
      chapter.headings.filter(h=>h.text.trim()).forEach(h=>{const target=document.getElementById(h.id);if(target)headingObserver.observe(target);});
      $('#localToc').scrollTop=0;
      afterLayout(measureAndProgress);
    });
  }
  function updateActiveHeading(entries) {
    if(currentView!=='reader'||!currentChapter)return;
    for(const entry of entries||[]) headingPositions.set(entry.target.id,entry);
    // The newest heading the observer has seen at or above the 24% line. A
    // record survives until a later crossing replaces it, and both edges of the
    // band sit at or above that line, so a stale record never un-highlights a
    // heading the live scan would still have kept.
    const line=window.innerHeight*0.24;
    const headings=currentChapter.headings.filter(h=>h.text.trim());
    let active=headings[0]?.id;
    for(const h of headings){
      const seen=headingPositions.get(h.id);
      if(seen&&(seen.isIntersecting||seen.boundingClientRect.top<=line))active=h.id;
    }
    if(active===activeHeading)return;
    // One frame per change, and the latest change wins: measuring inside the
    // frame means a flick that moved two headings never reads after a write.
    if(headingFrame)cancelAnimationFrame(headingFrame);
    headingFrame=requestAnimationFrame(()=>applyActiveHeading(active));
  }
  function applyActiveHeading(active) {
    if(currentView!=='reader'||active===activeHeading)return;
    const nav=$('#localToc'),link=nav.querySelector(`[data-heading="${CSS.escape(active)}"]`);
    // Read first, write last. `.active` only changes colour and an absolutely
    // positioned marker, so the box measured before the class lands is the box
    // the reader sees, and nothing here forces a layout.
    let delta=null;
    if(link&&nav.clientHeight) {
      const bounds=nav.getBoundingClientRect(),rect=link.getBoundingClientRect();
      if(rect.top<bounds.top||rect.bottom>bounds.bottom)delta=rect.top-bounds.top-(nav.clientHeight-rect.height)/2;
    }
    activeHeading=active;
    $$('[data-heading]').forEach(a=>{const on=a.dataset.heading===active;a.classList.toggle('active',on);if(on)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');});
    if(delta!==null)nav.scrollTop+=delta;
  }
  let articleTop = 0, articleHeight = 1;
  /* Reading offsetHeight inside a scroll handler forces a layout on every frame
     of a 400k-word document. The article's box only changes when the chapter
     changes or the viewport does, so those are the only two moments we measure;
     the scroll handler then does arithmetic on scrollY, which reads no layout. */
  function measureArticle() {
    const article = $('#article');
    const rect = article.getBoundingClientRect();
    articleTop = rect.top + window.scrollY;
    articleHeight = Math.max(1, article.offsetHeight - window.innerHeight);
  }
  function measureAndProgress() { measureArticle(); updateProgress(); }
  /* A read in the frame that follows a write burst makes the browser lay the new
     document out inside the task; a read one frame later finds the layout it
     already computed for painting, and costs nothing. A chapter render and an
     in-place route are the only paths that rewrite the whole article, so they are
     the only ones that need the wait. */
  function afterLayout(read) { requestAnimationFrame(()=>requestAnimationFrame(read)); }
  function updateProgress() {
    if(currentView!=='reader')return;
    // scrollY and the cached box are the only inputs: no layout property is read,
    // so a scroll event cannot force a layout of a 400k-word document. Heading
    // highlighting is not here -- it belongs to the observer, which reports the
    // crossings this scan used to measure on every frame.
    $('#readingProgress').style.width=Math.max(0,Math.min(100,(window.scrollY-articleTop)/articleHeight*100))+'%';
  }
  function route(options) {
    // A language switch re-runs the router in place: dialogs stay open and the
    // reader keeps its scroll position.
    const inPlace=!!(options&&options.inPlace);
    // Preserve community links published before the route was named contribute.
    if(location.hash==='#community')history.replaceState(null,'','#contribute');
    const {name,sub,pathKey}=parseHash(location.hash,paths);
    const previousPage=currentView==='reader'?currentChapter?.id:currentView;
    const pathChanged=currentPathKey!==pathKey;
    currentPathKey=pathKey;
    const chapter=chapters.get(name);
    const view=chapter?'reader':['contents','paths','practice','contribute'].includes(name)?name:'home';
    const samePath=currentView==='paths'&&view==='paths';
    const apply = () => {
      if(!inPlace)closeDialogs();
      $$('[data-page]').forEach(p=>p.hidden=p.dataset.page!==view);
      document.body.dataset.view=view;
      $$('.desktop-nav [data-route]').forEach(a=>{if(a.dataset.route===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
      $('#headerAction').textContent=view==='reader'?t('nav.backHome'):t('nav.startReading');$('#headerAction').href=view==='reader'?'#home':'#chapter-1';
      $('#mobileChapterNav').hidden=view!=='reader';
      if(view==='reader') {
        if(currentChapter?.id!==chapter.id||currentView!=='reader'||pathChanged)renderChapter(chapter);
      } else {
        if(headingObserver)headingObserver.disconnect();
        document.title=t('doc.'+view)+t('doc.suffix');
        if(view==='contents')renderIndex();if(view==='paths')renderPath(sub);
        if(view==='practice'){
          if(window.ExerciseMap)renderExerciseMap();
          else paintPracticeStatus(t('practice.loading'));
        }
      }
      currentView=view;
    };
    // A language switch re-runs in place, and the first route of a visit has no
    // previous view to fade from: a #chapter-1 deep link would otherwise paint
    // the rendered home page and then cross-fade it into the chapter.
    const swap = (inPlace || !currentView || !window.Motion) ? (apply(), undefined) : window.Motion.transition(apply);
    if(inPlace){
      // The language switch that lands here has just rewritten the article, so
      // the bar waits for the browser's own layout pass instead of forcing one.
      afterLayout(updateProgress);
      /* No frame is scheduled for an in-place route, and a language switch into
         #practice is also the retry path for a bundle that failed before. Nothing
         here is waiting on a first paint, so the fetch can start at once. */
      if(view==='practice'&&!window.ExerciseMap)loadPracticeBundle();
      return;
    }
    const analyticsPage=view==='reader'?chapter.id:view;
    if(analyticsPage!==previousPage)window.dispatchEvent(new CustomEvent('purplebook:route',{detail:{page:analyticsPage}}));
    const after = () => requestAnimationFrame(()=>{
      if(view==='reader'&&sub){const target=document.getElementById(sub);if(target){target.scrollIntoView({block:'start',behavior:'instant'});target.tabIndex=-1;target.focus({preventScroll:true});}}
      else if(!samePath)window.scrollTo({top:0,behavior:'instant'});
      if(view==='reader')ensureCurrentChapterVisible();
      updateProgress();
      /* The bundle is not only the #practice map: assets/exercise-ui.js is the
         only mount point for the in-chapter panel, so a reader who deep links
         into a chapter would lose it if #practice were the only trigger. Both
         triggers run in this post-render frame rather than in the route body:
         the chapter's or the map's markup is complete before the injection
         starts, and the fetch queues behind whatever the first paint needs.
         Nothing awaits either one -- AssetLoader memoises the six modules, the
         panel mounts itself when they land, and a bundle that never arrives
         costs the chapter view only the panel, so that failure is swallowed and
         only logged (`window.AssetLoader` is checked first, so a page without
         the primitive still renders instead of throwing in this frame). */
      if(view==='practice'&&!window.ExerciseMap)loadPracticeBundle();
      if(view==='reader'&&!window.ExerciseMap&&window.AssetLoader)ensureExerciseBundle().catch(error=>console.warn('exercise bundle failed to load',error));
      if(window.Motion)window.Motion.scan();
    });
    if(swap && swap.ready) swap.ready.then(after,error=>{console.error('view transition failed',error);after();}); else after();
  }
  // A language change rewrites every string the router and panels own.
  window.MSI18N.on(()=>{
    refreshPaths();
    searchIndex=buildSearchIndex();
    renderProjectLinks();renderHomePaths();renderScenes();renderExerciseMap();buildChapterNav();renderIndex();
    if(currentView==='reader'&&currentChapter)renderChapter(currentChapter);
    else syncTranslationNotice(currentChapter);
    route({inPlace:true});
  });
  document.addEventListener('click',e=>{
    const a=e.target.closest('a[href^="#"]');
    if(a&&a.getAttribute('href')===location.hash&&a.id!=='backTop'){e.preventDefault();route();}
  });
  window.addEventListener('hashchange',route);
  window.addEventListener('scroll',updateProgress,{passive:true});
  window.addEventListener('resize',()=>{measureArticle();updateProgress();});
  buildChapterNav();renderIndex();route();
})();