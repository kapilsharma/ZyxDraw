import { Notice, Scope, TFile, TextFileView, WorkspaceLeaf, debounce, type Modifier, type ViewStateResult } from "obsidian";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, toggleComment, undo } from "@codemirror/commands";
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import {
  Diagnostics,
  applyEdits,
  brokenReferences,
  deleteShape,
  moveShapeTo,
  findShape,
  layerOf,
  newLayer,
  editableShape,
  pointSourceRange,
  importCandidates,
  layers,
  parse,
  toggleHidden,
  nameDefinition,
  type CompileResult,
  type DefinitionLink,
  type EditResult,
  type Scene,
  type SourceRange,
  type TextMeasurer,
} from "../core";
import { definitionAtCursor, definitionLinks } from "./navigate";
import { DrawingEditor } from "./drawing";
import { layerToggles, layerTracking, setLayers } from "./layers";
import { LOGO_ICON } from "./logo";
import { AttributesForm } from "./attributes";
import { LayersView } from "./layer-panel";
import { ConfirmModal } from "./confirm";
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
  private attributes: AttributesForm | null = null;
  /** Under the drawing area. Today it shows the Attributes. */
  private bottomPanel: HTMLElement | null = null;
  private attributesButton: HTMLElement | null = null;
  private bottomSplitter: HTMLElement | null = null;
  /** Right of the drawing area. Today it shows the Layers (issue #11). */
  private rightPanel: HTMLElement | null = null;
  private rightSplitter: HTMLElement | null = null;
  private layersView: LayersView | null = null;
  private layersButton: HTMLElement | null = null;
  private layersVisible: boolean;
  /** New shapes go into this layer. Follows the selection; kept for this open drawing only. */
  private activeLayer: string | null = null;
  /** Line wrapping, switchable without rebuilding the editor state (keeps undo history). */
  private readonly wrap = new Compartment();
  /** Eye icons next to the line numbers (setting "Show layer toggles in the text editor"). */
  private readonly eyes = new Compartment();
  /** A definition to show once the file's text is loaded (opened by go to definition). */
  private pendingReveal: { name: string | undefined; hops: number } | null = null;
  private bottomPanelVisible: boolean;
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
    this.bottomPanelVisible = plugin.settings.showProperties;
    this.layersVisible = plugin.settings.showLayers;
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
    // Panels (issue #8): left panel (text), then a column with the drawing area and the bottom
    // panel (Attributes) under it, then the right panel (Layers, issue #11).
    const leftPanel = this.contentEl.createDiv({ cls: "zyxdraw-left-panel" });
    const center = this.contentEl.createDiv({ cls: "zyxdraw-center" });
    this.drawing = new DrawingEditor(center, {
      current: () => this.current(),
      apply: (edit, source) => this.applyEdit(edit, source),
      undo: () => this.editor && undo(this.editor),
      redo: () => this.editor && redo(this.editor),
      revealInSource: (path) => this.revealInSource(path),
      defaultUnit: () => this.plugin.settings.defaultUnit,
      selectionChanged: (path) => {
        this.attributes?.show(path);
        this.followLayer(path);
        if (path) this.followSelection(path);
      },
      guideOn: (guide) => this.plugin.guideOn(guide),
      toggleGuide: (guide) => this.plugin.setGuide(guide, !this.plugin.guideOn(guide)),
      showCoordinates: (text) => this.plugin.showCoordinates(text),
      pointSelected: (path, index) => this.followPoint(path, index),
      activeLayer: () => this.activeLayer,
    });
    this.bottomPanel = center.createDiv({ cls: "zyxdraw-bottom-panel" });
    this.attributes = new AttributesForm(this.bottomPanel, {
      current: () => this.current(),
      apply: (edit, source) => this.applyEdit(edit, source),
      revealInSource: (path) => this.revealInSource(path),
      select: (path) => this.drawing?.select(path),
    });
    this.problemsEl = center.createDiv({ cls: "zyxdraw-problems" });
    this.rightPanel = this.contentEl.createDiv({ cls: "zyxdraw-right-panel" });
    this.layersView = new LayersView(this.rightPanel, {
      current: () => this.current(),
      activeLayer: () => this.activeLayer,
      select: (path) => {
        this.followLayer(path);
        this.drawing?.select(path);
        this.layersView?.showSelection(path);
      },
      toggleHidden: (path) => this.toggleLayer(path),
      revealInSource: (path) => this.revealInSource(path),
      newLayer: () => this.editNow((t) => newLayer(t), (edit) => (this.activeLayer = edit.select ?? null)),
      delete: (path) => this.editChecked((t) => deleteShape(t, path), "Delete", "Delete anyway"),
      move: (path, place) => this.editChecked((t) => moveShapeTo(t, path, place), "Move", "Move anyway"),
    });
    this.addDrawingHotkeys();
    this.addSplitters(leftPanel, center);
    this.editor = new EditorView({ parent: leftPanel, state: this.createState(this.text) });
    this.addModeButtons();
    this.setMode(this.mode);
    this.setBottomPanelVisible(this.bottomPanelVisible);
    this.setLayersVisible(this.layersVisible);
    this.setWrap(this.plugin.settings.wrapText);
    void this.renderPreview();
  }

  override async onClose(): Promise<void> {
    this.editor?.destroy();
    this.editor = null;
    this.plugin.showCoordinates(null);
    this.drawing = null;
    this.attributes = null;
    this.bottomPanel = null;
    this.layersView = null;
    this.rightPanel = null;
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

  /** Drag handles: left panel | drawing area (side by side), and drawing area / bottom panel (stacked). */
  private addSplitters(leftPanel: HTMLElement, center: HTMLElement): void {
    const s = this.plugin.settings;
    const clamp = (f: number, min: number, max: number) => Math.min(max, Math.max(min, f));
    const save = () => void this.plugin.saveSettings();

    const applySource = () => {
      leftPanel.setCssProps({ "--zyxdraw-left-panel-width": `${s.sourceWidth * 100}%` });
    };
    createSplitter(this.contentEl, center, {
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

    const bottom = this.bottomPanel!;
    const applyProps = () => {
      bottom.setCssProps({ "--zyxdraw-bottom-panel-height": `${s.propertiesHeight * 100}%` });
    };
    this.bottomSplitter = createSplitter(center, bottom, {
      axis: "y",
      label: "Drag to resize drawing and attributes",
      container: () => center,
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

    const right = this.rightPanel!;
    const applyRight = () => {
      right.setCssProps({ "--zyxdraw-right-panel-width": `${s.rightPanelWidth * 100}%` });
    };
    this.rightSplitter = createSplitter(this.contentEl, right, {
      axis: "x",
      label: "Drag to resize the layers",
      container: () => this.contentEl,
      onMove: (f) => {
        s.rightPanelWidth = clamp(1 - f, 0.1, 0.5);
        applyRight();
      },
      onEnd: save,
      onReset: () => {
        s.rightPanelWidth = DEFAULT_SETTINGS.rightPanelWidth;
        applyRight();
      },
    });
    this.rightSplitter.addClass("is-right");
    applyRight();
  }

  // ---- bottom panel (Attributes) ----------------------------------------------------------

  setBottomPanelVisible(visible: boolean): void {
    this.bottomPanelVisible = visible;
    this.bottomPanel?.toggleClass("is-hidden", !visible);
    this.attributes?.setShown(visible);
    this.bottomSplitter?.toggleClass("is-hidden", !visible);
    this.attributesButton?.toggleClass("is-active", visible);
    this.attributesButton?.setAttribute("aria-pressed", String(visible));
    if (this.plugin.settings.showProperties !== visible) {
      this.plugin.settings.showProperties = visible;
      void this.plugin.saveSettings();
    }
    this.app.workspace.requestSaveLayout();
  }

  // ---- right panel (Layers) ---------------------------------------------------------------

  setLayersVisible(visible: boolean): void {
    this.layersVisible = visible;
    this.rightPanel?.toggleClass("is-hidden", !visible);
    this.rightSplitter?.toggleClass("is-hidden", !visible);
    this.layersView?.setShown(visible);
    this.layersButton?.toggleClass("is-active", visible);
    this.layersButton?.setAttribute("aria-pressed", String(visible));
    if (this.plugin.settings.showLayers !== visible) {
      this.plugin.settings.showLayers = visible;
      void this.plugin.saveSettings();
    }
    this.app.workspace.requestSaveLayout();
  }

  /** The active layer follows the selection: the layer of the selected shape (or none outside layers). */
  private followLayer(path: string | null): void {
    if (path) {
      const scene = this.current()?.result.scene;
      const shape = scene ? findShape(scene, path) : undefined;
      if (shape) this.activeLayer = layerOf(shape)?.path ?? null;
    }
    this.layersView?.showSelection(path);
  }

  /** Runs an edit against the current text (from the layers view) and applies it. */
  private editNow(op: (t: { source: string; scene: Scene }) => EditResult, after?: (edit: EditResult) => void): void {
    const cur = this.current();
    if (!cur) return;
    const edit = op({ source: cur.source, scene: cur.result.scene });
    for (const n of edit.notices) new Notice(`ZyxDraw: ${n}`);
    if (edit.edits.length === 0) return;
    after?.(edit);
    this.applyEdit(edit, cur.source);
  }

  /**
   * Runs a move or delete from the layers view. When it would break references (another shape
   * refers to the old path), asks first: the user can go ahead anyway or cancel.
   */
  private editChecked(op: (t: { source: string; scene: Scene }) => EditResult, what: string, anyway: string): void {
    const cur = this.current();
    if (!cur) return;
    const edit = op({ source: cur.source, scene: cur.result.scene });
    const broken = edit.edits.length > 0 ? brokenReferences(cur.source, applyEdits(cur.source, edit.edits)) : [];
    const go = () => {
      this.applyEdit(edit, cur.source);
      if (edit.select) this.drawing?.select(edit.select);
    };
    if (broken.length === 0) {
      for (const n of edit.notices) new Notice(`ZyxDraw: ${n}`);
      if (edit.edits.length > 0) go();
      return;
    }
    const message = `${what} breaks ${broken.length === 1 ? "a reference" : `${broken.length} references`}: other shapes refer to it by its current path. They will show an error until you fix them.`;
    new ConfirmModal(this.app, `${what}?`, message, broken, anyway, go).open();
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

    // Attributes button (shows or hides the bottom panel), just left of the group.
    const props = this.addAction("sliders-horizontal", "Attributes", () => {
      const show = !this.bottomPanelVisible;
      // The bottom panel sits under the drawing area: in "text only" mode, bring the drawing alongside.
      if (show && this.mode === "source") this.setMode("split");
      this.setBottomPanelVisible(show);
    });
    props.addClass("zyxdraw-attributes-button");
    group.parentElement?.insertBefore(props, group);
    this.attributesButton = props;

    // Layers button (shows or hides the right panel), left of the Attributes button.
    const layersButton = this.addAction("layers", "Layers", () => this.setLayersVisible(!this.layersVisible));
    layersButton.addClass("zyxdraw-layers-button");
    group.parentElement?.insertBefore(layersButton, props);
    this.layersButton = layersButton;
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
    return { ...super.getState(), mode: this.mode, properties: this.bottomPanelVisible, layers: this.layersVisible }; // "properties": key kept so saved layouts still load
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as { mode?: unknown; properties?: unknown; layers?: unknown } | null;
    const mode = s?.mode;
    if (typeof mode === "string" && (MODES as string[]).includes(mode)) this.setMode(mode as ViewMode);
    if (typeof s?.properties === "boolean" && s.properties !== this.bottomPanelVisible) this.setBottomPanelVisible(s.properties);
    if (typeof s?.layers === "boolean" && s.layers !== this.layersVisible) this.setLayersVisible(s.layers);
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
        // A library draws nothing: it opens as text only (the view button still switches).
        if (this.file?.extension === "zyxdl" && this.mode !== "source") this.setMode("source");
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
        libraryFolder: this.plugin.settings.libraryFolder,
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
    this.attributes?.refresh();
    // A deleted or renamed layer is no longer active.
    if (this.activeLayer && !findShape(result.scene, this.activeLayer)?.layer) this.activeLayer = null;
    this.layersView?.refresh();
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
    const candidates = importCandidates(this.file?.path ?? "", t.file, this.plugin.settings.libraryFolder);
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

  /** Shows the definition of a name in this file (or follows it further if imported here). */
  revealName(name: string | undefined, hops = 0): void {
    if (!this.editor || (this.editor.state.doc.length === 0 && this.text === "")) {
      this.pendingReveal = { name, hops }; // file not loaded yet
      return;
    }
    if (name === undefined) {
      this.revealRange({ start: 0, end: 0 });
      return;
    }
    const target = nameDefinition(parse(this.editor.state.doc.toString(), new Diagnostics()).statements, name);
    if (!target) new Notice(`ZyxDraw: \`${name}\` is not defined in ${this.file?.path ?? "this file"}`);
    else void this.goToDefinition({ range: { start: 0, end: 0 }, target }, hops);
  }

  /** Selects a range in the text, scrolled to the middle, with the left panel (text) visible and focused. */
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
