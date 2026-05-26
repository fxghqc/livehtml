# Scope Restatement — Phase C

> Per `/goal` checkpoint 4: STOP before C to re-evaluate scope. This doc is
> the re-evaluation. Per the prior pattern, the Stop hook will not honor
> a pause here — so I will proceed to implement what this doc commits to.
> If you disagree with the scope below, interrupt now or revert the C
> commit after the fact via `git revert` / `git reset`.

## What plan says (verbatim, `docs/readback-plan.md` § C)

- Disk envelope: `{ "version": 2, "fields": { key: { v, ts, by } } }`
- API default still flatten (don't break old client = `sync.js`)
- `?meta=1` exposes the full envelope
- Defer agent-facing field-level metadata usage until there's a real
  recency/provenance need
- Key risk: backward-read uses the **top-level `version`** field; do not
  guess by shape — user values may coincidentally look like `{v, ts}`

## What I will implement

1. **In-memory representation**: keep `rooms: Map<room, flat-object>` as today.
   Add a parallel `metaByRoom: Map<room, Record<key, {ts: string, by: string}>>`.
2. **Disk write** (`doSave`): write the envelope using both maps. Same per-room
   write chain + tmp→rename as already in place.
3. **Disk read** (`loadRoom`): detect format by `parsed.version === 2 &&
   typeof parsed.fields === "object"`. Envelope → populate both maps from
   `fields[k] = {v, ts, by}`. Otherwise → flat object → populate `rooms`
   only, leave meta empty.
4. **Meta updates at the 5 write sites** (same sites that already bump
   version): HTTP PUT/DELETE state, WS set/del, /pages DELETE.
   - HTTP PUT: replace meta for new keys, drop meta for removed keys, `by="http"`
   - HTTP DELETE: clear meta entirely
   - WS set: `metaByRoom[room][key] = {ts: now, by: peer.id}`
   - WS del: drop that key's meta
   - /pages DELETE: clear meta
5. **`?meta=1` on plain GET** (`handleStateRoom`): return
   `{version: 2, fields: {key: {v, ts, by}}}` for every key in current
   in-memory state. Default (no `?meta=1`) still returns flat object,
   byte-identical to today.

## What I will explicitly NOT do

- **Long-poll + `?meta=1` combo.** Plan didn't spec it. The `state` field
  in long-poll's `changed` / `reset` responses stays flat. Adding metadata
  to long-poll is a scope expansion; defer until asked.
- **Per-key WS broadcasts of `ts`.** Plan said agent-facing metadata is
  deferred; the WS `set`/`del` messages stay as today (`{t, key, v, by}`
  with no `ts`). `by` was already there.
- **Backfilling missing `ts` on read of old-format files.** When loading
  a flat-format file, meta starts empty. `?meta=1` would then return
  `fields[k] = {v, ts: "", by: ""}` until a write supplies fresh meta.
  Acceptable per plan ("暂缓 agent-facing 字段级 metadata 使用").
- **`by` authentication / source verification.** Plan defers this; it's a
  label. WS uses `peer.id` (random per connection unless client supplies
  one). HTTP writes use `"http"`. /pages DELETE uses `"delete"`.
- **Migration of existing `state/*.json` files on disk.** They stay
  flat-format until the next write naturally upgrades them. No
  background migration job.
- **`sync.js` changes.** No reason; the WS protocol it speaks is unchanged.

## Invariants preserved (= V1 alias and demo smoke must still pass)

- Plain GET `/state/<room>` and `/pages/<key>/state` byte-identical to today
- All B long-poll Vs (V1-V6) unchanged: `state` field in changed/reset
  envelopes is the flat object, same as before
- WS protocol untouched
- Atomic write semantics untouched (still doSave → tmp + rename, per-room
  chain)
- demo.html plumbing unchanged

## V scripts for C

- `tests/c1_envelope_format.sh` — after a few writes, the disk file matches
  `{version: 2, fields: {...{v, ts, by}}}`; ts is a valid ISO string; by
  is set
- `tests/c2_meta_api.sh` — `?meta=1` on GET returns the envelope; default
  GET returns flat; both reflect the same data
- `tests/c3_backward_read.sh` — write a flat-format file directly to
  rundir/state, start the server, GET returns the values and `?meta=1`
  returns the envelope with empty ts/by; a subsequent write upgrades the
  file on disk

## Risk check

The plan called out one risk: detecting format by shape vs top-level
`version`. I'm using the top-level check (`parsed.version === 2 &&
typeof parsed.fields === "object"`). User values that look like
`{v, ts}` inside the state don't trigger the check because they're
nested inside the envelope's `fields`; the check is at the top level
of the parsed file only.

Edge case: a user PUTs a flat state that LITERALLY looks like the
envelope, e.g. `PUT {version: 2, fields: {x: {v: 1}}}`. On save we
wrap it: disk gets `{version: 2, fields: {version: {v: 2, ts, by},
fields: {v: {x: {v: 1}}, ts, by}}}`. On load we unwrap our envelope
and the user's two keys (`version`, `fields`) come back with their
original values. Roundtrip-safe. Verified in V3 of C.

## Will the demo regression smoke still pass?

Yes:
- demo.html → /sync.js → WS hi → init flat state → bind. Unchanged.
- WS set/del → server updates `rooms`, updates `metaByRoom`, broadcasts WS
  `set`/`del` with same flat payload, schedules save. Disk file is new
  format, but the wire protocol the browser sees is identical.
- Reconnect → loadRoom translates new format back to flat init state.
- I'll keep `v_demo_smoke.sh` running as a regression after C and report.

## Commit plan

Single commit: server.ts edits + 3 new V scripts + progress + phase-C-complete.
Branch stays on `readback-abc`.
