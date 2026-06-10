# Accordion Claim Tests

This file maps product claims to automated checks. It is intentionally narrower than the product vision: each row below is an executable claim about current code, not a marketing statement.

Run the fast claim suite with:

```bash
npm run test:claims
```

The claim tests live in `src/claims.test.ts` and are included in `npm test`.

## Covered claims

| Claim | Automated check |
| --- | --- |
| Equal-budget operation | Assembled Accordion context stays `<= budgetTokens` while exercising at least one fold. |
| Reversibility | `runConductor()` does not mutate original session messages; restoring the view exposes the exact original marker again. |
| Graduated minimal-depth folding | The marginal unit stops at trim (level 1) when trim covers the need; deeper need escalates to digest; deep pressure groups contiguous digests — and originals stay byte-identical at every level (`src/levels-calibration.test.ts`). |
| Calibrated fold target | Corrections raise the target asymmetrically and idempotently within `[0.60, 0.92]`; quiet pressure decays it to the floor; proactive unfolds count as corrections; `fixedFoldTarget` pins it (`src/levels-calibration.test.ts`). |
| Trim preserves buried salience | A `KEY=VALUE` identifier buried mid-block survives into the level-1 trim excerpt. |
| Bidirectional memory · read | `agentRecall` returns the full original text of folded turns without changing live state or messages (`src/agent-tools.test.ts`). |
| Bidirectional memory · write | An agent-issued `agentUnfold` restores full text on the next assembly, survives fold pressure for one turn (grace), keeps the budget invariant, and is attributed to actor `agent` in the decision stream. |
| Agent corrections teach the Conductor | An agent unfold counts as a correction: the calibrated fold target rises by `CALIBRATION_UP_STEP` on the next pressure-active turn. |
| Folds are addressable | Every fold level carries a `⟦t…⟧` turn address (digests, trims, group members), so the agent and the human can target them. |
| Provider safety | Fold decisions for a valid tool call/result pair are atomic, and assembled output has no orphaned tool calls/results. |
| Protected working tail | Blocks in the configured working tail are not auto-folded and remain full text in output. |
| Semantic restore | A folded block with no keyword overlap is restored when cached embeddings make it semantically relevant. |
| Structured salience in digests | A block containing a file path, shell command, error string, key=value pair, or decision language has those facts categorized and appended as a `⟦paths: … ∣ commands: …⟧` suffix in its level-2 digest (`src/conductor-improvements.test.ts`). |
| Risk-aware unfold floor | A folded block whose digest contains `commands`, `paths`, `exact_values`, or `decisions` markers has a lower effective proactive-unfold floor than one without risk markers (`src/conductor-improvements.test.ts`). |
| Conductor pin prevents auto-fold | A conductor-pinned block is not auto-folded for up to `CONDUCTOR_PIN_LIFETIME` turns; the pin expires automatically and expiry does not count as a calibration correction (`src/conductor-improvements.test.ts`). |
| Human fold overrides conductor pin | `agentFold` and human manual fold actions succeed even on conductor-pinned blocks (`src/conductor-improvements.test.ts`). |
| Multi-reason decision logging | `FoldDecision.reason` is an array of all applicable factors; unfold decisions include `digest_has_risk_flag:*` when risk markers were present (`src/conductor-improvements.test.ts`). |
| Context-awareness header injected | When the assembled context has folded blocks, the first assistant message contains the awareness note with correct turn list and pressure label; no header appears when nothing is folded (`src/conductor-improvements.test.ts`). |

## What this does not prove

These tests do **not** prove UI quality, real provider acceptance, or that Accordion beats every possible human-written compact summary. They prove core invariants on deterministic fixtures. Use the benchmark/proof grid below for comparative retrieval claims, and use live smoke/manual provider tests for live integration claims.

## Related proof commands

For broader retrieval/baseline claims, use the existing proof grid:

```bash
npm run proof:compact
npm run proof:judge
npm run proof:judge:llm
npm run proof:report
```

Those compare Accordion against recency truncation and compact-style baselines under equal token budgets.

## Demo/E2E artifacts

The demo generator writes ignored local artifacts:

- `demo-transcript.jsonl`
- `benchmark-report.json`
- `app/static/samples/local/demo-transcript.jsonl`

They are reproducible and should not be treated as source. Regenerate with:

```bash
node --experimental-strip-types src/generate-demo-transcript.ts
```
