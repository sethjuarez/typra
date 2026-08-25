// Copyright (c) Microsoft. All rights reserved.

// Executable proof that @vector behavioral conformance is an ENFORCED tier for
// the Java target, not a tautology. We compile one spec (Echo/Sum/Note) once,
// then replay the generated conformance suite against three runtime adapter
// registries:
//
//   1. reference   -> every vector implemented           => GREEN
//   2. waived      -> one operation missing but waived    => GREEN, visible skip
//   3. incomplete  -> one operation missing, NO waiver    => RED (hard failure)
//
// If the loop were open (comparing vector data to itself), scenarios 2 and 3
// could never diverge from scenario 1. They do, so the loop is closed.
//
// The target is emitted with native-serialization "none": the harness drives the
// built-in JSON value model (TypraJson/TypraMaps), so it must emit and pass
// regardless of serialization backend. This doubles as the #259 regression lock —
// on the pre-fix emitter the harness was gated on Jackson and never emitted here.

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

function toolAvailable(tool: string): boolean {
  try {
    execFileSync(tool, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

// Recursively collect every .java file under a root (the emitted model/runtime
// tree, which includes the built-in TypraJson/TypraMaps the harness depends on).
function collectJavaSources(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

const BIG_TEXT = "x".repeat(70000);

const SPEC = [
  'import "@typra/emitter";',
  "",
  "namespace Typra.Proof;",
  "",
  "model Root {",
  "  id: string;",
  "}",
  "",
  "const EchoVectors = #[",
  '  #{ name: "shout", input: #{ payload: "hi" }, expected: "HI" },',
  '  #{ name: "empty", input: #{ payload: "" }, expectedError: #{ code: "empty" } }',
  "];",
  "",
  "const SumVectors = #[",
  '  #{ name: "basic", input: #{ values: #[1, 2, 3] }, expected: 6 }',
  "];",
  "",
  "const NoteVectors = #[",
  '  #{ name: "bidi", input: #{ text: "a\u202eb" }, expected: "a\u202eb!" },',
  `  #{ name: "big", input: #{ text: "${BIG_TEXT}" }, expected: "${BIG_TEXT}!" }`,
  "];",
  "",
  "interface Echo {",
  "  @vector(EchoVectors)",
  "  echo(payload: string): string;",
  "}",
  "",
  "interface Sum {",
  "  @vector(SumVectors)",
  "  sum(values: int32[]): int32;",
  "}",
  "",
  "interface Note {",
  "  @vector(NoteVectors)",
  "  note(text: string): string;",
  "}",
  "",
].join("\n");

const ADAPTER_CLASS = "typra.proof.adapters.VectorAdapters";

// -- runtime adapter registry authored the way a downstream runtime would ------

const JAVA_INVOKES = [
  "  private static Object field(Object value, String key) {",
  "    return value instanceof Map<?, ?> map ? map.get(key) : null;",
  "  }",
  "",
  "  // Async adapter: returns a CompletableFuture the harness joins. Proves the",
  "  // await-if-awaitable seam, including the failed-future error path.",
  "  private static java.util.concurrent.CompletableFuture<Object> echoInvoke(",
  "      Object input, VectorContext ctx) {",
  '    Object raw = field(input, "payload");',
  '    String payload = raw instanceof String s ? s : "";',
  "    if (payload.isEmpty()) {",
  "      Map<String, Object> err = new LinkedHashMap<>();",
  '      err.put("code", "empty");',
  "      return java.util.concurrent.CompletableFuture.failedFuture(",
  '          new VectorException("empty", err));',
  "    }",
  "    return java.util.concurrent.CompletableFuture.completedFuture(",
  "        payload.toUpperCase(Locale.ROOT));",
  "  }",
  "",
  "  private static Object noteInvoke(Object input, VectorContext ctx) {",
  '    Object raw = field(input, "text");',
  '    return (raw instanceof String s ? s : "") + "!";',
  "  }",
  "",
  "  private static Object sumInvoke(Object input, VectorContext ctx) {",
  "    long total = 0;",
  '    Object values = field(input, "values");',
  "    if (values instanceof List<?> list) {",
  "      for (Object v : list) {",
  "        if (v instanceof Number n) { total += n.longValue(); }",
  "      }",
  "    }",
  "    return total;",
  "  }",
  "",
];

function javaAdapter(
  registrations: string[],
  waiverEntries: string[],
): string {
  return [
    "package typra.proof.adapters;",
    "",
    "import java.util.ArrayList;",
    "import java.util.HashMap;",
    "import java.util.LinkedHashMap;",
    "import java.util.List;",
    "import java.util.Locale;",
    "import java.util.Map;",
    "import typra.proof.VectorRunner.VectorAdapter;",
    "import typra.proof.VectorRunner.VectorContext;",
    "import typra.proof.VectorRunner.VectorException;",
    "",
    "public final class VectorAdapters {",
    "  private VectorAdapters() { }",
    "",
    ...JAVA_INVOKES,
    "  public static Map<String, VectorAdapter> adapters() {",
    "    Map<String, VectorAdapter> m = new HashMap<>();",
    ...registrations,
    "    return m;",
    "  }",
    "",
    "  public static Map<String, String> waivers() {",
    "    Map<String, String> w = new HashMap<>();",
    ...waiverEntries,
    "    return w;",
    "  }",
    "",
    "  public static Object doubles() { return new LinkedHashMap<String, Object>(); }",
    "}",
    "",
  ].join("\n");
}

function javaReferenceAdapter(): string {
  return javaAdapter(
    [
      '    m.put("Echo.echo", new VectorAdapter(VectorAdapters::echoInvoke));',
      '    m.put("Sum.sum", new VectorAdapter(VectorAdapters::sumInvoke));',
      '    m.put("Note.note", new VectorAdapter(VectorAdapters::noteInvoke));',
    ],
    [],
  );
}

// Echo and Note only. Sum.sum is deliberately unimplemented.
function javaEchoOnlyAdapter(waiverEntries: string[]): string {
  return javaAdapter(
    [
      '    m.put("Echo.echo", new VectorAdapter(VectorAdapters::echoInvoke));',
      '    m.put("Note.note", new VectorAdapter(VectorAdapters::noteInvoke));',
    ],
    waiverEntries,
  );
}

type RunResult = { status: number; output: string };

describe("@vector conformance is an enforced closed loop (Java)", () => {
  it("goes green with a reference adapter, skips with a waiver, and fails hard without one", (t) => {
    if (!toolAvailable("javac") || !toolAvailable("java")) {
      t.skip("java toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(process.cwd(), "tmp-vector-java-loop-"));
    const source = path.join(output, "main.tsp");
    const config = path.join(output, "tspconfig.yaml");
    const javaOut = path.join(output, "generated", "java");
    const javaTestDir = path.join(output, "generated", "java-tests");
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
          '    root-object: "Typra.Proof.Root"',
          '    root-namespace: "Typra.Proof"',
          "    emit-targets:",
          "      - type: Java",
          `        output-dir: ${yamlString(javaOut)}`,
          `        test-dir: ${yamlString(javaTestDir)}`,
          '        package-name: "typra.proof"',
          '        native-serialization: "none"',
          `        vector-adapter-path: ${yamlString(ADAPTER_CLASS)}`,
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", source, "--config", config],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      // Sanity: the generated suite must invoke a runtime adapter registry.
      const javaSuite = readFileSync(
        path.join(javaTestDir, "VectorConformanceTests.java"),
        "utf8",
      );
      // The interpreter (adapter lookup, invocation, classification) now lives in
      // the sibling VectorRunner module; the thin harness only builds payloads and
      // injects the seam. Sanity-check each concern against the file that owns it.
      const javaRunner = readFileSync(
        path.join(javaTestDir, "VectorRunner.java"),
        "utf8",
      );
      assert.match(javaSuite, /package typra\.proof;/);
      assert.match(javaSuite, /typra\.proof\.adapters\.VectorAdapters\.adapters\(\)/);
      assert.match(javaRunner, /No vector adapter registered for/);
      assert.match(javaRunner, /Object apply\(Object input, VectorContext ctx\)/);
      assert.match(javaRunner, /invokeAdapter\(adapter, input, ctx, sync, vectorId\)/);
      // #259 regression lock: the harness must be serialization-agnostic — no
      // Jackson types — since it is emitted for the native (none) backend too.
      assert.doesNotMatch(javaSuite, /com\.fasterxml\.jackson/);
      assert.match(javaSuite, /TypraJson\.parse\(/);
      // The bidi control (U+202E) is embedded as an ASCII JSON escape, never raw.
      assert.match(javaSuite, /\\\\u202e/);
      assert.doesNotMatch(javaSuite, /\u202e/);
      // Each vector is emitted as its own straight-line method that inlines only its
      // own data (mirroring the model/sample tests) — no monolithic embedded payload.
      assert.doesNotMatch(javaSuite, /private static String buildPayload\(\)/);
      assert.match(
        javaSuite,
        /private static void vector\d+\w*\(\) throws Exception/,
      );
      assert.match(
        javaSuite,
        /VectorRunner\.runVector\("[^"]*", "[^"]*", vector, (?:true|false), seam\(\)\)/,
      );
      // The "big" vector alone exceeds the 64 KiB constant-pool limit, so its own
      // literal must be assembled from multiple runtime-concatenated chunks.
      assert.ok(
        (javaSuite.match(/sb\.append\(/g) ?? []).length >= 2,
        "the oversized vector should split into multiple appended chunks",
      );

      // Assemble a self-contained source tree: the emitted model/runtime files
      // (which carry the built-in TypraJson/TypraMaps the harness depends on),
      // the generated harness, the runtime adapter, and a tiny Main that drives
      // run(). No external classpath is needed for the native (none) backend.
      const modelSources = collectJavaSources(javaOut);
      const srcDir = path.join(output, "src");
      const classesDir = path.join(output, "classes");
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(classesDir, { recursive: true });
      const harnessPath = path.join(javaTestDir, "VectorConformanceTests.java");
      const runnerPath = path.join(javaTestDir, "VectorRunner.java");
      writeFileSync(
        path.join(srcDir, "Main.java"),
        [
          "public final class Main {",
          "  public static void main(String[] args) {",
          "    try {",
          "      typra.proof.VectorConformanceTests.run();",
          '      System.out.println("SUITE OK");',
          "    } catch (Throwable t) {",
          '      System.out.println("SUITE FAILED: " + t.getMessage());',
          "      System.exit(1);",
          "    }",
          "  }",
          "}",
          "",
        ].join("\n"),
      );

      const adapterPath = path.join(srcDir, "VectorAdapters.java");

      const run = (adapterSrc: string): RunResult => {
        writeFileSync(adapterPath, adapterSrc);
        rmSync(classesDir, { recursive: true, force: true });
        mkdirSync(classesDir, { recursive: true });
        const sources = [
          ...modelSources,
          runnerPath,
          harnessPath,
          adapterPath,
          path.join(srcDir, "Main.java"),
        ];
        try {
          execFileSync(
            "javac",
            ["-Xlint:all", "-Werror", "-d", classesDir, ...sources],
            { cwd: output, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string };
          return {
            status: 1,
            output: `javac failed:\n${err.stdout ?? ""}${err.stderr ?? ""}`,
          };
        }
        try {
          const out = execFileSync(
            "java",
            ["-cp", classesDir, "Main"],
            { cwd: output, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
          return { status: 0, output: out };
        } catch (error) {
          const err = error as { status?: number; stdout?: string; stderr?: string };
          return {
            status: err.status ?? 1,
            output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
          };
        }
      };

      // -- scenario 1: reference adapter => everything green --------------------
      const green = run(javaReferenceAdapter());
      assert.equal(green.status, 0, `reference Java suite should pass:\n${green.output}`);
      assert.match(green.output, /SUITE OK/);
      assert.match(green.output, /PASS Echo\.echo:shout/);
      assert.match(green.output, /PASS Sum\.sum:basic/);
      assert.match(green.output, /PASS Note\.note:bidi/);
      assert.match(green.output, /PASS Note\.note:big/);
      assert.doesNotMatch(green.output, /FAIL /);
      assert.doesNotMatch(green.output, /SKIP /);

      // -- scenario 2: Sum.sum unimplemented but explicitly waived => pass ------
      const waived = run(
        javaEchoOnlyAdapter(['    w.put("Sum.sum", "runtime pending");']),
      );
      assert.equal(waived.status, 0, `waived Java suite should pass:\n${waived.output}`);
      assert.match(waived.output, /SUITE OK/);
      assert.match(waived.output, /SKIP Sum\.sum:basic \(waived: runtime pending\)/);
      assert.doesNotMatch(waived.output, /FAIL /);

      // -- scenario 3: Sum.sum unimplemented, NO waiver => hard failure ---------
      const red = run(javaEchoOnlyAdapter([]));
      assert.notEqual(red.status, 0, `unwaived Java suite must fail:\n${red.output}`);
      assert.match(red.output, /SUITE FAILED/);
      assert.match(red.output, /FAIL Sum\.sum:basic: No vector adapter registered for Sum\.sum/);
      assert.doesNotMatch(red.output, /SKIP Sum\.sum/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
