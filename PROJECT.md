# Project: Accordion Hackathon Demo

## Architecture
- `src/generate-demo-transcript.ts`: Generates the scenario, runs Accordion and baselines, produces JSONL transcript and benchmark report.
- `app/`: Desktop app that plays back the transcript (replay, group folds, live bridge).
- `src/conductor.ts`: Core Accordion engine (unmodified logic/constants).

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Scenario & Benchmark Generation | Create `src/generate-demo-transcript.ts`. Must build a realistic coding scenario, run Accordion + standard baselines (recency-truncation, summarize-then-drop). Generate `demo-transcript.jsonl` and benchmark report. Use a model-independent retrievability metric. No needle strings in `src/`. | none | PLANNED |
| 2 | App Replay | Update `app/` to playback the JSONL transcript. Must legibly show folding, digest retention, and semantic unfold. | M1 | PLANNED |
| 3 | Final Milestone: E2E Verification | Pass all E2E tests and checks (npm test, npm run check, constant verification, no needles in src). | M1, M2 | PLANNED |

## Interface Contracts
### `src/generate-demo-transcript.ts` ↔ `app/`
- Output: A valid JSONL transcript compatible with the app's parser (fold/unfold decisions, digests, etc.).
- Output: A benchmark report proving retrievability metrics for Accordion vs Baselines.

## Code Layout
- Demo script: `src/generate-demo-transcript.ts`
- App UI: `app/src/lib/ui/` and `app/src/routes/`
- Transcripts: `app/static/samples/local/`
