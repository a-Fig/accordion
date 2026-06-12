import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	accordionContext,
	buildExternalTemplate,
	buildScenarios,
	readExternalCompacts,
	renderExternalCaptureGuide,
} from "./compare-compact.ts";
import { conductorModelAuthoritySidecar, loadConductorModelAuthority } from "./conductor-model-authority.ts";
import { parseConductorModelArtifact, parseConductorModelAuthority } from "./conductor.ts";

test("external compact template excludes the final prompt from captured setup", () => {
	const scenario = buildScenarios().find((item) => item.name === "semantic-preference-late");
	assert.ok(scenario);

	const [fixture] = buildExternalTemplate([scenario], [1_500]);
	assert.equal(fixture.scenario, "semantic-preference-late");
	assert.equal(fixture.summary, "");
	assert.equal(fixture.finalPrompt, scenario.probe);
	assert.ok(fixture.setupTranscript);
	assert.equal(fixture.setupTranscript.some((message) => message.text === fixture.finalPrompt), false);
	assert.equal(fixture.setupTranscript.at(-1)?.text.includes(scenario.probe), false);
});

test("external compact captures reject blank summaries unless explicitly allowed", () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-compact-"));
	const file = join(dir, "compact-captures.json");
	try {
		writeFileSync(file, JSON.stringify([
			{ scenario: "semantic-preference-late", budget: 1_500, summary: "" },
		]));

		assert.throws(
			() => readExternalCompacts(file, false),
			/External compact summary is empty for semantic-preference-late budget 1500/,
		);

		const allowed = readExternalCompacts(file, true);
		assert.equal(allowed.get("semantic-preference-late:1500"), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("external compact guide explains the contamination-safe capture protocol", () => {
	const scenario = buildScenarios().find((item) => item.name === "semantic-preference-late");
	assert.ok(scenario);

	const [fixture] = buildExternalTemplate([scenario], [1_500]);
	const guide = renderExternalCaptureGuide([fixture]);

	assert.match(guide, /Accordion Real \/compact Capture Guide/);
	assert.match(guide, /Invoke `\/compact` before sending the final prompt/);
	assert.match(guide, /semantic-preference-late @ budget 1500/);
	assert.match(guide, /Final prompt, do not send before \/compact: Which onboarding design did Maya like\?/);
	assert.match(guide, /Replay the \d+ messages in this fixture's JSON `setupTranscript` field/);
	assert.match(guide, /Paste the compacted summary into this fixture's JSON `summary` field/);
});

test("model authority loader uses explicit files and artifact sidecars", () => {
	const dir = mkdtempSync(join(tmpdir(), "accordion-authority-loader-"));
	const artifactFile = join(dir, "model.json");
	const sidecarFile = conductorModelAuthoritySidecar(artifactFile);
	const explicitFile = join(dir, "explicit.authority.json");
	const authority = {
		version: 1,
		generatedAt: "2026-06-12T00:00:00.000Z",
		artifact: artifactFile,
		evidence: {},
		authority: {
			budgetOracle: { mode: "cost_guarded", maxTargetMultiplier: 1 },
			foldPolicy: { mode: "shadow_only" },
			compression: { mode: "digest_only" },
		},
	};
	try {
		writeFileSync(sidecarFile, JSON.stringify(authority));
		writeFileSync(explicitFile, JSON.stringify({
			...authority,
			authority: {
				...authority.authority,
				budgetOracle: { mode: "shadow_only" },
			},
		}));

		const implicit = loadConductorModelAuthority({ artifactFile });
		const explicit = loadConductorModelAuthority({ artifactFile, authorityFile: explicitFile });

		assert.equal(implicit.file, sidecarFile);
		assert.equal(implicit.implicit, true);
		assert.equal(implicit.authority?.authority.budgetOracle.mode, "cost_guarded");
		assert.equal(explicit.file, explicitFile);
		assert.equal(explicit.implicit, false);
		assert.equal(explicit.authority?.authority.budgetOracle.mode, "shadow_only");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("accordion comparison can exercise local model providers", async () => {
	const scenario = buildScenarios().find((item) => item.name === "exact-command");
	assert.ok(scenario);
	const artifact = parseConductorModelArtifact(readFileSync("models/conductor-local-v1.json", "utf8"));
	const authority = parseConductorModelAuthority(readFileSync("models/conductor-local-v1.authority.json", "utf8"));

	const messages = await accordionContext(scenario.messages, scenario.probe, 1_500, undefined, true, artifact, authority);
	const text = messages
		.map((message: any) => (message.content ?? []).map((part: any) => part.text ?? "").join("\n"))
		.join("\n");

	assert.ok(text.includes(scenario.key), `expected local-model Accordion context to preserve ${scenario.key}`);
});
