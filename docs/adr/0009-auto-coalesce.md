# ADR 0009 — Auto-Coalesce: conductor-built flat groups (Milestone C2.5)

**Status:** accepted (Milestone C2.5 in progress)
**Date:** 2026-06-10
**Builds on:** [ADR 0006](0006-multiblock-folds.md) (GroupOp wire machinery, group fold
codes, agent group-unfold — reused unchanged), [ADR 0007](0007-cold-score-conductor.md)
(conductor provenance, hysteresis, coldScore — coalescing runs after the clamp),
[ADR 0008](0008-gemini-summarizer.md) (LLM group recaps — coalescence is only a win
when recaps carry meaning).
**See also:** [conductor-plan.md](../conductor-plan.md) §C2.5 for the full work plan.

## Context

After C1 + C2, a long session in steady state looks like this: dozens of individually
auto-folded blocks, each presenting a `{#code FOLDED} <summary>` stub in the context
window. Suppose 60 blocks are folded — that is 60 separate stubs, each occupying a
few dozen tokens, totalling ~1–2k tokens of pure residue. Worse, the agent's context
holds 60 separate `content` parts (or messages), adding parse overhead and cluttering
the C3 summary index that the tick must reason over.

The `GroupOp` wire machinery (ADR 0006) collapses a range of messages into one
synthetic summary entry. What is missing is the **policy** for when the conductor
should use it automatically. C2.5 adds that policy: a deterministic, no-LLM-in-the-
decision coalescing rule that identifies runs of long-cold, auto-folded blocks and
collapses them into single episode entries.

**Why C2.5 depends on C2.** Pre-summaries, a group recap is a concatenation of
deterministic digests — a list of skeletal stubs. Coalescing fifty stubs into one
stub loses the per-block granularity that the lexical pass and the agent's reading
depend on, saving stub overhead while making old context *more* opaque. With C2's
cache, `groupSummary` is a summary-of-summaries — one readable episode line. The
per-block detail was already compressed; the group just removes the per-block clutter.
C2.5 immediately after C2 is the correct sequencing.

## Decision

### 1. Coalescing rule — deterministic, model-free

The coalescing pass runs **after** C1's budget clamp (it only ever considers blocks
the clamp has already folded; it is a second compression stage, not a replacement for
the first). A run of blocks is a valid coalescing candidate iff **all** of the
following hold:

1. **Contiguous** in block order, with no non-member blocks in between.
2. **Auto-folded and conductor-managed** — every block has `autoFolded: true` and
   `by: "auto"` or `by: "conductor"`. A block with `override: "folded"` (human fold)
   or `override: "unfolded"` (agent sticky) breaks the run.
3. **Durable ids throughout** — all blocks in the run have durable ids (ADR 0003
   guard, inherited from ADR 0006's "whole messages only" constraint).
4. **Age floor: older than ~20 turns** — ensures the run is genuinely cold and not
   transitively inside C1's hysteresis window. The age floor is measured from the
   newest block in the run.
5. **Bounded by user-message seams** — the run does not cross a `user` block
   boundary. User blocks never fold; they are the natural episode boundaries. A run
   between two user turns is a single logical episode.
6. **No pins or manual folds inside** — `override: "folded"` or human-pinned blocks
   inside the run prevent coalescing, preserving the human's intent.
7. **Does not reach the protected tail** — `pruneProtectedGroups` (ADR 0006) already
   enforces this; inherited unchanged.
8. **Minimum run length: ≥ 8 contiguous members.** Below this threshold, the stub
   overhead is small and the blast-radius risk of a full-group restore is not worth
   the compression gain.

### 2. Blast-radius caps

Until C4's level-by-level unfold exists, a group is all-or-nothing: an unfold
restores every member at full text in one operation. Aggressive coalescing with no
size bounds could spike the context by tens of thousands of tokens on a single
lexical hit. Two caps bound this:

- **Member count cap: ~12 blocks** — keeps the full-restore spike survivable. If a
  run exceeds the cap, it splits into two or more sub-runs, each coalesced
  independently (as long as each sub-run meets the minimum length).
- **Full-text token cap: ~15k tokens** — a group whose members' full text totals more
  than ~15k tokens is split at the token boundary. This prevents a single ancient
  tool dump from generating an unmanageable restore spike.

These numbers are initial estimates, tuned against the corpus replay before shipping.
C4's level-by-level unfold is the proper fix to the blast-radius problem; these caps
are the bounded-risk mitigation in the interim.

### 3. Groups built with `"conductor"` provenance

Conductor-built groups are attributed identically to per-block conductor actions
(ADR 0007 §5):

- `group.by = "conductor"` (a new field mirroring `block.by`).
- The reason string in the activity log: `"auto-coalesced: <N> cold blocks"`.
- The group is **not** a manually-created group — it is never surfaced in the
  "edit group" UI as user-managed. The conductor can dissolve and re-form it; the
  user can delete it like any group.

The `GroupOp` wire format (ADR 0006, `protocol.ts`) is reused unchanged. No
protocol version bump is needed; conductor-built groups produce the same
`{id, memberIds, summaryText}` triples as manual groups.

### 4. Partial restore and re-coalesce flow

A group unfolds (by agent request or lexical hit) in one of two ways:

- **Full restore:** the entire group unfolds. Normal group-unfold path (ADR 0006).
  All members return live. The group is dissolved; the conductor may re-coalesce
  after the group hysteresis cooldown (~8 turns — see §5).
- **Partial restore (lexical hit):** the lexical pre-unfold pass (ADR 0007 §3) hits
  an identifier inside one or more group members. Because a group is a unit, the
  whole group unfolds. The matched blocks get `coolUntil = currentTurn + 5`
  (block hysteresis). The remaining cold members — not matched, not touched by the
  human or agent — are eligible for re-coalescing after the group's own hysteresis
  expires (~8 turns), forming a new smaller group if they still meet the rule.

The re-coalesce flow goes through the normal coalescing pass on the next qualifying
turn. No special "re-coalesce" code path is needed; the rule §1 naturally re-selects
the cold remainder once hysteresis clears.

### 5. Group hysteresis: longer than block hysteresis

Block hysteresis (ADR 0007) is 5 turns. Group hysteresis is **~8 turns**. The
difference is deliberate: a `GroupOp` changes the **message count** in the context
window, not just in-place content. A forming/dissolving group cycle makes the agent's
context structurally different across consecutive turns — the kind of churn that
confuses tool-call tracking and role-alternation checks. Block-level churn is a
content flicker; group-level churn is a structural flicker. Group decisions earn a
longer cooling window.

The relaxed second-pass budget override (ADR 0007 §1) does not apply to group
decisions — the budget clamp operates on per-block folding only. A group dissolve
that puts the session over budget resolves by the per-block clamp re-folding the
individual members, not by accelerating re-coalescing.

### 6. Token accounting and the summary index

A coalesced group's token contribution is `groupSummary` tokens (one entry), as
in manual groups (ADR 0006 §5). The C3 summary index (ADR 0010) sees the group as
**one entry** — kind `group`, turn range, token count, folded state, and the summary
text. This is the primary payoff: a 60-block stretch of ancient tool calls becomes
one line in C3's index rather than sixty, cutting the tick's prompt size on long
sessions.

## Safety invariants

All ADR 0004/0005/0006 invariants hold. Coalescing rides `folding.enabled` (off by
default, reset on every attach). `applyPlan` re-derives the wire collapse
independently of the GUI (defense in depth, ADR 0006). The conductor never coalesces
into the protected tail, never touches pins or manual folds, and never produces an
orphaned tool-call/result pair.

**The deterministic budget clamp (ADR 0007) always runs last.** If a group dissolve
puts the session over budget, the per-block clamp restores balance — the conductor's
coalescing policy is overridden by the budget guarantee, never the reverse.

## Consequences

**Wins.** Ancient history folds to a handful of episode lines rather than hundreds of
stubs. C3's tick prompt shrinks materially on long sessions, reducing per-turn cost.
The Map grid's tile count drops for long sessions, reducing scroll overhead. Group
recaps are meaningful (C2's summaries underlie them). The wire's message count drops,
reducing provider parse overhead.

**Risk: blast radius on full restore.** A 12-member, ~15k-token group restores all at
once if the agent or lexical pass triggers it. With C2's summaries, the group recap
was informative enough that the agent might not need the full restore — but if it
does, the spike is real. Mitigation: the caps in §2, tuned conservatively on the
corpus; the correct fix is C4's level-by-level unfold.

**Risk: group churn.** If the age floor or minimum-length threshold is set too low,
groups form and dissolve frequently. The 8-turn hysteresis and the corpus replay churn
metric bound this. If tuning cannot get churn below the threshold on real sessions,
the coalescing age floor should be raised, not the hysteresis.

**Risk: re-coalesce after partial restore creates smaller and smaller groups** —
progressively less useful, eventually below the minimum length, and thus never
re-formed. This is the correct behavior, not a bug: a block that has been restored
multiple times is warming; it should stay individually folded where C1's scoring
handles it.

## Rejected alternatives

- **Coalesce before C2** — generates concatenated skeletal digests; makes old
  context more opaque. Firmly rejected; C2 is a hard prerequisite.
- **LLM in the coalescing decision** — the rule is purely structural (contiguity,
  age, kind, size); there is nothing ambiguous for a model to resolve. The LLM is
  in the recap (`groupSummary`), not the decision. Using a model call here would
  add latency and cost to a decision a deterministic rule makes correctly.
- **Unlimited group size** — without C4's level-by-level unfold, the blast radius
  is the dominant risk. The caps are conservative by design.
- **Coalesce groups into groups (nested)** — flat is the invariant here; nesting is
  C4's job. The `Group.memberIds` contract in ADR 0006 is `string[]` of block ids;
  extending it to include group ids is the C4 refactor, not a shortcut available now.
