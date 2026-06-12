import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	DEFAULT_CONDUCTOR_TRAINING_DATA,
	buildConductorTrainingRecords,
	conductorTrainingDataHash,
	serializeConductorTrainingRecords,
} from "./conductor-training-data.ts";

function main(): void {
	const out = process.argv.find((arg) => arg.startsWith("--out="))?.split("=")[1] ?? DEFAULT_CONDUCTOR_TRAINING_DATA;
	const records = buildConductorTrainingRecords();
	const jsonl = serializeConductorTrainingRecords(records);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, jsonl);
	process.stdout.write(`Wrote ${out} with ${records.length} records (${conductorTrainingDataHash(jsonl).slice(0, 12)})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
