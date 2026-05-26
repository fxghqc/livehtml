# Readback A+B+C — Progress

Branch: `readback-abc` (baseline `main` @ `44e1c23`).

## Current state

- **Phase A**: complete and committed (`1b3d437`)
- **Phase B**: implemented, all V scripts green, awaiting checkpoint review
- **Phase C**: not started (will re-evaluate scope before entry)

## Phase A — Read-back 一等公民化 ✓

### Checklist

- [x] skill 三个 read-back cookbook (`skill/SKILL.md`)
- [x] `/pages/<key>/state` GET/PUT/DELETE 别名 (`server.ts`)
- [x] alias equivalence test (`tests/v1_state_alias.sh`)

### V script exit codes (last full run 2026-05-26T08:48Z)

| script | exit code |
|---|---|
| `tests/v1_state_alias.sh` | **0** |
| `tests/v_demo_smoke.sh` | **0** |
| `tests/v2_paired_trial.md` | n/a (protocol doc) |

## Phase B — Long-poll ✓

### Checklist

- [x] `wait/since` long-poll (`server.ts:longPoll`)
- [x] `changed/not_modified/reset` 三态
- [x] pending waiter abort+timeout cleanup (V3 RSS test verifies)
- [x] 重启 reset 行为测试 (V5)
- [x] state 原子写
  - **已在 baseline 实现**（`server.ts:50,94-105`，per-room write chain + tmp→rename）
  - V6 在 SIGKILL during write 场景下端到端验证：50 并发 PUT + 进程被 SIGKILL，磁盘上所有 `state/*.json` 都 parse 成功

### V script exit codes (last full run 2026-05-26T08:48Z)

| script | exit code |
|---|---|
| `tests/v1_longpoll_changed.sh` | **0** |
| `tests/v2_longpoll_not_modified.sh` | **0** |
| `tests/v3_longpoll_concurrency.sh` | **0** |
| `tests/v4_longpoll_sequence.sh` | **0** |
| `tests/v5_longpoll_reset.sh` | **0** |
| `tests/v6_atomic_write_kill.sh` | **0** |

### Files changed in Phase B

- `server.ts`: bootId + versionByRoom + Waiter type + waitersByRoom Map;
  bumpAndNotify/notifyWaiters/settleWaiter; makeChanged/NotModified/Reset
  response helpers; parseWaitParam; longPoll handler; wired version bumps
  into 5 sites (HTTP PUT/DELETE state, WS set/del, /pages DELETE); wired
  long-poll into the `/pages/<key>/state` alias when `?wait=<sec>` present
- `tests/_lib.sh`: switched from `ln -s server.ts` to `cp server.ts` so
  `import.meta.dir` resolves to the rundir (state truly isolated); added
  `restart_server` for V5; switched `bun server.ts` invocation to use
  `exec` so $! captures the bun PID (no orphan processes)
- `tests/v1_longpoll_changed.sh`: long-poll wakes within 1s of a same-key PUT
- `tests/v2_longpoll_not_modified.sh`: idle wait=2 returns not_modified after ~2s
- `tests/v3_longpoll_concurrency.sh`: 100 concurrent polls, RSS bounded,
  no leak after drain
- `tests/v4_longpoll_sequence.sh`: orchestrated 3 PUTs, 3 changed responses,
  versions monotonic
- `tests/v5_longpoll_reset.sh`: server restart yields reset with state
  loaded from disk
- `tests/v6_atomic_write_kill.sh`: 50 parallel PUTs + SIGKILL → all .json
  files parse

### Blockers / open

- None for B. STOP per checkpoint 3; awaiting user review of
  `docs/phase-B-complete.md` before proceeding to C.

## Phase C — Envelope (descoped)

Not started. Plan says re-evaluate scope at C entry.

## Logs / history

- 2026-05-26T08:11Z — baseline commit `44e1c23` on `main`; switched to
  `readback-abc`
- 2026-05-26T08:24Z — A implementation + V1 green
- 2026-05-26T08:25Z — v_demo_smoke green
- 2026-05-26T08:28Z — Phase A committed (`1b3d437`)
- 2026-05-26T08:35Z — discovered _lib.sh isolation bug (`import.meta.dir`
  follows symlink), fixed by `cp`; cleaned ~50 polluted files from
  production `state/`
- 2026-05-26T08:42Z — discovered V3 `wait` (no args) blocked on bun server
  PID, fixed by tracking curl PIDs explicitly; discovered subshell-PID
  bug leaking orphan bun processes, fixed by `exec`
- 2026-05-26T08:48Z — full sequential V battery green, no orphans, no
  pollution
