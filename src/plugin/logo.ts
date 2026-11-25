// The ZyxDraw logo (the Zoey Nyxx Z and N), written in ZyxDraw itself.
// Same drawing as Docs/Examples/04_zoey_nyxx_logo.zyxd: change both together.
// No Obsidian imports, so tests can check it.
import { compile } from "../core";

export const LOGO_ICON = "zyxdraw-logo";

export const LOGO_SOURCE = `canvas(width=200, height=200)

letter_z is shape(color):
  path(fill=color, d="M 56.4 5.3 Q 63.9 0 70.9 5.3 L 128.3 37.4 L 128.6 49.8 Q 105.1 54.8 83.8 77.6 Q 68.8 94.2 46.8 116.4 L 57.4 120.6 Q 63.6 123.1 68.8 121.1 L 130.2 98.5 L 130.6 113 L 73 148 Q 66.2 152.6 59.5 148 L 0.5 115.5 L 0 103.1 Q 22.2 99.3 45.5 74 Q 59.5 56.9 81.8 36.4 L 72.4 33.6 Q 64.2 30 58.5 32.6 L 0.9 54 L 0.6 39 Z")

nyxx is letter_z(color=#31bbec, x=34.2, y=28.2, rotate=-60, scale=1.25)
zoey is letter_z(color=#fbb904, x=34.7, y=28, scale=1.1)
`;

/** The logo as a full SVG file (what `Export as SVG` gives for the logo drawing). */
export function logoSvg(): string {
  return compile(LOGO_SOURCE).svg;
}

/**
 * The logo for Obsidian's `addIcon`: the inside of an SVG with viewBox 0 0 100 100.
 * The logo fills its square canvas, so the canvas is scaled to 100.
 */
export function logoIconContent(): string {
  const result = compile(LOGO_SOURCE);
  const { width, height } = result.scene.frame;
  const k = 100 / Math.max(width, height);
  const inner = result.svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").trim();
  return `<g transform="scale(${k})">${inner}</g>`;
}
