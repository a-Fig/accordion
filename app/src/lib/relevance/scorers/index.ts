import type { PureScorer } from "../types";
import { recencyScorer } from "./recency";
import { actrScorer } from "./actr";
import { bm25Scorer } from "./bm25";
import { graphScorer } from "./graph";

// The four pure scorers run both in the app (live) and in the harness.
// The external scorers (embed / judge / attn / rerank) live in scoring/external/.
export const pureScorers: PureScorer[] = [
    recencyScorer,
    actrScorer,
    bm25Scorer,
    graphScorer,
];
