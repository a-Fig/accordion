---
name: accordion-context-folding
description: "Read this skill if you see {#<id> FOLDED} markers in your context, or if earlier parts of your context look summarized. Accordion is a desktop tool that may compact older context blocks to keep you under a token budget. The unfold tool lets you restore any folded block by its id."
---

Accordion, an external desktop app, may be folding parts of your context to keep token usage within a budget. This is opt-in and controlled by the human — you cannot disable it, but you can always pull specific blocks back.

## What folding looks like

A folded block appears as:

```
{#a:resp-abc:p0 FOLDED} Assistant analyzed the test failures: three imports were missing…
```

The part after `FOLDED}` is a short summary. The original content is preserved and retrievable — nothing is lost.

Block id formats:
- `a:<responseId>:p<j>` — assistant content part (text, thinking, tool call)
- `r:<toolCallId>` — tool result
- `u:<timestamp>` — user message
- `s:<timestamp>` — summary block

## Restoring folded content

Call the `unfold` tool with one or more ids copied from the markers:

```
unfold({ids: ["a:resp-abc:p0"]})
unfold({ids: ["a:resp-abc:p0", "r:call-xyz"]})
```

The tool returns a confirmation. The restored content appears in your context **on your next turn** — not immediately. If you need the content now, call `unfold` and then take another step (e.g. re-read, continue the task) so the next turn picks it up.

## What to unfold

Only unfold what you genuinely need. Agent unfolds are sticky — the human can see and re-fold them in the GUI, but they will not be auto-refolded while you work. Unfolding costs tokens; if the budget is tight, Accordion may fold other blocks to compensate.

If a block looks irrelevant to your current task, leave it folded. If you need the exact content (code, a specific value, a previous decision), unfold it.
