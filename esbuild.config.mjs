// Bundles src/plugin/main.ts into main.js (same approach as the official Obsidian sample plugin).
//
//   npm run dev     -> watch mode
//   npm run build   -> one production build
//
// Optional: copy every build into a vault's plugin folder (<vault>/.obsidian/plugins/zyxdraw),
// plus a .hotreload marker for the "Hot Reload" community plugin. The folder comes from:
//   1. the OBSIDIAN_PLUGIN_DIR environment variable, or
//   2. the first line of .obsidian-plugin-dir (git-ignored, so local paths stay out of the repo).
import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const production = process.argv[2] === "production";
const pluginDir = findPluginDir();

function findPluginDir() {
  if (process.env.OBSIDIAN_PLUGIN_DIR) return process.env.OBSIDIAN_PLUGIN_DIR;
  if (!existsSync(".obsidian-plugin-dir")) return null;
  const line = readFileSync(".obsidian-plugin-dir", "utf8").split(/\r?\n/)[0].trim();
  return line ? resolve(line) : null;
}

const copyToVault = {
  name: "copy-to-vault",
  setup(build) {
    build.onEnd((result) => {
      if (!pluginDir || result.errors.length > 0) return;
      mkdirSync(pluginDir, { recursive: true });
      for (const file of ["main.js", "manifest.json", "styles.css"]) {
        copyFileSync(file, join(pluginDir, file));
      }
      const marker = join(pluginDir, ".hotreload");
      if (!existsSync(marker)) writeFileSync(marker, "");
      console.log(`[zyxdraw] copied build to ${pluginDir}`);
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/plugin/main.ts"],
  bundle: true,
  // Provided by Obsidian at runtime. Never bundle these.
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  plugins: [copyToVault],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
