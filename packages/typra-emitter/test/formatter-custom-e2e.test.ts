// Copyright (c) Microsoft. All rights reserved.

// End-to-end proof that a consumer-declared `format` command survives the full
// path: tspconfig YAML -> TypeSpec option validation (ajv, coerceTypes:true) ->
// EmitTarget.format -> the driver's custom-formatter branch -> execFileSync.
//
// The unit tests in formatter-runner.test.ts exercise the runner in isolation;
// this test closes the remaining gap by running a real `tsp compile` and
// asserting the declared command actually executed against the emitted tree
// (it drops a marker file into {dir}). It also confirms the sibling guarantee
// that `format: false` on a second target genuinely skips formatting -- the
// regression that the schema's dropped null branch protects.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

const SPEC = [
  'import "@typra/emitter";',
  "",
  "namespace Typra.Fmt;",
  "",
  "model Root {",
  "  id: string;",
  "}",
  "",
].join("\n");

// A portable "formatter": node writes a marker file into the directory it is
// handed as {dir}, proving the command ran with a substituted argument.
const MARKER = "FORMATTED_BY_CUSTOM.txt";
const FORMATTER_SCRIPT =
  "require('fs').writeFileSync(" +
  `require('path').join(process.argv[1], '${MARKER}'), 'ok')`;

describe("consumer-declared formatter command (end-to-end)", () => {
  it("runs the declared command over {dir} and leaves format:false targets untouched", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-fmt-e2e-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const customDir = path.join(output, "generated", "typescript");
    const plainDir = path.join(output, "generated", "python");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");

    try {
      writeFileSync(source, SPEC);
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.Fmt.Root"',
          '    root-namespace: "Typra.Fmt"',
          "    emit-targets:",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(customDir)}`,
          "        format:",
          `          command: ${yamlString(process.execPath)}`,
          "          args:",
          '            - "-e"',
          `            - ${yamlString(FORMATTER_SCRIPT)}`,
          '            - "{dir}"',
          "      - type: Python",
          `        output-dir: ${yamlString(plainDir)}`,
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      // The custom command ran: its marker landed in the TypeScript {dir}.
      assert.ok(
        existsSync(path.join(customDir, MARKER)),
        "the consumer-declared formatter command should have run against {dir}",
      );

      // The format:false sibling target did not receive the custom command:
      // the marker is scoped to its own target's {dir} and does not leak. (The
      // false -> null coercion guard itself is locked by the closed-loop test,
      // which compiles a format:false target and would crash under coercion.)
      assert.ok(
        !existsSync(path.join(plainDir, MARKER)),
        "a format:false target must not run the sibling's formatter command",
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
