import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	combineFacetLoaders,
	createFacetHost,
	defineFacet,
	type FacetHost,
	type FacetLoader,
	type JsonValue,
	type LoadedFacets,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentState, ConversationView } from "@earendil-works/pi-durable";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	type SelectItem,
	SelectList,
	setKeybindings,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { getAgentDir } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { createChatViewport } from "../modes/interactive/chat-viewport.ts";
import { CustomEditor } from "../modes/interactive/components/custom-editor.ts";
import { getEditorTheme, setRegisteredThemes, stopThemeWatcher, theme } from "../modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../modes/interactive/theme/theme-controller.ts";
import { createInteractiveTui } from "../modes/interactive/tui-renderer.ts";
import {
	type AgentRowState,
	type AgentViewRow,
	captainEntry,
	listAgentViewSources,
	registerAgentViewSource,
} from "./agent-view-sources.ts";
import { type OpenClientRuntimeOptions, openClientRuntime } from "./client-runtime.ts";
import { ExperimentalChatView, liveOf } from "./client-tui-chat.ts";
import { emitAgentNotification } from "./notify.ts";
import { createPresentationFacetLoaders } from "./plugins/bundled.ts";
import { AgentController, type AgentOperationResponse, type AgentQueueResponse } from "./services/agent-controller.ts";
import type {
	ServerConnectionState,
	ServerServiceSource,
	SessionAttachmentState,
	SessionServiceSource,
} from "./services/connection.ts";
import { Goals } from "./services/goals.ts";
import { PresentationPlugins } from "./services/plugins.ts";
import { PresentationUI } from "./services/presentation-ui.ts";
import { Questions } from "./services/questions.ts";
import { SessionDirectory, SessionManagement, type SessionSummary } from "./services/sessions.ts";
import { SlashCommands } from "./services/slash-commands.ts";
import {
	createBuiltInSlashCommandsFacet,
	createSlashCommandsRuntimeFacet,
} from "./services/slash-commands-provider.ts";
import { Transcript, type Transcript as TranscriptService } from "./services/transcript.ts";

export interface RunClientTuiOptions extends OpenClientRuntimeOptions {
	readonly facetLoader?: FacetLoader;
	/** Open straight into the Agent View (same screen as pressing ← in a session). */
	readonly startInAgentsView?: boolean;
}

export interface ClientTuiServer {
	readonly serverId: string;
	readonly radius: boolean;
	readonly server: ServerServiceSource;
	readonly session: SessionServiceSource;
}

interface SessionFeature {
	readonly serverId: string;
	readonly session: SessionServiceSource;
	readonly transcript: TranscriptService;
}

interface PreparedClientSession {
	readonly server: ClientTuiServer;
	readonly summary: SessionSummary;
	readonly presentationPlugins: JsonValue;
}

interface PendingSelection {
	readonly title: string;
	readonly items: readonly SelectItem[];
	readonly selectedValue?: string;
	resolve(value: string | undefined): void;
}

const selectTheme = {
	selectedPrefix: (text: string) => theme.fg("accent", text),
	selectedText: (text: string) => theme.fg("accent", text),
	description: (text: string) => theme.fg("muted", text),
	scrollInfo: (text: string) => theme.fg("dim", text),
	noMatch: (text: string) => theme.fg("warning", text),
};

/** Agent View rows use the shared row shape; pi rows are built locally, C rows come from sources. */
type SessionEntry = AgentViewRow;

// Re-exported so the Agent View's C-source surface has a single import site.
export { captainEntry, listAgentViewSources, registerAgentViewSource };
export type { AgentRowOrigin, AgentViewRow, AgentViewSource } from "./agent-view-sources.ts";

function shortenPath(path: string): string {
	const home = process.env.HOME;
	if (home !== undefined && path === home) return "~";
	if (home !== undefined && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

function parseRecordContent(record: string): unknown {
	try {
		const parsed = JSON.parse(record) as { model?: Array<{ content?: unknown }> };
		return parsed.model?.[0]?.content;
	} catch {
		return undefined;
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part !== null &&
				typeof part === "object" &&
				"text" in part &&
				typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.join(" ");
	}
	return "";
}

function agentStateLabel(state: AgentRowState): string {
	if (state === "working") return "working";
	if (state === "needs-input") return "needs input";
	if (state === "needs-instructions") return "needs instructions";
	if (state === "finishing") return "finishing";
	if (state === "done") return "done";
	return "failed";
}

/** Fixed-width, colored state tag shown at the front of every row. */
function agentStateTag(state: AgentRowState): string {
	const label = agentStateLabel(state).padEnd(18);
	if (state === "working" || state === "finishing") return theme.fg("accent", label);
	if (state === "needs-input") return theme.fg("warning", label);
	if (state === "failed") return theme.fg("error", label);
	if (state === "done") return theme.fg("success", label);
	return theme.fg("muted", label);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function relativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	if (diff < 60_000) return "just now";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
	const years = Math.floor(months / 12);
	return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** Newest session that already has a user prompt (skips empty dispatch leftovers). */
function newestNonEmptySessionId(): string | undefined {
	const root = join(getAgentDir(), "experimental", "sessions");
	let ids: string[];
	try {
		ids = readdirSync(root).filter((id) => !id.endsWith(".lock"));
	} catch {
		return undefined;
	}
	const candidates: Array<{ id: string; createdAt: number }> = [];
	for (const id of ids) {
		try {
			const meta = JSON.parse(readFileSync(join(root, id, "meta.json"), "utf-8")) as { createdAt?: number };
			const db = new DatabaseSync(join(root, id, "session.sqlite"), { readOnly: true });
			try {
				const row = db
					.prepare("select count(*) as c from entries where json_extract(record, '$.kind') = 'pi.user'")
					.get() as unknown as { c?: number };
				if ((row?.c ?? 0) > 0) candidates.push({ id, createdAt: meta.createdAt ?? 0 });
			} finally {
				db.close();
			}
		} catch {
			// skip unreadable session
		}
	}
	candidates.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
	return candidates[0]?.id;
}

export type SessionDoneListener = (sessionId: string) => void;

const sessionDoneListeners = new Set<SessionDoneListener>();

/** Subscribe to user-confirmed session completion (`/done`). Returns an unsubscribe function. */
export function onSessionDone(listener: SessionDoneListener): () => void {
	sessionDoneListeners.add(listener);
	return () => sessionDoneListeners.delete(listener);
}

/** Service-only presentation driven by a replicated main-lane snapshot. */
export class ExperimentalClientTui implements Component {
	readonly #ui: TUI;
	readonly #requestRender: () => void;
	readonly #finish: () => void;
	#restartSessionId: string | undefined;
	readonly #documentContainer = new Container();
	readonly #sessionHeading = new Text("", 1, 0);
	readonly #pendingMessagesContainer = new Container();
	readonly #statusContainer = new Container();
	readonly #editorContainer = new Container();
	readonly #footerComponent = new Text("", 1, 0);
	readonly #layoutRoot: Component;
	readonly #sharedFacets: LoadedFacets;
	readonly #keybindings = KeybindingsManager.create();
	readonly #servers: readonly ClientTuiServer[];
	#presentationFacets: LoadedFacets | undefined;
	#facetHost: FacetHost | undefined;
	#facetReloadTail = Promise.resolve();
	#session: SessionFeature | undefined;
	#slashCommands: SlashCommands | undefined;
	#controller: AgentController | undefined;
	readonly #chatInput: CustomEditor;
	#selectList: SelectList | undefined;
	#selection: PendingSelection | undefined;
	#screen: "select" | "sessions" | "chat" = "chat";
	#selectedServerId: string | undefined;
	#sessionId: string | undefined;
	#status = "Starting Session…";
	#busy = false;
	#closed = false;
	#closePromise: Promise<void> | undefined;
	#recoveryTransition: Promise<void> = Promise.resolve();
	#laneUnsubscribe: (() => void) | undefined;
	#chatView: ExperimentalChatView | undefined;
	#sessionItems: SessionEntry[] = [];
	#sessionIndex = 0;
	#sessionQuery = "";
	#sessionAll = false;
	/** True while the Captain (C entry point) row has the cursor in the Agent View. */
	#captainSelected = false;
	#sessionPreview = false;
	#sessionRenaming = false;
	#sessionRenameValue = "";
	#agentDispatch = "";
	#needsInput = 0;
	#agentPollTimer: ReturnType<typeof setInterval> | undefined;
	#agentStates = new Map<string, AgentRowState>();
	#goal: string | undefined;
	#hints: string[] = [];
	#hintIndex = 0;
	#hintLoading = false;
	#documentHidden = false;

	private constructor(
		ui: TUI,
		requestRender: () => void,
		finish: () => void,
		loadedFacets: LoadedFacets,
		servers: readonly ClientTuiServer[],
	) {
		this.#ui = ui;
		this.#requestRender = requestRender;
		this.#finish = finish;
		this.#sharedFacets = loadedFacets;
		this.#servers = servers;
		setKeybindings(this.#keybindings);
		this.#chatInput = new CustomEditor(ui, getEditorTheme(), this.#keybindings, { paddingX: 1 });
		this.#chatInput.onSubmit = (message) => {
			const text = message.trim();
			if (text === "/goal" || text.startsWith("/goal ")) {
				void this.#runGoalCommand(text.slice(5));
				return;
			}
			void this.#runPrompt(message);
		};
		this.#chatInput.onEscape = () => this.#interrupt();
		this.#chatInput.onCtrlD = finish;
		this.#chatInput.onAction("app.clear", finish);
		this.#chatInput.onAction("app.model.select", () => void this.#executeSlashCommand("model", ""));
		this.#chatInput.onAction("app.message.followUp", () => {
			const text = this.#chatInput.getText().trim();
			if (text.length === 0) return;
			this.#chatInput.setText("");
			void this.#queueFollowUp(text);
		});
		this.#editorContainer.addChild(this.#chatInput);
		this.#layoutRoot = createChatViewport({
			document: this.#documentContainer,
			pendingMessages: this.#pendingMessagesContainer,
			status: this.#statusContainer,
			editor: this.#editorContainer,
			footer: this.#footerComponent,
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		}).root;
		this.#rebuild();
	}

	static async create(options: {
		readonly command: ClientCommand;
		readonly ui: TUI;
		readonly servers: readonly ClientTuiServer[];
		readonly facetLoader?: FacetLoader;
		readonly startInAgentsView?: boolean;
		requestRender(): void;
		finish(): void;
	}): Promise<ExperimentalClientTui> {
		const prepared = await prepareClientSession(options.command, options.servers);
		const loadedFacets = await combineFacetLoaders(
			options.facetLoader === undefined ? [] : [options.facetLoader],
		).load();
		const component = new ExperimentalClientTui(
			options.ui,
			options.requestRender,
			options.finish,
			loadedFacets,
			options.servers,
		);
		try {
			await component.#start(prepared);
			await component.#openPreparedSession(prepared);
			if (options.startInAgentsView === true) component.#openSessionOverview();
			component.#startAgentPolling();
			return component;
		} catch (error) {
			try {
				await component.close();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Experimental TUI startup and cleanup failed");
			}
			throw error;
		}
	}

	get layoutRoot(): Component {
		return this.#layoutRoot;
	}

	/** Session chosen in the overview; runClientTui restarts the TUI bound to it. */
	get restartSessionId(): string | undefined {
		return this.#restartSessionId;
	}

	render(width: number): string[] {
		return [
			...this.#documentContainer.render(width),
			...this.#pendingMessagesContainer.render(width),
			...this.#statusContainer.render(width),
			...this.#editorContainer.render(width),
			...this.#footerComponent.render(width),
		];
	}

	handleInput(data: string): void {
		if (this.#busy) {
			if (
				this.#keybindings.matches(data, "app.clear") ||
				(this.#chatInput.getText().length === 0 && this.#keybindings.matches(data, "app.exit"))
			) {
				this.#finish();
			}
			return;
		}
		if (this.#screen === "chat") {
			// Tab: propose the user's likely next replies (the `hint` role).
			if ((data === "\t" || data === "\u0009") && this.#chatInput.getText().length === 0) {
				void this.#tabHint();
				return;
			}
			// ← on an empty editor opens the all-sessions overview (Claude Code-style switch).
			if (!this.#busy && (data === "\u001b[D" || data === "\u001bOD") && this.#chatInput.getText().length === 0) {
				this.#openSessionOverview();
				return;
			}
			this.#chatInput.handleInput(data);
			this.#requestRender();
			return;
		}
		if (this.#screen === "sessions") {
			this.#handleSessionOverviewInput(data);
			return;
		}
		this.#selectList?.handleInput(data);
	}

	invalidate(): void {
		this.#layoutRoot.invalidate();
	}

	dispose(): void {
		void this.close().catch(() => {});
	}

	refreshTheme(): void {
		const view = this.#conversationView();
		if (view !== undefined) this.#chatView?.refreshTheme(view);
		this.#rebuild();
	}

	showError(error: string): void {
		this.#status = `Error: ${error}`;
		this.#rebuild();
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #start(prepared: PreparedClientSession): Promise<void> {
		const server = prepared.server;
		let presentationFacets = await combineFacetLoaders(
			createPresentationFacetLoaders(prepared.presentationPlugins),
		).load();
		this.#presentationFacets = presentationFacets;
		let facetHost!: FacetHost;
		const reloadPresentationPlugins = (data: JsonValue): Promise<void> => {
			const operation = this.#facetReloadTail.then(async () => {
				const candidate = await combineFacetLoaders(createPresentationFacetLoaders(data)).load();
				try {
					await facetHost.reload(candidate.facets);
				} catch (error) {
					try {
						await candidate.dispose();
					} catch (cleanupError) {
						throw new AggregateError([error, cleanupError], "TUI plugin reload and cleanup failed");
					}
					throw error;
				}
				const retired = presentationFacets;
				presentationFacets = candidate;
				this.#presentationFacets = candidate;
				await retired.dispose();
			});
			this.#facetReloadTail = operation.catch(() => {});
			return operation;
		};
		const presentationBridgeFacet = defineFacet({
			id: "@pi/presentation-bridge",
			setup: (env) => {
				env.provide(PresentationUI, {
					select: (title, items, selectedValue) =>
						this.#select(
							title,
							items.map((item) => ({ ...item })),
							selectedValue,
						),
					showStatus: (status) => {
						this.#status = status;
						this.#rebuild();
					},
				});
				const commands = env.use(SlashCommands);
				const controller = env.use(AgentController);
				const transcript = env.use(Transcript);
				const sessionFeature: SessionFeature = {
					serverId: server.serverId,
					session: server.session,
					transcript,
				};
				env.onActivate(() => {
					if (this.#session !== undefined || this.#slashCommands !== undefined || this.#controller !== undefined) {
						throw new Error("Presentation services are already active");
					}
					this.#session = sessionFeature;
					this.#slashCommands = commands;
					this.#controller = controller;
					env.own(() => {
						if (this.#session === sessionFeature) this.#session = undefined;
						if (this.#slashCommands === commands) this.#slashCommands = undefined;
						if (this.#controller === controller) this.#controller = undefined;
					});
					env.own(commands.subscribe(() => this.#updateAutocomplete()));
					if (server.radius) {
						env.own(
							server.server.connection.subscribe((state) => this.#handleConnectionState(server.serverId, state)),
						);
						env.own(
							server.session.attachment.subscribe((state) => this.#handleAttachmentState(sessionFeature, state)),
						);
					}
				});
			},
		});
		facetHost = await createFacetHost({
			facets: [
				createSlashCommandsRuntimeFacet(),
				presentationBridgeFacet,
				createBuiltInSlashCommandsFacet({ reloadPresentationPlugins }),
				...this.#sharedFacets.facets,
				...presentationFacets.facets,
			],
			serviceSources: [server.server, server.session],
		});
		this.#facetHost = facetHost;
	}

	async #openPreparedSession(prepared: PreparedClientSession): Promise<void> {
		const feature = this.#session;
		if (feature === undefined) throw new Error(`No Session service is available for ${prepared.server.serverId}`);
		await feature.session.whenAttached(prepared.summary.sessionId, BACKGROUND_CONTEXT);
		this.#selectedServerId = feature.serverId;
		this.#sessionId = prepared.summary.sessionId;
		this.#updateAutocomplete();
		await this.#openLane(feature);
		this.#screen = "chat";
		this.#status = "";
		this.#rebuild();
		void this.#refreshGoal();
	}

	async #close(): Promise<void> {
		this.#closed = true;
		if (this.#agentPollTimer !== undefined) {
			clearInterval(this.#agentPollTimer);
			this.#agentPollTimer = undefined;
		}
		this.#completeSelection(undefined);
		const errors: unknown[] = [];
		try {
			await this.#recoveryTransition;
			await this.#closeLane();
			await this.#facetReloadTail;
		} catch (error) {
			errors.push(error);
		}
		if (this.#facetHost !== undefined) {
			try {
				await this.#facetHost.dispose();
			} catch (error) {
				errors.push(error);
			}
			this.#facetHost = undefined;
		}
		const generations = [this.#presentationFacets, this.#sharedFacets].filter(
			(generation): generation is LoadedFacets => generation !== undefined,
		);
		this.#presentationFacets = undefined;
		const results = await Promise.allSettled(generations.map((generation) => generation.dispose()));
		errors.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose experimental TUI facets");
	}

	#rebuild(): void {
		this.#sessionHeading.setText(
			this.#sessionId === undefined || this.#selectedServerId === undefined
				? ""
				: theme.fg("dim", `Server: ${this.#selectedServerId}\nSession: ${this.#sessionId}`),
		);
		this.#statusContainer.clear();
		if (this.#status.length > 0) {
			this.#statusContainer.addChild(new Text(theme.fg("dim", this.#status), 1, 0));
		}
		if (this.#chatView !== undefined) this.#statusContainer.addChild(this.#chatView.status);
		this.#footerComponent.setText(this.#screen === "sessions" ? "" : theme.fg("dim", this.#footer()));
		if (this.#screen === "sessions") {
			if (!this.#documentHidden) {
				this.#documentContainer.clear();
				this.#pendingMessagesContainer.clear();
				this.#documentHidden = true;
			}
		} else if (this.#documentHidden) {
			this.#documentContainer.clear();
			if (this.#chatView !== undefined) {
				this.#documentContainer.addChild(this.#sessionHeading);
				this.#documentContainer.addChild(this.#chatView.transcript);
			}
			this.#documentHidden = false;
		}
		this.#editorContainer.clear();
		if (this.#screen === "select" && this.#selection !== undefined) {
			this.#chatInput.focused = false;
			const selector = new Container();
			selector.addChild(new Text(theme.bold(this.#selection.title), 1, 1));
			const items = [...this.#selection.items];
			this.#selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), selectTheme);
			const selectedIndex = items.findIndex((item) => item.value === this.#selection?.selectedValue);
			if (selectedIndex >= 0) this.#selectList.setSelectedIndex(selectedIndex);
			this.#selectList.onSelect = (item) => this.#completeSelection(item.value);
			this.#selectList.onCancel = () => this.#completeSelection(undefined);
			selector.addChild(this.#selectList);
			this.#editorContainer.addChild(selector);
		} else if (this.#screen === "sessions") {
			this.#selectList = undefined;
			this.#chatInput.focused = false;
			this.#editorContainer.addChild(this.#renderSessionOverview());
		} else {
			this.#selectList = undefined;
			this.#chatInput.focused = !this.#busy;
			this.#editorContainer.addChild(this.#chatInput);
		}
		this.#layoutRoot.invalidate();
		this.#requestRender();
	}

	#select(title: string, items: readonly SelectItem[], selectedValue?: string): Promise<string | undefined> {
		if (this.#selection !== undefined) throw new Error("A slash command selector is already active");
		return new Promise((resolve) => {
			this.#selection = { title, items, ...(selectedValue === undefined ? {} : { selectedValue }), resolve };
			this.#screen = "select";
			this.#rebuild();
		});
	}

	#completeSelection(value: string | undefined): void {
		const selection = this.#selection;
		if (selection === undefined) return;
		this.#selection = undefined;
		this.#screen = "chat";
		selection.resolve(value);
		if (!this.#closed) this.#rebuild();
	}

	/** List local daemon sessions from the session store (no service re-open while attached). */
	#listSessions(): SessionEntry[] {
		const root = join(getAgentDir(), "experimental", "sessions");
		let ids: string[];
		try {
			ids = readdirSync(root);
		} catch {
			return [];
		}
		const sessions: SessionEntry[] = [];
		for (const id of ids) {
			try {
				const dir = join(root, id);
				const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")) as {
					createdAt?: number;
					cwd?: string;
					name?: string;
					done?: boolean;
				};
				let title = "";
				let activity = "";
				let entries = 0;
				let bytes = 0;
				let lastActivityAt = meta.createdAt ?? 0;
				let state: AgentRowState = "needs-instructions";
				let question: string | undefined;
				try {
					const dbPath = join(dir, "session.sqlite");
					bytes = statSync(dbPath).size;
					// Activity = most recent write to the durable store (sqlite and its WAL).
					lastActivityAt = statSync(dbPath).mtimeMs;
					try {
						lastActivityAt = Math.max(lastActivityAt, statSync(`${dbPath}-wal`).mtimeMs);
					} catch {
						// no WAL
					}
					const db = new DatabaseSync(dbPath, { readOnly: true });
					try {
						const firstUser = db
							.prepare(
								"select record from entries where json_extract(record, '$.kind') = 'pi.user' order by id asc limit 1",
							)
							.get() as unknown as { record?: string } | undefined;
						if (firstUser?.record !== undefined) {
							title = extractText(parseRecordContent(firstUser.record))
								.replace(/\s+/gu, " ")
								.trim()
								.slice(0, 80);
						}
						const lastAssistant = db
							.prepare(
								"select record from entries where json_extract(record, '$.kind') = 'pi.assistant' order by id desc limit 1",
							)
							.get() as unknown as { record?: string } | undefined;
						const lastAssistantRecord = lastAssistant?.record;
						if (lastAssistantRecord !== undefined) {
							activity = extractText(parseRecordContent(lastAssistantRecord))
								.replace(/\s+/gu, " ")
								.trim()
								.slice(0, 80);
						}
						const countRow = db.prepare("select count(*) as c from entries").get() as unknown as { c?: number };
						entries = countRow?.c ?? 0;
						const task = db
							.prepare("select status, record from tasks order by id desc limit 1")
							.get() as unknown as { status?: string; record?: string } | undefined;
						const status = task?.status;
						// State is derived only from durable session state: the task record and the pi.question document.
						if (status === "completing") {
							state = "finishing";
						} else if (status === "pending" || status === "running" || status === "waiting") {
							state = "working";
						} else if (status === "terminal") {
							state = /"(?:error|is_error)":\s*(?:"[^"]+"|true)/u.test(task?.record ?? "")
								? "failed"
								: "needs-instructions";
						} else {
							state = "needs-instructions";
						}
						if (meta.done === true) state = "done";
						// A pending durable question means the session is waiting on the user.
						const questionRow = db
							.prepare(
								"select r.content from document_revisions r join documents d on d.id = r.document_id where d.kind = '\"pi.question\"' order by r.seq desc limit 1",
							)
							.get() as unknown as { content?: string } | undefined;
						if (questionRow?.content !== undefined) {
							const doc = JSON.parse(questionRow.content) as { status?: string; question?: string };
							if (doc.status === "pending" && typeof doc.question === "string") {
								state = "needs-input";
								question = doc.question;
							}
						}
					} finally {
						db.close();
					}
				} catch {
					// session without a readable database
				}
				if (meta.done === true) state = "done";
				sessions.push({
					sessionId: id,
					createdAt: meta.createdAt ?? 0,
					lastActivityAt,
					cwd: meta.cwd ?? "",
					title,
					activity,
					state,
					entries,
					bytes,
					name: meta.name,
					hasUser: title.length > 0 || meta.name !== undefined,
					done: meta.done === true,
					question,
					origin: "pi",
				});
			} catch {
				// not a session directory
			}
		}
		return sessions;
	}

	/** Full-screen all-sessions overview; picking one switches and returns to chat. */
	#openSessionOverview(): void {
		this.#sessionItems = this.#listSessions();
		this.#sessionQuery = "";
		this.#sessionAll = false;
		this.#captainSelected = false;
		this.#sessionIndex = 0;
		this.#sessionPreview = false;
		this.#sessionRenaming = false;
		this.#agentDispatch = "";
		this.#screen = "sessions";
		this.#rebuild();
		void this.#pruneEmptySessions();
	}

	/** pi (A) sessions in the current view, flattened for cursor navigation. */
	#visibleSessions(): SessionEntry[] {
		return this.#sessionGroups().flatMap((group) => group.rows);
	}

	/** The single, stable C entry point ("captain"), when a C source is registered. */
	#captainRow(): SessionEntry | undefined {
		return this.#listCEntries()[0];
	}

	/**
	 * The list contents. No query: this project's sessions (or every project under Ctrl+A), sorted by
	 * activity time. With a query: matches from the current project first, then global matches from
	 * other projects — each group still activity-time sorted.
	 */
	#sessionGroups(): Array<{ label: string | undefined; rows: SessionEntry[] }> {
		const byActivity = (left: SessionEntry, right: SessionEntry): number =>
			right.lastActivityAt - left.lastActivityAt || left.sessionId.localeCompare(right.sessionId);
		const owned = this.#sessionItems.filter((session) => session.hasUser || session.sessionId === this.#sessionId);
		const query = this.#sessionQuery.trim().toLowerCase();
		if (query.length === 0) {
			const rows = owned.filter((session) => this.#sessionAll || session.cwd === process.cwd()).sort(byActivity);
			return [{ label: undefined, rows }];
		}
		const matches = owned.filter((session) => this.#matchesQuery(session, query));
		const local = matches.filter((session) => session.cwd === process.cwd()).sort(byActivity);
		const global = matches.filter((session) => session.cwd !== process.cwd()).sort(byActivity);
		const groups: Array<{ label: string | undefined; rows: SessionEntry[] }> = [];
		if (local.length > 0) groups.push({ label: undefined, rows: local });
		if (global.length > 0) groups.push({ label: `global · ${global.length}`, rows: global });
		return groups;
	}

	/** Rows contributed by registered C sources (a single "captain" entry today), activity-time sorted. */
	#listCEntries(): SessionEntry[] {
		const query = this.#sessionQuery.toLowerCase();
		const entries: SessionEntry[] = [];
		for (const source of listAgentViewSources()) {
			try {
				for (const entry of source.list()) {
					const row: SessionEntry = { ...entry, origin: "c" };
					if (this.#matchesQuery(row, query)) entries.push(row);
				}
			} catch {
				// a misbehaving C source must never break the Agent View
			}
		}
		return entries.sort(
			(left, right) => right.lastActivityAt - left.lastActivityAt || left.sessionId.localeCompare(right.sessionId),
		);
	}

	#matchesQuery(session: SessionEntry, query: string): boolean {
		return (
			query.length === 0 ||
			session.sessionId.toLowerCase().includes(query) ||
			session.cwd.toLowerCase().includes(query) ||
			session.title.toLowerCase().includes(query) ||
			(session.name?.toLowerCase().includes(query) ?? false)
		);
	}

	#renderSessionOverview(): Container {
		const container = new Container();
		const visible = this.#visibleSessions();
		const scoped = this.#sessionItems.filter((session) => this.#sessionAll || session.cwd === process.cwd());
		const needsInput = scoped.filter((session) => session.state === "needs-input").length;
		const divider = theme.fg("muted", "─".repeat(60));

		// 1. Captain — the single, stable C entry point, on top.
		const captain = this.#captainRow();
		if (captain !== undefined) {
			const name = this.#sessionName(captain);
			const prefix = this.#captainSelected ? `${theme.fg("accent", "❯")} ` : "  ";
			const label = this.#captainSelected ? theme.bold(name) : name;
			container.addChild(new Text(`${prefix}${agentStateTag(captain.state)} ${label}`, 1, 0));
		}

		// 2. Divider, then the search box, then a second divider.
		container.addChild(new Text(divider, 1, 1));
		const queryLine = this.#sessionQuery.length > 0 ? this.#sessionQuery : theme.fg("muted", "Search…");
		container.addChild(new Text(`${theme.fg("accent", "⌕ ")}${queryLine}`, 1, 0));
		container.addChild(new Text(divider, 1, 1));

		// 3. The list: sessions sorted by activity time, scrollable all the way to the bottom.
		const scope =
			theme.fg("muted", `most active first · ${this.#sessionAll ? "all projects" : shortenPath(process.cwd())}`) +
			(needsInput > 0 ? theme.fg("warning", ` · ${needsInput} need${needsInput === 1 ? "s" : ""} input`) : "");
		container.addChild(new Text(scope, 1, 0));
		if (visible.length === 0) {
			container.addChild(
				new Text(theme.fg("muted", this.#sessionQuery.length > 0 ? "No matches" : "No sessions"), 1, 1),
			);
		}
		// The list is its own box: it scrolls internally around the cursor instead of the whole page.
		const rows: Array<{ session: SessionEntry; label: string | undefined }> = [];
		for (const group of this.#sessionGroups()) {
			for (const session of group.rows) rows.push({ session, label: group.label });
		}
		const maxRows = 12;
		const start = Math.max(0, Math.min(this.#sessionIndex - Math.floor(maxRows / 2), rows.length - maxRows));
		const end = Math.min(rows.length, start + maxRows);
		if (start > 0) container.addChild(new Text(theme.fg("muted", "  ↑"), 1, 0));
		for (let index = start; index < end; index++) {
			const row = rows[index]!;
			const session = row.session;
			if (row.label !== undefined && rows[index - 1]?.label !== row.label) {
				container.addChild(new Text(theme.fg("muted", `  ⟨${row.label}⟩`), 1, 0));
			}
			const selected = index === this.#sessionIndex;
			const name = this.#sessionName(session);
			const current = session.sessionId === this.#sessionId ? theme.fg("accent", " ◂ current") : "";
			const where = theme.fg("muted", shortenPath(session.cwd) || "?");
			const age = theme.fg("muted", relativeTime(session.lastActivityAt));
			const activity =
				session.activity.length > 0 && session.activity !== name ? theme.fg("muted", `  ${session.activity}`) : "";
			const prefix = selected ? `${theme.fg("accent", "❯")} ` : "  ";
			container.addChild(
				new Text(`${prefix}${agentStateTag(session.state)} ${selected ? theme.bold(name) : name}${current}`, 1, 0),
			);
			container.addChild(new Text(`     ${where} · ${age}${activity}`, 1, 0));
		}
		if (end < rows.length) container.addChild(new Text(theme.fg("muted", "  ↓"), 1, 0));
		if (this.#sessionRenaming) {
			container.addChild(new Text(theme.fg("accent", `Rename: ${this.#sessionRenameValue}▏`), 1, 1));
		}
		if (this.#sessionPreview) {
			const session = this.#selectedRow();
			if (session !== undefined) {
				container.addChild(
					new Text(
						theme.fg(
							"muted",
							`── peek ──\n${
								session.question !== undefined
									? `  ❓ ${session.question}\n  answer with /reply <answer>\n`
									: ""
							}  ${session.activity || session.title || "(no output yet)"}\n  cwd: ${session.cwd || "(unknown)"} · entries: ${session.entries} · ${formatBytes(session.bytes)}`,
						),
						1,
						1,
					),
				);
			}
		}
		const composer =
			this.#agentDispatch.length > 0
				? this.#agentDispatch
				: theme.fg("muted", "/dispatch <task> to launch an agent…");
		container.addChild(new Text(`${theme.fg("accent", "❯")} ${composer}`, 1, 1));
		container.addChild(
			new Text(
				theme.fg(
					"muted",
					"type to search · /dispatch <task> · Ctrl+A all/this · Space peek · Enter attach · /reply · /done · Ctrl+X stop · Esc exit",
				),
				1,
				1,
			),
		);
		return container;
	}

	#sessionName(session: SessionEntry): string {
		if (session.name !== undefined && session.name.length > 0) return session.name;
		if (session.title.length > 0) return session.title;
		return session.sessionId.slice(0, 8);
	}

	#handleSessionOverviewInput(data: string): void {
		if (this.#sessionRenaming) {
			if (data === "\r" || data === "\n") this.#saveSessionName();
			else if (data === "\u001b") this.#sessionRenaming = false;
			else if (data === "\u007f") this.#sessionRenameValue = this.#sessionRenameValue.slice(0, -1);
			else if (data.length === 1 && data >= " ") this.#sessionRenameValue += data;
			this.#rebuild();
			return;
		}
		if (data === "\u001b[A" || data === "\u001bOA") {
			const count = this.#visibleSessions().length;
			if (this.#captainSelected) {
				this.#captainSelected = false;
				this.#sessionIndex = Math.max(0, count - 1);
			} else if (this.#sessionIndex === 0 && this.#captainRow() !== undefined) {
				this.#captainSelected = true;
			} else {
				this.#sessionIndex = count === 0 ? 0 : (this.#sessionIndex - 1 + count) % count;
			}
		} else if (data === "\u001b[B" || data === "\u001bOB") {
			const count = this.#visibleSessions().length;
			if (this.#captainSelected) {
				this.#captainSelected = false;
				this.#sessionIndex = 0;
			} else {
				this.#sessionIndex = count === 0 ? 0 : (this.#sessionIndex + 1) % count;
			}
		} else if (data === "\u001b[C" || data === "\u001bOC") {
			void this.#confirmSession();
			return;
		} else if (data === "\r" || data === "\n") {
			const text = this.#agentDispatch.trim();
			if (text === "/done") {
				this.#markDone(this.#selectedRow());
				return;
			}
			if (text.startsWith("/reply ")) {
				void this.#answerQuestion(this.#selectedRow()?.sessionId, text.slice(7).trim());
				return;
			}
			if (text.startsWith("/dispatch ")) {
				this.#agentDispatch = "";
				void this.#dispatchAgent(text.slice(10).trim());
				return;
			}
			void this.#confirmSession();
			return;
		} else if (data === "\u001b") {
			if (this.#sessionPreview) this.#sessionPreview = false;
			else if (this.#agentDispatch.length > 0) this.#agentDispatch = "";
			else this.#screen = "chat";
		} else if (data === "\u0001") {
			this.#sessionAll = !this.#sessionAll;
			this.#sessionIndex = 0;
		} else if (data === "\u0012") {
			const session = this.#selectedRow();
			if (session !== undefined) {
				this.#sessionRenaming = true;
				this.#sessionRenameValue = session.name ?? session.title;
			}
		} else if (data === "\u0018") {
			void this.#stopAgent();
			return;
		} else if (data === "\t" || data === "\u0009") {
			void this.#tabHint();
			return;
		} else if (data === " ") {
			if (this.#agentDispatch.length === 0) this.#sessionPreview = !this.#sessionPreview;
			else this.#agentDispatch += " ";
		} else if (data === "\u007f") {
			if (this.#agentDispatch.length > 0) {
				this.#agentDispatch = this.#agentDispatch.slice(0, -1);
			} else {
				this.#sessionQuery = this.#sessionQuery.slice(0, -1);
				this.#sessionIndex = 0;
				this.#captainSelected = false;
			}
		} else if (data === "/" && this.#agentDispatch.length === 0) {
			this.#agentDispatch = "/";
		} else if (data.length === 1 && data >= " ") {
			// Typing filters the list below (local matches first, then global); a leading "/" is a command.
			if (this.#agentDispatch.startsWith("/")) {
				this.#agentDispatch += data;
			} else {
				this.#sessionQuery += data;
				this.#sessionIndex = 0;
				this.#captainSelected = false;
			}
		}
		this.#rebuild();
	}

	/** Create a git worktree for an isolated background agent. Returns undefined when not applicable. */
	async #prepareWorktree(): Promise<string | undefined> {
		if (process.env.PI_NO_WORKTREE === "1") return undefined;
		const top = await new Promise<string>((done) => {
			execFile("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() }, (error, stdout) =>
				done(error ? "" : stdout.trim()),
			);
		});
		if (top.length === 0) return undefined;
		const worktree = join(top, ".pi", "worktrees", `agent-${Date.now().toString(36)}`);
		try {
			mkdirSync(dirname(worktree), { recursive: true });
		} catch {
			return undefined;
		}
		const ok = await new Promise<boolean>((done) => {
			execFile("git", ["worktree", "add", "--detach", worktree], { cwd: top }, (error) => done(error === null));
		});
		return ok ? worktree : undefined;
	}

	/** Dispatch a new background agent: create a Session and send the prompt. */
	async #dispatchAgent(prompt: string): Promise<void> {
		this.#status = "Dispatching…";
		this.#agentDispatch = "";
		this.#rebuild();
		try {
			const server = this.#servers[0];
			if (server === undefined) throw new Error("no server available");
			const serverServices = server.server.open({
				services: [SessionDirectory, SessionManagement, PresentationPlugins],
				assertAccess() {},
				onError() {},
			});
			const sessionServices = server.session.open({
				services: [AgentController],
				assertAccess() {},
				onError() {},
			});
			const disposeAll = async (): Promise<void> => {
				await Promise.allSettled([
					serverServices.dispose(BACKGROUND_CONTEXT),
					sessionServices.dispose(BACKGROUND_CONTEXT),
				]);
			};
			try {
				await Promise.all([serverServices.ready(BACKGROUND_CONTEXT), sessionServices.ready(BACKGROUND_CONTEXT)]);
				const management = serverServices.use(SessionManagement);
				const plugins = serverServices.use(PresentationPlugins);
				const controller = sessionServices.use(AgentController);
				// Isolate a parallel agent's edits in a git worktree when possible.
				const worktree = await this.#prepareWorktree();
				const summary = await management.create(
					worktree === undefined ? {} : { cwd: worktree },
					BACKGROUND_CONTEXT,
				);
				await plugins.prepareSession({ sessionId: summary.sessionId, packagePaths: null }, BACKGROUND_CONTEXT);
				await management.attach(summary.sessionId, BACKGROUND_CONTEXT);
				await server.session.whenAttached(summary.sessionId, BACKGROUND_CONTEXT);
				const response = await controller.prompt({ message: prompt, images: null }, BACKGROUND_CONTEXT);
				if (!response.accepted) throw new Error(response.error.message);
				// Keep the connection until the durable task is recorded; the agent keeps running
				// server-side and the TUI stays interactive while we wait.
				void controller
					.waitForPrompt(response.operationId, BACKGROUND_CONTEXT)
					.then(
						() => {
							this.#sessionItems = this.#listSessions();
							this.#rebuild();
						},
						() => {},
					)
					.finally(() => void disposeAll());
			} catch (error) {
				await disposeAll();
				throw error;
			}
			this.#status = "";
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
		this.#sessionItems = this.#listSessions();
		this.#rebuild();
	}

	/** Stop the selected background agent (abort its active run). */
	async #stopAgent(): Promise<void> {
		const session = this.#selectedRow();
		if (session === undefined) return;
		this.#status = `Stopping ${session.sessionId.slice(0, 8)}…`;
		this.#rebuild();
		try {
			const server = this.#servers[0];
			if (server === undefined) throw new Error("no server available");
			const serverServices = server.server.open({
				services: [SessionManagement],
				assertAccess() {},
				onError() {},
			});
			const sessionServices = server.session.open({
				services: [AgentController],
				assertAccess() {},
				onError() {},
			});
			try {
				await Promise.all([serverServices.ready(BACKGROUND_CONTEXT), sessionServices.ready(BACKGROUND_CONTEXT)]);
				const management = serverServices.use(SessionManagement);
				const controller = sessionServices.use(AgentController);
				await management.attach(session.sessionId, BACKGROUND_CONTEXT);
				await server.session.whenAttached(session.sessionId, BACKGROUND_CONTEXT);
				await controller.abort(BACKGROUND_CONTEXT);
			} finally {
				await Promise.allSettled([
					serverServices.dispose(BACKGROUND_CONTEXT),
					sessionServices.dispose(BACKGROUND_CONTEXT),
				]);
			}
			this.#status = "";
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
		this.#sessionItems = this.#listSessions();
		this.#rebuild();
	}

	/** Poll session state in the background so the footer can show how many agents need input. */
	#startAgentPolling(): void {
		if (this.#agentPollTimer !== undefined) return;
		const tick = (): void => {
			try {
				const items = this.#listSessions();
				// Notify on lifecycle transitions (needs input / finished / failed).
				for (const session of items) {
					const previous = this.#agentStates.get(session.sessionId);
					if (previous !== undefined && previous !== session.state) {
						if (session.state === "needs-input")
							emitAgentNotification({
								kind: "needs-input",
								title: "pi agent needs input",
								message: session.question ?? session.title,
								sessionId: session.sessionId,
								cwd: session.cwd,
							});
						else if (session.state === "failed")
							emitAgentNotification({
								kind: "failed",
								title: "pi agent failed",
								message: session.title,
								sessionId: session.sessionId,
								cwd: session.cwd,
							});
						else if (
							session.state === "needs-instructions" &&
							(previous === "working" || previous === "finishing")
						)
							emitAgentNotification({
								kind: "finished",
								title: "pi agent finished",
								message: session.title,
								sessionId: session.sessionId,
								cwd: session.cwd,
							});
					}
					this.#agentStates.set(session.sessionId, session.state);
					// After a turn ends, pre-generate hints for the current session.
					if (
						session.sessionId === this.#sessionId &&
						session.state === "needs-instructions" &&
						(previous === "working" || previous === "finishing")
					)
						void this.#generateHints();
				}
				const needs = items.filter((session) => session.state === "needs-input").length;
				if (needs !== this.#needsInput) {
					this.#needsInput = needs;
					this.#sessionItems = items;
					if (!this.#closed) this.#rebuild();
				}
			} catch {
				// best-effort polling
			}
		};
		tick();
		this.#agentPollTimer = setInterval(tick, 10_000);
		this.#agentPollTimer.unref();
	}

	/** Remove sessions that never received a prompt (empty idle sessions) to free resources. */
	async #pruneEmptySessions(): Promise<void> {
		const empties = this.#sessionItems.filter((session) => !session.hasUser && session.sessionId !== this.#sessionId);
		if (empties.length === 0) return;
		const server = this.#servers[0];
		if (server === undefined) return;
		try {
			const serverServices = server.server.open({
				services: [SessionManagement],
				assertAccess() {},
				onError() {},
			});
			try {
				await serverServices.ready(BACKGROUND_CONTEXT);
				const management = serverServices.use(SessionManagement);
				for (const session of empties) {
					try {
						await management.remove(session.sessionId, BACKGROUND_CONTEXT);
					} catch {
						// already gone or in use
					}
				}
			} finally {
				await serverServices.dispose(BACKGROUND_CONTEXT);
			}
		} catch {
			// pruning is best-effort
		}
		this.#sessionItems = this.#listSessions();
		if (!this.#closed) this.#rebuild();
	}

	/** Mark a session done (user-confirmed) and fire the done hook; future memory can key off this. */
	#markDone(session: SessionEntry | undefined): void {
		this.#agentDispatch = "";
		if (session === undefined) {
			this.#rebuild();
			return;
		}
		const at = Date.now();
		try {
			const dir = join(getAgentDir(), "experimental", "sessions", session.sessionId);
			const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")) as Record<string, unknown>;
			meta.done = true;
			meta.doneAt = at;
			meta.userConfirmed = true;
			writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
			// Durable, observable marker so hooks (e.g. memory) can react to a user-confirmed done.
			writeFileSync(join(dir, "done.json"), JSON.stringify({ userConfirmed: true, at }));
		} catch {
			// ignore mark-done failures
		}
		for (const listener of sessionDoneListeners) {
			try {
				listener(session.sessionId);
			} catch {
				// listener failures must not break the UI
			}
		}
		this.#sessionItems = this.#listSessions();
		this.#rebuild();
	}

	/** Answer the selected session's durable pending question. */
	/** Set, clear, or read the session's durable goal (pi.goal). */
	async #runGoalCommand(args: string): Promise<void> {
		const text = args.trim();
		this.#status = "";
		try {
			const server = this.#servers[0];
			if (server === undefined) throw new Error("no server available");
			const services = server.session.open({ services: [Goals], assertAccess() {}, onError() {} });
			try {
				await services.ready(BACKGROUND_CONTEXT);
				const goals = services.use(Goals);
				const lower = text.toLowerCase();
				if (["clear", "stop", "off", "reset", "none", "cancel"].includes(lower)) {
					await goals.clear(BACKGROUND_CONTEXT);
					this.#goal = undefined;
					this.#status = "goal cleared";
				} else if (text.length === 0) {
					const state = await goals.status(BACKGROUND_CONTEXT);
					this.#goal = state.active ? state.condition : undefined;
					this.#status = state.active
						? `◎ goal: ${state.condition} (turn ${state.verdicts})`
						: state.condition.length > 0 && state.outcome.length > 0
							? `goal ${state.outcome}: ${state.condition}`
							: "No goal set";
				} else {
					await goals.set(text, BACKGROUND_CONTEXT);
					this.#goal = text;
					this.#status = `◎ goal set: ${text}`;
				}
			} finally {
				await services.dispose(BACKGROUND_CONTEXT);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
		this.#rebuild();
	}

	async #refreshGoal(): Promise<void> {
		try {
			const server = this.#servers[0];
			if (server === undefined) return;
			const services = server.session.open({ services: [Goals], assertAccess() {}, onError() {} });
			try {
				await services.ready(BACKGROUND_CONTEXT);
				const state = await services.use(Goals).status(BACKGROUND_CONTEXT);
				this.#goal = state.active ? state.condition : undefined;
			} finally {
				await services.dispose(BACKGROUND_CONTEXT);
			}
			this.#rebuild();
		} catch {
			// goal display is best-effort
		}
	}

	async #answerQuestion(sessionId: string | undefined, answer: string): Promise<void> {
		this.#agentDispatch = "";
		if (sessionId === undefined || answer.length === 0) {
			this.#rebuild();
			return;
		}
		this.#status = "Answering…";
		this.#rebuild();
		try {
			const server = this.#servers[0];
			if (server === undefined) throw new Error("no server available");
			const serverServices = server.server.open({
				services: [SessionManagement],
				assertAccess() {},
				onError() {},
			});
			const sessionServices = server.session.open({
				services: [Questions],
				assertAccess() {},
				onError() {},
			});
			try {
				await Promise.all([serverServices.ready(BACKGROUND_CONTEXT), sessionServices.ready(BACKGROUND_CONTEXT)]);
				const management = serverServices.use(SessionManagement);
				await management.attach(sessionId, BACKGROUND_CONTEXT);
				await server.session.whenAttached(sessionId, BACKGROUND_CONTEXT);
				const questions = sessionServices.use(Questions);
				const result = await questions.answer(answer, BACKGROUND_CONTEXT);
				if (!result.ok) throw new Error(result.error ?? "answer rejected");
			} finally {
				await Promise.allSettled([
					serverServices.dispose(BACKGROUND_CONTEXT),
					sessionServices.dispose(BACKGROUND_CONTEXT),
				]);
			}
			this.#status = "";
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
		this.#sessionItems = this.#listSessions();
		this.#rebuild();
	}

	/** The hint model: the `hint` role from agent-config (mirrors the goal supervisor), env override. */
	#hintModel(): string {
		if (process.env.PI_HINT_MODEL !== undefined && process.env.PI_HINT_MODEL.length > 0)
			return process.env.PI_HINT_MODEL;
		try {
			const config = JSON.parse(readFileSync(join(getAgentDir(), "agent-config.json"), "utf-8")) as {
				roles?: Record<string, { model?: string[] }>;
			};
			const model = config.roles?.hint?.model?.[0];
			if (typeof model === "string" && model.length > 0) return model;
		} catch {
			// fall through to the default
		}
		return "deepseek/deepseek-flash";
	}

	/** A bounded plain-text view of the current session's recent durable entries. */
	#recentTranscript(maxChars = 4000): string {
		if (this.#sessionId === undefined) return "";
		try {
			const db = new DatabaseSync(
				join(getAgentDir(), "experimental", "sessions", this.#sessionId, "session.sqlite"),
				{ readOnly: true },
			);
			try {
				const rows = db
					.prepare(
						"select json_extract(record,'$.kind') as kind, record from entries where json_extract(record,'$.kind') in ('pi.user','pi.assistant') order by id desc limit 12",
					)
					.all() as unknown as Array<{ kind?: string; record?: string }>;
				const lines = rows
					.reverse()
					.map((row) => {
						const text = row.record === undefined ? "" : extractText(parseRecordContent(row.record));
						return `${row.kind === "pi.user" ? "user" : "assistant"}: ${text.replace(/\s+/gu, " ").trim()}`;
					})
					.filter((line) => line.length > 6);
				const joined = lines.join("\n");
				return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
			} finally {
				db.close();
			}
		} catch {
			return "";
		}
	}

	/** Path of the `hint` role prompt (roles/<prompt> from agent-config). */
	#hintPromptPath(): string | undefined {
		try {
			const config = JSON.parse(readFileSync(join(getAgentDir(), "agent-config.json"), "utf-8")) as {
				roles?: Record<string, { prompt?: string }>;
			};
			const rel = config.roles?.hint?.prompt;
			if (typeof rel === "string" && rel.length > 0) {
				const path = join(getAgentDir(), "roles", rel);
				if (existsSync(path)) return path;
			}
		} catch {
			// no role prompt
		}
		return undefined;
	}

	/** Tab: generate hints once, then cycle them into the composer. */
	async #tabHint(): Promise<void> {
		if (this.#hints.length === 0 || this.#hintLoading) {
			await this.#generateHints();
			return;
		}
		this.#hintIndex = (this.#hintIndex + 1) % this.#hints.length;
		this.#applyHint();
		this.#rebuild();
	}

	#applyHint(): void {
		const hint = this.#hints[this.#hintIndex];
		if (hint === undefined) return;
		if (this.#screen === "sessions") this.#agentDispatch = hint;
		else if (this.#screen === "chat") this.#chatInput.setText(hint);
	}

	/** Ask the `hint` model for the user's likely next replies and cache them. */
	async #generateHints(): Promise<void> {
		if (this.#hintLoading) return;
		this.#hintLoading = true;
		this.#status = "hint: thinking…";
		this.#rebuild();
		try {
			// The instruction lives in the role prompt (roles/hint/prompt.md), not inline here.
			const transcript = this.#recentTranscript();
			const promptPath = this.#hintPromptPath();
			const launcher = join(getAgentDir(), "bin", "pi");
			const args = [
				"--mode",
				"json",
				"-p",
				// Reuse the same supervisor session as goal supervision.
				"--session",
				join(getAgentDir(), "supervisor", "session.jsonl"),
				"--no-extensions",
				"--no-tools",
				"--model",
				this.#hintModel(),
			];
			if (promptPath !== undefined) args.push("--append-system-prompt", promptPath);
			args.push(transcript.length > 0 ? transcript : "(no conversation yet)");
			const out = await new Promise<string>((done) => {
				execFile(launcher, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
					done(error === null ? stdout : ""),
				);
			});
			// Collect assistant text from the JSON stream.
			let text = "";
			for (const line of out.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("{")) continue;
				try {
					const event = JSON.parse(trimmed) as { message?: { role?: string; content?: unknown } };
					if (event.message?.role !== "assistant" || !Array.isArray(event.message.content)) continue;
					const part = event.message.content
						.filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
						.map((b) => (b as { text?: string }).text ?? "")
						.join("");
					if (part.trim().length > 0) text = part;
				} catch {
					// ignore
				}
			}
			const match = /\[[\s\S]*\]/.exec(text);
			this.#hints = [];
			if (match) {
				const parsed = JSON.parse(match[0]) as unknown;
				if (Array.isArray(parsed))
					this.#hints = parsed.filter((x): x is string => typeof x === "string").slice(0, 3);
			}
			this.#hintIndex = 0;
			this.#status = this.#hints.length > 0 ? `hint: ${this.#hints[0]}` : "hint: none";
			this.#applyHint();
		} catch (error) {
			this.#status = `hint failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.#hintLoading = false;
		this.#rebuild();
	}

	/** The row under the cursor: the Captain entry when selected, else the indexed pi session. */
	#selectedRow(): SessionEntry | undefined {
		if (this.#captainSelected) return this.#captainRow();
		return this.#visibleSessions()[this.#sessionIndex];
	}

	#saveSessionName(): void {
		const session = this.#selectedRow();
		this.#sessionRenaming = false;
		if (session === undefined) return;
		try {
			const path = join(getAgentDir(), "experimental", "sessions", session.sessionId, "meta.json");
			const meta = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
			meta.name = this.#sessionRenameValue;
			writeFileSync(path, JSON.stringify(meta));
		} catch {
			// ignore rename failures
		}
		this.#sessionItems = this.#listSessions();
	}

	async #confirmSession(): Promise<void> {
		const target = this.#selectedRow();
		this.#screen = "chat";
		if (target === undefined || target.sessionId === this.#sessionId) {
			this.#rebuild();
			return;
		}
		// Rebind by restarting the TUI on the chosen Session; runClientTui loops on restartSessionId.
		this.#restartSessionId = target.sessionId;
		this.#finish();
	}

	#updateAutocomplete(): void {
		const commands = this.#selectedSlashCommands()?.list() ?? [];
		this.#chatInput.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				commands.map((command) => ({
					name: command.name,
					description: command.description,
					...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
					...(command.getArgumentCompletions === undefined
						? {}
						: {
								getArgumentCompletions: async (prefix: string) => {
									const items = await command.getArgumentCompletions!(prefix);
									return items === null ? null : [...items];
								},
							}),
				})),
				process.cwd(),
			),
		);
		this.#requestRender();
	}

	#selectedSlashCommands(): SlashCommands | undefined {
		return this.#slashCommands;
	}

	#handleConnectionState(serverId: string, state: ServerConnectionState): void {
		if (this.#closed || this.#selectedServerId !== serverId) return;
		if (state.status === "connected") {
			if (this.#laneUnsubscribe === undefined) {
				this.#busy = true;
				this.#status = "Reattaching Session…";
				this.#rebuild();
			}
			return;
		}
		this.#busy = true;
		this.#status = state.status === "connecting" ? "Reconnecting to Radius…" : "Radius disconnected; retrying…";
		this.#queueRecovery(() => this.#closeLane());
		this.#rebuild();
	}

	#handleAttachmentState(feature: SessionFeature, state: SessionAttachmentState): void {
		if (this.#closed || this.#selectedServerId !== feature.serverId || this.#sessionId === undefined) return;
		if (state.status === "attached" && state.sessionId === this.#sessionId) {
			this.#queueRecovery(async () => {
				if (this.#laneUnsubscribe === undefined) await this.#openLane(feature);
				this.#busy = false;
				this.#status = "";
				this.#rebuild();
			});
			return;
		}
		if (state.status === "attaching" && state.sessionId === this.#sessionId) {
			this.#busy = true;
			this.#status = "Reattaching Session…";
			this.#rebuild();
		}
	}

	#queueRecovery(operation: () => Promise<void>): void {
		this.#recoveryTransition = this.#recoveryTransition
			.then(async () => {
				if (!this.#closed) await operation();
			})
			.catch((error: unknown) => {
				if (this.#closed) return;
				this.#busy = true;
				this.#status = `Reconnect error: ${message(error)}`;
				this.#rebuild();
			});
	}

	async #openLane(feature: SessionFeature): Promise<void> {
		await this.#closeLane();
		const view = new ExperimentalChatView(this.#ui, process.cwd());
		this.#chatView = view;
		this.#documentContainer.addChild(this.#sessionHeading);
		this.#documentContainer.addChild(view.transcript);
		this.#pendingMessagesContainer.addChild(view.pendingMessages);
		this.#laneUnsubscribe = feature.transcript.state.subscribe((value) => {
			view.apply(value);
			this.#rebuild();
		});
		if (feature.transcript.state.value === undefined) {
			await this.#closeLane();
			throw new Error("Transcript has no initialized view");
		}
	}

	async #closeLane(): Promise<void> {
		this.#laneUnsubscribe?.();
		this.#laneUnsubscribe = undefined;
		this.#chatView?.dispose();
		this.#chatView = undefined;
		this.#documentContainer.clear();
		this.#pendingMessagesContainer.clear();
		this.#statusContainer.clear();
	}

	async #runPrompt(messageText: string): Promise<void> {
		const prompt = messageText.trim();
		if (prompt.length === 0) return;
		if (prompt.startsWith("/")) {
			const separator = prompt.indexOf(" ");
			const name = prompt.slice(1, separator === -1 ? undefined : separator);
			const args = separator === -1 ? "" : prompt.slice(separator + 1).trim();
			await this.#executeSlashCommand(name, args);
			return;
		}
		this.#chatInput.setText("");
		try {
			await this.#submitPrompt(prompt);
		} catch (error) {
			this.#status = `Error: ${message(error)}`;
			this.#rebuild();
		}
	}

	async #executeSlashCommand(name: string, args: string): Promise<void> {
		const command = this.#selectedSlashCommands()
			?.list()
			.find((candidate) => candidate.name === name);
		this.#chatInput.setText("");
		if (command === undefined) {
			this.#status = `Unknown slash command: /${name}`;
			this.#rebuild();
			return;
		}
		try {
			const result = await command.run(args, BACKGROUND_CONTEXT);
			if (result !== undefined) {
				if ("entryId" in result) this.#reportQueue(result);
				else this.#reportOperation(result);
			}
		} catch (error) {
			this.#status = `Error: ${message(error)}`;
			this.#rebuild();
		}
	}

	async #submitPrompt(prompt: string): Promise<void> {
		const controller = this.#selectedController();
		if (controller === undefined) throw new Error("No Session AgentController service is available");
		const view = this.#conversationView();
		const running = view !== undefined && liveOf(view).run !== undefined;
		this.#status = running ? "Queueing steering message…" : "Running turn…";
		this.#rebuild();
		if (running) this.#reportQueue(await controller.steer({ message: prompt, images: null }, BACKGROUND_CONTEXT));
		else this.#reportOperation(await controller.prompt({ message: prompt, images: null }, BACKGROUND_CONTEXT));
	}

	async #queueFollowUp(text: string): Promise<void> {
		const controller = this.#selectedController();
		if (controller === undefined) return;
		try {
			this.#status = "Queueing follow-up…";
			this.#rebuild();
			this.#reportQueue(await controller.followUp({ message: text, images: null }, BACKGROUND_CONTEXT));
		} catch (error) {
			this.#status = `Error: ${message(error)}`;
			this.#rebuild();
		}
	}

	#reportOperation(response: AgentOperationResponse): void {
		this.#status = response.accepted ? "" : `Operation rejected: ${response.error.message}`;
		this.#rebuild();
	}

	#reportQueue(response: AgentQueueResponse): void {
		this.#status = response.accepted ? `Queued ${response.entryId}.` : `Message rejected: ${response.error.message}`;
		this.#rebuild();
	}

	#interrupt(): void {
		const view = this.#conversationView();
		const controller = this.#selectedController();
		if (view === undefined || liveOf(view).run === undefined || controller === undefined) return;
		this.#status = "Aborting…";
		this.#rebuild();
		void controller.abort(BACKGROUND_CONTEXT).then(
			() => {
				if (this.#status !== "Aborting…") return;
				this.#status = "";
				this.#rebuild();
			},
			(error: unknown) => {
				this.#status = `Error: ${message(error)}`;
				this.#rebuild();
			},
		);
	}

	#selectedController(): AgentController | undefined {
		return this.#controller;
	}

	#conversationView(): ConversationView | undefined {
		return this.#session?.transcript.state.value;
	}

	#footer(): string {
		const view = this.#conversationView();
		if (!view) return "/model · /thinking · /compact · /reload";
		const agent = (view.docs["pi.agent"] ?? {}) as AgentState;
		const model = agent.model === undefined ? "no model" : `${agent.model.provider}/${agent.model.modelId}`;
		const agentsHint = this.#needsInput > 0 ? `← ${this.#needsInput} agents` : "← agents";
		const goalHint = this.#goal === undefined ? "" : ` · ◎ goal: ${this.#goal.slice(0, 40)}`;
		return `${model} · thinking:${agent.thinkingLevel ?? "off"} · ${view.entries.length} entries · ${agentsHint}${goalHint} · /model · /thinking · /goal`;
	}
}

async function prepareClientSession(
	command: ClientCommand,
	servers: readonly ClientTuiServer[],
): Promise<PreparedClientSession> {
	const opened = servers.map((server) => ({
		server,
		services: server.server.open({
			services: [SessionDirectory, SessionManagement, PresentationPlugins],
			assertAccess() {},
			onError() {},
		}),
	}));
	try {
		const features = opened.map(({ server, services }) => ({
			server,
			directory: services.use(SessionDirectory),
			management: services.use(SessionManagement),
			plugins: services.use(PresentationPlugins),
		}));
		await Promise.all(opened.map(({ services }) => services.ready(BACKGROUND_CONTEXT)));
		let selected:
			| {
					readonly server: ClientTuiServer;
					readonly management: SessionManagement;
					readonly plugins: PresentationPlugins;
					readonly summary: SessionSummary;
			  }
			| undefined;
		if (command.sessionId !== undefined) {
			const matches = features.flatMap((feature) =>
				(feature.directory.state.value?.sessions ?? [])
					.filter((session) => session.sessionId === command.sessionId)
					.map((summary) => ({
						server: feature.server,
						management: feature.management,
						plugins: feature.plugins,
						summary,
					})),
			);
			if (matches.length > 1) throw new Error(`Session ${command.sessionId} is available from more than one server`);
			selected = matches[0];
			if (selected === undefined) {
				if (command.connect?.transport === "radius") {
					throw new Error(`Remote server does not contain Session ${command.sessionId}`);
				}
				const feature = requireSingleServer(features);
				selected = {
					server: feature.server,
					management: feature.management,
					plugins: feature.plugins,
					summary: await feature.management.create({ id: command.sessionId }, BACKGROUND_CONTEXT),
				};
			}
		} else if (command.continue === true || command.resume === true) {
			selected = features
				.flatMap((feature) =>
					(feature.directory.state.value?.sessions ?? []).map((summary) => ({
						server: feature.server,
						management: feature.management,
						plugins: feature.plugins,
						summary,
					})),
				)
				.sort(
					(left, right) =>
						right.summary.createdAt - left.summary.createdAt ||
						left.summary.serverId.localeCompare(right.summary.serverId) ||
						left.summary.sessionId.localeCompare(right.summary.sessionId),
				)[0];
		}
		if (selected === undefined) {
			const feature = requireSingleServer(features);
			selected = {
				server: feature.server,
				management: feature.management,
				plugins: feature.plugins,
				summary: await feature.management.create({}, BACKGROUND_CONTEXT),
			};
		}
		const presentationPlugins = await selected.plugins.prepareSession(
			{
				sessionId: selected.summary.sessionId,
				packagePaths: command.pluginPackages?.map((packagePath) => resolve(packagePath)) ?? null,
			},
			BACKGROUND_CONTEXT,
		);
		await selected.management.attach(selected.summary.sessionId, BACKGROUND_CONTEXT);
		await selected.server.session.whenAttached(selected.summary.sessionId, BACKGROUND_CONTEXT);
		return {
			server: selected.server,
			summary: selected.summary,
			presentationPlugins,
		};
	} finally {
		await Promise.allSettled(opened.map(({ services }) => services.dispose(BACKGROUND_CONTEXT)));
	}
}

export async function runClientTui(command: ClientCommand, options: RunClientTuiOptions = {}): Promise<void> {
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	// `pi agents` opens the Agent View without creating an empty session; attach to the newest
	// non-empty session so no empty leftover is kept alive by the current marker.
	const baseCommand: ClientCommand = (() => {
		if (
			options.startInAgentsView !== true ||
			command.sessionId !== undefined ||
			command.continue === true ||
			command.resume === true
		) {
			return command;
		}
		const existing = newestNonEmptySessionId();
		return existing === undefined ? { ...command, continue: true } : { ...command, sessionId: existing };
	})();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	setRegisteredThemes(resourceLoader.getThemes().themes);
	const runtime = await openClientRuntime(command, options);
	const tui = createInteractiveTui({
		tuiMode: "fullscreen",
		showHardwareCursor: settingsManager.getShowHardwareCursor(),
		logDirectory: agentDir,
		fullscreenWheelScrollLines: settingsManager.getFullscreenWheelScrollLines(),
	});
	tui.setClearOnShrink(settingsManager.getClearOnShrink());
	let component: ExperimentalClientTui | undefined;
	let tuiStarted = false;
	const themeController = new InteractiveThemeController(tui, {
		getSettingsManager: () => settingsManager,
		showError: (error) => component?.showError(error),
		onChanged: () => component?.refreshTheme(),
	});
	const servers = runtime.servers.map((server) => ({
		serverId: server.route.serverId,
		radius: server.route.transport === "radius",
		server: server.server,
		session: server.session,
	}));
	try {
		// The overview can ask to switch Session; restart the TUI bound to the chosen one.
		let nextSessionId: string | undefined;
		for (;;) {
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => {
				finish = () => resolve();
			});
			const created = await ExperimentalClientTui.create({
				command: nextSessionId === undefined ? baseCommand : { ...baseCommand, sessionId: nextSessionId },
				ui: tui,
				servers,
				facetLoader: options.facetLoader,
				startInAgentsView: nextSessionId === undefined ? options.startInAgentsView : false,
				requestRender: () => tui.requestRender(),
				finish,
			});
			component = created;
			tui.addChild(created);
			tui.setLayoutRoot(created.layoutRoot);
			tui.setFocus(created);
			if (!tuiStarted) {
				tuiStarted = true;
				tui.start();
				themeController.applyFromSettings();
			} else {
				tui.requestRender();
			}
			await finished;
			nextSessionId = created.restartSessionId;
			await created.close();
			tui.removeChild(created);
			component = undefined;
			if (nextSessionId === undefined) break;
		}
	} finally {
		themeController.disableAutoSync();
		themeController.dispose();
		stopThemeWatcher();
		if (tuiStarted) tui.stop();
		await component?.close();
		await runtime.dispose();
	}
}

function requireSingleServer<T>(features: readonly T[]): T {
	if (features.length !== 1) throw new Error("Starting a Session requires exactly one server");
	return features[0]!;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
