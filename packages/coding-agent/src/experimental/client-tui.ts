import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
	visibleWidth,
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
import { type OpenClientRuntimeOptions, openClientRuntime } from "./client-runtime.ts";
import { ExperimentalChatView, liveOf } from "./client-tui-chat.ts";
import { createPresentationFacetLoaders } from "./plugins/bundled.ts";
import { AgentController, type AgentOperationResponse, type AgentQueueResponse } from "./services/agent-controller.ts";
import type {
	ServerConnectionState,
	ServerServiceSource,
	SessionAttachmentState,
	SessionServiceSource,
} from "./services/connection.ts";
import { PresentationPlugins } from "./services/plugins.ts";
import { PresentationUI } from "./services/presentation-ui.ts";
import { SessionDirectory, SessionManagement, type SessionSummary } from "./services/sessions.ts";
import { SlashCommands } from "./services/slash-commands.ts";
import {
	createBuiltInSlashCommandsFacet,
	createSlashCommandsRuntimeFacet,
} from "./services/slash-commands-provider.ts";
import { Transcript, type Transcript as TranscriptService } from "./services/transcript.ts";

export interface RunClientTuiOptions extends OpenClientRuntimeOptions {
	readonly facetLoader?: FacetLoader;
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

type SessionEntry = {
	readonly sessionId: string;
	readonly createdAt: number;
	readonly cwd: string;
	readonly title: string;
	readonly entries: number;
	readonly bytes: number;
	readonly name: string | undefined;
};

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

/** Claude Code-style rounded search field at the top of the session picker. */
class SearchBox implements Component {
	private readonly getQuery: () => string;

	constructor(getQuery: () => string) {
		this.getQuery = getQuery;
	}

	invalidate(): void {}
	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const query = this.getQuery();
		const label = query.length > 0 ? `⌕ ${query}` : theme.fg("muted", "⌕ Search…");
		const pad = Math.max(0, innerWidth - visibleWidth(label) - 1);
		const border = (text: string) => theme.fg("border", text);
		return [
			border(`╭${"─".repeat(innerWidth)}╮`),
			`${border("│")} ${label}${" ".repeat(pad)}${border("│")}`,
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
	}
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
	#sessionPreview = false;
	#sessionRenaming = false;
	#sessionRenameValue = "";
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
		this.#chatInput.onSubmit = (message) => void this.#runPrompt(message);
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
	}

	async #close(): Promise<void> {
		this.#closed = true;
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
				};
				let title = "";
				let entries = 0;
				let bytes = 0;
				try {
					const dbPath = join(dir, "session.sqlite");
					bytes = statSync(dbPath).size;
					const db = new DatabaseSync(dbPath, { readOnly: true });
					try {
						const row = db
							.prepare(
								"select record from entries where json_extract(record, '$.kind') = 'pi.user' order by id asc limit 1",
							)
							.get() as unknown as { record?: string } | undefined;
						if (row?.record !== undefined) {
							const parsed = JSON.parse(row.record) as { model?: Array<{ content?: unknown }> };
							const content = parsed.model?.[0]?.content;
							if (typeof content === "string") title = content.replace(/\s+/gu, " ").trim().slice(0, 80);
						}
						const countRow = db.prepare("select count(*) as c from entries").get() as unknown as { c?: number };
						entries = countRow?.c ?? 0;
					} finally {
						db.close();
					}
				} catch {
					// session without a readable database
				}
				sessions.push({
					sessionId: id,
					createdAt: meta.createdAt ?? 0,
					cwd: meta.cwd ?? "",
					title,
					entries,
					bytes,
					name: meta.name,
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
		this.#sessionIndex = 0;
		this.#sessionPreview = false;
		this.#sessionRenaming = false;
		this.#screen = "sessions";
		this.#rebuild();
	}

	/** Sessions passing the current-directory / query filters, newest first. */
	#visibleSessions(): SessionEntry[] {
		const query = this.#sessionQuery.toLowerCase();
		return this.#sessionItems
			.filter((session) => this.#sessionAll || session.cwd === process.cwd())
			.filter(
				(session) =>
					query.length === 0 ||
					session.sessionId.toLowerCase().includes(query) ||
					session.cwd.toLowerCase().includes(query) ||
					session.title.toLowerCase().includes(query) ||
					(session.name?.toLowerCase().includes(query) ?? false),
			)
			.sort((left, right) => right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId));
	}

	#renderSessionOverview(): Container {
		const container = new Container();
		const visible = this.#visibleSessions();
		const scoped = this.#sessionItems.filter((session) => this.#sessionAll || session.cwd === process.cwd());
		const position = visible.length === 0 ? 0 : Math.min(this.#sessionIndex + 1, visible.length);
		container.addChild(
			new Text(theme.fg("accent", "Resume session") + theme.fg("muted", ` (${position} of ${scoped.length})`), 1, 1),
		);
		container.addChild(new SearchBox(() => this.#sessionQuery));
		if (visible.length === 0) container.addChild(new Text(theme.fg("muted", "No sessions"), 1, 1));
		visible.slice(0, 12).forEach((session, index) => {
			const selected = index === this.#sessionIndex;
			const name = this.#sessionName(session);
			const marker = selected ? theme.fg("accent", "❯") : " ";
			container.addChild(new Text(`${marker} ${selected ? theme.bold(name) : name}`, 1, 1));
			container.addChild(
				new Text(
					theme.fg(
						"muted",
						`  ${relativeTime(session.createdAt)} · ${session.cwd || "(unknown)"} · ${formatBytes(session.bytes)}`,
					),
					1,
					0,
				),
			);
		});
		if (this.#sessionRenaming) {
			container.addChild(new Text(theme.fg("accent", `Rename: ${this.#sessionRenameValue}▏`), 1, 1));
		}
		if (this.#sessionPreview) {
			const session = visible[this.#sessionIndex];
			if (session !== undefined) {
				container.addChild(
					new Text(
						theme.fg(
							"muted",
							`Preview: ${session.sessionId}\n  cwd: ${session.cwd || "(unknown)"}\n  entries: ${session.entries}\n  created: ${new Date(session.createdAt).toLocaleString()}`,
						),
						1,
						1,
					),
				);
			}
		}
		container.addChild(
			new Text(theme.fg("muted", "Ctrl+A to show all projects · Type to search · Esc to cancel"), 1, 1),
		);
		container.addChild(new Text(theme.fg("muted", "Space to preview · Ctrl+R to rename · Enter to resume"), 1, 0));
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
		const count = Math.max(this.#visibleSessions().length, 1);
		if (data === "\u001b[A") this.#sessionIndex = (this.#sessionIndex - 1 + count) % count;
		else if (data === "\u001b[B") this.#sessionIndex = (this.#sessionIndex + 1) % count;
		else if (data === "\r" || data === "\n") {
			void this.#confirmSession();
			return;
		} else if (data === "\u001b") {
			this.#screen = "chat";
		} else if (data === "\u0001") {
			this.#sessionAll = !this.#sessionAll;
			this.#sessionIndex = 0;
		} else if (data === "\u0012") {
			const session = this.#visibleSessions()[this.#sessionIndex];
			if (session !== undefined) {
				this.#sessionRenaming = true;
				this.#sessionRenameValue = session.name ?? session.title;
			}
		} else if (data === " ") {
			this.#sessionPreview = !this.#sessionPreview;
		} else if (data === "\u007f") {
			this.#sessionQuery = this.#sessionQuery.slice(0, -1);
			this.#sessionIndex = 0;
		} else if (data.length === 1 && data >= " ") {
			this.#sessionQuery += data;
			this.#sessionIndex = 0;
		}
		this.#rebuild();
	}

	#saveSessionName(): void {
		const session = this.#visibleSessions()[this.#sessionIndex];
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
		const target = this.#visibleSessions()[this.#sessionIndex];
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
		return `${model} · thinking:${agent.thinkingLevel ?? "off"} · ${view.entries.length} entries · /model · /thinking · /compact · /reload`;
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
				command: nextSessionId === undefined ? command : { ...command, sessionId: nextSessionId },
				ui: tui,
				servers,
				facetLoader: options.facetLoader,
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
