/**
 * `@`-mention triggers.
 *
 * A mention is **public** (it lives on a block everyone can read); whether it *wakes* someone is a
 * local decision made by a registered handler. This is the A2A trigger: write a block, mention
 * `@captain` / `@scout` / `@all`, and the matching handlers fire — including a **subagent adapter**
 * that turns `@<agent>` into a subagent run.
 */

import { type Block, type BlockStore, createBlock, mention } from "./blocks.ts";

export interface TriggerContext {
	readonly block: Block;
	readonly store: BlockStore;
	/** `@all` broadcast: how many handlers are wired up. */
	readonly broadcastSize: number;
	log?(message: string): void;
}

export interface MentionTarget {
	/** The handle without `@`, e.g. `captain`, `scout`, `all`. */
	readonly handle: string;
	trigger(context: TriggerContext): void | Promise<void>;
}

export interface MentionRouter {
	register(target: MentionTarget): () => void;
	handles(): readonly string[];
	/** Fire every mention on `block`. Unknown handles are reported, not fatal. */
	fire(block: Block, store: BlockStore, log?: (message: string) => void): Promise<MentionFireResult>;
}

export interface MentionFireResult {
	readonly fired: readonly string[];
	readonly unknown: readonly string[];
}

export function createMentionRouter(): MentionRouter {
	const targets = new Map<string, MentionTarget>();
	return {
		register(target) {
			targets.set(target.handle.replace(/^@/, ""), target);
			return () => {
				if (targets.get(target.handle.replace(/^@/, "")) === target)
					targets.delete(target.handle.replace(/^@/, ""));
			};
		},
		handles: () => [...targets.keys()],
		async fire(block, store, log) {
			const fired: string[] = [];
			const unknown: string[] = [];
			for (const raw of block.mentions) {
				const handle = raw.replace(/^@/, "");
				const context: TriggerContext = { block, store, broadcastSize: targets.size, ...(log ? { log } : {}) };
				if (handle === "all") {
					for (const target of targets.values()) {
						await target.trigger(context);
					}
					fired.push("@all");
					continue;
				}
				// A handle may carry a target after a colon (`@session:s2`); fall back to the prefix.
				const target =
					targets.get(handle) ??
					(handle.includes(":") ? targets.get(handle.slice(0, handle.indexOf(":"))) : undefined);
				if (target === undefined) {
					unknown.push(raw);
					continue;
				}
				await target.trigger(context);
				fired.push(raw);
			}
			return { fired, unknown };
		},
	};
}

export interface SubagentRunResult {
	readonly ok: boolean;
	readonly output?: string;
	readonly error?: string;
}

/**
 * The **subagent adapter**: `@<agent>` runs the named subagent with the mentioning block's body as
 * the task, and appends the result as a child block (so the outcome is on the blackboard too).
 */
export function subagentMentionTarget(
	agent: string,
	run: (task: string, context: TriggerContext) => Promise<SubagentRunResult>,
): MentionTarget {
	return {
		handle: agent,
		async trigger(context) {
			const result = await run(context.block.body, context);
			const body = result.ok
				? (result.output ?? "")
				: `subagent @${agent} failed: ${result.error ?? "unknown error"}`;
			createBlock(context.store, {
				kind: "turn",
				title: `@${agent} result`,
				body,
				parent: context.block.id,
				author: `subagent:${agent}`,
				refs: [{ to: context.block.id, rel: "answers" }],
				props: { agent, ok: result.ok },
			});
			context.log?.(`@${agent} ran (ok=${result.ok})`);
		},
	};
}

/**
 * The captain adapter: `@captain` delivers a public block to the captain session. `deliver` is the
 * side-channel steer (the captain already speaks that protocol).
 */
export function captainMentionTarget(deliver: (text: string, context: TriggerContext) => Promise<void>): MentionTarget {
	return {
		handle: "captain",
		async trigger(context) {
			await deliver(context.block.body, context);
			context.log?.("captain notified");
		},
	};
}

/** Convenience: create a block that mentions someone (the A2A write path). */
export function postMentionedBlock(
	store: BlockStore,
	input: {
		kind: Block["kind"];
		body: string;
		author: string;
		mentions: readonly string[];
		parent?: string | null;
		title?: string;
	},
): Block {
	const block = createBlock(store, {
		kind: input.kind,
		body: input.body,
		author: input.author,
		parent: input.parent ?? null,
		...(input.title === undefined ? {} : { title: input.title }),
	});
	for (const target of input.mentions) mention(store, block.id, target);
	return store.get(block.id) ?? block;
}
