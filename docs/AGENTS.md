# Repository Guidelines

## Project Structure & Module Organization

This repo has two main surfaces. Root docs (`README.md`, `VISION.md`, `CLAUDE.md`) explain the product direction and current agent handoff notes. `app/` is the active desktop application: a Tauri 2 + SvelteKit app with UI in `app/src/lib/ui/`, model logic in `app/src/lib/engine/`, routes in `app/src/routes/`, static sample data in `app/static/`, and the Rust shell in `app/src-tauri/`. `src/accordion.ts` is the pi extension entry point and `src/conductor.ts` is the Conductor engine that powers real deployments.

## Build, Test, and Development Commands

Run app commands from `app/`:

```bash
npm install
npm run dev       # Vite dev server at http://localhost:1420
npm run tauri dev # native desktop window; requires Rust toolchain
npm run build     # production static build into app/build/
npm run check     # svelte-kit sync plus svelte-check/typecheck
```

Live session bridge: Vite dev middleware at `/api/live-session/events` (same origin as `:1420`); Tauri native uses Rust file watch + events.

## Coding Style & Naming Conventions

Use the existing TypeScript/Svelte style: tabs for indentation, double quotes, semicolons, and explicit types on exported or cross-module APIs. Svelte components use `PascalCase.svelte`; utility modules use lowercase names such as `parse.ts` or `tokens.ts`. Keep engine behavior in `app/src/lib/engine/`; UI components should render store state and call store actions rather than duplicating model rules. Use Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`) in app code.

## Testing Guidelines

There is no dedicated unit test suite yet. Before handing off app changes, run `npm run check`; for UI or engine changes, also run `npm run build` when practical. Verify interactive changes manually in the Vite app and, for native-only behavior, with `npm run tauri dev`. Keep future tests near the code they exercise and name them after the behavior under test.

## Commit & Pull Request Guidelines

Recent commits use short, descriptive subjects such as `Add Accordion desktop app...` or `Map Grid: uniform dice-face tiles...`. Prefer imperative, specific messages that name the affected surface. Pull requests should include a brief problem/solution summary, validation commands run, linked issues when available, and screenshots or short recordings for visual changes.

## Security & Configuration Tips

This repo is public. Do not commit real API keys or private session transcripts. Keep local transcript drops under ignored paths such as `app/static/samples/local/`, and scan sample `.jsonl` files before committing.
