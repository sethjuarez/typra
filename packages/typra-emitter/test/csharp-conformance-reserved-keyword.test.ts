import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";

import { generate } from "../src/generate.js";

// Regression (prompty#511 static-target sweep): the typed @vector conformance
// emitter decoded each seam-op param into a C# LOCAL named VERBATIM after the
// spec parameter (`var <paramName> = <Model>.FromJson(...)`). When a seam op's
// param is a C# reserved word — e.g. prompty's `DiscoveryConformance.enrich`
// takes `base: ModelInfo` — that emits `var base = ModelInfo.FromJson(...)`,
// which is a C# CS1041 compile error (`base` is a keyword). The fix routes
// every C# local through `csharpIdentifier`, which escapes reserved words as a
// verbatim identifier (`@base`); the JSON key / wire lookup stays raw.
//
// This suite renders a plain (undispatched) seam whose model param is named
// `base` and asserts the emitted C# conformance entrypoint never emits a bare
// `var base` (or any other bare `var <keyword>`), and that the escaped form is
// used instead. Red-first: on the pre-fix emitter the entrypoint contains
// `var base = Note.FromJson(...)` and the C# vector-conformance-compile gate
// fails; the fix makes it `var @base` and compile.

const SPEC = `import "@typra/emitter";
namespace Typra.Fixtures.Test.ReservedKeywordParam;

@doc("A note that crosses the seam boundary; persisted as part of Root.")
model Note {
  @doc("Short heading.")
  title: string;

  @doc("Free-form content.")
  body: string;
}

@doc("Plain seam whose op param is a C# reserved word: base.")
interface Keyworder {
  @vector(#{
    name: "passthrough",
    stage: "callable",
    input: #{ base: #{ title: "t", body: "b" } },
    expected: #{ title: "t", body: "b" },
  })
  @doc("Echo the note; the param name base is a C# reserved keyword.")
  keyword(base: Note): Note;
}

@serializable
@doc("Fixture root that puts Note in the serialization closure.")
model Root {
  @doc("A note the Keyworder seam echoes; puts Note in the closure.")
  note: Note;
}
`;

// A small, high-signal slice of the C# reserved-word set that also appears as
// plausible spec parameter names.
const CSHARP_KEYWORDS = ["base", "class", "object", "string", "params", "ref"];

describe("C# typed @vector conformance escapes reserved-word seam params (prompty#511)", () => {
  let specDir: string;
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;

  before(async () => {
    // The temp spec must live under the package root so `import "@typra/emitter"`
    // resolves against this package's own node_modules link.
    specDir = mkdtempSync(path.join(process.cwd(), ".tmp-reserved-kw-"));
    output = mkdtempSync(path.join(process.cwd(), ".tmp-reserved-kw-out-"));
    writeFileSync(path.join(specDir, "main.tsp"), SPEC, "utf8");
    result = await generate({
      output,
      source: path.join(specDir, "main.tsp"),
      rootObject: "Typra.Fixtures.Test.ReservedKeywordParam.Root",
      targets: ["csharp"],
      format: false,
      generateTests: true,
      deterministic: true,
    });
  });

  after(() => {
    for (const dir of [specDir, output]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits C# successfully for a seam whose param is a reserved word", () => {
    assert.equal(
      result.success,
      true,
      `emit must succeed with a reserved-word seam param, got: ${result.errors?.join(
        "\n",
      )}`,
    );
  });

  it("conformance entrypoint escapes `base` as `@base`, never a bare `var base`", () => {
    const conformance = path.join(output, "csharp", "VectorConformance.cs");
    assert.ok(
      existsSync(conformance),
      "expected the typed conformance entrypoint VectorConformance.cs to be emitted",
    );
    const src = readFileSync(conformance, "utf8");

    // The exact token that fails to compile (`base` is a C# keyword, so
    // `var base` is CS1041). It must never survive into the emitted C#.
    assert.doesNotMatch(
      src,
      /\bvar base\b/,
      `VectorConformance.cs must not declare a bare \`var base\` local:\n${src}`,
    );
    // The corrected escaped declaration + usage.
    assert.match(
      src,
      /var @base = Note\.FromJson\(/,
      `VectorConformance.cs must escape the reserved param as \`@base\`:\n${src}`,
    );
    assert.match(
      src,
      /seam\.KeywordAsync\(@base\)/,
      `VectorConformance.cs must pass the escaped \`@base\` to the seam call:\n${src}`,
    );
  });

  it("no emitted C# file declares a bare `var <reserved-keyword>` local", () => {
    const csharpRoot = path.join(output, "csharp");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".cs")) continue;
        const src = readFileSync(full, "utf8");
        for (const keyword of CSHARP_KEYWORDS) {
          // A local declaration `var <keyword> =` (not the `: base(...)` ctor
          // chain, which is `base(` with no `var`).
          const re = new RegExp(`\\bvar ${keyword}\\b`);
          if (re.test(src)) {
            offenders.push(`${path.relative(csharpRoot, full)}: var ${keyword}`);
          }
        }
      }
    };
    walk(csharpRoot);
    assert.deepEqual(
      offenders,
      [],
      `emitted C# must not declare a local named after a reserved keyword:\n${offenders.join(
        "\n",
      )}`,
    );
  });
});
