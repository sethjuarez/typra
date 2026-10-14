import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";

import { generate } from "../src/generate.js";

// Regression (typra#338): the typed Rust conformance rail had no error channel
// for `@sync` ops. The seam trait emitted a bare `fn check(&self, ..) -> String`,
// so `run_<seam>_conformance` SKIPPED every `expectedError` vector on a sync op
// (`// skipped: ... has no typed error channel`) and a consumer could not
// satisfy it through the typed rail. Every other runtime already carries an
// error channel on a sync op (Go `(T, error)`, Swift `throws`, exceptions in
// TS/Python/C#/Java), and Rust async ops already return
// `Result<T, Box<dyn std::error::Error + Send + Sync>>`. The fix gives sync ops
// the same `Result` and routes `expectedError` through the typed rail: `Err`
// whose message contains the expected substring, `Ok` for success vectors.

const SPEC = `import "@typra/emitter";
namespace Typra.Fixtures.Test.RustErrorChannel;

@doc("Sync plain seam with an error channel.")
interface Checker {
  @vector(#{
    name: "check-accepts",
    stage: "callable",
    input: #{ text: "ok" },
    expected: "ok",
  })
  @vector(#{
    name: "check-rejects-empty",
    stage: "callable",
    input: #{ text: "" },
    expectedError: "empty input rejected",
  })
  @sync
  @doc("Return the input, or fail when it is empty.")
  check(text: string): string;

  @optionalOperation
  @sync
  @doc("Optional sync op keeps its in-band default body.")
  hint(text: string): string | null;
}

@serializable
@doc("Fixture root.")
model Root {
  @doc("Seed.")
  seed: string = "";
}
`;

describe("Rust typed @vector conformance has an error channel for @sync ops (typra#338)", () => {
  let specDir: string;
  let output: string;
  let result: Awaited<ReturnType<typeof generate>>;

  before(async () => {
    specDir = mkdtempSync(path.join(process.cwd(), ".tmp-rust-err-chan-"));
    output = mkdtempSync(path.join(process.cwd(), ".tmp-rust-err-chan-out-"));
    writeFileSync(path.join(specDir, "main.tsp"), SPEC, "utf8");
    result = await generate({
      output,
      source: path.join(specDir, "main.tsp"),
      rootObject: "Typra.Fixtures.Test.RustErrorChannel.Root",
      targets: ["rust"],
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

  it("emits Rust successfully", () => {
    assert.equal(result.success, true, result.errors?.join("\n"));
  });

  it("a non-optional @sync trait method returns Result<T, Box<dyn Error + Send + Sync>>", () => {
    const trait = readFileSync(path.join(output, "rust", "checker.rs"), "utf8");
    assert.match(
      trait,
      /fn check\(&self, text: &String\) -> Result<String, Box<dyn std::error::Error \+ Send \+ Sync>>;/,
      `sync op must expose an error channel:\n${trait}`,
    );
    assert.doesNotMatch(trait, /fn check\(&self, text: &String\) -> String;/);
    // An optional sync op keeps its in-band default body (mirrors Go).
    assert.match(trait, /fn hint\(&self, text: &String\) -> Option<String> \{/);
  });

  it("the typed entrypoint asserts expectedError on a @sync op instead of skipping it", () => {
    const conformance = readFileSync(
      path.join(output, "rust", "vector_conformance.rs"),
      "utf8",
    );
    assert.doesNotMatch(
      conformance,
      /skipped: .*no typed error channel/,
      `expectedError on a @sync op must not be skipped:\n${conformance}`,
    );
    assert.match(conformance, /pub fn run_checker_conformance<S: crate::model::Checker \+ \?Sized>/);
    assert.match(
      conformance,
      /let result = seam\.check\(&text\);\s*assert!\(result\.is_err\(\), "\{\}: expected an error, got Ok", "check-rejects-empty"\);/,
      conformance,
    );
    assert.match(
      conformance,
      /message\.contains\("empty input rejected"\)/,
      conformance,
    );
    assert.match(
      conformance,
      /let actual = seam\.check\(&text\)\s*\.unwrap_or_else\(\|error\| panic!\("\{\}: expected Ok, got Err: \{\}", "check-accepts", error\)\);/,
      conformance,
    );
  });
});
