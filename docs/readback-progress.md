# Readback A+B+C — Progress

Branch: `readback-abc` (baseline `main` @ `44e1c23`).

## ALL DONE

All three phases shipped to branch `readback-abc`. Awaiting user review.

## Phase A — Read-back 一等公民化 ✓

Commit: `1b3d437`.

- [x] skill 三个 read-back cookbook (`skill/SKILL.md`)
- [x] `/pages/<key>/state` GET/PUT/DELETE 别名 (`server.ts`)
- [x] alias equivalence test (`tests/v1_state_alias.sh`)

## Phase B — Long-poll ✓

Commit: `65d268b`.

- [x] `wait/since` long-poll (`server.ts:longPoll`)
- [x] `changed/not_modified/reset` 三态
- [x] pending waiter abort+timeout cleanup
- [x] 重启 reset 行为测试
- [x] state 原子写 (baseline + end-to-end verification under SIGKILL)

## Phase C — Envelope (descoped) ✓

Commit: (this commit).

- [x] 磁盘 envelope `{version:2, fields:{key:{v,ts,by}}}`
- [x] API default flatten — sync.js & V1 alias still pass byte-equivalent
- [x] `?meta=1` returns envelope on both `/pages/<key>/state` and `/state/<room>`
- [x] backward read for legacy flat files (detection by top-level `version`)
- [x] lazy upgrade — next write upgrades a legacy file in place
- [x] format detection is top-level-only (user payload that looks like
  `{v, ts}` is wrapped, not interpreted)

## V script exit codes (last full run 2026-05-26T08:58Z)

### Functional (A)
| script | exit code |
|---|---|
| `tests/v1_state_alias.sh` | **0** |
| `tests/v_demo_smoke.sh` | **0** |
| `tests/v2_paired_trial.md` | n/a (protocol doc) |

### Long-poll (B)
| script | exit code |
|---|---|
| `tests/v1_longpoll_changed.sh` | **0** |
| `tests/v2_longpoll_not_modified.sh` | **0** |
| `tests/v3_longpoll_concurrency.sh` | **0** |
| `tests/v4_longpoll_sequence.sh` | **0** |
| `tests/v5_longpoll_reset.sh` | **0** |
| `tests/v6_atomic_write_kill.sh` | **0** |

### Envelope (C)
| script | exit code |
|---|---|
| `tests/c1_envelope_format.sh` | **0** |
| `tests/c2_meta_api.sh` | **0** |
| `tests/c3_backward_read.sh` | **0** |

### Repository hygiene
- production `state/` clean — only `.keep` and pre-existing `wstest.json`
- no orphan `bun server.ts` processes after the battery

## Files changed across the branch

### server.ts
- A: extracted `handleStateRoom`; routed `/pages/<key>/state` alias
- B: bootId + versionByRoom + Waiter + waitersByRoom; bumpAndNotify /
  notifyWaiters / settleWaiter; longPoll handler; wired bumps into 5 sites
- C: FieldMeta + metaByRoom; loadRoom format detection; doSave envelope;
  ?meta=1 in handleStateRoom GET; meta wiring at the 5 sites

### skill/SKILL.md
- A: replaced "Read state from outside the browser" with three cookbooks
  + `-A "livehtml-agent-readback/1"` UA convention
- B + C: unchanged (deliberate; long-poll cookbook and ?meta=1 note are
  open follow-ups for user decision)

### tests/
| file | added in |
|---|---|
| `_lib.sh` | A (later hardened in B + C) |
| `v1_state_alias.sh` | A |
| `v_demo_smoke.sh` | A |
| `v2_paired_trial.md` | A (protocol doc, not script) |
| `v1_longpoll_changed.sh` | B |
| `v2_longpoll_not_modified.sh` | B |
| `v3_longpoll_concurrency.sh` | B |
| `v4_longpoll_sequence.sh` | B |
| `v5_longpoll_reset.sh` | B |
| `v6_atomic_write_kill.sh` | B |
| `c1_envelope_format.sh` | C |
| `c2_meta_api.sh` | C |
| `c3_backward_read.sh` | C |

### docs/
- `spec-restatement.md` (preflight)
- `scope-restatement-c.md` (C re-evaluation)
- `phase-A-complete.md`, `phase-B-complete.md`, `phase-C-complete.md`
- `PROPOSAL-no-git-repo.md` (resolved with方案 A — git init + branch)
- `readback-progress.md` (this file)

## Untouched / preserved

- `public/sync.js`, `examples/demo.html`, WS protocol (`hi/init/set/del/replace/pres`)
- `/pages/<key>` HTML upload/serve and DELETE; `/state/<room>` external
  behavior (refactored internals only; default GET stays byte-identical)
- Atomic-write internals (`per-room write chain + tmp→rename`,
  `server.ts:50` and the doSave chain) — extended in C to write envelope
  via the same mechanism
- Deploy / docker / production (private internal deploy) — never touched
- `.gitignore`, `package.json` deps, `Dockerfile`

## Logs / history

- 2026-05-26T08:11Z — baseline commit `44e1c23` on `main`; switched to
  `readback-abc` (PROPOSAL方案 A approved)
- 2026-05-26T08:24Z — A implementation + V1 green
- 2026-05-26T08:25Z — v_demo_smoke green
- 2026-05-26T08:28Z — Phase A committed (`1b3d437`)
- 2026-05-26T08:35Z — found _lib.sh isolation bug, fixed via `cp`
- 2026-05-26T08:42Z — found V3 `wait`-no-args bug; found subshell-PID
  orphan-bun bug; both fixed
- 2026-05-26T08:48Z — Phase B committed (`65d268b`)
- 2026-05-26T08:52Z — C scope re-evaluation (`scope-restatement-c.md`)
- 2026-05-26T08:57Z — C implementation + 3 V scripts green
- 2026-05-26T08:58Z — full battery green + V3 standalone green
- ALL DONE
