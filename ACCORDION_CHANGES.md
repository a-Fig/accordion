# Accordion Changes: Salience-Preserving Digest + Semantic Relevance

**Audience:** Technical teammates who need to understand, explain, and maintain these changes.  
**Prerequisites:** Basic familiarity with LLM context windows and how Accordion works (see README).

---

## 1. What Accordion Does

Accordion manages an agent's context window by "folding" old conversation blocks into short summaries (called *digests*) when the session grows too large to fit in the model's token budget. The original messages are never deleted — Accordion only substitutes shorter text when assembling the outgoing context. If a block becomes relevant again, it can be unfolded back to full.

---

## 2. The Two Problems

### The Running Example

A tool call logged a configuration value during the session:

```
Configuration log output:
The emergency rollback passphrase is: TANGERINE-WHISPER-9
```

Later, under token budget pressure, this block was folded.

---

### Problem A — Fact Loss on Fold (Stage 1)

**What happened:** When a block was folded, the old digest looked only at the *first non-empty line* of the block text:

```typescript
// BEFORE — peeked only the first line:
const peek = firstLine(block.text, 60);
return `${name} -> ${tag}, ~${block.tokens} tok${peek ? " - " + peek : ""}`;
```

For the example block, the first line is `"Configuration log output:"` — the label. The actual value (`TANGERINE-WHISPER-9`) was on line 2 and got **silently discarded**. The folded digest was:

```
bash -> 2 lines, ~25 tok - Configuration log output:
```

The passphrase was gone from the model's view.

---

### Problem B — Literal Word Matching for Recall (Stage 2)

**What happened:** When the user asked *"Remind me of the secret we need to revert the deployment,"* Accordion decided whether to un-fold the block by counting how many words the question and the stored text share. This is the *keyword overlap* measure:

```typescript
// BEFORE — literal shared-word fraction:
export function keywordOverlap(blockText, prompt) {
    const promptTokens = new Set(tokenizeForRelevance(prompt));
    if (promptTokens.size === 0) return 0;
    const blockTokens = new Set(tokenizeForRelevance(blockText));
    let shared = 0;
    for (const token of promptTokens) if (blockTokens.has(token)) shared++;
    return shared / promptTokens.size;
}
```

The probe ("remind … secret … revert … deployment") and the stored text ("emergency … rollback … passphrase … TANGERINE-WHISPER-9") share **zero** tokens after stopword removal. Overlap = 0. The conductor had no signal to rescue the folded block, even when budget permitted.

There was also a brittle absolute threshold: a block was only proactively unfolded if its relevance score crossed a hard-coded cutoff of 0.50 (keyword path) or 0.60 (planned embedding path). Since the realistic probe scored 0, it never fired.

---

## 3. The Two Fixes

### Stage 1 — Salience-Preserving Digest

**Plain language:** Instead of just reading the first line, the digest now scans the *entire block text* looking for tokens that carry high information density.

**What it scans for, in priority order:**
1. SCREAMING-CASE hyphenated identifiers: `TANGERINE-WHISPER-9`, `AUTH-TOKEN`, `PROD-ENV`
2. Key=value pairs: `passphrase: TANGERINE-WHISPER-9`, `version=3.1.4`
3. Filenames with extensions: `app.log`, `config.yaml`
4. Version and hex literals: `v2.1.0`, `0xdeadbeef`
5. Error markers: `error: connection refused`, `panic: nil pointer`

Results are deduplicated, capped at 5 items / 120 characters, and joined with ` · `.

**Before → After:**
```
BEFORE:  bash -> 2 lines, ~25 tok - Configuration log output:
AFTER:   bash -> 2 lines, ~25 tok - TANGERINE-WHISPER-9
```

No model required. The key survives folding deterministically.

**Files changed:** `src/conductor.ts` (`salienceTokens()` helper + `deterministicDigest()` tool_result and text branches), `app/src/lib/engine/digest.ts` (mirror — same logic for the UI).

---

### Stage 2 — Semantic Relevance + Relative-Outlier Unfold Rule

#### Step 1: Replace word-counting with meaning-similarity

**Plain language:** Instead of counting shared words, Accordion now converts each block and the incoming prompt into a *embedding vector* — a list of ~384 numbers that encodes the meaning of the text. Two pieces of text that *mean* similar things (even with completely different words) will have vectors that point in roughly the same direction. The similarity is measured as *cosine similarity*: 1.0 = identical meaning, 0.0 = unrelated.

**The embedding model:** `Xenova/all-MiniLM-L6-v2`, running locally via `@huggingface/transformers`. 384-dimensional, 256-token input cap. No network call at inference time (model downloads once to local cache).

**The warm-up pattern:** `runConductor()` is synchronous (important for the pi extension's event loop). Embeddings are pre-computed in a separate async step before calling the conductor:

```typescript
// Before calling runConductor():
await warmEmbeddings(blocks, incomingPrompt, embeddingProvider, state);
// state.embeddingCache now holds all vectors, keyed by content hash.

// Inside runConductor() — synchronous read only:
relevance(blockText, promptText, state)  // → cosine if cached, else keyword fallback
```

The cache persists across turns so each text is embedded only once.

**Before → After (relevance scores for the running example):**

| Probe type | Word-overlap | Cosine (embedding) |
|---|---|---|
| Direct ("what is the emergency rollback passphrase?") | 0.60 | 0.72 |
| Realistic ("remind me of the secret we need to revert the deployment") | **0.00** | **0.40** |
| Adversarial ("a critical incident occurred, what code do I enter?") | **0.00** | **0.26** |

The realistic probe correctly scores higher than the adversarial one despite both having zero word overlap with the needle.

#### Step 2: Replace absolute threshold with a relative-outlier rule

**The problem with absolute thresholds:** A fixed cutoff like 0.60 doesn't generalize. Cosine values shift with prompt phrasing and haystack composition. The realistic probe hits 0.40 — a clear signal above background — but never clears 0.60. The adversarial probe hits 0.26, indistinguishable from a false positive under an absolute rule.

**The relative-outlier rule (what's deployed now):** A folded block is an unfold candidate if and only if:

```
relevance >= median(relevances of all folded blocks) + MARGIN
AND
relevance >= FLOOR
```

With `MARGIN = 0.08`, `FLOOR = 0.30` (cosine path), `FLOOR = 0.50` (keyword fallback).

**Why this works for the running example:**
- Filler blocks (mundane dev logs): cosine ≈ 0.25, median ≈ 0.25
- Needle (realistic probe): cosine = 0.40
- Test: 0.40 ≥ 0.25 + 0.08 = 0.33 ✓ AND 0.40 ≥ 0.30 ✓ → **rescued**
- Adversarial probe: 0.26 ≥ 0.33? ✗ AND 0.26 ≥ 0.30? ✗ → **blocked**

The relative component ("above the pack") fires on genuine semantic matches. The absolute floor prevents the rule from firing when all relevance values are uniformly low (e.g., a completely off-topic prompt).

**Budget guard (unchanged):** The unfolded block must fit in the remaining token budget. No unfold fires when there's no headroom.

---

## 4. How We Tested

### NIAH (Needle-in-a-Haystack) benchmark — `src/benchmark-niah.ts`

The benchmark hides a secret passphrase at a specific position in a simulated conversation of known length, then measures whether the conductor preserves it through folding. Three probe types isolate different parts of the system:

- **Direct probe:** shares keywords with the needle — tests the existing keyword path (best case).
- **Indirect probe:** zero keyword overlap, adversarial phrasing — tests whether the floor blocks it.
- **Realistic probe:** semantically related but zero keyword overlap — isolates Stage 2 (embedding path only).

Key metrics (model-independent — conductor only):
- `needleFolded`: was the needle block ever folded?
- `needleRescued`: did the proactive-unfold rule fire on the needle?
- `falseUnfolds`: how many non-needle blocks were proactively unfolded?

### Embeddings ON vs OFF

Running the realistic probe with and without `--embeddings` shows Stage 2's contribution directly:
- OFF: needle folds in every non-baseline cell (no rescue signal).
- ON: needle is never folded at budget=0.9/0.7 (proactively rescued before folding occurs).

### Calibration sweep — `src/sweep-unfold.ts`

A conductor-only grid search over MARGIN ∈ {0.05, 0.08, 0.10, 0.12, 0.15} × FLOOR ∈ {0.25, 0.30, 0.35} (no Ollama required). Every grid point achieved 0 false unfolds; rescue rate was flat at 56% across all settings. Tie-breaking by largest margin (most conservative) selected **margin=0.08, floor=0.30** as the defaults. (The 56% is the fraction of cells where folding actually happens AND the outlier rule fires — cells where the needle is in the protected tail or budget is sufficient don't need rescue.)

---

## 5. Results

### Phase 2 benchmark (lengths 10k/20k, depths 10%/25%, budgets 1.0/0.9/0.7/0.5, varied filler)

**Realistic probe, embeddings ON:**

| Metric | budget=0.9 | budget=0.7 | budget=0.5 |
|---|---|---|---|
| needle_fold_rate | 0% | 0% | 50% |
| needle_rescue_rate | 50% | **100%** | 50% |
| false_unfold_rate | 0% | **0%** | **0%** |

*At budget=0.9, 50% rescue rate means half of the cells never fold the needle in the first place — nothing to rescue. At budget=0.5, the needle is folded in some 10k cells but the budget is too tight to unfold; Stage 1's digest carrying the key (`TANGERINE-WHISPER-9`) is the safety net there.*

**Adversarial guard (indirect probe, embeddings ON):**

| Metric | budget=0.9 | budget=0.7 | budget=0.5 |
|---|---|---|---|
| needle_rescue_rate | 0% | 0% | 0% |
| false_unfold_rate | 0% | 0% | 0% |

*The floor (0.30) correctly blocks the adversarial probe (cosine ~0.26) in every cell.*

**Stage 1 digest verification:**

```
Input block text: "Configuration log output:\nThe emergency rollback passphrase is: TANGERINE-WHISPER-9"
Digest output:    "bash -> 2 lines, ~20 tok - TANGERINE-WHISPER-9"
Key present:      true
```

**Never-worse:** Accordion delta vs baseline is 0pp in every cell across all four benchmark runs. (The 3B model scores 0% on indirect/realistic probes at baseline — this is the model's capability ceiling, not a conductor regression.)

### Honest limitations

- **Single fact pattern:** The sweep calibration used one type of needle (a passphrase in a specific format). Calibration against a broader corpus of fact types and session styles is future work.
- **Local 3B model floor:** End-to-end answer accuracy is capped by the local reasoning model. The conductor correctly preserves information it can't force the model to use.
- **Embedding model cap:** `all-MiniLM-L6-v2` has a 256-token input cap. Very long tool outputs are truncated at embedding time. For long contexts, upgrade to `nomic-ai/nomic-embed-text-v1.5` (8k ctx) — see CONDUCTOR.md.
- **Keyword fallback:** When no embedding provider is active, the conductor reverts to keyword overlap with a 0.50 floor. The realistic-probe regime requires embeddings to work.

---

## 6. File-by-File Changes

| File | What changed |
|---|---|
| `src/conductor.ts` | Added `salienceTokens()` helper; updated `deterministicDigest()` tool_result + text branches to use it; added `EmbeddingProvider` type, `AccordionState.embeddingCache`, `warmEmbeddings()`, `relevance()`, `textHash()`, `median()`, `createTransformersEmbeddingProvider()`; replaced absolute threshold with relative-outlier proactive-unfold rule; added `proactiveUnfolds: string[]` to `ConductorOutput`; added `UNFOLD_RELATIVE_MARGIN`, `UNFOLD_SEMANTIC_FLOOR` constants; removed `UNFOLD_SEMANTIC_THRESHOLD` |
| `app/src/lib/engine/digest.ts` | Mirror of Stage 1: added `salienceTokens()` copy and updated `digest()` tool_result + text branches |
| `src/benchmark-niah.ts` | Added `--probe realistic`, `--filler varied`, `--embeddings` flags; added `PROBE_REALISTIC`, `MULTI_PROBE_REALISTIC`, `VARIED_FILLER_POOL`, `assertLexicalIsolation()`; added `needleRescued`/`falseUnfolds` cell metrics and per-budget summary rates; fixed 120s timeout crash (increased to 600s + explicit AbortError handling) |
| `src/conductor.test.ts` | No changes — all 14 tests continue to pass |
| `src/sweep-unfold.ts` | New: calibration-only utility for sweeping margin×floor grid; guards top-level execution behind entrypoint check |
| `CONDUCTOR.md` | Updated Constants section (relative-outlier constants, removed retired absolute threshold); added Benchmark flags subsection |

---

## 7. Glossary

**Token** — The unit of text a model processes. Roughly 4 characters = 1 token. A context window has a maximum number of tokens it can hold.

**Fold / Digest** — Replacing a block's full text with a compact summary (the "digest") to save tokens. Folding is always reversible — the original text is preserved in the session log.

**Embedding** — A list of numbers (a vector) that represents the *meaning* of a piece of text. Two texts with similar meanings have vectors that point in similar directions. Produced by a small local model (`all-MiniLM-L6-v2`).

**Cosine similarity** — A measure of how similar two embedding vectors are. Range: –1 to 1. In practice for these models: 0.1–0.3 = unrelated, 0.4–0.6 = topically related, 0.7+ = closely related.

**NIAH (Needle-in-a-Haystack)** — A standard LLM evaluation where a specific fact ("the needle") is hidden in a long document ("the haystack") and the model must retrieve it. Used here to test whether Accordion preserves facts under folding.

**Budget** — The maximum number of tokens allowed in the assembled context. Expressed as a ratio of the original session size (e.g., budget=0.7 means "fit into 70% of the original token count").

**Needle** — In the benchmark, the specific block containing the secret passphrase (`TANGERINE-WHISPER-9`). More generally, any high-value block that should survive folding.

---

# Update (June 10): Graduated folds + a self-calibrating fold target

*Plain-language section for the team. The earlier sections of this doc still hold; this describes what changed on top.*

## What changed, in one paragraph

Folds used to be on/off: a block was either full text or a one-line digest. Now folding is **graduated** — full → **trimmed** (a structured excerpt ~25% the size, keeping the start, the end, and any key identifiers from the middle) → **digest** (the old one-liner) → **grouped** (under deep pressure, a run of cold digests collapses into one shared group summary). The Conductor always uses the *minimum* depth that fits the budget, so the last block folded usually only gets trimmed instead of crushed. And the budget target itself is no longer a fixed 80% — it **self-calibrates** between 60% and 92%: every time a human, the agent, or the Conductor's own rescue rule has to unfold something, the target opens up fast (+4pts per correction, max +8/turn); when folds go unchallenged, it tightens slowly (−1pt/turn). Think **TCP congestion control for context**: quick to back off when it caused a problem, slow to re-tighten.

## Pitch lines that work

- "`/compact` asks *what do we delete?* Accordion asks *how sharply does each region need to be in focus right now?* Context becomes a continuously-variable lens over preserved history."
- "Folds aren't 0 or 1 — they're a dial. The system turns each block's dial only as far as the budget requires."
- "Nobody ships reversible: Anthropic's context editing replaces tool results with placeholders (no restore), and the trained folding agents (ByteDance's Context-Folding, Alibaba's AgentFold) collapse history into summaries. Accordion is the only one where every fold can be undone — by the human, the agent, or the Conductor itself."
- "The fold target learns from being wrong, with zero training — corrections open the lens, quiet turns close it."

## What to demo

1. Watch a long session cross the budget: the first folds are **trims** (notice `⟦trim⟧` excerpts keep filenames and error strings), then digests, then a `⟦group · turns 3–9 · 6 units⟧` line appears only when pressure gets deep.
2. Unfold something by hand, then send the next message: the fold target jumps (e.g., 0.80 → 0.84) and the Conductor visibly keeps more context. `ConductorOutput.foldTarget` and `assembledTokens` expose this every run — the band *breathes*.
3. The needle rescue still works: a digested block whose topic comes back gets proactively restored to full — and that rescue itself counts as a correction.

## For the Q&A: "how is this different from X?"

See **RELATED_WORK.md** — it has the table. Short version: trained folding agents (FoldAgent, AgentFold) prove multi-scale folding beats summarization, but need RL training and can't un-fold; Anthropic's own context editing clears tool results with no restore path (and their April postmortem shows how silently that fails); the 2026 papers are converging on "non-destructive" and "adaptive" — Accordion ships both, training-free, on any provider.

## Re-run on a real machine (not the sandbox)

The deterministic gates were re-run after this change and hold: **50/50 unit tests, e2e pass, compare-compact 32/32 cells, accordion 1.0 vs compact 0.5, zero budget violations, +50pp**. Two things need network/Ollama and must be re-run locally before the demo: `npm run proof:refresh` (Ollama-scored proofs) and `node --experimental-strip-types src/sweep-unfold.ts` (live-embedding sweep). Expect headline numbers to match; file an issue if any gate moves.

---

# Update (June 10, later): Bidirectional memory — the agent can reach back

The tagline is now executable. Three model-callable tools ship in the pi extension (feature-detected; on pi builds without extension tools, the human commands below still cover everything):

- **`accordion_recall`** — the agent reads the FULL original text of folded turns without changing the live context (its own "peek").
- **`accordion_unfold`** — the agent restores folded turns to full text for upcoming work. Protected from auto-refold for one turn (grace), and it counts as a correction — the Conductor literally learns to fold less when the agent reaches back.
- **`accordion_fold`** — the agent pushes finished turns down to digests to free its own budget. Pinned turns stay open; the current turn is refused.

To make this possible, **every fold is now addressable**: digests render as `⟦t7⟧ …`, trims as `⟦trim t7⟧ …`, group members as `· t7 folded into the group digest above`. The agent sees the address in its own context and can target it. Two new human commands mirror the agent's verbs: **`/peek <turn#>`** (read a fold without touching context) and **`/fold <turn#>`** (fold a turn now, reversibly).

**Demo script for Claim 2:** run a long session in pi until early turns fold, then ask something only a folded turn contains verbatim ("what was the exact canary rollout plan we recorded?"). The agent sees `⟦t2⟧ Deploy rollout plan recorded…`, calls `accordion_recall` or `accordion_unfold` for turn 2, and answers correctly — the decision log shows the move attributed to **agent**, and on the next turn the fold target visibly rises.

Proof: `src/agent-tools.test.ts` (7 tests — recall purity, unfold + grace + budget invariant, calibrator learning, fold guardrails, addressability). Full suite 56/56; compare-compact grid unchanged at 32/32, +50pp, zero budget violations.

Queued next (not in this build): visualizer fold-target gauge + agent replay beat, `npm run evidence` generator for the Claim-1 story document, README hero rewrite around the tagline.

---

# Update (June 10, later): Decision model improvements — 6 enhancements to the Conductor

*Plain-language summary. Earlier sections of this doc still hold; this describes what shipped on top.*

## What changed

### 1. Structured salience digest

`deterministicDigest()` now appends a machine-readable `⟦category: value ∣ …⟧` suffix to every digest. Categories extracted from the block's full text: `paths` (file paths and extensions), `commands` (shell invocations), `errors` (explicit error markers), `exact_values` (key=value pairs), `decisions` (decision language). Example:

```
bash -> 3 lines, ~500 tok - FINAL_MARKER=v3 ⟦paths: deploy.sh ∣ commands: npm run deploy --tag=v3 ∣ exact_values: FINAL_MARKER=v3⟧
```

The suffix is deterministic (no LLM call) and parseable by `parseRiskFlags()` and `parseSalienceRiskBonus()`.

### 2. Risk-aware unfold scoring

The proactive-unfold floor is now per-block. Blocks whose digests contain `commands`, `paths`, `exact_values`, or `decisions` markers get a risk bonus: `effective_floor = max(RISK_FLOOR_MIN=0.1, global_floor − bonus × RISK_FLOOR_BONUS=0.1)`. A block with three risk categories has its floor reduced by 0.3 — it unfolds on any moderate relevance spike. The question becomes "would the answer be *worse* if this stays folded?", not just "is this relevant?"

### 3. Conductor-initiated temporary pins

The Conductor can now pin blocks for up to `CONDUCTOR_PIN_LIFETIME = 3` turns. Triggered when a block is proactively rescued or recently agent-unfolded AND still relevant to the current prompt. Stored in `AccordionState.conductorPins`. Expire automatically (without counting as calibration corrections), strictly weaker than human pins (human/agent fold overrides them). Pin decisions appear in the decision stream with `actor: "conductor"` and `action: "pin"`.

### 4. Improved group formation

Two changes to level-3 grouping:

- **Semantic second pass**: after contiguous grouping, if still over target, cluster non-adjacent L2 blocks with digest-text keyword overlap ≥ `SEMANTIC_GROUP_OVERLAP_THRESHOLD = 0.4`. Group head = highest-relevance block.
- **Enriched group head prefix**: the `⟦group · turns a–b · N units⟧` prefix now includes the union of salience markers from all member digests (e.g., `⟦group · turns 3–7 · 5 units ∣ paths: src/foo.ts ∣ commands: npm build⟧`), so the proactive-unfold rule can detect when any member becomes relevant.

### 5. Multi-reason decision logging

`FoldDecision.reason` is now `string | string[]`. The Conductor emits reason arrays with all applicable factors: `["relevance_low", "token_cost_high", "age_high", "not_pinned"]` for folds; `["relevance_high", "proactive_rescue", "digest_has_risk_flag:commands", "expected_answer_improvement_high"]` for proactive unfolds. Existing string-typed reasons remain valid (backward-compatible).

### 6. Agent context-awareness header

When the assembled context contains folded blocks, a short note is prepended to the first assistant message:

```
[Accordion context manager active. Some earlier turns are folded to digests (marked ⟦t…⟧). If you need exact details from a folded turn, call accordion_recall or accordion_unfold before answering. Folded turns: 2, 4, 7–12. Conductor target: 84%. Context pressure: normal.]
```

Under 100 tokens; injected into assembled output only (never the session log); pressure labels: `comfortable` / `normal` / `tight` based on `assembledTokens / budgetTokens`.

## How each improvement strengthens the three claims

| Claim | Improvement |
|---|---|
| Equal-budget operation (hard ceiling) | Conductor pins prevent thrashing (fold+unfold+fold cycles waste budget); enriched group heads reduce false-negative unfolds. All six improvements respect the hard ceiling. |
| Reversibility (non-destructive folding) | Salience suffix is part of the digest (assembled output only), not the session log. Conductor pins are transient state. Both preserve the invariant that originals are never touched. |
| Bidirectional memory (agent can reach back) | The awareness header explicitly tells the agent about folded turns and how to recall them. Risk-aware scoring ensures high-precision blocks (commands, paths) are more readily rescued. Conductor pins reduce the frequency of "the agent just unfolded this, now it's folded again" friction. |

## Files changed

| File | What changed |
|---|---|
| `src/conductor.ts` | New functions: `categorizeSalienceMarkers`, `buildSalienceSuffix`, `parseRiskFlags`, `parseSalienceRiskBonus`, `isConductorPinned`, `formatTurnRanges`, `buildContextAwarenessHeader`. Updated: `deterministicDigest`, `runConductor`, `buildDecisions`, `applyDecisionsToState`, `contentForLevel`, `createAccordionState`. New constants: `CONDUCTOR_PIN_LIFETIME`, `SEMANTIC_GROUP_OVERLAP_THRESHOLD`, `RISK_FLOOR_BONUS`, `RISK_FLOOR_MIN`. New types: `DecisionAction += "pin"`, `FoldDecision.reason: string | string[]`, `AccordionState.conductorPins`. |
| `src/conductor-improvements.test.ts` | New test file: 25 tests covering all 6 improvements + regression. |
| `CONDUCTOR.md` | Added sections: Structured salience digest, Risk-aware unfold scoring, Conductor-initiated temporary pins, Improved group formation, Agent context-awareness header, Multi-reason decision logging. Added 4 new constants. |
| `UBIQUITOUS_LANGUAGE.md` | Added terms: Salience suffix, Risk marker, Conductor pin, Context-awareness header. |
| `CLAIMS.md` | Added 6 new testable claims. |

## Follow-up work

- Visualizer: show risk markers in the block inspector panel; highlight conductor-pinned blocks with a distinct badge.
- NIAH benchmark: add a "command recall" probe (realistic probe but with an exact shell command as the needle) to validate risk-aware unfold against the keyword path.
- Calibration sweep: re-run `sweep-unfold.ts` after the risk floor change to verify `RISK_FLOOR_BONUS=0.1` is well-calibrated against the varied-filler distribution.
- Semantic grouping: evaluate whether `SEMANTIC_GROUP_OVERLAP_THRESHOLD=0.4` is too aggressive (false groupings) or too conservative (missed groups) on the real demo session.
