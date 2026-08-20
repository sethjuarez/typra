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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
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

const JACKSON_VERSION = "2.17.2";
const JACKSON_ARTIFACTS = [
  "jackson-annotations",
  "jackson-core",
  "jackson-databind",
];

// Resolve the Jackson runtime the way validate-fixtures does, but cached in a
// stable location so repeated local runs reuse the jars. Returns null offline.
function jacksonClasspath(): string | null {
  const cacheDir = path.join(os.tmpdir(), "typra-jackson-cache");
  mkdirSync(cacheDir, { recursive: true });
  const jars: string[] = [];
  for (const artifact of JACKSON_ARTIFACTS) {
    const jar = path.join(cacheDir, `${artifact}-${JACKSON_VERSION}.jar`);
    jars.push(jar);
    if (existsSync(jar)) continue;
    const url =
      `https://repo1.maven.org/maven2/com/fasterxml/jackson/core/` +
      `${artifact}/${JACKSON_VERSION}/${artifact}-${JACKSON_VERSION}.jar`;
    try {
      execFileSync("curl", ["-fsSL", url, "-o", jar], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return null;
    }
  }
  return jars.join(path.delimiter);
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
  "  // Async adapter: returns a CompletableFuture the harness joins. Proves the",
  "  // await-if-awaitable seam, including the failed-future error path.",
  "  private static java.util.concurrent.CompletableFuture<JsonNode> echoInvoke(",
  "      JsonNode input, VectorContext ctx) {",
  '    String payload = input.path("payload").asText("");',
  "    if (payload.isEmpty()) {",
  '      return java.util.concurrent.CompletableFuture.failedFuture(',
  '          new VectorException("empty", NF.objectNode().put("code", "empty")));',
  "    }",
  "    return java.util.concurrent.CompletableFuture.completedFuture(",
  "        NF.textNode(payload.toUpperCase(Locale.ROOT)));",
  "  }",
  "",
  "  private static JsonNode noteInvoke(JsonNode input, VectorContext ctx) {",
  '    return NF.textNode(input.path("text").asText("") + "!");',
  "  }",
  "",
  "  private static JsonNode sumInvoke(JsonNode input, VectorContext ctx) {",
  "    long total = 0;",
  '    for (JsonNode v : input.path("values")) { total += v.asLong(); }',
  "    return NF.numberNode(total);",
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
    "import com.fasterxml.jackson.databind.JsonNode;",
    "import com.fasterxml.jackson.databind.node.JsonNodeFactory;",
    "import java.util.HashMap;",
    "import java.util.Locale;",
    "import java.util.Map;",
    "import typra.proof.VectorConformanceTests.VectorAdapter;",
    "import typra.proof.VectorConformanceTests.VectorContext;",
    "import typra.proof.VectorConformanceTests.VectorException;",
    "",
    "public final class VectorAdapters {",
    "  private VectorAdapters() { }",
    "  private static final JsonNodeFactory NF = JsonNodeFactory.instance;",
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
    "  public static JsonNode doubles() { return NF.objectNode(); }",
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
    const classpath = jacksonClasspath();
    if (!classpath) {
      t.skip("jackson runtime unavailable (offline)");
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
          '        native-serialization: "jackson"',
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
      assert.match(javaSuite, /package typra\.proof;/);
      assert.match(javaSuite, /typra\.proof\.adapters\.VectorAdapters\.adapters\(\)/);
      assert.match(javaSuite, /No vector adapter registered for/);
      assert.match(javaSuite, /Object apply\(JsonNode input, VectorContext ctx\)/);
      assert.match(javaSuite, /invokeAdapter\(adapter, input, ctx, sync, vectorId\)/);
      // The bidi control (U+202E) is embedded as an ASCII JSON escape, never raw.
      assert.match(javaSuite, /\\\\u202e/);
      assert.doesNotMatch(javaSuite, /\u202e/);
      // The payload exceeds the 64 KiB constant-pool limit, so it must be assembled
      // from multiple runtime-concatenated chunks rather than one string literal.
      assert.match(javaSuite, /private static String buildPayload\(\)/);
      assert.ok(
        (javaSuite.match(/sb\.append\(/g) ?? []).length >= 2,
        "large payload should split into multiple appended chunks",
      );

      // Assemble a self-contained source tree: the generated harness, the runtime
      // adapter, and a tiny Main that drives run().
      const srcDir = path.join(output, "src");
      const harnessDir = path.join(srcDir, "typra", "proof");
      const adapterDir = path.join(harnessDir, "adapters");
      const classesDir = path.join(output, "classes");
      mkdirSync(adapterDir, { recursive: true });
      mkdirSync(classesDir, { recursive: true });
      writeFileSync(
        path.join(harnessDir, "VectorConformanceTests.java"),
        javaSuite,
      );
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

      const adapterPath = path.join(adapterDir, "VectorAdapters.java");

      const run = (adapterSrc: string): RunResult => {
        writeFileSync(adapterPath, adapterSrc);
        rmSync(classesDir, { recursive: true, force: true });
        mkdirSync(classesDir, { recursive: true });
        const sources = [
          path.join(harnessDir, "VectorConformanceTests.java"),
          adapterPath,
          path.join(srcDir, "Main.java"),
        ];
        try {
          execFileSync(
            "javac",
            ["-cp", classpath, "-Xlint:all", "-Werror", "-d", classesDir, ...sources],
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
            ["-cp", `${classesDir}${path.delimiter}${classpath}`, "Main"],
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
