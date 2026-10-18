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

  /* `updated` is unix SECONDS, not milliseconds. It is the arbitration key for
     merge(), so the unit has to be the one the server counts in (`int(time.time())`)
     and returns: Date.now() is ~1.7e12 against the server's ~1.7e9, so a
     millisecond stamp is always "newer" than every real one, which makes every
     sync report the local side as the winner and silently drops whatever the
     server actually holds. Second-resolution matches the server's clock and is
     fine for ordering -- two writes inside the same second are separated by the
     client's own tie-break, not by the stamp. */
  const SECOND = 1000;

  /* Fold a millisecond stamp down to seconds, leaving a second stamp alone.
     10**12 seconds is the year 33658 and 10**12 milliseconds is 2001-09-09, so
     the magnitude separates the two for the next three centuries. This is the
     mirror of the server's own defence and covers the two cases a bare clock
     change cannot: progress already sitting in this device's localStorage from
     the millisecond build, and a server that has not been redeployed yet. Both
     would otherwise keep the stamp permanently "newer" than everything the
     server holds, so the row would never stop winning its own merge. */
  const MILLISECOND_FLOOR = 1e12;

  function inSeconds(stamp) {
    return stamp >= MILLISECOND_FLOOR ? Math.floor(stamp / SECOND) : stamp;
  }

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
    const clock = typeof settings.now === 'function' ? settings.now : () => Math.floor(Date.now() / SECOND);
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
       the empty record rather than propagating undefined. `updated` is folded
       into seconds here too, which is what makes the unit correction reach
       records written before it: normalize() is the one place both the stored
       copy and an incoming server row pass through, so folding at the single
       choke point needs no separate migration pass over localStorage. */
    function normalize(record) {
      const source = record && typeof record === 'object' ? record : {};
      return {
        passed: source.passed === true,
        score: typeof source.score === 'number' && source.score >= 0 ? source.score : 0,
        attempts: typeof source.attempts === 'number' && source.attempts > 0 ? source.attempts : 0,
        code: typeof source.code === 'string' ? source.code.slice(0, CODE_LIMIT) : '',
        selfAssessed: typeof source.selfAssessed === 'string' ? source.selfAssessed : '',
        updated: typeof source.updated === 'number' ? inSeconds(source.updated) : 0,
      };
    }

    /* A chapter slot corrupted into something that cannot hold records (a
       hand-edited localStorage entry can parse cleanly yet hold a string) is
       replaced rather than assigned through — writing a property onto a
       primitive throws in strict mode, and that must never surface as a broken
       exercise panel.

       Arrays and null are rejected too, because `typeof` reports `'object'` for
       both. An array would be the worse of the two: `'ch01-ex01' => record`
       lands on a NON-index property, and JSON.stringify only serialises an
       array's indices. The record would therefore read back fine for the rest
       of the session and be silently absent from the flushed payload — a
       progress record lost on the next page load, with no error anywhere. */
    function bucket(chapterId) {
      const slot = data[chapterId];
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) data[chapterId] = Object.create(null);
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
        /* An array chapter has to be skipped for the same reason bucket()
           rebuilds one: iterating it yields '0', '1', … as if they were
           exercise ids, so the sync endpoint would be handed rows describing
           exercises that do not exist. */
        if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) continue;
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

    /* Merge with the server.

       `passed` and `score` are MONOTONE across the merge, exactly like the
       write path and exactly like the server: the plan's upsert uses
       passed=MAX(...), score=MAX(...) (docs/superpowers/plans/2026-10-18-sils-implementation.md:2417-2418).
       Timestamp arbitration alone would let a newer local failure un-pass a
       record the server had already accepted, which breaks the "a pass is
       never revoked" rule and makes the learning map drop a badge the server
       still holds. The server's MAX would repair the row on the next sync, but
       the client stays wrong in the meantime — the two layers must agree, or the
       push-back would carry a regressing value.

       `updated` still decides the OTHER fields (code, selfAssessed) and still
       decides whether the local side has to be pushed back, so a device with a
       skewed clock can only pick between two complete rows — it can never
       corrupt one.

       `attempts` is taken wholesale from the winning side rather than max()'d:
       it is a per-device counter, and the server's copy is the accumulated one
       for a signed-in reader. Accepting a server value that is lower than the
       local one can therefore lower the count, which is a deliberate trade — the
       alternative (max) would inflate it forever on a device that was reset.
       Nothing user-visible depends on it; `passed` and `score` are what the map
       renders.

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
        /* Timestamp arbitration, plus one tie-break: when the server holds a
           pass the local side has not earned, the server row is adopted even on
           an equal stamp. Without it the merge still latches `passed` — the
           latch is unconditional below — so the row would change data and be
           reported in neither list: absent from `records` (not adopted, as far
           as the caller can tell) and absent from `changed` (the server already
           holds the pass, so there is nothing to push back). `records` means
           "server rows adopted locally", and latching a pass IS an adoption. */
        const serverWins = incoming.updated > local.updated
          || (incoming.updated === local.updated && incoming.passed && !local.passed);
        /* Fields the timestamp owns: the winning side's latest text. */
        const winner = serverWins ? incoming : local;
        /* Fields the winner must never be allowed to lose: passing is a latch
           and the score only ever ratchets up. */
        const merged = normalize(Object.assign({}, winner, {
          passed: incoming.passed || local.passed,
          score: Math.max(incoming.score, local.score),
        }));
        bucket(chapterId)[exerciseId] = merged;
        if (serverWins) records.push({ chapterId, exerciseId, record: merged });
        else if (local.updated > incoming.updated) {
          /* Push-back rides on snapshot(), which reads the bucket we just wrote,
             so the row sent up carries the merged latch/max score rather than
             the local value that would have regressed the server. */
          changed += 1;
        }
      }
      flush();
      return { changed, records };
    }

    /* `total` counts the ids handed in, not the ids with a record, so a chapter
       reports "3 exercises, 1 passed" rather than hiding unattempted work.

       A self-assessment of 'fail' is the learner saying "I did not get it" and
       is therefore NOT counted as a self-assessed pass — it matches the
       reference store in the plan (line 3002). Any other self-assessment
       ('pass', 'hint', …) still counts, so a learner who reached for a hint
       without being graded is visible rather than invisible. */
    function chapterSummary(chapterId, exerciseIds) {
      const ids = Array.isArray(exerciseIds) ? exerciseIds : [];
      let passed = 0;
      let selfAssessed = 0;
      for (const exerciseId of ids) {
        const record = read(chapterId, exerciseId);
        if (!record) continue;
        if (record.passed) passed += 1;
        else if (record.selfAssessed && record.selfAssessed !== 'fail') selfAssessed += 1;
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
