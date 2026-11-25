// Public API of the core. Pure TypeScript: no Obsidian, no DOM, no file access.
import { fitInfiniteFrame } from "./bounds";
import { Code, Diagnostics, type Diagnostic } from "./diagnostics";
import { arrangeGallery } from "./gallery";
import { approxMeasurer, layout, type Scene, type TextMeasurer } from "./layout/layout";
import { render } from "./render/render";
import { loadLibraries, type ReadFile } from "./resolve/library";
import { resolve } from "./resolve/resolve";
import type { SyntaxTree } from "./syntax/ast";
import { parse } from "./syntax/parser";

export interface CompileOptions {
  /** Real text measurement (plugin). Defaults to a deterministic approximation (tests). */
  measurer?: TextMeasurer;
  /** Add data-zyx-* attributes for the editor. */
  metadata?: boolean;
  /** Vault path of this file, for relative imports. */
  path?: string;
  /** Library sources by vault path. Load them first with `loadLibraries`. */
  libraries?: Map<string, string>;
  /** Vault path of the library folder from the settings, searched after the file's own folder. */
  libraryFolder?: string;
  /** A library's gallery (issue #24): the width to fit columns in, in pixels. */
  galleryWidth?: number;
  /** A library's custom shapes left out of its gallery (eye icons, issue #25). */
  galleryHidden?: readonly string[];
}

export interface CompileResult {
  tree: SyntaxTree;
  scene: Scene;
  svg: string;
  /** Sorted by position in the source. */
  diagnostics: Diagnostic[];
}

/**
 * Source text to SVG: parse -> resolve -> layout -> render.
 * Never throws on user input. Problems are in `diagnostics`, and everything that can still be
 * drawn is drawn.
 */
export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const diags = new Diagnostics();
  const tree = parse(source, diags);
  const model = resolve(tree, diags, {
    path: options.path,
    source,
    libraries: options.libraries,
    libraryFolder: options.libraryFolder,
    galleryHidden: options.galleryHidden,
  });
  const measurer = options.measurer ?? approxMeasurer;
  if (model.gallery) {
    // A library's cells are placed once their sizes are known (problems come from the second layout).
    arrangeGallery(model, layout(model, new Diagnostics(), measurer), options.galleryWidth);
  }
  const scene = layout(model, diags, measurer);
  fitInfiniteFrame(scene);
  const svg = render(scene, { metadata: options.metadata });
  const diagnostics = [...diags.list].sort((a, b) => a.range.start - b.range.start);
  return { tree, scene, svg, diagnostics };
}

/** Loads imported libraries through `read`, then compiles. Convenience for hosts. */
export async function compileWithImports(
  source: string,
  read: ReadFile,
  options: Omit<CompileOptions, "libraries"> = {},
): Promise<CompileResult> {
  const libraries = await loadLibraries(source, options.path ?? "", read, options.libraryFolder);
  return compile(source, { ...options, libraries });
}

export { Code, Diagnostics, type Diagnostic, type Severity } from "./diagnostics";
export { loadLibraries, importCandidates, isLibraryPath, type ReadFile } from "./resolve/library";
export type { Shape, Model, Frame, GradientDef, Gallery } from "./resolve/resolve";
export { isPreviewBlock } from "./resolve/resolve";
export { GALLERY_GAP, GALLERY_WIDTH, galleryLayers } from "./gallery";
export type { Box, Placed } from "./layout/layout";
export { GRADIENT, SHAPES, STOP, isShapeType, type ShapeType, type AttrSpec } from "./builtins/catalog";
export * from "./edit/edit";
export * from "./edit/properties";
export * from "./edit/arrange";
export * from "./edit/visibility";
export {
  canAddPoints,
  deletePoint,
  hasPoints,
  insertedPointsText,
  insertLine,
  insertPath,
  insertPoint,
  insertPolygon,
  localOrigin,
  movePoint,
  movedPointsText,
  overlayTransforms,
  pointHandles,
  pointSourceRange,
  previewGeometry,
  sideHandles,
  type NumberFormat,
  type PointDragOptions,
  type PointHandle,
} from "./edit/points";
export { penPathData, type PenNode, type Pt } from "./edit/path-nodes";
export { shapeTransform } from "./transform";
export { formatCoordinate, gridPath, gridSteps, snapDelta } from "./grid";
export { contentBounds, INFINITE_PADDING, type Bounds } from "./bounds";
export { definitionAt, nameDefinition, shapeDefinition, topLevel, type DefinitionLink, type DefinitionTarget } from "./navigate";
export { toJsonCanvas, type JsonCanvas } from "./export/json-canvas";
export type { FontSpec, TextMeasurer, Scene } from "./layout/layout";
export { approxMeasurer } from "./layout/layout";
export { parse } from "./syntax/parser";
export { libraryFile, libraryNameProblem } from "./syntax/library-name";
export { resolve } from "./resolve/resolve";
export { layout } from "./layout/layout";
export { render, esc as escapeXml } from "./render/render";
export type { SourceRange, SyntaxTree, Statement, Attr, Value, ImportName } from "./syntax/ast";

/**
 * References an edit would break: "unknown shape" problems that the text after the edit has and
 * the text before does not (issue #11: moving a shape to another layer or group changes its path,
 * and deleting it removes it). Messages, one per broken reference. Names are found anywhere in the
 * file, whatever the order, so reordering alone never breaks a reference.
 */
export function brokenReferences(before: string, after: string, options: CompileOptions = {}): string[] {
  const unknown = (source: string) => compile(source, options).diagnostics.filter((d) => d.code === Code.UnknownShape);
  const old = unknown(before).map((d) => d.message);
  const out: string[] = [];
  for (const d of unknown(after)) {
    const i = old.indexOf(d.message);
    if (i !== -1) old.splice(i, 1);
    else out.push(`Line ${after.slice(0, d.range.start).split("\n").length}: ${d.message}`);
  }
  return out;
}
