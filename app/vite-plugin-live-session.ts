import type { Plugin } from "vite";
import { liveSessionMiddleware } from "./src/lib/server/live-session-bridge";

/** Mount live-session SSE on the Vite dev server (same origin as :1420). */
export function liveSessionPlugin(): Plugin {
	return {
		name: "accordion-live-session",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				liveSessionMiddleware(req, res, next);
			});
		},
	};
}
