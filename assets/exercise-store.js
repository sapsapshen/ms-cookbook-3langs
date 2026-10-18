/* Local-first progress storage for SILS exercises.
   Guests keep everything in localStorage; signed-in readers merge with the
   server. A denied or corrupted storage degrades to an in-memory map so the
   reading experience never depends on storage being available. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExerciseStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEY = 'ms-cookbook.exercise.v1';
  const CODE_LIMIT = 20000;

  /* A storage object is trusted only after a write+delete round trip: some
     browsers expose localStorage in private mode but throw on setItem. Probing
     once at construction keeps every later call free of try/catch noise. */
  function safeStorage(candidate) {
    try {
      const probe = '__sils_probe__';
      candidate.setItem(probe, '1');
      candidate.removeItem(probe);
      return candidate;
    } catch { return null; }
  }

  function create(options) {
    const settings = options || {};
    const clock = typeof settings.now === 'function' ? settings.now : () => Date.now();
    const backing = safeStorage(settings.storage || (typeof localStorage !== 'undefined' ? localStorage : null));
    const available = backing !== null;

    /* Every failure mode here — no storage, a denied getItem, unparseable JSON —
       lands on an empty record set. Progress already written during this page
       view lives in `data`, so a dead storage still reads back for the session. */
    function load() {
      if (!backing) return Object.create(null);
      let raw;
      try { raw = backing.getItem(KEY); } catch { return Object.create(null); }
      if (!raw) return Object.create(null);
      try {
        const parsed = JSON.parse(raw);
        /* Arrays parse as objects but their indices are not exercise ids, so
           they are discarded with the rest of the unusable payloads. */
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : Object.create(null);
      } catch { return Object.create(null); }
    }

    let data = load();

    function flush() {
      if (!backing) return;
      try { backing.setItem(KEY, JSON.stringify(data)); } catch { /* quota or denial: keep memory copy */ }
    }

    /* Every read passes through here, so a hand-edited or truncated localStorage
       payload can never hand the UI a half-record: unknown shapes collapse to
       the empty record rather than propagating undefined. */
    function normalize(record) {
      const source = record && typeof record === 'object' ? record : {};
      return {
        passed: source.passed === true,
        score: typeof source.score === 'number' && source.score >= 0 ? source.score : 0,
        attempts: typeof source.attempts === 'number' && source.attempts > 0 ? source.attempts : 0,
        code: typeof source.code === 'string' ? source.code.slice(0, CODE_LIMIT) : '',
        selfAssessed: typeof source.selfAssessed === 'string' ? source.selfAssessed : '',
        updated: typeof source.updated === 'number' ? source.updated : 0,
      };
    }

    /* A chapter slot corrupted into a non-object (a hand-edited localStorage
       entry can parse cleanly yet hold a string) is replaced rather than
       assigned through — writing a property onto a primitive throws in strict
       mode, and that must never surface as a broken exercise panel. */
    function bucket(chapterId) {
      if (!data[chapterId] || typeof data[chapterId] !== 'object') data[chapterId] = Object.create(null);
      return data[chapterId];
    }

    function read(chapterId, exerciseId) {
      const chapter = data[chapterId];
      if (!chapter || !chapter[exerciseId]) return null;
      return normalize(chapter[exerciseId]);
    }

    /* Progress is monotonic by design: a later attempt can raise the score but
       never lower it, and a later failure can never revoke an earlier pass. A
       learner's history should not be able to move backwards because they
       stumbled on a retry.

       The previous values are captured into scalars BEFORE the patch is applied.
       `Object.assign(previous, patch)` would mutate `previous` in place and hand
       back the very same object, so `next.score` and `previous.score` would be
       the same slot — max(x, x) is x, and the monotonic rule would silently
       degrade into last-write-wins. */
    function write(chapterId, exerciseId, patch) {
      const previous = read(chapterId, exerciseId);
      const priorPassed = previous ? previous.passed : false;
      const priorScore = previous ? previous.score : 0;
      const priorAttempts = previous ? previous.attempts : 0;
      const next = Object.assign(
        { attempts: 0 },
        previous,
        patch || {},
        { updated: clock() },
      );
      next.passed = next.passed === true || priorPassed;
      next.score = Math.max(next.score || 0, priorScore);
      next.attempts = priorAttempts + 1;
      next.code = typeof next.code === 'string' ? next.code.slice(0, CODE_LIMIT) : '';
      next.selfAssessed = typeof next.selfAssessed === 'string' ? next.selfAssessed : '';
      bucket(chapterId)[exerciseId] = normalize(next);
      flush();
      return normalize(next);
    }

    /* Flat, wire-shaped rows: `passed` is 0/1 rather than a boolean because this
       is what the sync endpoint stores. */
    function snapshot() {
      const rows = [];
      for (const chapterId of Object.keys(data)) {
        const chapter = data[chapterId];
        if (!chapter || typeof chapter !== 'object') continue;
        for (const exerciseId of Object.keys(chapter)) {
          const record = normalize(chapter[exerciseId]);
          rows.push({
            chapter: chapterId,
            exercise: exerciseId,
            passed: record.passed ? 1 : 0,
            score: record.score,
            attempts: record.attempts,
            code: record.code,
            selfAssessed: record.selfAssessed,
            updated: record.updated,
          });
        }
      }
      return rows;
    }

    /* Three-way merge, last-write-wins on `updated` with one deliberate tie
       break: when both sides carry the same stamp, passing wins, so a record can
       never be un-passed by a tie. Clock skew between devices is harmless — a
       skewed stamp only decides which of two complete rows is kept, it cannot
       corrupt either.
       Returns {changed, records}: `changed` counts the rows the local side owns
       and the caller must push back to the server; `records` lists the server
       rows adopted locally as {chapterId, exerciseId, record}. The push-back
       payload itself is snapshot(), so it stays a single code path.
       `rows` is never mutated — callers reuse the array they hand in. */
    function merge(rows) {
      let changed = 0;
      const records = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object') continue;
        const chapterId = typeof row.chapter === 'string' ? row.chapter : '';
        const exerciseId = typeof row.exercise === 'string' ? row.exercise : '';
        if (!chapterId || !exerciseId) continue;
        const incoming = normalize({ ...row, passed: row.passed === 1 || row.passed === true });
        const local = read(chapterId, exerciseId);
        if (!local) {
          bucket(chapterId)[exerciseId] = incoming;
          records.push({ chapterId, exerciseId, record: incoming });
          continue;
        }
        const serverWins = incoming.updated > local.updated
          || (incoming.updated === local.updated && incoming.passed && !local.passed);
        if (serverWins) {
          bucket(chapterId)[exerciseId] = incoming;
          records.push({ chapterId, exerciseId, record: incoming });
        } else if (local.updated > incoming.updated) {
          changed += 1;
        }
      }
      flush();
      return { changed, records };
    }

    /* `total` counts the ids handed in, not the ids with a record, so a chapter
       reports "3 exercises, 1 passed" rather than hiding unattempted work. */
    function chapterSummary(chapterId, exerciseIds) {
      const ids = Array.isArray(exerciseIds) ? exerciseIds : [];
      let passed = 0;
      let selfAssessed = 0;
      for (const exerciseId of ids) {
        const record = read(chapterId, exerciseId);
        if (!record) continue;
        if (record.passed) passed += 1;
        else if (record.selfAssessed) selfAssessed += 1;
      }
      return { total: ids.length, passed, selfAssessed };
    }

    function summary(chapterMap) {
      let total = 0;
      let passed = 0;
      let selfAssessed = 0;
      for (const chapterId of Object.keys(chapterMap || {})) {
        const part = chapterSummary(chapterId, chapterMap[chapterId]);
        total += part.total;
        passed += part.passed;
        selfAssessed += part.selfAssessed;
      }
      return { total, passed, selfAssessed };
    }

    function reset() {
      data = Object.create(null);
      if (backing) { try { backing.removeItem(KEY); } catch { /* ignore */ } }
      return store;
    }

    const store = { available, read, write, snapshot, merge, chapterSummary, summary, reset };
    return store;
  }

  return { KEY, CODE_LIMIT, create };
});
