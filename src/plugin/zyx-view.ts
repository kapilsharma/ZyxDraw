import { Notice, Scope, TFile, TextFileView, WorkspaceLeaf, debounce, type Modifier, type ViewStateResult } from "obsidian";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, toggleComment, undo } from "@codemirror/commands";
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import {
  Diagnostics,
  editableShape,
  pointSourceRange,
  importCandidates,
  layers,
  parse,
  toggleHidden,
  shapeDefinition,
  type CompileResult,
  type DefinitionLink,
  type EditResult,
  type SourceRange,
  type TextMeasurer,
} from "../core";
import { definitionAtCursor, definitionLinks } from "./navigate";
import { DrawingEditor } from "./drawing";
import { layerToggles, layerTracking, setLayers } from "./layers";
import { LOGO_ICON } from "./logo";
import { PropertyPanel } from "./properties";
import { DEFAULT_SETTINGS } from "./settings";
import { createSplitter } from "./splitter";
import { compileInVault } from "./host";
import { zyxLanguageSupport } from "./language";
import { createCanvasMeasurer } from "./measure";
import type ZyxDrawPlugin from "./main";
import type { ViewMode } from "./settings";
import { renderDiagnostics } from "./svg";

export const VIEW_TYPE_ZYX = "zyxdraw-view";

/**
 * Cursor and selection colors from the Obsidian theme. Set as a CodeMirror theme because
 * CodeMirror's own defaults (black cursor) are injected after plugin CSS and would win.
 */
const caret = "var(--caret-color, var(--text-normal))";
const obsidianTheme = EditorView.theme({
  ".cm-content": { caretColor: caret },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: caret, borderLeftWidth: "2px" },
  // Same selectors as CodeMirror's base theme, so these win on specificity too.
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "var(--text-selection, rgba(127, 127, 255, 0.3))",
    },
});

/** Left to right in the view header. */
const MODES: ViewMode[] = ["source", "split", "drawing"];
const MODE_ICON: Record<ViewMode, string> = { split: "columns-2", drawing: "shapes", source: "file-code" };
const MODE_LABEL: Record<ViewMode, string> = { split: "Text and drawing", drawing: "Drawing only", source: "Text only" };

/**
 * View for .zyxd files: our own CodeMirror 6 editor and the live drawing.
 * Text is the only source of truth. The drawing is recompiled from it after every change, and
 * drawing edits come back as text edits (one undo step each).
 */
export class ZyxView extends TextFileView {
  private editor: EditorView | null = null;
  private drawing: DrawingEditor | null = null;
  private problemsEl: HTMLElement | null = null;
  private properties: PropertyPanel | null = null;
  private propertiesButton: HTMLElement | null = null;
  private propertiesSplitter: HTMLElement | null = null;
  /** Line wrapping, switchable without rebuilding the editor state (keeps undo history). */
  private readonly wrap = new Compartment();
  /** Eye icons next to the line numbers (setting "Show layer toggles in the text editor"). */
  private readonly eyes = new Compartment();
  /** A definition to show once the file's text is loaded (opened by go to definition). */
  private pendingReveal: { name: string | undefined; hops: number } | null = null;
  private propertiesVisible: boolean;
  private readonly modeButtons = new Map<ViewMode, HTMLElement>();
  private mode: ViewMode;
  private text = "";
  /** True while we push text into the editor ourselves, so it is not saved back as a user edit. */
  private applyingFileText = false;
  private measurer: TextMeasurer | null = null;
  private pending: { source: string; promise: Promise<CompileResult> } | null = null;
  private resolved: { source: string; result: CompileResult } | null = null;
  private renderVersion = 0;

  private readonly renderSoon = debounce(() => void this.renderPreview(), 150, true);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ZyxDrawPlugin,
  ) {
    super(leaf);
    this.mode = plugin.settings.defaultMode;
    this.propertiesVisible = plugin.settings.showProperties;
  }

  getViewType(): string {
    return VIEW_TYPE_ZYX;
  }

  override getDisplayText(): string {
    return this.file?.basename ?? "ZyxDraw";
  }

  override getIcon(): string {
    return LOGO_ICON;
  }

  override async onOpen(): Promise<void> {
    this.measurer = createCanvasMeasurer();
    this.contentEl.empty();
    this.contentEl.addClass("zyxdraw-view");
    const sourceEl = this.contentEl.createDiv({ cls: "zyxdraw-source" });
    const previewEl = this.contentEl.createDiv({ cls: "zyxdraw-preview" });
    this.drawing = new DrawingEditor(previewEl, {
      current: () => this.current(),
      apply: (edit, source) => this.applyEdit(edit, source),
      undo: () => this.editor && undo(this.editor),
      redo: () => this.editor && redo(this.editor),
      revealInSource: (path) => this.revealInSource(path),
      defaultUnit: () => this.plugin.settings.defaultUnit,
      selectionChanged: (path) => {
        this.properties?.show(path);
        if (path) this.followSelection(path);
      },
      guideOn: (guide) => this.plugin.guideOn(guide),
      toggleGuide: (guide) => this.plugin.setGuide(guide, !this.plugin.guideOn(guide)),
      showCoordinates: (text) => this.plugin.showCoordinates(text),
      pointSelected: (path, index) => this.followPoint(path, index),
    });
    this.properties = new PropertyPanel(previewEl, {
      current: () => this.current(),
      apply: (edit, source) => this.applyEdit(edit, source),
      revealInSource: (path) => this.revealInSource(path),
      select: (path) => this.drawing?.select(path),
    });
    this.problemsEl = previewEl.createDiv({ cls: "zyxdraw-problems" });
    this.addDrawingHotkeys();
    this.addSplitters(sourceEl, previewEl);
    this.editor = new EditorView({ parent: sourceEl, state: this.createState(this.text) });
    this.addModeButtons();
    this.setMode(this.mode);
    this.setPropertiesVisible(this.propertiesVisible);
    this.setWrap(this.plugin.settings.wrapText);
    void this.renderPreview();
  }

  override async onClose(): Promise<void> {
    this.editor?.destroy();
    this.editor = null;
    this.plugin.showCoordinates(null);
    this.drawing = null;
    this.properties = null;
    this.problemsEl = null;
  }

  // ---- text wrapping ----------------------------------------------------------------------

  /** Turns wrapping of long lines on or off (command "Toggle text wrapping"). */
  setWrap(wrap: boolean): void {
    this.contentEl.toggleClass("is-wrapping", wrap);
    this.editor?.dispatch({ effects: this.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }

  /** Turns the eye icons in the text editor on or off. */
  setLayerToggles(on: boolean): void {
    this.editor?.dispatch({ effects: this.eyes.reconfigure(this.eyeExtension(on)) });
  }

  private eyeExtension(on: boolean) {
    return on ? layerToggles((path) => this.toggleLayer(path)) : [];
  }

  /** An eye was clicked: hide or show the shape, as one text edit. */
  private toggleLayer(path: string): void {
    const cur = this.current();
    if (!cur) return; // a newer text is still compiling: the eyes will be redrawn for it
    const { tree, scene, diagnostics } = cur.result;
    this.applyEdit(toggleHidden({ source: cur.source, scene, tree, diagnostics }, path), cur.source);
  }

  /** The grid or mouse coordinates setting changed. */
  refreshGuides(): void {
    this.drawing?.refreshGuides();
  }

  /**
   * Drawing shortcuts that Obsidian may also use (`Ctrl/Cmd+G` opens the graph view): while the
   * drawing has the keyboard, the view's scope takes them first. Elsewhere they pass through.
   */
  private addDrawingHotkeys(): void {
    this.scope = new Scope(this.app.scope);
    const keys: [Modifier[], string][] = [
      [["Mod"], "g"],
      [["Mod", "Shift"], "g"],
      [["Mod"], "d"],
      [["Mod"], "a"],
    ];
    // Ctrl/Cmd+/ comments lines in the text editor, before Obsidian sees the key.
    this.scope.register(["Mod"], "/", () => {
      if (!this.editor?.hasFocus) return true;
      toggleComment(this.editor);
      return false;
    });
    for (const [mods, key] of keys) {
      this.scope.register(mods, key, (evt) => {
        if (!this.drawing?.hasFocus()) return true;
        // The drawing's own key handler may already have done it.
        if (!evt.defaultPrevented) this.drawing.shortcut(key, evt.shiftKey);
        return false;
      });
    }
  }

  // ---- resizable panes --------------------------------------------------------------------

  /** Drag handles: text | drawing (side by side), and drawing / properties (stacked). */
  private addSplitters(sourceEl: HTMLElement, previewEl: HTMLElement): void {
    const s = this.plugin.settings;
    const clamp = (f: number, min: number, max: number) => Math.min(max, Math.max(min, f));
    const save = () => void this.plugin.saveSettings();

    const applySource = () => {
      sourceEl.style.flex = `0 0 ${s.sourceWidth * 100}%`;
    };
    createSplitter(this.contentEl, previewEl, {
      axis: "x",
      label: "Drag to resize text and drawing",
      container: () => this.contentEl,
      onMove: (f) => {
        s.sourceWidth = clamp(f, 0.15, 0.85);
        applySource();
      },
      onEnd: save,
      onReset: () => {
        s.sourceWidth = DEFAULT_SETTINGS.sourceWidth;
        applySource();
      },
    });
    applySource();

    const props = this.properties!.el;
    const applyProps = () => {
      props.style.height = `${s.propertiesHeight * 100}%`;
    };
    this.propertiesSplitter = createSplitter(previewEl, props, {
      axis: "y",
      label: "Drag to resize drawing and attributes",
      container: () => previewEl,
      onMove: (f) => {
        s.propertiesHeight = clamp(f, 0.1, 0.85);
        applyProps();
      },
      onEnd: save,
      onReset: () => {
        s.propertiesHeight = DEFAULT_SETTINGS.propertiesHeight;
        applyProps();
      },
    });
    applyProps();
  }

  // ---- attributes panel -------------------------------------------------------------------

  setPropertiesVisible(visible: boolean): void {
    this.propertiesVisible = visible;
    this.properties?.setVisible(visible);
    this.propertiesSplitter?.toggleClass("is-hidden", !visible);
    this.propertiesButton?.toggleClass("is-active", visible);
    this.propertiesButton?.setAttribute("aria-pressed", String(visible));
    if (this.plugin.settings.showProperties !== visible) {
      this.plugin.settings.showProperties = visible;
      void this.plugin.saveSettings();
    }
    this.app.workspace.requestSaveLayout();
  }

  // ---- modes ------------------------------------------------------------------------------

  /** One button per mode in the view header, grouped together; the current one is highlighted. */
  private addModeButtons(): void {
    for (const m of MODES) {
      const button = this.addAction(MODE_ICON[m], MODE_LABEL[m], () => this.setMode(m));
      button.addClass("zyxdraw-mode-button");
      this.modeButtons.set(m, button);
    }
    // Wrap them in one group, in MODES order, wherever Obsidian placed them.
    const buttons = MODES.map((m) => this.modeButtons.get(m)!);
    const parent = buttons[0].parentElement;
    if (!parent) return;
    const first = buttons.reduce((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? b : a));
    const group = createDiv({ cls: "zyxdraw-mode-group", attr: { role: "group", "aria-label": "View" } });
    parent.insertBefore(group, first);
    for (const b of buttons) group.appendChild(b);

    // Attributes panel toggle, just left of the group.
    const props = this.addAction("sliders-horizontal", "Attributes", () => {
      const show = !this.propertiesVisible;
      // The panel sits under the drawing: in "text only" mode, bring the drawing alongside.
      if (show && this.mode === "source") this.setMode("split");
      this.setPropertiesVisible(show);
    });
    props.addClass("zyxdraw-properties-button");
    group.parentElement?.insertBefore(props, group);
    this.propertiesButton = props;
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    for (const m of MODES) {
      this.contentEl.toggleClass(`mode-${m}`, m === mode);
      const button = this.modeButtons.get(m);
      button?.toggleClass("is-active", m === mode);
      button?.setAttribute("aria-pressed", String(m === mode));
    }
    this.app.workspace.requestSaveLayout();
  }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), mode: this.mode, properties: this.propertiesVisible };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as { mode?: unknown; properties?: unknown } | null;
    const mode = s?.mode;
    if (typeof mode === "string" && (MODES as string[]).includes(mode)) this.setMode(mode as ViewMode);
    if (typeof s?.properties === "boolean" && s.properties !== this.propertiesVisible) this.setPropertiesVisible(s.properties);
    await super.setState(state, result);
  }

  // ---- file data --------------------------------------------------------------------------

  getViewData(): string {
    return this.text;
  }

  setViewData(data: string, clear: boolean): void {
    this.text = data;
    if (this.editor) {
      if (clear) {
        // A different file was loaded: fresh state, so undo history does not leak between files.
        this.editor.setState(this.createState(data));
      } else if (this.editor.state.doc.toString() !== data) {
        // The file changed outside this view (another pane, sync): replace the text.
        this.applyingFileText = true;
        this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: data } });
        this.applyingFileText = false;
      }
      if (this.pendingReveal) {
        const { name, hops } = this.pendingReveal;
        this.pendingReveal = null;
        if (data !== "") this.revealName(name, hops);
      }
    }
    void this.renderPreview();
  }

  clear(): void {
    this.text = "";
    this.pending = null;
    this.resolved = null;
    this.editor?.setState(this.createState(""));
    this.problemsEl?.empty();
  }

  /** Re-compiles, e.g. after an imported library changed. */
  refresh(): void {
    this.pending = null;
    this.resolved = null;
    void this.renderPreview();
  }

  // ---- compile ----------------------------------------------------------------------------

  /** Compiles once per text version; shared by the drawing and the error underlines. */
  private compile(source: string): Promise<CompileResult> {
    if (this.pending?.source !== source) {
      const promise = compileInVault(this.app, source, this.file?.path ?? "", {
        measurer: this.measurer ?? undefined,
        metadata: true,
      }).then((result) => {
        if (this.pending?.promise === promise) this.resolved = { source, result };
        return result;
      });
      this.pending = { source, promise };
    }
    return this.pending.promise;
  }

  /** The result for exactly the text in the editor, or null if a newer compile is pending. */
  current(): { source: string; result: CompileResult } | null {
    const doc = this.editor?.state.doc.toString() ?? this.text;
    return this.resolved && this.resolved.source === doc ? this.resolved : null;
  }

  private async renderPreview(): Promise<void> {
    const version = ++this.renderVersion;
    const source = this.text;
    let result: CompileResult;
    try {
      result = await this.compile(source);
    } catch (err) {
      console.error("ZyxDraw compile failed", err);
      return;
    }
    if (version !== this.renderVersion || !this.drawing || !this.problemsEl) return;
    this.drawing.show(result.svg, result.scene.frame.infinite ?? false);
    if (this.editor && this.editor.state.doc.toString() === source) this.editor.dispatch({ effects: setLayers.of(layers(result.scene)) });
    this.properties?.refresh();
    renderDiagnostics(this.problemsEl, source, result.diagnostics, (offset) => this.revealOffset(offset));
  }

  // ---- editor -----------------------------------------------------------------------------

  private createState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        // Draw our own cursor and selection (Obsidian hides the native caret in CodeMirror).
        drawSelection(),
        obsidianTheme,
        history(),
        // `Mod-/` is handled in the view scope only (see addDrawingHotkeys), so it never runs twice.
        keymap.of([...defaultKeymap.filter((k) => k.key !== "Mod-/"), ...historyKeymap, indentWithTab]),
        this.wrap.of(this.plugin.settings.wrapText ? EditorView.lineWrapping : []),
        layerTracking(),
        this.eyes.of(this.eyeExtension(this.plugin.settings.showLayerToggles)),
        ...zyxLanguageSupport(),
        definitionLinks((link) => void this.goToDefinition(link)),
        lintGutter(),
        linter((view) => this.lint(view), { delay: 300 }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || this.applyingFileText) return;
          this.text = update.state.doc.toString();
          this.requestSave();
          // Edits from the drawing re-render at once; typing is debounced.
          if (update.transactions.some((tr) => tr.isUserEvent("zyxdraw.canvas"))) void this.renderPreview();
          else this.renderSoon();
        }),
      ],
    });
  }

  private async lint(view: EditorView): Promise<CmDiagnostic[]> {
    const source = view.state.doc.toString();
    const result = await this.compile(source);
    const length = view.state.doc.length;
    return result.diagnostics.map((d) => {
      const from = Math.min(d.range.start, length);
      let to = Math.min(d.range.end, length);
      if (to <= from && from < length) to = from + 1;
      return { from, to, severity: d.severity, message: `${d.message} (${d.code})`, source: "ZyxDraw" };
    });
  }

  /** Applies a drawing edit as one transaction (one undo step). Dropped if the text moved on. */
  private applyEdit(edit: EditResult, source: string): void {
    for (const n of edit.notices) new Notice(`ZyxDraw: ${n}`);
    if (!this.editor || edit.edits.length === 0) return;
    if (this.editor.state.doc.toString() !== source) return;
    this.editor.dispatch({
      changes: edit.edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
      annotations: Transaction.userEvent.of("zyxdraw.canvas"),
    });
  }

  private revealInSource(path: string): void {
    const cur = this.current();
    const shape = cur && editableShape(cur.result.scene, path);
    if (!shape) return;
    if (this.mode === "drawing") this.setMode("split");
    const r = shape.source.range;
    this.editor?.dispatch({ selection: { anchor: r.start, head: r.end }, scrollIntoView: true });
    this.editor?.focus();
  }

  // ---- go to definition -------------------------------------------------------------------

  /** Command "Go to definition": the name at the text cursor. */
  goToDefinitionAtCursor(): void {
    const link = this.editor && definitionAtCursor(this.editor);
    if (link) void this.goToDefinition(link);
    else new Notice("ZyxDraw: put the cursor on a shape, style, clip or import name");
  }

  /** Follows a link: in this file, or opens the imported file (new tab, or the tab already showing it). */
  async goToDefinition(link: DefinitionLink, hops = 0): Promise<void> {
    const t = link.target;
    if (hops > 10) {
      new Notice("ZyxDraw: the definition is imported in a circle");
      return;
    }
    if (t.file === null) {
      this.revealRange(t.range);
      return;
    }
    const candidates = importCandidates(this.file?.path ?? "", t.file);
    const file = candidates.map((p) => this.app.vault.getAbstractFileByPath(p)).find((f): f is TFile => f instanceof TFile);
    if (!file) {
      new Notice(`ZyxDraw: cannot find \`${t.file}\``);
      return;
    }
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_ZYX).find((l) => l.view instanceof ZyxView && l.view.file === file);
    if (leaf) {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true });
    }
    if (leaf.view instanceof ZyxView) leaf.view.revealName(t.name, hops + 1);
  }

  /** Shows the definition of a custom shape in this file (or follows it further if imported here). */
  revealName(name: string | undefined, hops = 0): void {
    if (!this.editor || (this.editor.state.doc.length === 0 && this.text === "")) {
      this.pendingReveal = { name, hops }; // file not loaded yet
      return;
    }
    if (name === undefined) {
      this.revealRange({ start: 0, end: 0 });
      return;
    }
    const target = shapeDefinition(parse(this.editor.state.doc.toString(), new Diagnostics()).statements, name);
    if (!target) new Notice(`ZyxDraw: \`${name}\` is not defined in ${this.file?.path ?? "this file"}`);
    else void this.goToDefinition({ range: { start: 0, end: 0 }, target }, hops);
  }

  /** Selects a range in the text, scrolled to the middle, with the text pane visible and focused. */
  private revealRange(range: SourceRange): void {
    if (this.mode === "drawing") this.setMode("split");
    if (!this.editor) return;
    const len = this.editor.state.doc.length;
    this.editor.dispatch({
      selection: { anchor: Math.min(range.start, len), head: Math.min(range.end, len) },
      effects: EditorView.scrollIntoView(Math.min(range.start, len), { y: "center" }),
    });
    this.editor.focus();
  }

  /**
   * Side by side: a shape selected in the drawing moves the text cursor to its statement and
   * scrolls it into view. Focus stays in the drawing (keyboard nudging and Delete keep working);
   * the active line highlight shows where the cursor is.
   */
  private followSelection(path: string): void {
    if (this.mode !== "split" || !this.editor) return;
    const cur = this.current();
    const shape = cur && editableShape(cur.result.scene, path);
    if (!shape) return;
    const stmt = shape.source;
    const at = Math.min(stmt.nameRange?.start ?? stmt.keywordRange.start, this.editor.state.doc.length);
    this.editor.dispatch({
      selection: { anchor: at },
      effects: EditorView.scrollIntoView(at, { y: "center" }),
    });
  }

  /**
   * Side by side: a point clicked in the drawing selects its numbers in the text (`34,95`).
   * Focus stays in the drawing, like `followSelection`.
   */
  private followPoint(path: string, index: number): void {
    if (this.mode !== "split" || !this.editor) return;
    const cur = this.current();
    const range = cur && pointSourceRange({ source: cur.source, scene: cur.result.scene }, path, index);
    if (!range) return;
    const len = this.editor.state.doc.length;
    this.editor.dispatch({
      selection: { anchor: Math.min(range.start, len), head: Math.min(range.end, len) },
      effects: EditorView.scrollIntoView(Math.min(range.start, len), { y: "center", x: "center" }),
    });
  }

  private revealOffset(offset: number): void {
    if (this.mode === "drawing") this.setMode("split");
    this.editor?.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
    this.editor?.focus();
  }
}
