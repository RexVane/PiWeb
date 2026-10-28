// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "@/hooks/useDialog";

afterEach(cleanup);

function Modal({ name, onClose, children }: { name: string; onClose: () => void; children?: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useDialog({ open: true, onClose, ref });
	return <div ref={ref} role="dialog" aria-modal="true" aria-label={name}><button>{name} first</button>{children}<button>{name} last</button></div>;
}

function Scene() {
	const [parent, setParent] = useState(false);
	const [child, setChild] = useState(false);
	return <><button onClick={() => setParent(true)}>open parent</button><button>background</button>{parent && <Modal name="parent" onClose={() => setParent(false)}><button onClick={() => setChild(true)}>open child</button>{child && createPortal(<Modal name="child" onClose={() => setChild(false)} />, document.body)}</Modal>}</>;
}

describe("modal focus and Escape stack", () => {
	it("traps focus in the top portal, closes one layer, and restores each opener", () => {
		render(<Scene />);
		const opener = screen.getByRole("button", { name: "open parent" });
		opener.focus();
		fireEvent.click(opener);
		const childOpener = screen.getByRole("button", { name: "open child" });
		childOpener.focus();
		fireEvent.click(childOpener);
		const child = screen.getByRole("dialog", { name: "child" });
		screen.getByRole("button", { name: "background" }).focus();
		expect(child.contains(document.activeElement)).toBe(true);
		screen.getByRole("button", { name: "child last" }).focus();
		fireEvent.keyDown(document.activeElement!, { key: "Tab" });
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "child first" }));
		fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "child last" }));
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(screen.queryByRole("dialog", { name: "child" })).toBeNull();
		expect(screen.getByRole("dialog", { name: "parent" })).toBeTruthy();
		expect(document.activeElement).toBe(childOpener);
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it("keeps a nested dialog on top when both mount in the same render", () => {
		const parentClose = vi.fn();
		const childClose = vi.fn();
		render(<Modal name="parent" onClose={parentClose}><Modal name="child" onClose={childClose} /></Modal>);
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(childClose).toHaveBeenCalledOnce();
		expect(parentClose).not.toHaveBeenCalled();
	});

	it("does not dismiss a dialog for IME or an already handled Escape", () => {
		const onClose = vi.fn();
		render(<Modal name="parent" onClose={onClose}><input aria-label="name" onKeyDown={(event) => { if (event.key === "Escape" && event.shiftKey) event.preventDefault(); }} /></Modal>);
		const input = screen.getByRole("textbox");
		input.focus();
		fireEvent.keyDown(input, { key: "Escape", isComposing: true });
		fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
		fireEvent.keyDown(input, { key: "Escape", shiftKey: true });
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
	});
});
