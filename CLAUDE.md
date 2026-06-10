# CLAUDE.md — Accordion

Guidance for AI coding sessions in this repo. Read [VISION.md](VISION.md) for the
product north star and [README.md](README.md) for the short pitch. This file is
about **how to work in the code**, not what the product is.

## Where the live work is

The active surface is the **desktop app** in `app/` — a Tauri 2 + SvelteKit window
that visualizes an agent's context window. A **single route** (`routes/+page.svelte`):
the **Map** app, an abstraction-first view. In the desktop app it's a shell — a
**`SessionsSidebar`** (a top **source switcher** — live pi sessions via the pull model,
*or* read-only **Claude Code** transcripts browsed from `~/.claude/projects`; minimizable
to a slim icon rail, plus a pinned **Demo session** that loads the bundled sample) + the
session view:
`MapHeader` (composition strip + budget) + `ContextMap` + `Inspector` (on-demand text
panel). `ContextMap` carries a **2-way segmented control: `Map` | `Transcript`** — **Map**
is the abstraction (the uniform dice-square grid) and **Transcript** is the concretion (a
readable, scrollable full-chat view: blocks as cards in conversation order, each with a
kind-colored left spine and a role label — You / Assistant / Thinking / Tool call / Tool
result; live blocks show full text, folded blocks show the exact `{#code FOLDED}` digest the
agent sees; inline Fold/Unfold per card + double-click to fold, single click = inspect).
The old **Classic** view (summary/timeline of `BlockCard`s) and the earlier 3-way
**Grid / Turns / Chains** zoom switch were both removed; their components
(`ContextSummary` / `ContextTimeline` / `Timeline` / `BlockCard`) and `chains.ts` are gone.

The current pi extension is **`extension/accordion.ts`** (the live link — see below).
`src/` (repo root) and `visualizer/` are the *older* pi-extension POC and the
standalone HTML visualizer — not the focus; touch only if asked. Don't confuse
`src/accordion.ts` (old POC) with `extension/accordion.ts` (current).

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
  `log`, `meta`, and `appendBlocks(blocks)` (used by the live link to stream new
  blocks in). Exposed as `window.__store` for debugging.
  - **Protected working tail:** `protectTokens` (default `20_000`) reserves the newest
    ~N tokens of context so the auto-folder never touches recent reasoning. `protectedFromIndex`
    walks back from the newest block summing full `tokens` toward that target, but refuses
    to pull in the next older block if doing so would exceed a strict 25% whole-block
    overflow cap (except the newest block, which is always protected even if it alone
    exceeds the cap; `0` if the whole session fits under the target/cap).
    `isProtected(b)` and `protectedTokens` are the reads. `refold()` only builds fold
    candidates from blocks with `i < protectedFromIndex` — i.e. older than the tail. Manual
    `fold()` is also refused in the protected tail, and a folded block that later becomes
    protected heals back to live; `pin()` remains allowed because it keeps content open.
    `setProtect(n)` resizes the tail and re-folds — wired to an on-bar draggable handle
    on the composition strip (0–60k, step 2k; the real refold is deferred to pointer-release
    so dragging doesn't re-fold continuously).
- `tokens.ts` (chars/4 estimate) · `digest.ts` (what a kind collapses to when folded).
- `score.ts` — `coldScore(block, ctx)`, ACT-R base-level activation with a kind-major
  prior. Score = `KIND_PRIOR[kind] + ln Σ (now − t_j)^(−d_kind)` over the block's retrieval
  history (creation turn + every subsequent agent/manual/lexical recall). Kind-major by
  design: prior gaps (tool_result=0, thinking=8, text=16) exceed the max activation spread,
  so zero-history ordering reproduces the legacy `FOLD_RANK`-then-age exactly. Pair-warmth
  bonus for blocks whose `callId` partner is in the protected tail. Tunable via exported
  `SCORE_CONFIG` object (priors, decay exponents, pair-warmth bonus, recall floor).
- `lexical.ts` — `extractIdentifiers(tailText)`: file paths, snake_case/camelCase/SCREAMING
  symbols, quoted strings, numeric literals. `matchBlocks(identifiers, candidates)`:
  returns a Map of block-id → matched identifier for auto-folded durable blocks whose
  full text matches any trigger. Pure functions, heavily unit-tested.
- `coalesce.ts` — `findCoalesceRuns(input)`: deterministic policy returning
  `CoalesceRun[]` — runs of ≥ 8 contiguous auto-folded durable blocks, older than the
  protected tail, bounded by user-message seams, no pins/manual-folds inside, member cap
  12 / full-text token cap 15k. Tunable via exported `COALESCE_CONFIG`. Pure, Node-safe.
- `replay.ts` — `replaySession(blocks, opts)` / `replaySessionAsync(blocks, opts)`:
  feeds a block array through the store turn-by-turn, records budget violations, fold
  churn, and miss/preempt events. `onTurn` async hook lets the caller inject a conductor
  tick between turns. Eval backbone for all later milestones.
- `summaryCache.ts` — `summaryKey(input)` (SHA-256 of blockText+kind+promptVersion+model),
  `CacheEntry`, `SummaryCacheMem` (in-memory index built on load). Cache file at
  `~/.accordion/summaries/cache.jsonl`. **`PROMPT_VERSION` in `prompts.ts` is the cache
  invalidation lever — bumping it makes old entries stale silently; always bump it when
  changing prompt text.**

**`refold()` pipeline** (order is strict; phases share no mutable state):
1. **Heal/reset** — expire `coolUntil` timers; heal protected-tail blocks back to live.
2. **Lexical pre-unfold** — extract identifiers from the protected tail; unfold matching
   auto-folded blocks (provenance `"conductor"`, reason `matched "<identifier>"`); cap 4
   per pass; set `coolUntil = turn + 5` on each.
3. **Budget clamp** — score all unprotected auto-folded-eligible candidates with
   `coldScore`; fold ascending score until under budget. Relaxed second pass ignores
   `coolUntil` if budget still can't be met — budget is the hard guarantee, hysteresis
   is best-effort.
4. **Auto-coalesce** — after the clamp, `findCoalesceRuns` identifies runs for grouping;
   the store calls `createGroup` with provenance `"conductor"`, reason
   `"auto-coalesced: N cold blocks"`, group hysteresis cooldown ~8 turns.

**Summary layer.** `store.digestOf(block)` checks `SummaryCacheMem` first; falls back to
`digest.ts`. The `{#code FOLDED}` prefix (ADR 0005) is always prepended verbatim —
immutable regardless of whether a summary or a deterministic digest follows. `effTokens`
uses the cached summary's `tokens` field when available; this is handled at the store
layer, not in `digest.ts` (which stays sync/pure). Group summaries (`groupSummary`) are
a summary-of-member-summaries call, cached under the same scheme.

**`conductorFold(id, reason)` / `conductorUnfold(id, reason)`** — thin store wrappers
over `fold`/`unfold` that set `by: "conductor"` and log the reason to the activity log.
Same refusal guards apply: pins/tail/kind/cooldown untouchable. Tick output always feeds
through these wrappers, never bypassing engine guards.

Folding is **content substitution, never removal** — provider-safe and fully reversible.

## The live link (`app/src/lib/live/` + `extension/`)

How the app attaches to a *running* pi session and steers its context.
Two halves talk over a loopback WebSocket; **"GUI drives, extension is thin"** — the
extension makes no folding decisions, it streams pi's messages and applies whatever
plan the app returns. Decisions live in ADRs: [0001](docs/adr/0001-pi-live-integration.md)
(the loop) and [0002](docs/adr/0002-pull-connection-model.md) (how they find each other).

- **Shared contract — imported by *both* sides** (extension via relative path, app via
  `$lib`), so the wire and safety rules have one home. Keep these dependency-free /
  Node-safe (no Svelte, no `$state`):
  - `protocol.ts` — wire messages (`hello` / `sync` / `plan`), `WireBlock`, `FoldOp`,
    `PROTOCOL_VERSION`. Block ids encode message location (`m<i>:p<j>`, `m<i>:r`, …).
  - `mapping.ts` — `linearize(messages)` (mirrors `engine/parse`) and the **pure,
    kind-checked** `applyPlan(messages, ops)` (a `tool_call` is never folded → never
    orphans its result; recent messages are backstopped).
  - `registry.ts` — the **discovery** contract: `SessionEntry`, `FocusRequest`,
    `isLiveEntry`, and the `~/.accordion/` layout. The Tauri Rust layer mirrors these
    constants — change them in lockstep.
- **App side (Svelte):** `liveClient.svelte.ts` (WS *client* → builds the live store),
  `discovery.svelte.ts` (polls native discovery, reaps stale sessions, handles focus),
  rendered by `ui/live/SessionsSidebar.svelte` on the `/map` shell.
- **Extension side (Node):** `extension/accordion.ts` hosts the WS *server* on an
  **ephemeral** port and advertises the session in `~/.accordion/sessions/<id>.json`
  (5 s heartbeat; deleted on shutdown). `/accordion` writes `~/.accordion/focus.json`.
- **Native discovery (Rust):** `app/src-tauri/src/lib.rs` — `list_sessions`,
  `reap_session`, `take_focus_request`, `focus_window`. A browser tab can't read the
  registry, which is why discovery is desktop-only (browser dev has a manual-port box).

**Read-only Claude Code browsing (separate from the live link).** The source switcher's
*Claude Code* mode lists static transcripts under `~/.claude/projects/<proj>/*.jsonl`.
Two Rust commands own this (`lib.rs`): `list_claude_sessions` (walks the projects dir,
skips nested `subagents/`, newest-50 by mtime, head-reads ≤96 KB to pull a title —
`ai-title`→`summary`→first-user-msg — plus cwd/project) and `read_claude_session` (a
path-confined read used to load **and tail** the file — the JS `fs` plugin's scope does
*not* cover programmatic reads of `~/.claude`, only dialog-picked files, so Rust owns
that access). App side: `live/claude.ts` (the `ClaudeCodeSession` type + guard) and
`live/claudeDiscovery.svelte.ts` (a 3 s poll that runs only while the CC tab is active).
A CC session loads through the engine like the demo, so local fold/unfold/pin/peek all
work as a personal lens — but `session.readOnly` is set (the `MapHeader` shows a
**READ-ONLY** badge) and there is no wire to steer. **Known limitation:** an *actively
appended* CC session re-runs `_load` on each tail tick, which rebuilds the store and
drops manual folds; static transcripts (the common case) never re-load. The durable fix
is an incremental `appendBlocks` tail like the WS path.

**Conductor tick scheduling (C3, `app/src/lib/conductor/`).** After every live sync
settles, `liveClient.svelte.ts` calls `requestTick("sync")` which schedules a 400 ms
debounced tick via `attachConductor` / `scheduler.svelte.ts`. Tick logic is in
`conductor/tick.ts` (pure, Node-safe except for the `AccordionStore` type import):
`buildIndex` → `buildTailText` → `tickPrompt` (from `llm/prompts.ts`) → `llmGenerate`
(Tauri command) → `parseTickDecision` → `applyTickDecision` → `recordTick` + `noteAction`.
Single-in-flight: a newer tick supersedes a pending one. Hard cap
`MAX_TICKS_PER_SESSION = 300` in `scheduler.svelte.ts`. The tick only runs when
`conductor.mode === "attentive"` and `llmAvailable()` — no LLM calls in deterministic
or off mode.

**Miss metrics and telemetry.** `conductor/telemetry.ts` owns two fire-and-forget writers:
- `metricsWrite(record)` → `~/.accordion/metrics.jsonl` (one record per agent
  `unfoldRequest`; fields: `at`, `sessionKey`, `mode`, `codes`, `perCode` with
  `{code, wasFolded, restored}` per code). `wasFolded=true` + tick hadn't unfolded = miss;
  `wasFolded=false` = preempt. Counters surface in `conductor/state.svelte.ts`
  (`conductor.misses`, `conductor.preempts`) and the ConductorPanel.
- `distillWrite(sessionKey, record)` → `~/.accordion/distill/<sessionKey>.jsonl` (one
  record per tick; fields: `at`, `turn`, `model`, `promptVersion`, `budget`, `live`,
  `entries[]`, `decision`, `usage`). D0 training data — accumulates from day one.

Both are no-ops outside the Tauri desktop runtime. Uses `accordion_append_line` (Rust
path-confined helper in `lib.rs`). **Never log API keys or gcloud tokens** — the Rust
layer holds credentials; telemetry records contain only fold codes and summary text.

**Corpus.** 24 real pi sessions at `~/.accordion/corpus` (never commit — the repo is
public). 18 of 24 contain real agent-unfold events that serve as ground truth. The
replay eval results live at `docs/eval/conductor-replay-eval.md` (living doc; check
before quoting numbers — the eval is in progress).

**Conductor state** lives in `conductor/state.svelte.ts`: `conductor` ($state object —
`mode`, `busy`, `ticks`, `costUSD`, `misses`, `preempts`, `lastActions`). `ConductorMode`
= `"off" | "deterministic" | "attentive"`. `ConductorPanel.svelte` renders the three-way
segmented control (OFF / AUTO / SMART) plus busy dot, cost, miss/preempt counters, and
the action popover.

**Invariants (don't break):** discovery I/O is best-effort and **never blocks or alters
a model call**; no GUI / reply timeout / empty plan ⇒ messages pass through untouched;
no disk I/O on the `context` (pre-model-call) hook. **The engine is now on (M2, ADR
0004) but folding the live agent is OPT-IN and OFF by default** (`folding.enabled`, a
header toggle). Disarmed, the GUI still replies with an empty plan — M1 behavior, no
model call altered. Armed, `computePlan` mirrors the engine's fold decisions into ops
via `computeFoldOps` (`plan.ts`), guarded so only **durable-id** `text`/`thinking`/
`tool_result` blocks are ever folded (`isDurableId`; `applyPlan` enforces the same).

**M3 — agent self-unfold ([ADR 0005](docs/adr/0005-agent-unfold.md)):** the engine's
`digest()` now prefixes every folded block's digest with `{#<code> FOLDED}`, where
`<code>` is a short stateless hash of the durable block id (`foldCode` — a raw id is a
UUID/timestamp, too noisy to repeat). This is the single source of truth: the GUI renders
the exact string the agent receives, and token accounting includes the tag — no separate
wire representation, no drift (only foldable kinds — text/thinking/tool_result — are tagged,
since only those are ever sent folded). The extension registers an `unfold` pi tool: the
agent calls `unfold({codes: [...]})` with code(s) copied from the tags, the GUI resolves
each code to its folded block(s) (a rare hash collision restores all matches) and marks
them unfolded (sticky, provenance `"agent"`), and the full content returns on the agent's
**next turn** (state-change-only; no content echo this cut). The agent can only unfold a
block that is actually folded — it can't downgrade a human pin. Agent unfolds show in the
activity log; the human can re-fold them. The skill `accordion-context-folding` is
auto-exposed via `resources_discover` — no manual loading.

**Post-turn view sync:** the extension's `agent_end` and `message_end` handlers (ADR
0003) push view-only syncs without a fold plan, so an assistant reply is seen at the
turn it completes rather than waiting for the next user turn. The `context` hook still
drives the fold plan; view-only syncs carry no plan. This was the C3 "view-sync gap"
prerequisite — it was already closed before C3 landed (verified in smoke tests).

## LLM access (`app/src/lib/llm/` + Rust `llm_generate`)

The app calls LLMs for two things: block summarization (C2) and conductor ticks (C3).
Both paths go through the same Rust `llm_generate` Tauri command — the key and gcloud
token never enter the webview.

**Provider chain (implemented in `app/src-tauri/src/lib.rs`):**
1. Check `GEMINI_API_KEY` env var → try AI Studio (`generativelanguage.googleapis.com`).
2. On 429 / absent key → shell `gcloud auth print-access-token`, cache 45 min → Vertex AI
   `us-central1 gemini-2.5-flash-lite`. Requires gcloud installed and authenticated.
3. Neither available → `LlmError("unavailable")` → caller falls back to deterministic
   digest. No crash, no silent failure.

**Module map:**
- `llm/types.ts` — `LlmRequest`, `LlmResponse`, `LlmError` (kinds: `unavailable | quota |
  http | parse`).
- `llm/gateway.ts` — `llmGenerate(req)` (thin Tauri shim), `llmAvailable()`.
- `llm/prompts.ts` — **single prompt home**. `PROMPT_VERSION` (summary cache invalidation
  key); `TICK_PROMPT_VERSION` (tick prompt invalidation key — also here). Per-kind summary
  templates (`summaryPrompt(kind, blockText, toolName?)`); `tickPrompt(TickPromptInput)`
  builds the numbered-index + tail-window prompt for the conductor tick. **Always preserve
  file paths, symbol names, and quoted strings verbatim** — that is the highest-priority
  quality constraint in every prompt.
- `llm/summaryQueue.svelte.ts` — `attachSummaryQueue(store)` → detach fn. Concurrency 2
  (`MAX_INFLIGHT`), 400-call/session cap (`MAX_CALLS_PER_SESSION`). Pricing constants `PRICE_IN_PER_M`
  / `PRICE_OUT_PER_M` (gemini-2.5-flash-lite list prices). Accumulates cost into
  `conductor.costUSD` via `recordTick`.
- `scripts/lib/llm-node.mjs` — **Node twin for offline evals and the replay driver.** Same
  POST logic using Node's `fetch`; imports `prompts.ts` via jiti. Duplication is
  intentionally limited to transport only — the prompts are not duplicated.

**NEVER log API keys or access tokens.** The Rust layer holds credentials; telemetry and
distill records contain only fold codes and summary snippets.

## Visual grammar (consistent across ALL views)

- **kind = color** — `user #6ea8fe · text #aab2c2 · thinking #b483e0 · tool_call #34d3c2 · tool_result #f0a35e` (vars `--k-*` in `app.css`).
- **live = solid / folded = recessed** (dim + faint hatch, never a heavy dark hatch).
- In the **Map Grid**: every block is the **same-size square**, laid out in strict
  conversation order (uniform size ⇒ no reflow holes ⇒ linearity is free). Token
  **weight is read as a dice face 1–6** (more pips = heavier block). Current
  thresholds in `ContextMap.svelte → faceFor()` (upper bounds, "up to"): ≤100→1, ≤500→2,
  ≤1.5k→3, ≤5k→4, ≤15k→5, >15k→6. Arrow keys traverse blocks (←/→ = prev/next, ↑/↓ = ± one row).
  The grid is split into **two rounded boxes stacked like paragraphs**, divided at
  `store.protectedFromIndex`: the top box holds older/foldable blocks (thin border);
  the bottom box holds the protected tail and has a **meaningfully thicker, accented
  border** to signal protection (`.box.prot`). No text labels — the border does the
  talking. Each box holds its own uniform grid; order is continuous across both.

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$derived.by`, `$effect`, `$props`).
  `ssr = false`, adapter-static SPA fallback (so `/map` direct-loads). Vite port 1420.
- **Plain JS/TS** — no fancy build steps beyond SvelteKit.
- **Engine config objects are mutable on purpose for evals.** `SCORE_CONFIG` (`score.ts`),
  `COALESCE_CONFIG` (`coalesce.ts`), and `HYSTERESIS` (`store.svelte.ts` — fields:
  `unfoldCooldownTurns`, `maxLexicalUnfoldsPerPass`) are exported plain objects so vitest
  and the replay driver can override individual fields per-test without module-level
  hacks. Don't freeze them or inline their values.
- `{@const}` must be an immediate child of `{#if}`/`{#each}` — otherwise use a `$derived`.
- This Svelte's `svelte-ignore` only honors the **first** code in a multi-code comment.
- **Performance: do not paint many live gradients/filters across the 982-tile grid.**
  Radial gradients and per-element `filter` re-rasterize on every repaint and tank
  interaction. The dice pips are **one cached SVG data-URI per face** (decoded once,
  blitted) — keep that pattern for anything tile-dense.
- **Scroll perf on the tile grid:** the win came from killing hover repaints during
  scroll, not from culling. `ContextMap` sets `class:scrolling` on the stage while a
  scroll is in flight and clears it ~140 ms after it stops; `.stage.scrolling .grid`
  drops `pointer-events: none` so the cursor can't trigger per-tile hover repaints
  mid-scroll. The `.boxes` get GPU layer promotion (`transform: translateZ(0)`) and
  hover is instant (no `transition`). `content-visibility`/`contain-intrinsic-size`
  were **removed** from `.cell` (they hurt more than helped here). Keep tile
  decorations **inset** (the selection ring is inset-only) — outset box-shadows clip.

## Running & verifying

```bash
cd app
npm run dev          # browser dev server → http://localhost:1420 (UI iteration only)
npm run tauri dev    # native desktop window — REQUIRED for live session discovery
npm run check        # svelte-check / typecheck — keep it 0 errors / 0 warnings
npm run test         # vitest — unit tests for the risky live/mapping logic
```

```bash
cd extension && node smoke.mjs   # drives the extension via jiti + a real WS client
cd app/src-tauri && cargo check  # the native discovery layer (PowerShell — see below)
```

Live discovery (the Sessions sidebar) only works in the **desktop** app — the browser
build can't read `~/.accordion/`, so it falls back to a manual-port Connect box.

Environment gotchas (Windows, this repo's usual setup):

- **cargo is not on the Bash tool's PATH.** Run `npm run tauri dev` from PowerShell
  with `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\.rustup\bin;$env:PATH"`.
- The dev server and `tauri dev` both want **port 1420** — only one at a time. Free it
  with `Get-NetTCPConnection -LocalPort 1420 | Stop-Process` before swapping.
- The preview/screenshot MCP has been **flaky** here (captures time out even when the
  page is healthy); verify via `preview_eval` / `preview_inspect` and `svelte-check`.
- Always `npx svelte-check --tsconfig ./tsconfig.json` before declaring done.

## Data & security

- Dev sample: `app/static/sample-session.jsonl` — a real ~130k-token / ~982-block pi
  session. Most blocks are small (<500 tok); the largest is ~5k, so under the current
  faceFor() bounds the sample spans roughly faces 1–4 (face 6 = >15k won't appear).
- **Session corpus:** `~/.accordion/corpus` — 24 real pi sessions (local only, never
  commit). 18 of 24 contain agent-unfold events used as ground truth for replay evals.
  The corpus grows incrementally; every new production session may contribute.
- **Telemetry paths (local only, never commit):** `~/.accordion/metrics.jsonl` (miss/preempt
  events per agent unfold-request), `~/.accordion/distill/<sessionKey>.jsonl` (one record
  per conductor tick, D0 training data), `~/.accordion/summaries/cache.jsonl` (immutable
  summary cache). Same best-effort I/O rules as the session registry — never on the
  `context`-hook path.
- **This repo is public.** The sample once contained a live API key (redacted to
  `REDACTED_API_KEY`). **Never commit real keys, session data, or corpus files** — scan
  sample data before pushing.

## Working style

Be candid — no undue praise, no overselling. The owner reviews by screenshot and
makes the design calls; surface tradeoffs plainly and let them decide.
