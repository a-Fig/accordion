<div align="center">

# 🪗 Accordion

### Your agent's memory shouldn't have to forget to keep going.

**See everything your AI agent is holding in context — and fold, unfold, and pin any part of it, by hand or automatically.**

</div>

---

This is the short product and usage guide. The complete north-star behavior is in [VISION.md](VISION.md).

## The problem

Every long-running agent hits the same wall: the context window fills up, and something has to go. Today's answers are both bad — **compaction** blasts your whole history into one lossy summary (slow, destructive, all-or-nothing), and **sliding windows** just drop the oldest tokens (the agent simply forgets). Both treat context as a buffer to flush: the detail is gone, you never saw it go, and you can't get it back.

## The idea

> Context isn't a buffer. It's an accordion.

Accordion shows the agent's context as a list of **sections** — one per turn — and lets you resize it instead of flushing it. Folds are graduated, not 0-or-1: every section is **Full**, **Trimmed** (a structured excerpt — head, key identifiers, tail), **Folded** (a short digest), **Grouped** (a run of cold digests sharing one group summary), or **Pinned** (locked open). The Conductor uses the *minimum* total depth that fits the budget — and the budget target itself breathes inside a calibrated band (0.60–0.92), opening when you or the agent correct it and tightening when its folds go unchallenged. Four actions move sections:

- **Fold** — replace a section with its summary to free up room.
- **Unfold** — bring it back to full detail (still auto-managed, unless pinned).
- **Pin / Unpin** — lock a section open so nothing folds it automatically.
- **Peek** — read a folded section in the window *without* changing the agent's context.

**And the agent can reach back too.** Agent memory should be bidirectional — the agent should be able to inspect and restore its own history, not just receive whatever the system decides to show it. Every fold carries a turn address (`⟦t7⟧ …`), and the pi extension registers `accordion_recall`, `accordion_unfold`, and `accordion_pin` as model-callable tools: the agent reads folded turns in full, restores what it needs (protected by a grace period, counted as a correction that teaches the Conductor), and pins context the user asks it to remember. Humans get the mirror verbs: `/peek`, `/fold`, `/expand`, `/collapse`.

Nothing is ever deleted — folding only changes what the agent is *shown*, never what's *stored* — so every fold is instantly reversible, with no database or search index behind it.

And the recent past is always safe: the most recent ~20k tokens of context are **never auto-folded**, so the agent's working tail — its latest reasoning — stays at full fidelity. You can still fold inside that window by hand; only the automatic system is held back.

## Three hands on the same controls

- **You** — fold, unfold, pin, and peek, by hand.
- **The agent** — reaches back to recall, unfold, or pin context it needs mid-task.
- **The Conductor** — Accordion's automatic mode: between every turn it folds what's gone cold and unfolds what's becoming relevant, on its own.

And folds nest: cold turns fold into **groups**, groups into bigger groups, so a session of thousands of turns stays small enough to fit and complete enough to recover. It all happens in a **separate window** where every change is shown and attributed — open it to watch and steer, close it to let the Conductor run.

Full details, capability matrix, and a walkthrough: [VISION.md](VISION.md).

## See it: the app

The desktop app in `app/` renders a real agent context window and lets you fold, unfold, pin, group, and replay context locally. It is the supported UI surface; the old standalone `visualizer/` prototype has been retired. **Go live** connects to a running pi session via a built-in bridge.

```bash
cd app && npm run dev   # then open http://localhost:1420
```

Classic (`/`) and Map (`/map`) views share the same engine. Sample data lives in `app/static/`. Everything runs locally — nothing is uploaded.

App layout:

```text
app/src/lib/engine/          model and folding rules
app/src/lib/ui/              Classic UI components
app/src/lib/ui/map/          Map UI components
app/src/lib/server/          Node-only Vite live-session bridge
app/src/routes/+page.svelte  Classic route
app/src/routes/map/+page.svelte  Map route
app/src-tauri/               Tauri desktop shell
```

## Why it's different

| | Sliding window | `/compact` | Black-box memory | 🪗 Accordion |
|---|:---:|:---:|:---:|:---:|
| Keeps old context usable | ❌ | ⚠️ lossy | ⚠️ if retrieved | ✅ |
| **Reversible** to full detail | ❌ | ❌ | ❌ | ✅ |
| No mid-task stall | ✅ | ❌ | ✅ | ✅ |
| Per-section, not all-or-nothing | ❌ | ❌ | ⚠️ | ✅ |
| You can see and steer it | ❌ | ❌ | ❌ | ✅ |
| No extra infra (no vector DB) | ✅ | ✅ | ❌ | ✅ |

## Status

[VISION.md](VISION.md) is the north star — the finished product we're building toward. What exists **today**:

- A Tauri + SvelteKit desktop app (`app/`) with Classic and Map views, replay controls, a protected working tail, fold levels, group cards, and a built-in dev live bridge at `http://localhost:1420`.
- A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension (`src/accordion.ts`) backed by the root Conductor (`src/conductor.ts`). It folds under budget pressure, preserves originals, records decisions, and exposes `/accordion`, `/expand`, `/collapse`, plus agent-facing recall/unfold/pin tools.
- Deterministic digests and benchmark/proof tooling for equal-budget comparisons against recency truncation and compact-style baselines.

Honest about what's **not** there yet: no production installer/distribution flow, no LLM-generated summaries on the critical path, and no fully autonomous long-running daemon. The standalone `visualizer/` prototype has been retired; the app is the supported UI surface.

### Try it

```bash
cd app && npm install && npm run dev   # browser dev server at http://localhost:1420
```

For native desktop behavior:

```bash
cd app && npm run tauri dev
```

Pi commands: `/accordion` (status) · `/expand <n>` · `/collapse <n>`

## Proving the claims

Accordion's claims are backed by two layers of automated checks:

```bash
npm run test:claims   # fast invariant tests for reversibility, budget, tail, tool-pair safety, semantic restore
npm test              # full deterministic root suite
```

For benchmark evidence against recency truncation and compact-style baselines:

```bash
npm run proof:compact
npm run proof:judge
npm run proof:judge:llm
npm run proof:report
```

See [DEVELOPMENT.md](DEVELOPMENT.md#claim-map) for the claim-to-test map and [CONDUCTOR.md](CONDUCTOR.md) for the broader proof/benchmark commands.

## Docs

- [DEVELOPMENT.md](DEVELOPMENT.md) - repo layout, coding style, domain language, claim map, and validation commands.
- [CONDUCTOR.md](CONDUCTOR.md) - folding policy, constants, proof commands, summaries, embeddings, and state.
- [VISION.md](VISION.md) - finished-product north star.
- [CONDUCTOR_MODEL_LABELING_RUBRIC.md](CONDUCTOR_MODEL_LABELING_RUBRIC.md) - frozen label contract used by model-training scripts.

## Roadmap

- [x] Core fold/unfold engine — reversible, tool-pair safe
- [x] Rolling automatic folding + manual expansion
- [x] The separate window — desktop app, Map/Classic views, replay
- [x] Agent-driven recall/unfold/pin tools *(POC)*
- [x] Deterministic Conductor + proof/benchmark harness
- [ ] LLM-generated summaries, computed once and cached
- [ ] Production live/distribution polish
- [ ] Hierarchical nested folding for million-turn sessions
- [ ] Agent-driven pin

---

**The north star: your agent's memory should be something you can see and steer — not a black box that silently forgets.**

🪗

<sub>An experiment in context engineering. Contributions, ideas, and benchmarks welcome.</sub>
