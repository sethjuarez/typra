// Issue #349: nullable unknown values treat explicit JSON null the same as absence,
// while plain optional unknown fields retain a present Value::Null.

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
  "nullable",
  "main.tsp",
);
const ROOT = "Typra.Fixtures.Features.Nullable.Root";

describe("Rust nullable unknown fields (#349)", () => {
  let root = "";
  let out = "";

  before(() => {
    root = scratchDir("nullable-unknown");
    out = generate(root, FIXTURE, ROOT, ["rust"]);
  });

  after(() => removeDir(root));

  it("filters null for nullable unknown, preserving plain optional unknown", () => {
    const rust = readSources(path.join(out, "rust"), ".rs");
    assert.match(
      rust,
      /unknown_nullable: value\.get\("unknownNullable"\)\.filter\(\|v\| !v\.is_null\(\)\)\.cloned\(\)/,
    );
    assert.match(
      rust,
      /optional_unknown_nullable: value\.get\("optionalUnknownNullable"\)\.filter\(\|v\| !v\.is_null\(\)\)\.cloned\(\)/,
    );
    assert.match(
      rust,
      /plain_unknown: value\.get\("plainUnknown"\)\.cloned\(\)/,
    );
  });

  it("loads absent and explicit null as None only for nullable unknown fields", (t) => {
    if (!toolAvailable("cargo")) return t.skip("cargo not available");
    buildRust(
      path.join(out, "rust"),
      [
        "use probe::model::fixtures::features::nullable::Row;",
        "use probe::model::LoadContext;",
        "",
        "#[test]",
        "fn nullable_unknown_nulls_are_unset() {",
        "    let ctx = LoadContext::default();",
        "    let absent = Row::load_from_value(",
        "        &serde_json::json!({",
        "            \"caption\": null, \"count\": null, \"mood\": null,",
        "            \"detail\": null, \"tags\": null, \"details\": null, \"labels\": null,",
        "        }),",
        "        &ctx,",
        "    );",
        "    assert_eq!(absent.unknown_nullable, None);",
        "    assert_eq!(absent.optional_unknown_nullable, None);",
        "    assert_eq!(absent.plain_unknown, None);",
        "",
        "    let explicit_null = Row::load_from_value(",
        "        &serde_json::json!({",
        "            \"caption\": null, \"count\": null, \"mood\": null,",
        "            \"detail\": null, \"tags\": null, \"details\": null, \"labels\": null,",
        "            \"unknownNullable\": null,",
        "            \"optionalUnknownNullable\": null,",
        "            \"plainUnknown\": null,",
        "        }),",
        "        &ctx,",
        "    );",
        "    assert_eq!(explicit_null.unknown_nullable, None);",
        "    assert_eq!(explicit_null.optional_unknown_nullable, None);",
        "    assert_eq!(explicit_null.plain_unknown, Some(serde_json::Value::Null));",
        "",
        "    let present = Row::load_from_value(",
        "        &serde_json::json!({",
        "            \"caption\": null, \"count\": null, \"mood\": null,",
        "            \"detail\": null, \"tags\": null, \"details\": null, \"labels\": null,",
        "            \"unknownNullable\": { \"key\": \"value\" },",
        "        }),",
        "        &ctx,",
        "    );",
        "    assert_eq!(",
        "        present.unknown_nullable,",
        "        Some(serde_json::json!({ \"key\": \"value\" })),",
        "    );",
        "}",
        "",
      ].join("\n"),
    );
  });
});
