import type { SourceRange } from "./syntax/ast";

export type Severity = "error" | "warning";

export interface Diagnostic {
  code: string;
  message: string;
  severity: Severity;
  range: SourceRange;
}

/**
 * Stable error codes. Messages can change, codes should not.
 *   ZYX0xx  syntax (parser)
 *   ZYX1xx  meaning (resolve)
 *   ZYX2xx  layout
 */
export const Code = {
  UnclosedParen: "ZYX001",
  ExpectedEquals: "ZYX002",
  UnterminatedString: "ZYX003",
  Indentation: "ZYX004",
  UnexpectedIndent: "ZYX005",
  MissingValue: "ZYX006",
  ExpectedParen: "ZYX007",
  UnexpectedChar: "ZYX008",
  TrailingText: "ZYX009",
  UnexpectedCloseParen: "ZYX010",
  EmptyBlock: "ZYX011",
  ExpectedStatement: "ZYX012",
  /** `rect box(...)`: the name now comes first, `box is rect(...)`. */
  OldSyntax: "ZYX013",
  /** A name that is a keyword or a shape type (`is`, `rect`, `style`, ...). */
  ReservedName: "ZYX014",
  /** A library name in an import that is not `folder.file` (a `/`, an extension, other characters). */
  InvalidLibraryName: "ZYX015",

  UnknownType: "ZYX101",
  NotSupportedYet: "ZYX102",
  DuplicateName: "ZYX103",
  UnknownAttribute: "ZYX104",
  DuplicateAttribute: "ZYX105",
  InvalidValue: "ZYX106",
  OutOfRange: "ZYX107",
  PercentNotSupported: "ZYX108",
  MissingRequired: "ZYX109",
  UnknownStyle: "ZYX110",
  ChildrenNotAllowed: "ZYX111",
  Canvas: "ZYX112",
  UnexpectedPositional: "ZYX113",
  InvalidGeometry: "ZYX114",
  ConflictingAttributes: "ZYX115",
  ImportNotFound: "ZYX116",
  CircularImport: "ZYX117",
  CircularShape: "ZYX118",
  InvalidDefinition: "ZYX119",
  PrivatePart: "ZYX120",
  UnknownClip: "ZYX121",
  InvalidClip: "ZYX122",
  InvalidGradient: "ZYX123",
  /** `layer` inside a group, a custom shape or another layer: layers are top level only. */
  LayerNotTopLevel: "ZYX124",
  /** `canvas` or a shape at the top level of a `.zyxdl` library: a library draws nothing. */
  LibraryDraws: "ZYX125",
  /** `export` in a drawing, or of a name the library does not have. */
  Export: "ZYX126",

  UnknownShape: "ZYX201",
  PositionConflict: "ZYX202",
  CircularAnchor: "ZYX203",
  PercentNeedsSize: "ZYX204",
  AnchorToLine: "ZYX205",
  LayoutLimit: "ZYX206",
} as const;

export class Diagnostics {
  readonly list: Diagnostic[] = [];
  private readonly seen = new Set<string>();

  error(code: string, message: string, range: SourceRange): void {
    this.add({ code, message, severity: "error", range });
  }

  warning(code: string, message: string, range: SourceRange): void {
    this.add({ code, message, severity: "warning", range });
  }

  protected add(d: Diagnostic): void {
    // The same problem can be found more than once (e.g. a style used by many shapes).
    const key = `${d.code}:${d.range.start}:${d.range.end}:${d.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push(d);
  }
}

/**
 * Forwards problems found in another place (a library file, or the body of a custom shape) to
 * one range in the file the user is editing, with a prefix and the original line number.
 */
export class ScopedDiagnostics extends Diagnostics {
  constructor(
    private readonly parent: Diagnostics,
    private readonly range: SourceRange,
    private readonly prefix: string,
    /** Source text the original ranges refer to, for line numbers. */
    private readonly source?: string,
  ) {
    super();
  }

  protected override add(d: Diagnostic): void {
    const line = this.source !== undefined ? ` (line ${this.source.slice(0, d.range.start).split("\n").length})` : "";
    const message = `${this.prefix}${d.message}${line}`;
    if (d.severity === "error") this.parent.error(d.code, message, this.range);
    else this.parent.warning(d.code, message, this.range);
  }
}
