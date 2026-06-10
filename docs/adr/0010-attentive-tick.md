# ADR 0010 — Attentive Tick: the between-turns LLM conductor (Milestone C3)

**Status:** accepted (Milestone C3 in progress)
**Date:** 2026-06-10
**Builds on:** [ADR 0007](0007-cold-score-conductor.md) (cold-score + lexical pre-unfold
+ warmth map — the deterministic layer the tick runs on top of),
[ADR 0008](0008-gemini-summarizer.md) (model access, summary cache — tick reuses both),
[ADR 0009](0009-auto-coalesce.md) (C2.5 groups reduce the summary index the tick reads).
**See also:** [conductor-plan.md](../conductor-plan.md) §C3 for the full work plan and
§D-track for the distillation instrumentation built in here.

## Context

C1 + C2 + C2.5 give the conductor a sound deterministic policy: cold-score ordering,
lexical relevance pre-unfold, informative summaries, and flat group coalescing. The
remaining gap is *intentional relevance*: the lexical pass triggers on exact identifier
matches; it misses conceptual relevance ("the config decision" has no token in common
with `database_config.ts`). Closing that gap requires reading what the agent is doing
and choosing which folded blocks are becoming useful — the VISION.md sentence, taken
literally.

C3 adds a **between-turns async tick**: on each live sync settling, a debounced Gemini
call reads the current state and emits a fold/unfold plan. The LLM proposes; the C1
deterministic layer disposes. This is the milestone at which the feature called "the
Conductor" in VISION.md exists.

**Key finding vs the original C3 plan:** the post-turn view-sync gap the plan listed
as a C3 prerequisite is **already closed** in the codebase. The extension's
`agent_end` and `message_end` handlers (ADR 0003) push view-only syncs without a fold
plan; the GUI receives and ingests them normally. C3 therefore requires **no extension
changes and no protocol changes** for the view-sync gap. This simplification is
verified in the extension smoke tests and documented here because ADR 0003 and the
conductor plan both listed it as open work.

## Decision

### 1. The tick: debounced, single-in-flight, newest supersedes

`conductorTick()` is a pure async function in `app/src/lib/live/conductor.ts`.
Scheduling lives in `liveClient.svelte.ts`:

- **Trigger:** every live sync that settles (view-only or plan-bearing) schedules a
  debounced tick with a ~400 ms delay.
- **Single-in-flight:** if a prior tick is still awaiting its Gemini response, the new
  call supersedes it. The in-flight request is not cancelled (Gemini has no free
  cancel), but its result is discarded if a newer tick has already started.
- **One turn behind, by design.** The tick runs async *after* the sync; its output
  applies to the *next* plan. Folding one turn late costs a little headroom; unfolding
  one turn late is still ahead of the agent's need in most cases (the C1 lexical pass
  catches same-turn identifier mentions). This is the structural consequence of "no
  conductor work ever blocks a model call" — it is documented, not fought.

The tick does not run when the conductor is in **deterministic mode** (C1 only) or
**off**. Mode is controlled by the conductor panel (§5).

### 2. Tick inputs: tail window + numbered summary index + budget state

Three inputs, deliberately small:

**a. Protected-tail text window** — the protected tail's text, truncated to ≤ ~6k
tokens. This is the "what the agent is currently doing" signal. Truncation is from
the top (oldest first dropped); the newest content is always included.

**b. Numbered summary index** — one entry per block or group older than the protected
tail, in conversation order:

```
[n] <kind> turn=<t> tokens=<T> folded=<yes|no> pinned=<yes|no>
    <summary-or-digest text, one line>
```

Where `n` is a stable integer index for this tick's context (prevents id
hallucination — the model selects by number, not by raw id). C2.5 groups appear as
single entries with `kind=group`, dramatically reducing index length on long sessions.
The index is built purely from data already in the store; no additional I/O.

**c. Budget state** — `{liveTokens, budget, headroom, overBudget}`. Surfaced plainly
so the model can calibrate aggressiveness.

**Total input size.** On a long session with C2.5 active, the index compresses to tens
of entries rather than hundreds. Typical tick input: ~3–6k tokens. The Gemini
`gemini-2.5-flash-lite` model handles this comfortably within a single call.

### 3. Tick output: strict JSON, librarian role

The prompt frames the model as a **librarian who selects, not an author who writes**:
it may only reference items from the numbered index it was shown. The output schema
is strict JSON with no free text outside the defined fields:

```json
{
  "fold":   [{"n": <index>, "reason": "<short string>"}],
  "unfold": [{"n": <index>, "reason": "<short string>"}],
  "reasons": "<optional overall note, ≤100 chars>"
}
```

The `reason` strings go **verbatim into the activity log** — this is both the
transparency mechanism and the quality signal. A reason that does not make sense
to the human is a tuning failure, visible immediately.

Numbered entries prevent the model from hallucinating a block id that does not exist.
If the model returns an `n` outside the shown range, the engine ignores it silently
(it cannot reference something it was not shown, so this is equivalent to an out-of-
bounds array access, not a correctness hazard).

### 4. Applying tick output: conductor actions through engine guards

Tick output is applied as `conductorFold(id)` / `conductorUnfold(id)` engine actions
(thin wrappers over the existing `fold` / `unfold` with `by: "conductor"` and the
provided reason). The same refusal guards that apply to all other folds apply here:

- Pins overrule the conductor — a pinned block's fold/unfold request is silently
  dropped.
- The protected tail is absolute — any id in the tail is dropped.
- Only durable-id `text` / `thinking` / `tool_result` blocks fold; `tool_call` and
  `user` are ignored.
- Agent-sticky unfolds (`override: "unfolded"`) are respected for a configurable
  cooldown before the conductor may re-fold.
- Hysteresis from C1 applies (cooldowns respected; budget override is last-resort).

**C1 runs last.** After applying tick output, the C1 deterministic clamp runs and
enforces the budget. A confused LLM that proposes 20 unfolds in a tight budget session
will find the clamp restoring the deficit — the LLM proposes; the engine disposes.

**No conductor work ever blocks a model call.** The tick is async and decoupled from
the `context` hook entirely. The plan at each `context` hook reflects whatever the
last tick produced; if the tick is still in-flight, the previous plan is used. The
tick output is not awaited on any synchronous path.

### 5. Conductor modes and panel

The existing `folding.enabled` arm toggle grows into a three-state **conductor mode**:

| Mode | What runs |
|------|-----------|
| **off** | No conductor work; empty plan (M1 behavior). |
| **deterministic** | C1 cold-score + lexical pre-unfold; no tick. |
| **attentive** | C1 + between-turns LLM tick (this milestone). |

Defaults:
- **Live sessions** arm `folding.enabled` separately per-attach (ADR 0004). Conductor
  mode defaults to **deterministic** when armed (conservative; attentive is opt-in).
- **Demo session** may run attentive locally without touching any wire.
- Mode is reset to off on every new live attach (same principle as `folding.enabled`).

The panel shows, per session: mode selector, current turn's miss rate (hits / total
agent unfolds), tokens spent on summarization (C2), tokens spent on ticks (this
milestone), and last tick's reasons.

### 6. Miss metric: every agent unfold is logged

Every agent `unfoldRequest` is logged as:

```json
{"turn": t, "code": "3f9a", "blockId": "...", "wasFolded": true,
 "conductorMode": "attentive", "tickHadUnfolded": false}
```

to `~/.accordion/metrics.jsonl` via `accordion_append_line` (ADR 0008's path-confined
Rust helper). `wasFolded: true` + `tickHadUnfolded: false` = a conductor miss.
`wasFolded: false` = the block was already open (either the tick or the lexical pass
pre-empted the agent). `wasFolded: true` + `conductorMode: "off"` = baseline data.

Hit/miss is surfaced in the conductor panel. This single number is how C3 is tuned,
and later how C5 proves itself publicly. It is non-negotiable.

**Offline replay eval first.** Before any live tokens burn, C1's replay driver
(ADR 0007) is extended to simulate the tick turn-by-turn over the recorded corpus,
scoring would-have-been misses against the corpus's real agent-unfold events. Prompt
tuning happens in this offline loop — 100× cheaper than live sessions and fully
reproducible.

### 7. D0 distillation instrumentation

The **distillation track** (D-track, `docs/conductor-distillation.md`) plans to train
a local student ranker by distilling C3's frontier-model decisions. D0 is the
instrumentation phase: accumulating training data from day one so that dogfooding
builds the dataset automatically.

On every tick, one JSONL record is appended to
`~/.accordion/distill/<sessionId>.jsonl` via `accordion_append_line`:

```json
{
  "sessionId": "...", "turn": t, "promptVersion": "...", "model": "gemini-2.5-flash-lite",
  "entries": [ /* the numbered summary index shown to the model */ ],
  "decision": { "fold": [...], "unfold": [...], "reasons": "..." },
  "ts": "..."
}
```

One record per tick (entries + decision + metadata). The schema is stable from day
one — retroactive schema migrations on a growing JSONL corpus are painful; decide the
schema before accumulating data. The `promptVersion` field lets a future pipeline
filter by prompt generation. The `entries` array includes fold codes but not full
block text (already in the summary cache, retrievable by key if the training pipeline
needs it).

D0 is pure logging — no training loop, no model changes, no new dependencies beyond
`accordion_append_line`. The distillation work proper (D1+) is a separate track.

## Safety invariants

All invariants from ADR 0004/0005/0006/0007 hold. The tick is an additional
*proposing* layer; it cannot bypass any guard. Specifically:

1. **The tick is structurally one turn behind and cannot delay a model call.**
2. **Pins, the protected tail, and kind restrictions are enforced in the engine**
   before any tick output is applied.
3. **The C1 deterministic clamp runs last** and guarantees the budget regardless
   of tick output.
4. **A tick failure (network error, invalid JSON, timeout) is silently swallowed.**
   The previous plan is used; no model call is affected.
5. **`folding.enabled` gate still governs.** If the user disarms, the tick's output
   is discarded even if it is in-flight.

## Consequences

**Wins.** Conceptual relevance is now within the conductor's reach. Pre-emptive
unfolds are no longer limited to exact identifier matches. Every decision is attributed
and reasoned in the activity log. The miss metric gives a single, honest performance
number that will drive tuning and, eventually, public evaluation (C5). D0 starts
accumulating training data automatically from day one.

**Risk: mediocrity.** The failure mode is not catastrophe — the C1 layer guarantees
budget and safety. The failure mode is a conductor that does not clearly beat C1's
lexical pass, wastes per-turn cost, and gets turned off. That is why the offline
replay eval precedes the live loop, and why the miss metric is the deciding criterion.
If after honest tuning the attentive tick cannot beat C1 by a clear margin, ship
C1+C2 as the conductor and say so — the result would be informative, not shameful.

**Risk: per-turn cost.** One small Gemini call per turn at flash-lite pricing is
~cents per turn; a long session of 100 turns is a few dollars. A per-turn cost cap in
the conductor panel bounds this; users who find it unacceptable can run deterministic
mode.

**Risk: D0 distill log size.** A 100-turn session at one record per tick produces a
small JSONL, but dogfooding many sessions for months accumulates GBs if entries arrays
are large. Mitigation: entries are summaries, not full text (bounded by the index
size); the schema omits block text. Monitor `~/.accordion/distill/` size; add a
rotation policy if needed.

## Rejected alternatives

- **Close the view-sync gap with extension changes** — already closed (the `agent_end`
  and `message_end` paths in ADR 0003); no extension changes needed. Documented above
  because the original plan listed this as required work.
- **Embeddings + vector retrieval instead of LLM tick** — Anthropic has no embeddings
  API; a local model or Voyage-style service adds a runtime dependency for a gain the
  LLM tick approximates at lower infrastructure cost. Deferred as a cost optimization
  if the tick proves too expensive at scale.
- **The tick proposes raw block ids (not index numbers)** — a block id is a UUID or
  timestamp; the model hallucinates plausible-looking ids. Numbered index entries
  prevent this class of error entirely.
- **Tick applies its output directly, bypassing the engine** — the "LLM proposes;
  engine disposes" architecture is the safety layer. Bypassing it for latency would
  remove the budget guarantee and the pin/tail/kind guards. Rejected categorically.
- **Eager tick (runs before sync settles, on partial updates)** — adds latency to
  the sync path and reasons over incomplete state. The debounced post-settle tick is
  the correct tradeoff.
