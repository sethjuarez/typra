import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate, SUPPORTED_TARGET_LANGUAGES } from "../src/generate.js";
import { validateNativeSerializationTargets } from "../src/native-serialization.js";

const require = createRequire(import.meta.url);

describe("generate", () => {
  it("rejects unsupported target languages before creating output", async () => {
    const output = path.join(tmpdir(), `typra-invalid-target-${Date.now()}`);
    const result = await generate({
      output,
      targets: ["invalid" as never],
    });

    assert.equal(result.success, false);
    assert.deepEqual(result.targets, ["invalid"]);
    assert.match(result.errors?.[0] ?? "", /Unsupported target language\(s\): invalid/);
    assert.equal(existsSync(output), false);
  });

  it("advertises every generator target through the public target registry", () => {
    assert.deepEqual(SUPPORTED_TARGET_LANGUAGES, [
      "python",
      "csharp",
      "typescript",
      "go",
      "java",
      "rust",
      "swift",
      "markdown",
    ]);
  });

  it("rejects unsupported native serialization target pairs before creating output", async () => {
    const output = path.join(tmpdir(), `typra-invalid-native-serialization-${Date.now()}`);
    const result = await generate({
      output,
      targets: {
        go: {
          outputDir: path.join(output, "go"),
          nativeSerialization: "zod",
        },
      } as never,
    });

    assert.equal(result.success, false);
    assert.match(result.errors?.[0] ?? "", /Target "go" does not support native-serialization "zod"/);
    assert.equal(existsSync(output), false);
  });

  it("validates native serialization compatibility centrally for every target", () => {
    assert.deepEqual(validateNativeSerializationTargets([
      { type: "TypeScript", "native-serialization": "zod" },
      { type: "python", "native-serialization": "pydantic" },
      { type: "java", "native-serialization": "jackson" },
      { type: "java", "native-serialization": "none" },
    ]), []);
    assert.deepEqual(validateNativeSerializationTargets([
      { type: "typescript", "native-serialization": "pydantic" },
      { type: "python", "native-serialization": "standard-schema" },
    ]), [
      'Target "typescript" does not support native-serialization "pydantic". Supported values: "none", "zod".',
      'Target "python" does not support native-serialization "standard-schema". Supported values: "none", "pydantic".',
    ]);
  });

  it("generates the bundled fixture with default source and root settings", async () => {
    const output = path.join(tmpdir(), `typra-default-generate-${Date.now()}`);
    try {
      const result = await generate({
        output,
        targets: ["swift"],
        format: false,
        generateTests: false,
      });

      assert.equal(result.success, true, result.errors?.join("\n"));
      assert.equal(existsSync(path.join(output, "swift", "Package.swift")), true);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("rejects complex defaults before they can relax required-field guards", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-complex-default-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(source, [
        'import "@typra/emitter";',
        "",
        "namespace Typra.DefaultProbe;",
        "",
        "model Root {",
        '  owner: Owner = #{ id: "owner-1" };',
        '  nullableOwner: Owner | null = #{ id: "owner-2" };',
        "  owners: Owner[] = #[];",
        "}",
        "",
        "model Owner {",
        "  id: string;",
        "}",
        "",
      ].join("\n"));
      writeFileSync(config, [
        "emit:",
        '  - "@typra/emitter"',
        "options:",
        '  "@typra/emitter":',
        `    emitter-output-dir: "${path.join(output, "generated")}"`,
        '    root-object: "Typra.DefaultProbe.Root"',
        '    root-namespace: "Typra.DefaultProbe"',
        "    emit-targets:",
        "      - type: TypeScript",
        `        output-dir: "${path.join(output, "generated", "typescript")}"`,
        "        format: false",
        "",
      ].join("\n"));

      assert.throws(
        () => execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
        (error: unknown) => {
          const output = error && typeof error === "object" && "stdout" in error && "stderr" in error
            ? `${String((error as { stdout?: unknown }).stdout ?? "")}${String((error as { stderr?: unknown }).stderr ?? "")}`
            : String(error);
          assert.match(output, /typra-emitter-unsupported-complex-default/);
          assert.match(output, /Property 'owner' has an unsupported default/);
          assert.match(output, /Property 'nullableOwner' has an unsupported default/);
          assert.match(output, /Property 'owners' has an unsupported default/);
          return true;
        },
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("rejects native serialization values on unsupported targets", () => {
    const output = mkdtempSync(path.join(process.cwd(), "tmp-native-serialization-target-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");
    try {
      writeFileSync(source, [
        'import "@typra/emitter";',
        "",
        "namespace Typra.NativeProbe;",
        "",
        "model Root {",
        "  name: string;",
        "}",
        "",
      ].join("\n"));
      writeFileSync(config, [
        "emit:",
        '  - "@typra/emitter"',
        "options:",
        '  "@typra/emitter":',
        `    emitter-output-dir: "${path.join(output, "generated")}"`,
        '    root-object: "Typra.NativeProbe.Root"',
        "    emit-targets:",
        "      - type: Python",
        `        output-dir: "${path.join(output, "generated", "python")}"`,
        '        native-serialization: "jackson"',
        "        format: false",
        "",
      ].join("\n"));

      assert.throws(
        () => execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
        (error: unknown) => {
          const output = error && typeof error === "object" && "stdout" in error && "stderr" in error
            ? `${String((error as { stdout?: unknown }).stdout ?? "")}${String((error as { stderr?: unknown }).stderr ?? "")}`
            : String(error);
          assert.match(output, /typra-emitter-native-serialization-target/);
          assert.match(output, /native-serialization 'jackson' is not supported for target 'Python'/);
          return true;
        },
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
