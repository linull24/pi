import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindSession } from "../src/experimental/block-session.ts";
import { createFileBlockStore, readIndex, rebuildIndex } from "../src/experimental/block-store.ts";
import { createMentionRouter, postMentionedBlock, subagentMentionTarget } from "../src/experimental/block-triggers.ts";
import {
	childrenOf,
	commit,
	createBlock,
	createMemoryBlockStore,
	fulfil,
	mention,
	mentioning,
	openCommitments,
	query,
	refer,
	referencedIds,
	referrersOf,
	release,
	resolveReferences,
	updateBlock,
	violate,
} from "../src/experimental/blocks.ts";

const roots: string[] = [];
function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-blocks-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("blocks", () => {
	it("creates, nests (ordered) and queries", () => {
		const store = createMemoryBlockStore();
		const convo = createBlock(store, { kind: "conversation", body: "root", author: "user" });
		const turn1 = createBlock(store, {
			kind: "turn",
			body: "hi",
			author: "user",
			parent: convo.id,
			props: { seq: 1 },
		});
		const turn2 = createBlock(store, {
			kind: "turn",
			body: "hello",
			author: "session:s1",
			parent: convo.id,
			props: { seq: 2 },
		});
		expect(childrenOf(store, convo.id).map((b) => b.id)).toEqual([turn1.id, turn2.id]);
		expect(store.get(convo.id)?.children).toEqual([turn1.id, turn2.id]);
		expect(query(store, { kind: "turn" }).length).toBe(2);
		expect(query(store, { props: { seq: 2 } }).map((b) => b.id)).toEqual([turn2.id]);
	});

	it("keeps weak relations separate from nesting, one truth per edge", () => {
		const store = createMemoryBlockStore();
		const step = createBlock(store, { kind: "plan-step", body: "do x", author: "user" });
		const evidence = createBlock(store, { kind: "evidence", body: "proof", author: "user" });
		refer(store, step.id, evidence.id, "cites", "why");
		refer(store, step.id, evidence.id, "cites"); // idempotent
		expect(store.get(step.id)?.refs).toHaveLength(1);
		expect(referrersOf(store, evidence.id, "cites").map((b) => b.id)).toEqual([step.id]);
		expect(store.get(step.id)?.parent).toBeNull();
	});

	it("addresses with public @ mentions", () => {
		const store = createMemoryBlockStore();
		const block = createBlock(store, { kind: "instruction", body: "deploy", author: "user" });
		mention(store, block.id, "captain");
		mention(store, block.id, "@captain"); // idempotent
		expect(store.get(block.id)?.mentions).toEqual(["@captain"]);
		expect(mentioning(store, "captain").map((b) => b.id)).toEqual([block.id]);
		expect(query(store, { mentions: "@captain", status: "open" }).map((b) => b.id)).toEqual([block.id]);
	});

	it("bumps revision and status on update", () => {
		const store = createMemoryBlockStore();
		const block = createBlock(store, { kind: "note", body: "x", author: "user" });
		const next = updateBlock(store, block.id, { body: "y", status: "closed", props: { tag: "a" } });
		expect(next.revision).toBe(2);
		expect(next.status).toBe("closed");
		expect(next.props).toEqual({ tag: "a" });
	});
});

describe("file block store", () => {
	it("persists per-block files and an index, and reloads them", () => {
		const root = tempRoot();
		const store = createFileBlockStore(root);
		const parent = createBlock(store, { kind: "plan", body: "the plan", author: "user" });
		createBlock(store, { kind: "plan-step", body: "step 1", author: "user", parent: parent.id });
		const reloaded = createFileBlockStore(root);
		expect(reloaded.list()).toHaveLength(2);
		expect(reloaded.get(parent.id)?.children).toHaveLength(1);
		expect(
			readIndex(root)
				.map((e) => e.kind)
				.sort(),
		).toEqual(["plan", "plan-step"]);
	});

	it("rebuilds the index from block files", () => {
		const root = tempRoot();
		const store = createFileBlockStore(root);
		createBlock(store, { kind: "note", body: "a", author: "user" });
		createBlock(store, { kind: "note", body: "b", author: "user" });
		expect(rebuildIndex(root)).toBe(2);
		expect(readIndex(root)).toHaveLength(2);
	});
});

describe("@ triggers", () => {
	it("fires known handles and reports unknown ones", async () => {
		const store = createMemoryBlockStore();
		const router = createMentionRouter();
		const seen: string[] = [];
		router.register({ handle: "captain", trigger: ({ block }) => void seen.push(`captain:${block.body}`) });
		const block = postMentionedBlock(store, {
			kind: "instruction",
			body: "deploy",
			author: "user",
			mentions: ["@captain", "@nobody"],
		});
		const result = await router.fire(block, store);
		expect(seen).toEqual(["captain:deploy"]);
		expect(result.fired).toEqual(["@captain"]);
		expect(result.unknown).toEqual(["@nobody"]);
	});

	it("@all broadcasts to every registered target", async () => {
		const store = createMemoryBlockStore();
		const router = createMentionRouter();
		const hits: string[] = [];
		router.register({ handle: "a", trigger: () => void hits.push("a") });
		router.register({ handle: "b", trigger: () => void hits.push("b") });
		const block = postMentionedBlock(store, { kind: "note", body: "hey all", author: "user", mentions: ["@all"] });
		const result = await router.fire(block, store);
		expect(hits.sort()).toEqual(["a", "b"]);
		expect(result.fired).toEqual(["@all"]);
	});

	it("the subagent adapter runs @<agent> and posts the result as a child block", async () => {
		const store = createMemoryBlockStore();
		const router = createMentionRouter();
		const run = vi.fn(async (task: string) => ({ ok: true, output: `done: ${task}` }));
		router.register(subagentMentionTarget("scout", run));
		const block = postMentionedBlock(store, {
			kind: "instruction",
			body: "map the repo",
			author: "user",
			mentions: ["@scout"],
		});
		await router.fire(block, store);
		expect(run).toHaveBeenCalledWith("map the repo", expect.anything());
		const results = query(store, { kind: "turn", parent: block.id });
		expect(results).toHaveLength(1);
		expect(results[0]?.body).toBe("done: map the repo");
		expect(results[0]?.author).toBe("subagent:scout");
	});
});

describe("session binding (the whole A2A surface)", () => {
	it("posts as the session, asks with mentions, and sees its public inbox", async () => {
		const store = createMemoryBlockStore();
		const router = createMentionRouter();
		const steered: Array<[string, string]> = [];
		const binding = bindSession({
			sessionId: "s1",
			store,
			router,
			targets: {
				agents: ["scout"],
				runSubagent: async (_agent, task) => ({ ok: true, output: `scouted ${task}` }),
				steerSession: async (id, text) => void steered.push([id, text]),
			},
			log: () => {},
		});

		const note = binding.post({ kind: "note", body: "thinking" });
		expect(note.author).toBe("session:s1");

		const { result } = await binding.ask({ kind: "instruction", body: "map it", mentions: ["@scout"] });
		expect(result.fired).toEqual(["@scout"]);
		expect(
			query(store, {
				parent:
					result.fired.length > 0 ? (store.list().find((b) => b.author === "subagent:scout")?.parent ?? "") : "",
			}).length,
		).toBeGreaterThan(0);

		await binding.ask({ kind: "instruction", body: "over to you", mentions: ["@session:s2"] });
		expect(steered).toEqual([["s2", "over to you"]]);

		// Another session mentions s1 -> it shows up in s1's public inbox.
		postMentionedBlock(store, { kind: "instruction", body: "ping", author: "session:s2", mentions: ["@session:s1"] });
		expect(binding.inbox().map((b) => b.body)).toEqual(["ping"]);

		expect(binding.close(note.id).status).toBe("closed");
	});
});

describe("commitments (not evidence)", () => {
	it("undertakes, fulfils, releases and violates with a public counterparty", () => {
		const store = createMemoryBlockStore();
		const c = commit(store, { body: "ship the gateway", author: "session:s1", to: "captain", due: 123 });
		expect(c.kind).toBe("commitment");
		expect(c.mentions).toEqual(["@captain"]);
		expect(openCommitments(store, "@captain").map((b) => b.id)).toEqual([c.id]);

		const work = createBlock(store, { kind: "turn", body: "done", author: "session:s1" });
		const fulfilled = fulfil(store, c.id, work.id);
		expect(fulfilled.props.status).toBe("fulfilled");
		expect(store.get(work.id)?.refs).toEqual([{ to: c.id, rel: "fulfil" }]);
		expect(openCommitments(store)).toHaveLength(0);

		const other = commit(store, { body: "x", author: "session:s1", to: "@bob" });
		expect(release(store, other.id, "no longer needed").props.status).toBe("released");
		const third = commit(store, { body: "y", author: "session:s1", to: "@bob" });
		expect(violate(store, third.id, "missed").props.status).toBe("violated");
	});
});

describe("inline [[block]] references", () => {
	it("finds referenced ids and expands them to real content (no copying)", () => {
		const store = createMemoryBlockStore();
		const target = createBlock(store, { kind: "note", body: "the payload", author: "session:s1" });
		const body = `see [[block:${target.id}]] and [[${target.id}]]`;
		expect(referencedIds(body)).toEqual([target.id]);
		const resolved = resolveReferences(store, body);
		expect(resolved).toContain("the payload");
		expect(resolved.match(/the payload/g)?.length).toBe(2);
	});

	it("leaves a missing reference untouched", () => {
		const store = createMemoryBlockStore();
		expect(resolveReferences(store, "[[block:b_missing]]")).toBe("[[block:b_missing]]");
	});
});
