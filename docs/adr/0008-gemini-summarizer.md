# ADR 0008 — Gemini Summarizer: folds that carry meaning (Milestone C2)

**Status:** accepted (Milestone C2 in progress)
**Date:** 2026-06-10
**Builds on:** [ADR 0005](0005-agent-unfold.md) (`{#code FOLDED}` digest prefix — the
single source of truth that summaries layer into), [ADR 0006](0006-multiblock-folds.md)
(`groupDigest` / `summaryText` wire field — same path LLM recaps take over).
**See also:** [conductor-plan.md](../conductor-plan.md) §C2 for the full work plan.

## Context

Today every folded block collapses to a deterministic digest from `digest.ts`:
a short, kind-shaped stub that tells the agent *that* something was here, not *what*.
A 5k-token tool result that ran a multi-file refactor folds to roughly "tool_result
(FOLDED): wrote 4 files." The agent can self-unfold (ADR 0005), but whether it does
depends on the digest being informative enough to signal that the block is worth
restoring. Skeletal digests undermine both the Conductor's ability to fold
aggressively and the agent's ability to judge what to unfold.

The highest-leverage upgrade on the whole Conductor ladder is replacing skeletal
digests with **LLM-generated summaries, computed once, cached forever**. When a
5k-token result folds to 60 tokens that genuinely carry its content, folding stops
being information loss in practice. The conductor can fold far more aggressively;
the agent's unfold decisions get accurate. C2.5's coalescing and C3's relevance
index both improve proportionally — their quality ceiling is the quality of the
summaries they index.

## Decision

### 1. Content-addressed, immutable cache

The cache key is:

```
SHA-256(blockText + kind + PROMPT_VERSION + model)
```

Blocks never change after they are committed to the store. A summary is therefore
computed **once ever** — across sessions, re-opens, and re-folds. The same block in
two different sessions hits the same key and pays zero.

Storage: `~/.accordion/summaries/cache.jsonl` — append-only JSONL records
`{key, summary, tokens, model, promptVersion, ts}`. This is the same best-effort,
path-confined I/O regime as the session registry (ADR 0002). SQLite only if scale
demands it; a linear-scan JSONL with an in-memory index built on load is fast enough
for the realistic cache sizes (hundreds to low thousands of entries per user).

`PROMPT_VERSION` is a constant in `app/src/lib/llm/prompts.ts` — bumping it
invalidates old entries, so a prompt fix never silently serves stale summaries.

### 2. Model access: Google Gemini via Rust

**Provider choice: Google Gemini, not Anthropic.** This is a billing decision, not
a quality decision. On this machine, available API credits are on Google. AI Studio
(Gemini) prepay credits are currently depleted (detected as 429); Vertex AI
(`us-central1`, `gemini-2.5-flash-lite`) via gcloud ADC OAuth is verified working.
If AI Studio credits are topped up, the provider chain automatically promotes: AI
Studio is tried first (faster, no gcloud dependency), Vertex is the fallback.

**Model: `gemini-flash-lite-latest` / `gemini-2.5-flash-lite`.** Haiku-class
economics. A 130k-token session like the bundled sample has ~982 blocks; after
applying the size floor (~300 tokens; smaller blocks keep the deterministic digest),
a few hundred are summarization candidates. At flash-lite pricing, full-session
summarization costs cents, not dollars.

**Access path: Rust `llm_generate` Tauri command** (`app/src-tauri/src/lib.rs`).
The API key and gcloud OAuth token never enter the webview — they stay in the Rust
process, mirroring how `~/.claude` reads went to Rust (ADR 0002). The `llm_generate`
command accepts `{prompt, model, maxTokens}` and returns `{text, inputTokens,
outputTokens}`.

**For offline evals and the replay driver (`engine/replay.ts`, ADR 0007):** a
parallel Node twin at `app/scripts/lib/llm-node.mjs` performs the same HTTP POST
using Node's `fetch` with a locally-available key or gcloud token. This is a thin
duplication of one POST, accepted deliberately: **all prompt logic lives in one TS
home** (`app/src/lib/llm/prompts.ts`), imported by both paths. The duplication is
contained to transport; the prompts are not duplicated.

**AI Studio key detection:** the provider chain checks for `GEMINI_API_KEY` in the
environment first. If absent or if a 429 is returned, it shells to `gcloud auth
print-access-token`, caches the result for 45 minutes (the token's TTL), and retries
against the Vertex endpoint. This shell-out happens in the Rust layer, not the
webview.

**Rejected: direct `fetch` from the webview.** Fast to build, but puts the API key
in webview memory — accessible to injected scripts and visible in DevTools. Not the
default path; acceptable behind a dev-only flag if ever warranted.

**Rejected: Node sidecar.** Overkill until C5 forces the runtime question anyway.
The Rust `llm_generate` command covers the GUI use-case; the Node twin covers evals.
No new process boundary before C5.

### 3. Generic path-confined Rust I/O helpers

Two new Rust commands, reused by metrics (ADR 0010) and distillation logs:

- `accordion_read_text(path)` — reads a UTF-8 file under `~/.accordion`; rejects
  any path that escapes the directory.
- `accordion_append_line(path, line)` — appends one line to a file under
  `~/.accordion`, creating it if absent; same path confinement. Used by cache writes,
  metrics, and distill log appends.

Both wrap the same path-confinement check used by the existing session-registry
Rust commands. No new security surface; just the existing pattern factored out.

### 4. Per-kind prompts with verbatim-identifier preservation

`app/src/lib/llm/prompts.ts` exports one prompt template per foldable kind:

- **`tool_result`** — "what was asked and what came back; key values, paths, errors
  verbatim."
- **`thinking`** — "decisions reached and the reasoning behind them."
- **`text`** — "claims, commitments, answers given."

Every template carries a hard rule: **preserve every file path, symbol name, and
quoted string verbatim.** C1's lexical pass (ADR 0007) and the agent's own grep
search for exact identifiers — a summary that paraphrases `src/lib/engine/store.svelte.ts`
as "the store module" breaks both. This is the highest-priority quality constraint,
ahead of brevity.

**Length cap:** `min(120 tokens, ~10% of source tokens)`. This keeps token accounting
meaningful — a 1k-token block folds to at most ~100 summary tokens, a material
saving. Below the **300-token size floor**, the deterministic digest from `digest.ts`
is already a fine summary; no model call is made and no cache entry written.

### 5. Engine integration: `digestOf` prefers cache; `{#code FOLDED}` survives

`store.digestOf(block)` checks the summary cache first and falls back to `digest.ts`'s
deterministic output. The `{#code FOLDED}` prefix from ADR 0005 is preserved verbatim —
it is prepended to whichever text `digestOf` returns:

```
{#3f9a FOLDED} <summary or deterministic digest here>
```

ADR 0005's single-source-of-truth property survives intact: the GUI shows exactly
what the agent receives, and token accounting includes the tag overhead.

**Token accounting:** `effTokens(block)` must use the summary token count (from the
cache record's `tokens` field) when a summary is present. This is handled at the
`store` layer, not in `digest.ts`. The reason: `digest.ts` is a pure, dependency-free
function with no async access to the cache; routing summary lookups through the store
avoids introducing async into `digest.ts` and sidesteps the WeakMap staleness tripwire
that already exists in the digest machinery.

**Group summaries** (`groupSummary`, already in ADR 0006's plan): a group's recap
becomes one cheap call over the member summaries already in cache — "summary of
summaries." Cached under the same content-addressed scheme, keyed on a hash of the
member summary hashes. Near-free for C2.5's coalescing.

### 6. Summary queue: ahead-of-need scheduling

A `summaryQueue` in the app schedules summarization whenever the session passes
**~50% of budget** — ahead of the fold threshold, so a summary is available as a cache
hit before the conductor needs it. Priority: largest uncached blocks above the floor,
oldest first (most likely to be folded imminently). The queue processes one request
at a time to avoid parallel Tauri command flooding; the digest fallback covers the
window while a summary is pending.

The queue runs on the GUI side (GUI drives), respects the same `folding.enabled`
gate, and is paused while the session is over budget (the conductor is folding to
recover headroom; adding summarization latency in that moment is counterproductive).

## Safety invariants

All ADR 0004/0005/0006 invariants hold unchanged. Summaries are a content upgrade —
they never alter the fold mechanics, the wire guards, or the budget accounting. A
summary computation failure leaves the block with its deterministic digest; no model
call is ever delayed by a pending summary.

**No `context`-hook-path I/O.** The summary queue is async and decoupled from the
`context` hook entirely. Cache writes go through `accordion_append_line` in the Rust
layer; the GUI never performs synchronous I/O on the fold path.

## Consequences

**Wins.** Folding becomes genuinely informative rather than merely signaling that
something was here. The agent's self-unfold decisions get more accurate because the
digest text is meaningful. C1's lexical pass scores more precise hits on cached
summaries (which preserve exact identifiers). C2.5's group recaps become readable.
C3's summary index is usable rather than skeletal.

**Risk: summary quality.** A subtly wrong summary is worse than a skeletal digest
because the agent trusts it. Mitigations: the verbatim-identifier instruction
(the most common failure mode), the quality eval harness (LLM-as-judge on ~100 corpus
blocks, spot-calibrated with hand grading), the size floor (small blocks stay
deterministic), and the architecture itself — the full text is always one unfold away,
and the `{#code FOLDED}` tag signals "residue, not the thing." The residual risk is
accepted, measured, and documented, not pretended away.

**Risk: Vertex AI OAuth path.** Shelling to `gcloud` from Rust adds a process
dependency and a 45-minute cache; a stale token or a missing `gcloud` install degrades
gracefully (no summary, falls back to digest) but requires the user to have gcloud
installed. Documented as a setup requirement; once AI Studio credits are funded, the
shell-out is bypassed.

**Risk: cache key collision.** SHA-256 is collision-resistant in practice; this is
not a security context. A SHA-256 collision would serve a wrong summary silently,
but a `PROMPT_VERSION` bump invalidates the slot. The risk is vanishingly small and
the impact bounded by the fallback-to-digest path.

## Rejected alternatives

- **Anthropic API for summaries** — preferred on quality; rejected on available
  billing. The Rust `llm_generate` path is model-agnostic; if AI Studio credits are
  funded, switching the model string is a one-line change. No architectural lock-in.
- **SQLite for the cache** — cleaner at large scale; adds a Tauri plugin or native
  dep. JSONL with an in-memory index is fast enough for realistic sizes; SQLite is a
  defined upgrade path if scale demands it.
- **Summarize on every block above the floor** — wastes credits on blocks that will
  never fold; the 50%-budget trigger and largest-first priority focus spend on blocks
  the conductor is actually likely to use.
- **Same-turn echo of summary in the `unfold` tool result** — not applicable here
  (this is a summarizer milestone, not an unfold mechanism change), but noted for
  completeness: ADR 0005 already deferred same-turn echo on those grounds.
