# Related Work: Where Accordion Sits

Accordion's design choices are not invented in a vacuum. This page maps the
prior art — what each approach proved, and what Accordion does differently.
Use it for the "how is this different from X?" question.

## The two trained folding agents (closest neighbors)

**Context-Folding / FoldAgent** (Sun et al., ByteDance Seed + CMU + Stanford,
arXiv:2510.11967, Oct 2025). Agents branch into a sub-trajectory, then fold it
on completion, "collapsing the intermediate steps while retaining a concise
summary of the outcome." Trained end-to-end with FoldGRPO process rewards.
Result: matches or beats ReAct with an active context ~10× smaller, and
"significantly outperforms summarization-based context management."

**AgentFold** (Ye et al., Alibaba Tongyi, arXiv:2510.24699, Oct 2025). Context
as "a dynamic cognitive workspace to be actively sculpted, rather than a
passive log to be filled." At each step a trained model emits a folding
operation at multiple scales: "granular condensations to preserve vital,
fine-grained details, or deep consolidations to abstract away entire
multi-step sub-tasks."

**What they prove:** folding beats flat summarization, and *multi-scale*
folding (light condensation vs. deep consolidation) is the right shape —
which is exactly Accordion's trim / digest / group ladder.

**What Accordion does differently:** both systems make the *model* decide
(requiring RL training and burning output tokens on fold directives), and
both folds are *collapses* — the detail leaves the active context with no
restore primitive. Accordion's Conductor is an external, deterministic,
training-free policy; every fold is a view over preserved history, reversible
by the human, the agent, or the Conductor's own relative-outlier rescue.

## What the platform itself ships

**Anthropic context editing + compaction** (Claude API, beta
`context-management-2025-06-27`; compaction `compact_20260112`).
`clear_tool_uses_20250919` drops old tool results past a token threshold and
replaces them with a placeholder; `clear_thinking_20251015` does the same for
thinking blocks; compaction summarizes the earlier conversation and replaces
it. Anthropic's own cookbook notes what a naive implementation misses: "token
counting and automatic triggering, correct tool_use/tool_result pairing
invariants, tool-specific exclusions."

**What it proves:** tool results are the right thing to fold first (Accordion's
`kind_rank` ordering agrees), and placeholder-style replacement is provider-safe.

**What Accordion does differently:** cleared content has no restore path —
once replaced, the only recovery is re-running the tool. Accordion keeps the
original in the session log and can unfold it, proactively, when relevance
returns. The pairing/threshold/exclusion pitfalls the cookbook lists are
covered by Accordion's claims tests (tool-pair atomicity, budget invariant,
pins, protected tail).

**Cautionary tale:** Anthropic's April 2026 postmortem describes a Claude Code
bug where thinking-clearing fired "on every turn for the rest of the session,"
so the model ran "increasingly without memory of why it had chosen to do what
it was doing" — surfacing as forgetfulness and repetition. Destructive,
unattributed context ops fail silently. Accordion's decision log attributes
every fold/unfold/level change to an actor with a reason, and the app
renders it — that failure mode would be visible in one glance.

## Compression literature

**LLMLingua / LongLLMLingua** (Jiang et al., EMNLP 2023 / ACL 2024).
Question-aware, coarse-to-fine prompt compression with a budget controller
that assigns *different compression ratios to different segments* by
relevance. Validates Accordion's core move — graduated, relevance-allocated
depth — at token granularity. Difference: one-shot, irreversible prompt
rewriting; no cross-turn state, no human controls.

**Lost in the Middle** (Liu et al., TACL 2024). Models use information best at
the start and end of the context; mid-context recall sags. Two Accordion
choices lean on this: the protected working tail keeps the end full, and the
**trim level keeps each block's head and tail while hoisting salience tokens
from the elided middle** — the serial-position effect applied inside a block.

**KV-cache eviction: StreamingLLM attention sinks (Xiao et al., ICLR 2024),
H2O heavy-hitters (Zhang et al., NeurIPS 2023).** A small fraction of tokens
carries most of the attention mass. Validates salience-token digests: keep
the heavy hitters, summarize the rest. Difference: those methods need model
internals; Accordion operates at the message/API level on any provider.

**MemGPT** (Packer et al., 2023) and successors (Letta, Mem0). OS-style memory
paging between main context and external storage; "sleep-time" background
consolidation. Accordion's async Haiku/Ollama summarizer is exactly a
sleep-time worker — but Accordion needs no external store or retrieval calls:
nothing ever leaves the session log, so there is no retrieval-miss failure mode.

## The 2026 wave (the field is converging on Accordion's bets)

**Active Context Compression / "Focus"** (Verma, arXiv:2601.07190, Jan 2026).
Critiques "passive, external summarization mechanisms that the agent cannot
control" and gives the agent a compression tool: ~22.7% token reduction at
identical accuracy on SWE-bench Lite slices, with savings up to 57% per
instance. Accordion agrees the agent deserves control — it is one of three
actors (`/fold`, `/unfold` are agent-callable) — but doesn't make the agent
spend its own output tokens policing context every step: the Conductor
handles the default between turns.

**ACON** (Kang et al., arXiv:2510.00615). Optimizes natural-language
compression guidelines and distills them into smaller compressors; 26–54%
peak-token reduction while preserving task success. Still one-way
summarization — compressed history can't be recovered.

**TACO & SWE-Pruner** (2026). TACO observes that "predefined static
compression strategies... yield only limited or unstable gains across tasks"
because environments are heterogeneous, and that training-based pruners
"require additional training" and don't generalize. That is precisely the
niche of Accordion's calibrated fold target: per-session adaptation with no
training, driven by correction events.

**The Complexity Trap** (Lindenbauer et al., arXiv:2508.21433). Finds simple
observation masking is as efficient as LLM summarization for agent context
management. Strong support for Accordion's default stack: deterministic
trims and salience digests on the critical path, LLM summaries only as an
async background upgrade.

**Demand paging for context windows** (arXiv:2603.09023, 2026) and
**E-mem** (2026, "replacing destructive memory compression with context
reconstruction"). The OS-paging frame is converging with ours: fold = page
out, unfold = page in. Accordion's twist is that nothing ever leaves "disk"
(the session log is immutable), and page faults are *predicted* — the
relative-outlier rule unfolds before the miss, instead of reconstructing
after it.

## Positioning table

| | Sliding window | `/compact` & API compaction | Tool-result clearing | Trained folding (FoldAgent, AgentFold) | 🪗 Accordion |
|---|:---:|:---:|:---:|:---:|:---:|
| Keeps old context usable | ❌ | ⚠️ lossy | ⚠️ placeholder | ⚠️ summary only | ✅ |
| Reversible to full detail | ❌ | ❌ | ❌ | ❌ | ✅ |
| Graduated (not 0/1) depth | ❌ | ❌ | ❌ | ✅ multi-scale | ✅ trim → digest → group |
| Adapts pressure to feedback | ❌ | ❌ | threshold only | ✅ via RL training | ✅ calibrated target, training-free |
| Works on any provider, no training | ✅ | ✅ | ✅ | ❌ | ✅ |
| Attributed, observable decisions | ❌ | ❌ | ❌ | partial | ✅ decision log + app |

## Design lessons Accordion adopted

1. Multi-scale folding over binary fold (AgentFold, Context-Folding) →
   fold levels L0–L3 with minimal-depth escalation.
2. Per-segment compression ratios by relevance (LongLLMLingua) →
   score-ordered depth-first escalation; the marginal unit stays at trim.
3. Serial-position retention (Lost in the Middle) → trim keeps head + tail,
   salience tokens rescue the middle.
4. Heavy-hitter sparsity (H2O) → salience-token digests.
5. Tool results first (Anthropic context editing) → `kind_rank` fold order.
6. Sleep-time consolidation (MemGPT/Letta) → async off-critical-path summaries.
7. Feedback-adaptive pressure (FoldGRPO's learned signal) → the calibrated
   fold target driven by correction events — the training-free analog.
8. Destructive ops fail silently (Claude Code postmortem) → reversibility +
   attributed decisions as non-negotiable invariants.
