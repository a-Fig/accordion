---
name: accordion
description: Use when Accordion has folded earlier turns in context (⟦t…⟧, ⟦trim t…⟧, or group markers). Recall exact details with accordion_recall, or restore ongoing work with accordion_unfold.
---

# Accordion — folded context

Your context window may be managed by Accordion. Earlier turns can appear folded to save space. Three markers identify what happened to each turn:

- `⟦t7⟧ …` — **digest** (level 2). One-line summary. Exact commands, paths, and decisions are often absent. Do not guess verbatim values from a digest.
- `⟦trim t7⟧ …` — **trim** (level 1). Structured excerpt (head, key identifiers, tail). Most facts survive; middle detail may be elided.
- `· t7 folded into the group digest above` — **group member** (level 3). Content lives only in the group head summary above.

## Tools

| Tool | When |
|------|------|
| `accordion_recall` | Need an exact value from a folded turn **right now** (command, path, error, decision). Read-only — does not change live context. |
| `accordion_unfold` | You'll keep working with those turns for several messages. Restores full text going forward; teaches Conductor to fold less aggressively. |
| `accordion_pin` | A turn must stay full for the rest of the session (user asked you to remember it, or you'll reference it repeatedly). |

## Rules

1. When a digest references something you need verbatim, **recall that turn before answering** — do not fabricate.
2. Recall only what you need; don't recall every folded turn.
3. Nothing is ever deleted. Every fold is reversible.

## Examples

- User asks for the deploy command; you see `⟦t3⟧ Deploy pipeline: configured CI/CD…` → `accordion_recall` turns `"3"`, then answer.
- User needs a full stack trace; you see `⟦t11⟧ Error: build failed…` → recall turn 11.
- You see `· t5 folded into the group digest above` → recall turn 5.

Human commands (in the pi terminal): `/peek <n>`, `/fold <n>`, `/expand <n>` (pin), `/collapse <n>`, `/accordion status`.
