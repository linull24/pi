/**
 * Read the agent-view session list from the durable store, for both the TUI (`client-tui`) and
 * `pi agents --json`. State is derived only from durable session state: the task record and the
 * `pi.question` document, plus the explicit `meta.json` done flag.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "../config.ts";

export type AgentSessionState = "working" | "needs-input" | "needs-instructions" | "finishing" | "done" | "failed";

export interface AgentSessionInfo {
	readonly sessionId: string;
	readonly createdAt: number;
	readonly cwd: string;
	readonly name?: string;
	readonly title: string;
	readonly activity: string;
	readonly state: AgentSessionState;
	readonly question?: string;
	readonly entries: number;
	readonly bytes: number;
	readonly hasUser: boolean;
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

/** List every local daemon session with its durable state. */
export function listAgentSessions(): AgentSessionInfo[] {
	const root = join(getAgentDir(), "experimental", "sessions");
	let ids: string[];
	try {
		ids = readdirSync(root).filter((id) => !id.endsWith(".lock"));
	} catch {
		return [];
	}
	const sessions: AgentSessionInfo[] = [];
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
			let state: AgentSessionState = "needs-instructions";
			let question: string | undefined;
			try {
				const dbPath = join(dir, "session.sqlite");
				bytes = statSync(dbPath).size;
				const db = new DatabaseSync(dbPath, { readOnly: true });
				try {
					const firstUser = db
						.prepare(
							"select record from entries where json_extract(record, '$.kind') = 'pi.user' order by id asc limit 1",
						)
						.get() as unknown as { record?: string } | undefined;
					if (firstUser?.record !== undefined) {
						title = extractText(parseRecordContent(firstUser.record)).replace(/\s+/gu, " ").trim().slice(0, 80);
					}
					const lastAssistant = db
						.prepare(
							"select record from entries where json_extract(record, '$.kind') = 'pi.assistant' order by id desc limit 1",
						)
						.get() as unknown as { record?: string } | undefined;
					if (lastAssistant?.record !== undefined) {
						activity = extractText(parseRecordContent(lastAssistant.record))
							.replace(/\s+/gu, " ")
							.trim()
							.slice(0, 80);
					}
					const countRow = db.prepare("select count(*) as c from entries").get() as unknown as { c?: number };
					entries = countRow?.c ?? 0;
					const task = db.prepare("select status, record from tasks order by id desc limit 1").get() as unknown as
						| { status?: string; record?: string }
						| undefined;
					const status = task?.status;
					if (status === "completing") state = "finishing";
					else if (status === "pending" || status === "running" || status === "waiting") state = "working";
					else if (status === "terminal")
						state = /"(?:error|is_error)":\s*(?:"[^"]+"|true)/u.test(task?.record ?? "")
							? "failed"
							: "needs-instructions";
					if (meta.done === true) state = "done";
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
			sessions.push({
				sessionId: id,
				createdAt: meta.createdAt ?? 0,
				cwd: meta.cwd ?? "",
				...(meta.name === undefined ? {} : { name: meta.name }),
				title,
				activity,
				state,
				...(question === undefined ? {} : { question }),
				entries,
				bytes,
				hasUser: title.length > 0 || meta.name !== undefined,
			});
		} catch {
			// not a session directory
		}
	}
	return sessions;
}
