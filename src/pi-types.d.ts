declare module "@earendil-works/pi-agent-core" {
	export type AgentMessage = Record<string, any>;
}

declare module "@earendil-works/pi-coding-agent" {
	export interface AgentToolResult {
		content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
		details: Record<string, any>;
		terminate?: boolean;
	}

	export interface ExtensionContext {
		sessionManager: {
			getBranch(): any[];
		};
		ui: {
			theme: {
				fg(name: string, text: string): string;
			};
			setStatus(name: string, text: string): void;
			notify(message: string, level?: string): void;
		};
		compact(options?: {
			customInstructions?: string;
			onComplete?: () => void;
			onError?: (error: Error) => void;
		}): void;
	}

	export interface ExtensionCommandContext extends ExtensionContext {}

	export interface ExtensionAPI {
		on(name: string, handler: (event: any, ctx: ExtensionContext) => any): void;
		registerTool?(tool: {
			name: string;
			label?: string;
			description: string;
			parameters: Record<string, any>;
			execute: (...args: any[]) => Promise<AgentToolResult> | AgentToolResult;
		}): void;
		appendEntry(customType: string, data: any): void;
		registerCommand(
			name: string,
			command: {
				description: string;
				getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		): void;
	}
}
