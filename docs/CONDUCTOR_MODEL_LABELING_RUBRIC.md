# Conductor Model Labeling Rubric v1

Rubric version: `conductor-labeling-rubric-v1`

This rubric is the frozen contract for Conductor model labels. It is designed for
teacher distillation and local replay labels. Do not change the rules in place.
If label semantics change, create a new rubric version and keep artifacts tied to
the version that produced them.

## Scope

The Conductor model has three jobs:

- Budget oracle: predicts the safe fold-target multiplier for the current prompt
  and session shape.
- Fold policy: scores each block for likely future reuse and maps reuse distance
  to fold levels.
- Compression: produces grounded block digests, with deterministic fallback on
  any fidelity failure.

## Budget Oracle Labels

Label the target multiplier, not an absolute token budget.

- Use `1.0` for the checked-in replay artifact until paired A/B proof supports
  either tightening or loosening the budget target. Use `> 1.0` only when replay or
  proof evidence shows the deterministic target loses required facts.
- Use `< 1.0` only when the prompt is broad continuation or cleanup and there is
  no exact-recall risk.
- Keep local-replay labels inside `[0.88, 1.12]`; wider authority requires a new
  validation gate.
- Record the prompt risk features and the source that produced the label.

## Fold Policy Labels

Fold-policy labels are positive-unlabeled data, not positive-negative data.

- Confirmed positives are blocks later recalled, unfolded, manually restored, or
  known by scenario construction to contain the answer key or alias.
- Unrecalled blocks are unlabeled. They may be used as low-weight sampled
  negatives only when they are old, low-risk, and not near the prompt terms.
- The training target is a keep score in `[0, 1]`. Confirmed positives use a high
  salience score, but do not automatically require L0/full text when the
  deterministic digest preserves the answer-bearing fact. Unlabeled sampled
  records use low weight so the model does not learn "never recalled means
  unimportant."
- Expected reuse turns should come from measured recall distance when available.
  Scenario labels use `0` for answer-bearing blocks and the configured reuse
  horizon for unlabeled blocks.
- NIAH needles are held-out sanity checks and may be a low-weight slice. They
  must not become the backbone of training data.

## Compression Labels

Compression labels must be extractive and fidelity-gated.

- Preserve exact paths, commands, marker values, errors, and decisions.
- The digest must not introduce facts absent from the source block.
- Any path, command, exact value, error, or decision present in the source must
  either appear in the digest or cause fallback to `deterministicDigest()`.
- Teacher-written digests are acceptable only when the fidelity gate accepts
  them. Rejected digests are fallback examples, not successful labels.

## Drift Controls

- Every exported record must include `rubricVersion`.
- Every trained artifact must include the rubric version and dataset hash.
- Periodically duplicate-label a fixed slice with the same teacher prompt and
  record self-agreement. Do not compare batches across rubric versions as if they
  share identical semantics.
