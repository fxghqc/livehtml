# Phase A — Complete

> Per `/goal` checkpoint 2: STOP, await user review before entering Phase B.

## Summary

Phase A delivers the three deliverables from `docs/readback-plan.md` § A:

1. **skill three cookbooks** for read-back (single / aggregate / debug)
2. **`/pages/<key>/state` alias** equivalent to `/state/pages/<key>` (byte-level)
3. **cookbook UA convention** `-A "livehtml-agent-readback/1"` so access log
   distinguishes agent read-backs from browser traffic

## V script results

```
$ bash tests/v1_state_alias.sh
PASS: step 1: PUT old, GET old/new identical
PASS: step 2: PUT new, GET old/new identical
PASS: step 3: PUT responses agree on room id
PASS: step 4: DELETE via new clears state visible from old
PASS: step 5: invalid JSON → 400 on both
PASS: step 6: array body → 400 on both
PASS: step 7: unknown key → {}
OK: all 7 steps passed for /pages/<key>/state alias
EXIT=0

$ bash tests/v_demo_smoke.sh
PASS: step 1: /examples/demo.html serves, has data-live
PASS: step 2: /sync.js serves
step3:ok  step4:ok  step5:ok  step6:ok  step7:ok  DONE
PASS: steps 3-7: WS hi/init/set/del + persistence + broadcast
OK: demo.html plumbing intact
EXIT=0
```

V2 (paired trial) is a behavioral test requiring real subagents; documented
in `tests/v2_paired_trial.md` as a protocol. It is **not** a phase-A gate;
it's a post-merge leading indicator. Skip unless you want stakeholder proof.

## Demo regression — what was checked

`v_demo_smoke.sh` exercises the same plumbing demo.html depends on, without
needing a browser:

- `/examples/demo.html` serves and contains `data-live="task-1"` etc.
- `/sync.js` serves
- WS `hi` → `init` flow (joins room "demo", receives state)
- WS `set` message → state file on disk (`state/demo.json`) updates within
  500ms (server debounces save by 300ms)
- WS `del` message → key removed from state file
- Reconnect → init shows previously-set value (persistence intact)
- Broadcast → third client receives `set` from second client

Why automated is sufficient: Phase A made zero changes to `public/sync.js`
or to the WS message protocol. The only server change touching state is the
new alias endpoint, which shares the `handleStateRoom` helper with the old
endpoint — so the broadcast/persistence paths used by demo.html are
literally the same code as before.

If you still want a manual browser check, the procedure is at the top of
`tests/v_demo_smoke.sh` as comments: start server → open demo in two windows
→ click a checkbox → confirm both windows update + state file shows it.

## Files changed

```
server.ts       | 71 +++++++++++++++++++++++++++++++++++++--------------
skill/SKILL.md  | 65 ++++++++++++++++++++++++++++++++++++++++++++++++---
tests/_lib.sh           (new)
tests/v1_state_alias.sh (new, executable)
tests/v_demo_smoke.sh   (new, executable)
tests/v2_paired_trial.md (new)
docs/readback-progress.md (new)
docs/phase-A-complete.md  (this file)
```

## Implementation notes

### Why I extracted `handleStateRoom`

Rather than copy-paste the PUT/GET/DELETE logic into the new alias branch
(which would invite drift), both routes call the same helper. This is what
makes the V1 byte-equivalence test pass by construction: there's literally
one code path computing the response.

### Why the alias check comes before MinIO check

`/pages/<key>/state` is the state alias, not a MinIO operation. Putting the
`endsWith("/state")` check before `if (!minio) return 503` means the alias
works even when MinIO is unconfigured. This matches the spec: state lives
on local disk in `state/`, independent of MinIO.

### Why I added `-A "livehtml-agent-readback/1"` only to read-back cookbooks

The plan says "cookbook 里 curl 加 -A ..." — i.e. specifically the read-back
ones. The PUT-the-page-HTML curl is not read-back; leaving it unlabelled
keeps the access log's UA semantically meaningful: "this UA tag = an agent
asked for state".

### Why V2 is documented but not automated

Each V2 trial spawns a real LLM subagent. Cost and wall-time are non-trivial
(see `tests/v2_paired_trial.md` for the sequential-stopping protocol).
Phase A's functional correctness — "the alias exists, returns identical
bytes, the cookbooks document it" — doesn't need V2 to verify. V2 is the
behavioral leading indicator (does agent actually USE it?), runnable as a
release-gate or post-merge check.

## What I did NOT touch

- `public/sync.js` (zero changes; preserves all browser behavior)
- `examples/demo.html`
- WebSocket message protocol (`hi/init/set/del/replace/pres`)
- `/state/<room>` external behavior (refactored internals only; bytes
  identical, proven by V1)
- `/pages/<key>` HTML upload/serve (only added a sibling `/state` route)
- `.gitignore`, `package.json` deps, `Dockerfile`, deploy config
- The production server at `192.168.130.12:39191`

## Awaiting user decision

Per checkpoint 2: STOP. Once you've reviewed, options:

1. **Approve → enter Phase B** (long-poll). I'll write a `spec-restatement`
   delta first if Phase A surfaced any new ambiguity (it didn't, AFAICT).
2. **Revise** — point out anything you want changed (cookbook wording,
   alias behavior edge case, test rigor); I'll fix and re-run V1 + smoke.
3. **Abort / rewind** — `git checkout main && git branch -D readback-abc`
   removes everything; the baseline commit on `main` is preserved.
