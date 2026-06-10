# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Guidance for AI coding sessions in this repo. Read [VISION.md](VISION.md) for the
product north star and [README.md](README.md) for the short pitch. This file is
about **how to work in the code**, not what the product is.

Use the precise domain vocabulary from [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md)
when discussing or writing about context assembly, folding, blocks, turns, and scoring.
"Collapse" and "expand" are command names, not domain terms — use **fold**/**unfold**/**pin**.

## Where the live work is

The active surface is the **desktop app** in `app/` — a Tauri 2 + SvelteKit window
that visualizes an agent's context window. Two routes:

- `/`  — **Classic** view (`routes/+page.svelte`): `ContextSummary` / `ContextTimeline`
  toggle on top, a scrollable `Timeline` of `BlockCard`s, activity feed.
- `/map` — **Map** app (`routes/map/+page.svelte`): an abstraction-first view.
  `MapHeader` (composition strip + budget) + `ContextMap` + `Inspector` (on-demand
  text panel). This is where most recent design iteration lives.

Both routes independently `fetch("/sample-session.jsonl")` and construct a fresh
`AccordionStore` in `onMount`. There is no shared layout-level store.

`src/` (repo root) holds the **pi extension and Conductor** — actively developed,
not the UI focus, but the engine that powers real deployments.

## The engine is the source of truth — use it, don't change it

`app/src/lib/engine/` owns the model. The UI only renders it and calls its actions.

- `types.ts` — `Block { id, kind, turn, order, text, tokens, toolName?, callId?, override, autoFolded, by }`.
  Kinds: `user · text · thinking · tool_call · tool_result`.
- `parse.ts` — pi / Claude Code JSONL → typed blocks. **`tool_call` and `tool_result`
  are separate blocks sharing a `callId`** (call = durable "what it did"; result =
  "what it saw", decays fast). An assistant message's thinking/text/call share an
  `id` prefix before `:`.
- `store.svelte.ts` — `AccordionStore` (Svelte runes). API: `blocks`, `budget`/`setBudget`,
  `isFolded(b)`, `effTokens(b)`, `digestOf(b)`, `toggle/fold/unfold/pin/unpin(id)`,
  `resetAll()`, `liveTokens`, `fullTokens`, `savedTokens`, `foldedCount`, `overBudget`,
  `log`, `meta`. Exposed as `window.__store` for debugging.
  - **Protected working tail:** `protectTokens` (default `20_000`) reserves the newest
    ~N tokens of context so the auto-folder never touches recent reasoning. `protectedFromIndex`
    walks back from the newest block summing full `tokens` and returns the index where the
    sum first reaches `protectTokens` (blocks at that index and later are protected; always
    at least the newest block; `0` if the whole session is smaller than the window).
    `isProtected(b)` and `protectedTokens` are the reads. `refold()` only builds fold
    candidates from blocks with `i < protectedFromIndex` — i.e. older than the tail. Manual
    `fold()`/`pin()` are unaffected; protection constrains the automatic folder only.
    `setProtect(n)` resizes the tail and re-folds — wired to a header slider (0–60k).
- `tokens.ts` (chars/4 estimate) · `digest.ts` (what a kind collapses to when folded).

Folding is **content substitution, never removal** — provider-safe and fully reversible.

## The Conductor (root `src/`)

The root `src/` module is the **pi extension and Conductor** — the real deployment layer.
See [CONDUCTOR.md](CONDUCTOR.md) for scoring formula, dynamic weights, constants, and
summary provider details.

Key files:
- `src/conductor.ts` — `runConductor()`, `parseMessages()`, scoring, summary providers
  (`createHaikuSummaryProvider()`, `createOllamaSummaryProvider()`). Constants like
  `DEFAULT_BUDGET_TOKENS = 150_000` live at the top of this file.
- `src/accordion.ts` — the pi extension entry point; wires Conductor into pi's `context`
  event and registers `/accordion`, `/expand`, `/collapse` commands.
- `src/conductor.test.ts` / `src/accordion.test.ts` — deterministic unit tests.
- `src/ollama-summary.live.ts` — live integration test against a local Ollama instance.

Run the deterministic tests from the repo root:

```bash
npm test               # node --test with experimental-strip-types
npm run test:ollama    # live Ollama integration (needs Ollama running locally)
```

## Visual grammar (consistent across ALL views)

- **kind = color** — `user #6ea8fe · text #aab2c2 · thinking #b483e0 · tool_call #34d3c2 · tool_result #f0a35e` (vars `--k-*` in `app.css`).
- **live = solid / folded = recessed** (dim + faint hatch, never a heavy dark hatch).
- In the **Map Grid**: every block is the **same-size square**, laid out in strict
  conversation order (uniform size ⇒ no reflow holes ⇒ linearity is free). Token
  **weight is read as a dice face 1–6** (more pips = heavier block). Current
  thresholds in `ContextMap.svelte → faceFor()`: ≥500→2, ≥1500→3, ≥5000→4, ≥10000→5,
  ≥50000→6, else 1. Arrow keys traverse blocks (←/→ = prev/next, ↑/↓ = ± one row).
  The grid is split into **two rounded boxes stacked like paragraphs**, divided at
  `store.protectedFromIndex`: the top box holds older/foldable blocks (thin border);
  the bottom box holds the protected tail and has a **meaningfully thicker, accented
  border** to signal protection (`.box.prot`). No text labels — the border does the
  talking. Each box holds its own uniform grid; order is continuous across both.

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$derived.by`, `$effect`, `$props`).
  `ssr = false`, adapter-static SPA fallback (so `/map` direct-loads). Vite port 1420.
- **Plain JS/TS** — no fancy build steps beyond SvelteKit.
- `{@const}` must be an immediate child of `{#if}`/`{#each}` — otherwise use a `$derived`.
- This Svelte's `svelte-ignore` only honors the **first** code in a multi-code comment.
- **Performance: do not paint many live gradients/filters across the 982-tile grid.**
  Radial gradients and per-element `filter` re-rasterize on every repaint and tank
  interaction. The dice pips are **one cached SVG data-URI per face** (decoded once,
  blitted) — keep that pattern for anything tile-dense.
- **Scroll perf on the tile grid:** `.cell` uses `content-visibility: auto` +
  `contain-intrinsic-size: var(--cell)` to cull off-screen tiles, and hover is
  instant (no `transition`) so scrolling past tiles doesn't animate a repaint storm.
  Because `content-visibility` implies paint containment, keep tile decorations
  **inset** (the selection ring is inset-only) — outset box-shadows get clipped.

## Running & verifying

```bash
# From app/
npm run dev          # browser dev server → http://localhost:1420
npm run tauri dev    # native desktop window (needs Rust toolchain)
npm run check        # svelte-check / typecheck — keep it 0 errors / 0 warnings
npm run build        # production static build into app/build/

# From repo root
npm test             # Conductor + accordion extension deterministic tests
```

Always `npm run check` (from `app/`) before declaring done.

## Data & security

- Dev sample: `app/static/sample-session.jsonl` — a real ~130k-token / ~982-block pi
  session. Most blocks are small (<500 tok); the largest is ~5k, so dice faces 5–6
  won't appear on this sample.
- **This repo is public.** The sample once contained a live API key (redacted to
  `REDACTED_API_KEY`). **Never commit real keys** — scan sample data before pushing.

## Working style

Be candid — no undue praise, no overselling. The owner reviews by screenshot and
makes the design calls; surface tradeoffs plainly and let them decide. Only commit /
push when explicitly asked.
