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
       choke point needs no separate migration pass over localStorage.

       `score` is clamped at BOTH ends, mirroring the server's `ge=0, le=1`. Only
       the lower bound used to be clamped here, so a record scoring 1.7 left this
       store and failed the server's validation — which, before per-row
       validation, failed the reader's entire sync batch over one row. The clamp
       belongs at the same place on both sides of the wire so the value a device
       holds is always one the server can accept. */
    function normalize(record) {
      const source = record && typeof record === 'object' ? record : {};
      return {
        passed: source.passed === true,
        score: typeof source.score === 'number' && source.score >= 0 ? Math.min(source.score, 1) : 0,
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

    /* Split the snapshot into batches of at most `size` rows.

       The server accepts a batch far larger than any plausible corpus (its cap
       is a ceiling on one request body, not on how much progress a reader may
       hold), so this is not needed to get a reader's progress through. It is
       needed because the server counts WRITE REQUESTS against a per-minute
       quota: a reader who works through the whole corpus has well over one
       batch worth of rows, and sending them in slices lets a partial sync
       succeed instead of refusing all of it.

       `size` is coerced to a positive integer and falls back to the whole
       snapshot, so a caller passing nothing, a zero or a negative number gets
       one batch rather than an empty array of batches — the shape that used to
       be the whole behaviour. */
    function chunks(size) {
      const rows = snapshot();
      const step = Number.isInteger(size) && size > 0 ? size : rows.length || 1;
      const parts = [];
      for (let index = 0; index < rows.length; index += step) {
        parts.push(rows.slice(index, index + step));
      }
      return parts;
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

       Returns {changed, records}: `changed` is a COUNT of the rows the local
       side owns and the caller must push back to the server; `records` lists the
       server rows adopted locally as {chapterId, exerciseId, record}. The
       push-back payload itself is snapshot(), so it stays a single code path and
       the count is the only thing the caller has to act on -- it is never a list
       and nothing iterates it. `rows` is never mutated — callers reuse the array
       they hand in.

       `changed` answers "does the server hold everything this device knows?",
       and there are exactly two ways it can fail to. The first is a row the
       server has NEVER seen: it does not appear in `rows`, so the loop above
       never reaches it and a naive merge reports nothing for it -- the reader
       does the exercise on this device, the row never goes up, and the only
       other upload path (a one-shot push after each verdict, no retry, no
       offline queue) loses it for good on one quota refusal or one dropped
       connection. `answered` records which ids actually arrived so the local
       rows can be swept afterwards. The second is a row the server has but with
       LESS progress than the reader has earned here -- handled inline, below.

       Two arguments narrow what the sweep is allowed to conclude, and both
       exist because a pull is a request in flight while the reader keeps
       working:

       * `scopeChapterId` -- the pull only asked about this chapter, so an
         absent row says nothing about any other one. Without it every chapter
         is swept, which is exact for an unscoped pull and wrong for a scoped
         one: the reader would pay a write-back on every chapter entry.
       * `inFlight` -- [{chapter, exercise}] the caller has ALREADY pushed
         successfully while this request was open. The answer describes a
         moment before those rows landed, so counting them would ship every row
         the reader did during the pull a second time: two writes for one
         exercise, against a quota of twenty writes a minute. A row whose push
         is still outstanding, or that failed, is deliberately NOT listed and
         so still counts -- one duplicate is recoverable, a lost result is not.

       Omitting `inFlight` is honest when nothing has been pushed during the
       pull, which is the common case for a chapter entry. */
    function merge(rows, scopeChapterId, inFlight) {
      let changed = 0;
      const records = [];
      /* Ids the server actually answered with. The separator is a character no
         id can contain, so 'a' + 'b c' cannot collide with 'a b' + 'c'. A
         null-prototype object keeps a chapter literally called 'toString' or
         '__proto__' from reading as answered. */
      const answered = Object.create(null);
      const scope = typeof scopeChapterId === 'string' && scopeChapterId ? scopeChapterId : null;
      /* Null-prototype SET of ids the caller has already pushed during this
         request. Same separator for the same reason. */
      const pushed = Object.create(null);
      for (const entry of Array.isArray(inFlight) ? inFlight : []) {
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.chapter !== 'string' || typeof entry.exercise !== 'string') continue;
        pushed[entry.chapter + '\u0000' + entry.exercise] = true;
      }
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object') continue;
        const chapterId = typeof row.chapter === 'string' ? row.chapter : '';
        const exerciseId = typeof row.exercise === 'string' ? row.exercise : '';
        if (!chapterId || !exerciseId) continue;
        answered[chapterId + '\u0000' + exerciseId] = true;
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
        /* One row, one vote: `changed` is a COUNT of rows to write back, so the
           two reasons a row qualifies are OR'd into a single increment rather
           than counted twice. */
        const newerLocal = !serverWins && local.updated > incoming.updated;
        /* The server has this row and it holds LESS than the reader has earned
           here. `merged` latched the local pass and ratcheted the local score,
           so the row above reads as passed locally while the server still says
           0 -- and a latched value nobody sends is a pass that lives on exactly
           one device forever. The server's own upsert is passed=MAX(...),
           score=MAX(...), and that MAX assumes the client ships what it knows:
           a row is adopted into `records` (and repainted) as a server row, so
           nothing else would ever carry it back up. Counting it here is the
           other end of the same monotonicity promise, not a second rule.

           This fires only when the MERGED value differs from what the server
           sent. A row the server already agrees with contributes nothing, so a
           pull that changes nothing schedules no write-back and cannot spend the
           reader's 20-writes-per-minute quota on a no-op. */
        const aheadOfServer = merged.passed !== incoming.passed || merged.score !== incoming.score;
        if (newerLocal || aheadOfServer) changed += 1;
      }
      /* The rows the server never mentioned at all. This is the one that needs
         no arbitration: there is nothing to arbitrate against, and the local
         values ARE the merged ones, so this sweep can only ever ship a row the
         reader genuinely did on this device. */
      for (const chapterId of Object.keys(data)) {
        if (scope && chapterId !== scope) continue;
        const chapter = data[chapterId];
        if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) continue;
        for (const exerciseId of Object.keys(chapter)) {
          const key = chapterId + '\u0000' + exerciseId;
          if (key in answered) continue;
          if (key in pushed) continue;
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

    const store = { available, read, write, snapshot, chunks, merge, chapterSummary, summary, reset };
    return store;
  }

  return { KEY, CODE_LIMIT, create };
});
