import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Build output and the Node build script are not plugin code.
  globalIgnores(["node_modules", "main.js", "esbuild.config.mjs"]),
  // The same rules as Obsidian's community plugin review (ESLint, type-checked typescript-eslint, Obsidian rules).
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "vitest.config.ts"],
        },
      },
    },
  },
  {
    // Core must stay pure: no Obsidian, no editor, no DOM, no file system.
    // See Docs/dev/Architecture.md.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["obsidian", "@codemirror/*", "**/plugin/**", "fs", "path", "node:*"],
              message: "src/core must stay pure (no Obsidian, editor, DOM or file access).",
            },
          ],
        },
      ],
      "no-restricted-globals": ["error", "document", "window", "navigator", "localStorage"],
    },
  },
]);
