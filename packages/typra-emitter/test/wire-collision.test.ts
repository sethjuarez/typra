import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { detectWireCollisions } from "../src/ir/lower.js";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

describe("wire-name collisions", () => {
  it("flags two canonical fields mapping to the same wire name for one provider", () => {
    const mappings = [
      { fieldName: "maxOutputTokens", wireNames: { openai: "max_tokens" } },
      { fieldName: "maxTokens", wireNames: { openai: "max_tokens" } },
    ];

    const collisions = detectWireCollisions(mappings);

    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].provider, "openai");
    assert.equal(collisions[0].wireName, "max_tokens");
    assert.deepEqual(collisions[0].fields, ["maxOutputTokens", "maxTokens"]);
  });

  it("does not flag distinct wire names or per-provider reuse of a name", () => {
    const mappings: { fieldName: string; wireNames: Record<string, string> }[] =
      [
        {
          fieldName: "maxOutputTokens",
          wireNames: {
            openai: "max_completion_tokens",
            anthropic: "max_tokens",
          },
        },
        // Same wire name, but a DIFFERENT provider — not a collision.
        { fieldName: "budget", wireNames: { cohere: "max_tokens" } },
        { fieldName: "temperature", wireNames: { openai: "temperature" } },
      ];

    assert.deepEqual(detectWireCollisions(mappings), []);
  });

  it("reports typra-emitter-wire-collision when compiling a colliding model", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-wire-collision-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(
        source,
        [
          'import "@typra/emitter";',
          "",
          "namespace Typra.CollisionProbe;",
          "",
          "model Root {",
          "  options: WireOptions;",
          "}",
          "",
          // Two canonical fields both map to "max_tokens" for openai.
          '@@knownAs(WireOptions.maxOutputTokens, "openai", "max_tokens");',
          '@@knownAs(WireOptions.maxTokens, "openai", "max_tokens");',
          "model WireOptions {",
          "  maxOutputTokens?: int32;",
          "  maxTokens?: int32;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(path.join(output, "generated"))}`,
          '    root-object: "Typra.CollisionProbe.Root"',
          '    root-namespace: "Typra.CollisionProbe"',
          "    emit-targets:",
          "      - type: TypeScript",
          `        output-dir: ${yamlString(path.join(output, "generated", "typescript"))}`,
          "        format: false",
          "",
        ].join("\n"),
      );

      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [tspCli, "compile", source, "--config", config],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            },
          ),
        (error: unknown) => {
          const combined =
            error &&
            typeof error === "object" &&
            "stdout" in error &&
            "stderr" in error
              ? `${String((error as { stdout?: unknown }).stdout ?? "")}${String((error as { stderr?: unknown }).stderr ?? "")}`
              : String(error);
          assert.match(combined, /typra-emitter-wire-collision/);
          assert.match(combined, /openai/);
          assert.match(combined, /max_tokens/);
          assert.match(combined, /maxOutputTokens/);
          assert.match(combined, /maxTokens/);
          return true;
        },
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
