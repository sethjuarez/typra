import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

import { WEB_COMPILE_COMPILER_OPTIONS } from "./fixtures/web-compile-profile.mjs";

// Resolve the same TypeScript the validation stage compiles with.
const require = createRequire(import.meta.url);
const ts = require("typescript");

/**
 * Compile the given synthetic sources under the exact web-oriented profile the
 * `typescript.web-compile` validation stage uses, and return the resulting
 * diagnostic codes. This exercises the shared profile object rather than a
 * re-typed copy, so a drift in the stage's options is caught here too.
 */
function compileUnderWebProfile(sources) {
  const dir = mkdtempSync(path.join(tmpdir(), "typra-web-profile-"));
  try {
    const files = sources.map((source) => {
      const filePath = path.join(dir, source.name);
      writeFileSync(filePath, source.content);
      return filePath;
    });
    const { options, errors } = ts.convertCompilerOptionsFromJson(
      WEB_COMPILE_COMPILER_OPTIONS,
      dir,
    );
    assert.equal(
      errors.length,
      0,
      `web compile profile is not a valid tsconfig: ${errors
        .map((error) => error.messageText)
        .join(", ")}`,
    );
    const program = ts.createProgram(files, options);
    return ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => diagnostic.code);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("web compile profile accepts web-runtime capabilities", () => {
  const codes = compileUnderWebProfile([
    {
      name: "neutral.ts",
      content: [
        "export const encoded = new TextEncoder().encode('typra');",
        "export const endpoint = new URL('https://example.test/v1');",
        "export async function ping(): Promise<number> {",
        "  const response = await fetch(endpoint);",
        "  console.log(response.status);",
        "  return response.status;",
        "}",
        "",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(
    codes,
    [],
    "the shipped library's allowed web globals (fetch, URL, console, TextEncoder) must type-check without @types/node",
  );
});

test("web compile profile rejects Node-only coupling", () => {
  const codes = compileUnderWebProfile([
    {
      name: "node-coupled.ts",
      content: [
        "export const home = process.env.HOME;",
        "export const bytes = Buffer.from('typra');",
        "const { parse } = require('yaml');",
        "export const parsed = parse('a: 1');",
        "",
      ].join("\n"),
    },
  ]);
  // TS2591: "Cannot find name 'X'. Do you need to install type definitions for
  // node?" — emitted for process, Buffer, and require once @types/node is gone.
  assert.ok(
    codes.includes(2591),
    `Node globals must fail the web compile profile, got diagnostics: ${JSON.stringify(codes)}`,
  );
});
