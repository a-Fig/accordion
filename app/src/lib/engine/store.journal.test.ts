import { describe, expect, it } from "vitest";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";
import type { Command, Conductor, ConductorView } from "$conductors/contract";

function blk(i: number): Block {
	return {
		id: `m${i}:p0`,
		kind: "text",
		turn: i + 1,
		order: i,
		text: `block ${i} ` + "x".repeat(160),
		tokens: 1000,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeStore(): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks: [blk(0), blk(1), blk(2)],
		lineCount: 0,
		skipped: 0,
	};
	const s = new AccordionStore(parsed);
	s.setProtect(0);
	return s;
}

class StubConductor implements Conductor {
	readonly id = "stub";
	readonly label = "Stub";
	cmds: Command[] = [];
	conduct(_view: ConductorView): Command[] {
		return this.cmds;
	}
}

describe("decision journal", () => {
	it("records manual transitions", () => {
		const s = makeStore();
		s.fold("m0:p0");
		s.unfold("m0:p0");

		expect(s.decisionJournal[0]).toMatchObject({ by: "you", action: "unfold", ids: ["m0:p0"] });
		expect(s.decisionJournal[1]).toMatchObject({ by: "you", action: "fold", ids: ["m0:p0"] });
	});

	it("records conductor transitions once and does not spam on identical refolds", () => {
		const s = makeStore();
		const stub = new StubConductor();
		stub.cmds = [{ kind: "fold", ids: ["m0:p0"] }];

		s.attach(stub);
		const firstCount = s.decisionJournal.filter((e) => e.by === "auto" && e.action === "fold" && e.ids[0] === "m0:p0").length;
		expect(firstCount).toBe(1);

		s.refold();
		const secondCount = s.decisionJournal.filter((e) => e.by === "auto" && e.action === "fold" && e.ids[0] === "m0:p0").length;
		expect(secondCount).toBe(1);
	});
});
