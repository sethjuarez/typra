// Copyright (c) Microsoft. All rights reserved.

// Reproduce-before-fix guard for issue #262: a Go external-test file
// (`package <pkg>_test`) must keep importing the model package even when the
// package's declared name differs from its import path's last segment.
//
// Go binds an import to the imported package's *declared name*, not its path's
// last segment. So `package prompty` living under `.../model` is referenced as
// `prompty.` in call sites, while the bare import `"prompty/model"` leads
// goimports to guess the identifier is `model`, judge it unused, and prune it —
// breaking compilation with `undefined: prompty`. The emitter defends against
// this by emitting an explicit alias (`prompty "prompty/model"`) whenever the
// name and the path segment diverge.
//
// The deterministic emit assertion below fails on `main` (bare import) and
// passes on the fix. An executable variant, guarded on the go + goimports
// toolchain, proves the aliased import actually survives goimports and compiles.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function yamlString(value: string): string {
  return JSON.stringify(value);
}


function toolAvailable(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

const SPEC = [
  'import "@typra/emitter";',
  "",
  "namespace Prompty.Sdk;",
  "",
  "model Agent {",
  '  @sample(#{ name: "assistant" })',
  "  name: string;",
  "}",
  "",
].join("\n");

type Compiled = {
  root: string;
  goOut: string;
  goTestDir: string;
};

// Compile SPEC once with a Go target whose declared package name and import
// path's last segment diverge (package `prompty` under import path
// `prompty/model`). Returns the generated tree. Caller owns cleanup.
function compileDivergent(packageName: string, importPath: string): Compiled {
  const root = mkdtempSync(path.join(process.cwd(), "tmp-go-import-alias-"));
  const source = path.join(root, "main.tsp");
  const config = path.join(root, "tspconfig.yaml");
  const goOut = path.join(root, "generated", "model");
  const goTestDir = path.join(root, "generated", "model");
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  const tspCli = path.join(compilerRoot, "cmd", "tsp.js");

  writeFileSync(source, SPEC);
  writeFileSync(
    config,
    [
      "emit:",
      '  - "@typra/emitter"',
      "options:",
      '  "@typra/emitter":',
      `    emitter-output-dir: ${yamlString(path.join(root, "generated"))}`,
      '    root-object: "Prompty.Sdk.Agent"',
      '    root-namespace: "Prompty.Sdk"',
      "    emit-targets:",
      "      - type: Go",
      `        output-dir: ${yamlString(goOut)}`,
      `        test-dir: ${yamlString(goTestDir)}`,
      `        package-name: ${yamlString(packageName)}`,
      `        import-path: ${yamlString(importPath)}`,
      "        format: false",
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, [tspCli, "compile", source, "--config", config], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { root, goOut, goTestDir };
}

function readTestFile(dir: string): { name: string; content: string } {
  const entry = readdirSync(dir).find((f) => f.endsWith("_test.go"));
  assert.ok(entry, `expected a generated *_test.go under ${dir}`);
  return {
    name: entry,
    content: readFileSync(path.join(dir, entry), "utf8"),
  };
}

describe("Go external-test import survives name/path divergence (#262)", () => {
  it("aliases the model import when the package name differs from the path segment", () => {
    const compiled = compileDivergent("prompty", "prompty/model");
    try {
      const { content } = readTestFile(compiled.goTestDir);
      // The call sites qualify with the declared package name.
      assert.match(content, /\bprompty\./);
      // The import must be explicitly aliased so it binds to `prompty`.
      assert.match(content, /prompty "prompty\/model"/);
      assert.doesNotMatch(content, /^\t?"prompty\/model"$/m);
    } finally {
      rmSync(compiled.root, { recursive: true, force: true });
    }
  });

  it("leaves the import bare when the package name matches the path segment", () => {
    const compiled = compileDivergent("model", "prompty/model");
    try {
      const { content } = readTestFile(compiled.goTestDir);
      assert.match(content, /\t"prompty\/model"/);
      assert.doesNotMatch(content, /model "prompty\/model"/);
    } finally {
      rmSync(compiled.root, { recursive: true, force: true });
    }
  });

  it("compiles after goimports when name and path segment diverge", (t) => {
    if (!toolAvailable("go", ["version"])) {
      t.skip("go toolchain not available");
      return;
    }
    if (!toolAvailable("goimports", ["-h"])) {
      // goimports prints usage to stderr and exits non-zero for -h; probe via
      // a no-op format of an empty temp file instead.
      const probe = mkdtempSync(path.join(process.cwd(), "tmp-goimports-probe-"));
      try {
        writeFileSync(path.join(probe, "x.go"), "package x\n");
        execFileSync("goimports", ["-w", path.join(probe, "x.go")], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        rmSync(probe, { recursive: true, force: true });
        t.skip("goimports not available");
        return;
      }
      rmSync(probe, { recursive: true, force: true });
    }

    const compiled = compileDivergent("prompty", "prompty/model");
    try {
      // Assemble a module `prompty` whose model package lives under model/.
      const moduleDir = path.join(compiled.root, "module");
      const modelDir = path.join(moduleDir, "model");
      mkdirSync(modelDir, { recursive: true });
      writeFileSync(
        path.join(moduleDir, "go.mod"),
        [
          "module prompty",
          "",
          "go 1.22",
          "",
          "require gopkg.in/yaml.v3 v3.0.1",
          "",
        ].join("\n"),
      );

      // Resolve modules purely from the local cache — no network, no sumdb.
      const goEnv = {
        ...process.env,
        GOFLAGS: "-mod=mod",
        GOPROXY: "off",
        GOSUMDB: "off",
      };

      for (const f of readdirSync(compiled.goOut)) {
        if (f.endsWith(".go")) {
          writeFileSync(
            path.join(modelDir, f),
            readFileSync(path.join(compiled.goOut, f), "utf8"),
          );
        }
      }

      // goimports is the pruner that breaks the bare-import case. Run it exactly
      // as the emitter would; the surviving aliased import is the deterministic
      // regression lock. If the offline toolchain can't resolve modules here,
      // degrade to a skip rather than a false red — the first (toolchain-free)
      // test already locks the emitted alias. A genuine prune shows up as an
      // AssertionError, which is rethrown as a hard failure.
      try {
        execFileSync("goimports", ["-w", modelDir], {
          stdio: ["ignore", "pipe", "pipe"],
          env: goEnv,
        });

        const survived = readTestFile(modelDir).content;
        assert.match(
          survived,
          /prompty "prompty\/model"/,
          "goimports must not prune the aliased import",
        );

        execFileSync("go", ["build", "./..."], {
          cwd: moduleDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: goEnv,
        });
        execFileSync("go", ["vet", "./..."], {
          cwd: moduleDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: goEnv,
        });
      } catch (error) {
        if (error instanceof assert.AssertionError) {
          throw error;
        }
        const err = error as { stderr?: Buffer | string; stdout?: Buffer | string };
        const detail = `${err.stderr ?? ""}${err.stdout ?? ""}`;
        if (
          /no required module provides|missing go\.sum|GOPROXY|dial tcp|cannot find module|module lookup disabled/i.test(
            detail,
          )
        ) {
          t.skip(`go build unavailable offline: ${detail.trim()}`);
          return;
        }
        throw error;
      }
    } finally {
      rmSync(compiled.root, { recursive: true, force: true });
    }
  });
});
