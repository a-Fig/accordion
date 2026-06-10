# E2E Test Infra: Accordion Hackathon Demo

## Test Philosophy
- Opaque-box, requirement-driven.
- Automated verification of constraints (no needles in src, `npm test`, `npm run check`, constants unchanged).

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | Baseline Comparison | R5 | 5 | 5 | ✓ |
| 2 | Retrievability Metric | R5 | 5 | 5 | ✓ |
| 3 | Core Logic Constraints | R3, R4 | 5 | 5 | ✓ |
| 4 | App Replay Functionality | R1, R2 | 5 | 5 | ✓ |

## Test Architecture
- Use `npm test` and `npm run check` as standard.
- Specific assertions to check `src/` for needles (grep).
- Run `generate-demo-transcript.ts` to ensure it runs without errors and produces expected files.

## Coverage Thresholds
- Tier 1: ≥5 per feature
- Tier 2: ≥5 per feature (where boundaries exist)
- Tier 3: pairwise coverage of major feature interactions
- Tier 4: ≥5 realistic application scenarios
