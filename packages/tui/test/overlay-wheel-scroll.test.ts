import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** A focused modal overlay that handles keyboard input but has NO mouse handling. */
class KeyboardOnlyOverlay {
	focused = false;
	inputs: string[] = [];

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return Array.from({ length: 8 }, () => "o".repeat(40));
	}

	invalidate(): void {}
}

/** A tiny centered overlay, used to leave room outside it for the pointer. */
class KeyboardOnlyTinyOverlay {
	inputs: string[] = [];

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return ["ovl1", "ovl2"];
	}

	invalidate(): void {}
}

/** An overlay that handles the wheel itself; it must win over the keyboard fallback. */
class MouseAwareOverlay extends KeyboardOnlyOverlay {
	wheels = 0;

	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "wheel") return undefined;
		this.wheels += 1;
		return { handled: true, render: true };
	}
}

describe("alt-screen wheel over a modal overlay", () => {
	it("forwards the wheel to a focused overlay as Up/Down keys when it has no mouse handling", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 1 });
		tui.addChild(new Text("body", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const overlay = new KeyboardOnlyOverlay();
		const handle = tui.showOverlay(overlay);
		handle.focus();
		await terminal.waitForRender();

		// Wheel down over the overlay (SGR button 65 = wheel down).
		terminal.sendInput("\x1b[<65;20;6M");
		await terminal.waitForRender();
		assert.deepStrictEqual(overlay.inputs, ["\x1b[B"]);

		// Wheel up (SGR button 64 = wheel up).
		terminal.sendInput("\x1b[<64;20;6M");
		await terminal.waitForRender();
		assert.deepStrictEqual(overlay.inputs, ["\x1b[B", "\x1b[A"]);
		tui.stop();
	});

	it("lets a mouse-aware overlay consume the wheel itself", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 1 });
		tui.addChild(new Text("body", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const overlay = new MouseAwareOverlay();
		const handle = tui.showOverlay(overlay);
		handle.focus();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<65;20;6M");
		await terminal.waitForRender();
		assert.strictEqual(overlay.wheels, 1);
		assert.deepStrictEqual(overlay.inputs, []);
		tui.stop();
	});

	it("scrolls the conversation when the wheel is outside the focused overlay", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 1 });
		const transcript = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const chat = new ScrollView(new Text(transcript, 0, 0), { follow: "end", primary: true });
		tui.setLayoutRoot(chat);
		tui.start();
		await terminal.waitForRender();
		// Small centered overlay (2 rows x 4 cols) so the pointer can be outside it.
		const overlay = new KeyboardOnlyTinyOverlay();
		const handle = tui.showOverlay(overlay);
		handle.focus();
		await terminal.waitForRender();
		const before = chat.scrollTop;

		// Wheel up at the top-left corner, outside the overlay.
		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();

		assert.ok(chat.scrollTop < before, `chat should scroll (was ${before}, now ${chat.scrollTop})`);
		assert.deepStrictEqual(overlay.inputs, [], "the overlay must not receive keys for an outside wheel");
		tui.stop();
	});
});
