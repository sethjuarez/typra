import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

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
  "polymorphic-reference",
  "main.tsp",
);
const ROOT = "Typra.Fixtures.Features.PolymorphicReference.Root";

describe("Rust polymorphic references", () => {
  let root = "";
  let out = "";

  before(() => {
    root = scratchDir("polymorphic-reference");
    out = generate(root, FIXTURE, ROOT, ["rust"]);
  });

  after(() => removeDir(root));

  it("uses typed storage for non-recursive references and value storage for recursive ones", () => {
    const rust = readSources(path.join(out, "rust"), ".rs");
    assert.match(rust, /pub shape: Shape,/);
    assert.match(rust, /pub shapes: Vec<Shape>,/);
    assert.match(rust, /pub tree: serde_json::Value,/);
    assert.match(rust, /next: Option<serde_json::Value>,/);
    assert.match(
      rust,
      /shape: value\.get\("shape"\).*Shape::load_from_value/s,
    );
  });

  it("applies known and unknown discriminator defaults consistently for fields and arrays", (t) => {
    if (!toolAvailable("cargo")) return t.skip("cargo not available");
    buildRust(
      path.join(out, "rust"),
      [
        "use probe::model::fixtures::features::polymorphic_reference::Root;",
        "use probe::model::{LoadContext, SaveContext};",
        "",
        "fn round_trip(shape: serde_json::Value) -> serde_json::Value {",
        "    let input = serde_json::json!({",
        "        \"shape\": shape,",
        "        \"shapes\": [shape],",
        "        \"tree\": { \"kind\": \"branch\", \"next\": { \"kind\": \"branch\" } },",
        "    });",
        "    let root = Root::load_from_value(&input, &LoadContext::default());",
        "    root.to_value(&SaveContext::default())",
        "}",
        "",
        "#[test]",
        "fn known_discriminator_defaults_match_array_elements() {",
        "    let output = round_trip(serde_json::json!({ \"kind\": \"circle\" }));",
        "    let expected = serde_json::json!({",
        "        \"kind\": \"circle\", \"enabled\": true, \"legacyLabel\": null, \"radius\": 3,",
        "    });",
        "    assert_eq!(output[\"shape\"], expected);",
        "    assert_eq!(output[\"shapes\"][0], expected);",
        "}",
        "",
        "#[test]",
        "fn unknown_discriminator_defaults_match_array_elements() {",
        "    let output = round_trip(serde_json::json!({",
        "        \"kind\": \"triangle\", \"metadata\": { \"source\": \"plugin\" },",
        "    }));",
        "    let expected = serde_json::json!({",
        "        \"kind\": \"triangle\", \"enabled\": true, \"legacyLabel\": null,",
        "        \"metadata\": { \"source\": \"plugin\" },",
        "    });",
        "    assert_eq!(output[\"shape\"], expected);",
        "    assert_eq!(output[\"shapes\"][0], expected);",
        "}",
        "",
      ].join("\n"),
    );
  });
});
