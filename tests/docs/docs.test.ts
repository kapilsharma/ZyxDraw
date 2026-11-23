/**
 * Runs every example in the shape docs as a test (see Docs/dev/Testing.md).
 *
 * The docs live outside this repo (the private Docs vault). Set ZYX_DOCS_DIR to point elsewhere;
 * if the folder is missing, these tests are skipped.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../../src/core";
import { extractCases } from "./markdown";
import { compareSvg } from "./svg-compare";

const DOCS_DIR = resolve(process.env.ZYX_DOCS_DIR ?? "../Docs/CustomLanguage/Shapes/inbuild");
const available = existsSync(DOCS_DIR);

const files = available ? readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md")) : [];
const cases = files.map((f) => ({ file: f, ...extractCases(readFileSync(join(DOCS_DIR, f), "utf8"), f) }));

/** Docs examples assume a 400 x 200 canvas unless they declare their own. */
function withCanvas(source: string): string {
  return /^\s*canvas\s*\(/m.test(source) ? source : `canvas(width=400, height=200)\n${source}`;
}

describe.skipIf(!available)(`docs examples (${DOCS_DIR})`, () => {
  for (const { file, examples } of cases) {
    if (examples.length === 0) continue;
    describe(file, () => {
      for (const ex of examples) {
        it(ex.title, () => {
          const result = compile(withCanvas(ex.source));
          const errors = result.diagnostics.filter((d) => d.severity === "error");
          expect(errors.map((d) => `${d.code} ${d.message}`), "unexpected errors").toEqual([]);
          const diff = compareSvg(result.svg, ex.svg);
          if (diff) {
            throw new Error(`${diff}\n\n--- source ---\n${ex.source}\n\n--- expected ---\n${ex.svg}\n\n--- actual ---\n${result.svg}`);
          }
        });
      }
    });
  }
});

describe.skipIf(!available)("docs error tables", () => {
  for (const { file, errors } of cases) {
    if (errors.length === 0) continue;
    describe(file, () => {
      for (const ec of errors) {
        it(ec.title, () => {
          const result = compile(ec.source);
          const found = result.diagnostics.filter((d) => d.severity === "error");
          expect(found.length, `expected an error for: ${ec.source}`).toBeGreaterThan(0);
        });
      }
    });
  }
});

it("docs folder is found (or deliberately skipped)", () => {
  if (!available) console.warn(`[docs tests] skipped: ${DOCS_DIR} not found`);
  expect(true).toBe(true);
});
