import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate, SUPPORTED_TARGET_LANGUAGES } from "../src/generate.js";

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
});
