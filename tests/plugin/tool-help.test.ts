// Help for the drawing area's tools (issue #42): one table, read by the toolbar tooltips and the
// Help tab. These checks keep it complete and in step with the toolbar and its keys.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_URL, TOOLS, TOOL_HELP, forPlatform } from "../../src/plugin/tool-help";

const read = (path: string) => readFileSync(resolve(__dirname, "../..", path), "utf8");
const drawing = read("src/plugin/drawing.ts");

describe("tool help", () => {
  it("has help for every tool: name, key, tooltip, about and steps", () => {
    for (const tool of TOOLS) {
      const help = TOOL_HELP[tool];
      expect(help, tool).toBeDefined();
      expect(help.name, tool).not.toBe("");
      expect(help.key, tool).toMatch(/^[A-Z]$/);
      expect(help.tooltip, tool).toContain(`(${help.key}`);
      expect(help.about, tool).not.toBe("");
      expect(help.steps.length, tool).toBeGreaterThanOrEqual(3);
      for (const step of help.steps) {
        expect(step.how, tool).not.toBe("");
        expect(step.does, tool).not.toBe("");
      }
    }
    expect(Object.keys(TOOL_HELP).sort()).toEqual([...TOOLS].sort());
  });

  it("matches the toolbar: every tool button takes its tooltip from the table", () => {
    const buttons = [...drawing.matchAll(/this\.toolButtons\.set\(\s*"(\w+)"/g)].map((m) => m[1]);
    expect(buttons.sort()).toEqual([...TOOLS].sort());
    for (const tool of TOOLS) expect(drawing, tool).toContain(`TOOL_HELP.${tool}.tooltip`);
  });

  it("matches the keys that pick each tool", () => {
    const keys = new Map<string, string>();
    for (const m of drawing.matchAll(/e\.key === "(\w)" \|\| e\.key === "\w"\)\) \{\s*this\.setTool\("(\w+)"\)/g)) keys.set(m[2], m[1].toUpperCase());
    for (const tool of TOOLS) expect(keys.get(tool), tool).toBe(TOOL_HELP[tool].key);
  });

  it("has a hint line for each drawing tool, and only for those (issue #33)", () => {
    const list = drawing.match(/const DRAWING_TOOLS: Tool\[\] = \[([^\]]*)\]/)?.[1] ?? "";
    const drawingTools = [...list.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    expect(drawingTools.length).toBeGreaterThan(0);
    expect(TOOLS.filter((t) => TOOL_HELP[t].hint).sort()).toEqual(drawingTools);
  });

  it("tells how to make a curve and take back a point with the pen (issue #33)", () => {
    const pen = TOOL_HELP.pen;
    expect(pen.hint).toBe("Click: corner · Press and drag: curve · Shift: arc · Backspace: remove last point · Enter: finish · Esc: stop");
    expect(pen.tooltip).toContain("press and drag for a curve");
    expect(pen.tooltip).toContain("Backspace");
    expect(pen.steps.map((s) => s.how)).toEqual(expect.arrayContaining(["Press and drag", "Backspace or Ctrl+Z", "Esc"]));
  });

  it("links to a section that exists in the editing guide", () => {
    const anchor = DOCS_URL.split("#")[1];
    const slugs = [...read("docs/editing.md").matchAll(/^#+ (.+)$/gm)].map((m) => m[1].trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-"));
    expect(slugs).toContain(anchor);
  });

  it("uses the locked terms", () => {
    const all = JSON.stringify(TOOL_HELP).toLowerCase();
    for (const banned of ["property", "properties", "pane", "drawing view", "text view", "canvas view"]) expect(all, banned).not.toContain(banned);
  });

  it("shows Cmd for Ctrl on Mac only", () => {
    expect(forPlatform("Ctrl+D", true)).toBe("Cmd+D");
    expect(forPlatform("Ctrl + mouse wheel", false)).toBe("Ctrl + mouse wheel");
  });
});
