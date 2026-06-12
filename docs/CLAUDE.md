# CLAUDE.md

Guidance for AI coding sessions in this repo. Read [VISION.md](VISION.md) for the
product north star and [README.md](README.md) for the short pitch. This file is
about **how to work in the code**, not what the product is.

Use the precise domain vocabulary from [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md).
"Collapse" and "expand" are command names, not domain terms — use **fold**/**unfold**/**pin**.

## Structure

```
src/          pi extension + Conductor — the deployment layer
app/          Tauri 2 + SvelteKit desktop app — the visualiser
skills/       Agent skill docs loaded by pi
```

## The Conductor (`src/`)

`src/accordion.ts` is the **single pi extension** — it runs the Conductor, hosts the
WebSocket server for the GUI, and registers agent tools. See [CONDUCTOR.md](CONDUCTOR.md)
for the scoring formula, dynamic weights, and fold-level details.

Key files:
- `src/conductor.ts` — `runConductor()`, `parseMessages()`, scoring, summary providers,
  graduated fold levels (0=full · 1=trim · 2=digest · 3=group member).
- `src/accordion.ts` — extension entry point. Wires Conductor into pi's `context` hook,
  WebSocket live-link to GUI, `/accordion`, `/expand`, `/collapse`, `/fold`, `/peek` commands,
  and agent tools (`accordion_recall`, `accordion_unfold`, `accordion_pin`).
- `src/agent-tools.ts` — agent-callable tools. Agents can recall/unfold/pin — **not fold**
  (VISION.md: only you and the Conductor fold).
- `src/conductor.test.ts`, `src/accordion.test.ts`, etc. — deterministic unit tests.

Register in `~/.pi/agent/settings.json`:
```json
{ "extensions": ["<repo>/src/accordion.ts"] }
```

Run tests from repo root:
```bash
npm test               # node --test with experimental-strip-types
npm run test:ollama    # live Ollama integration (needs Ollama running)
```

## The GUI (`app/`)

One route: `/` (`routes/+page.svelte`) — the Map view. Sessions sidebar on the left,
`MapHeader` (composition bar + budget + protect slider) + `ContextMap` (tile grid) +
`Inspector` (on-demand block detail) + `ConductorActivity` (fold decision log).

**Live mode**: GUI connects over WebSocket to `src/accordion.ts`. The Conductor is
authoritative — the GUI mirrors its decisions. User actions (fold/unfold/pin/group)
are sent back as `userAction` messages and take effect on the Conductor's next turn.
`store.liveMode = true` disables the local auto-folder.

**File/demo mode**: GUI loads a JSONL session and runs the local `AccordionStore`
auto-folder (no Conductor, no WebSocket).

### Engine (`app/src/lib/engine/`)

The engine is the source of truth for the local view. **The live Conductor overrides it.**

- `types.ts` — `Block`, `Group`, `Actor` (`"you" | "agent" | "auto" | "conductor"`).
- `store.svelte.ts` — `AccordionStore`. In live mode: `applyLiveSnapshot()` overwrites
  fold state from Conductor snapshots; `digestOf(b)` returns Conductor text (`⟦tN⟧ …`)
  when `liveFoldedDigests` is populated; local `refold()` is a no-op.
- `digest.ts` — local/file-view digest format (`{#code FOLDED} …`). Used only when
  `liveMode` is false.

### Live link (`app/src/lib/live/`)

- `protocol.ts` — wire contract (v5). `SyncMessage` carries block deltas + authoritative
  snapshot (`foldedBlockIds`, `pinnedBlockIds`, `groups`, `foldLevels`, `foldedDigests`).
  `UserActionMessage` carries on-demand GUI actions back to the extension.
- `liveClient.svelte.ts` — connects to extension, ingests snapshots, emits user actions.
- `mapping.ts` — `linearize()` and `blockId()` shared by GUI and extension. Durable
  content-anchored ids: `u:<timestamp>`, `a:<responseId>:p<j>`, `r:<toolCallId>`.
- `registry.ts` — session discovery contract (`~/.accordion/sessions/<id>.json`).

### Four actors (VISION.md permissions)

| Action | You (GUI + cmd) | Agent | Conductor |
|---|:---:|:---:|:---:|
| Fold | ✅ | — | ✅ |
| Unfold | ✅ | ✅ | ✅ |
| Pin | ✅ | ✅ | — |
| Peek | ✅ | — | — |

## Visual grammar

- **kind = color** — `user #6ea8fe · text #aab2c2 · thinking #b483e0 · tool_call #34d3c2 · tool_result #f0a35e` (CSS vars `--k-*`).
- **live = solid / folded = recessed** (dim + faint hatch).
- **Map Grid**: uniform square tiles in conversation order. Token weight = dice face 1–6.
  Split into two boxes at `protectedFromIndex`: older/foldable (thin border) and protected
  tail (thick accented border). Fold level shown in Inspector: trim / digest / group member.

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$derived.by`, `$effect`, `$props`). `ssr = false`, adapter-static SPA. Vite port 1420.
- `{@const}` must be an immediate child of `{#if}`/`{#each}` — use `$derived` otherwise.
- **Canvas perf**: no gradients/filters on the tile grid. Dice pips are cached SVG data-URIs. Tile decorations are inset-only (paint containment from `content-visibility`).

## Running & verifying

```bash
# From app/
npm run dev       # browser dev server → http://localhost:1420
npm run tauri dev # native window (needs Rust)
npm run check     # svelte-check — keep 0 errors / 0 warnings
npm run build     # production static build

# From repo root
npm test          # Conductor + agent-tools deterministic tests
```

Always `npm run check` before declaring done.

## Data & security

- Dev sample: `app/static/sample-session.jsonl` — ~130k-token / ~982-block pi session.
- **Public repo.** Never commit real keys — the sample had one redacted to `REDACTED_API_KEY`.

## Working style

Candid — no undue praise. Only commit / push when explicitly asked.
