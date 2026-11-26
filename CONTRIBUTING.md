# Contributing to ZyxDraw

Ideas and bug reports are welcome as [GitHub issues](https://github.com/kapilsharma/ZyxDraw/issues). Before suggesting a feature, read [Why ZyxDraw](WhyZyxDraw.md).

## Development

Requirements: Node.js (LTS or newer) and npm.

```sh
npm install
npm test          # unit tests and docs examples (plain Node)
npm run lint      # includes the "core must stay pure" rule
npm run build     # type check + production bundle -> main.js
npm run dev       # watch mode
```

To try it in a vault, point the build at the vault's plugin folder:

```powershell
$env:OBSIDIAN_PLUGIN_DIR = "C:\path\to\vault\.obsidian\plugins\zyxdraw"
npm run dev
```

Or put that path on the first line of a git-ignored file named `.obsidian-plugin-dir` in the repo root. Each build copies `main.js`, `manifest.json` and `styles.css` there. A hot-reload plugin can reload ZyxDraw after each build.

Layout:

- `src/core/`: pure TypeScript (parser, resolve, layout, SVG, edits, JSON Canvas). No Obsidian or DOM, enforced by lint.
- `src/plugin/`: Obsidian views, drawing editor, commands, export, embeds, settings.
- `tests/`: Vitest. `tests/docs/` runs the examples from the language reference when `ZYX_DOCS_DIR` (or the default private docs folder) exists.

### Release

Once per repository: in GitHub, **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**.

1. Update `version` in `manifest.json` and `package.json`, and add it to `versions.json` with the minimum Obsidian version.
2. Commit, then tag with the same version (no `v` prefix) and push the tag: `git tag -a 0.1.0 -m "0.1.0"` and `git push origin 0.1.0`.
3. The release workflow runs the tests, checks the tag matches `manifest.json`, builds, attests the build (signed provenance, recommended for the community directory) and attaches `main.js`, `manifest.json` and `styles.css` to a draft GitHub release with generated notes. Review and publish it.
