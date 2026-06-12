import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCORDION_AGENT_SKILL } from "./accordion-skill.ts";
import { buildAccordionSkillAppendix, buildConductorModelDependencies, injectAccordionSkillContext } from "./accordion.ts";

type TestMessage = {
	role: string;
	content: Array<{ type: "text"; text: string }>;
	id?: string;
};

const txt = (text: string) => ({ type: "text", text });

function textOf(message: TestMessage): string {
	return message.content.map((part) => part.text).join("\n");
}

function dynamicIndex(messages: TestMessage[]): number {
	const index = messages.findIndex((message) => textOf(message).startsWith("Currently folded:"));
	assert.notEqual(index, -1, "dynamic Accordion appendix should be present");
	return index;
}

test("accordion skill injection keeps the cached prefix stable when fold state changes", () => {
	const base: TestMessage[] = [
		{ id: "u1", role: "user", content: [txt("Please inspect the cache design.")] },
		{ id: "a1", role: "assistant", content: [txt("We discussed a Redis prefix cache and a Vite middleware path.")] },
		{ id: "u2", role: "user", content: [txt("Continue from the current turn.")] },
	];
	const before = JSON.stringify(base);

	const first = injectAccordionSkillContext(base as any, [1], 0.8) as TestMessage[];
	const second = injectAccordionSkillContext(base as any, [1, 2], 0.92) as TestMessage[];
	const firstDynamic = dynamicIndex(first);
	const secondDynamic = dynamicIndex(second);

	assert.equal(JSON.stringify(base), before, "injection must not mutate stored originals");
	assert.equal(first[0].role, "system");
	assert.equal(textOf(first[0]), ACCORDION_AGENT_SKILL);
	assert.equal(second[0].role, "system");
	assert.equal(textOf(second[0]), ACCORDION_AGENT_SKILL);
	assert.equal(first[firstDynamic].role, "assistant");
	assert.equal(first[firstDynamic + 1].role, "user", "dynamic appendix should sit just before the current turn");
	assert.equal(JSON.stringify(first.slice(0, firstDynamic)), JSON.stringify(second.slice(0, secondDynamic)));
	assert.equal(JSON.stringify(first.slice(firstDynamic + 1)), JSON.stringify(second.slice(secondDynamic + 1)));
	assert.notEqual(textOf(first[firstDynamic]), textOf(second[secondDynamic]));
	assert.equal(textOf(first[2]).includes(ACCORDION_AGENT_SKILL), false, "first assistant should not carry the static skill");
});

test("accordion skill injection is idempotent for prior injected views", () => {
	const base: TestMessage[] = [
		{ id: "u1", role: "user", content: [txt("Summarize earlier work.")] },
		{ id: "u2", role: "user", content: [txt("What was the exact command?")] },
	];

	const injected = injectAccordionSkillContext(base as any, [1], 0.8) as TestMessage[];
	const reinjected = injectAccordionSkillContext(injected as any, [1, 2], 0.91) as TestMessage[];

	assert.equal(reinjected.filter((message) => textOf(message) === ACCORDION_AGENT_SKILL).length, 1);
	assert.equal(reinjected.filter((message) => textOf(message).startsWith("Currently folded:")).length, 1);
	assert.equal(textOf(reinjected[dynamicIndex(reinjected)]), buildAccordionSkillAppendix([1, 2], 0.91));
});

test("conductor model dependencies stay inert by default and activate for shadow mode", () => {
	const inert = buildConductorModelDependencies("test-model", { shadowMode: false });
	assert.equal(inert.budgetOracle, undefined);
	assert.equal(inert.foldPolicyProvider, undefined);
	assert.equal(inert.compressionProvider, undefined);

	const traces: unknown[] = [];
	const shadow = buildConductorModelDependencies("test-model", {
		shadowMode: true,
		onShadowTrace: (trace) => traces.push(trace),
	});
	assert.equal(typeof shadow.budgetOracle, "function");
	assert.equal(typeof shadow.foldPolicyProvider, "function");
	assert.equal(typeof shadow.compressionProvider, "function");
	shadow.onShadowTrace?.({
		kind: "budget_oracle",
		turn: 1,
		heuristicDecision: {},
		modelDecision: {},
		outcome: "pending",
	});
	assert.equal(traces.length, 1);
});
