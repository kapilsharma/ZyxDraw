import { describe, expect, it } from "vitest";
import { compile } from "../../src/core";
import { readFileSync } from "node:fs";
import { LOGO_SOURCE, logoCssUrl, logoIconContent, logoSvg } from "../../src/plugin/logo";

describe("logo", () => {
  it("compiles without problems", () => {
    expect(compile(LOGO_SOURCE).diagnostics).toEqual([]);
  });

  it("draws the blue N under the yellow Z", () => {
    const svg = logoSvg();
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 200 200"/);
    expect(svg.indexOf("#31bbec")).toBeLessThan(svg.indexOf("#fbb904"));
  });

  it("styles.css has the current logo for the file explorer icon", () => {
    const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    // If this fails after changing the logo, replace the url in styles.css with logoCssUrl().
    expect(css).toContain(`background-image: ${logoCssUrl()};`);
  });

  it("gives Obsidian an icon in a 100 x 100 box, without the svg element", () => {
    const icon = logoIconContent();
    expect(icon.startsWith('<g transform="scale(0.5)">')).toBe(true);
    expect(icon).not.toContain("<svg");
    expect(icon.match(/<path /g)).toHaveLength(2);
  });
});
