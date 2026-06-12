# Ubiquitous Language

## Context assembly

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Accordion** | The context-management system that preserves original conversation history while sending a budgeted view to the model. | Compactor, summarizer |
| **Conductor** | The automatic Accordion policy that decides which context blocks to fold or unfold for an outgoing model request. | Auto mode, policy engine |
| **Context event** | The pi extension interception point where Accordion assembles the outgoing model view. | Hook, between-turn hook |
| **Assembled context** | The transient message list sent to the model after Accordion applies folds and unfolds. | Mutated history, compacted log |
| **Incoming prompt** | The new user request used to score block relevance for the current context event. | Current message, query |
| **Session log** | The durable branch history that stores original messages and Accordion state entries. | Source context, transcript |

## Context units

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Turn** | A user-led segment of conversation that contains the user request and subsequent assistant or tool activity. | Message group, exchange |
| **Block** | A typed unit of context inside a turn, such as user text, assistant text, thinking, tool call, or tool result. | Chunk, segment |
| **Tool pair** | A tool call and its matching tool result that must remain folded or full together. | Tool block, call/result fragment |
| **Preamble** | The system prompt and tool definitions before the first user turn. | Header, setup text |
| **Working tail** | The most recent token region that Accordion keeps full to preserve immediate task continuity. | Recent context, live tail |

## Folding lifecycle

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Fold** | Replace a block's full content in the assembled context with a shallower view at some fold level (trim, digest, or group marker). | Collapse, compact |
| **Fold level** | The graduated depth of a fold: 0 = full, 1 = trim, 2 = digest, 3 = group member. Recorded per block in `foldLevels`; membership stays in `foldedBlockIds`. | Compression ratio, stage |
| **Trim** | The level-1 fold: a deterministic structured excerpt (~25% of the original) keeping the block's head, salience tokens from the elided middle, and tail, marked `⟦trim⟧`. | Snippet, preview |
| **Group fold** | The level-3 deep-pressure move: a contiguous run of digested units collapses so the **group head** carries a `⟦group · turns a–b · N units⟧`-prefixed digest and each **group member** shrinks to a one-line marker. Message skeleton is untouched. | Merge, squash |
| **Unfold** | Restore a folded block to full content in the assembled context. | Expand, hydrate |
| **Proactive unfold** | A Conductor-initiated unfold triggered by the relative-outlier rule before a block would be requested; the Conductor rescues a high-relevance block without a human asking. Counts as a correction event for the calibrator. | Auto-expand, rescue |
| **Pin** | A sticky user or agent override that prevents a block or turn from being folded. | Expand, lock open |
| **Grace period** | A one-turn protection after a human or agent changes a non-pinned block state. | Cooldown, override stickiness |
| **Fold decision** | An attributed Conductor action recording that a block was folded or unfolded for the current assembly. | State change, policy result |
| **Budget guard** | The constraint that a proactive unfold can only fire when the unfolded block fits within remaining token headroom. | Headroom check, budget check |

## Scoring and budget

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Budget ceiling** | The maximum token ceiling allowed for the assembled context. | Limit, context window |
| **Fold target** | The lower headroom target Accordion folds toward instead of stopping exactly at the token budget. No longer fixed: see *Calibrated fold target*. | Ceiling, threshold |
| **Calibrated fold target** | The self-tuning fold target inside `[0.60, 0.92]`. Correction events raise it quickly (`+0.04` each, max `+0.08`/turn); quiet pressure-active turns decay it slowly (`−0.01`). Pinnable via `ACCORDION_FIXED_TARGET`. | Adaptive ratio, learning rate |
| **Correction event** | Evidence the Conductor over-folded: a human or agent unfold, or a proactive unfold, inside the feedback window. Each correction opens the lens on the next calibration tick. | Mistake, override |
| **Calibration tick** | The once-per-turn, idempotent update of the calibrated fold target. Ticks only on pressure-active runs, so idle sessions can't drift the target. | Update step, adjustment |
| **Fold score** | The weighted score that ranks foldable units by kind, keyword overlap or semantic relevance, and recency. | Priority, relevance score |
| **Keyword overlap** | The normalized shared-token relevance between a block and the incoming prompt; the fallback relevance measure when no embedding provider is active. | Similarity, search match |
| **Semantic relevance** | The cosine similarity between the embedding vector of a block and the embedding vector of the incoming prompt; replaces keyword overlap when an embedding provider is active. | Embedding score, vector similarity |
| **Relative-outlier rule** | The proactive-unfold policy: a folded block is a candidate only if its relevance exceeds the median relevance of all folded blocks by at least `UNFOLD_RELATIVE_MARGIN` AND clears `UNFOLD_SEMANTIC_FLOOR`. The rule adapts to the distribution of the haystack rather than relying on a fixed absolute threshold. | Adaptive threshold, outlier detection |
| **Unfold feedback** | Recent manual or agent unfolds that make the Conductor preserve more relevant context on the next turn. | Correction, preference |

## Summary generation

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Deterministic digest** | The immediate local fallback summary generated without a network call; uses salience tokens to surface high-value content from anywhere in the block text, not just the first line. Includes a machine-readable **salience suffix** listing categorized markers. | Placeholder, synthetic summary |
| **Salience token** | A high-signal lexeme extracted from block text and surfaced in the deterministic digest: SCREAMING-CASE identifiers, key=value pairs, filenames with extensions, version and hex literals, and error markers. | Key token, important term |
| **Salience suffix** | A `⟦category: value ∣ …⟧` fragment appended to every deterministic digest by `buildSalienceSuffix()`. Categories: `paths`, `commands`, `errors`, `exact_values`, `decisions`. Parsed by `parseRiskFlags()` to drive risk-aware unfold scoring and group head enrichment. | Metadata suffix, structured annotation |
| **Risk marker** | A salience suffix category (`commands`, `paths`, `exact_values`, or `decisions`) that indicates a block is risky to leave folded — the agent would likely produce a wrong answer without seeing its full content. Each risk marker lowers the block's effective proactive-unfold floor by `RISK_FLOOR_BONUS`. | Hazard flag, precision signal |
| **Conductor pin** | A temporary block-level protection set by the Conductor (not by the human or agent). Prevents auto-folding for up to `CONDUCTOR_PIN_LIFETIME` turns. Triggered when the Conductor proactively rescues or detects active-task dependency. Weaker than human pins: expires automatically, does not prevent manual human/agent fold, and its expiry does not count as a calibration correction event. | Auto-pin, temporary lock |
| **Context-awareness header** | A short system note prepended to the first assistant message in the assembled context when folded blocks exist. Lists folded turn numbers, the calibrated fold target, and a pressure label (comfortable/normal/tight). Injected into the assembled output only; never written to the session log. | Fold notice, accordion header |
| **Summary provider** | An injected asynchronous service that can produce a higher-quality summary for a folded block. | LLM client, summarizer |
| **Anthropic provider** | The default Summary provider used by the pi extension when an Anthropic API key exists. | Haiku provider |
| **Ollama provider** | The local Summary provider that calls Ollama's OpenAI-compatible chat completions endpoint. | Local provider, OpenAI provider |
| **LLM summary** | The provider-generated summary cached for future assembled contexts. | Real summary, async summary |
| **Summary cache** | The state store of generated summaries keyed by SHA-256 content hash. | Digest cache, memo |
| **Content hash** | A strong hash of normalized block content used to avoid summarizing the same content twice. | Cache key, block id |
| **Provider failure** | A summary-provider timeout, network error, or non-success response that leaves the deterministic digest in place. | Crash, summarizer error |

## Embeddings

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Embedding vector** | An L2-normalized float vector encoding the semantic meaning of a text, produced by a local embedding model; two texts with similar meanings produce vectors that point in nearly the same direction. | Representation, feature vector |
| **Embedding provider** | The async service that batches texts and returns embedding vectors; analogous to a Summary provider but used for relevance scoring, not summarization. | Vector service, encoder |
| **Warm-up** | The async pre-computation step that embeds all block texts and the incoming prompt before the synchronous Conductor run; writes vectors into the embedding cache so the Conductor only reads, never calls the provider. | Pre-embed, async prep |
| **Embedding cache** | The persistent store of pre-computed embedding vectors keyed by content hash; each text is embedded only once and reused across turns. | Vector cache, embedding memo |
| **Cosine similarity** | The dot product of two L2-normalized embedding vectors; 1.0 = identical direction (close meaning), 0.0 = orthogonal (unrelated). | Dot product, vector distance |

## Benchmarking

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **NIAH benchmark** | The Needle-in-a-Haystack test suite that hides a specific high-value fact in a simulated conversation and measures whether Accordion preserves it through folding pressure. | Integration test, evaluation |
| **Needle** | The specific block containing the high-value fact in a NIAH benchmark run; the block Accordion must not permanently discard. | Target block, secret block |
| **Haystack** | The background filler blocks surrounding the needle in a NIAH benchmark run. | Filler context, padding |
| **Probe type** | A NIAH benchmark variant defined by the lexical and semantic relationship between the needle and the retrieval question: direct (keyword overlap), realistic (semantic but no lexical overlap), or indirect (adversarial, neither semantic nor lexical match). | Query type, test mode |

## Relationships

- An **Accordion** run produces one **assembled context** from one **session log** without destroying original messages.
- A **Conductor** evaluates many **blocks** inside many **turns** during a **context event**.
- A **Tool pair** contains exactly one matching tool call and tool result when valid.
- A **Fold decision** belongs to exactly one **block** and is attributed to the **Conductor**.
- A **Summary cache** stores zero or one **LLM summary** for each **content hash**.
- An **Embedding cache** stores zero or one **embedding vector** for each **content hash**.
- A **Pin** protects a **block** or **turn** until explicitly removed.
- A **Provider failure** must not prevent a **context event** from returning an **assembled context**.
- A **Proactive unfold** fires only when the **relative-outlier rule** passes AND the **budget guard** permits.
- A **Deterministic digest** surfaces up to five **salience tokens** from anywhere in the **block** text.
- **Semantic relevance** is computed from two **embedding vectors**; **keyword overlap** is the fallback when no **embedding provider** was active during **warm-up**.

## Example dialogue

> **Dev:** "When the **context event** fires, does the **Conductor** change the **session log**?"

> **Domain expert:** "No. It only builds the **assembled context**; the original messages remain in the **session log**."

> **Dev:** "If the budget is tight, can we **fold** just the tool result and keep the call full?"

> **Domain expert:** "No. A valid **tool pair** folds or unfolds as one unit so the provider never receives a split payload."

> **Dev:** "What does the model see if the block with the passphrase gets folded?"

> **Domain expert:** "It sees the **deterministic digest**, which now includes the passphrase as a **salience token** — the label line is skipped, the value on line two is surfaced. The model still has the fact."

> **Dev:** "How does the **Conductor** decide to proactively restore it on the next turn if the user asks with completely different words?"

> **Domain expert:** "The **warm-up** embeds the block and the **incoming prompt** before the Conductor runs. Inside, `relevance()` returns their **cosine similarity**. If the block stands out above the median of all folded blocks by the margin — and clears the absolute floor — the **relative-outlier rule** fires a **proactive unfold**, provided the **budget guard** allows it."

> **Dev:** "What if there's no embedding provider?"

> **Domain expert:** "It falls back to **keyword overlap**. The realistic probe fails there — zero shared words — so that block stays folded. That's why the NIAH **probe type** matters: the realistic probe isolates the embedding path."

## Flagged ambiguities

- "Expand" is a command name but should not be used as the domain term for restoring content; use **Unfold** for restored context and **Pin** for sticky protection.
- "Collapse" is a command name but should not be used as the domain term for replacing content; use **Fold**.
- "Summary" can mean either a **deterministic digest** or **LLM summary**; name the specific form when behavior depends on latency or cache state.
- "Budget" can mean **budget ceiling** or **fold target**; use the precise term when discussing thresholds.
- "Context" can mean **context event**, **session log**, **assembled context**, **preamble**, or **working tail**; use the precise term in specs and tests.
- "Relevance" can mean **keyword overlap** (fallback) or **semantic relevance** (embedding path); specify which when discussing scoring thresholds, since the numeric ranges differ (keyword overlap is 0–1 word-fraction; cosine similarity is typically 0.1–0.8 in practice).
- "Threshold" alone is ambiguous: it can refer to the fixed **UNFOLD_KEYWORD_THRESHOLD** (keyword path), **UNFOLD_SEMANTIC_FLOOR** (absolute cosine floor), or the dynamic target of the **relative-outlier rule**; use the precise constant name or describe the path.
