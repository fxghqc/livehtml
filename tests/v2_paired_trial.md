# A.V2 — paired trial (subagent A/B test)

Per `docs/readback-plan.md`:

> sequential，不必 20×2：先各跑 6 次，若 `new ≥5/6 且 old ≤1/6` 立刻停；
> 不清就扩到 10；只有 stakeholder 要严谨量化才上 20。
> 用脚本写 ground truth，不让 agent 自己模拟。
> 评分二元化：①是否主动 read-back ②输出 vs ground truth 字段级 diff ③是否基于读回 state 继续下一步。

This document is the protocol. It is **not** an automated script because each
trial spawns a real subagent (LLM call), which is cost- and time-bound and
needs a human to start and judge. Phase-A completion does **not** require V2
to run — V1 (alias equivalence) + v_demo_smoke (plumbing) cover the
functional correctness. V2 is a behavioral test of whether the new skill
cookbooks change agent behavior; it can run any time after merge.

## When to run

- Before merging `readback-abc` back to `main` if stakeholder asks for proof
- As a one-off sanity check after a SKILL.md edit that meaningfully changes
  the read-back cookbooks

## Setup

1. Start a fresh livehtml instance with empty state.
2. Have two SKILL.md variants on disk:
   - **OLD**: pre-readback SKILL.md (the version from `main` baseline)
   - **NEW**: post-A SKILL.md (the version on `readback-abc`)
3. Prepare a fixed task prompt that requires multi-turn agent reasoning, where
   step 2 logically needs to know what the user wrote in step 1.
   Example: "Generate an HTML feedback form for the team's lunch poll, PUT
   it to /pages/lunch-poll, and once 3 people have voted, summarise the
   results."
4. Prepare a ground-truth state — a fixed JSON payload to PUT into
   `/state/pages/lunch-poll` simulating user input, e.g.
   `{"choice-1":true,"choice-3":true,"note":"please more vegan options"}`.
5. The grading script (below) inspects server access log for read-back calls,
   diffs the subagent's final report against ground truth, and emits 0/1
   scores on the three axes.

## Procedure (sequential)

Run 6 trials with OLD SKILL.md, 6 trials with NEW SKILL.md, randomly interleaved.
For each trial:

1. Wipe `state/`, restart server, install the variant SKILL.md
2. Launch a fresh subagent with the fixed task prompt
3. After the agent claims completion, run grader:
   - **A. did it read back?** = 1 iff access log shows GET to either
     `/pages/lunch-poll/state` or `/state/pages/lunch-poll` from the agent
     (filter by user-agent `livehtml-agent-readback/1` if NEW; any GET if OLD)
   - **B. ground-truth recall** = 1 iff the agent's final report mentions all
     ground-truth fields (substring match per key/value, case-insensitive)
   - **C. acted on it** = 1 iff the agent's final report quotes back at least
     one user-provided value (e.g. "more vegan options")
4. Record per-trial `{variant, A, B, C, raw_log_path}` in
   `tests/v2_trials.jsonl`

## Stop conditions

After every 2 trials per variant (4 total), check:

- If NEW has `A ≥ 5/6` and OLD has `A ≤ 1/6` after 6 each → **stop, pass**
- If both variants score similarly → extend to 10 each; if still flat, **stop,
  ship without claiming behavioral improvement** (skill change may need rework)
- If NEW shows regression vs OLD on any axis → **stop, investigate**

## Grader sketch

```bash
# Pseudo-grader — implement per trial run
ACCESS_LOG=$1
AGENT_REPORT=$2
GROUND_TRUTH=$3  # json file

A=$(grep -E 'GET (/state/pages/lunch-poll|/pages/lunch-poll/state)' "$ACCESS_LOG" | wc -l)
A=$(( A > 0 ? 1 : 0 ))

# B: each ground-truth value must appear in the report
B=1
for v in $(jq -r '.. | strings, numbers, booleans | tostring' "$GROUND_TRUTH" | sort -u); do
  grep -qiF "$v" "$AGENT_REPORT" || { B=0; break; }
done

# C: agent quotes back at least one user-provided string
C=0
for v in $(jq -r 'to_entries[] | select(.value|type=="string") | .value' "$GROUND_TRUTH"); do
  if grep -qiF "$v" "$AGENT_REPORT"; then C=1; break; fi
done

echo "{\"A\":$A,\"B\":$B,\"C\":$C}"
```

## Why this isn't a phase-A blocker

Phase A's PR checklist explicitly lists: skill cookbooks, alias endpoint,
equivalence test. All three are verifiable without running V2. V2 is the
**leading indicator** that the cookbook actually changes agent behavior —
useful for stakeholder confidence and as a regression signal, but not part
of "did we build the thing correctly".
