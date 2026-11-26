/**
 * The Zyxd guide for AI assistants (docs/zyxd-for-ai.md): every ```zyxd block must compile with no
 * problems, so the guide never teaches wrong syntax. Imports resolve against the libraries in `library/`.
 * Wrong examples are written as ```text blocks, which are not checked.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../../src/core";

const GUIDE = resolve("docs/zyxd-for-ai.md");
const LIB_ROOT = resolve("library");
const FOLDER = "Libs";

function zyxdlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return zyxdlFiles(p);
    return p.endsWith(".zyxdl") ? [relative(LIB_ROOT, p).split("\\").join("/")] : [];
  });
}

const libraries = new Map(zyxdlFiles(LIB_ROOT).map((f) => [`${FOLDER}/${f}`, readFileSync(join(LIB_ROOT, f), "utf8")]));

/** Each ```zyxd block, with the nearest heading above it. */
function blocks(markdown: string): { title: string; source: string }[] {
  const out: { title: string; source: string }[] = [];
  const lines = markdown.split(/\r?\n/);
  let heading = "";
  let label = "";
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{1,6}\s+(.*)$/.exec(lines[i]);
    if (h) {
      heading = h[1].trim();
      label = "";
      continue;
    }
    const bold = /^\*\*(.+?):?\*\*$/.exec(lines[i].trim());
    if (bold) label = bold[1];
    if (/^```zyxd\s*$/.test(lines[i])) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      const base = label ? `${heading} > ${label}` : heading;
      const n = out.filter((b) => b.title.startsWith(base)).length;
      out.push({ title: n ? `${base} (${n + 1})` : base, source: body.join("\n") });
    }
  }
  return out;
}

const cases = blocks(readFileSync(GUIDE, "utf8"));

describe("Zyxd guide for AI (docs/zyxd-for-ai.md)", () => {
  it("has examples", () => {
    expect(cases.length).toBeGreaterThan(5);
  });

  for (const c of cases) {
    it(c.title, () => {
      const result = compile(c.source, { path: "drawing.zyxd", libraryFolder: FOLDER, libraries });
      const lineOf = (offset: number) => c.source.slice(0, offset).split("\n").length;
      const problems = result.diagnostics.map((d) => `${d.severity} ${d.code} line ${lineOf(d.range.start)}: ${d.message}`);
      expect(problems, `\n--- source ---\n${c.source}`).toEqual([]);
    });
  }
});
