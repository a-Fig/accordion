# ADR 0011 — Nested groups: hierarchical folding for C4

**Status:** accepted (Milestone C4 engine start)
**Date:** 2026-06-10
**Builds on:** [ADR 0006](0006-multiblock-folds.md) (flat groups, group wire ops),
[ADR 0009](0009-auto-coalesce.md) (conductor coalesce pipeline, groupCool hysteresis),
[ADR 0005](0005-agent-unfold.md) (fold tags), [ADR 0004](0004-engine-on-fold-toggle.md)
(opt-in armed folding).

---

## Context

C2.5 (auto-coalesce, ADR 0009) builds flat conductor-managed groups (episodes) from
adjacent folded blocks. C4 adds the next rung: adjacent folded groups coalesce upward
into parent groups (eras). A multi-day session can then hold thousands of turns as a
2–3-level tree of era/episode summaries. The key property from VISION.md: "one unfold
reveals member summaries, not full text" — resolution decays with distance, and you
drill down level by level to recover full text.

**This ADR covers the engine model only.** The wire protocol (extension/protocol.ts),
the extension (accordion.ts), and the UI (ContextMap) are explicitly out of scope for
this cut. The wire stays flat (see §4).

---

## Decision

### 1. Tree model: `Group.children` (parallel to `memberIds`)

The `Group` interface gains an optional `children` field:

```ts
interface Group {
  id: string;
  memberIds: string[];    // leaf BLOCK ids (unchanged — always blocks, flat)
  children?: string[];    // child GROUP ids, if this is a parent group
  folded: boolean;
  by?: Actor;             // conductor | you — unchanged
}
```

**`memberIds` always carries LEAF BLOCK IDS, never group ids.** A parent group's
`memberIds` is the union of all its descendants' leaf block ids. This means
`memberIds` is redundant for a parent (it can be derived from the tree), but it is
kept because:

- Every existing consumer of `memberIds` (`computeGroupOps`, `applyPlan`,
  `classifyGroup`, `groupAt`) continues to work without change.
- Wire flattening (`computeGroupOps`) can emit the correct `GroupOp.memberIds`
  (the leaf ids the extension needs) without walking the tree at call time.
- `applyPlan` never needs to know about nesting — the wire was always flat.

**The invariant:** a block's `memberIds` entry appears in EXACTLY ONE group across
the entire `groups` array (the existing non-overlap invariant, unchanged).

### 2. Recursive token accounting

The existing `groupWire` derived map and `effTokens` generalize correctly through
the existing path as long as:
  a) `groupWire` is built for ALL groups (not just top-level), and
  b) when a PARENT group is folded, its children are skipped in `groupWire` to avoid
     double-counting their leaf blocks.

This is handled by building `groupWire` from the full `groups` array but first
collecting the set of child group ids that are subsumed by a folded parent — those
child groups are skipped so their memberIds don't get double-entered in the map.

**Invariant (tested):** `liveTokens` = `fullTokens` − `savedTokens` holds at every
depth.

### 3. Level-by-level unfold semantics

`unfoldGroup(id)` has two behaviors depending on whether the group is a parent:

- **Leaf group (no `children`):** unchanged — sets `folded = false`, members render
  live with their own per-block fold state.
- **Parent group (has `children`):** sets the parent `folded = false`, but the
  child groups remain `folded = true`. The display then renders: the parent band
  open, each child as a collapsed tile (their own folded group tile). One unfold
  reveals child SUMMARIES, not full text.

The existing `groupCool` hysteresis (ADR 0009 §5) applies to both leaf and parent
groups. Existing `foldGroup`, `deleteGroup`, and `createGroup` (for the manual/leaf
case) are unchanged.

**Agent self-unfold (ADR 0005/0006):** the group's `{#code FOLDED}` tag works at
every level. `resolveUnfold` routes the code to `unfoldGroup(id, "agent")`, which
follows the level-by-level rule — the agent unfolds one level per request.

### 4. Wire flattening: `computeGroupOps` skips subsumed children

When emitting a `GroupOp` for a folded TOP-LEVEL group, `computeGroupOps` already
uses `g.memberIds` — and since `memberIds` is always leaf block ids (§1), it already
emits the correct flat list for `applyPlan`.

For nested groups:
- Only TOP-LEVEL folded groups (groups with no parent, or whose parent is unfolded)
  emit a `GroupOp`. A child group whose parent is also folded is skipped (subsumed).
- `computeGroupOps` builds a `subsumedByFoldedParent` set and skips those groups.

**`applyPlan` needs NO changes.** Its input is still `GroupOp[]` with flat member
block ids.

### 5. `pruneProtectedGroups` generalizes to any depth

The existing rule "no group may reach into the protected tail at ANY depth" is
extended: if a group (at any level) has ANY leaf member in `memberIds` that maps to
an index >= `protectedFromIndex`, dissolve that group.

Dissolving a parent group orphans its children — they become top-level groups and are
retained if they themselves are unprotected. The pruning code collects dissolved group
ids, filters out dissolved groups, and for surviving parent groups removes dissolved
children from their `children` list (clearing it if empty).

The `groupCool` hysteresis is set when dissolving conductor-built groups, same as
before.

### 6. `createParentGroup(childGroupIds)` — internal, for the coalescing schedule

A new internal method `createParentGroup(childGroupIds: string[]): Group | null`
creates a parent group from a list of existing child group ids. It:
- Validates that all child groups exist, are folded, and are not already members of
  another group (no overlap).
- Computes `memberIds` as the union of all children's `memberIds` (already leaf ids),
  sorted in block order.
- Validates the combined set against the protected tail.
- Sets `children = childGroupIds`, `by = "conductor"`, `folded = true`.
- Uses `era:` id prefix to avoid collision with child `g:` ids.
- Returns the new group, or null if any validation fails.

`createGroup(startId, endId)` stays unchanged — the manual creation path produces
only leaf groups.

### 7. Upward coalescing schedule: `findEraRuns` in `engine/coalesce.ts`

C2.5's flat auto-coalesce policy lives in `engine/coalesce.ts`. C4 extends it with
`findEraRuns`:

```ts
function findEraRuns(groups: Group[], blocks: Block[], currentTurn: number,
                     blockIndex?: ReadonlyMap<string, number>): string[][]
```

Constants (alongside C2.5's `COALESCE_CONFIG`):
- `MIN_ERA_GROUPS = 4` — minimum adjacent folded groups to form an era.
- `ERA_AGE_TURNS = 300` — all member blocks must be at least this many turns old.
- `MAX_ERA_GROUPS = 20` — max child groups per era.

"Adjacent" means their `memberIds` span contiguous blocks with only user-kind blocks
allowed as separators (conductor episodes are naturally bounded by user turns).

**Era formation is wired into `_runCoalesce`** (after episode formation), guarded by:
- `groupCool` hysteresis (same as episode formation — checks the first child group's
  first member id).
- Net-savings guard: if the era summary is MORE expensive than the sum of its child
  summaries (very unlikely with the deterministic digest), the era is dissolved
  immediately via `deleteGroup`.

### 8. Recursive recaps: `groupEraDigest` for a parent group

Added to `engine/digest.ts`. For now deterministic — LLM upgrade is C2's job:

```
{#<era-code> FOLDED} era · <N> episodes · <M> blocks · turns X–Y · ~<T> tok
  episode 1: <first line of child 1's summary>
  episode 2: <first line of child 2's summary>
  …
```

Built by detecting `g.children` in `groupSummary` — if present, call `groupEraDigest`
with child groups' own summaries; if absent, use the existing member-block digest.

---

## Differences from the reference design (agent-aa949e43578df5607)

The reference agent built this scope against a pre-conductor base. This implementation
differs in:

1. **Era formation IS wired into `_runCoalesce`** (the reference left it unwired).
   `findEraRuns` runs after episode formation in the conductor pipeline, guarded by
   the same hysteresis + net-savings pattern.

2. **`groupCool` hysteresis composes.** `unfoldGroup` and `deleteGroup` already set
   `groupCool` for conductor groups — this implementation preserves that behavior
   for both leaf and parent groups. The `unfoldGroup` level-by-level change keeps the
   existing `groupCool` assignment intact.

3. **`by: "conductor"` on parent groups.** `createParentGroup` sets `by: "conductor"`
   on the new group so hysteresis and net-savings logic applies to eras the same way
   it does to episodes.

4. **`findEraRuns` lives in the existing `coalesce.ts`** alongside `findCoalesceRuns`
   and `COALESCE_CONFIG` (not a separate file), keeping the coalesce policy co-located.

---

## Scope / limitations (this cut)

- **Engine-only.** No UI changes (the existing `buildDisplay` renders the tree's
  current cut via existing flat group rendering — a parent group is just another
  `Group` entry when folded; when unfolded, its children appear as their own tiles
  in the same groups array passed to `buildDisplay`).
- **No wire/protocol changes.** The extension and `applyPlan` are untouched.
- **`createGroup` (manual path) stays flat.** Only `createParentGroup` (internal,
  used by the coalescing schedule) creates parent groups.
- **No LLM recaps.** All summaries are deterministic digests. LLM upgrade is C2.
- **No UI tree rendering.** The Map renders the current cut correctly with the
  existing canvas/display logic.

---

## Safety invariants (unchanged from ADR 0006)

1. All ADR 0004/0005/0006/0009 invariants hold. Group collapse rides `folding.enabled`.
2. `applyPlan` input is always flat `GroupOp[]` with leaf block ids — nested vs.
   flat is an engine/GUI concept only.
3. No group at ANY depth may reach into the protected tail.
4. `memberIds` is always leaf block ids; parent-group membership is tracked via
   `children`.
5. The non-overlap invariant extends across all levels: a leaf block appears in
   exactly one group's `memberIds`.
6. Era formation is guarded by the same `groupCool` hysteresis and net-savings guard
   as episode formation — conductor groups never increase live cost.
