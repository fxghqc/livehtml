# Phase C — Complete

> Per `/goal` checkpoint 4: C was scope-restated in `docs/scope-restatement-c.md`
> before any code change. This doc is the post-implementation report.

## Summary

C delivers the descoped envelope from `docs/readback-plan.md` § C:

1. **On-disk format**: `{ "version": 2, "fields": { key: { v, ts, by } } }`
2. **API default = flat** (`sync.js` continues to work without changes)
3. **`?meta=1` GET** returns the envelope on both `/pages/<key>/state` and
   `/state/<room>`
4. **Backward read**: legacy flat-format files load correctly; format
   detection uses the top-level `version` field only (user values that
   coincidentally look like `{v, ts}` are NOT mistaken for the envelope)
5. **Lazy upgrade**: legacy files stay flat on disk until the next write
   naturally upgrades them — no migration job

## V script results

```
tests/v1_state_alias.sh           PASS  (regression — A alias still bytes-identical default GET)
tests/v_demo_smoke.sh             PASS  (regression — demo plumbing unchanged)
tests/v1_longpoll_changed.sh      PASS  (B regression)
tests/v2_longpoll_not_modified.sh PASS  (B regression)
tests/v3_longpoll_concurrency.sh  PASS  (B regression, see commit for ΔRSS)
tests/v4_longpoll_sequence.sh     PASS  (B regression)
tests/v5_longpoll_reset.sh        PASS  (B regression — new format round-trips through restart)
tests/v6_atomic_write_kill.sh     PASS  (B regression — envelope written atomically too)
tests/c1_envelope_format.sh      PASS  (disk shape, ISO ts, by per source)
tests/c2_meta_api.sh             PASS  (?meta=1 on alias and legacy paths; flat by default)
tests/c3_backward_read.sh        PASS  (legacy flat → flat GET + envelope meta=1; tricky payload roundtrips)
```

All run in one sequential battery. No orphan bun processes. Production
`state/` not polluted.

## Implementation notes

### In-memory shape unchanged for `rooms`

`rooms: Map<room, flat-object>` stays as today. A parallel
`metaByRoom: Map<room, Record<key, {ts, by}>>` carries per-key metadata.
WS messages (`set` / `del` / `replace`) carry the same flat payloads they
always have — there is no on-the-wire schema change.

### Disk format detection is strict

`loadRoom` accepts a parsed file as envelope only if all four hold:
- it's a non-array object
- `parsed.version === 2`
- `parsed.fields` is a non-array object
- per-key entry has `"v" in entry`

Otherwise the file is treated as legacy flat. This protects the case
the plan explicitly called out: a user storing values that look like
`{v, ts}` does not pollute the detection because the check is at the
top level only.

### `by` source labels

- `"http"` for both HTTP PUT and HTTP DELETE
- `peer.id` (random per WS connection, or client-supplied via the `hi`
  message) for WS `set`
- `"delete"` for /pages DELETE (mirrors the existing broadcast `by`)
- Empty string for keys loaded from a legacy flat file with no meta

These remain pure labels — no authentication, per plan's deferred list.

### `ts` semantics

ISO 8601 UTC timestamp captured at the write call site (`new Date().toISOString()`).
For PUT-replaces, all keys in the new state get the same `ts`. WS `set`
updates only that key's `ts`. WS `del` drops the meta entry entirely.

### Long-poll envelope behavior is unchanged

The `state` field inside long-poll `changed` / `reset` responses is still
the flat object. `?meta=1` only affects plain (non-`?wait`) GETs. This is
the scope I committed to in `scope-restatement-c.md`; adding `?meta=1`
to long-poll is a follow-up if you want it.

### Tricky payload roundtrip

C.V3 step 4–5 verifies: PUT `{version: 7, fields: {x: {v: 1, ts: "user-ts"}}}`.
Server wraps it as our envelope; user gets back the exact same JSON on
the next GET. The user's "version" and "fields" keys are preserved by
the wrapper.

## Files changed in C

```
server.ts                | + FieldMeta / metaByRoom / setKeyMeta / delKeyMeta /
                         |   replaceRoomMeta; loadRoom format detection;
                         |   doSave writes envelope; handleStateRoom GET
                         |   honors ?meta=1; meta wired at the 5 write sites
tests/_lib.sh            | + EADDRINUSE retry (up to 3) in start_server /
                         |   restart_server (random_port has a TOCTOU window)
tests/c1_envelope_format.sh  (new, executable)
tests/c2_meta_api.sh         (new, executable)
tests/c3_backward_read.sh    (new, executable)
docs/scope-restatement-c.md  (the pre-implementation scope doc)
docs/readback-progress.md    (updated; final entry says ALL DONE)
docs/phase-C-complete.md     (this file)
```

## What I did NOT touch (still preserved)

- `public/sync.js` — unchanged. WS protocol identical.
- `examples/demo.html` — unchanged.
- WS messages — same shape (`hi/init/set/del/replace/pres`).
- `/pages/<key>` HTML upload / serve — unchanged.
- `skill/SKILL.md` — unchanged in C (and in B). Adding a Cookbook 4 for
  long-poll or a note about `?meta=1` is a natural follow-up I left for
  you to decide.
- Deploy / docker / production at 192.168.130.12:39191 — never touched.
- The `/state/<room>` route does NOT have `?wait/since` long-poll added
  (plan only specified the alias gets it; you asked once about symmetry,
  I deferred per plan default).

## Final state of the branch

- Branch: `readback-abc`
- Commits:
  - `44e1c23` baseline
  - `1b3d437` phase A
  - `65d268b` phase B
  - (C commit will be the next git push prep — see commit log after this)
- Tests: 10 V scripts + v_demo_smoke + V3, all exit 0
- Production state: only `wstest.json` (pre-existing) and `.keep` remain
- No orphan bun processes

## Awaiting user review

Per the goal directive: "ALL DONE, 留分支等用户 review". Branch is here.
Suggested review steps:

```bash
cd /Users/fx/Projects/livehtml
git log --oneline main..readback-abc
git diff main..readback-abc -- server.ts
ls tests/
# If happy: git checkout main && git merge --ff-only readback-abc
# If not:   git checkout main && git branch -D readback-abc
```

If you want me to:
- add a Cookbook 4 for long-poll → say so
- add `?wait/since` symmetry on `/state/<room>` → say so
- run the V2 paired trial → see `tests/v2_paired_trial.md` for the protocol
- update SKILL.md to mention `?meta=1` → trivial follow-up
