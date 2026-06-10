# ADR 0007 — Cold-Score: the deterministic conductor (Milestone C1)

**Status:** accepted (Milestone C1 in progress)
**Date:** 2026-06-10
**Builds on:** [ADR 0005](0005-agent-unfold.md) (agent unfold + provenance machinery),
[ADR 0006](0006-multiblock-folds.md) (GroupOp wire, group-aware `liveTokens`).
**See also:** [conductor-plan.md](../conductor-plan.md) §C1 for the full work plan.

## Context

The auto-folder today is a **budget clamp**: `refold()` fires only when
`liveTokens > budget`, sorts candidates by a hard-coded `FOLD_RANK` (kind) then
age, and folds oldest-first until the budget is met. It never unfolds anything,
has no notion of relevance or warmth, and has no ground for deciding "this block
is becoming useful again."

The result is correct (budget is always respected, safety invariants always hold)
but brittle: the agent reaches for a folded block and gets a `{#code FOLDED}`
stub, meaning every agent self-unfold (ADR 0005) is, by definition, a miss. The
`unfold` tool is the agent's only recall path.

Three improvements are bundled here as a single milestone because they share
infrastructure (scoring function, warmth map, provenance, corpus, replay driver)
and replacing the clamp piecemeal would require two sets of golden tests:

1. **ACT-R cold-score ordering** — a principled, continuous score replacing the
   binary kind/age sort.
2. **Lexical relevance pre-unfold** — a pass that opens folded blocks the agent is
   about to need, before the agent has to ask.
3. **Warmth memory** — a per-block recall history that feeds the scoring and
   accumulates ground truth for later milestones (C3's replay eval, C5's benchmark).

## Decision

### 1. Three-stage pipeline inside `refold()`

The new pipeline keeps `refold()`'s existing call sites and phase ordering
(triggered by `appendBlocks`, on every live sync); only the internals change:

1. **Heal / reset** (unchanged) — blocks whose `coolUntil` has expired resume
   normal candidacy; blocks in the protected tail that were auto-folded are healed
   to live.
2. **Lexical pre-unfold** — scan the protected tail for identifiers; unfold
   matching auto-folded blocks with provenance `"conductor"`.
3. **Budget clamp** — build the candidate set (auto-folded-eligible blocks older
   than the protected tail); score each by cold-score; fold ascending score until
   under budget. If budget still cannot be met after exhausting candidates under
   hysteresis, a **relaxed second pass** folds over candidates regardless of their
   `coolUntil` value. Budget is the hard guarantee; hysteresis is best-effort.

The three phases have a strict dependency order (heal before pre-unfold before
clamp) and share no mutable state — they are independently testable.

### 2. Cold-score: ACT-R base-level activation with a kind-major prior

The score for a block `b` at the current turn:

```
coldScore(b) = KIND_PRIOR[b.kind] + B(b)
```

where `B(b)` is the ACT-R base-level activation (Anderson & Schooler 1991):

```
B(b) = ln( Σ_j (now_turns − t_j)^(−d_kind) )
```

summed over the block's **retrieval history** `{t_j}` — the creation turn plus
every subsequent recall (agent unfolds, manual unfolds, lexical pre-unfold hits).
`d_kind` is a per-kind decay exponent (`tool_result` decays fastest, `thinking`
slower, `text` slowest), reflecting the empirical observation that tool results
age more steeply than prose.

**Theoretical grounding.** Power-law forgetting is the Bayesian-optimal retention
policy given that real demand follows a power-law recency distribution (Anderson &
Schooler 1991). Folding is betting that the block will not be needed; the ACT-R
activation is the principled estimate of that probability's inverse. When the agent
does need a block (an unfold event), that event is recorded in the history, so the
estimate updates exactly where and when it should.

**Kind-major design — deliberate.** The `KIND_PRIOR` gaps are set so that, with
zero recall history, the ordering reproduces the legacy `FOLD_RANK`-then-age
behavior exactly:

| Kind | Prior |
|------|-------|
| `tool_result` | 0 |
| `thinking` | 8 |
| `text` | 16 |

The maximum activation spread across realistic session sizes is less than 8, so
kind-prior gaps exceed the maximum `B(b)` range. With an empty warmth map,
`coldScore` yields the same ordering as `FOLD_RANK + age`. Recalls reorder blocks
only within a kind — they cannot promote a `tool_result` above a `text` unless
the `text` has been recalled more recently and more often.

**Rejected alternative: fully blended weighted score** (a single continuous number
where kind, recency, recall, and size all interact). More "principled" in the sense
of being a single formula, but it changes the fold ordering wholesale with zero
corpus evidence, breaks backward compatibility with the golden tests, and makes
explaining a fold decision ("why did it fold that?") harder in the inspector.
Kind-major is honest about the known hierarchy while making recall the continuous
variable that reorders within it.

**Pair warmth bonus.** A block whose `callId` partner sits inside the protected
tail gets a small additive bonus (~0.5 on the log scale) — call and result age
together, so if the call is still visible the result is penalized for being folded.
This is a tiebreaker among cold `tool_result` candidates, not a dominating signal.

### 3. Lexical pre-unfold

Before the budget clamp, the pass:

1. Tokenizes the protected tail's text for **identifiers**: file paths
   (`/some/path`, `.\relative\path`), `snake_case` / `camelCase` / `SCREAMING`
   symbols, quoted strings (`"…"` / `'…'`), and numeric literals with units
   (`1420`, `32px`).
2. Applies a **stopword + rarity guard**: an identifier appearing in more than
   `max(3, 25%)` of the current fold candidate set is too common to carry a signal
   (e.g. the word `error` in an error-heavy session) and is removed from the
   trigger set.
3. For every auto-folded durable block whose **full text** (available in the
   engine — folding is substitution, never removal) contains a trigger identifier:
   schedules an unfold with provenance `"conductor"`, reason `matched "<identifier>"`.
4. Caps at **4 auto-folded blocks per pass** (blast-radius control until C3 can
   prioritize by relevance score).
5. Sets `coolUntil = currentTurn + 5` on each unfolded block (hysteresis — see §4).

**Manual (human) folds are never relevance-unfolded.** A block with
`override: "folded"` is exempt. The conductor can only act on blocks it or the
engine put into the auto-folded state (`autoFolded: true`).

The identifier extractor is a pure function, heavily unit-tested. The regex set is
expected to be wrong at least once; the 4-block cap and the rarity guard bound the
cost of a wrong trigger.

### 4. Hysteresis

A relevance-unfolded block (provenance `"conductor"`) is immune to refolding for
**5 turns** via a `coolUntil: Map<id, turn>` in the store. After 5 turns, normal
cold-score candidacy resumes.

Without hysteresis, the lexical pass can unfold a block on turn N and the clamp
can refold it on turn N+1 (if budget is tight), creating a flicker on the agent's
context wire. Group operations use a longer cooldown (~8 turns, see ADR 0009) for
the same reason: a change in message count is more disruptive than an in-place
substitution.

The budget relaxation in the clamp's second pass bypasses `coolUntil` — budget is
the hard invariant; hysteresis is the quality preference that yields under pressure.

### 5. Conductor provenance and `"conductor"` actor

A new `by: "conductor"` value joins `user | agent | auto` in the `Block.by` union.
Conductor actions:

- Are **soft folds** (`autoFolded: true, by: "conductor"`) — they can be reversed
  by the lexical pass, by the agent's `unfold` tool, or by a manual unfold. They
  are never `override: "folded"` (that is the human's exclusive register).
- Appear in the activity log with the reason string ("matched `config.ts`") — every
  conductor action is attributed and explainable.
- Can be re-folded by the budget clamp like any other auto-folded block (they are
  not sticky unless the human or agent pins).

The `"conductor"` actor value propagates to the Transcript view's role chips and
the activity log from this milestone forward; C2–C5 inherit it with zero additional
wiring.

### 6. Warmth memory and the replay driver

A `recalls: Map<id, turn[]>` in `AccordionStore` records every retrieval event:
the block's creation turn (the initial entry) plus every agent unfold, manual
unfold, and lexical pre-unfold hit thereafter. `coldScore` reads this map; it is
the single source of warmth for both the scoring function and the offline replay
eval.

The **replay driver** (`engine/replay.ts`) feeds a corpus JSONL to the store
turn-by-turn (advancing `currentTurn`, calling `appendBlocks` per turn's blocks)
and records, for each turn: blocks folded / unfolded, budget headroom, and whether
any agent-unfold event in the corpus's ground truth was pre-empted by the lexical
pass. This driver is written once here and reused by every later milestone's eval
harness.

**Corpus.** 24 real pi sessions kept at `~/.accordion/corpus` (never committed —
the repo is public and the sessions contain live work details). 18 of the 24
contain real agent-unfold events that serve as ground truth. The corpus is acquired
incrementally starting on day one of C1 and never reaches a "done" state — every
new production session optionally contributes.

## Safety invariants (unchanged)

All invariants from ADR 0004 and 0005 hold unchanged:

1. No GUI / disarmed / reply timeout → messages pass through unmodified.
2. `tool_call` and `user` blocks never fold.
3. The protected working tail is absolute — `refold()` only builds candidates from
   blocks with `i < protectedFromIndex`.
4. Pins overrule the conductor always — a block with `override: "unfolded"` (agent
   sticky) or a human pin is never a fold candidate.
5. Manual folds are never relevance-unfolded — `override: "folded"` blocks skip the
   lexical pass entirely.

## Consequences

**Wins.** The fold ordering is now continuous rather than binary. Blocks with a
real recall history warm up and resist the clamp. The lexical pass gives the agent
a chance of finding its identifiers already open, making the `unfold` tool a
backstop rather than the only path. The warmth map and replay driver build the
infrastructure C3 needs for its offline eval, starting on day one.

**Limitations.** The lexical pass has good precision and mediocre recall. It will
miss conceptual relevance ("the config decision" vs `config.ts`). It will fire
false positives on common symbols. The 4-block cap and rarity guard bound but do
not eliminate churn. These are known characteristics, not defects — C1's job is
the skeleton that C3 swaps a smarter brain into.

**Risk: identifier extractor quality.** The regex set will be wrong at least once
before it is right. Mitigation: the extractor is a pure function with heavy unit
tests; the corpus replay catches churn above threshold before live sessions see it.

**Risk: ACT-R parameter choice.** `d_kind` exponents and `KIND_PRIOR` gaps are
tuned on the sample session and corpus, not derived from a large dataset. They may
not generalize. Mitigation: the replay driver makes re-tuning cheap; the
kind-major design ensures the base case (no recall history) is identical to the
battle-tested legacy clamp.

## Rejected alternatives

- **Fully blended weighted score** — changes fold ordering wholesale before there
  is corpus evidence to support it; breaks golden-test compatibility. Rejected in
  favor of kind-major + activation within kind.
- **Cosine similarity / embeddings for relevance** — Anthropic has no embeddings
  API; a local model adds a runtime dependency for a gain that a lexical pass
  approximates well enough for C1. Deferred to C3's LLM tick if the lexical pass
  proves clearly insufficient.
- **Unfold on every identifier match (no cap)** — blast radius too large; a
  common symbol in the tail would explode the live context. The 4-block cap is a
  deliberate conservative ceiling until C3 can rank by score.
- **Per-kind decay derived from Anderson & Schooler's empirical constants** —
  their study uses words and human episodic memory, not LLM agent tool outputs.
  Use the theoretical shape (power law), tune the constants empirically.
