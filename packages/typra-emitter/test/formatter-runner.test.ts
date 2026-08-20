import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveCustomFormatters,
  runCustomFormatters,
  substituteFormatterArgs,
} from "../src/languages/formatter-runner.js";
import type { FormatterCommand } from "../src/lib.js";

/** Portable "formatter": a node one-liner that writes a marker file into {dir}. */
function markerWriter(markerName = "marker.txt"): FormatterCommand {
  return {
    command: process.execPath,
    args: [
      "-e",
      `require('fs').writeFileSync(require('path').join(process.argv[1], ${JSON.stringify(
        markerName,
      )}), 'ok')`,
      "{dir}",
    ],
  };
}

function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

describe("resolveCustomFormatters", () => {
  it("returns null for the built-in default (unset / true / false)", () => {
    assert.equal(resolveCustomFormatters(undefined), null);
    assert.equal(resolveCustomFormatters(true), null);
    assert.equal(resolveCustomFormatters(false), null);
  });

  it("wraps a single formatter command in an array", () => {
    const spec: FormatterCommand = { command: "prettier" };
    assert.deepEqual(resolveCustomFormatters(spec), [spec]);
  });

  it("passes an array of formatter commands through unchanged", () => {
    const specs: FormatterCommand[] = [
      { command: "ruff", args: ["check", "--fix", "{dir}"] },
      { command: "ruff", args: ["format", "{dir}"] },
    ];
    assert.deepEqual(resolveCustomFormatters(specs), specs);
  });
});

describe("substituteFormatterArgs", () => {
  it("substitutes {dir} and {testDir} placeholders", () => {
    assert.deepEqual(
      substituteFormatterArgs(["--write", "{dir}", "{testDir}"], {
        dir: "/out",
        testDir: "/out-test",
      }),
      ["--write", "/out", "/out-test"],
    );
  });

  it("drops args referencing {testDir} when no test dir exists", () => {
    assert.deepEqual(
      substituteFormatterArgs(["--write", "{dir}", "{testDir}"], {
        dir: "/out",
      }),
      ["--write", "/out"],
    );
  });
});

describe("runCustomFormatters", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "typra-fmt-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("executes the declared command with substituted args", () => {
    runCustomFormatters([markerWriter()], { dir });
    assert.ok(
      existsSync(join(dir, "marker.txt")),
      "custom formatter should have run against {dir}",
    );
  });

  it("runs every command in a multi-command spec", () => {
    runCustomFormatters([markerWriter("a.txt"), markerWriter("b.txt")], {
      dir,
    });
    assert.ok(existsSync(join(dir, "a.txt")));
    assert.ok(existsSync(join(dir, "b.txt")));
  });

  it("warns but does not throw when the formatter binary is missing", () => {
    const warnings = captureWarnings(() => {
      runCustomFormatters(
        [{ command: "typra-nonexistent-formatter-xyz", args: ["{dir}"] }],
        { dir },
      );
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /typra-nonexistent-formatter-xyz/);
  });

  it("warns on a pinned version the installed tool does not satisfy, but still runs", () => {
    const spec = markerWriter();
    const warnings = captureWarnings(() => {
      runCustomFormatters(
        [{ ...spec, version: "999.0.0", "version-args": ["--version"] }],
        { dir },
      );
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /does not satisfy pinned 999\.0\.0/);
    assert.ok(
      existsSync(join(dir, "marker.txt")),
      "version skew is non-fatal: the formatter should still run",
    );
  });

  it("does not warn when the installed version satisfies the pinned range", () => {
    const spec = markerWriter();
    const warnings = captureWarnings(() => {
      runCustomFormatters(
        [{ ...spec, version: ">=1.0.0", "version-args": ["--version"] }],
        { dir },
      );
    });
    assert.deepEqual(warnings, []);
    assert.ok(existsSync(join(dir, "marker.txt")));
  });

  it("matches an exact prerelease pin without stripping the prerelease tag", () => {
    // The tool reports a prerelease version; an exact prerelease pin must match.
    // Coercing the reported version would drop `-beta.1` and wrongly warn.
    const spec = markerWriter();
    const warnings = captureWarnings(() => {
      runCustomFormatters(
        [
          {
            ...spec,
            version: "1.2.3-beta.1",
            "version-args": [
              "-e",
              "process.stdout.write('formatter 1.2.3-beta.1')",
            ],
          },
        ],
        { dir },
      );
    });
    assert.deepEqual(
      warnings,
      [],
      "an exact prerelease pin that matches the reported version must not warn",
    );
    assert.ok(existsSync(join(dir, "marker.txt")));
  });
});
