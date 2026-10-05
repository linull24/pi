/**
 * The `block` tool — the A2A blackboard as a **tool call**. The agent never touches raw files or JSON:
 * it posts blocks, `@`-mentions targets, queries, and reads its inbox through one tool.
 *
 * Everything is a block (conversation / turn / instruction / evidence / plan / plan-step). Blocks
 * nest (parent/children) and link weakly (refs[].rel); `@`-mentions are public addressing.
 *
 * Backing store: `<agent-dir>/blocks/` (the shared blackboard — everyone can see every block).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { type BlackboardBinding, bindSession } from "../../experimental/block-session.ts";
import { createFileBlockStore } from "../../experimental/block-store.ts";
import { createMentionRouter } from "../../experimental/block-triggers.ts";
import { mention as addMention, nest as nestBlock, query as queryBlocks, refer } from "../../experimental/blocks.ts";

export const BLOCK_TOOL_NAME = "block";

const ACTIONS = ["post", "ask", "nest", "refer", "mention", "query", "inbox", "close", "get"] as const;

const BlockParams = Type.Object({
	action: Type.String({ description: `One of: ${ACTIONS.join(", ")}` }),
	/** Target/other block id (nest/refer/mention/get/close). */
	id: Type.Optional(Type.String({ description: "Block id (for get/close/nest child/refer from/mention target)" })),
	kind: Type.Optional(
		Type.String({ description: "Block kind: conversation, turn, instruction, evidence, plan, plan-step, note" }),
	),
	body: Type.Optional(Type.String({ description: "Block body (the content)" })),
	title: Type.Optional(Type.String({ description: "Short title" })),
	parent: Type.Optional(Type.String({ description: "Parent block id (nesting)" })),
	to: Type.Optional(Type.String({ description: "Relation/reference target block id" })),
	rel: Type.Optional(
		Type.String({ description: "Relation type: refer, at, cites, derives, answers, supersedes, blocks, implements" }),
	),
	mentions: Type.Optional(Type.Array(Type.String(), { description: "Public @-mentions, e.g. ['@captain']" })),
	queryKind: Type.Optional(Type.String({ description: "query: filter by kind" })),
	queryMentions: Type.Optional(Type.String({ description: "query: filter by mention, e.g. '@captain'" })),
	queryStatus: Type.Optional(Type.String({ description: "query: filter by status (open/closed/deleted)" })),
});
type BlockArgs = Static<typeof BlockParams>;

/** The agent names the subagent adapter will `@`-run. */
const SUBAGENT_AGENTS = ["scout", "researcher", "planner", "reviewer", "worker"];

/** Run a named subagent by launching pi with the agent's system prompt (the fork's agent files). */
function runSubagent(agent: string, task: string): Promise<{ ok: boolean; output?: string; error?: string }> {
	const agentFile = path.join(getAgentDir(), "agents", `${agent}.md`);
	if (!fs.existsSync(agentFile)) return Promise.resolve({ ok: false, error: `unknown agent ${agent}` });
	const body = stripFrontmatter(fs.readFileSync(agentFile, "utf-8"));
	const tmp = path.join(getAgentDir(), "blocks", `.subagent-${agent}-${Date.now()}.md`);
	fs.mkdirSync(path.dirname(tmp), { recursive: true });
	fs.writeFileSync(tmp, body);
	const launcher = path.join(getAgentDir(), "bin", "pi");
	const command = fs.existsSync(launcher) ? launcher : "pi";
	return new Promise((resolve) => {
		const child = spawn(command, ["--mode", "json", "-p", "--no-session", "--append-system-prompt", tmp, task], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (data: Buffer) => {
			out += data.toString();
		});
		child.on("close", (code) => {
			fs.rmSync(tmp, { force: true });
			const text = lastAssistantText(out);
			resolve(code === 0 ? { ok: true, output: text } : { ok: false, error: text || `exit ${code}` });
		});
		child.on("error", (error) => resolve({ ok: false, error: String(error) }));
	});
}

function stripFrontmatter(md: string): string {
	const match = /^---\s*\n[\s\S]*?\n---\s*\n/.exec(md);
	return match === null ? md : md.slice(match[0].length);
}

function lastAssistantText(out: string): string {
	let last = "";
	for (const line of out.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const event = JSON.parse(trimmed) as { message?: { role?: string; content?: unknown } };
			const content = event.message?.content;
			if (event.message?.role !== "assistant" || !Array.isArray(content)) continue;
			const text = content
				.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
				.map((block) => (block as { text?: string }).text ?? "")
				.join("");
			if (text.trim().length > 0) last = text;
		} catch {
			// not a json event line
		}
	}
	return last;
}

let binding: BlackboardBinding | undefined;

function board(): BlackboardBinding {
	if (binding !== undefined) return binding;
	const store = createFileBlockStore(path.join(getAgentDir(), "blocks"));
	const router = createMentionRouter();
	binding = bindSession({
		sessionId: process.env.PI_SESSION_ID ?? "session",
		store,
		router,
		targets: {
			agents: SUBAGENT_AGENTS,
			runSubagent: (agent, task) => runSubagent(agent, task),
		},
		log: () => {},
	});
	return binding;
}

function text(value: string): { content: { type: "text"; text: string }[]; details: Record<string, never> } {
	return { content: [{ type: "text", text: value }], details: {} };
}

export function createBlockToolDefinition(): ToolDefinition<typeof BlockParams> {
	return {
		name: BLOCK_TOOL_NAME,
		label: "Block",
		description: [
			"The A2A blackboard. Everything is a block (conversation, turn, instruction, evidence, plan, plan-step).",
			"Blocks NEST (parent/children) and link WEAKLY (refs[].rel). Addressing is PUBLIC `@`-mention: everyone sees it.",
			`Actions: ${ACTIONS.join(", ")}.`,
			"post → create a block; ask → create a block AND fire its @-mentions (e.g. @scout runs a subagent, @captain notifies the captain);",
			"nest → move a block under another; refer → add a weak relation; mention → add a public @mention;",
			"query → find blocks; inbox → blocks that mention this session; close → mark a block closed; get → read one block.",
		].join(" "),
		parameters: BlockParams,
		async execute(_toolCallId: string, args: BlockArgs) {
			const b = board();
			const store = b.store;
			const summarize = (id: string): string => {
				const block = store.get(id);
				return block === undefined
					? `${id} (missing)`
					: `${block.id} [${block.kind}] ${block.title ?? block.body.slice(0, 60)}`;
			};
			switch (args.action) {
				case "post": {
					const block = b.post({
						kind: args.kind ?? "note",
						body: args.body ?? "",
						...(args.title === undefined ? {} : { title: args.title }),
						...(args.parent === undefined ? {} : { parent: args.parent }),
					});
					return text(`posted ${block.id} (${block.kind})`);
				}
				case "ask": {
					const { block, result } = await b.ask({
						kind: args.kind ?? "instruction",
						body: args.body ?? "",
						mentions: args.mentions ?? [],
						...(args.title === undefined ? {} : { title: args.title }),
						...(args.parent === undefined ? {} : { parent: args.parent }),
					});
					return text(
						`posted ${block.id}; fired ${result.fired.join(", ") || "none"}; unknown ${result.unknown.join(", ") || "none"}`,
					);
				}
				case "nest": {
					if (args.parent === undefined || args.id === undefined) return text("nest needs parent and id");
					nestBlock(store, args.parent, args.id);
					return text(`${args.id} is now a child of ${args.parent}`);
				}
				case "refer": {
					if (args.id === undefined || args.to === undefined) return text("refer needs id (from) and to (target)");
					refer(store, args.id, args.to, args.rel ?? "refer");
					return text(`${args.id} --${args.rel ?? "refer"}--> ${args.to}`);
				}
				case "mention": {
					const target = args.to ?? args.mentions?.[0];
					if (args.id === undefined || target === undefined) return text("mention needs id and to");
					addMention(store, args.id, target);
					return text(`${args.id} now mentions @${target.replace(/^@/, "")} (public)`);
				}
				case "query": {
					const rows = queryBlocks(store, {
						...(args.queryKind === undefined ? {} : { kind: args.queryKind }),
						...(args.queryMentions === undefined ? {} : { mentions: args.queryMentions }),
						...(args.queryStatus === undefined
							? {}
							: { status: args.queryStatus as "open" | "closed" | "deleted" }),
					});
					return text(rows.length === 0 ? "no blocks" : rows.map((block) => summarize(block.id)).join("\n"));
				}
				case "inbox": {
					const rows = b.inbox();
					return text(rows.length === 0 ? "inbox empty" : rows.map((block) => summarize(block.id)).join("\n"));
				}
				case "close": {
					if (args.id === undefined) return text("close needs id");
					const block = b.close(args.id);
					return text(`closed ${block.id}`);
				}
				case "get": {
					if (args.id === undefined) return text("get needs id");
					const block = store.get(args.id);
					return text(block === undefined ? `no block ${args.id}` : JSON.stringify(block, null, "\t"));
				}
				default:
					return text(`unknown action ${args.action}`);
			}
		},
	};
}

export default function blocksExtension(pi: {
	registerTool: (tool: ToolDefinition<typeof BlockParams>) => void;
}): void {
	pi.registerTool(createBlockToolDefinition());
}
