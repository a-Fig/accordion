# Tiered relevance — a level-of-detail conductor for Accordion

> Every block continuously sits at the **fidelity tier its relevance earns**, and the token
> budget decides how generous the tiers are. Fold, unfold, and anti-thrash all fall out of one
> re-tiering computation.

This is an external WebSocket conductor (like [`../attention-folder`](../attention-folder) and
[`../recency-folder`](../recency-folder)): it hosts a WS server, advertises itself under
`~/.accordion/conductors/` for desktop auto-discovery, and Accordion dials in. Select it from the
header conductor switcher once it's running.

## The model

**Tiers** (the four fold levels from the product doc):

| Tier | Name | What the agent sees |
| --- | --- | --- |
| 0 | Full | original text |
| 1 | Trim | a query-aware extractive excerpt (~25%) |
| 2 | Digest | a 1–3 line summary (LLM, or deterministic) + `⟦salience⟧` suffix |
| 3 | Group | a contiguous run collapsed to one head digest + one-line markers |

**Unified relevance** — one score drives everything:

```
r(block) = max( cos(emb(block), emb(goal)), cos(emb(block), emb(trajectory)) )
```

- **goal** = the incoming prompt **+ a maintained task summary** (the stable objective). Folding
  ranks against this — terse prompts ("continue", "fix that") no longer collapse the signal.
- **trajectory** = the protected **working tail** (recent thinking + latest tool activity).
  Anticipatory unfold ranks against this — *where the agent is heading*.

**Hysteresis band [60%, 90%]** of the cap (`min(budget, contextWindow)`):

- **Compress** — when rendered > 90%: deepen the **coldest** units first (depth-first to Digest;
  the marginal unit stops at the shallowest tier that reaches 60%), then collapse contiguous
  Digest runs into Groups.
- **Float-up** — a folded block returns one tier **only when its relevance out-ranks something
  currently live** (the trajectory shifted toward it). It does *not* refill the budget to the
  ceiling, so right after a compression nothing floats — the tiers are stable. This is
  anticipatory unfold, and "out-rank the live set" + "compress folds coldest first" make it
  **structurally thrash-free — no pins, no timers**.
- **Hold** otherwise (emit nothing → the host keeps the last applied state → prompt cache stays warm).

**Guards** (the host also enforces these): `user` blocks never fold; a `tool_call`/`tool_result`
pair moves atomically; malformed/unpaired tool blocks stay full; the protected tail is never
touched; human overrides always win; agent self-unfolds (M3) are respected.

## Run

```bash
npm install        # ws (required). @huggingface/transformers is OPTIONAL (embeddings).
npm start          # node tiered-relevance.mjs
npm test           # node --test  (pure tier algorithm + a WS smoke test)
```

Three capability tiers, each degrading gracefully:

1. **Full** — `@huggingface/transformers` installed (nomic embeddings) **and** a summary provider
   reachable → semantic relevance + LLM digests.
2. **No LLM** — embeddings but no Ollama/Anthropic → semantic relevance, **deterministic** digests.
3. **No models** — neither installed → **keyword-overlap** relevance + deterministic digests. Still
   defends the budget band correctly; just a coarser relevance signal.

Install embeddings explicitly with `npm install @huggingface/transformers` (it's large, hence
optional). Summaries use a local **Ollama** first (`OLLAMA_BASE_URL`, default
`http://localhost:11434`, model `llama3.2:3b`), then **Anthropic Haiku** if `ANTHROPIC_API_KEY`
is set. Block digests are cached by content hash and upgrade in place on a later pass once the
async summary lands; a pass never blocks on them.

## Config (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `TIERS_PORT` | `7702` | WebSocket port |
| `TIERS_HIGH_WATER` | `0.9` | compress when rendered crosses this fraction of the cap |
| `TIERS_LOW_WATER` | `0.6` | compress down to roughly here |
| `TIERS_FLOAT_FLOOR` | `0.3` | absolute cosine floor to float a folded block back up |
| `TIERS_FLOAT_MARGIN` | `0.05` | deadband — a block must clearly out-rank the live set to float |
| `ACCORDION_EMBEDDING_MODEL` | `nomic-ai/nomic-embed-text-v1.5` | embedding model (8k ctx, 768d) |
| `OLLAMA_BASE_URL` / `OLLAMA_SUMMARY_MODEL` | `localhost:11434` / `llama3.2:3b` | local summary provider |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_SUMMARY_MODEL` | — / `claude-haiku-4-5` | cloud summary fallback |

## Files

- `tiered-relevance.mjs` — the WS server: protocol lifecycle, async warm, change-gated emit.
- `tiers.mjs` — the pure LOD equilibrium (compress / float-up / band). The heart; fully unit-tested.
- `relevance.mjs` — embeddings (doc/query prefixes), unified relevance, task-summary upkeep.
- `summaries.mjs` — async L2-digest + task-summary providers (Ollama → Haiku → deterministic).
- `commands.mjs` — tier result → wire commands (replace / fold+digest / group).
- `salience.mjs` · `digest.mjs` · `trim.mjs` · `units.mjs` — pure text/fold helpers ported from
  the original `the_conductor` (salience extraction, deterministic digest, query-aware trim,
  tool-pair atomicity).
- `tiers.test.mjs` · `smoke.test.mjs` — algorithm proofs + a real WS round-trip.

See `../../docs/conductor-protocol.md` for the full wire reference and
`../contract/conductor.ts` for the `ConductorView` / `Command` shapes.
