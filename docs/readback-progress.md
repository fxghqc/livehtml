# Readback A+B+C — Progress

Branch: `readback-abc` (baseline `main` @ `44e1c23`).

## Current state

- **Phase A**: implemented, V1 + v_demo_smoke green, awaiting checkpoint review
- **Phase B**: not started
- **Phase C**: not started (will re-evaluate scope before entry)

## Phase A — Read-back 一等公民化

### Checklist

- [x] skill 三个 read-back cookbook (`skill/SKILL.md`)
  - Cookbook 1: read one page's state
  - Cookbook 2: aggregate across pages
  - Cookbook 3: debug "state isn't what I expected"
  - All cookbooks default to `-A "livehtml-agent-readback/1"` user-agent
- [x] `/pages/<key>/state` GET/PUT/DELETE alias (`server.ts`)
  - Implemented via shared `handleStateRoom(req, room)` helper; both routes
    `/state/<room>` and `/pages/<key>/state` go through the same code path,
    guaranteeing byte-level equivalence by construction
- [x] Alias equivalence test (`tests/v1_state_alias.sh`)
  - 7 sub-assertions covering both directions of PUT, DELETE semantics,
    invalid-body handling, and unknown-key behavior

### V script exit codes

| script | last run (UTC) | exit code |
|---|---|---|
| `tests/v1_state_alias.sh` | 2026-05-26T08:24:42Z | **0** |
| `tests/v_demo_smoke.sh` | 2026-05-26T08:25:10Z | **0** |
| `tests/v2_paired_trial.md` | n/a (protocol doc, manual subagent run) | — |

### Files changed in Phase A

- `server.ts`: extracted `handleStateRoom` helper; routed `/pages/<key>/state`
  to it before the existing `/pages/<key>` MinIO branch; refactored
  `/state/<room>` to use the same helper
- `skill/SKILL.md`: replaced "Read state from outside the browser" subsection
  with three cookbooks + user-agent convention
- `tests/_lib.sh`: shared helpers (random_port, start_server with isolated
  state dir, assert_eq, http wrapper)
- `tests/v1_state_alias.sh`: A.V1 alias equivalence
- `tests/v_demo_smoke.sh`: automated demo regression (WS hi/init/set/del +
  persistence + broadcast across 3 ws clients)
- `tests/v2_paired_trial.md`: A.V2 protocol (not automated; behavioral test)

### Blockers / open

- None for A. STOP per checkpoint 2; awaiting user review of
  `docs/phase-A-complete.md` before proceeding to B.

## Phase B — Long-poll

Not started.

## Phase C — Envelope (descoped)

Not started.

## Logs / history

- 2026-05-26T08:11Z — baseline commit `44e1c23` on `main`; switched to
  `readback-abc` (PROPOSAL方案 A approved by user)
- 2026-05-26T08:24Z — A implementation + V1 green
- 2026-05-26T08:25Z — v_demo_smoke green
