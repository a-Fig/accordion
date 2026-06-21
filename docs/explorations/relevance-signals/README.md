# Exploration — Relevance signals for fold/unfold (and where attention/perplexity actually fit)

> Status: **exploration, settled to a negative-plus-redirect conclusion.** No app or conductor
> code. It started from "measure relevance to the newest tokens to drive *unfolding*" and ended
> at "that whole family of signals is for *folding* and *offline labeling*, not unfolding."
> Pairs with [`experiment.py`](experiment.py) + [`results.txt`](results.txt).

## TL;DR

- **Starting idea:** to unfold the right old block, measure its relevance to the very newest
  tokens — e.g. relocate it just above the tail and read how much attention it gets.
- **A cleaner cousin:** *perplexity reduction* — does the block, placed before the tail, make
  the current reasoning more **predictable**? Outcome-based ("did it help") rather than a
  correlate ("did the model look at it"), and it needs only logprobs, not attention internals.
- **The finding that killed the unfold framing:** attention and perplexity-reduction are both
  **retrospective** signals — they measure *whether a block was used to produce text that
  already exists*. That requires the block to have been **present** when the text was generated.
  - **Folding** satisfies this (the block is live; the tail was produced with it there). ✔
  - **Unfolding** violates it (the block is folded; the tail was produced *without* it). The
    signal then measures whether the full block *agrees with* a path the agent already took from
    the digest — redundancy/consistency, **not** prospective need. ✗ (The "score the digest→full
    delta" patch doesn't save it: high = "the digest was already enough," low/negative =
    "conflicts with the path already taken"; neither is "needed next.")
- **What unfolding actually needs:** either *prediction* of what's coming (an ML-trained signal)
  or *retrieval* against the newest **exogenous** input (the user message / tool result — the
  part of the tail folding didn't contaminate). Retrieval already ships (`tiered-relevance`,
  `the-conductor`, `cold-score`); the novel measurement adds nothing there.
- **Where the idea is genuinely useful:** as a **folder** (online leave-one-out contribution)
  and as an **offline labeler / evaluator** (true ablation → ground truth).
- **Honest verdict on the folder:** as a *0.5B-proxy* folder it's "attention-folder but pricier
  and maybe a bit cleaner" — not a slam dunk. It clearly wins only with the **agent's own
  logprobs** (a capability we don't have) or when used as the **labeler**. So: **build the
  labeler first; let measured ground truth decide whether any probe beats near-free recency
  before writing a conductor.**
- **The one durable data point:** on the real sample session, content-relevance-to-now is
  essentially uncorrelated with recency (**Pearson +0.007**). Age-based folding therefore folds
  still-relevant blocks — there *is* headroom for a relevance/contribution-aware folder.

## 1. The arc (what we tried and why each step moved)

1. **"Relocate above the tail, read attention" (unfold).** Mechanically sound — causal
   attention only looks backward, so a candidate must sit *before* the tail to be seen at all —
   and relocation neutralizes the position confound (recency + lost-in-the-middle, Liu et al.
   2023) that `attention-folder`'s in-place scoring leaves in. Genuinely unbuilt in Accordion.
2. **Swap attention → perplexity reduction.** Same idea, better signal: measure the *effect*
   (does the block make the current reasoning more predictable) instead of a *correlate* (does
   the model attend to it). Bonus: needs only logprobs, and drops all the attention bookkeeping
   (layer/head selection, sink masking, value-weighting, anchor calibration).
3. **The objection that broke it:** the tail was produced *while the agent saw the block
   folded.* So scoring "does full X explain the tail" is circular — the tail is an artifact of
   X's absence. Worse, when the agent went wrong *for lack of X*, its committed tokens *conflict*
   with X, so the signal goes **negative** exactly when X is most needed.
4. **The asymmetry that generalizes the objection:** these are retrospective "what-got-used"
   signals. Eviction (fold the unused) is their natural job; admission (what *will* be needed) is
   structurally invisible to them. Same root as "Expected Attention" (2025)'s future-query
   blindness.

## 2. The folding version, concretely

At an epoch (context over budget), for each live foldable block X, do a leave-one-out against
the recent tail Q:

```
contribution(X) = logprob(Q | context as-is) − logprob(Q | X folded to its digest)
```

Fold lowest-contribution first — *fold the live blocks the current work isn't leaning on.* It's
`attention-folder` with the signal swapped from a correlate to the effect.

**Why it could beat what we have:**
- *Effect vs. correlate.* Attention is a noisy stand-in (sink-prone; the
  attention-is-not-explanation problem). Δlogprob measures the thing itself.
- *Redundancy-awareness — the one thing attention can't do.* If X and Y both carry the board
  state, attention lights up both; marginal contribution sees that folding X is free *while Y
  stays* → folds the duplicate, keeps the info.
- *Data:* relevance ⟂ recency (§4) means recency/age folders demonstrably fold still-relevant
  blocks.

**Why it might not be worth it (the honest caveats):**
- *Proxy-of-a-proxy.* It's a 0.5B probe's perplexity, not the agent's — a cleaner signal read by
  the same weak instrument as `attention-folder`.
- *Cost.* True leave-one-out is ~N forward passes per epoch (`attention-folder` scores every
  block in one pass). The cheap shortcut — score `[X][Q]` in isolation — throws away the
  redundancy-awareness that was the main advantage. The unique win and the cost are coupled.
- *Coarse decision.* Folding only needs bottom-K; a better signal only matters if it changes
  bottom-K often enough to pay for a GPU over near-free ACT-R/recency.

**The two versions that clearly win:** leave-one-out against the **agent's own logprobs** (proxy
objection gone — but `host.complete` is text-only today, so this is a capability gap →
imaginarium #8), or used **offline as a labeler** rather than an online folder.

## 3. Why unfold needs something else

Unfold is *admission*, and admission needs prediction or retrieval — neither of which is a
retrospective signal:
- **Retrieval** of folded blocks against the newest **exogenous** input (user msg / tool result
  — not folding-contaminated). This is embedding/lexical/cross-encoder relevance, and it already
  exists (`tiered-relevance`, `the-conductor`, `cold-score`'s lexical pre-unfold).
- **Prediction** of what the next turn will need — an ML-trained signal, fed by…
- …the **counterfactual labeler** (re-run a turn with/without a block, compare behavior;
  imaginarium #9). True ground truth, offline, the natural training source.
- The **agent's own `recall`/`unfold`** is the live backstop for "I'm stuck because something's
  folded" — the conductor *provisions*, the agent *repairs*; one probe shouldn't do both.

## 4. The lite test (the durable evidence)

[`experiment.py`](experiment.py) parses the real bundled sample session (981 blocks / ~134k
tokens) exactly as the engine does (`parse.ts` + `tokens.ts`) and asks: **is "relevant to now"
the same as "recent"?** Using a transparent lexical relevance proxy (TF-IDF cosine to the
protected tail; there's no GPU/torch here):

```
Pearson(content_relevance, distance_to_tail) = +0.007
Top-20 most-relevant-to-tail blocks: median distance 387 blocks; 9/20 in the older half
```

Relevance-to-now and recency are **essentially uncorrelated.** Any age-based fold/unfold
heuristic therefore mis-ranks relevance — which is precisely the headroom a contribution-aware
folder would exploit. Caveats (spelled out in the script): the lexical proxy over-rewards
near-duplicate boilerplate — which actually argues *for* a semantic/perplexity signal; lexical ≠
semantic; the real validation is the labeler in §3.

Reproduce: `cd docs/explorations/relevance-signals && python3 experiment.py`.

## 5. Recommendation / next step

**Don't build a conductor on faith — build the labeler first.** Run true ablation offline on the
replay corpus to get ground truth for "which folds were actually free," then measure how well
each *cheap* signal — recency, ACT-R (cold-score), attention (attention-folder), perplexity-proxy
— predicts it. That answers "does it perform better?" *before* any conductor is written, and the
labeled corpus is exactly the training data an ML conductor would want. If perplexity-proxy
doesn't beat near-free recency by enough to justify the GPU, we have our answer cheaply.

## Placement (literature & Accordion)

- **Literature:** lost-in-the-middle (Liu 2023); H2O / Scissorhands / SnapKV (heavy-hitter
  eviction); attention sinks / VATP; LongLLMLingua (question-aware + document reorder +
  contrastive perplexity — the closest prior art); "Expected Attention" (2025, future-query
  blindness = why retrospective signals can't do admission).
- **Accordion:** `attention-folder` (ADR 0010 — fold-only, in-place attention; this is its
  natural sibling); `tiered-relevance` / `the-conductor` (retrieval-based unfold — the right tool
  for admission); `cold-score` (ADR 0009 — lexical/ACT-R); imaginarium **#8** (attention/logprob
  telemetry as a capability) and **#9** (the counterfactual oracle = the labeler).
