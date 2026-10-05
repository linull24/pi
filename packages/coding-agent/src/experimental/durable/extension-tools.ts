/**
 * Extension → durable tool bridge.
 *
 * pi extensions register tools via `pi.registerTool(ToolDefinition)`. The daemon session worker only
 * installed pi's built-in `CodingTools`, so background sessions lacked every extension tool
 * (`web_search`, `subagent`, extension commands, …) and tools were effectively owned by the client.
 *
 * This loads the same extensions the interactive session loads and installs their tools into the
 * durable registry, so background sessions own the same tool set as a foreground session.
 *
 * A pi `ToolDefinition` and a durable `defineTool` have almost the same shape; the only real
 * difference is the execution context. Background sessions are headless, so tools get a no-UI
 * context (`hasUI: false`); UI-only tools fall back to their own non-interactive behaviour.
 */

import type { Extension, Registry } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { getAgentDir } from "../../config.ts";
import type { ExtensionContext, ExtensionToolContext, ToolDefinition } from "../../core/extensions/types.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";

/** A no-op UI: background sessions have no terminal. */
function headlessUi(): ExtensionContext["ui"] {
	const noop = (): void => {};
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: noop,
		onTerminalInput: () => () => {},
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "background sessions have no theme UI" }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	} as unknown as ExtensionContext["ui"];
}

function headlessContext(cwd: string, modelRuntime: ModelRuntime): ExtensionToolContext {
	return {
		ui: headlessUi(),
		hasUI: false,
		cwd,
		mode: "print",
		modelRegistry: modelRuntime as unknown as ExtensionContext["modelRegistry"],
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		tools: [],
		executeTool: async (name: string) => ({
			toolName: name,
			isError: true,
			content: [{ type: "text", text: "Nested tool calls are unavailable in background sessions." }],
		}),
	} as unknown as ExtensionToolContext;
}

/** Wrap a pi tool as a single-tool durable extension. */
function adaptTool(definition: ToolDefinition, context: ExtensionToolContext): Extension {
	return defineExtension({
		name: `pi-ext:${definition.name}`,
		tools: [
			defineTool({
				name: definition.name,
				description: definition.description || definition.name,
				parameters: definition.parameters,
				execute: async (args, _api) => {
					const result = await definition.execute(`ext:${definition.name}`, args, undefined, undefined, context);
					return result as unknown as never;
				},
			}),
		],
	});
}

/**
 * Load the configured extensions and install their tools into the durable registry.
 * Best-effort: a tool that fails to install is reported and skipped, never fatal.
 */
export async function installExtensionTools(
	registry: Registry,
	settingsManager: SettingsManager,
	cwd: string,
	modelRuntime: ModelRuntime,
): Promise<void> {
	const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager });
	await loader.reload();
	const loaded = loader.getExtensions();
	const context = headlessContext(cwd, modelRuntime);
	let installed = 0;
	const failures: string[] = [];
	for (const extension of loaded.extensions) {
		for (const [name, entry] of extension.tools) {
			try {
				registry.install(adaptTool(entry.definition, context));
				installed++;
			} catch (error) {
				failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	console.error(
		`[extension-tools] installed ${installed} tool(s) from ${loaded.extensions.length} extension(s)` +
			(failures.length > 0 ? `; skipped ${failures.length}: ${failures.join(" | ")}` : ""),
	);
}
