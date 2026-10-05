/**
 * File-backed block store.
 *
 * Layout (see docs/block-store.md):
 *   <root>/b_….json     one JSON file per block — big bodies never force a whole-store rewrite
 *   <root>/index.jsonl  append-mostly index {id,kind,parent,refs[],mentions,status,updatedAt}
 *
 * The index is a cheap scan surface for queries; it is rebuildable from the block files at any time,
 * and `list()` reads the files so a stale index can never hide a block.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Block, BlockStore } from "./blocks.ts";

export interface IndexEntry {
	readonly id: string;
	readonly kind: string;
	readonly parent: string | null;
	readonly refs: readonly { readonly to: string; readonly rel: string }[];
	readonly mentions: readonly string[];
	readonly status: string;
	readonly updatedAt: number;
}

export function indexEntry(block: Block): IndexEntry {
	return {
		id: block.id,
		kind: block.kind,
		parent: block.parent,
		refs: block.refs.map((ref) => ({ to: ref.to, rel: ref.rel })),
		mentions: block.mentions,
		status: block.status,
		updatedAt: block.updatedAt,
	};
}

/** A block store backed by one JSON file per block plus an append-only index. */
export function createFileBlockStore(root: string): BlockStore {
	const cache = new Map<string, Block>();
	let loaded = false;

	const load = (): void => {
		if (loaded) return;
		loaded = true;
		if (!existsSync(root)) return;
		for (const name of readdirSync(root)) {
			if (!name.endsWith(".json")) continue;
			try {
				const block = JSON.parse(readFileSync(join(root, name), "utf-8")) as Block;
				if (typeof block?.id === "string") cache.set(block.id, block);
			} catch {
				// a corrupted block file must not hide the rest
			}
		}
	};

	return {
		get(id) {
			load();
			return cache.get(id);
		},
		put(block) {
			load();
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, `${block.id}.json`), `${JSON.stringify(block, null, "\t")}\n`);
			appendFileSync(join(root, "index.jsonl"), `${JSON.stringify(indexEntry(block))}\n`);
			cache.set(block.id, block);
		},
		list() {
			load();
			return [...cache.values()];
		},
	};
}

/** Read the appended index (last entry wins per id). Useful for cheap scans / diagnostics. */
export function readIndex(root: string): readonly IndexEntry[] {
	const path = join(root, "index.jsonl");
	if (!existsSync(path)) return [];
	const byId = new Map<string, IndexEntry>();
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const entry = JSON.parse(trimmed) as IndexEntry;
			if (typeof entry.id === "string") byId.set(entry.id, entry);
		} catch {
			// skip corrupted index line
		}
	}
	return [...byId.values()];
}

/** Rebuild index.jsonl from the block files (safe to run at any time). */
export function rebuildIndex(root: string): number {
	if (!existsSync(root)) return 0;
	const ids: string[] = [];
	const lines: string[] = [];
	for (const name of readdirSync(root)) {
		if (!name.endsWith(".json")) continue;
		try {
			const block = JSON.parse(readFileSync(join(root, name), "utf-8")) as Block;
			if (typeof block?.id !== "string") continue;
			ids.push(block.id);
			lines.push(JSON.stringify(indexEntry(block)));
		} catch {
			// skip corrupted block file
		}
	}
	rmSync(join(root, "index.jsonl"), { force: true });
	if (lines.length > 0) appendFileSync(join(root, "index.jsonl"), `${lines.join("\n")}\n`);
	return ids.length;
}
