# The Relevance Lab — a testing surface for the Conductor

> Status: experimental dev tooling, not product surface. This is the C-ladder's
> measurement instrument: **every block gets K independent relevance scores**, so
> competing relevance mechanisms (see [conductor-imaginarium.md](conductor-imaginarium.md))
> can be compared on real sessions before any of them is trusted to drive folding.

## What "relevance" means here

At a **tick** — a chosen point in a session — every block strictly older than the
protected tail receives a score per scorer: *predicted usefulness of this block to
the agent's immediate next work, conditioned on the tail*. The tail is the query;
tail blocks are never scored (the UI shows them as "in tail"). Scores are stored
**raw** per scorer; consumers rank-normalize to [0,1] for display/comparison
(`rankNormalize()` in `app/src/lib/relevance/normalize.ts`) — raw scales are not
comparable across scorers and we don't pretend they are.

## The scorers

| id | name | mechanism | runs |
|----|------|-----------|------|
| `recency` | Recency×Kind | kind prior × exponential turn decay (C1-clamp-shaped baseline) | in-app + harness |
| `actr` | ACT-R activation | base-level activation `ln(Σ t_j^-d)` over reference events (re-mentions of the block's identifiers in later blocks) | in-app + harness |
| `bm25` | Lexical BM25 | identifiers extracted from tail (paths, symbols, quoted strings) scored BM25 against block text | in-app + harness |
| `graph` | Spreading activation | entity co-occurrence graph; activation pumped from tail blocks, decaying per hop | in-app + harness |
| `embed` | Embedding cosine | Vertex `text-embedding-005`, block vs tail, content-addressed cache | harness only |
| `judge` | LLM judge | Vertex `gemini-2.5-flash-lite`, batched 0–10 ratings, strict JSON | harness only |
| `attn` | Attention probe | local ~0.5B model (Python sidecar), attention mass from tail tokens to block spans, sink-corrected | harness only |
| `rerank` | Attention-specific model | trained pruner/reranker per research memo (Provence / cross-encoder class) | harness only |

The four pure-TS scorers run live in the app on any loaded session. The four heavy
ones run offline in the harness and are loaded from a score file.

## Score file schema (v1)

One JSON per session at `~/.accordion/relevance/<sessionId>.scores.json`; the demo
precompute ships at `app/static/sample-relevance.json`. Columnar to stay small:

```jsonc
{
  "version": 1,
  "sessionId": "…",            // store.meta identity
  "generatedAt": "2026-06-10T…",
  "ticks": [{
    "tick": 0,                  // ordinal
    "atBlock": 940,             // blocks [0, atBlock) are scored; [atBlock, end) is the tail
    "blockIds": ["m0:p0", "m1:r", "…"],          // ids of scored blocks, in order
    "scorers": {
      "embed":  { "version": "1", "wallMs": 1234, "costUsd": 0.0021, "params": {} },
      "judge":  { "version": "1", "wallMs": 5678, "costUsd": 0.0144, "params": {} }
    },
    "scores": { "embed": [0.12, 0.78, null, …], "judge": [3, 9, 0, …] }   // raw, aligned to blockIds; null = scorer skipped block
  }]
}
```

## Layout

- `app/src/lib/relevance/` — **Node-safe, browser-safe TS** (no Svelte, no `$lib`
  imports, relative paths only — same discipline as `live/protocol.ts`): types,
  pure tail computation (mirrors `store.protectedFromIndex` exactly), identifier
  extractor, the four pure scorers, normalization, score-file load/validate.
- `scoring/` — harness land, Node-only: `run.mjs` (jiti bootstrap, like
  `extension/smoke.mjs`), Vertex client + caches + spend ledger, eval report
  generator, `probe/` (the quarantined Python sidecar: requirements.txt,
  probe.py, reranker.py).
- Outputs and caches: `~/.accordion/relevance/` (score files, `cache/embed/`,
  `cache/judge/`, `spend.jsonl`). **Never in the repo.**

## Hard rules

- **Privacy:** the repo is public. Corpus-derived artifacts (scores, caches,
  reports quoting session text) stay under `~/.accordion/`. Only artifacts derived
  from the already-public `sample-session.jsonl` may be committed.
- **Spend:** every Vertex call goes through one client that appends to
  `~/.accordion/relevance/spend.jsonl` and refuses to start a batch when
  `spent + projected > $25`. Prices pinned in the client.
- **Engine untouched:** the lab reads sessions through the existing engine
  (`parse.ts`) and re-implements tail logic as a pure function; it does not modify
  `store.svelte.ts` or any fold behavior. The dev view is read-only overlay.
- **Subagents do not commit.** The PM commits.

## Python sidecar contract

The harness prepares per-tick input JSON `{ "tail": "…", "blocks": [{"id", "text"}] }`
(text pre-truncated per scorer policy) and invokes
`python scoring/probe/probe.py --in <file> --out <file>`; the sidecar returns
`{ "scores": {"<blockId>": <raw float>}, "meta": {"model": "…", "wallMs": n} }`.
Same contract for `reranker.py`. Tail/block prep lives in TS so both Python
scorers share identical inputs.

## Eval design

Ticks are sampled at user-turn boundaries through replay (cap ~12 ticks/session,
evenly spaced; always include the final tick). Labels, two tiers:

- **Gold (tiny, trusted):** agent `unfold` events — at every tick before the
  event, the unfolded block is a positive. The corpus currently holds ~6 events
  across 3 sessions; report them separately, never pooled with silver.
- **Silver (volume, biased):** block b is positive at tick t if identifiers
  distinctive to b (appearing in <25% of blocks) re-occur in blocks created within
  the next k=10 turns. **Known bias: silver labels share machinery with `bm25`/
  `actr`/`graph` — those scorers partially "grade their own homework." The report
  must say this in its first paragraph and lean on judge-correlation and gold as
  the counterweight axes.**

Report per session and pooled: Spearman correlation matrix between scorers,
nDCG@10 / precision@10 vs silver, gold-event hit rank, wall-time and cost per
scorer. Output: `~/.accordion/relevance/report.md` (+ a committed
`docs/relevance-lab-results.md` with sample-session numbers only).
