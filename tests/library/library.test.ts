/**
 * The example libraries in `library/` (issue #19): every library compiles, shows every exported
 * shape in its `preview()` block, works when imported into a drawing, and is listed in
 * `library/index.json`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../../src/core";

const ROOT = resolve("library");
/** The plugin's library folder, as a vault path: the libraries are copied into it. */
const FOLDER = "Libs";

function zyxdlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return zyxdlFiles(p);
    return f.endsWith(".zyxdl") ? [relative(ROOT, p).split("\\").join("/")] : [];
  });
}

const files = zyxdlFiles(ROOT).sort();
const libraries = new Map(files.map((f) => [`${FOLDER}/${f}`, readFileSync(join(ROOT, f), "utf8")]));
const nameOf = (file: string) => file.replace(/\.zyxdl$/, "").split("/").join(".");

interface Entry {
  name: string;
  description: string;
  version: string;
  licence: string;
  files: string[];
  imports: string[];
}
const index = JSON.parse(readFileSync(join(ROOT, "index.json"), "utf8")) as { format: number; libraries: Entry[] };

const opts = (path: string) => ({ path, libraryFolder: FOLDER, libraries });
const problems = (r: ReturnType<typeof compile>) => r.diagnostics.map((d) => `${d.code} ${d.message}`);

describe("example libraries", () => {
  it("has at least one library", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    describe(file, () => {
      const path = `${FOLDER}/${file}`;
      const source = libraries.get(path)!;
      const result = compile(source, opts(path));
      const gallery = result.scene.gallery!;

      it("compiles without problems", () => {
        expect(problems(result)).toEqual([]);
      });

      it("shows every exported shape in preview()", () => {
        const shown = new Set(gallery.cells.filter((c) => !c.shape.preview!.placeholder).map((c) => c.shape.preview!.def));
        const missing = gallery.defs.filter((d) => d.exported && !shown.has(d.name)).map((d) => d.name);
        expect(missing).toEqual([]);
      });

      it("works in a drawing: each preview() line, imported", () => {
        const lines = (gallery.block?.children ?? []).map((s) => source.slice(s.range.start, s.range.end).trim());
        const used = [...new Set(lines.map((l) => /^(?:[\w-]+\s+is\s+)?([\w-]+)\s*\(/.exec(l)![1]))];
        const drawing = `import ${used.join(", ")} from ${nameOf(file)}\n${lines.map((l, i) => `${l.replace(/\)\s*$/, `, x=0, y=${i * 200})`)}`).join("\n")}\n`;
        const r = compile(drawing, opts("drawing.zyxd"));
        expect(problems(r)).toEqual([]);
        expect(r.svg).toContain("<");
      });
    });
  }
});

describe("library/index.json", () => {
  it("uses format 1", () => {
    expect(index.format).toBe(1);
  });

  it("lists every library file once, and nothing else", () => {
    expect(index.libraries.flatMap((l) => l.files).sort()).toEqual(files);
  });

  it("names each library after its first file", () => {
    for (const l of index.libraries) expect(l.name).toBe(nameOf(l.files[0]));
  });

  it("fills every field", () => {
    for (const l of index.libraries) {
      expect(l.description.length, l.name).toBeGreaterThan(0);
      expect(l.version, l.name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(l.licence.length, l.name).toBeGreaterThan(0);
      expect(Array.isArray(l.imports), l.name).toBe(true);
    }
  });

  it("lists the libraries each one imports, all from this folder", () => {
    const names = new Set(index.libraries.map((l) => l.name));
    for (const l of index.libraries) {
      const text = l.files.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
      const imported = [...new Set([...text.matchAll(/^[ \t]*import\b.*\bfrom[ \t]+([\w.-]+)/gm)].map((m) => m[1]))].sort();
      expect(imported, l.name).toEqual([...l.imports].sort());
      for (const i of l.imports) expect(names.has(i), `${l.name} imports ${i}`).toBe(true);
    }
  });

  it("is in the README table", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const l of index.libraries) expect(readme, l.name).toContain(`| \`${l.name}\` |`);
  });
});

it("library/ exists next to the tests", () => {
  expect(existsSync(ROOT)).toBe(true);
});
