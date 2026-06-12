# Test Ready Report

Iteration 3 is complete and the test suite has passed Auditor and Challenger verification. It is ready for the Implementation track to use.

## Test Runner Commands

Fast claim/invariant suite:

```bash
npm run test:claims
```

Full deterministic root suite:

```bash
npm test
```

E2E demo gate:

```bash
bash scripts/e2e-tests.sh
```

## Coverage Summary
Based on the `TEST_INFRA.md` specifications, the current E2E test suite covers the following:

- **Tier 1 (Core Unit / Happy Path)**: ≥5 test vectors per feature verified.
- **Tier 2 (Boundary / Edge Cases)**: ≥5 test vectors per feature (where boundaries exist) covered.
- **Tier 3 (Integration / Pairwise)**: Pairwise coverage of major feature interactions verified.
- **Tier 4 (E2E / Application Scenarios)**: ≥5 realistic application scenarios implemented via the opaque-box constraints.

### Feature Inventory Verification
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---------|--------|:------:|:------:|:------:|:------:|
| 1 | Baseline Comparison | R5 | 5 | 5 | ✓ | 5 |
| 2 | Retrievability Metric | R5 | 5 | 5 | ✓ | 5 |
| 3 | Core Logic Constraints | R3, R4 | 5 | 5 | ✓ | 5 |
| 4 | App Replay Functionality | R1, R2 | 5 | 5 | ✓ | 5 |

The E2E test runner automatically executes requirements validation by verifying script executions, generating and testing file outputs (valid JSONL, benchmark existence), assessing core metrics (Accordion > Baselines), verifying required logic variables, and establishing that banned implementations are not present.

`src/claims.test.ts` additionally locks down the current executable product claims: equal-budget assembly, reversible/non-mutating folds, provider-safe tool pairs, protected working tail behavior, and semantic restore with cached embeddings.
