# 🪗 Accordion — desktop app

The Accordion window is a Tauri + SvelteKit app that shows an agent's context as typed blocks and lets you inspect, fold, unfold, pin, group, and replay context locally. It is the supported UI surface; the old standalone `visualizer/` prototype has been removed.

## What is here

- **Classic view (`/`)** — summary/timeline view with block cards and an activity feed.
- **Map view (`/map`)** — abstraction-first grid with budget/composition header, protected-tail split, Inspector, group cards, replay controls, and conductor settings.
- **Engine source of truth** — `src/lib/engine/` owns parsing, token estimates, digests, fold state, protected-tail accounting, groups, and replay behavior. UI components render store state and call store actions.
- **Built-in live dev bridge** — Vite serves `/api/live-session` and `/api/live-session/events` from `~/.pi/agent/accordion-live-session.jsonl`, replacing the old port-8080 visualizer server for development.

## Architecture

```text
src/lib/engine/          model and folding rules
src/lib/ui/              Classic UI components
src/lib/ui/map/          Map UI components
src/lib/server/          Node-only Vite live-session bridge
src/routes/+page.svelte  Classic route
src/routes/map/+page.svelte  Map route
src-tauri/               Tauri desktop shell
```

## Run

```bash
npm install
npm run dev            # browser dev server at http://localhost:1420
npm run tauri dev      # native desktop window (needs Rust toolchain)
npm run build          # static production build → build/
npm run check          # svelte-check / typecheck
```

## Notes

- Sample data lives under `static/` and `static/samples/`.
- Local generated demo transcripts belong under ignored `static/samples/local/`.
- The root test/proof tooling lives one level up (`npm test`, `npm run test:claims`, proof scripts).
