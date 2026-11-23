import type { FontSpec, TextMeasurer } from "../core";

/** Measures text with the real font through a hidden canvas (plugin only, needs the DOM). */
export function createCanvasMeasurer(): TextMeasurer {
  const canvas = activeDocument.createElement("canvas");
  const ctx = canvas.getContext("2d");
  return {
    measure(text: string, font: FontSpec) {
      const lines = text.split("\n");
      const height = lines.length * font.size * 1.2;
      if (!ctx) {
        const longest = Math.max(...lines.map((l) => l.length));
        return { width: longest * font.size * 0.6, height };
      }
      ctx.font = `${font.style ?? "normal"} ${font.weight ?? "normal"} ${font.size}px ${font.family ?? "sans-serif"}`;
      const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
      return { width, height };
    },
  };
}
