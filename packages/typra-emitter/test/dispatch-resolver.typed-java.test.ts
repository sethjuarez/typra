// Copyright (c) Microsoft. All rights reserved.

// Executable proof that the Part III typed @dispatch resolver (issue #282) is a
// COMPILE-TIME contract in Java, not a runtime dictionary. We generate the
// committed `fixtures/dispatch-seam` spec for Java, then exercise the EMITTED
// provider interface + resolve switch (`RendererProvider` / `RendererResolver`)
// two ways:
//
//   * positive -> a class implementing every provider accessor routes each
//                 committed vector's discriminator through
//                 `RendererResolver.resolve`, selecting the typed Renderer impl
//                 that reproduces `expected` (javac + java)             => GREEN
//   * negative -> a class that OMITS one accessor fails to COMPILE: implementing
//                 `RendererProvider` obliges every method, so a missing slot is a
//                 javac error, never a silent skip                      => javac RED
//
// A green positive and a red (compile-error) negative together prove the
// resolver's completeness is enforced by the type system — the Java form of §5
// control 2. The positive run also exercises §5 control 1 (correct route
// reproduces `expected`) through idiomatic, statically-typed call sites.

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
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";
const PACKAGE = "typra.fixtures";

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

function collectJavaSources(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

// Consumer renderers: each understands only its own dialect's substitution
// braces (mustache `{{name}}`, jinja2 `{{ name }}`), so a wrong slot leaves the
// template unsubstituted.
const RENDERERS = [
  `package ${PACKAGE};`,
  "",
  "import java.util.Map;",
  "import java.util.regex.Matcher;",
  "import java.util.regex.Pattern;",
  "",
  "final class DialectRenderer implements Renderer {",
  "  private final Pattern pattern;",
  "  DialectRenderer(Pattern pattern) { this.pattern = pattern; }",
  "  public String render(Agent agent, Inputs inputs) {",
  "    Matcher m = pattern.matcher(agent.template.content);",
  "    StringBuilder sb = new StringBuilder();",
  "    while (m.find()) {",
  "      Object value = inputs.values.get(m.group(1));",
  "      m.appendReplacement(sb,",
  '          Matcher.quoteReplacement(value == null ? "" : String.valueOf(value)));',
  "    }",
  "    m.appendTail(sb);",
  "    return sb.toString();",
  "  }",
  "}",
  "",
].join("\n");

// FULL provider: every @dispatch slot attached (liquid explicitly null to model
// a valid-but-unimplemented variant).
const FULL_PROVIDER = [
  `package ${PACKAGE};`,
  "",
  "import java.util.regex.Pattern;",
  "",
  "public final class FullProvider implements RendererProvider {",
  '  public Renderer mustache() { return new DialectRenderer(Pattern.compile("\\\\{\\\\{(\\\\w+)\\\\}\\\\}")); }',
  '  public Renderer jinja2() { return new DialectRenderer(Pattern.compile("\\\\{\\\\{ (\\\\w+) \\\\}\\\\}")); }',
  "  public Renderer liquid() { return null; }",
  "}",
  "",
].join("\n");

// PARTIAL provider: DROPS the `mustache` accessor. `RendererProvider` still
// declares it, so this class cannot compile — the compile-time control.
const PARTIAL_PROVIDER = [
  `package ${PACKAGE};`,
  "",
  "import java.util.regex.Pattern;",
  "",
  "public final class PartialProvider implements RendererProvider {",
  '  public Renderer jinja2() { return new DialectRenderer(Pattern.compile("\\\\{\\\\{ (\\\\w+) \\\\}\\\\}")); }',
  "  public Renderer liquid() { return null; }",
  "}",
  "",
].join("\n");

// Proof driver: walk each committed vector's discriminator down the dispatch
// path on the TYPED Agent graph (agent.template.format.kind — the same `kind`
// the shape's own discriminator switch keys on), resolve the typed impl from the
// provider, invoke it, and assert the typed result reproduces `expected`.
const DISPATCH_PROOF = [
  `package ${PACKAGE};`,
  "",
  "import java.nio.file.Files;",
  "import java.nio.file.Path;",
  "import java.util.List;",
  "import java.util.Map;",
  "",
  "public final class DispatchProof {",
  "  private DispatchProof() {}",
  "  public static void run() throws Exception {",
  '    String json = Files.readString(Path.of(System.getenv("VECTORS")));',
  "    Object parsed = TypraJson.parse(json);",
  "    RendererProvider provider = new FullProvider();",
  "    List<?> vectors = (List<?>) parsed;",
  "    int failures = 0;",
  "    for (Object v : vectors) {",
  "      Map<?, ?> vec = (Map<?, ?>) v;",
  '      String name = String.valueOf(vec.get("name"));',
  '      Map<?, ?> input = (Map<?, ?>) vec.get("input");',
  '      Agent agent = Agent.load(input.get("agent"), null);',
  '      Inputs inputs = Inputs.load(input.get("inputs"), null);',
  "      String kind = agent.template.format.kind;",
  "      Renderer r = RendererResolver.resolve(kind, provider);",
  "      if (r == null) {",
  '        System.out.println("FAIL " + name + ": no impl attached for " + kind);',
  "        failures++;",
  "        continue;",
  "      }",
  "      String got = r.render(agent, inputs);",
  '      String expected = String.valueOf(vec.get("expected"));',
  "      if (!got.equals(expected)) {",
  "        System.out.println(",
  "            \"FAIL \" + name + \": got '\" + got + \"' expected '\" + expected + \"'\");",
  "        failures++;",
  "      } else {",
  '        System.out.println("PASS " + name);',
  "      }",
  "    }",
  '    if (failures > 0) throw new RuntimeException(failures + " vector(s) failed");',
  "  }",
  "}",
  "",
].join("\n");

const MAIN = [
  "public final class Main {",
  "  public static void main(String[] args) {",
  "    try {",
  "      typra.fixtures.DispatchProof.run();",
  '      System.out.println("SUITE OK");',
  "    } catch (Throwable t) {",
  '      System.out.println("SUITE FAILED: " + t.getMessage());',
  "      System.exit(1);",
  "    }",
  "  }",
  "}",
  "",
].join("\n");

type RunResult = { status: number; output: string };

describe("typed @dispatch resolver is a compile-time contract (Java)", () => {
  it("routes typed vectors green with a full provider; a missing accessor fails to compile", (t) => {
    if (!toolAvailable("javac") || !toolAvailable("java")) {
      t.skip("java toolchain not available");
      return;
    }

    const output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-typed-java-"));
    const emitRoot = path.join(output, "generated");
    const javaOut = path.join(emitRoot, "java");
    const javaTestDir = path.join(emitRoot, "java-tests");
    const config = path.join(output, "tspconfig.yaml");
    const compilerEntry = require.resolve("@typespec/compiler");
    const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
    const tspCli = path.join(compilerRoot, "cmd", "tsp.js");

    try {
      writeFileSync(
        config,
        [
          "emit:",
          '  - "@typra/emitter"',
          "options:",
          '  "@typra/emitter":',
          `    emitter-output-dir: ${yamlString(emitRoot)}`,
          `    root-object: ${yamlString(ROOT_OBJECT)}`,
          "    deterministic-output: true",
          "    emit-targets:",
          "      - type: Java",
          `        output-dir: ${yamlString(javaOut)}`,
          `        test-dir: ${yamlString(javaTestDir)}`,
          `        package-name: ${yamlString(PACKAGE)}`,
          '        native-serialization: "none"',
          "        format: false",
          "",
        ].join("\n"),
      );

      execFileSync(
        process.execPath,
        [tspCli, "compile", FIXTURE, "--config", config],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const providerSrc = readFileSync(
        path.join(javaOut, "RendererProvider.java"),
        "utf8",
      );
      const resolverSrc = readFileSync(
        path.join(javaOut, "RendererResolver.java"),
        "utf8",
      );

      // -- rendered-code lock: the emitted resolver is the twin of the shape ----
      // discriminator switch — a provider interface with one accessor per variant
      // plus a switch that throws on an unknown discriminator.
      assert.match(providerSrc, /public interface RendererProvider \{/);
      assert.match(providerSrc, /Renderer mustache\(\);/);
      assert.match(providerSrc, /Renderer jinja2\(\);/);
      assert.match(providerSrc, /Renderer liquid\(\);/);
      assert.match(
        resolverSrc,
        /public static Renderer resolve\(String kind, RendererProvider registry\)/,
      );
      assert.match(resolverSrc, /case "mustache":/);
      // Closed dispatch: an unknown discriminator is a hard error, never null.
      assert.match(resolverSrc, /throw new IllegalArgumentException\(/);

      const modelSources = collectJavaSources(javaOut);
      const srcDir = path.join(output, "src");
      const classesDir = path.join(output, "classes");
      mkdirSync(srcDir, { recursive: true });

      const renderersPath = path.join(srcDir, "DialectRenderer.java");
      const fullProviderPath = path.join(srcDir, "FullProvider.java");
      const partialProviderPath = path.join(srcDir, "PartialProvider.java");
      const proofPath = path.join(srcDir, "DispatchProof.java");
      const mainPath = path.join(srcDir, "Main.java");
      writeFileSync(renderersPath, RENDERERS);
      writeFileSync(fullProviderPath, FULL_PROVIDER);
      writeFileSync(proofPath, DISPATCH_PROOF);
      writeFileSync(mainPath, MAIN);

      const compile = (sources: string[]): RunResult => {
        rmSync(classesDir, { recursive: true, force: true });
        mkdirSync(classesDir, { recursive: true });
        try {
          execFileSync("javac", ["-d", classesDir, ...sources], {
            cwd: output,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { status: 0, output: "" };
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string };
          return { status: 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
        }
      };

      // -- compile-time control (§5 control 2) --------------------------------
      // Dropping the `mustache` accessor must fail to compile: implementing
      // RendererProvider obliges every method.
      writeFileSync(partialProviderPath, PARTIAL_PROVIDER);
      const partial = compile([...modelSources, partialProviderPath]);
      assert.notEqual(
        partial.status,
        0,
        "dropping the mustache accessor must fail to compile",
      );
      assert.match(
        partial.output,
        /mustache/,
        `javac must name the missing accessor, got:\n${partial.output}`,
      );

      // -- positive control: full provider compiles + routes green -------------
      const positiveSources = [
        ...modelSources,
        renderersPath,
        fullProviderPath,
        proofPath,
        mainPath,
      ];
      const built = compile(positiveSources);
      assert.equal(
        built.status,
        0,
        `full provider must compile:\n${built.output}`,
      );

      const snapshot = JSON.parse(
        readFileSync(
          path.join(emitRoot, ".typra-generated", "vectors.json"),
          "utf8",
        ),
      ) as { vectors: { vector: Record<string, unknown> }[] };
      const vectors = snapshot.vectors
        .map((entry) => entry.vector)
        .filter((vector) => typeof vector.expected === "string");
      assert.ok(vectors.length >= 2, "fixture must carry routed vectors");
      const vectorsFile = path.join(output, "vectors-data.json");
      writeFileSync(vectorsFile, JSON.stringify(vectors));

      let runOut: RunResult;
      try {
        const out = execFileSync("java", ["-cp", classesDir, "Main"], {
          cwd: output,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, VECTORS: vectorsFile },
        });
        runOut = { status: 0, output: out };
      } catch (error) {
        const err = error as {
          status?: number;
          stdout?: string;
          stderr?: string;
        };
        runOut = {
          status: err.status ?? 1,
          output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
        };
      }

      // -- runtime positive control (§5 control 1) ----------------------------
      assert.equal(
        runOut.status,
        0,
        `typed routing must reproduce every vector's expected, got:\n${runOut.output}`,
      );
      assert.match(runOut.output, /SUITE OK/);
      for (const vector of vectors) {
        assert.match(runOut.output, new RegExp(`PASS ${vector.name as string}`));
      }
      assert.doesNotMatch(runOut.output, /FAIL /);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
