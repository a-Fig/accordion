# Conductor Model Implementation Todos

This checklist tracks implementation against [CONDUCTOR_MODEL.md](CONDUCTOR_MODEL.md).
Each phase should land in small, testable slices with deterministic fallback kept
intact.

## Phase 0a - Cache Stability

- [x] Split static `ACCORDION_AGENT_SKILL` from dynamic fold metadata.
- [x] Insert the static skill as a stable system message.
- [x] Insert dynamic folded-turn metadata near the current turn, not at the prefix.
- [x] Add a regression test proving the prefix stays byte-stable when only fold
  state changes.
- [x] Run the targeted test file, then the full root test suite.

## Phase 0b - Data + Shadow Harness

- [x] Add shadow-mode configuration via `CONDUCTOR_SHADOW=1`.
- [x] Add `ConductorShadowTrace` state/log types for heuristic/model/outcome triples.
- [x] Invoke model providers in shadow mode without live authority.
- [x] Log provider disagreements and per-decision fallbacks.
- [x] Persist shadow traces and model caches into the session state/log.
- [x] Add local deterministic prior providers so `CONDUCTOR_SHADOW=1` produces data without external weights.
- [x] Add trace extraction helpers for `manualChanges`, fold decisions, NIAH labels,
  and compact budget sweeps.
- [x] Publish frozen `conductor-labeling-rubric-v1` teacher-labeling rules.
- [x] Export labeled dataset v0 as JSONL with budget oracle, PU fold-policy, and
  compression records.
- [x] Include rubric version/path, record split, source, and labeler metadata on
  each exported record.
- [x] Add duplicate-label self-agreement audit to catch rubric drift across
  exported training batches.
- [x] Add tests proving shadow providers never alter live decisions.

## Phase 1 - Budget Oracle

- [x] Add `budgetOracle?` to `ConductorDependencies`.
- [x] Add a `warmConductorModel()` async boundary beside `warmEmbeddings()`.
- [x] Add a persisted artifact format for locally-runnable oracle weights.
- [x] Add a training/export command that emits the oracle artifact from replay data.
- [x] Teach the trainer to consume exported labels and record dataset hash/source
  provenance in the artifact.
- [x] Cache oracle output as a target multiplier with confidence.
- [x] Clamp oracle authority to the configured fold-target band.
- [x] Fall back per turn on missing provider, low confidence, errors, or timeout.
- [x] Add an opt-in proof-harness path that warms the oracle before comparison runs.
- [x] Add a cost guard so checked-in artifact oracle authority cannot loosen the
  heuristic target before paired A/B proof earns it.
- [x] Add an evidence-backed authority manifest so artifact authority is explicit
  rather than hardcoded in the runtime.
- [x] Add tests for clamping, confidence fallback, and shadow-only behavior.

## Phase 2 - Learned Fold Policy

- [x] Add `foldPolicyProvider?` to `ConductorDependencies`.
- [x] Add a persisted artifact format for locally-runnable fold-policy weights.
- [x] Add a training/export command that emits fold-policy weights from replay labels.
- [x] Treat unrecalled fold-policy blocks as low-weight PU unlabeled examples
  rather than confirmed negatives.
- [x] Add a block-hash score cache keyed by `textHash(block.text)`.
- [x] Extract agent-attention features from recent assistant messages.
- [x] Map predicted time-to-next-use to L0-L3 fold levels.
- [x] Add MMR-style redundancy penalty using existing embeddings.
- [x] Plug cached policy output into the scoring path behind confidence gates.
- [x] Keep checked-in artifact fold-policy authority proof-gated: cache/log
  artifact predictions, but do not let them reorder or deepen live folds until
  paired A/B token non-regression passes with real authority.
- [x] Add an opt-in proof-harness path that warms fold-policy scores before comparison and NIAH runs.
- [x] Add a deterministic NIAH holdout gate for artifact-backed local model runs.
- [x] Add tests for score caching, fallback, attention boost, MMR redundancy, and
  no budget violations.

## Phase 3 - Compression + Salience Metadata

- [x] Add `compressionProvider?` to `ConductorDependencies`.
- [x] Add a persisted artifact section for the textual compression strategy.
- [x] Export deterministic extractive compression labels with fidelity metadata.
- [x] Add a compression cache keyed by `contentHash(block)`.
- [x] Implement a fidelity gate for paths, commands, exact values, errors, and
  decisions.
- [x] Keep checked-in artifact compression metadata proof-gated so salience
  enrichment cannot lengthen group headers before token non-regression proof.
- [x] Fall back per block to `deterministicDigest()` on failed fidelity.
- [x] Extend `AccordionState` with structured salience metadata.
- [x] Preserve member salience when group folding collapses blocks.
- [x] Add an opt-in proof-harness path that warms compression caches before comparison and NIAH runs.
- [x] Add tests for grounded compression, hallucination rejection, fallback, and
  group salience union.

## Phase 4 - Optional Consolidation

- [x] Keep separate per-job provider contracts as the default.
- [x] Leave shared-serving configuration unimplemented until SLO evidence exists.
- [x] Document that consolidation is optional and must not weaken per-job fallback.
- [x] Add a latency regression test for artifact-backed warm-up and synchronous `runConductor()`.
- [x] Add regression tests for training-data export and JSONL-backed artifact
  provenance.
- [x] Add a paired learned-vs-heuristic model evaluation gate with bootstrap over
  conversations and token-regression checks.
- [x] Add a promotion command that derives checked-in artifact authority from
  label-audit and model-evaluation evidence.
- [x] Make comparison, evaluation, and NIAH proof harnesses load the promoted
  authority manifest explicitly.
- [x] Run root tests and relevant proof gates after all live-authority phases.

## Remaining Spec Audit - Teacher-Distilled Local Students

- [x] Record teacher-vs-local label provenance in training vectors and model
  artifacts.
- [x] Add an explicit promotion guard that can require teacher distillation before
  any live-authority promotion.
- [x] Add teacher-label JSONL import tooling that validates labels against the
  frozen rubric and emits teacher-augmented training data.
- [x] Add teacher-label job export tooling with rubric-bound prompts, source text,
  and import-compatible label templates.
- [x] Add an OpenAI-compatible teacher-label request runner that turns exported
  jobs into validated import-ready teacher-label JSONL once credentials are
  available.
- [x] Add MiniLM-class fold-policy artifact schema, training scaffold, and
  promotion guard so replay-linear heads cannot masquerade as distilled students.
- [x] Add teacher textual-compressor artifact schema, digest-table training
  scaffold, runtime fallback, and promotion guard.
- [x] Import actual strong-teacher labels under the frozen rubric and retrain an
  artifact with teacher records (`teacher:minimax-m3-cloud` validation batch).
- [x] Compose and proof-gate a combined teacher-student candidate artifact with
  MiniLM fold-policy metadata and teacher textual-compressor metadata.
- [x] Replace the metadata-only MiniLM fold-policy candidate with a runnable
  teacher-trained MiniLM/cross-encoder policy head.
- [x] Expand the teacher textual-compressor candidate beyond the one-record
  validation digest table, or prove that its coverage meets the Phase 3 recall
  and fidelity gates.
