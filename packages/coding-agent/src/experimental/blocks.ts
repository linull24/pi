/**
 * Blocks — the blackboard's unit.
 *
 * Everything is a block: conversations, turns, instructions, evidence, plans and plan steps. Blocks
 * **nest** (a structural `parent`/`children` tree) and link **weakly** (`refs[].rel`). Agent-to-agent
 * addressing is `@` (at) semantics and **public**: a block carries `mentions` and everyone can see
 * it — there is no private delivery.
 *
 * This module is the pure model + operations, deliberately independent of how blocks are stored, so
 * it can be unit-tested in memory and later mapped 1:1 onto Logseq (block = block, nesting = the
 * block tree, rel = `((block))` reference, `@` = a property).
 */

/** Known kinds are a hint, not a closed set. */
export type BlockKind =
	| "conversation"
	| "turn"
	| "instruction"
	| "commitment"
	| "plan"
	| "plan-step"
	| "note"
	| (string & {});

/** Relation vocabulary. `refer` is the generic weak link; `at` is a public `@`-mention edge. */
export type RelationType =
	| "refer"
	| "at"
	| "cites"
	| "commit"
	| "fulfil"
	| "release"
	| "violate"
	| "derives"
	| "answers"
	| "supersedes"
	| "blocks"
	| "implements"
	| (string & {});

export interface BlockRef {
	readonly to: string;
	readonly rel: RelationType;
	readonly note?: string;
}

export type BlockStatus = "open" | "closed" | "deleted";

export interface Block {
	readonly id: string;
	readonly kind: BlockKind;
	readonly title?: string;
	readonly body: string;
	/** Structural nesting. */
	readonly parent: string | null;
	/** Ordered children — the block tree. */
	readonly children: readonly string[];
	/** Weak links. */
	readonly refs: readonly BlockRef[];
	/** A2A addressing: `@name` mentions, public to every reader. */
	readonly mentions: readonly string[];
	/** Kind-specific data (role, seq, path, hash, …). */
	readonly props: Readonly<Record<string, unknown>>;
	readonly author: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly revision: number;
	readonly status: BlockStatus;
}

/** The minimal persistence surface the operations below need. */
export interface BlockStore {
	get(id: string): Block | undefined;
	put(block: Block): void;
	list(): readonly Block[];
}

export interface BlockQuery {
	readonly kind?: BlockKind;
	readonly parent?: string | null;
	readonly status?: BlockStatus;
	/** Only blocks that mention this target, e.g. `@me`. */
	readonly mentions?: string;
	/** Only blocks that have a `refs` edge to this id. */
	readonly refersTo?: string;
	/** Only blocks whose `props` match these exact values. */
	readonly props?: Readonly<Record<string, unknown>>;
}

let sequence = 0;
/** A stable, sortable id. Not a uuid — short and enough for one store. */
export function newBlockId(now = Date.now()): string {
	sequence = (sequence + 1) % 0x10000;
	return `b_${now.toString(36)}${sequence.toString(36).padStart(3, "0")}`;
}

export interface CreateBlockInput {
	readonly kind: BlockKind;
	readonly body: string;
	readonly title?: string;
	readonly parent?: string | null;
	readonly author: string;
	readonly refs?: readonly BlockRef[];
	readonly mentions?: readonly string[];
	readonly props?: Readonly<Record<string, unknown>>;
	readonly now?: number;
}

/** Create a block and, when it has a parent, append it to that parent's children. */
export function createBlock(store: BlockStore, input: CreateBlockInput): Block {
	const now = input.now ?? Date.now();
	const block: Block = {
		id: newBlockId(now),
		kind: input.kind,
		...(input.title === undefined ? {} : { title: input.title }),
		body: input.body,
		parent: input.parent ?? null,
		children: [],
		refs: input.refs ?? [],
		mentions: input.mentions ?? [],
		props: input.props ?? {},
		author: input.author,
		createdAt: now,
		updatedAt: now,
		revision: 1,
		status: "open",
	};
	store.put(block);
	if (block.parent !== null) linkChild(store, block.parent, block.id);
	return store.get(block.id) ?? block;
}

function linkChild(store: BlockStore, parentId: string, childId: string): void {
	const parent = store.get(parentId);
	if (parent === undefined) throw new Error(`nest: unknown parent ${parentId}`);
	if (parent.children.includes(childId)) return;
	store.put({
		...parent,
		children: [...parent.children, childId],
		updatedAt: Date.now(),
		revision: parent.revision + 1,
	});
}

export interface UpdateBlockInput {
	readonly title?: string;
	readonly body?: string;
	readonly status?: BlockStatus;
	readonly props?: Readonly<Record<string, unknown>>;
}

/** Patch a block; bump revision/updatedAt. Immutable: returns the new block. */
export function updateBlock(store: BlockStore, id: string, patch: UpdateBlockInput, now = Date.now()): Block {
	const block = store.get(id);
	if (block === undefined) throw new Error(`update: unknown block ${id}`);
	const next: Block = {
		...block,
		...(patch.title === undefined ? {} : { title: patch.title }),
		...(patch.body === undefined ? {} : { body: patch.body }),
		...(patch.status === undefined ? {} : { status: patch.status }),
		...(patch.props === undefined ? {} : { props: { ...block.props, ...patch.props } }),
		updatedAt: now,
		revision: block.revision + 1,
	};
	store.put(next);
	return next;
}

/** Move `childId` under `parentId` (append, order preserved). */
export function nest(store: BlockStore, parentId: string, childId: string): void {
	const child = store.get(childId);
	if (child === undefined) throw new Error(`nest: unknown child ${childId}`);
	if (child.parent !== null) unlinkChild(store, child.parent, childId);
	store.put({ ...child, parent: parentId, updatedAt: Date.now(), revision: child.revision + 1 });
	linkChild(store, parentId, childId);
}

function unlinkChild(store: BlockStore, parentId: string, childId: string): void {
	const parent = store.get(parentId);
	if (parent === undefined) return;
	store.put({
		...parent,
		children: parent.children.filter((id) => id !== childId),
		updatedAt: Date.now(),
		revision: parent.revision + 1,
	});
}

/** Add a directed weak relation (idempotent for the same `to` + `rel`). */
export function refer(
	store: BlockStore,
	fromId: string,
	toId: string,
	rel: RelationType = "refer",
	note?: string,
): Block {
	const from = store.get(fromId);
	if (from === undefined) throw new Error(`refer: unknown block ${fromId}`);
	if (from.refs.some((ref) => ref.to === toId && ref.rel === rel)) return from;
	const next: Block = {
		...from,
		refs: [...from.refs, { to: toId, rel, ...(note === undefined ? {} : { note }) }],
		updatedAt: Date.now(),
		revision: from.revision + 1,
	};
	store.put(next);
	return next;
}

/** Mention a target (`@captain`) on a block; public, idempotent. */
export function mention(store: BlockStore, id: string, target: string): Block {
	const block = store.get(id);
	if (block === undefined) throw new Error(`mention: unknown block ${id}`);
	const handle = target.startsWith("@") ? target : `@${target}`;
	if (block.mentions.includes(handle)) return block;
	const next: Block = {
		...block,
		mentions: [...block.mentions, handle],
		updatedAt: Date.now(),
		revision: block.revision + 1,
	};
	store.put(next);
	return next;
}

export function childrenOf(store: BlockStore, id: string): readonly Block[] {
	const block = store.get(id);
	if (block === undefined) return [];
	return block.children.flatMap((childId) => {
		const child = store.get(childId);
		return child === undefined ? [] : [child];
	});
}

/** Blocks that point at `id` (the inverse of `refs`, derived not stored). */
export function referrersOf(store: BlockStore, id: string, rel?: RelationType): readonly Block[] {
	return store
		.list()
		.filter((block) => block.refs.some((ref) => ref.to === id && (rel === undefined || ref.rel === rel)));
}

/** Blocks that mention `target` (accepts `@name` or `name`). */
export function mentioning(store: BlockStore, target: string): readonly Block[] {
	const handle = target.startsWith("@") ? target : `@${target}`;
	return store.list().filter((block) => block.mentions.includes(handle));
}

export function query(store: BlockStore, q: BlockQuery = {}): readonly Block[] {
	return store.list().filter((block) => {
		if (q.kind !== undefined && block.kind !== q.kind) return false;
		if (q.parent !== undefined && block.parent !== q.parent) return false;
		if (q.status !== undefined && block.status !== q.status) return false;
		if (
			q.mentions !== undefined &&
			!block.mentions.includes(q.mentions.startsWith("@") ? q.mentions : `@${q.mentions}`)
		)
			return false;
		if (q.refersTo !== undefined && !block.refs.some((ref) => ref.to === q.refersTo)) return false;
		if (q.props !== undefined) {
			for (const [key, value] of Object.entries(q.props)) {
				if (block.props[key] !== value) return false;
			}
		}
		return true;
	});
}

/** An in-memory store, for tests and for the trigger pipeline. */
export function createMemoryBlockStore(initial: readonly Block[] = []): BlockStore {
	const map = new Map<string, Block>(initial.map((block) => [block.id, block]));
	return {
		get: (id) => map.get(id),
		put: (block) => void map.set(block.id, block),
		list: () => [...map.values()],
	};
}

// ── Commitments (the replacement for `evidence`) ────────────────────────────────────────────────
//
// A commitment is an undertaking with a counterparty and a lifecycle — who owes what to whom — not a
// proof file. The counterparty is a **public** `@`-mention; the work that satisfies it links back.

export type CommitmentStatus = "open" | "fulfilled" | "released" | "violated";

export interface CommitInput {
	readonly body: string;
	readonly author: string;
	/** The counterparty, `@name` or `name` (public mention). */
	readonly to: string;
	readonly due?: number;
	readonly parent?: string | null;
	readonly props?: Readonly<Record<string, unknown>>;
}

/** Undertake a commitment toward `to`. */
export function commit(store: BlockStore, input: CommitInput, now = Date.now()): Block {
	const block = createBlock(store, {
		kind: "commitment",
		body: input.body,
		author: input.author,
		parent: input.parent ?? null,
		mentions: [input.to.startsWith("@") ? input.to : `@${input.to}`],
		refs: [],
		props: {
			status: "open" satisfies CommitmentStatus,
			...(input.due === undefined ? {} : { due: input.due }),
			...(input.props ?? {}),
		},
		now,
	});
	return block;
}

function setCommitmentStatus(
	store: BlockStore,
	id: string,
	status: CommitmentStatus,
	now: number,
	note?: string,
): Block {
	const block = store.get(id);
	if (block === undefined) throw new Error(`commitment: unknown block ${id}`);
	return updateBlock(
		store,
		id,
		{ status: status === "violated" ? "closed" : "open", props: { status, ...(note === undefined ? {} : { note }) } },
		now,
	);
}

/** Mark a commitment fulfilled; link the satisfying work with `fulfil`. */
export function fulfil(store: BlockStore, id: string, byId?: string, now = Date.now()): Block {
	const block = setCommitmentStatus(store, id, "fulfilled", now);
	if (byId !== undefined) refer(store, byId, id, "fulfil");
	return block;
}

/** Release a commitment (no longer owed). */
export function release(store: BlockStore, id: string, reason?: string, now = Date.now()): Block {
	return setCommitmentStatus(store, id, "released", now, reason);
}

/** Record a violated commitment. */
export function violate(store: BlockStore, id: string, reason?: string, now = Date.now()): Block {
	return setCommitmentStatus(store, id, "violated", now, reason);
}

/** Open commitments, optionally those made to a target. */
export function openCommitments(store: BlockStore, to?: string): readonly Block[] {
	const handle = to === undefined ? undefined : to.startsWith("@") ? to : `@${to}`;
	// "open" is the commitment's own props.status, not the block status (a fulfilled block stays open).
	return query(store, { kind: "commitment" }).filter(
		(block) => block.props.status === "open" && (handle === undefined || block.mentions.includes(handle)),
	);
}

// ── Inline `[[block]]` references (pass content, never copy) ─────────────────────────────────────

/** `[[block:<id>]]` or `[[<id>]]` inside a body. */
export const BLOCK_REF_PATTERN = /\[\[(?:block:)?(b_[A-Za-z0-9]+)\]\]/g;

/** The block ids referenced inline in a body, in order, deduplicated. */
export function referencedIds(body: string): string[] {
	const ids: string[] = [];
	for (const match of body.matchAll(BLOCK_REF_PATTERN)) {
		const id = match[1];
		if (id !== undefined && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * Expand inline `[[block]]` references to the referenced block's body so a peer gets the content by
 * reference rather than by copy. `depth` bounds recursion; a missing/cyclic ref is left as-is.
 */
export function resolveReferences(store: BlockStore, body: string, depth = 3): string {
	if (depth <= 0) return body;
	return body.replace(BLOCK_REF_PATTERN, (whole, id: string) => {
		const target = store.get(id);
		if (target === undefined) return whole;
		return `\n--- [[${id}]] ---\n${resolveReferences(store, target.body, depth - 1)}\n--- /[[${id}]] ---\n`;
	});
}
