/*
 * digest.ts — what a folded block collapses to.
 *
 * Deterministic, per-kind. The point of typed blocks is that each kind keeps a
 * different essence when folded: a tool_call keeps WHAT it did, a tool_result
 * keeps only its shape and a taste of WHAT it saw. No LLM here yet — these are
 * structured digests so behaviour is reproducible and debuggable.
 */
import type { Block } from "./types";
import { estTokens, clip, firstLine, BLOCK_OVERHEAD } from "./tokens";

const _KV_STOPWORDS = new Set(["a","an","and","are","as","at","be","but","by","for","from","has","have","i","in","is","it","me","of","on","or","our","that","the","this","to","we","with","you","your"]);

function salienceTokens(text: string, maxItems = 5, maxChars = 120): string {
	const seen = new Set<string>();
	const result: string[] = [];
	let totalChars = 0;
	const add = (s: string) => {
		const t = s.trim();
		if (!t || seen.has(t) || result.length >= maxItems || totalChars + t.length > maxChars) return;
		seen.add(t); result.push(t); totalChars += t.length;
	};
	for (const m of text.matchAll(/[A-Z]{2,}(?:-[A-Z0-9]+)+/g)) add(m[0]);
	for (const m of text.matchAll(/\b(\w[\w.-]*)[ \t]*[:=][ \t]*(\S+)/g)) {
		const key = m[1], val = m[2];
		if (!_KV_STOPWORDS.has(key.toLowerCase()) && val.length > 2) add(`${key}=${val}`);
	}
	for (const m of text.matchAll(/\b[\w.-]+\.\w{1,6}\b/g)) add(m[0]);
	for (const m of text.matchAll(/\bv?\d+\.\d+[\d.]*\b|\b0x[0-9a-fA-F]+\b/g)) add(m[0]);
	for (const m of text.matchAll(/\b(?:error|exception|failed|panic)[: ]+\S+/gi)) add(m[0].slice(0, 30));
	for (const m of text.matchAll(/\b(?:DELETE|GET|PATCH|POST|PUT)\s+\/[A-Za-z0-9_./:*-]+/g)) add(m[0]);
	for (const m of text.matchAll(/\b(?:bun|cargo|deno|docker|gh|git|go|kubectl|make|node|npm|npx|pnpm|pytest|python3?|uv|yarn)\b[^\n.!?;]*/g)) add(m[0]);
	return result.join(" · ");
}

function decisionSentence(text: string, maxChars = 180): string {
	const sentences = text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const selected = sentences.find((sentence) =>
		/\b(?:actual|belongs to|blamed|came from|command we kept|decision|decided|exact command|favou?rite|favou?red|final|liked|preferred|selected|chosen|wanted|we chose|we will)\b/i.test(sentence),
	);
	return selected ? clip(selected, maxChars) : "";
}

export function digest(b: Block): string {
	switch (b.kind) {
		case "user":
			return "“" + clip(b.text, 100) + "”";
		case "text": {
			const decision = decisionSentence(b.text);
			const salience = salienceTokens(b.text);
			if (decision && salience && !decision.includes(salience)) return `${decision} | ${salience}`;
			return decision || salience || clip(b.text, 120);
		}
		case "thinking": {
			const tok = estTokens(b.text);
			const gist = firstLine(b.text, 80);
			return `thought · ~${tok} tok${gist ? " · " + gist : ""}`;
		}
		case "tool_call":
			// Tiny and durable — the digest is nearly the whole thing on purpose.
			return `${b.toolName ?? "tool"}(${clip(b.text.replace(/^\S+\s*/, ""), 70)})`;
		case "tool_result": {
			const name = b.toolName ?? "result";
			if (!b.text.trim()) return `${name} → ${b.isError ? "error" : "empty"}`;
			const lines = b.text.split("\n").filter((l) => l.trim()).length;
			const tag = b.isError ? "error" : `${lines} line${lines === 1 ? "" : "s"}`;
			const peek = salienceTokens(b.text) || firstLine(b.text, 60);
			return `${name} → ${tag}, ~${b.tokens} tok${peek ? " · " + peek : ""}`;
		}
		default:
			return clip(b.text, 80); // defensive: an unmodelled kind still gets a sane digest
	}
}

export function digestTokens(b: Block): number {
	return estTokens(digest(b)) + BLOCK_OVERHEAD;
}
