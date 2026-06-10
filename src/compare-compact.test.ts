import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildExternalTemplate,
	buildScenarios,
	readExternalCompacts,
	renderExternalCaptureGuide,
} from "./compare-compact.ts";

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
