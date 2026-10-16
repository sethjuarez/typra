// Issue #356: source field identifiers must stay valid in each target while encoded
// JSON names remain the keys used by generated loading and saving.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { RustExprVisitor } from "../src/languages/rust/visitor.js";
import {
  buildRust,
  generate,
  packageRoot,
  readSources,
  removeDir,
  scratchDir,
  toolAvailable,
} from "./native-probe.js";

const FIXTURE = path.join(
  packageRoot,
  "fixtures",
  "features",
  "field-identifiers",
  "main.tsp",
);
const ROOT = "Typra.Fixtures.Features.FieldIdentifiers.Root";

function sources(out: string, target: string, extension: string): string {
  return readSources(path.join(out, target), extension);
}

describe("field identifiers and encoded wire names (#356)", () => {
  let root = "";
  let out = "";

  before(() => {
    root = scratchDir("field-identifiers");
    out = generate(root, FIXTURE, ROOT, [
      "typescript",
      "python",
      "go",
      "csharp",
      "rust",
      "swift",
    ]);
  });

  after(() => removeDir(root));

  it("keeps source identifiers distinct from encoded wire keys in all targets", () => {
    const cases = [
      {
        target: "typescript",
        extension: ".ts",
        identifiers: [
          "className",
          "importName",
          "self",
          "super",
          "crate",
          "traceId",
          "twoFa",
        ],
      },
      {
        target: "python",
        extension: ".py",
        identifiers: [
          "class_name",
          "import_name",
          "self",
          "super",
          "crate",
          "trace_id",
          "two_fa",
        ],
      },
      {
        target: "go",
        extension: ".go",
        identifiers: [
          "ClassName",
          "ImportName",
          "Self",
          "Super",
          "Crate",
          "TraceId",
          "TwoFa",
        ],
      },
      {
        target: "csharp",
        extension: ".cs",
        identifiers: [
          "ClassName",
          "ImportName",
          "Self",
          "Super",
          "Crate",
          "TraceId",
          "TwoFa",
        ],
      },
      {
        target: "rust",
        extension: ".rs",
        identifiers: [
          "class_name",
          "import_name",
          "self_",
          "super_",
          "crate_",
          "trace_id",
          "two_fa",
        ],
      },
      {
        target: "swift",
        extension: ".swift",
        identifiers: [
          "className",
          "importName",
          "`self`",
          "super",
          "crate",
          "traceId",
          "twoFa",
        ],
      },
    ];
    const wireNames = [
      '"class"',
      '"import"',
      '"self"',
      '"super"',
      '"crate"',
      '"x-trace-id"',
      '"2fa"',
    ];

    for (const { target, extension, identifiers } of cases) {
      const code = sources(out, target, extension);
      for (const identifier of identifiers) {
        assert.ok(
          code.includes(identifier),
          `${target} should emit ${identifier}`,
        );
      }
      for (const wireName of wireNames) {
        assert.ok(
          code.includes(wireName),
          `${target} should preserve ${wireName}`,
        );
      }
    }

    const rust = sources(out, "rust", ".rs");
    assert.match(rust, /pub self_: Option<String>/);
    assert.match(rust, /pub super_: Option<String>/);
    assert.match(rust, /pub crate_: Option<String>/);
    assert.match(rust, /self_: value\.get\("self"\)/);
    assert.match(rust, /super_: value\.get\("super"\)/);
    assert.match(rust, /crate_: value\.get\("crate"\)/);
    assert.match(rust, /self\.self_\.as_ref\(\)/);
    assert.doesNotMatch(rust, /r#self/);
    assert.equal(
      new RustExprVisitor().visitExpr({
        kind: "field_read",
        objectName: "root",
        fieldName: "self",
        fieldType: "string",
        isOptional: false,
      }),
      "root.self_",
    );
  });

  it("reports collisions caused by Rust keyword escaping", () => {
    const collisionRoot = scratchDir("field-identifiers-collision");
    try {
      assert.throws(
        () =>
          generate(
            collisionRoot,
            [
              'import "@typra/emitter";',
              "namespace Probe;",
              "@serializable model Root { self?: string; self_?: string; }",
              "",
            ].join("\n"),
            "Probe.Root",
            ["rust"],
          ),
        /Rust type Root: fields "self" and "self_" both map to the identifier "self_"/,
      );
    } finally {
      removeDir(collisionRoot);
    }
  });

  it("compiles and round-trips Rust fields using their encoded JSON keys", (t) => {
    if (!toolAvailable("cargo")) return t.skip("cargo not available");

    buildRust(
      path.join(out, "rust"),
      [
        "use probe::model::fixtures::features::field_identifiers::Root;",
        "use probe::model::{LoadContext, SaveContext};",
        "",
        "#[test]",
        "fn encoded_names_round_trip() {",
        "    let input = serde_json::json!({",
        '        "class": "class-value", "import": "import-value", "self": "self-value",',
        '        "super": "super-value", "crate": "crate-value",',
        '        "x-trace-id": "trace-value", "2fa": "two-fa-value",',
        "    });",
        "    let root = Root::load_from_value(&input, &LoadContext::default());",
        '    assert_eq!(root.self_.as_deref(), Some("self-value"));',
        "    assert_eq!(root.to_value(&SaveContext::default()), input);",
        "}",
        "",
      ].join("\n"),
    );
  });
});
