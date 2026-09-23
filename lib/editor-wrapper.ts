/**
 * Extensions that draw into the editor's border rows (the phase spinner, voice)
 * wrap whatever editor is installed, possibly another wrapper, and change only
 * what it renders. Everything else is forwarded, so wrappers chain in any order.
 */
import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, EditorComponent, EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

export type StatusIndicator = NonNullable<Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]>;
type EditorFactory = ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
type EditorHost = { ui: Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent"> };

export interface EditorDecoration {
	/** Redraws some of the base editor's rows; never called with an empty render. */
	render(lines: string[], width: number, editor: WrappedEditor): string[];
	/** Pi's working status changed; undefined clears it. */
	onWorkingStatus?(indicator: StatusIndicator | undefined): void;
}

export class WrappedEditor extends CustomEditor {
	readonly base: EditorComponent;
	wantsKeyRelease?: boolean;
	private readonly decoration: EditorDecoration;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, base: EditorComponent, decoration: EditorDecoration) {
		// Pi then leaves its working status to the editor, so a wrapper can draw it.
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.base = base;
		this.decoration = decoration;
		this.wantsKeyRelease = base.wantsKeyRelease;
		if (base instanceof CustomEditor) this.actionHandlers = base.actionHandlers;
	}

	render(width: number): string[] {
		this.syncBase();
		const lines = this.base.render(width);
		return lines.length === 0 ? lines : this.decoration.render(lines, width, this);
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		super.setWorkingStatusIndicator(indicator);
		const forward = this.base as EditorComponent & { setWorkingStatusIndicator?: (indicator: StatusIndicator | undefined) => void };
		forward.setWorkingStatusIndicator?.(indicator);
		this.decoration.onWorkingStatus?.(indicator);
	}

	/** Pi sets callbacks and focus on the outermost editor; the base must see them too. */
	private syncBase(): void {
		this.base.onSubmit = this.onSubmit;
		this.base.onChange = this.onChange;
		if (this.base.borderColor !== undefined) this.base.borderColor = this.borderColor;
		const focusable = this.base as EditorComponent & { focused?: boolean };
		if ("focused" in focusable) focusable.focused = this.focused;
		if (!(this.base instanceof CustomEditor)) return;
		this.base.actionHandlers = this.actionHandlers;
		this.base.onEscape = this.onEscape;
		this.base.onCtrlD = this.onCtrlD;
		this.base.onPasteImage = this.onPasteImage;
		this.base.onExtensionShortcut = this.onExtensionShortcut;
	}

	invalidate(): void {
		super.invalidate();
		this.base.invalidate();
	}

	handleInput(data: string): void {
		this.syncBase();
		this.base.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		this.syncBase();
		return this.base.handleMouse?.(event);
	}

	getText(): string {
		return this.base.getText();
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setText(text: string): void {
		this.syncBase();
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		super.setPaddingX(padding);
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		super.setAutocompleteMaxVisible(maxVisible);
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}
}

/** One extension's place in the editor chain: installed per session, removed on shutdown. */
export class EditorSlot {
	private previous: EditorFactory;
	private installed: EditorFactory;

	install(ctx: EditorHost, decorate: (tui: TUI) => EditorDecoration): void {
		const current = ctx.ui.getEditorComponent();
		// A new session in the same process finds our own wrapper; wrap what it wrapped.
		if (current !== this.installed) this.previous = current;
		const baseFactory = this.previous;
		this.installed = (tui, theme, keybindings) => {
			const base = baseFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return new WrappedEditor(tui, theme, keybindings, base, decorate(tui));
		};
		ctx.ui.setEditorComponent(this.installed);
	}

	/** Puts back the editor we wrapped, unless another extension has wrapped ours since. */
	restore(ctx: EditorHost): void {
		if (this.installed && ctx.ui.getEditorComponent?.() === this.installed) ctx.ui.setEditorComponent(this.previous);
		this.installed = undefined;
		this.previous = undefined;
	}
}
