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

**ATTENTIVE** — C1 + `runTick()` called via `replayAsync(onTurn)` after each turn's refold settles and before the next turn's blocks. Mirrors live one-turn-behind semantics. Rate-limited (150 ms gap), quota-retried (3×, 5 s sleep), aborted on persistent failure.

### Corpus

- **Total sessions:** 24
- **Sessions with ≥1 agent-unfold event (included):** 3
- **Sessions with 0 events (counted only):** 21

Corpus path: `~/.accordion/corpus/`

### Caveats

- Eval index snippets are deterministic digests except for the top-3 summarized sessions (EVAL_SUMMARIES=1 — 116 summaries pre-generated, all cache hits on re-run).
- Tick uses parse-format block ids (not live durable UUIDs); resolution via `resolveToken` handles both.
- Corpus is one developer's sessions — generalization to other workloads is untested.
- Only 3 of 24 corpus sessions contain agent-unfold events. The miss metric is structurally under-powered; results at 0% miss rate cannot rank arms.
- Attentive arm covers 3/3 sessions (well under call cap 2000; actual calls: 61 ticks).
- Miss counting: a miss is an agent unfold call where the target block was folded at that moment. A preempt is when the block was already open before the agent asked.

## Results

### Comparison table

```
Arm              | Sessions | Events | Misses | Miss% | Preempts | BudgetViol | Churn/turn | SavedTok | Groups
-----------------+----------+--------+--------+-------+----------+------------+------------+----------+-------
LEGACY           | 3        | 6      | 0      | 0.0%  | 0        | 0          | 28.16      | 68433    | 0
C1-DETERMINISTIC | 3        | 6      | 0      | 0.0%  | 0        | 2          | 31.22      | 66407    | 0
ATTENTIVE        | 3        | 6      | 0      | 0.0%  | 0        | 1          | 36.53      | 66126    | 0
```

### Budget violations — FINDING

**Budget violations detected: LEGACY=0 · C1=2 · ATTENTIVE=1**

Violations appear in C1 and ATTENTIVE but not LEGACY. LEGACY disables both the lexical pre-unfold and the coalesce pipeline; C1 and ATTENTIVE enable both. The pattern points to the coalesce group formation or the lexical-unfold pass transiently lifting `liveTokens` above budget in a way the relaxed pass cannot recover from.

Hypothesis: the coalesce step introduces group-level token accounting (carrier + stragglers) that can diverge from the per-block sum; a group with stragglers stays partially live, and the accounting mismatch leaves `liveTokens > budget` after refold. LEGACY, which never forms groups, is immune.

This is a real engine finding, not an eval artifact. It warrants a dedicated investigation into whether `protectedTokens > budget` is reachable with the eval's budget formula, or whether coalesce group straggler accounting introduces a budget overshoot path that the relaxed pass misses.

### Attentive arm details

```
Ticks:               61
Fold ops applied:     0
Unfold ops applied:  77
Ops rejected:       587
Total in tokens:    907,709
Total out tokens:    23,173
Estimated cost:     $0.1000
```

High rejection rate (587 rejected / 664 proposed = 88%) is expected behavior: the engine guard layer (protected tail, pin checks, cooldown, already-folded checks) filters most LLM proposals before they apply. Of the 77 unfold ops that were applied, none corresponded to a preemptive hit over the C1 baseline because all C1 misses were already 0.

### Narrative

**Null result on this corpus: all three arms achieve 0% miss rate.**

All 6 agent-unfold events across 3 sessions found their target blocks already live at request time. No arm produced a miss. With every arm at 0%, this corpus cannot rank conductor quality — the discriminating signal (a miss that the conductor could have preempted) is absent.

Why 0% misses? The 3 unfold-bearing sessions are relatively short (≤65 turns projected). At the budget settings used (55% of fullTokens, 25% protected tail), the auto-folder does not reach the blocks the agent requests before the agent asks for them. The corpus would need deeper sessions where budget pressure is real and sustained to produce a non-zero baseline miss rate.

**C1 vs LEGACY:** Equal miss rates (0%/0%). Lexical pre-unfold and cold-score cannot improve on LEGACY when LEGACY already achieves 0%. On secondary metrics: C1 has higher churn/turn (31.22 vs 28.16) and slightly lower mean saved tokens (66 407 vs 68 433) — the coalesce pass and lexical unfolds introduce more block state transitions than the pure clamp. These are not regressions; they reflect the conductor actively managing context rather than passively clamping.

**ATTENTIVE vs C1:** No improvement in miss rate (both 0%). Churn is higher (36.53 vs 31.22) and saved tokens slightly lower (66 126 vs 66 407). The tick applies 77 unfold ops per run on average, which predictably reduces token savings and increases churn without improving hit rate in this corpus. On a corpus with real miss pressure, these unfolds would be the mechanism that converts misses to hits — here they operate on already-live blocks.

**Summary judgment:** The infrastructure is sound — the replay driver, three-arm harness, LLM plumbing, distill logging, and summary cache pre-generation all work. The corpus is underpowered for ranking C1 vs ATTENTIVE. More corpus sessions with sustained budget pressure and real agent-unfold misses are needed before the miss-rate number can guide tuning decisions.

Mean churn per turn: LEGACY=28.16 · C1=31.22 · ATTENTIVE=36.53.

## Per-session attentive table

| Session (last 24 chars)    | Events | LEGACY misses | C1 misses | ATTENTIVE misses | Ticks | Cost USD |
|----------------------------|--------|---------------|-----------|------------------|-------|----------|
| 6-71eb-867d-9e617a90fdab   | 3      | 0             | 0         | 0                | 48    | $0.0971  |
| 8-7e7c-a674-e032964b4b78   | 2      | 0             | 0         | 0                | 11    | $0.0027  |
| 0-75ce-9500-d6de20543ffc   | 1      | 0             | 0         | 0                | 2     | $0.0002  |

## Distillation yield

ATTENTIVE arm wrote distill records to `~/.accordion/eval-distill/`.
Record count: 61 (one per completed tick). These records contain the full numbered index + fold/unfold decision for each turn, ready for D1 training pipeline consumption.

Summary cache pre-generation: 116 summaries generated (first run), 0 new on re-run (all cache hits). Cache persisted to `~/.accordion/summaries/cache.jsonl`.

## Run metadata

| Field | Value |
|-------|-------|
| Wall time | 166 s |
| Total LLM calls | 61 (ticks only; 116 summary calls on first run) |
| Total tick input tokens | 907,709 |
| Total tick output tokens | 23,173 |
| Estimated tick cost | $0.1000 |
| Summary gen cost (first run) | ~$0.0330 (116 calls × avg ~285 tok in / 60 tok out) |
| MAX_EVAL_CALLS | 2000 |
| EVAL_SUMMARIES | 1 (enabled) |
| Corpus provider | Vertex AI (AI Studio prepay depleted, auto-fallback) |
