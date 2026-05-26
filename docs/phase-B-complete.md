# Phase B — Complete

> Per `/goal` checkpoint 3: STOP, await user review before entering Phase C.
> Plan also says C requires a separate scope re-evaluation STOP.

## Summary

Phase B delivers the long-poll protocol from `docs/readback-plan.md` § B
plus the three "must-do top 3" risks:

1. **`wait/since` long-poll** on `/pages/<key>/state`
2. **three-state envelope**: `changed` / `not_modified` / `reset`
3. **bootId + monotonic version** as opaque etag `<bootId>:<version>`
4. **pending waiter cleanup** on timeout / client abort / next write
5. **state file atomic write** verified end-to-end (was already in baseline)

## Protocol — quick reference

```
GET /pages/<key>/state?wait=<sec>&since=<bootId:version>

# changed: state advanced past your `since`
{ "status": "changed",      "etag": "<boot>:<v>", "version": <v>, "state": {...} }

# not_modified: wait elapsed without a write
{ "status": "not_modified", "etag": "<boot>:<v>", "version": <v> }

# reset: bootId mismatch (restart) OR your since.version is impossible
{ "status": "reset",        "etag": "<boot>:0",   "version":  0,  "state": {...} }
```

- `wait` is capped at 60s; `<= 0` or missing → plain GET (no envelope)
- `since` missing or malformed → reset (client bootstraps from there)
- The plain (non-`?wait`) GET behavior on the alias is **unchanged** — V1
  alias equivalence still passes against `/state/pages/<key>`

## V script results

```
tests/v1_state_alias.sh           PASS  (regression — A alias still bytes-identical)
tests/v_demo_smoke.sh             PASS  (regression — WS demo plumbing intact)
tests/v1_longpoll_changed.sh      PASS  (poll woke in ~25ms after PUT)
tests/v2_longpoll_not_modified.sh PASS  (wait=2 returned at ~2.02s, no .state field)
tests/v3_longpoll_concurrency.sh  PASS  (100 parked polls; ΔRSS peak ≤ 1MB)
tests/v4_longpoll_sequence.sh     PASS  (3 PUTs, 3 changed, versions 1<2<3)
tests/v5_longpoll_reset.sh        PASS  (restart → new bootId, version=0, state from disk)
tests/v6_atomic_write_kill.sh     PASS  (50 PUTs + SIGKILL, all .json parse, 0 .tmp residuals)
```

All run sequentially in one battery with no shared state, no orphan bun
processes, no production `state/` pollution.

## Implementation notes

### bootId is in-memory only

Picked `crypto.randomUUID()` at startup, kept in a module-level `const`.
Restart → new bootId → all old-etag pollers get `reset`. No persistence,
no sidecar file, no recovery dance.

### `versionByRoom: Map<string, number>` bumped at 5 sites

1. `handleStateRoom` PUT (HTTP)
2. `handleStateRoom` DELETE (HTTP)
3. WS `set` handler
4. WS `del` handler
5. `/pages/<key>` DELETE (when state is cleared as a side effect)

Each bump triggers `notifyWaiters(room)`, which snapshots the waiter set
and resolves every parked poller with `changed`.

### Waiter cleanup is single-flight

`settleWaiter(w, resp)` checks a `settled` flag, clears the timer, removes
the abort listener, deletes from the per-room set (deleting the set if
empty), then resolves the Promise. It's called from three paths — write
notify, timeout, client abort — and the flag ensures exactly one resolve
per waiter.

V3 verifies cleanup end-to-end: parking 100 polls and letting them all
drain leaves the server's RSS lower than baseline (-864 KB on one run),
i.e. no waiter map growth.

### `reset` always reports `version: 0`

Per plan spec. The included `state` is whatever `loadRoom(room)` returns
from disk under the new bootId. After a reset the client uses
`since=<newBoot>:0` for the next poll; the next write bumps version to 1
and triggers `changed`.

### Long-poll is opt-in to the alias only

`/pages/<key>/state?wait=N&since=...` engages the envelope.
`/state/<room>?wait=N` does **not** — old path stays the simple plain-GET
behavior. This was a deliberate choice (plan only specs long-poll on the
new alias) and keeps the V1 byte-equivalence test honest.

### Test infrastructure fixes uncovered along the way

- **Isolation**: `server.ts` derives `STATE_DIR = import.meta.dir + "/state"`.
  Symlinking server.ts into the rundir caused `import.meta.dir` to resolve
  back to the source tree, so the first few test runs polluted the
  production `state/`. Fix: `cp` server.ts into the rundir; `import.meta.dir`
  now resolves locally. ~50 polluted files were cleaned from prod (user-approved).
- **Orphan bun processes**: backgrounding a subshell with `( ... bun ... ) &`
  captures the subshell PID in `$!`, not the bun PID. Killing the subshell
  leaves bun running. Fix: `( ... exec bun ... ) &` so the subshell becomes
  bun via exec; `$!` now points at bun directly.
- **V3 `wait` without args**: `wait` waits for *all* shell-tracked children,
  including the bg-spawned bun server (which never exits). Fix: capture
  curl PIDs in `CURL_PIDS=()` and wait on them explicitly.

## Files changed (since `1b3d437`)

```
server.ts             | ~135 insertions, +4 wired callsites
tests/_lib.sh         | + restart_server, exec fix, cp-instead-of-symlink
tests/v1_longpoll_changed.sh        (new, executable)
tests/v2_longpoll_not_modified.sh   (new, executable)
tests/v3_longpoll_concurrency.sh    (new, executable; CURL_PIDS fix)
tests/v4_longpoll_sequence.sh       (new, executable)
tests/v5_longpoll_reset.sh          (new, executable)
tests/v6_atomic_write_kill.sh       (new, executable)
docs/readback-progress.md           (updated)
docs/phase-B-complete.md            (this file)
```

## What I did NOT touch (still preserved)

- `public/sync.js` — zero changes; demo browser sync identical
- `examples/demo.html` — unchanged
- WS protocol (`hi/init/set/del/replace/pres`) — unchanged
- `/state/<room>` external behavior — unchanged (refactored internals only)
- `/pages/<key>` HTML upload/serve — unchanged
- `skill/SKILL.md` — **unchanged in Phase B**. The plan's A scope explicitly
  enumerated three cookbooks and didn't mention adding a long-poll cookbook
  in B. I deliberately left it alone to avoid scope creep — a Cookbook 4
  for `?wait/since` would be a natural follow-up but I'd rather you decide.
- Deploy / docker / production at 192.168.130.12:39191 — never touched

## Open question for you

The plan deliberately left `/state/<room>?wait/since` unimplemented (long-poll
is alias-only). I followed that. If you want symmetry — i.e. the legacy path
also opts into long-poll — say so and I'll add it before Phase C (~5 lines,
same V scripts apply). Default is: don't add it.

## Awaiting user decision

Per checkpoint 3: STOP. Options:

1. **Approve → enter Phase C** scope re-evaluation. Plan says C should be
   reduced to disk envelope only (`{version, fields: {k: {v, ts, by}}}`),
   API default still flatten, `?meta=1` for full. I'll write a brief
   scope-restatement and STOP again per checkpoint 4 before coding.
2. **Approve + add Cookbook 4** for long-poll in SKILL.md, then C.
3. **Approve + add `/state/<room>?wait` symmetry**, then C.
4. **Revise** — point out anything wrong; I'll fix and re-run.
5. **Abort / rewind** — `git checkout main && git branch -D readback-abc`
   wipes everything; baseline preserved.
