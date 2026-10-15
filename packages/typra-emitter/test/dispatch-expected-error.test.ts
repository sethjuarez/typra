import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { generate } from "../src/generate.js";

// Regression: `expectedError` on a TYPED per-interface @dispatch vector.
//
// The typed @dispatch rail used to reject any dispatched vector carrying
// `expectedError` ("has no typed assertion arm (would assert success)"), so a
// seam whose contract includes a failure case could not ride the typed rail at
// all. The committed `dispatch-seam` fixture now carries `mustache-unbound` — a
// mustache render referencing a binding the inputs omit, with
// `expectedError: "unbound variable: missing"`. Every runtime target must emit an
// ERROR arm for it: resolve through the typed resolver (a missing route still
// fails), invoke the seam, and assert it threw / returned an error whose message
// contains the expected substring — never the success assertion.

const FIXTURE = path.resolve(
  process.cwd(),
  "fixtures",
  "dispatch-seam",
  "main.tsp",
);
const ROOT_OBJECT = "Typra.Fixtures.DispatchSeam.Root";
const MESSAGE = "unbound variable: missing";

type Target =
  | "typescript"
  | "python"
  | "go"
  | "csharp"
  | "java"
  | "rust"
  | "swift";

// For each target: the conformance file, how to slice out the error vector's
// test body, the error-arm needles, and the success-arm needles that must NOT
// appear inside that body.
const CASES: Array<{
  target: Target;
  file: string;
  start: RegExp;
  end: RegExp;
  mustInclude: string[];
  mustExclude: string[];
}> = [
  {
    target: "typescript",
    file: "renderer.conformance.test.ts",
    start: /it\("mustache-unbound"/,
    end: /\n {2}\}\);/,
    mustInclude: [
      "const impl = resolveRenderer(kind, rendererProvider);",
      "expect(impl).not.toBeNull();",
      "await impl!.render(agent, inputs);",
      "} catch (error) {",
      "expect(caught).toBeDefined();",
      `expect(message).toContain(${JSON.stringify(MESSAGE)});`,
    ],
    mustExclude: ["const result =", "toEqual("],
  },
  {
    target: "python",
    file: "test_renderer_conformance.py",
    start: /def test_mustache_unbound\(/,
    end: /\n\n\ndef |$/,
    mustInclude: [
      "impl = resolve_renderer(kind, renderer_provider)",
      "assert impl is not None",
      "        result = impl.render(agent, inputs)",
      "    try:",
      "    except Exception as error:  # noqa: BLE001",
      "    assert caught is not None",
      `assert ${JSON.stringify(MESSAGE)} in str(`,
    ],
    mustExclude: ["assert result =="],
  },
  {
    target: "go",
    file: "renderer_conformance_test.go",
    start: /func TestRenderer\w*MustacheUnbound\w*\(/,
    end: /\n\}\n(\n|$)/,
    mustInclude: [
      "impl, err := fixtures.ResolveRenderer(",
      "if impl == nil {",
      "_, err = impl.Render(agent, inputs)",
      "if err == nil {",
      `if !strings.Contains(err.Error(), ${JSON.stringify(MESSAGE)}) {`,
    ],
    mustExclude: ["actual, err :=", "misrouted"],
  },
  {
    target: "csharp",
    file: "RendererConformanceTests.cs",
    start: /public async Task \w*MustacheUnbound\w*\(\)/,
    end: /\n {4}\}\n\n/,
    mustInclude: [
      "var impl = RendererResolver.Resolve(kind, Provider());",
      "Assert.NotNull(impl);",
      "await impl!.RenderAsync(agent!, inputs!);",
      "catch (Exception error)",
      "Assert.NotNull(caught);",
      `Assert.Contains(${JSON.stringify(MESSAGE)}, caught!.Message);`,
    ],
    mustExclude: ["var actual =", "Assert.Equal("],
  },
  {
    target: "java",
    file: "RendererConformanceTests.java",
    start: /private static void \w*[Mm]ustache_?[Uu]nbound\w*\(\)/,
    end: /\n {2}\}\n/,
    mustInclude: [
      "Renderer impl = RendererResolver.resolve(kind,",
      "if (impl == null) throw new AssertionError(",
      "impl.render(agent, inputs);",
      "} catch (Throwable error) {",
      "if (caught == null) throw new AssertionError(",
      `String.valueOf(caught.getMessage()).contains(${JSON.stringify(MESSAGE)})`,
    ],
    mustExclude: ["Object actual =", "assertEquals("],
  },
  {
    target: "rust",
    file: "renderer_conformance_test.rs",
    start: /fn \w*mustache_unbound\w*\(\)/,
    end: /\n\}\n(\n|$)/,
    mustInclude: [
      "let seam_impl = renderer_resolver::resolve(&kind, &provider)",
      "let result = seam_impl.render(&agent, &inputs).await;",
      "assert!(result.is_err()",
      `assert!(message.contains(${JSON.stringify(MESSAGE)})`,
    ],
    mustExclude: ["let actual =", "assert_eq!(", '.expect("seam invocation")'],
  },
  {
    target: "swift",
    file: "RendererConformanceTests.swift",
    start: /func \w*[Mm]ustache_?[Uu]nbound\w*\(\)/,
    end: /\n {2}\}\n/,
    mustInclude: [
      "guard let impl = try RendererResolver.resolve(",
      "_ = try await impl.render(agent: agent, inputs: inputs)",
      "    do {",
      "    } catch {",
      "guard let caughtError = caught else {",
      `String(describing: caughtError).contains(${JSON.stringify(MESSAGE)})`,
    ],
    mustExclude: ["let actual =", "XCTAssertEqual("],
  },
];

function sliceBody(src: string, start: RegExp, end: RegExp): string {
  const match = start.exec(src);
  assert.ok(match, `could not find ${start} in:\n${src}`);
  const rest = src.slice(match.index);
  const after = rest.slice(match[0].length);
  const stop = end.exec(after);
  return stop ? rest.slice(0, match[0].length + stop.index) : rest;
}

describe("typed @dispatch conformance emits an expectedError arm (every runtime)", () => {
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;

  before(async () => {
    output = mkdtempSync(path.join(tmpdir(), "typra-dispatch-expected-error-"));
    result = await generate({
      output,
      source: FIXTURE,
      rootObject: ROOT_OBJECT,
      targets: CASES.map((entry) => entry.target),
      format: false,
      generateTests: true,
      deterministic: true,
    });
  });

  after(() => {
    rmSync(output, { recursive: true, force: true });
  });

  it("emits across every target (expectedError no longer rejected by the typed rail)", () => {
    assert.equal(
      result.success,
      true,
      `emit must succeed for a dispatched expectedError vector, got: ${result.errors?.join(
        "\n",
      )}`,
    );
  });

  for (const entry of CASES) {
    it(`${entry.target}: mustache-unbound asserts the error, not success`, () => {
      const src = readFileSync(
        path.join(output, entry.target, "tests", entry.file),
        "utf8",
      );
      const body = sliceBody(src, entry.start, entry.end);
      if (entry.target === "typescript") {
        assert.ok(
          src.includes(
            `    expect(message).toContain(${JSON.stringify(MESSAGE)});\n  });`,
          ),
          "unformatted TypeScript expectedError test must close with the exact emitted text `  });`",
        );
      }
      for (const needle of entry.mustInclude) {
        assert.ok(
          body.includes(needle),
          `${entry.target} error arm must include ${JSON.stringify(
            needle,
          )}\n--- body ---\n${body}`,
        );
      }
      for (const needle of entry.mustExclude) {
        assert.ok(
          !body.includes(needle),
          `${entry.target} error arm must NOT include success assertion ${JSON.stringify(
            needle,
          )}\n--- body ---\n${body}`,
        );
      }
      // The resolver/null check must precede the invocation so a missing route
      // fails the test rather than satisfying the expected error.
      const resolveAt = body.indexOf(entry.mustInclude[0]);
      const invokeAt = body.indexOf(entry.mustInclude[2]);
      assert.ok(
        resolveAt >= 0 && invokeAt > resolveAt,
        `${entry.target}: resolve must precede the seam invocation`,
      );
    });
  }
});
