/* Learning map for the practice view.

   Two halves with very different risk. aggregate() decides which of three
   states a single exercise cell shows, and it is the half that decides whether
   a learner can see their own progress, so it is written as a pure function of
   (corpus, store, parts, book) with no DOM and no globals -- the grid can then
   be verified in Node against the real corpus and the real store. render()
   only paints what aggregate() returned.

   THE STATE RULE, and the reason it reads store.read() rather than
   store.chapterSummary(). chapterSummary() answers "how many of these are
   passed", which is the wrong shape for a grid: it carries no per-exercise
   information at all, and a caller that looked there for one found undefined
   and painted every cell as "not done". That is not hypothetical -- it shipped
   once (Task 4) and made the whole feature look broken to everyone who had
   actually done the work. So every cell here comes from an individual
   store.read(chapterId, exerciseId).

   THREE STATES, not two. `passed` is a graded pass. `self` is the learner's own
   claim on a `reflect` exercise, which has no graded checks and therefore no
   pass to earn -- it is shown distinctly rather than folded into `passed`,
   because a self-assessment is not a verdict. A self-assessment of 'fail' is
   the learner saying "I did not get it", so it is `todo`, not `self`; this
   matches the rule store.chapterSummary() already applies.

   NOT A REPLACEMENT. assets/paper.js still paints the scene cards into
   #sceneGrid directly below this grid; the map is what sits above them. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExerciseMap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GLYPH = { passed: '✓', self: '~', todo: '○' };

  /* The exercise ids of one chapter. The localized lists carry the same ids in
     the same order -- only the prose is translated -- so the map reads `zh`
     and never has to know which language is on screen. A chapter whose list is
     missing (a corpus entry with no exercises yet, which is what a chapter
     awaiting Task 14 looks like) contributes nothing rather than throwing. */
  function idsFor(chapter) {
    const lists = (chapter && chapter.exercises) || {};
    const list = Array.isArray(lists.zh) ? lists.zh
      : ['en', 'es'].map(lang => lists[lang]).find(Array.isArray);
    return (list || []).map(item => item && item.id).filter(id => typeof id === 'string' && id);
  }

  /* One of three states, read per exercise from the store. A missing record is
     "not done", not an error: localStorage can be unavailable, denied or
     corrupt, and the map still has to draw. */
  function stateOf(store, chapterId, exerciseId) {
    if (!store || typeof store.read !== 'function') return 'todo';
    const record = store.read(chapterId, exerciseId);
    if (!record) return 'todo';
    if (record.passed === true) return 'passed';
    return record.selfAssessed && record.selfAssessed !== 'fail' ? 'self' : 'todo';
  }

  function count(states, state) {
    return states.reduce((sum, value) => sum + (value === state ? 1 : 0), 0);
  }

  /* Pure. Returns one row per part that actually has exercises:
       [{partIndex, partTitle, total, passed, self, chapters: [...]}]
     and each chapter carries {chapter, number, title, total, passed, self,
     states}. Nothing here touches the DOM, the clock, the network or the
     arguments -- the same inputs always give the same rows. */
  function aggregate(data, store, parts, bookChapters) {
    const chapters = (data && data.chapters) || {};
    const grouped = new Map();
    for (const id of Object.keys(chapters)) {
      const chapter = chapters[id] || {};
      const chapterId = chapter.chapter || id;
      const ids = idsFor(chapter);
      // A chapter with no exercises has nothing to draw, so it is left out of
      // the grid entirely rather than rendered as a row of empty cells.
      if (!ids.length) continue;
      const index = Number.isInteger(chapter.partIndex) ? chapter.partIndex : 0;
      if (!grouped.has(index)) grouped.set(index, []);
      grouped.get(index).push({ chapter, chapterId, ids });
    }

    const rows = [];
    for (const partIndex of Array.from(grouped.keys()).sort((a, b) => a - b)) {
      const part = (parts || [])[partIndex] || {};
      const entries = grouped.get(partIndex)
        .sort((a, b) => (a.chapter.number || 0) - (b.chapter.number || 0))
        .map(({ chapter, chapterId, ids }) => {
          const states = ids.map(id => stateOf(store, chapterId, id));
          const book = bookChapters && typeof bookChapters.get === 'function'
            ? bookChapters.get(chapterId)
            : null;
          return {
            chapter: chapterId,
            number: chapter.number,
            // A chapter missing from the book index still gets a cell: the id
            // is a worse label than nothing, but a missing cell would hide
            // exercises the learner can actually do.
            title: book && book.title ? book.title : chapterId,
            total: ids.length,
            passed: count(states, 'passed'),
            self: count(states, 'self'),
            states,
          };
        });
      rows.push({
        partIndex,
        partTitle: part.title || `Part ${partIndex + 1}`,
        total: entries.reduce((sum, entry) => sum + entry.total, 0),
        passed: entries.reduce((sum, entry) => sum + entry.passed, 0),
        self: entries.reduce((sum, entry) => sum + entry.self, 0),
        chapters: entries,
      });
    }
    return rows;
  }

  /* ------------------------------------------------------- painting (browser) */

  /* Collaborators are read at paint time, not at module scope, for the same
     reason assets/exercise-ui.js does it: a script listed after this one would
     otherwise leave the grid permanently absent, with nothing in the console. */
  function translator() {
    const i18n = typeof window !== 'undefined' ? window.MSI18N : null;
    return {
      t: i18n && typeof i18n.t === 'function' ? (key, vars) => i18n.t(key, vars) : (key => key),
      // `has` keeps a raw key off the page: without it, a dictionary that has
      // not been given this string yet would render "partName.03" as if it
      // were the part's name.
      has: i18n && typeof i18n.has === 'function' ? (key) => i18n.has(key) : () => false,
    };
  }

  /* Part and chapter names already have translations in assets/locale/*.js,
     keyed exactly as assets/paper.js keys them. Reusing those keys is why the
     map speaks the reader's language instead of showing the Chinese source to
     an English speaker. `fallback` is the Chinese text, which is what the book
     itself carries. */
  function partTitle(i18n, partIndex, fallback) {
    const key = 'partName.' + String(partIndex + 1).padStart(2, '0');
    return i18n.has(key) ? i18n.t(key) : fallback;
  }

  function chapterTitle(i18n, number, fallback) {
    const key = 'chapterTitle.' + String(number).padStart(2, '0');
    return i18n.has(key) ? i18n.t(key) : fallback;
  }

  /* A FRESH STORE EVERY TIME. ExerciseStore.create() snapshots localStorage at
     construction and keeps its own in-memory copy, so a store cached at page
     load still believes in the progress the reader had not earned yet: doing
     an exercise writes through a DIFFERENT store instance -- the panel's -- and
     only reaches this one through localStorage. Reading the storage again on
     each paint is what makes a pass earned a minute ago show up here. The cost
     is one JSON.parse of the learner's own record set per paint, and a paint
     only happens on load, on a language switch and on entering this view. */
  function currentStore() {
    const factory = typeof window !== 'undefined' ? window.ExerciseStore : null;
    if (!factory || typeof factory.create !== 'function') return null;
    try { return factory.create({}); } catch { return null; }
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  /* `host` is injectable so the grid can be painted into a detached tree; the
     page passes nothing and gets the slot the router left in index.html. */
  function render(host) {
    const target = host || (document.getElementById ? document.getElementById('exerciseMap') : null);
    // No slot means the view was never wired up. Nothing to paint, and nothing
    // to clear either -- this must never reach into another view's markup.
    if (!target) return;
    const data = typeof window !== 'undefined' ? window.EXERCISE_DATA : null;
    const store = currentStore();
    // Nothing is painted and nothing already painted is removed: an exercise
    // corpus that failed to load should leave the practice view exactly as it
    // was rather than blank a grid a reader is looking at.
    if (!data || !data.chapters || !store) return;

    const bookData = window.BOOK_DATA || {};
    const i18n = translator();
    const bookChapters = new Map((bookData.chapters || []).map(chapter => [
      chapter.id,
      { title: chapterTitle(i18n, chapter.number, chapter.title) },
    ]));
    const rows = aggregate(data, store, bookData.parts || [], bookChapters);
    if (!rows.length) return;

    const total = rows.reduce((sum, row) => sum + row.total, 0);
    const passed = rows.reduce((sum, row) => sum + row.passed, 0);

    const section = el('section', null, 'exercise-map container');
    section.setAttribute('aria-label', i18n.t('exercise.mapTitle'));
    const head = el('div', null, 'exercise-map-head');
    head.append(
      el('h2', i18n.t('exercise.mapTitle')),
      el('span', i18n.t('exercise.mapTotal', { passed, total }), 'exercise-map-total'),
    );
    section.append(head);

    for (const row of rows) {
      const block = el('div', null, 'exercise-map-part');
      const heading = el('h3', null, null);
      heading.append(
        partTitle(i18n, row.partIndex, row.partTitle),
        el('span', `${row.passed}/${row.total}`, 'exercise-map-part-meta'),
      );
      const grid = el('div', null, 'exercise-map-grid');
      for (const entry of row.chapters) {
        grid.append(buildCell(i18n, entry));
      }
      block.append(heading, grid);
      section.append(block);
    }

    target.replaceChildren(section);
  }

  /* One chapter: its title, and one glyph per exercise. The glyph run is the
     whole point of the view, so the cell's accessible name spells out the same
     counts -- "✓✓○" reads as nothing to a screen reader. */
  function buildCell(i18n, entry) {
    const cell = document.createElement('a');
    cell.className = 'exercise-map-cell';
    cell.setAttribute('href', `#${entry.chapter}`);
    cell.dataset.chapter = entry.chapter;
    cell.setAttribute('aria-label', `${entry.title} · ${i18n.t('exercise.headerCount', { total: entry.total, passed: entry.passed })}`);
    const dots = el('span', entry.states.map(state => GLYPH[state] || GLYPH.todo).join(''), 'exercise-map-dots');
    dots.setAttribute('aria-hidden', 'true');
    cell.append(el('span', `${String(entry.number).padStart(2, '0')} · ${entry.title}`), dots);
    return cell;
  }

  return { GLYPH, aggregate, render };
});