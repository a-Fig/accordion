# Development

This is the contributor and agent handoff guide for Accordion. Product framing lives in
[README.md](README.md) and [VISION.md](VISION.md); Conductor policy details live in
[CONDUCTOR.md](CONDUCTOR.md).

## Repo Surfaces

```text
src/          pi extension + Conductor deployment layer
app/          Tauri 2 + SvelteKit desktop app
docs/         Product, engine, and development notes
```

Key root files:

- `src/accordion.ts` - pi extension entry point, context hook, WebSocket live-link, slash commands, and agent tools.
- `src/conductor.ts` - `runConductor()`, parsing, scoring, graduated fold levels, digests, summaries, embeddings, and state.
- `src/agent-tools.ts` - agent-callable recall/unfold/pin behavior.
- `src/accordion-skill.ts` - compact instruction block injected when folded context is present.

Key app files:

- `app/src/lib/engine/` - local parsing, token estimates, digests, fold state, protected-tail accounting, groups, and replay behavior.
- `app/src/lib/ui/` - Classic UI.
- `app/src/lib/ui/map/` - Map view.
- `app/src/lib/live/` - live-session protocol, client, mapping, and registry.
- `app/src/routes/+page.svelte` - Classic route.
- `app/src/routes/map/+page.svelte` - Map route.
- `app/src-tauri/` - native shell.

## Commands

Run app commands from `app/`:

```bash
npm install
npm run dev       # Vite dev server at http://localhost:1420
npm run tauri dev # native desktop window; requires Rust
npm run check     # svelte-kit sync plus svelte-check/typecheck
npm run build     # production static build into app/build/
```

Run root commands from the repo root:

```bash
npm test
npm run test:claims
npm run test:ollama
npm run proof:compact
npm run proof:judge
npm run proof:judge:llm
npm run proof:report
```

Live session bridge:

- Vite dev middleware serves `/api/live-session` and `/api/live-session/events` from `~/.pi/agent/accordion-live-session.jsonl`.
- Tauri native uses Rust file watch + events.
- Register the pi extension in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["<repo>/src/accordion.ts"] }
```

## Coding Style

- TypeScript/Svelte style: tabs for indentation, double quotes, semicolons.
- Add explicit types on exported or cross-module APIs.
- Svelte components use `PascalCase.svelte`; utility modules use lowercase names such as `parse.ts` or `tokens.ts`.
- Keep engine behavior in `app/src/lib/engine/`; UI components render store state and call store actions.
- Use Svelte 5 runes (`$state`, `$derived`, `$derived.by`, `$effect`, `$props`) in app code.
- `{@const}` must be an immediate child of `{#if}`/`{#each}`; use `$derived` otherwise.
- Canvas map performance rule: no gradients or filters on the tile grid. Dice pips are cached SVG data URIs, and tile decorations are inset-only.

## Domain Language

Use these terms precisely:

| Term | Meaning | Avoid |
| --- | --- | --- |
| Accordion | Context-management system that preserves original history while sending a budgeted view. | Compactor, summarizer |
| Conductor | Automatic policy that decides which blocks to fold or unfold. | Auto mode |
| Session log | Durable original branch history. | Mutated history |
| Assembled context | Transient message list sent to the model after folding. | Stored context |
| Turn | User-led conversation segment. | Message group |
| Block | Typed unit inside a turn: user text, assistant text, thinking, tool call, or tool result. | Chunk |
| Fold | Replace full content with trim, digest, or group marker. | Collapse, compact |
| Unfold | Restore folded content to full context. | Expand |
| Pin | Sticky user or agent override that keeps a block or turn full. | Lock only |
| Peek | Human UI inspection that does not change agent context. | Unfold |
| Fold level | 0 full, 1 trim, 2 digest, 3 group member. | Compression ratio |
| Working tail | Recent token region never auto-folded. | Recent turns |
| Fold target | Calibrated headroom target inside the budget ceiling. | Budget |
| Deterministic digest | Immediate local digest generated without a network call. | LLM summary |
| Salience suffix | Machine-readable digest suffix for paths, commands, errors, exact values, and decisions. | Metadata blob |

Command names can still be `/expand` and `/collapse`; prose should use unfold and fold.

## Current Tool Surface

Slash commands:

- `/accordion` - status or direct fold pass.
- `/expand <turn>` - pin/restore a turn.
- `/collapse <turn>` - unpin a turn so the Conductor may fold it later.
- `/fold <turn>` - human-initiated reversible fold.
- `/peek <turn>` - human inspection without changing agent context.

Agent tools:

- `accordion_recall` - read full original text of folded turns without changing live context.
- `accordion_unfold` - restore folded turns to full context for upcoming work.
- `accordion_pin` - keep turns full when the user asks the agent to remember them.

The agent does not get a registered fold tool in the current pi extension.

## Claim Map

Fast invariant suite:

```bash
npm run test:claims
```

The claim tests live in `src/claims.test.ts` and are included in `npm test`.

| Claim | Automated check |
| --- | --- |
| Equal-budget operation | Assembled Accordion context stays within `budgetTokens` while exercising at least one fold. |
| Reversibility | `runConductor()` does not mutate original session messages; restoring the view exposes the exact original marker again. |
| Graduated minimal-depth folding | The marginal unit stops at trim when trim covers the need; deeper pressure escalates to digest and group. |
| Calibrated fold target | Corrections raise the target asymmetrically; quiet pressure decays it inside `[0.60, 0.92]`. |
| Trim salience | A buried `KEY=VALUE` identifier survives into the level-1 trim excerpt. |
| Bidirectional memory read | `agentRecall` returns full original text without changing live state. |
| Bidirectional memory write | `agentUnfold` restores full text, survives one-turn pressure, preserves budget, and is attributed to `agent`. |
| Addressable folds | Digest, trim, and group markers carry turn addresses. |
| Provider safety | Valid tool call/result pairs fold atomically; output has no orphaned tool calls/results. |
| Protected working tail | Blocks in the configured working tail are not auto-folded. |
| Semantic restore | Cached embeddings can restore a folded block with no keyword overlap. |
| Risk-aware decisions | Salience suffix markers affect unfold floor, conductor pins, and multi-reason logs. |
| Awareness header | Folded assembled contexts include the short Accordion guidance header. |

Proof commands compare Accordion against equal-budget recency truncation and compact-style baselines:

```bash
npm run proof:compact
npm run proof:judge
npm run proof:judge:llm
npm run proof:report
```

`npm run proof:report` writes `docs/JUDGE_PROOF.md`, which is a generated local artifact.

## Security

This repo is public. Do not commit real API keys or private session transcripts. Keep local transcript drops under ignored paths such as `app/static/samples/local/`, and scan sample `.jsonl` files before committing.

## Commit And PR Notes

Use short, descriptive, imperative commit subjects. Pull requests should include the problem, solution, validation commands, linked issues when available, and screenshots or recordings for visual changes.
