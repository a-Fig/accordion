# Accordion Conductor

The Conductor is Accordion's automatic context policy for the pi extension. It runs in the existing `context` event and rewrites only the outgoing model view; original session messages remain unchanged in pi's branch log.

## Scoring

Each foldable unit gets:

```text
fold_score = (kind_rank * kind_weight) + (keyword_overlap * keyword_weight) + (recency * recency_weight)
```

Lowest scores fold first. `kind_rank` uses Accordion's durable-value order: `tool_result`, `thinking`, `text`, `tool_call`, `user`. `keyword_overlap` is normalized prompt-token overlap after lowercasing and stopword removal; identifiers, filenames, and error strings are preserved. `recency` is the block's normalized turn position, where newer context scores higher and is therefore less foldable.

Tool calls and matching tool results are scored and folded as one unit. Malformed or partial tool pairs stay full fidelity.

## Dynamic Weights

Weights are chosen per incoming prompt:

- Identifier, filename, or error prompt: kind `0.3`, keyword `0.6`, recency `0.1`.
- Past-reference prompt such as "earlier" or "we decided": kind `0.25`, keyword `0.7`, recency `0.05`.
- Generic continuation such as "continue" or "next": kind `0.3`, keyword `0.2`, recency `0.5`.
- Default: kind `0.4`, keyword `0.4`, recency `0.2`.

Recent human or agent unfolds in the last five turns increase keyword weight and reduce fold aggressiveness for the current turn.

## Constants

Defaults live at the top of `src/conductor.ts`:

- `DEFAULT_BUDGET_TOKENS = 150_000`
- `WORKING_TAIL_TOKENS = 20_000` — default engine protection window, matching the desktop app's protected tail. Callers can override this via `workingTailTokens` in `runConductor()`.
- `MAX_EMBEDDING_CACHE_ENTRIES = 1_000` — maximum persisted embedding vectors after pruning stale transcript hashes.
- `FOLD_TARGET_MIN / FOLD_TARGET_MAX / FOLD_TARGET_INITIAL = 0.60 / 0.92 / 0.80` — the calibrated fold-target band. The Conductor self-calibrates the target inside the band instead of using a fixed ratio (see "Calibrated fold target" below). `FOLD_TARGET_RATIO` remains as a legacy alias for `FOLD_TARGET_INITIAL`.
- `CALIBRATION_UP_STEP = 0.04`, `CALIBRATION_UP_MAX_PER_TURN = 0.08`, `CALIBRATION_DOWN_STEP = 0.01` — correction events raise the target fast (fold less), quiet pressure decays it slowly (fold more). Asymmetric on purpose, like TCP congestion control: back off quickly when you've caused a problem, re-tighten slowly.
- `TRIM_TARGET_RATIO = 0.25`, `TRIM_MIN_TOKENS = 240` — level-1 trim sizing and eligibility floor. Blocks below the floor (or whose trim wouldn't save ≥50%) skip straight to digest.
- `GROUP_MIN_UNITS = 3`, `GROUP_MEMBER_MARKER` — level-3 grouping engages only for contiguous runs of at least this many digested units, and only under deep pressure.
- `UNFOLD_KEYWORD_THRESHOLD = 0.5` — word-overlap floor for proactive unfold (keyword path)
- `UNFOLD_RELATIVE_MARGIN = 0.08` — relative-outlier margin for proactive unfold (embedding path): a folded block is a candidate only if its cosine relevance exceeds `median(all_folded) + margin`.
- `UNFOLD_SEMANTIC_FLOOR = 0.30` — absolute safety floor (cosine path): the relative-outlier rule won't fire unless the block also clears this floor. Prevents spurious unfolds when all relevance values are uniformly low.
- `EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2"` — 384d, 256-token input cap; no prefixes needed. For longer tool outputs upgrade to `"nomic-ai/nomic-embed-text-v1.5"` (768d, 8k ctx) but that model requires `"search_document:"` / `"search_query:"` prefixes on inputs. Override at runtime via env var `ACCORDION_EMBEDDING_MODEL`. The provider handles the prefixing automatically for known models like `nomic-embed-text`.
- `UNFOLD_FEEDBACK_TURNS = 5`
- `SUMMARY_MODEL = "claude-haiku-4-5"`
- `DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1"`
- `DEFAULT_OLLAMA_MODEL = "llama3.2:3b"`
- `DEFAULT_SUMMARY_TIMEOUT_MS = 30_000`
- `CONDUCTOR_PIN_LIFETIME = 3` — how many turns a conductor-initiated pin remains active before expiring. Renewal resets the clock.
- `SEMANTIC_GROUP_OVERLAP_THRESHOLD = 0.4` — minimum pairwise digest-text keyword overlap for non-adjacent semantic group formation (second grouping pass).
- `RISK_FLOOR_BONUS = 0.1` — each risk category present in a digest's salience suffix lowers the effective proactive-unfold floor by this amount.
- `RISK_FLOOR_MIN = 0.1` — the effective unfold floor never drops below this, regardless of risk bonus count.

Tune these constants before changing the scoring shape. Lower the fold-target band to fold more aggressively; higher `UNFOLD_KEYWORD_THRESHOLD` or `UNFOLD_SEMANTIC_FLOOR` makes proactive unfolds rarer. Override `UNFOLD_RELATIVE_MARGIN` / `UNFOLD_SEMANTIC_FLOOR` at runtime via env vars `ACCORDION_UNFOLD_MARGIN` / `ACCORDION_UNFOLD_FLOOR`. Pin the fold target (disabling calibration) via env var `ACCORDION_FIXED_TARGET` or `ConductorDependencies.fixedFoldTarget`.

## Fold levels

Folds are graduated, not binary. Every foldable unit sits at a depth:

| Level | Name | Assembled content | Typical size |
| --- | --- | --- | --- |
| 0 | Full | Original text | 100% |
| 1 | Trim | `⟦trim⟧` structured excerpt: head + salience tokens from the elided middle + tail | ~25% |
| 2 | Digest | Salience digest, or cached LLM summary when available | 1–3 lines |
| 3 | Group member | One-line marker pointing at the group head's `⟦group · turns a–b · N units⟧`-prefixed digest | ~10 tokens |

Escalation is depth-first in fold-score order: the coldest unit deepens first, and the *marginal* unit — the one that crosses the target line — stops at the shallowest level that meets the target, so it stays at trim instead of being crushed to a digest. Group folding (level 3) only engages when every eligible unit is already digested and the target is still unmet; it collapses contiguous runs of ≥ `GROUP_MIN_UNITS` digested units, leaving the message skeleton untouched (provider safety holds by construction). Tool pairs move levels atomically; a mixed-level pair normalizes to its shallowest member. Trim keeps each block's head and tail and hoists salience tokens from the middle — the serial-position effect (Lost in the Middle) applied inside a block. Proactive unfold restores straight to level 0, and rescue compensation folds donors to level 2.

All levels remain views: originals are never mutated, and `FoldDecision.level` / `fromLevel` make every depth change attributable in the decision log.

## Structured salience digest

Level-2 digests now carry a machine-readable **salience suffix** appended by `deterministicDigest()`. The suffix lists categorized high-signal markers extracted from the block's full text:

```
bash -> 3 lines, ~500 tok - FINAL_MARKER=MANGO-WHISPER-9 ⟦paths: src/deploy.ts ∣ commands: npm run deploy --tag=v3 ∣ exact_values: FINAL_MARKER=MANGO-WHISPER-9⟧
```

Categories: `paths` (file paths and extensions), `commands` (shell invocations starting with `$` or using common CLIs), `errors` (explicit error markers and stack traces), `exact_values` (key=value pairs), `decisions` (sentences with decision language). The suffix is deterministic (no LLM call) and delimited by `⟦…⟧` so it can be parsed by `parseRiskFlags()`.

## Risk-aware unfold scoring

The proactive-unfold floor is now per-block rather than global. Blocks whose digests contain `commands`, `paths`, `exact_values`, or `decisions` markers get a **risk bonus** that lowers their effective floor:

```
effective_floor = max(RISK_FLOOR_MIN, global_floor − riskBonus × RISK_FLOOR_BONUS)
```

A block with three risk categories gets `riskBonus = 3`, so its effective floor drops from 0.5 to max(0.1, 0.5 − 0.3) = 0.2. It will unfold on any moderate relevance spike instead of needing a strong match. This captures the "expected answer improvement" framing: the question isn't just "is this relevant?" but "would the answer be worse if this stays folded?"

The floor is computed from the digest's suffix at unfold-decision time, not the full block text.

## Conductor-initiated temporary pins

The Conductor can pin a block for up to `CONDUCTOR_PIN_LIFETIME = 3` turns when it detects active-task dependency. Two triggers:

- **Proactive rescue**: a block is proactively unfolded AND its relevance clears the unfold floor → pin it to prevent fold-unfold thrashing on subsequent turns.
- **Agent unfold**: an agent unfold from the previous turn is detected AND the block is still relevant → pin it.

Conductor pins are stored in `state.conductorPins` and are checked by `canFoldUnit()` alongside human pins. Unlike human pins:

- They expire automatically after `CONDUCTOR_PIN_LIFETIME` turns without renewal.
- Expiry does NOT count as a calibration correction event (it's expected lifecycle, not Conductor error).
- A human `/fold` or agent `accordion_fold` command overrides them (manual actions bypass `canFoldUnit`).
- They are recorded in the decision stream with `actor: "conductor"` and `action: "pin"`.

## Improved group formation

Group formation now has two passes:

1. **Contiguous pass** (original): collapses runs of ≥ `GROUP_MIN_UNITS` adjacent digested units under deep pressure.
2. **Semantic pass** (new): if the contiguous pass did not reach the target, clusters non-adjacent L2 blocks whose digest texts share keyword overlap ≥ `SEMANTIC_GROUP_OVERLAP_THRESHOLD = 0.4` (pairwise against the seed, which is the highest-relevance L2 block). Groups of ≥ `GROUP_MIN_UNITS` fire.

In both passes, the group head's prefix is enriched with the **union of salience markers** from all member digests:

```
⟦group · turns 3–7 · 5 units ∣ paths: src/foo.ts ∣ commands: npm run build⟧
```

This allows the proactive-unfold rule to detect when *any* group member becomes relevant, not just the head.

All grouping constraints (pins, protected tail, grace period, tool-pair atomicity) still apply.

## Agent context-awareness header

When the assembled context contains folded blocks, a short system note is prepended to the first assistant message:

```
[Accordion context manager active. Some earlier turns are folded to digests (marked ⟦t…⟧). If you need exact details from a folded turn, call accordion_recall or accordion_unfold before answering. Folded turns: 2, 4, 7–12. Conductor target: 84%. Context pressure: normal.]
```

The note is injected into the assembled output only — never into the original session log. Pressure labels: `comfortable` (< 70% of budget), `normal` (70–85%), `tight` (≥ 85%). This makes the fold system legible to models that might not infer from `⟦t7⟧` markers alone that those turns are recoverable.

## Multi-reason decision logging

`FoldDecision.reason` now accepts `string | string[]`. The Conductor emits arrays with all applicable factors:

- **Fold**: `["relevance_low", "token_cost_high", "age_high", "not_pinned"]`
- **Trim**: `["budget_pressure", "trim_sufficient"]`
- **Group**: `["budget_pressure_deep", "grouped"]`
- **Proactive unfold**: `["relevance_high", "proactive_rescue", "digest_has_risk_flag:commands", "expected_answer_improvement_high"]`

Single-string reasons (from legacy paths or external actors) remain valid.

## Calibrated fold target

The fold target is no longer a fixed ratio. `calibrateFoldTarget()` ticks once per pressure-active turn (idempotent via `lastCalibrationTurn`; quiet under-budget turns don't tick, so an idle session can't silently ratchet the target):

- **Correction events** — human/agent unfolds and proactive unfolds since the last tick, inside the `UNFOLD_FEEDBACK_TURNS` window — each push the target **up** by `CALIBRATION_UP_STEP`, capped at `CALIBRATION_UP_MAX_PER_TURN` per tick. A correction means the Conductor folded something the conversation needed: open the lens.
- A pressure-active turn with **no corrections** that previously assembled within budget decays the target **down** by `CALIBRATION_DOWN_STEP`. Quiet folding is evidence the lens can tighten.
- The target clamps to `[FOLD_TARGET_MIN, FOLD_TARGET_MAX]` and persists in state (`foldTargetCalibrated`), along with a capped `calibrationEvents` log for the UI.

The old binary behavior — bumping `foldTargetRatio` to 0.9 after `HIGH_UNFOLD_RATE` recent unfolds — is removed; the feedback rule now only shifts relevance weights, and all fold-pressure adaptation flows through the calibrator. `ConductorOutput.foldTarget` and `ConductorOutput.assembledTokens` expose the live value per run so the band's breathing is observable in the demo.

## Embeddings

Semantic relevance replaces literal word-overlap when an embedding provider is active. The flow:

1. **Before calling `runConductor()`**, the caller awaits `warmEmbeddings(blocks, prompt, provider, state)`. This batches all block texts and the incoming prompt, embeds them via the provider, and writes L2-normalized float vectors into `state.embeddingCache` (keyed by truncated SHA-256 of the normalized text). Already-cached texts are skipped.
2. **Inside `runConductor()`** the `relevance()` function checks the cache. If both the block text and the prompt vector are present, it returns their dot product (= cosine similarity for normalized vectors). On cache miss or when no provider was used, it falls back to `keywordOverlap()`.
3. `runConductor()` itself is **synchronous** — it only reads the cache, never calls the provider. The warm-up step is the only async boundary.

`createTransformersEmbeddingProvider(model?)` provides a concrete implementation using the optional `@huggingface/transformers` dependency. The package import is checked when the provider is created; the model pipeline is lazy-loaded on the first embedding batch and reused. If the package is not installed, the provider throws a clear error and Accordion continues on the deterministic keyword/digest path.

### Benchmark flags

`src/benchmark-niah.ts` supports:

- `--probe direct|indirect|realistic` — direct shares keywords with the needle (tests keyword path); indirect has zero overlap (tests digest-only safety net); realistic is semantically related but lexically isolated (tests embedding path in isolation).
- `--filler repeat|varied` — repeat uses a single token pattern; varied uses the 20-line mundane developer log pool (no credential/rollback language).
- `--embeddings` — activates the embedding path (warm-up + cosine relevance). Without this, the conductor uses keyword overlap only.
- `--mode single|multi-key` — single-needle or three-needle haystack.
- `--verbose` — prints per-cell embedding diagnostics (cosine scores, floor/margin, filler stats).

Run `src/sweep-unfold.ts` to re-calibrate `UNFOLD_RELATIVE_MARGIN` / `UNFOLD_SEMANTIC_FLOOR` after changing the embedding model or filler distribution. It is a dev utility and requires no Ollama endpoint.

### Compact comparison

Run `npm run compare:compact -- --budgets=1500,2500,4000` to compare equal-budget recency truncation, compact-style summarize-then-drop, and Accordion contexts on targeted retrieval scenarios. Add `-- --answers` to score local Ollama answers instead of only checking whether the assembled context still contains the target fact. Answer-scored scenarios can reject known decoy answers, so a response that includes both the right value and a wrong rejected option does not pass. Add `-- --compact=llm` to use a local Ollama-generated compact summary as the compact baseline. Add `-- --compact=external --external-compact=compact-captures.json` to score captured summaries from a real `/compact` run. Add `-- --markdown=compact-comparison.md` to emit a judge-readable report with scores, head-to-head counts, budget violations, and representative Accordion wins. The runner writes `compact-comparison.json` by default.

Useful proof runs:

- `npm run proof:compact` — broad embedding proof gate; fails if Accordion advantage drops below 20pp, compact wins any cell, or Accordion violates a budget.
- `npm run proof:semantic` — tight answer-scored semantic proof gate; fails unless Accordion wins the paraphrased late-fact case without budget violations.
- `npm run proof:semantic:cloud` — same answer-scored semantic gate against Ollama's `minimax-m3:cloud`, useful as a second-model sanity check when the cloud model is available.
- `npm run proof:semantic:two-model` — runs the semantic proof against local `llama3.2:3b` and Ollama's `minimax-m3:cloud` model when the cloud model is available.
- `npm run proof:judge` — answer-scored semantic grid over multiple scenarios and budgets; requires at least six cells, 100% Accordion score, at least a 50pp advantage, zero compact wins, and zero Accordion budget violations.
- `npm run proof:judge:llm` — same answer-scored semantic grid, but with a local Ollama-generated compact summary as the compact baseline instead of the deterministic digest/drop baseline.
- `npm run proof:judge:all` — runs both judge grids.
- `npm run proof:report` — validates the latest JSON proof outputs against the same headline gates and expected benchmark configuration, then writes `JUDGE_PROOF.md`; exits nonzero if required reports are missing, older than 24 hours, misconfigured, or weak.
- `npm run proof:refresh` — reruns all proof outputs required by `proof:report`, then regenerates `JUDGE_PROOF.md`.
- `npm run compact:external-template` — writes `compact-captures.template.json` plus `compact-captures.guide.md`, containing the semantic setup transcripts, budgets, final prompts, expected keys, and empty `summary` fields for real `/compact` output.
- `npm run proof:judge:external` — scores `compact-captures.json` as a captured real-compact baseline against the same judge grid. Fill it from the template before running this command; blank summaries are rejected.
- `npm run compare:compact -- --budgets=1500,2500,4000 --out=compact-comparison-broad.json` — broad deterministic context check over exact decisions, file paths, endpoint choices, UI policy, and command recall.
- `npm run compare:compact -- --compact=llm --budgets=1500,2500,4000 --out=compact-comparison-llm-broad-context.json` — same grid against an Ollama-generated compact summary baseline.
- `npm run compare:compact -- --compact=llm --budgets=1500 --out=compact-comparison-llm-answer-sample.json --answers` — answer-scored Ollama sample across all scenarios at the tightest budget.
- `npm run compare:compact -- --embeddings --category=semantic --budgets=1500,2500 --out=compact-comparison-semantic-embed.json` — semantic/paraphrase check where embeddings rescue a late fact that keyword matching and compact summaries miss.
- `npm run compare:compact -- --embeddings --budgets=1500,2500,4000 --out=compact-comparison-all-embed.json` — full context-retention grid with both exact-recall and semantic scenarios.

For a true `/compact` comparison, generate the external template and guide, replay each listed `setupTranscript` in the host, invoke `/compact` before sending the `finalPrompt`, paste the resulting compact summary into the matching `summary` field, save it as `compact-captures.json`, then run `npm run proof:judge:external`. Do not include `finalPrompt` in the captured `/compact` input; the scorer adds that prompt later. The external mode does not synthesize or trim the pasted summary; it scores the captured summary plus the same final prompt tail against Accordion under the same budget and answer checks. External mode rejects empty `summary` fields by default so an unfilled template cannot be mistaken for evidence; use `--allow-empty-external` only for parser smoke tests. `proof:report` shows the host `/compact` comparison as optional until `compact-comparison-judge-external-semantic.json` exists; once present, it validates that report with the same freshness, metadata, score, and budget gates.

## Summaries

Folded blocks use deterministic digests immediately. The pi extension keeps Anthropic Haiku as the default provider: if `ANTHROPIC_API_KEY` is set, it schedules async `claude-haiku-4-5` summaries off the critical path and caches them by SHA-256 content hash. Missing or failing summary calls never block context assembly.

`src/conductor.ts` also exports `createOllamaSummaryProvider()` for local testing and alternate deployments. It uses Ollama's OpenAI-compatible endpoint at `http://localhost:11434/v1/chat/completions`; the model defaults to `llama3.2:3b` and can be overridden with the provider option or `OLLAMA_SUMMARY_MODEL` in the live test.

Run the fast claim/invariant suite with `npm run test:claims`. It verifies equal-budget assembly, reversible/non-mutating folds, provider-safe tool pairs, protected-tail behavior, and semantic restore on a deterministic fixture.

Run the deterministic suite with `npm test`. Run the live Ollama integration with:

```bash
npm run test:ollama
```

## State

The extension persists Conductor state as custom session entries: folded block ids, pinned block ids, pinned turn indexes, summary cache, pending summary hashes, manual changes, embedding cache, and decisions attributed to `conductor`. Before each state snapshot, the embedding cache is pruned to hashes for the current prompt and current transcript blocks, capped at 1,000 entries with the newest blocks preferred. Only pins are sticky protections. Non-pinned blocks remain eligible for re-evaluation each turn, with a one-turn grace period after human or agent changes.
