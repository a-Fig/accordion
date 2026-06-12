# Conductor Model

A research-backed design for evolving the Conductor from a hand-tuned heuristic
engine into a small, locally-runnable learned system purpose-built for context
management.

Read [VISION.md](VISION.md) for the product north star, [CONDUCTOR.md](CONDUCTOR.md)
for the current heuristic engine (scoring formula, calibrated fold target, fold
levels), and [CLAUDE.md](CLAUDE.md) for how to work in the code. This document is
the *what to build and why* for the next generation of the Conductor — it is a
design + roadmap, not an implementation. Each phase lands behind an injectable
dependency with per-decision deterministic fallback. Learned components earn
authority only after shadow validation.

## Framing: from tuned constants to a learned model

Today the Conductor's "intelligence" lives in hand-tuned constants in
[src/conductor.ts](src/conductor.ts): the `FOLD_RANK` durable-value order, the
per-prompt dynamic weights (`kind` / `keyword` / `recency`), the self-calibrated
`FOLD_TARGET_*` band, and the `UNFOLD_*` relevance floors. These approximate three
deeper judgments that a learned system could make directly:

1. **How much context should the agent actually have** for this task and this
   target model (the budget).
2. **Which specific blocks to keep vs. fold**, and to what depth (the policy).
3. **How to fold without losing what matters** (value-preserving compression).

The vision is a **dedicated small learned system** — distilled from a strong teacher
into tiny local students — that makes these judgments better than the constants do,
while running locally with no external dependency and large efficiency gains.

Three principles from VISION/CLAUDE shape every phase:

1. **Context is a view, not a store.** Learned components decide *what the view
   shows*; they never gain authority to destroy underlying data. Originals are
   never mutated; folds stay instant and reversible.
2. **Deterministic fallback is per-decision, not global.** Every learned output
   carries a confidence signal; low-confidence decisions fall back to the heuristic
   *for that block or turn only*. The model is an injectable upgrade, never a hard
   dependency — and never an all-or-nothing switch. Provider absence, errors, and
   latency-budget overruns degrade the same way `embeddingProvider` /
   `summaryProvider` already do.
3. **Shadow before authority.** No learned component makes a live decision until it
   has run silently alongside the heuristic, with disagreements and outcomes logged.
   Shadow mode is both the safety mechanism and the training-data factory (`CONDUCTOR_SHADOW=1`).

```mermaid
flowchart TD
    transcript[Parsed blocks + prompt] --> stable
    subgraph stable [Phase 0a: cache-stable assembly]
        sys["static skill -> system message"]
        tail["dynamic appendix -> just before current turn"]
    end
    stable --> warm
    subgraph warm [async warm-up — warmConductorModel()]
        budget["Budget Oracle\n(quantile MLP / GBM)\nquality x cachehit / cost"]
        policy["Fold Policy\n(cross-encoder -> time-to-next-use)"]
        compress["Compressor\n(LoRA on small base, textual-only)"]
    end
    budget -->|"target multiplier (clamped)"| run["runConductor() (sync, cache reads only)"]
    policy -->|"re-use distance -> fold level"| run
    run -->|fold| compress
    compress -->|fidelity-gated digest| memory["Richer AccordionState\nsalience metadata"]
    run --> assembled[Assembled model view]
    run -.per-decision deterministic fallback.-> assembled
    policy -.shadow logs.-> traces[(Labeled traces)]
    budget -.shadow logs.-> traces
```

## Phase 0a — Cache-stability quick win (pre-ML, ship first)

This is a measurement prerequisite, not an afterthought. Before any model can be
trained or evaluated, the assembled context must be **cache-stable**, because cost
and quality measurements are meaningless while the prefix is being poisoned every
turn.

Today [src/accordion.ts](src/accordion.ts) (L968-989) concatenates the **static**
`ACCORDION_AGENT_SKILL` instruction block with a **dynamic** appendix (the
folded-turns list plus `Conductor target: N%`) and `unshift`es the whole string into
the **first assistant message** on every turn:

```ts
const appendix = `Currently folded: turns ${formatTurnList(foldedTurns)}. Conductor target: ${Math.round(output.foldTarget * 100)}%.`;
const skillText = `${ACCORDION_AGENT_SKILL}\n\n${appendix}`;
for (const msg of finalMessages) {
	if (msg.role === "assistant" && Array.isArray(msg.content)) {
		msg.content.unshift({ type: "text", text: skillText });
		break;
	}
}
```

Because the dynamic appendix changes every turn (the folded-turns set and the
calibrated target both move) and is glued to the front of an early message, it
mutates the cached prefix and produces the observed **~30% cache misses on
DeepSeek**. The static skill text — which never changes — is dragged along with it,
so even the stable part of the injection invalidates cache.

**Fix (no model needed, immediate ROI):**

- Move the **static** `ACCORDION_AGENT_SKILL` text to the **system message**, where
  it becomes part of a stable prefix that is cached once and reused every turn.
- Move the **dynamic** appendix (`Currently folded: …`, `Conductor target: N%`) to
  **just before the current turn** (the tail of the assembled view), where its churn
  is downstream of the cached prefix and cannot poison it.

Why this is a hard prerequisite for the Budget Oracle: you cannot fit an honest
cost-vs-quality curve while artificially leaking cache misses — the cost axis would
be dominated by self-inflicted invalidation rather than the real cost of context
size. A smaller, cache-stable context is *both* cheaper (more cache hits) and
higher-performing (less prefix churn, tighter effective context), so Phase 0a
de-risks every later phase and delivers value on its own.

**Exit:** assembled prefix is byte-stable across turns when only fold state changes;
regression test in `conductor-improvements.test.ts`.

## Phase 0b — Data + shadow harness

Before any learned component earns decision authority, build the infrastructure that
feeds training and validates safety.

**Trace extraction pipeline:**

- `state.manualChanges` — recall/unfold/pin events with turn index and block id.
- Conductor `FoldDecision` stream — heuristic decisions attributed to `conductor`.
- [src/benchmark-niah.ts](src/benchmark-niah.ts) fixtures — known needles for holdout.
- [src/compare-compact.ts](src/compare-compact.ts) budget sweeps — quality-knee targets.

**Shadow plumbing:**

- Invoke `budgetOracle` / `foldPolicyProvider` / `compressionProvider` on every turn
  when `CONDUCTOR_SHADOW=1`.
- Log `(heuristic_decision, model_decision, outcome)` triples; disagreement cases are
  the highest-value training examples.
- Providers are invoked and logged but **never consulted for live decisions** in
  shadow mode.

**Exit:** labeled dataset v0 exists; shadow logs flowing from real or replayed sessions.

## The three jobs

### Job 1 — Budget Oracle

Predict the *ideal* context budget for the (target model, task, conversation) instead
of a fixed `DEFAULT_BUDGET_TOKENS = 150_000`. The premise is well-established:
**effective context is much smaller than advertised**, and quality-per-token curves
have a knee rather than monotonically improving with more tokens.

- *Lost in the Middle* (Liu et al., 2023) — accuracy degrades when relevant
  information sits in the middle of a long context.
- *RULER* (Hsieh et al., 2024) — measured effective context lengths fall far short
  of nominal window sizes.
- *Same Task, More Tokens* (Levy et al.) — more context can *hurt* once past the
  model's sweet spot.

**Dual objective (stated explicitly).** The oracle does not optimize quality alone.
A budget that is "best for quality" can be cost-terrible. The oracle maximizes a
**joint objective**:

```
score(B) = quality(B) × cache_hit_rate(B) / cost(B)
```

A smaller, more stable prefix yields more cache hits and lower cost, so the optimum
budget trades a little raw quality headroom for large cost wins. Phase 0a is what
makes `cache_hit_rate(B)` measurable in the first place.

**Honest data constraint.** [src/compare-compact.ts](src/compare-compact.ts) budget
sweeps yield scenario×budget cells (default budgets `[1500, 2500, 4000]`), not
thousands of examples. A regressor predicting raw `B*` from this would overfit and
could emit dangerous values. Design accordingly:

- **Form:** quantile regression (tiny MLP or GBM) over features — target model id,
  task-type signal, transcript stats (turn count, kind mix, token distribution,
  retrieval-difficulty proxy) — predicting the **location of the quality knee** as a
  **multiplier on the existing calibrated target**, not an absolute token count.
- **Safety by construction:** output is clamped into the existing
  `calibrateFoldTarget()` band `[FOLD_TARGET_MIN, FOLD_TARGET_MAX]` = `[0.60, 0.92]`
  ([src/conductor.ts](src/conductor.ts) L221-223). Worst case, a bad prediction
  degrades to today's behavior, never outside the band.
- **Cost:** microseconds locally; trivially off the critical path.

### Job 2 — Learned Fold Policy

Replace the hand-weighted `kind·w + keyword·w + recency·w` score with a learned
per-block decision. Three corrections to the naive "keep-probability" framing:

**Target is time-to-next-use, not binary keep.** Accordion has *graduated fold
levels* (L0–L3); a binary keep-score wastes that structure. The policy predicts
**expected re-use distance** (in turns, censored), which maps directly:

| Predicted re-use | Fold level |
|---|---|
| Needed imminently | L0 full |
| Needed soon | L1 trim |
| Plausibly later | L2 digest |
| Likely never | L3 group member |

Fold level becomes a *prediction*, not a heuristic rank. Turn-distance between a
fold and a subsequent recall/unfold event in `state.manualChanges` provides the
regression target directly.

**Labels are positive-unlabeled (PU), not positive-negative.** `accordion_recall` /
`accordion_unfold` events and human unfolds are confirmed positives ("this block
*was* needed"). But a never-recalled block is *not* a confirmed negative — it may
simply never have been tested. Train with PU-learning techniques (e.g. reweighted
risk estimation, spy-based negative mining) or at minimum disciplined negative
sampling from deep, old, never-referenced blocks; otherwise the policy learns
"recently recalled = important" tautologies. See the Training labels section for how
NIAH holdouts catch the silent failures PU labels miss.

**Selection is set-level, not pointwise.** Two blocks carrying the same fact both
score high; the budget only needs one. Add an MMR-style redundancy penalty using the
**already-computed** all-MiniLM-L6-v2 embeddings in `state.embeddingCache` —
submodular selection in spirit, nearly free in practice.

**Named feature: agent attention tracking.** What the agent *quoted or cited in its
last N assistant responses* is a stronger relevance signal than embedding similarity,
and it is cheap to extract — scan recent assistant message text for matches against
block content (exact value matches, path/identifier mentions, quoted snippets). If
the agent has been actively referencing a block, that block is hot regardless of
cosine score. Feed this as an input feature to the scorer. The attention-salience
literature (*H2O* — Zhang et al.; SnapKV; TOVA) is the intuition for block-level
eviction on a frozen API target, but the implementation is a text-match feature, not
KV introspection.

**Form:** distilled cross-encoder (MiniLM-class, ~22M params) scoring
(block, current-frontier) pairs.

**Runtime discipline:** scores cached by block content hash via `textHash()` — mirror
the existing `warmEmbeddings()` pattern ([src/conductor.ts](src/conductor.ts)
L1092-1156). Only new/changed blocks are scored per turn; steady-state cost is
O(new blocks), not O(transcript). This is what makes the `<100ms` scoring budget
achievable in practice.

The learned score plugs into `relevance()` / the scoring path. The oracle and policy
both run in `warmConductorModel()` parallel to `warmEmbeddings()`; `runConductor()`
stays synchronous and reads caches only.

### Job 3 — Value-preserving Compression

When the Conductor folds, it should compress *faithfully* so high-value facts survive
— and remain recallable.

The current deterministic digest + salience suffix (the `paths / commands / errors /
exact_values / decisions` categories described in [CONDUCTOR.md](CONDUCTOR.md)) is
the floor. The upgrade is a fine-tuned extractive+abstractive digester trained to
**maximize downstream answer recall** — i.e., trained against "can a model still
answer the future question from this digest?" rather than against summary-likeness.

**Critical scoping correction:** *Gisting* (Mu et al.), *In-Context Autoencoder*, and
*AutoCompressor* compress into **soft tokens injected at the embedding layer** —
they require controlling the target model. Accordion's downstream consumer is a
**frozen API model**. These papers are cited as *related work demonstrating
compressibility*, explicitly **not** as the design basis. The design space is
**textual compression only**:

- *LLMLingua / LongLLMLingua* (Jiang et al., 2023) — perplexity-based token pruning.
- *Selective Context* (Li et al., 2023) — drop low-information spans.
- Fine-tuned extractive+abstractive textual digests.

**Fidelity gate:** a compressor can hallucinate facts into the digest — and a
hallucinated fact in *persistent salience metadata* is worse than a lost one,
because it gets recalled with confidence. Every digest claim must pass a grounding
check against the source block (lightweight NLI entailment, or string-grounded
extraction for `exact_values` / `paths` / `commands`). Digests failing the gate fall
back to the current deterministic digest.

The "memory" half of this job has an architectural tension with the view-not-store
invariant and is addressed in its own section below.

## Fact memory vs. the "view, not store" invariant

The naive framing of a "persistent fact memory" quietly **departs from a core
invariant**. The system today is stateless in the sense that matters:
context is a view, originals are untouched, and there is — in VISION.md's words —
*"no database or search index to maintain."* A fact store that outlives the context
window is a genuine architectural change, so the design must take an explicit
position rather than smuggling one in.

- **Default (recommended): richer `AccordionState` salience metadata.** Grow the
  existing salience categories (`paths / commands / errors / exact_values /
  decisions`) into structured, recallable metadata carried *within* `AccordionState`
  — which already persists as custom session entries and is already "view"
  infrastructure (see the State section of [CONDUCTOR.md](CONDUCTOR.md)). The
  compressor's fidelity-gated extraction output feeds this metadata. This keeps the
  invariant intact: nothing new outlives the session view, and we are only carrying
  richer derived metadata alongside the existing fold levels and caches. Group
  folding can preserve the union of member salience so a fact survives even when its
  block is collapsed into a group digest. Tiered-memory framing per *MemGPT / Letta*
  (Packer et al.) applies to how salience is organized, not as a mandate for an
  external database.

- **Alternative (explicitly flagged as an invariant relaxation): external persistent
  store.** A MemGPT-style store that survives group folding *and* session boundaries.
  If this is ever chosen, Phase 3 **relaxes the stateless invariant**, and the
  implications must be owned: a store to build, migrate, and garbage-collect; a new
  source of truth that can **drift from the originals**; and new failure modes
  (stale or conflicting memory contradicting the real transcript). This is **not**
  chosen by default and should only be adopted with eyes open.

## Training labels: PU data + holdout

Using `accordion_recall` / `accordion_unfold` and human unfolds (recorded in
`state.manualChanges`) as positive labels is correct, but the label space is
**positive-unlabeled (PU)**, not positive-negative:

- **Confirmed positives:** recall/unfold events and human unfolds mark blocks that
  *were* needed. Turn-distance between fold and recall provides the time-to-next-use
  regression target directly.
- **Silent failure mode (selection bias):** PU labels only observe blocks the agent
  *knew* it was missing and could ask for. Blocks the agent needed but never
  requested — because it did not know they existed, or did not realize they had been
  folded — are invisible to this signal.
- **Never-recalled ≠ confirmed negative.** Train with PU techniques or disciplined
  negative sampling from deep, old, never-referenced blocks.

**Holdout mitigation (already available):** NIAH-style evals in
[src/benchmark-niah.ts](src/benchmark-niah.ts) inject known needles and test whether
the policy *keeps* facts the agent never explicitly reached for. Because the
needle's ground-truth importance is known by construction, the benchmark catches
exactly the silent failures that behavioral labels miss. Use NIAH needles as a
**held-out sanity check** and a **low-weight training slice** — not the training
backbone, or the model learns to detect needle-shaped text rather than real salience.

## Model architecture decision + latency budget

**Right-size per job; consolidate only if it pays.**

- **Budget oracle:** standalone MLP/GBM — putting this on a 0.5B decoder would be
  absurd.
- **Fold policy:** MiniLM-class cross-encoder (~22M params); fastest path to shadow
  mode; shares the embedding ecosystem already in the repo.
- **Compressor:** small decoder (candidate: Qwen2.5-0.5B/1.5B) with a LoRA adapter,
  served locally via Ollama / llama.cpp / `@huggingface/transformers`.

"Custom AI that runs locally with big gains" means **distillation from a strong
teacher (e.g. Claude) into tiny local students**, never from-scratch pretraining.
Phase 4 consolidation onto one shared LoRA'd base is **optional** — the three jobs
have very different latency/compute profiles, and a shared base is only worth it if
it simplifies serving without violating the per-job SLOs.

**The latency budget drives model choice, not the other way around.** The `context`
hook is on the critical path. Explicit targets:

- **Full fold-policy scoring pass must complete in `<100ms` on CPU for a ~300-block
  session** (~0.3ms/block). A 0.5-1.5B *generative* decoder scoring per block
  (~200ms/block → ~60s for 300 blocks) **violates this by ~600x** and is disqualified
  for the per-block path.
- Therefore the per-block scorer is a **small cross-encoder / distilled regressor**
  (batchable, embedding-style forward pass), not a generative decode. Generative
  models are reserved for **off-critical-path** jobs: compression digests and
  offline teacher labeling.
- **Block-hash score cache** (keyed by `textHash(block.text)`, same hash as
  embeddings) is mandatory, not optional — it is the mechanism that makes the
  `<100ms` budget achievable in steady state.
- `warmConductorModel()` (oracle + batched policy scoring) is the only async
  boundary with a soft budget of **~500ms**, mirroring `warmEmbeddings()`.
  `runConductor()` itself stays synchronous and cache-reading only.

Per-job latency SLOs:

| Job | SLO |
|---|---|
| Budget oracle | < 1 ms |
| Fold policy (incremental, cached) | p95 within `warmEmbeddings()` envelope |
| Compressor | async at fold time, off sync path |

## Training data (reuse what exists — with eyes open)

| Source | Role |
|---|---|
| `state.manualChanges` recall/unfold + agent tools | PU positives; turn-distance → time-to-next-use |
| NIAH needles ([src/benchmark-niah.ts](src/benchmark-niah.ts)) | Holdout counterfactual + **low-weight** training slice (not backbone) |
| `compare-compact` budget sweeps ([src/compare-compact.ts](src/compare-compact.ts)) | Knee-location targets for oracle (small-N → quantile + clamp) |
| Shadow traces | Flywheel: `(heuristic, model, outcome)` triples; disagreements = highest-value examples |
| Teacher distillation | **Frozen, versioned labeling rubric** + periodic duplicate-labeling for self-agreement; rubric drift poisons cross-batch comparisons |

## Integration surface + implementation highlights

The model lands behind injectable dependencies on `ConductorDependencies`
([src/conductor.ts](src/conductor.ts) ~L177), mirroring `embeddingProvider` /
`summaryProvider`. Each provider returns `{ value, confidence }`; the Conductor
applies a per-decision confidence gate (threshold via e.g.
`ACCORDION_MODEL_CONFIDENCE_FLOOR`) and falls back to the deterministic path below
threshold for that block/turn only.

- `runConductor()` — ~L1254 (stays sync; reads caches only).
- `relevance()` — ~L1162 (learned score + MMR redundancy penalty plug in here).
- `calibrateFoldTarget()` — ~L404 (budget oracle multiplies into target, clamped to band).
- New `warmConductorModel()` alongside `warmEmbeddings()`; fold-policy score cache
  keyed by `textHash(block.text)`.
- `CONDUCTOR_SHADOW=1`: providers invoked and logged, never consulted for decisions.

**Per-phase implementation:**

- **Phase 0a (cache):** edit [src/accordion.ts](src/accordion.ts) L968-989 — split
  `skillText` into system-message insertion (static `ACCORDION_AGENT_SKILL`) and
  pre-current-turn insertion (dynamic appendix). Regression test asserting prefix is
  byte-stable across turns when only fold state changes.
- **Phase 0b (data + shadow):** trace extraction pipeline; shadow logging plumbing;
  labeled dataset v0.
- **Phase 1 (oracle):** add `budgetOracle?`; call in `warmConductorModel()`, feed
  clamped multiplier into `calibrateFoldTarget()`. Shadow → live. Deterministic
  fallback = current fixed budget / calibrated band.
- **Phase 2 (policy):** add `foldPolicyProvider?`; learned time-to-next-use score
  plugs into `relevance()` and unit scoring. Agent-attention feature extraction.
  Block-hash score cache. Shadow A/B vs heuristic on proof gates before authority.
- **Phase 3 (compression):** add `compressionProvider?` with fidelity gate; extend
  salience metadata in `AccordionState`. Off hot path (digests already async, cached
  by content hash).

## Evaluation protocol

Proof gates in [package.json](package.json) (`proof:judge`, `proof:semantic`,
`compare:compact`) are the acceptance bar, with the comparison protocol pinned down:

- **Paired A/B:** identical transcripts and budgets through heuristic vs learned
  Conductor; per-conversation paired scores; significance via bootstrap over
  **conversations** (not over questions — questions are correlated within a session).
- **Hard constraints (any violation = fail):** zero budget violations
  (`compare-compact` tracks `accordionBudgetViolations`); zero fidelity-gate escapes
  in persisted digests.
- **Quality bar:** learned ≥ heuristic on judge score **and** ≥ compact baseline, at
  equal or lower token spend.
- **Latency SLOs:** per-job targets in the architecture section above.
- **Counterfactual honesty:** offline replay cannot observe what *would* have
  happened under different folds. Judge-scored replay
  ([src/compare-compact.ts](src/compare-compact.ts) `--answers` mode) is the accepted
  proxy and is named as such — not a perfect counterfactual, but the best available
  signal and the one the proof gates already use.

NIAH holdout must show **no silent-fold regressions** relative to the heuristic
Conductor.

## Phased roadmap

- **Phase 0a — Cache stability (pre-ML).** Split static/dynamic skill injection.
  Prerequisite for honest measurement; immediate cost + quality ROI.
  *Exit: prefix byte-stable; regression test green.*

- **Phase 0b — Data + shadow harness.** Trace extraction; shadow logging;
  `CONDUCTOR_SHADOW=1` plumbing.
  *Exit: labeled dataset v0 + shadow logs flowing.*

- **Phase 1 — Budget Oracle.** Quantile model behind `budgetOracle`; shadow → live
  with clamping to `[0.60, 0.92]`. Cheapest, highest ROI. Joint
  `quality × cache_hit_rate / cost` objective.
  *Exit: beats fixed target on `compare:compact`, zero budget violations.*

- **Phase 2 — Fold Policy.** Cross-encoder behind `foldPolicyProvider`;
  time-to-next-use → fold levels; PU labels; MMR redundancy; agent-attention
  features. Shadow A/B vs heuristic on proof gates before authority.
  *Exit: paired-bootstrap win on `proof:judge`; NIAH holdout clean.*

- **Phase 3 — Compression + salience metadata.** LoRA compressor behind
  `compressionProvider` with fidelity gate; richer `AccordionState` salience
  metadata (default). External store only if invariant relaxation explicitly accepted.
  *Exit: downstream answer-recall ≥ deterministic digest; zero fidelity escapes.*

- **Phase 4 (optional) — Consolidation.** Shared LoRA base + unified local serving,
  only if per-job SLOs survive it.
  *Exit: end-to-end latency budget confirmed.*

## Out of scope / risks

- **No from-scratch pretraining** — distillation / LoRA only.
- **No soft-token compression** (gisting / ICAE / AutoCompressor) while the target
  is a frozen API model; revisit only if a local target model becomes first-class.
- **Deterministic heuristic path remains permanent per-decision fallback;** learned
  components opt-in via deps/env.
- **Latency:** per-block generative scoring is disqualified by the `<100ms` budget;
  score caching is mandatory; warm-up stays off the sync critical path.
- **PU bias + rubric drift** are the two training failure modes most likely to
  produce a model that *looks* better in training and loses on proof gates — both
  have named mitigations above.
- **Phase 3 external memory (if ever chosen)** relaxes the stateless "view, not
  store" invariant — flagged and owned, never assumed.
