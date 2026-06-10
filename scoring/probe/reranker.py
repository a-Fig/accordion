"""
reranker.py — BGE cross-encoder reranker for the Relevance Lab.

Scorer id: "rerank"  version: "1"
Model: BAAI/bge-reranker-v2-m3  (Apache 2.0, XLM-RoBERTa/bge-m3 backbone)
Score: raw logit (single relevance score per query↔passage pair; no sigmoid).

CLI:
  python reranker.py --in <input.json> --out <output.json> [--device cuda|cpu]
                     [--model BAAI/bge-reranker-v2-m3]

Input JSON:
  { "tail": "...", "blocks": [{"id": "...", "text": "..."}] }

Output JSON:
  { "scores": {"<blockId>": <float raw logit>},
    "meta": {"model", "device", "wallMs", "params"} }
"""

import argparse
import json
import sys
import time

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer


# ---------------------------------------------------------------------------
# Text truncation helpers
# ---------------------------------------------------------------------------

def truncate_tail(text: str, max_tokens: int, tok) -> str:
    """Truncate to the NEWEST ~max_tokens tokens of text (keep the end)."""
    if not text:
        return text
    ids = tok.encode(text, add_special_tokens=False)
    if len(ids) <= max_tokens:
        return text
    # Keep the tail
    ids = ids[-max_tokens:]
    return tok.decode(ids, skip_special_tokens=True)


def truncate_passage(text: str, head_tokens: int, tail_tokens: int, tok) -> str:
    """Truncate passage to head_tokens from front + tail_tokens from end."""
    if not text:
        return text
    total = head_tokens + tail_tokens
    ids = tok.encode(text, add_special_tokens=False)
    if len(ids) <= total:
        return text
    head_ids = ids[:head_tokens]
    tail_ids = ids[-tail_tokens:]
    head_part = tok.decode(head_ids, skip_special_tokens=True)
    tail_part = tok.decode(tail_ids, skip_special_tokens=True)
    return head_part + "\n...\n" + tail_part


# ---------------------------------------------------------------------------
# Batch scoring
# ---------------------------------------------------------------------------

def score_pairs(model, tokenizer, pairs, device: str, batch_size: int) -> list[float]:
    """
    Score a list of (query, passage) pairs.
    Returns raw logits (float) in the same order.
    """
    model.eval()
    all_logits: list[float] = []

    i = 0
    while i < len(pairs):
        batch = pairs[i: i + batch_size]
        queries = [q for q, _ in batch]
        passages = [p for _, p in batch]

        encoded = tokenizer(
            queries,
            passages,
            padding=True,
            truncation="longest_first",
            max_length=1600,
            return_tensors="pt",
        )
        encoded = {k: v.to(device) for k, v in encoded.items()}

        with torch.no_grad():
            out = model(**encoded)

        # out.logits: (batch, 1)  — squeeze to scalar per pair
        logits = out.logits.squeeze(-1).float().cpu().tolist()
        if isinstance(logits, float):
            logits = [logits]
        all_logits.extend(logits)

        if i % 50 == 0 and i > 0:
            print(f"  [reranker] scored {i}/{len(pairs)} pairs", file=sys.stderr)

        i += batch_size

    return all_logits


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="BGE cross-encoder reranker sidecar")
    parser.add_argument("--in", dest="input", required=True, help="Path to input JSON")
    parser.add_argument("--out", dest="output", required=True, help="Path to output JSON")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu",
                        choices=["cuda", "cpu"])
    parser.add_argument("--model", default="BAAI/bge-reranker-v2-m3")
    args = parser.parse_args()

    t_start = time.perf_counter()

    # ------------------------------------------------------------------
    # Load input
    # ------------------------------------------------------------------
    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    tail_text: str = data.get("tail", "")
    blocks: list[dict] = data.get("blocks", [])

    if not blocks:
        out = {"scores": {}, "meta": {"model": args.model, "device": args.device,
                                       "wallMs": 0, "params": {"raw logits": True}}}
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(out, f)
        return

    # ------------------------------------------------------------------
    # Load model + tokenizer
    # ------------------------------------------------------------------
    print(f"  [reranker] loading tokenizer: {args.model}", file=sys.stderr)
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    max_pos = getattr(tokenizer, "model_max_length", None)

    print(f"  [reranker] loading model: {args.model}  device={args.device}", file=sys.stderr)
    model = AutoModelForSequenceClassification.from_pretrained(args.model)

    # Report actual config max_position_embeddings
    config_max = getattr(model.config, "max_position_embeddings", "?")
    print(f"  [reranker] config.max_position_embeddings={config_max}  "
          f"tokenizer.model_max_length={max_pos}", file=sys.stderr)

    if args.device == "cuda":
        model = model.half().to("cuda")
    else:
        model = model.to("cpu")
    model.eval()

    # ------------------------------------------------------------------
    # Prepare pairs
    # ------------------------------------------------------------------
    # Query: newest ~1024 tokens of the tail
    query = truncate_tail(tail_text, max_tokens=1024, tok=tokenizer)

    # Passages: head 384 + tail 128 tokens when longer
    passages = [
        truncate_passage(b.get("text", ""), head_tokens=384, tail_tokens=128, tok=tokenizer)
        for b in blocks
    ]

    pairs = [(query, p) for p in passages]
    print(f"  [reranker] {len(pairs)} pairs  device={args.device}", file=sys.stderr)

    # ------------------------------------------------------------------
    # Batch inference with OOM fallback
    # ------------------------------------------------------------------
    batch_size = 8

    while True:
        try:
            logits = score_pairs(model, tokenizer, pairs, args.device, batch_size)
            break
        except RuntimeError as e:
            if "out of memory" in str(e).lower() and batch_size > 1 and args.device == "cuda":
                torch.cuda.empty_cache()
                batch_size = max(1, batch_size // 2)
                print(f"  [reranker] CUDA OOM — halving batch_size to {batch_size}, retrying",
                      file=sys.stderr)
            else:
                raise

    print(f"  [reranker] done — final batch_size={batch_size}", file=sys.stderr)

    # ------------------------------------------------------------------
    # Build output
    # ------------------------------------------------------------------
    scores_map = {b["id"]: float(logits[i]) for i, b in enumerate(blocks)}

    wall_ms = round((time.perf_counter() - t_start) * 1000)

    out = {
        "scores": scores_map,
        "meta": {
            "model": args.model,
            "device": args.device,
            "wallMs": wall_ms,
            "params": {
                "raw logits": True,
                "query_tokens": 1024,
                "passage_head_tokens": 384,
                "passage_tail_tokens": 128,
                "max_pair_tokens": 1600,
                "config_max_position_embeddings": config_max,
                "batch_size_final": batch_size,
            },
        },
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(out, f)

    print(f"  [reranker] output written  wallMs={wall_ms}", file=sys.stderr)


if __name__ == "__main__":
    main()
