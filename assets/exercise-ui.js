/* Chapter exercise panel.
   The panel is injected after the chapter pager instead of being written into
   the chapter HTML: build-content.py rejects interactive tags in chapter
   source (G1), so every control here is created by script.

   Three rules shape everything below.

   1. OUTCOMES ARE INDEX-ALIGNED WITH exercise.checks. The grader reads
      outcomes[index] and pairs it with checks[index], so an array built any
      other way silently re-labels which assertion failed. Every path that
      grades maps over the FULL checks array and fills one slot per check --
      it never builds a short array and never filters the check list. The
      browser-side `output_choice` evaluator mirrors the worker's own host
      evaluator so the two agree on what a choice question means.

   2. GRADING NEVER BLOCKS READING. A missing sandbox, a dead worker, a
      timeout, a rejected network call and a malformed record all end in the
      panel's own status line. Nothing here throws into the reading view, and
      nothing removes or rewrites article content.

   3. A SELF-ASSESSMENT IS NEVER A PASS. `reflect` exercises have no graded
      checks, so the grader returns mode 'self-assessed' with passed=false and
      the panel shows that state as its own badge. Recording "I got it right"
      changes what the reader claimed, not what they earned. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const data = window.EXERCISE_DATA;
  const t = window.MSI18N ? window.MSI18N.t : (key => key);
  const Grader = window.ExerciseGrader;
  const Sandbox = window.ExerciseSandbox;
  const store = window.ExerciseStore ? window.ExerciseStore.create({}) : null;
  /* The facade only spawns its worker on the first run(), so constructing it
     here costs nothing and keeps one queue across every exercise on the page
     (G9: Pyodide is fetched on demand, never at load). onPhase lets the panel
     say "downloading" instead of looking hung during the ~12 MB first fetch. */
  let sandbox = null;
  let activeStatus = null;
  const onPhase = event => {
    if (!activeStatus) return;
    if (event && event.phase === 'loading') activeStatus.textContent = t('exercise.loading');
  };

  let panel = null;
  let chapterId = '';
  let mounted = false;
  let unsubscribeLang = null;
  let listenersBound = false;

  const ANSWER_LABELS = { pass: 'exercise.selfPass', partial: 'exercise.selfPartial', fail: 'exercise.selfFail' };

  function lang() {
    return window.MSI18N ? window.MSI18N.lang : 'zh';
  }

  function localizedItems() {
    const chapter = data && data.chapters ? data.chapters[chapterId] : null;
    if (!chapter || !chapter.exercises) return [];
    const list = chapter.exercises[lang()];
    return Array.isArray(list) ? list : (chapter.exercises.zh || []);
  }

  /* The chapter id in the address bar, or '' on any non-chapter view. Reading
     it from the hash rather than from layout (`offsetParent`) keeps the
     decision deterministic and testable. */
  function chapterFromHash() {
    const match = /^#chapter-(\d+)/.exec(window.location.hash || '');
    return match ? `chapter-${match[1]}` : '';
  }

  /* One outcome per check, in the check's own order. `slot` is what the
     evaluator knows about the check at that index; anything the evaluator
     could not judge fails closed, which is the same answer the worker gives. */
  function alignOutcomes(checks, evaluate) {
    const list = Array.isArray(checks) ? checks : [];
    return list.map((check, index) => {
      const own = evaluate(check, index);
      return own && typeof own.ok === 'boolean' ? own : { ok: false, detail: '' };
    });
  }

  /* output_choice is decided from the reader's selection, not from anything the
     learner typed, so it is evaluated on the main thread and a multiple-choice
     question never downloads Pyodide. This mirrors evaluateHostChecks() in
     assets/exercise-worker.js exactly, including the detail string, so a choice
     question means the same thing on both paths. */
  function choiceOutcomes(checks, chosen) {
    const picked = Array.isArray(chosen) ? chosen.slice().sort() : [];
    return alignOutcomes(checks, check => {
      if (!check || check.kind !== 'output_choice') return null;
      const expected = Array.isArray(check.correct) ? check.correct.slice().sort() : [];
      const ok = picked.length === expected.length && picked.every((value, index) => value === expected[index]);
      return { ok, detail: `selected ${JSON.stringify(picked)}` };
    });
  }

  async function tryLlmGrade(exercise, code) {
    if (!exercise.llm_rubric || exercise.llm_rubric.enabled !== true) return null;
    if (!exercise.llm_rubric.criteria) return null;
    try {
      const response = await fetch('/api/exercises/grade', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exercise: exercise.id, answer: code, criteria: exercise.llm_rubric.criteria }),
      });
      // 503 is the documented "LLM not configured / unavailable" answer and 429
      // is the rate limit. Both degrade to the deterministic score the reader
      // already has; neither is worth an error message or a retry.
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data.score === 'number' ? data : null;
    } catch { return null; }
  }

  function progressRow(record) {
    if (!record) return null;
    return {
      chapter: chapterId,
      exercise: record.exercise,
      passed: record.passed ? 1 : 0,
      score: record.score,
      attempts: record.attempts,
      updated: record.updated,
    };
  }

  /* Fire and forget by design. A reader who is signed out, offline, or rate
     limited simply keeps their local progress; the next attempt syncs it. */
  async function syncProgress(record) {
    const row = progressRow(record);
    if (!row) return;
    try {
      const session = await (await fetch('/api/session', { credentials: 'same-origin' })).json();
      if (!session || !session.user) return;
      await fetch('/api/exercises/progress', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        body: JSON.stringify({ items: [row] }),
      });
    } catch { /* reading must never depend on sync */ }
  }

  /* Renders the grader's own items rather than the raw sandbox outcomes,
     because an item carries the check's kind: an outcome on its own only says
     "ok", which tells the reader nothing about what passed. */
  function renderChecks(items) {
    const list = el('ul', null, 'exercise-checks');
    for (const item of items) {
      const row = el('li', null, null);
      row.dataset.ok = String(item.ok === true);
      row.append(el('span', `${item.ok === true ? '✓' : '✗'} ${item.detail || item.kind}`));
      list.append(row);
    }
    return list;
  }

  function renderSolution(exercise, host) {
    const details = el('details', null, 'exercise-solution');
    details.append(el('summary', t('exercise.solution')));
    if (exercise.reference) details.append(el('pre', exercise.reference));
    if (exercise.explanation) details.append(el('p', exercise.explanation));
    host.append(details);
  }

  /* Persist, sync and repaint in one place, so a graded exercise and a
     self-assessed one cannot drift apart on how a result is recorded. */
  function record(exercise, patch) {
    if (!store) return null;
    const saved = store.write(chapterId, exercise.id, patch);
    syncProgress(Object.assign({ exercise: exercise.id }, saved));
    updateCardState(exercise.id);
    refreshHeader();
    return saved;
  }

  function buildSandboxExercise(exercise, host) {
    if (!sandbox && Sandbox) sandbox = Sandbox.create({ onPhase });
    const editor = document.createElement('textarea');
    editor.className = 'exercise-editor';
    editor.spellcheck = false;
    editor.value = exercise.starter || '';
    const previous = store && store.read(chapterId, exercise.id);
    if (previous && previous.code) editor.value = previous.code;

    const actions = el('div', null, 'exercise-actions');
    const run = el('button', t('exercise.run'));
    run.type = 'button';
    run.dataset.role = 'run';
    const reset = el('button', t('exercise.reset'));
    reset.type = 'button';
    actions.append(run, reset);

    const status = el('p', null, 'exercise-status');
    status.setAttribute('role', 'status');
    const output = el('div');
    host.append(editor, actions, status, output);

    reset.addEventListener('click', () => {
      editor.value = exercise.starter || '';
      status.textContent = '';
      delete status.dataset.tone;
      output.replaceChildren();
    });

    run.addEventListener('click', async () => {
      run.disabled = true;
      reset.disabled = true;
      output.replaceChildren();
      delete status.dataset.tone;
      status.textContent = t('exercise.loading');
      // While this run is in flight the phase hook writes into THIS status
      // line, so a slow first download is announced where the reader is
      // already looking instead of on a panel-level banner.
      activeStatus = status;
      try {
        if (!sandbox) throw new Error('sandbox unavailable');
        const checks = exercise.checks || [];
        const result = await sandbox.run({ code: editor.value, checks });
        // The worker returns one slot per check in the check's own order. Map
        // over `checks` and index into `outcomes` -- never the other way
        // round, and never filter either array. A short or reordered outcome
        // array is the one defect that makes a correct answer score wrong.
        const outcomes = alignOutcomes(checks, (check, index) => {
          const produced = Array.isArray(result.outcomes) ? result.outcomes[index] : null;
          if (produced && typeof produced.ok === 'boolean') return produced;
          return { ok: false, detail: result.ok ? 'not evaluated' : 'code did not run' };
        });
        const llm = await tryLlmGrade(exercise, editor.value);
        const verdict = Grader.grade(exercise, { outcomes, llm });
        record(exercise, { passed: verdict.passed, score: verdict.score, code: editor.value });
        status.dataset.tone = verdict.passed ? 'pass' : '';
        if (!result.ok) {
          status.dataset.tone = 'error';
          // The worker's error is a Python traceback; its last line is the
          // exception the learner can act on, the frames above it are noise.
          status.textContent = String(result.error || '').split('\n').filter(Boolean).slice(-1)[0]
            || t('exercise.sandboxFailed');
        } else {
          const percent = Math.round(verdict.score * 100);
          status.textContent = `${t('exercise.score', { percent })} · ${t('exercise.elapsed', { ms: Math.round(result.ms || 0) })}`;
        }
        output.append(renderChecks(verdict.items));
        if (llm && llm.feedback) output.append(el('p', llm.feedback, 'exercise-solution'));
        renderSolution(exercise, output);
      } catch (error) {
        // No sandbox, no worker, a rejected fetch, a malformed record: the
        // panel says so and the article underneath is untouched.
        status.dataset.tone = 'error';
        status.textContent = t('exercise.sandboxFailed');
      } finally {
        // Identity-checked: the sandbox queues runs, so a second card can claim
        // this slot while the first run is still awaiting. Clearing blindly
        // would drop the second card's loading hint on the floor.
        if (activeStatus === status) activeStatus = null;
        run.disabled = false;
        reset.disabled = false;
      }
    });
  }

  /* The option letters live in the prompt ("A. ...\nB. ..."), not in the
     check, which carries only the correct ones. Rendering check.correct as the
     choice list would hide every wrong option from the reader and make the
     question unanswerable-but-always-right. */
  function promptOptions(exercise) {
    const text = String(exercise.prompt || '');
    const found = [];
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z])[.、)）]\s*(\S.*)$/.exec(line);
      if (match && !found.some(option => option.letter === match[1])) {
        found.push({ letter: match[1], label: match[2] });
      }
    }
    return found;
  }

  function buildChoiceExercise(exercise, host) {
    const checks = exercise.checks || [];
    const options = promptOptions(exercise);
    const field = el('div', null, 'exercise-choices');
    if (options.length) {
      for (const option of options) {
        const label = el('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = option.letter;
        label.append(input, el('span', `${option.letter}. ${option.label}`));
        field.append(label);
      }
    } else {
      // No parsable option list: say where the options are rather than
      // inventing a control that cannot be graded.
      field.append(el('p', t('exercise.optionPlaceholder'), 'exercise-fallback'));
    }

    const actions = el('div', null, 'exercise-actions');
    const submit = el('button', t('exercise.submit'));
    submit.type = 'button';
    submit.dataset.role = 'submit';
    submit.disabled = !options.length;
    actions.append(submit);
    const status = el('p', null, 'exercise-status');
    status.setAttribute('role', 'status');
    host.append(field, actions, status);
    renderSolution(exercise, host);

    submit.addEventListener('click', () => {
      const chosen = [...field.querySelectorAll('input')].filter(node => node.checked).map(node => node.value);
      const outcomes = choiceOutcomes(checks, chosen);
      const verdict = Grader.grade(exercise, { outcomes });
      record(exercise, { passed: verdict.passed, score: verdict.score });
      status.dataset.tone = verdict.passed ? 'pass' : '';
      status.textContent = verdict.passed ? t('exercise.correct') : t('exercise.incorrect');
      const failed = outcomes.some((outcome, index) => !outcome.ok && checks[index] && checks[index].kind === 'output_choice');
      if (failed) {
        const list = el('ul', null, 'exercise-checks');
        const row = el('li', null, null);
        row.dataset.ok = 'false';
        row.append(el('span', `✗ ${t('exercise.incorrect')}`));
        list.append(row);
        status.after(list);
      }
    });
  }

  function buildReflectExercise(exercise, host) {
    const area = document.createElement('textarea');
    area.className = 'exercise-editor';
    area.spellcheck = false;
    area.placeholder = t('exercise.reflectPlaceholder');
    const previous = store && store.read(chapterId, exercise.id);
    if (previous && previous.code) area.value = previous.code;

    const actions = el('div', null, 'exercise-actions');
    const status = el('p', null, 'exercise-status');
    status.setAttribute('role', 'status');
    for (const choice of ['pass', 'partial', 'fail']) {
      const button = el('button', t(ANSWER_LABELS[choice]));
      button.type = 'button';
      button.dataset.role = choice;
      button.addEventListener('click', () => {
        // Deliberately writes no `passed` and no `score`: the store's monotonic
        // write keeps whatever the reader already earned, and a self-assessment
        // can only ever add the reader's own claim.
        record(exercise, { code: area.value, selfAssessed: choice });
        status.textContent = t('exercise.selfRecorded');
      });
      actions.append(button);
    }
    host.append(area, actions, status);
    renderSolution(exercise, host);
  }

  function buildCard(exercise, index) {
    const card = el('article', null, 'exercise-card');
    card.dataset.exercise = exercise.id;
    const toggle = el('button', null, 'exercise-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const title = el('span', `${index + 1}. ${exercise.objective}`, 'exercise-toggle-title');
    const state = el('span', '', 'exercise-state');
    const meta = el('span', `${exercise.difficulty} · ${exercise.minutes} min`, 'exercise-toggle-meta');
    toggle.append(title, state, meta);
    const body = el('div', null, 'exercise-body');
    body.hidden = true;
    body.append(el('p', exercise.prompt, 'exercise-prompt'));
    card.append(toggle, body);
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden;
      toggle.setAttribute('aria-expanded', String(!body.hidden));
      // Built on first expand, not at render: a 35-chapter corpus would
      // otherwise create every editor, checkbox and solution up front.
      if (!body.hidden && !body.dataset.filled) {
        body.dataset.filled = '1';
        if (exercise.type === 'reflect') buildReflectExercise(exercise, body);
        else if (exercise.type === 'predict') buildChoiceExercise(exercise, body);
        else buildSandboxExercise(exercise, body);
      }
    });
    // Set before the card joins the panel: updateCardState() looks the card up
    // by selector, so a card that is not in the DOM yet cannot be found and
    // the badge would keep its unstyled placeholder text.
    paintState(state, exercise);
    return card;
  }

  function stateFor(exercise) {
    const saved = store ? store.read(chapterId, exercise.id) : null;
    if (!saved) return 'todo';
    if (saved.passed) return 'passed';
    return saved.selfAssessed && saved.selfAssessed !== 'fail' ? 'self' : 'todo';
  }

  function paintState(badge, exercise) {
    const state = stateFor(exercise);
    badge.dataset.state = state;
    badge.textContent = state === 'passed' ? t('exercise.statePassed')
      : state === 'self' ? t('exercise.stateSelf')
        : t('exercise.stateTodo');
  }

  function updateCardState(exerciseId) {
    if (!panel) return;
    const chapter = data && data.chapters ? data.chapters[chapterId] : null;
    const list = chapter && chapter.exercises ? (chapter.exercises[lang()] || chapter.exercises.zh || []) : [];
    const exercise = list.find(item => item.id === exerciseId);
    if (!exercise) return;
    const badge = panel.querySelector(`.exercise-card[data-exercise="${exerciseId}"] .exercise-state`);
    if (badge) paintState(badge, exercise);
  }

  function refreshHeader() {
    if (!panel) return;
    const items = localizedItems();
    const summary = store
      ? store.chapterSummary(chapterId, items.map(item => item.id))
      : { total: items.length, passed: 0 };
    const node = panel.querySelector('.exercise-count');
    if (node) node.textContent = t('exercise.headerCount', { total: summary.total, passed: summary.passed });
  }

  function render(currentChapterId) {
    if (!data || !data.chapters) return;
    const pager = $('.chapter-pager');
    if (!pager) return;
    // A reader who opens the book on the home page must not get an exercise
    // panel; it belongs to the chapter view and is mounted on the first
    // navigation into one.
    chapterId = currentChapterId || '';
    if (!chapterId) {
      if (mounted && panel) { panel.replaceChildren(); }
      return;
    }
    if (!mounted) {
      panel = el('section', null, 'exercise-panel');
      panel.id = 'exercisePanel';
      pager.after(panel);
      mounted = true;
    }
    panel.setAttribute('aria-label', t('a11y.exercisePanel'));
    panel.replaceChildren();
    const items = localizedItems();
    // An empty panel hides itself through .exercise-panel:empty, so a chapter
    // with no exercises shows nothing at all rather than an empty heading.
    if (!items.length) return;
    const summary = el('div', null, 'exercise-summary');
    summary.append(el('h2', t('exercise.title')), el('span', '', 'exercise-count'));
    panel.append(summary);
    refreshHeader();
    for (const [index, exercise] of items.entries()) panel.append(buildCard(exercise, index));
  }

  function onRoute() {
    const current = chapterFromHash();
    // `!mounted` matters: a reader who lands on the home page has no panel
    // yet, and the first navigation into a chapter is what mounts it.
    if (!current || (mounted && current === chapterId)) return;
    render(current);
  }

  /* Idempotent: the wiring runs once per page no matter how often init() is
     called, so a second call cannot double-bind hashchange or the language
     listener and re-render the panel twice per navigation. */
  function init() {
    if (listenersBound) return;
    if (!data || !data.chapters || !Grader || !store) return;
    listenersBound = true;
    window.addEventListener('hashchange', onRoute);
    if (window.MSI18N && window.MSI18N.on) {
      unsubscribeLang = window.MSI18N.on(() => {
        const current = chapterFromHash();
        // A language switch rebuilds the panel so the prompt, the solution and
        // every button speak the new language. The exercises themselves are
        // already translated per language in assets/exercises.js.
        if (mounted && current) render(current);
      });
    }
    render(chapterFromHash());
  }

  function teardown() {
    if (unsubscribeLang) { unsubscribeLang(); unsubscribeLang = null; }
    if (listenersBound) {
      window.removeEventListener('hashchange', onRoute);
      listenersBound = false;
    }
    if (sandbox) { sandbox.destroy(); sandbox = null; }
    if (panel) { panel.remove(); panel = null; }
    mounted = false;
    chapterId = '';
    activeStatus = null;
  }

  window.ExerciseUI = { init, render, teardown, chapterId: () => chapterId, refreshHeader };
  init();
})();