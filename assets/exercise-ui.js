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
      changes what the reader claimed, not what they earned.

   4. THE PULL HALF OF SYNC EXISTS SO A READER'S WORK FOLLOWS THEM. syncProgress
      pushes one row after every verdict, which alone means a reader who worked
      on one device sees nothing of it on another. pullProgress() reads the
      server's rows back and hands them to store.merge(), which owns every
      conflict rule -- passed latches, score ratchets, `updated` arbitrates
      code/selfAssessed. Nothing here decides a conflict itself, and a pull can
      never lower what the reader already earned. */
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

  /* One outcome per check, in the check's own order. The evaluator is handed the
     check at that index and nothing else; anything it could not judge fails
     closed, which is the same answer the worker gives. */
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

  /* How long the panel will wait on /api/exercises/grade before giving up on it.
     The endpoint's own server-side timeout plus a slow upstream can add up, and
     the panel was awaiting this with Run and Reset disabled -- so a hung call
     turned "the optional opinion never arrived" into "this exercise is stuck".
     Eight seconds is longer than a real grading call needs and short enough
     that the reader is not waiting on it. */
  const LLM_TIMEOUT_MS = 8000;

  /* fetch with a client-side deadline. AbortController is the clean way to do
     this, but it is not available in every browser the panel still runs in, so
     the race is what actually bounds the wait -- and a lost abort leaves the
     request to finish on its own without the panel ever hearing about it. */
  function fetchWithTimeout(url, init, ms) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (controller) controller.abort(); }, ms);
    const options = controller ? Object.assign({ signal: controller.signal }, init) : init;
    // A promise that never settles stands in for the aborted request, so the
    // race has a loser either way instead of waiting on a dead socket.
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('llm timeout')), ms));
    return Promise.race([fetch(url, options), timeout])
      .finally(() => clearTimeout(timer));
  }

  async function tryLlmGrade(exercise, code) {
    if (!exercise.llm_rubric || exercise.llm_rubric.enabled !== true) return null;
    if (!exercise.llm_rubric.criteria) return null;
    try {
      const response = await fetchWithTimeout('/api/exercises/grade', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exercise: exercise.id, answer: code, criteria: exercise.llm_rubric.criteria }),
      }, LLM_TIMEOUT_MS);
      // 503 is the documented "LLM not configured / unavailable" answer and 429
      // is the rate limit. Both degrade to the deterministic score the reader
      // already has; neither is worth an error message or a retry.
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data.score === 'number' ? data : null;
    } catch { return null; }
  }

  /* Whether `node` is still inside the panel this module owns. An answer that
     arrives after the reader collapsed the card, switched language or moved to
     another chapter has nowhere to go: the node it was going to be written into
     is no longer in the document, and appending to it would be a leak rather
     than an update. */
  function isAttached(node) {
    if (!node || !panel) return false;
    for (let current = node; current; current = current.parentNode) {
      if (current === panel) return true;
    }
    return false;
  }

  /* The reflection path's use of the rubric.

     ch13-ex03 and ch33-ex03 ship with `llm_rubric.enabled === true` and a
     written criteria, but `reflect` exercises have no graded checks -- so until
     this existed, nothing in the shipped corpus could ever reach
     /api/exercises/grade. Opening all nine exercises and clicking every button
     produced `/api/exercises/grade hit? false`.

     The opinion is ADVICE, never a verdict. It is not passed to
     Grader.grade(), it is not written to the store, and it cannot change the
     badge: a self-assessment is never a pass (rule 3) no matter what the model
     says about the answer. Failure and timeout both degrade to no opinion at
     all -- no error line, nothing to dismiss -- because the reader's own
     self-assessment has already been recorded by the time this runs. */
  async function consultLlmRubric(exercise, answer, host) {
    if (!exercise.llm_rubric || exercise.llm_rubric.enabled !== true) return;
    if (!exercise.llm_rubric.criteria) return;
    const llm = await tryLlmGrade(exercise, answer);
    if (!llm || !llm.feedback) return;
    // The reader may have collapsed the card or moved to another chapter while
    // the call was in flight; writing into a detached node would be a leak, not
    // an update.
    if (!isAttached(host)) return;
    host.replaceChildren(el('p', llm.feedback, 'exercise-llm-advice'));
  }

  const PROGRESS_PATH = '/api/exercises/progress';
  /* Rows per write-back request. The server caps a batch at 1000 items, but
     that ceiling is per body, not per reader: a row may carry up to 20000
     characters of the learner's own code, so a whole snapshot can be megabytes
     and one oversized body is a failed sync rather than a slow one. 25 rows
     keeps a request well under a megabyte, and the request count stays small
     enough that a full snapshot fits inside the server's per-minute write
     quota. */
  const PUSH_CHUNK = 25;

  /* The session as far as this module knows it, or null when it has not looked
     yet. assets/discussion.js dispatches `purplebook:session` after every
     session refresh and assets/wishes.js listens for the same event, so a
     login or logout anywhere in the reading header reaches the panel through
     the repo's existing channel instead of a second poll of its own. */
  let session = null;
  let sessionProbe = null;

  /* Concurrent triggers (a chapter entry and a session change in the same
     tick) share one probe instead of racing two, and a failed probe leaves the
     session unknown so the next trigger tries again rather than caching an
     offline answer for the rest of the page view. */
  async function readSession() {
    if (session) return session;
    if (!sessionProbe) {
      sessionProbe = (async () => {
        try {
          const response = await fetch('/api/session', { credentials: 'same-origin' });
          if (response && response.ok) {
            const data = await response.json();
            if (data && typeof data === 'object') session = data;
          }
        } catch { /* offline or denied: stay unknown, try again on the next trigger */ }
        sessionProbe = null;
        return session;
      })();
    }
    return sessionProbe;
  }

  /* ONE ROW, EVERY FIELD THE STORE HAS. The server's upsert is an
     unconditional overwrite of the two text columns --
     `code=excluded.code, ..., self_assessed=excluded.self_assessed` -- and
     ExerciseItem defaults both to ''. So a row that omits them is not a row
     that "fails to sync the code": it is an instruction to write an empty
     string over whatever another device saved. A reader re-running one exercise
     on a laptop would erase the code and the self-assessment they had on their
     phone, which is strictly worse than not syncing at all.

     The key list therefore has to stay identical to store.snapshot()'s, field
     for field. snapshot() is the wire shape the pull half already sends, so
     the two halves of the sync speak exactly one language. */
  function progressRow(record) {
    if (!record) return null;
    return {
      chapter: chapterId,
      exercise: record.exercise,
      passed: record.passed ? 1 : 0,
      score: record.score,
      attempts: record.attempts,
      // Coerced, not defaulted away: `undefined` would still serialize to a
      // missing key and the server would fill it with ''. An explicit '' is at
      // least the value the reader would have had locally.
      code: typeof record.code === 'string' ? record.code : '',
      selfAssessed: typeof record.selfAssessed === 'string' ? record.selfAssessed : '',
      updated: record.updated,
    };
  }

  /* Fire and forget by design. A reader who is signed out, offline, or rate
     limited simply keeps their local progress; the next attempt syncs it. */
  async function syncProgress(record) {
    const row = progressRow(record);
    if (!row) return;
    try {
      const current = await readSession();
      if (!current || !current.user) return;
      await fetch(PROGRESS_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': current.csrf },
        body: JSON.stringify({ items: [row] }),
      });
    } catch { /* reading must never depend on sync */ }
  }

  /* A pass that arrived from another device has to become VISIBLE, or the
     reader is left looking at a "not done" badge for work they have already
     done. Every other merge outcome is silent: repainting a badge the reader
     never asked about would be noise, but a badge that contradicts the server
     is a bug they would have to notice themselves.

     Only the CURRENT chapter is repainted -- the panel has no card for any
     other chapter, and the ones it does have read straight from the store the
     next time they are built. */
  function repaintFromMerge(records) {
    if (!panel) return;
    let adoptedPasses = 0;
    for (const entry of Array.isArray(records) ? records : []) {
      if (!entry || entry.chapterId !== chapterId) continue;
      if (entry.record && entry.record.passed) adoptedPasses += 1;
      updateCardState(entry.exerciseId);
    }
    refreshHeader();
    if (adoptedPasses > 0) noteSynced();
  }

  /* One line, once, in the panel's own summary row. A reader who sees a badge
     flip to "passed" with no explanation reasonably wonders whether the site
     is wrong; a short note answers that for the only case where the change is
     genuinely surprising. A merge that only imported self-assessments or code
     stays silent -- there is nothing to explain about work this device already
     had. */
  function noteSynced() {
    const summary = panel && panel.querySelector('.exercise-summary');
    if (!summary || summary.querySelector('.exercise-synced')) return;
    const note = el('p', t('exercise.synced'), 'exercise-synced');
    note.setAttribute('role', 'status');
    summary.append(note);
  }

  /* Ship the merged snapshot back up, in slices. The rows sent are
     store.chunks() of the ALREADY MERGED store, so the server receives the
     latched pass and the ratcheted score rather than the local row that would
     have regressed it -- which is exactly the payload merge()'s own comment
     promises the caller.

     A refused request (429) or a dropped connection stops the run rather than
     retrying: the quota that refused this batch would refuse the next one
     too, and burning the reader's remaining writes on it is how a partial
     sync turns into a deadlock. Whatever did not go up is already in
     localStorage, so the next trigger carries it. */
  async function pushBack(current) {
    for (const batch of store.chunks(PUSH_CHUNK)) {
      if (!batch.length) continue;
      try {
        const response = await fetch(PROGRESS_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': current.csrf },
          body: JSON.stringify({ items: batch }),
        });
        if (!response || !response.ok) return;
      } catch { return; }
    }
  }

  /* The half of sync that makes progress follow the reader between devices.
     Pulling is not optional decoration: the design promises that signed-in
     progress reaches the server so another device can continue, and without
     this the server copy is write-only -- visible to nobody.

     Every failure path is silent. A dead network, a 401, an expired session or
     a malformed payload ends the function with the reader's local progress
     exactly as it was, because a sync problem is never allowed to reach the
     reading view (rule 2). */
  let pulling = false;
  async function pullProgress() {
    if (!store || pulling) return null;
    pulling = true;
    try {
      const current = await readSession();
      // Nobody to sync with: no session, a reader who has not signed in, or a
      // deployment with no login at all. The endpoint would answer an empty
      // list and refuse every write, so the whole exchange is skipped rather
      // than spent on a round trip that cannot carry anything.
      if (!current || !current.user || current.loginEnabled === false) return null;
      let rows = [];
      try {
        const response = await fetch(PROGRESS_PATH, { credentials: 'same-origin' });
        if (!response || !response.ok) return null;
        const payload = await response.json();
        if (payload && Array.isArray(payload.items)) rows = payload.items;
      } catch { return null; }
      // merge() is the only thing that decides a conflict: `passed` latches,
      // `score` ratchets, and `updated` -- in seconds on both sides of the
      // wire, which normalize() also folds a legacy millisecond stamp down to
      // -- arbitrates code and selfAssessed. This function never compares
      // anything itself, so it cannot introduce a merge rule the store and the
      // server's own MAX() upsert would disagree with.
      const result = store.merge(rows);
      repaintFromMerge(result.records);
      // `changed` is a COUNT, not a list: merge() already wrote the merged
      // values into the buckets it touched, so the payload is the whole
      // snapshot rather than a hand-picked subset.
      if (result.changed > 0) await pushBack(current);
      return result;
    } catch { return null; }
    finally { pulling = false; }
  }

  /* Fires on the repo's own session channel. Signing in is the moment another
     device's progress becomes reachable, so that is when to pull; signing out
     leaves the local copy untouched, because the reader's own work is not the
     server's to take away. A repeat refresh for the SAME reader does not pull
     again -- assets/discussion.js dispatches this event on every repaint of
     the account area, not only on a real change. */
  function onSessionChange(event) {
    const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : null;
    const previousUser = session && session.user;
    session = detail;
    const user = detail && detail.user;
    if (!user) return;
    if (previousUser && previousUser.id === user.id) return;
    pullProgress();
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

  /* A labelled textarea, in the shape assets/discussion.js:20-21 already uses for
     the chapter comment box -- a visible <label for> bound to the control's id.
     A bare <textarea> has no accessible name: a screen reader announces "text
     field" with nothing else, and a placeholder (which the reflection box used
     to rely on) is not a label -- it disappears the moment the reader types,
     and several screen readers never read it at all.

     `id` is derived from the exercise id, so two expanded cards on the same
     page cannot collide and every label points at exactly one control. */
  function labelledEditor(exercise, key, placeholder) {
    const id = `exercise-editor-${exercise.id}-${key}`;
    const label = el('label', t(`exercise.${key}Label`), 'exercise-editor-label');
    label.htmlFor = id;
    const area = document.createElement('textarea');
    area.className = 'exercise-editor';
    area.id = id;
    area.spellcheck = false;
    if (placeholder) area.placeholder = placeholder;
    return { label, area };
  }

  function buildSandboxExercise(exercise, host) {
    if (!sandbox && Sandbox) sandbox = Sandbox.create({ onPhase });
    const { label, area: editor } = labelledEditor(exercise, 'code', '');
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
    host.append(label, editor, actions, status, output);

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
     question unanswerable-but-always-right.

     Returns the parsed options AND the prompt with those option lines removed,
     so the caller renders each of them exactly once. See splitPrompt.

     Four ways a naive line-by-line scan goes wrong, all of which cost the
     reader the question rather than merely looking untidy:

     1. CRLF. `.` does not match \r and `$` without the `m` flag is end-of-
        string, so on a prompt authored on Windows only the LAST option line
        ever matched -- the reader got one checkbox and could never be right.
     2. Fenced code. `X. not an option` inside a ``` block is not an option,
        and because the first letter wins, an `A.` inside a code block
        DISPLACES the real option A.
     3. Wrapped options. "A. the first option,\n   continued here" is one
        option; dropping the continuation silently truncates it.
     4. A lone or gapped list. One parsed option, or A/C/D with no B, means
        the scan lost something. Offering the control anyway produces a
        question that is unanswerable and says nothing about why. */
function splitPrompt(exercise) {
  // Normalize line endings FIRST: every later step reasons about "\n".
  const text = String(exercise.prompt || '').replace(/\r\n?/g, '\n');
  const found = [];
  const stem = [];
  let fenced = false;
  let previous = null;
  for (const raw of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(raw)) { fenced = !fenced; stem.push(raw); previous = null; continue; }
    if (!fenced) {
      const match = /^\s*([A-Z])[.、)）]\s*(\S.*)$/.exec(raw);
      if (match && !found.some(option => option.letter === match[1])) {
        found.push({ letter: match[1], label: match[2] });
        previous = found[found.length - 1];
        continue;
      }
      // A wrapped option: an unlabelled, non-blank line directly under one.
      // Attached rather than dropped, and attached with a space so the two
      // halves do not run together.
      if (previous && raw.trim()) { previous.label += ` ${raw.trim()}`; continue; }
    }
    if (raw.trim()) previous = null;
    stem.push(raw);
  }
  // Contiguous from A with no gaps, and at least two of them. A gap means the
  // scan dropped a line somewhere, and one option is not a question.
  const contiguous = found.length >= 2
    && found.every((option, index) => option.letter.charCodeAt(0) === 'A'.charCodeAt(0) + index);
  return { options: found, prompt: stem.join('\n').replace(/\n{3,}/g, '\n\n').trim(), usable: contiguous };
}

/* The option list, for callers that only want the options. */
function promptOptions(exercise) {
  return splitPrompt(exercise).options;
}

function buildChoiceExercise(exercise, host) {
    const checks = exercise.checks || [];
    const { options, usable } = splitPrompt(exercise);
    // A fieldset, not a div: four bare checkboxes reach a screen reader as four
    // unrelated controls with no statement of what they are answers TO. The
    // legend is what carries that. The <p> inside on the degraded path is the
    // content model a fieldset allows for exactly this.
    const field = document.createElement('fieldset');
    field.className = 'exercise-choices';
    const legend = el('legend', t('exercise.chooseAnswer'));
    field.append(legend);
    if (usable) {
      for (const option of options) {
        const label = el('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = option.letter;
        label.append(input, el('span', `${option.letter}. ${option.label}`));
        field.append(label);
      }
    } else {
      // Unparsable or gapped option list: say where the options are rather
      // than offering a control that cannot be graded, and keep Submit
      // disabled so the reader is not invited to answer a truncated question.
      const reason = el('p', options.length ? t('exercise.optionsUnparsed') : t('exercise.optionPlaceholder'));
      reason.className = 'exercise-fallback';
      field.append(reason);
    }

    const actions = el('div', null, 'exercise-actions');
    const submit = el('button', t('exercise.submit'));
    submit.type = 'button';
    submit.dataset.role = 'submit';
    submit.disabled = !usable;
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
    const { label, area } = labelledEditor(exercise, 'reflect', t('exercise.reflectPlaceholder'));
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
        // The optional rubric, asked for AFTER the self-assessment is already
        // recorded. See consultLlmRubric for why its answer is advice only.
        consultLlmRubric(exercise, area.value, advice);
      });
      actions.append(button);
    }
    // `advice` is where an LLM opinion lands, if one ever comes back. It is
    // outside the button row so the three self-assessment buttons keep their
    // place and a late answer cannot shift them under the reader's cursor.
    const advice = el('div', null, 'exercise-advice');
    host.append(label, area, actions, status, advice);
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
    /* For a choice exercise the prompt is not shown whole. Its option lines are
       rendered once, as the checkboxes this card is built around, and the
       `.exercise-prompt` paragraph carries only the stem -- so the reader sees
       each option exactly once instead of reading a block of A/B/C/D and then
       being shown the same four lines again as controls. A code or reflection
       exercise has no option list, so its prompt goes through untouched. */
    const shown = exercise.type === 'predict' ? splitPrompt(exercise).prompt : exercise.prompt;
    body.append(el('p', shown, 'exercise-prompt'));
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
    // Entering a chapter is a pull point because it is the moment the reader
    // is about to look at the panel: whatever another device earned should
    // already be in the badges, not arrive seconds later while they read. The
    // pull is fire-and-forget and silent, so a chapter opens exactly as fast
    // as it did before.
    pullProgress();
  }

  /* Idempotent: the wiring runs once per page no matter how often init() is
     called, so a second call cannot double-bind hashchange or the language
     listener and re-render the panel twice per navigation. */
  function init() {
    if (listenersBound) return;
    if (!data || !data.chapters || !Grader || !store) return;
    listenersBound = true;
    window.addEventListener('hashchange', onRoute);
    // Same channel assets/wishes.js listens on, so a sign-in or sign-out done
    // in the reading header pulls the reader's other-device progress without
    // this module polling for a session change of its own.
    window.addEventListener('purplebook:session', onSessionChange);
    if (window.MSI18N && window.MSI18N.on) {
      unsubscribeLang = window.MSI18N.on(() => {
        const current = chapterFromHash();
        // A language switch rebuilds the panel so the prompt, the solution and
        // every button speak the new language. The exercises themselves are
        // already translated per language in assets/exercises.js.
        if (mounted && current) render(current);
      });
    }
    const first = chapterFromHash();
    render(first);
    // A reader who lands directly on a chapter gets the same pull a
    // navigation would have given them.
    if (first) pullProgress();
  }

  function teardown() {
    if (unsubscribeLang) { unsubscribeLang(); unsubscribeLang = null; }
    if (listenersBound) {
      window.removeEventListener('hashchange', onRoute);
      window.removeEventListener('purplebook:session', onSessionChange);
      listenersBound = false;
    }
    if (sandbox) { sandbox.destroy(); sandbox = null; }
    if (panel) { panel.remove(); panel = null; }
    mounted = false;
    chapterId = '';
    activeStatus = null;
    // The cached session goes with the panel: a teardown/re-init cycle must
    // re-read who is signed in rather than trust an answer fetched for a
    // document that is no longer here.
    session = null;
    sessionProbe = null;
  }

  window.ExerciseUI = { init, render, teardown, chapterId: () => chapterId, refreshHeader, pullProgress };
  init();
})();