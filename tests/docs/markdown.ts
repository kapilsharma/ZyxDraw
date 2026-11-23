/**
 * Pulls test cases out of the shape docs:
 *   - Examples: one or more ```python blocks followed by a ```svg block in the same section.
 *   - Error cases: rows of an "## Errors" table whose first cell is exactly one `code` span.
 */

export interface DocExample {
  title: string;
  source: string;
  svg: string;
}

export interface DocErrorCase {
  title: string;
  source: string;
}

export function extractCases(markdown: string, file: string): { examples: DocExample[]; errors: DocErrorCase[] } {
  const lines = markdown.split(/\r?\n/);
  const examples: DocExample[] = [];
  const errors: DocErrorCase[] = [];

  let h2 = "";
  let heading = "";
  let pending: string[] = [];
  const counts = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      const text = body.join("\n");
      if (lang === "python") pending.push(text);
      if (lang === "svg") {
        for (const source of pending) {
          const base = `${file} > ${heading}`;
          const n = (counts.get(base) ?? 0) + 1;
          counts.set(base, n);
          examples.push({ title: n === 1 ? base : `${base} (${n})`, source, svg: text });
        }
        pending = [];
      }
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      pending = [];
      heading = h[2].trim();
      if (h[1].length <= 2) h2 = heading;
      continue;
    }

    if (h2 === "Errors") {
      const row = /^\|([^|]*)\|/.exec(line);
      const cell = row?.[1].trim() ?? "";
      if (/^`[^`]+`$/.test(cell) && cell !== "`Code`") {
        errors.push({ title: `${file} > Errors > ${cell}`, source: cell.slice(1, -1) });
      }
    }
  }
  return { examples, errors };
}
