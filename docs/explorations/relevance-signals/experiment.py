#!/usr/bin/env python3
"""
relevance signals lite test — is "relevant to now" the same as "recent"?
=======================================================================

Context: this exploration started from "measure relevance to the newest tokens
(the tail) to drive UNFOLDING" and concluded that attention/perplexity-style
signals are retrospective and belong to FOLDING + offline labeling, not unfold
(see README.md). The finding that survives that retraction — and that justifies a
relevance/contribution-aware *folder* over plain recency — is the one measured
here: relevant-to-now and recent are different things.

An age/recency folder (and an in-place attention scorer like `attention-folder`)
ranks largely by position. Position is biased (recency + 'lost in the middle',
Liu et al. 2023). So an in-place / age score conflates two things:

    in_place_attention(block) ~= content_relevance(block, tail) * position_weight(block)

Relocating a candidate to immediately before the tail pins position_weight ~= max
for every candidate, so the score collapses to content_relevance alone. That only
*matters* if content_relevance and position are decoupled in real sessions. If
relevant blocks always sit near the tail anyway, relocation buys nothing and plain
recency is fine.

This script measures that decoupling on the REAL bundled sample session, using a
transparent lexical relevance proxy (TF-IDF cosine to the tail). No torch / no GPU
(unavailable here). The real probe would swap TF-IDF cosine for a small LM's
attention; the structural conclusion (is relevance decoupled from recency?) is
proxy-independent and, if anything, conservative under lexical matching.

Run:  python3 experiment.py [path/to/sample-session.jsonl]
"""
import json
import math
import re
import sys
from collections import Counter

# ---- engine-faithful constants (app/src/lib/engine/tokens.ts) ----------------
CHARS_PER_TOKEN = 4
BLOCK_OVERHEAD = 4
PROTECT_TOKENS = 20_000            # store.svelte.ts default protectTokens
FOLDABLE = {"text", "thinking", "tool_result"}   # only these are ever sent folded


def est_tokens(s: str) -> int:
    return math.ceil(len(s) / CHARS_PER_TOKEN) if s else 0


# ---- parse pi JSONL -> linear blocks (mirrors engine/parse.ts parsePi) --------
def as_text(c) -> str:
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b["text"] for b in c
                         if isinstance(b, dict) and b.get("type") == "text"
                         and isinstance(b.get("text"), str))
    return ""


def parse_pi(path: str):
    blocks = []
    order = 0
    turn = 0

    def push(kind, text, **extra):
        nonlocal order
        if not text and kind != "tool_result":
            return
        b = {"kind": kind, "turn": turn, "order": order,
             "text": text, "tokens": est_tokens(text) + BLOCK_OVERHEAD}
        b.update(extra)
        blocks.append(b)
        order += 1

    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("type") != "message":
                continue
            m = e.get("message", {})
            role = m.get("role")
            if role == "user":
                turn += 1
                push("user", as_text(m.get("content")))
            elif role == "assistant":
                for b in (m.get("content") or []):
                    t = b.get("type")
                    if t == "thinking":
                        push("thinking", b.get("thinking") or "")
                    elif t == "text":
                        push("text", b.get("text") or "")
                    elif t == "toolCall":
                        push("tool_call",
                             f'{b.get("name")} {json.dumps(b.get("arguments") or {})}',
                             toolName=b.get("name"), callId=b.get("id"))
            elif role == "toolResult":
                push("tool_result", as_text(m.get("content")),
                     toolName=m.get("toolName") or "tool",
                     callId=m.get("toolCallId"))
    return blocks


# ---- TF-IDF lexical relevance (transparent stand-in for the attention probe) --
STOP = set("""a an the and or but if then else of to in on at by for with as is are was were
be been being it its this that these those i you he she we they them his her their our your
do does did done have has had not no yes can could will would should may might must just
so than too very s t re ve ll d m o re y about into over under out up down off then once here
there what which who whom whose when where why how all any both each few more most other some
such only own same also from""".split())
TOK = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*")


def tokenize(text: str):
    return [w.lower() for w in TOK.findall(text)
            if len(w) >= 2 and w.lower() not in STOP]


def tf_vec(tokens):
    c = Counter(tokens)
    n = sum(c.values()) or 1
    return {w: cnt / n for w, cnt in c.items()}


def cosine(a, b, idf):
    # weight both vectors by idf, then cosine
    keys = set(a) | set(b)
    da = db = dot = 0.0
    for k in keys:
        wa = a.get(k, 0.0) * idf.get(k, 0.0)
        wb = b.get(k, 0.0) * idf.get(k, 0.0)
        dot += wa * wb
        da += wa * wa
        db += wb * wb
    if da == 0 or db == 0:
        return 0.0
    return dot / math.sqrt(da * db)


def pearson(xs, ys):
    n = len(xs)
    if n < 2:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return 0.0
    return sxy / math.sqrt(sxx * syy)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "../../../app/static/sample-session.jsonl"
    blocks = parse_pi(path)
    total_tokens = sum(b["tokens"] for b in blocks)

    # ---- protected tail: newest ~PROTECT_TOKENS tokens = the "query" ----------
    tail_idx = len(blocks)
    acc = 0
    for i in range(len(blocks) - 1, -1, -1):
        acc += blocks[i]["tokens"]
        tail_idx = i
        if acc >= PROTECT_TOKENS:
            break
    tail_blocks = blocks[tail_idx:]
    cand = [(i, b) for i, b in enumerate(blocks[:tail_idx]) if b["kind"] in FOLDABLE]

    print("=" * 78)
    print("SAMPLE SESSION")
    print("=" * 78)
    kinds = Counter(b["kind"] for b in blocks)
    print(f"blocks={len(blocks)}  est_tokens={total_tokens:,}  kinds={dict(kinds)}")
    print(f"protected tail: blocks[{tail_idx}:{len(blocks)}] "
          f"= {len(tail_blocks)} blocks, {sum(b['tokens'] for b in tail_blocks):,} tok "
          f"(target {PROTECT_TOKENS:,})")
    print(f"foldable unfold-candidates (older than tail): {len(cand)}")

    # ---- build IDF over candidate blocks + the tail document ------------------
    docs = [tokenize(b["text"]) for _, b in cand]
    tail_tokens = tokenize(" ".join(b["text"] for b in tail_blocks))
    df = Counter()
    for d in docs + [tail_tokens]:
        for w in set(d):
            df[w] += 1
    N = len(docs) + 1
    idf = {w: math.log(1 + N / c) for w, c in df.items()}
    tail_v = tf_vec(tail_tokens)

    # ---- content relevance of each candidate to the tail (position-free) -----
    scored = []
    for (gi, b), d in zip(cand, docs):
        rel = cosine(tf_vec(d), tail_v, idf)
        dist = tail_idx - gi            # blocks between this block and the tail (>=1)
        scored.append({"gi": gi, "b": b, "rel": rel, "dist": dist})

    # =====================================================================
    # RESULT A (model-free): are relevant blocks decoupled from recency?
    # =====================================================================
    print("\n" + "=" * 78)
    print("A. MODEL-FREE: is content-relevance-to-tail decoupled from recency?")
    print("=" * 78)
    rels = [s["rel"] for s in scored]
    dists = [s["dist"] for s in scored]
    r = pearson(rels, dists)
    print(f"Pearson(content_relevance, distance_to_tail) = {r:+.3f}")
    print("  (~0 => relevance and recency are decoupled; recency is a poor proxy")
    print("   for relevance, so a recency-biased in-place scorer mis-ranks unfold)")

    by_rel = sorted(scored, key=lambda s: -s["rel"])
    K = 20
    topK = by_rel[:K]
    span = tail_idx  # candidate index range is [0, tail_idx)
    far = [s for s in topK if s["gi"] < 0.5 * span]   # older half of history
    print(f"\nTop-{K} MOST relevant-to-tail blocks — where do they live?")
    print(f"  in OLDER half of pre-tail history: {len(far)}/{K}")
    print(f"  median distance-to-tail among top-{K}: "
          f"{sorted(s['dist'] for s in topK)[K // 2]} blocks")
    print(f"  max distance-to-tail among top-{K}:    {max(s['dist'] for s in topK)} blocks")
    print("  -> these are exactly the blocks a recency/in-place scorer assigns")
    print("     near-zero weight, yet they are the most on-topic for 'right now'.")

    # =====================================================================
    # RESULT B: does relocation change the UNFOLD decision?
    # Illustrative position model (literature-shaped U-curve): in-place score
    #   = relevance * position_weight ; relocated score = relevance (pos pinned).
    # =====================================================================
    print("\n" + "=" * 78)
    print("B. DECISION CHANGE: in-place attention vs relocated attention (top-K unfold)")
    print("=" * 78)
    # position_weight(i): recency (decay toward tail) U-curved with mild primacy.
    # tuned so adjacent-to-tail ~= 1.0; labelled illustrative, not measured.
    lam_r = max(8.0, span * 0.06)      # recency length-scale (~6% of history)
    lam_p = max(4.0, span * 0.03)      # primacy length-scale
    for s in scored:
        d = s["dist"]                  # 1 = adjacent to tail
        i = s["gi"]
        recency = math.exp(-(d - 1) / lam_r)
        primacy = 0.4 * math.exp(-i / lam_p)
        s["pos_w"] = max(recency, primacy, 0.02)
        s["in_place"] = s["rel"] * s["pos_w"]
        s["relocated"] = s["rel"] * 1.0           # pinned adjacent

    in_place_top = {s["gi"] for s in sorted(scored, key=lambda s: -s["in_place"])[:K]}
    reloc_top = {s["gi"] for s in sorted(scored, key=lambda s: -s["relocated"])[:K]}
    overlap = len(in_place_top & reloc_top)
    print(f"position model: recency lam={lam_r:.0f}, primacy lam={lam_p:.0f} (illustrative U-curve)")
    print(f"top-{K} picks — overlap between age/in-place and relevance ranking: "
          f"{overlap}/{K}  (disagree on {K - overlap})")

    missed = sorted([s for s in scored if s["gi"] in (reloc_top - in_place_top)],
                    key=lambda s: -s["rel"])
    print(f"\nRelevant-but-FAR blocks relocation surfaces that in-place buries "
          f"({len(missed)} of top-{K}):")
    for s in missed[:8]:
        ip_rank = 1 + sorted(scored, key=lambda x: -x["in_place"]).index(s)
        preview = re.sub(r"\s+", " ", s["b"]["text"])[:88]
        print(f"  [{s['b']['kind']:11s}] rel={s['rel']:.3f}  dist={s['dist']:4d}  "
              f"in-place_rank={ip_rank:4d}  | {preview}")

    print("\n" + "=" * 78)
    print("TAKEAWAY")
    print("=" * 78)
    print("Pearson ~ 0 and a low top-K overlap mean 'how recent' and 'how relevant")
    print("to now' are different questions. Age/recency folders (and in-place attention)")
    print("answer the first; a relevance/contribution-aware folder answers the second.")
    print("So there is real headroom for a better FOLD signal over plain recency. (This")
    print("does NOT rescue unfolding — see README.md for why these signals are")
    print("retrospective and belong to folding + offline labeling, not admission.)")


if __name__ == "__main__":
    main()
