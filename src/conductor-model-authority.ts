import { existsSync, readFileSync } from "node:fs";
import {
	parseConductorModelAuthority,
	type ConductorModelAuthority,
} from "./conductor.ts";

export interface LoadedConductorModelAuthority {
	authority?: ConductorModelAuthority;
	file?: string;
	implicit: boolean;
}

export function conductorModelAuthoritySidecar(artifactFile: string): string {
	return artifactFile.replace(/\.json$/i, "") + ".authority.json";
}

export function loadConductorModelAuthority(input: {
	artifactFile?: string;
	authorityFile?: string;
}): LoadedConductorModelAuthority {
	if (input.authorityFile) {
		return {
			authority: parseConductorModelAuthority(readFileSync(input.authorityFile, "utf8")),
			file: input.authorityFile,
			implicit: false,
		};
	}
	if (!input.artifactFile) return { implicit: false };
	const sidecar = conductorModelAuthoritySidecar(input.artifactFile);
	if (!existsSync(sidecar)) return { implicit: false };
	return {
		authority: parseConductorModelAuthority(readFileSync(sidecar, "utf8")),
		file: sidecar,
		implicit: true,
	};
}
