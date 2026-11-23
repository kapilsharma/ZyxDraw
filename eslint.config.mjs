import tseslint from "typescript-eslint";

export default [
  { ignores: ["main.js", "node_modules/**"] },
  ...tseslint.configs.recommended,
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
];
