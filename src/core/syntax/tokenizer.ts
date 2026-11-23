import { Code, Diagnostics } from "../diagnostics";

export type TokenKind = "ident" | "number" | "string" | "color" | "punct";

export interface Token {
  kind: TokenKind;
  /** Raw source text of the token. */
  text: string;
  /** Decoded string, or the number value. */
  value: string | number;
  unit: "" | "px" | "%";
  start: number;
  end: number;
  /** Physical line index (0-based). */
  line: number;
}

export interface LineInfo {
  start: number;
  /** Number of leading whitespace characters. */
  indent: number;
  usesTab: boolean;
  usesSpace: boolean;
}

export interface TokenizeResult {
  tokens: Token[];
  lines: LineInfo[];
}

const IDENT = /[A-Za-z_][A-Za-z0-9_.-]*/y;
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(%|px)?/y;
const HEX_COLOR = /#[0-9a-fA-F]{3,8}(?![A-Za-z0-9_])/y;
/** `+ - * /` are for calculations (`width / 2`). A `-` directly before a digit is a negative number. */
const PUNCT = "()=,:+-*/";

/**
 * Splits source into tokens. Comments (`# ...`) are dropped. A `#` directly after `=`, `(` or `,`
 * followed by hex digits is a color (`fill=#4a90d9`), otherwise it starts a comment.
 */
export function tokenize(source: string, diags: Diagnostics): TokenizeResult {
  const tokens: Token[] = [];
  const lines: LineInfo[] = [];

  // A byte order mark (saved by some editors) is not part of the text.
  let lineStart = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let lineIndex = 0;
  while (lineStart <= source.length) {
    let lineEnd = source.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = source.length;
    let contentEnd = lineEnd;
    if (contentEnd > lineStart && source[contentEnd - 1] === "\r") contentEnd--;

    let pos = lineStart;
    let usesTab = false;
    let usesSpace = false;
    while (pos < contentEnd && (source[pos] === " " || source[pos] === "\t")) {
      if (source[pos] === "\t") usesTab = true;
      else usesSpace = true;
      pos++;
    }
    lines.push({ start: lineStart, indent: pos - lineStart, usesTab, usesSpace });

    const lineFirstToken = tokens.length;
    while (pos < contentEnd) {
      const ch = source[pos];
      if (ch === " " || ch === "\t") {
        pos++;
        continue;
      }

      // `import x from lib/shapes.zyxd`: an unquoted path may contain `/` and `.`.
      const prevTok = tokens[tokens.length - 1];
      if (ch !== '"' && prevTok?.text === "from" && prevTok.line === lineIndex && tokens[lineFirstToken]?.text === "import") {
        let end = pos;
        while (end < contentEnd && !/[\s#]/.test(source[end])) end++;
        const text = source.slice(pos, end);
        tokens.push({ kind: "string", text, value: text, unit: "", start: pos, end, line: lineIndex });
        pos = end;
        continue;
      }

      if (ch === "#") {
        const prev = tokens[tokens.length - 1];
        const valuePosition =
          prev !== undefined && prev.kind === "punct" && (prev.text === "=" || prev.text === "(" || prev.text === ",");
        HEX_COLOR.lastIndex = pos;
        const m = valuePosition ? HEX_COLOR.exec(source) : null;
        if (m && pos + m[0].length <= contentEnd) {
          tokens.push(token("color", m[0], m[0], pos, lineIndex));
          pos += m[0].length;
          continue;
        }
        break; // comment: rest of the line
      }

      if (ch === '"') {
        let i = pos + 1;
        let value = "";
        let closed = false;
        while (i < contentEnd) {
          const c = source[i];
          if (c === "\\" && i + 1 < contentEnd) {
            const n = source[i + 1];
            value += n === "n" ? "\n" : n === "t" ? "\t" : n;
            i += 2;
            continue;
          }
          if (c === '"') {
            closed = true;
            i++;
            break;
          }
          value += c;
          i++;
        }
        if (!closed) diags.error(Code.UnterminatedString, "Unterminated string (missing closing `\"`)", { start: pos, end: contentEnd });
        tokens.push({ kind: "string", text: source.slice(pos, i), value, unit: "", start: pos, end: i, line: lineIndex });
        pos = i;
        continue;
      }

      if ((ch >= "0" && ch <= "9") || ch === "." || (ch === "-" && /[0-9.]/.test(source[pos + 1] ?? ""))) {
        NUMBER.lastIndex = pos;
        const m = NUMBER.exec(source);
        if (m) {
          const unit = (m[1] ?? "") as Token["unit"];
          const num = parseFloat(unit ? m[0].slice(0, -unit.length) : m[0]);
          tokens.push({ kind: "number", text: m[0], value: num, unit, start: pos, end: pos + m[0].length, line: lineIndex });
          pos += m[0].length;
          continue;
        }
      }

      if (/[A-Za-z_]/.test(ch)) {
        IDENT.lastIndex = pos;
        const m = IDENT.exec(source)!;
        tokens.push(token("ident", m[0], m[0], pos, lineIndex));
        pos += m[0].length;
        continue;
      }

      if (PUNCT.includes(ch)) {
        tokens.push(token("punct", ch, ch, pos, lineIndex));
        pos++;
        continue;
      }

      diags.error(Code.UnexpectedChar, `Unexpected character \`${ch}\``, { start: pos, end: pos + 1 });
      pos++;
    }

    if (lineEnd >= source.length) break;
    lineStart = lineEnd + 1;
    lineIndex++;
  }

  return { tokens, lines };
}

function token(kind: TokenKind, text: string, value: string, start: number, line: number): Token {
  return { kind, text, value, unit: "", start, end: start + text.length, line };
}
