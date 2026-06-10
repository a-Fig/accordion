# Conductor Replay Evaluation

**Date:** 2026-06-10
**Eval version:** C3 Attentive Tick (ADR 0010)

## Methodology

Three arms replayed over the corpus at identical budget/protect settings:

| Setting | Formula |
|---------|---------|
| budget | clamp(round(0.55 × fullTokens), 8 000, 70 000) |
| protectTokens | min(20 000, round(0.25 × fullTokens)) |

**LEGACY** — budget clamp only. Lexical pre-unfold disabled (`HYSTERESIS.maxLexicalUnfoldsPerPass = 0`), coalesce disabled (`COALESCE_CONFIG.minRun = Number.MAX_SAFE_INTEGER`). Both are mutable exported config objects; patched in a try/finally so defaults are always restored.

**C1-DETERMINISTIC** — defaults on (lexical pre-unfold + coalesce). No LLM tick.

**ATTENTIVE** — C1 + `runTick()` called via `replayAsync(onTurn)` after each turn's refold settles and before the next turn's blocks. Mirrors live one-turn-behind semantics. Rate-limited (150ms gap), quota-retried (3×, 5s sleep), aborted on persistent failure.

### Corpus

- **Total sessions:** 24
- **Sessions with ≥1 agent-unfold event (included):** 3
- **Sessions with 0 events (counted only):** 21

Corpus path: `~/.accordion/corpus/`

### Caveats

- Eval index snippets are deterministic digests except for the top-4 summarized sessions (EVAL_SUMMARIES=1).
- Tick uses parse-format block ids (not live durable UUIDs); resolution via `resolveToken` handles both.
- Corpus is one developer's sessions — generalization to other workloads is untested.
- Attentive arm covers 3/3 sessions (call cap 2000).
- Miss counting: a miss is an agent unfold call where the target block was folded at that moment. A preempt is when the block was already open before the agent asked.

## Results

### Comparison table

```
Arm              | Sessions | Events | Misses | Miss% | Preempts | BudgetViol | Churn/turn | SavedTok | Groups
-----------------+----------+--------+--------+-------+----------+------------+------------+----------+-------
LEGACY           | 3        | 6      | 0      | 0.0%  | 0        | 0          | 28.16      | 68433    | 0     
C1-DETERMINISTIC | 3        | 6      | 0      | 0.0%  | 0        | 0          | 29.29      | 68970    | 0     
ATTENTIVE        | 3        | 6      | 0      | 0.0%  | 0        | 0          | 34.31      | 67973    | 0     
```

### Budget violations

All arms: 0 budget violations.

### Attentive arm details

  Ticks: 61
  Fold ops applied: 1
  Unfold ops applied: 118
  Ops rejected: 515
  Total in/out tokens: 909149 / 22872
  Estimated cost: $0.1001

### Narrative

ATTENTIVE and C1 show equivalent miss rates (0.0%). All 6 agent-unfold events across 3 sessions had their target blocks already live at request time — meaning the C1 lexical pre-unfold (or the budget clamp itself not folding the blocks yet at that turn) preempted every miss. With all arms at 0%, this corpus cannot distinguish conductor quality; a larger corpus with higher session depth is needed to observe meaningful miss rates.

Attentive ran 61 ticks across 3 sessions (515 ops rejected out of 634 proposed). The high rejection count reflects the engine's guard layer (protected tail, cooldowns, already-folded checks) filtering most LLM proposals — the model sees the index and proposes folds/unfolds, but the engine clamp and the C1 lexical pass already handle most cases deterministically, leaving little for the tick to act on with real effect.

C1 vs LEGACY: C1 does not improve miss rate over LEGACY (0.0% vs 0.0%); lexical signals in this corpus are weak.

Mean churn per turn: LEGACY=28.16 · C1=29.29 · ATTENTIVE=34.31.

## Per-session attentive table

| Session (last 20 chars) | Events | LEGACY misses | C1 misses | ATTENTIVE misses | Ticks | Cost USD |
|------------------------|--------|---------------|-----------|------------------|-------|----------|
| 6-71eb-867d-9e617a90fdab | 3 | 0 | 0 | 0 | 48 | $0.0970 |
| 8-7e7c-a674-e032964b4b78 | 2 | 0 | 0 | 0 | 11 | $0.0028 |
| 0-75ce-9500-d6de20543ffc | 1 | 0 | 0 | 0 | 2 | $0.0002 |

## Distillation yield

ATTENTIVE arm wrote distill records to `~/.accordion/eval-distill/`.
Approximate record count: 61 (one per completed tick).

## Run metadata

| Field | Value |
|-------|-------|
| Wall time | 171.0 s |
| Total LLM calls | 61 |
| Total input tokens | 909,149 |
| Total output tokens | 22,872 |
| Estimated cost | $0.1001 |
| MAX_EVAL_CALLS | 2000 |
| EVAL_SUMMARIES | 1 (enabled) |
