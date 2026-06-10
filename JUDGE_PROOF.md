# Accordion Judge Proof

Generated: 2026-06-10T17:20:30.067Z

## Claim

Accordion preserves buried, semantically referenced facts under tight context budgets better than compact-style summarization. The strongest current automated evidence is answer-scored: the model must answer the final prompt from each assembled context, and known decoy answers are rejected.

## Current Evidence

| Run | Proof date | Model | Baseline | Cells | Accordion | Baseline | Advantage | Accordion wins | Baseline wins | Accordion budget violations |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Semantic judge grid vs compact-style digest/drop | 2026-06-10T17:15:20.914Z | llama3.2:3b | summarize-then-drop | 14 | 100% | 28.6% | 71.4pp | 10 | 0 | 0 |
| Semantic judge grid vs model-generated compact summary | 2026-06-10T17:20:10.543Z | llama3.2:3b | llm-compact | 14 | 100% | 0% | 100pp | 14 | 0 | 0 |
| Broad exact + semantic grid vs compact-style digest/drop | 2026-06-10T17:13:42.221Z | llama3.2:3b | summarize-then-drop | 48 | 100% | 50% | 50pp | 24 | 0 | 0 |
| Local-model paraphrase smoke | 2026-06-10T17:20:17.704Z | llama3.2:3b | summarize-then-drop | 1 | 100% | 0% | 100pp | 1 | 0 | 0 |
| Cloud-model paraphrase smoke | 2026-06-10T17:20:29.789Z | minimax-m3:cloud | summarize-then-drop | 1 | 100% | 0% | 100pp | 1 | 0 | 0 |

## Optional Host /compact Capture

- Not captured yet: `compact-comparison-judge-external-semantic.json`. Generate captures with `npm run compact:external-template`, fill `compact-captures.json`, then run `npm run proof:judge:external`.

## Proof Gate Status

All report-level proof gates passed.

## Representative Failures Of Compact

### Semantic judge grid vs compact-style digest/drop

- `semantic-preference-late` at budget 1500: summarize-then-drop 703 tokens, Accordion 1201 tokens.
  - summarize-then-drop: There is no mention of Maya liking any onboarding design in the conversation.
  - Accordion: Maya preferred the ivy layout for her onboarding arrangement.
- `semantic-preference-late` at budget 2500: summarize-then-drop 703 tokens, Accordion 1201 tokens.
  - summarize-then-drop: There is no mention of Maya liking any onboarding design in the conversation.
  - Accordion: Maya preferred the ivy layout for her onboarding arrangement.
- `semantic-dashboard-preference` at budget 1500: summarize-then-drop 701 tokens, Accordion 1202 tokens.
  - summarize-then-drop: There is no mention of a preference for a specific dashboard concept by Rina in the conversation.
  - Accordion: The opal panel.

### Semantic judge grid vs model-generated compact summary

- `semantic-cache-store` at budget 1500: llm-compact 187 tokens, Accordion 1109 tokens.
  - llm-compact: It seems I've been provided with the same text again. There's no new conversation context to summarize. If you'd like to discuss the project or ask a question, I'm here to help!
  - Accordion: Redis.
- `semantic-cache-store` at budget 2500: llm-compact 187 tokens, Accordion 1109 tokens.
  - llm-compact: It seems I've been provided with the same text again. There's no new conversation context to summarize. If you'd like to discuss the project or ask a question, I'm here to help!
  - Accordion: Redis.
- `semantic-offline-sync` at budget 1500: llm-compact 319 tokens, Accordion 1139 tokens.
  - llm-compact: It seems that we were in the middle of discussing the implementation notes. To continue, I think it would be helpful to summarize or process the data in some way. However, I'd like to clarify what these implementation notes represent and how they should be used.

Before proceeding, I'll answer your question about disconnected edits: It's generally recommended to review and merge any pending changes before the network comes back online to ensure consistency and accuracy.
  - Accordion: Queue writes until reconnect, then replay them in original order after a fresh server version check.

## Reproduce

```bash
npm test
npm run proof:refresh
```

## Real /compact Capture Path

```bash
npm run compact:external-template
# Replay each setupTranscript in the host, invoke /compact before finalPrompt, fill compact-captures.json.
npm run proof:judge:external
```

External captures reject blank summaries by default, and generated templates keep `finalPrompt` out of `setupTranscript` so `/compact` does not see the question before evaluation.

## Caveat

This report proves Accordion against deterministic compact-style and local model-generated compact baselines. A judge-grade host comparison should add filled `compact-captures.json` from actual `/compact` runs and then rerun `npm run proof:judge:external`.
