import { App, Notice, TFile, normalizePath } from "obsidian";
import { toJsonCanvas, type CompileResult } from "../core";
import type { ZyxSettings } from "./settings";

/** Renders an SVG string to a PNG blob through a browser canvas (works on desktop and mobile). */
export async function svgToPng(svg: string, scale: number, background: string | null): Promise<Blob> {
  const width = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1] ?? 400);
  const height = Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1] ?? 300);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();

  const canvas = createEl("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  ctx.scale(scale, scale);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png"),
  );
}

/** Writes `<name>.<ext>` next to the drawing, replacing an earlier export. */
export async function saveNextTo(app: App, file: TFile, ext: string, data: string | ArrayBuffer): Promise<TFile> {
  const folder = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
  const path = normalizePath(`${folder}${file.basename}.${ext}`);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    if (typeof data === "string") await app.vault.modify(existing, data);
    else await app.vault.modifyBinary(existing, data);
    return existing;
  }
  return typeof data === "string" ? app.vault.create(path, data) : app.vault.createBinary(path, data);
}

export type ExportKind = "svg" | "png" | "canvas" | "copy-svg" | "copy-png";

/** Runs one export for a compiled drawing (compiled without editor metadata). */
export async function runExport(app: App, file: TFile, result: CompileResult, kind: ExportKind, settings: ZyxSettings): Promise<void> {
  const errors = result.diagnostics.filter((d) => d.severity === "error").length;
  const warn = errors > 0 ? ` (the drawing has ${errors} error${errors > 1 ? "s" : ""})` : "";
  const background = result.scene.frame.background ?? (settings.pngBackground === "white" ? "white" : null);
  try {
    switch (kind) {
      case "svg": {
        const saved = await saveNextTo(app, file, "svg", result.svg);
        new Notice(`Exported ${saved.path}${warn}`);
        break;
      }
      case "png": {
        const blob = await svgToPng(result.svg, settings.pngScale, background);
        const saved = await saveNextTo(app, file, "png", await blob.arrayBuffer());
        new Notice(`Exported ${saved.path}${warn}`);
        break;
      }
      case "canvas": {
        const { canvas, warnings } = toJsonCanvas(result.scene);
        const saved = await saveNextTo(app, file, "canvas", JSON.stringify(canvas, null, 2));
        new Notice(`Exported ${saved.path}${warnings.length ? ` (${warnings.length} item(s) skipped: no JSON Canvas equivalent)` : ""}`);
        break;
      }
      case "copy-svg":
        await navigator.clipboard.writeText(result.svg);
        new Notice(`SVG copied to the clipboard${warn}`);
        break;
      case "copy-png": {
        const blob = await svgToPng(result.svg, settings.pngScale, background);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        new Notice(`PNG copied to the clipboard${warn}`);
        break;
      }
    }
  } catch (err) {
    console.error("ZyxDraw export failed", err);
    new Notice(`ZyxDraw export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
