import {
  KNOWN_TEST_FAILURES,
  assertKnownTestFailures,
  commandExists,
  execFileSync,
  existsSync,
  fail,
  failures,
  generatedRoot,
  mkdtempSync,
  packageRoot,
  path,
  readFileSync,
  rmSync,
  tmpdir,
  unlinkSync,
  validationRoot,
  walkFiles,
  writeFileSync,
} from "../harness.mjs";
import {
  assertConformanceResult,
  fixtureRootSampleJsonLiteral,
  propertyCorpusJsonLiteral,
} from "../conformance.mjs";

export function runRustTests(target = "rust", packageName = "fixtures") {
  const sourceDir = path.join(generatedRoot, target);
  const useSerdeFeature = target === "rust-serde";
  const sourceFiles = walkFiles(sourceDir, (file) => file.endsWith(".rs"));
  if (sourceFiles.length === 0) {
    fail(`No generated ${target} Rust files found to test.`);
    return;
  }

  const cargoPath = path.join(sourceDir, "Cargo.toml");
  const lockPath = path.join(sourceDir, "Cargo.lock");
  const libPath = path.join(sourceDir, "lib.rs");
  const targetDir = mkdtempSync(path.join(tmpdir(), "typra-rust-"));
  writeFileSync(
    cargoPath,
    [
      "[package]",
      `name = "${packageName}"`,
      'version = "0.0.0"',
      'edition = "2021"',
      "",
      "[dependencies]",
      'async-trait = "0.1"',
      'serde = { version = "1", features = ["derive"] }',
      'serde_json = "1"',
      'serde_yaml = "0.9"',
      "",
      "[dev-dependencies]",
      'tokio = { version = "1", features = ["macros", "rt"] }',
      "",
      "[features]",
      "serde = []",
      "",
      "[lib]",
      'path = "lib.rs"',
      "",
    ].join("\n"),
  );
  writeFileSync(libPath, '#[path = "mod.rs"] pub mod model;\n');
  try {
    let output = "";
    let crashed = null;
    try {
      output = execFileSync(
        "cargo",
        useSerdeFeature ? ["test", "--features", "serde"] : ["test"],
        {
          cwd: sourceDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            CARGO_TARGET_DIR: targetDir,
            RUSTFLAGS: "-D warnings",
          },
        },
      );
    } catch (error) {
      output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`;
      crashed = error;
    }
    const failed = new Set([
      ...[...output.matchAll(/^test\s+(\S+)\s+\.\.\.\s+FAILED$/gm)].map(
        (match) => match[1],
      ),
      ...[...output.matchAll(/^----\s+(\S+)\s+stdout\s+----$/gm)].map(
        (match) => match[1],
      ),
    ]);
    assertKnownTestFailures(target, failed, KNOWN_TEST_FAILURES[target], {
      crashed,
      output,
      crashMessage: `Generated ${target} Rust tests failed to build or run`,
    });
  } finally {
    for (const tempPath of [cargoPath, lockPath, libPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
  }
}

export function runRustExecutableConformance(
  target = "rust",
  packageName = "fixtures",
) {
  const sourceDir = path.join(generatedRoot, target);
  const useSerdeFeature = target === "rust-serde";
  const cargoPath = path.join(sourceDir, "Cargo.toml");
  const lockPath = path.join(sourceDir, "Cargo.lock");
  const libPath = path.join(sourceDir, "lib.rs");
  const runnerPath = path.join(sourceDir, "conformance_validate.rs");
  const targetDir = mkdtempSync(path.join(tmpdir(), "typra-rust-conformance-"));
  if (!existsSync(sourceDir)) {
    fail(
      `No generated ${target} Rust directory found for executable conformance.`,
    );
    return;
  }

  writeFileSync(
    cargoPath,
    [
      "[package]",
      `name = "${packageName}"`,
      'version = "0.0.0"',
      'edition = "2021"',
      "",
      "[dependencies]",
      'async-trait = "0.1"',
      'serde = { version = "1", features = ["derive"] }',
      'serde_json = "1"',
      'serde_yaml = "0.9"',
      "",
      "[features]",
      "serde = []",
      "",
      "[lib]",
      'path = "lib.rs"',
      "",
      "[[bin]]",
      'name = "conformance_validate"',
      'path = "conformance_validate.rs"',
      "",
    ].join("\n"),
  );
  writeFileSync(libPath, '#[path = "mod.rs"] pub mod model;\n');
  writeFileSync(
    runnerPath,
    [
      `use ${packageName}::model::*;`,
      "use serde_json::json;",
      "",
      "fn main() {",
      "    let load_ctx = LoadContext::new();",
      "    let save_ctx = SaveContext::new();",
      `    let root_value: serde_json::Value = serde_json::from_str(${fixtureRootSampleJsonLiteral}).unwrap();`,
      `    let property_cases: Vec<serde_json::Value> = serde_json::from_str(${propertyCorpusJsonLiteral}).unwrap();`,
      "    let property_outputs: Vec<serde_json::Value> = property_cases.iter().map(|entry| {",
      useSerdeFeature
        ? '        let root: FixtureRoot = serde_json::from_value(entry["input"].clone()).unwrap();'
        : '        let root = FixtureRoot::load_from_value(&entry["input"], &load_ctx);',
      "        json!({",
      '            "id": entry["id"].clone(),',
      '            "seed": entry["seed"].clone(),',
      '            "caseId": entry["caseId"].clone(),',
      useSerdeFeature
        ? '            "root": serde_json::to_value(&root).unwrap()'
        : '            "root": root.to_value(&save_ctx)',
      "        })",
      "    }).collect();",
      useSerdeFeature
        ? "    let root: FixtureRoot = serde_json::from_value(root_value.clone()).unwrap();"
        : "    let root = FixtureRoot::load_from_value(&root_value, &load_ctx);",
      useSerdeFeature
        ? '    let image_content: FixtureContent = serde_json::from_value(json!({"kind": "image", "url": "https://example.com/fixture.png"})).unwrap();'
        : '    let image_content = FixtureContent::load_from_value(&json!({"kind": "image", "url": "https://example.com/fixture.png"}), &load_ctx);',
      useSerdeFeature
        ? '    let known_content: FixtureContent = serde_json::from_str(r#"{"kind":"text","value":"hello"}"#).expect("serde known closed discriminator");'
        : '    let known_content = FixtureContent::from_json(r#"{"kind":"text","value":"hello"}"#, &load_ctx).expect("known closed discriminator");',
      useSerdeFeature
        ? '    assert_eq!(serde_json::to_value(&known_content).unwrap(), json!({"kind": "text", "value": "hello"}));'
        : '    assert_eq!(known_content.to_value(&save_ctx), json!({"kind": "text", "value": "hello"}));',
      '    for invalid_kind in ["video", "Text"] {',
      '        let input = format!(r#"{{"kind":"{}","value":"hello"}}"#, invalid_kind);',
      useSerdeFeature
        ? '        let error = serde_json::from_str::<FixtureContent>(&input).expect_err("serde invalid closed discriminator");'
        : '        let error = FixtureContent::from_json(&input, &load_ctx).expect_err("invalid closed discriminator");',
      "        let message = error.to_string();",
      '        assert!(message.contains("kind") && message.contains(invalid_kind), "{message}");',
      "    }",
      "    let unknown_connection_input = json!({",
      '        "kind": "future-auth",',
      '        "name": "future",',
      '        "endpoint": "https://future.test",',
      '        "tenant": "future-tenant",',
      '        "providerOptions": {',
      '            "label": "future-provider",',
      '            "items": [1, {"enabled": true}],',
      '            "enabled": false,',
      '            "integer": 42,',
      '            "float": 3.14,',
      '            "nullable": null',
      "        }",
      "    });",
      useSerdeFeature
        ? "    let mut unknown_connection = serde_json::from_value::<FixtureConnection>(unknown_connection_input.clone()).unwrap();"
        : "    let mut unknown_connection = FixtureConnection::load_from_value(&unknown_connection_input, &load_ctx);",
      useSerdeFeature
        ? "    let canonical_unknown_connection = FixtureConnection::load_from_value(&unknown_connection_input, &load_ctx);"
        : "",
      '    assert_eq!(unknown_connection.kind_str(), "future-auth");',
      '    assert!(matches!(&unknown_connection.kind, FixtureConnectionKind::Custom { raw, .. } if raw.get("endpoint") == Some(&json!("https://future.test")) && raw.get("providerOptions") == unknown_connection_input.get("providerOptions")));',
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&unknown_connection).unwrap(), canonical_unknown_connection.to_value(&save_ctx));"
        : "    assert_eq!(unknown_connection.to_value(&save_ctx), unknown_connection_input);",
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&unknown_connection).unwrap(), unknown_connection_input);"
        : "",
      useSerdeFeature
        ? "    let reloaded_unknown_connection = serde_json::from_value::<FixtureConnection>(serde_json::to_value(&unknown_connection).unwrap()).unwrap();"
        : "    let reloaded_unknown_connection = FixtureConnection::load_from_value(&unknown_connection.to_value(&save_ctx), &load_ctx);",
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&reloaded_unknown_connection).unwrap(), unknown_connection_input);"
        : "    assert_eq!(reloaded_unknown_connection.to_value(&save_ctx), unknown_connection_input);",
      '    unknown_connection.name = Some("updated".to_string());',
      "    let mut updated_unknown_connection = unknown_connection_input.clone();",
      '    updated_unknown_connection["name"] = json!("updated");',
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&unknown_connection).unwrap(), updated_unknown_connection);"
        : "    assert_eq!(unknown_connection.to_value(&save_ctx), updated_unknown_connection);",
      '    let known_connection_input = json!({"kind": "custom", "name": "known", "endpoint": "https://known.test"});',
      useSerdeFeature
        ? "    let known_connection = serde_json::from_value::<FixtureConnection>(known_connection_input.clone()).unwrap();"
        : "    let known_connection = FixtureConnection::load_from_value(&known_connection_input, &load_ctx);",
      useSerdeFeature
        ? "    let canonical_known_connection = FixtureConnection::load_from_value(&known_connection_input, &load_ctx);"
        : "",
      "    assert!(matches!(&known_connection.kind, FixtureConnectionKind::FixtureCustomConnection { .. }));",
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&known_connection).unwrap(), canonical_known_connection.to_value(&save_ctx));"
        : "    assert_eq!(known_connection.to_value(&save_ctx), known_connection_input);",
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&known_connection).unwrap(), known_connection_input);"
        : "",
      '    for invalid_connection_input in [json!({}), json!({"kind": ""}), json!({"kind": null}), json!({"kind": 42})] {',
      useSerdeFeature
        ? '        let invalid_connection_error = serde_json::from_value::<FixtureConnection>(invalid_connection_input.clone()).expect_err("serde invalid FixtureConnection discriminator");'
        : '        let invalid_connection_error = FixtureConnection::from_json(&invalid_connection_input.to_string(), &load_ctx).expect_err("invalid FixtureConnection discriminator");',
      "        let invalid_connection_message = invalid_connection_error.to_string();",
      '        assert!(invalid_connection_message.contains("kind") || invalid_connection_message.contains("discriminator"), "{invalid_connection_message}");',
      "    }",
      // A named open-enum discriminator must round-trip an unrecognized kind losslessly.
      // (This is adjacent to issue #38 but does not reproduce it — see the fixture doc.)
      '    let named_open_input = json!({"kind": "vendor-specific", "label": "future", "extra": {"nested": [1, null]}});',
      useSerdeFeature
        ? "    let named_open = serde_json::from_value::<FixtureNamedOpenBase>(named_open_input.clone()).unwrap();"
        : "    let named_open = FixtureNamedOpenBase::load_from_value(&named_open_input, &load_ctx);",
      useSerdeFeature
        ? "    let canonical_named_open = FixtureNamedOpenBase::load_from_value(&named_open_input, &load_ctx);"
        : "",
      '    assert_eq!(named_open.kind_str(), "vendor-specific");',
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&named_open).unwrap(), canonical_named_open.to_value(&save_ctx));"
        : "    assert_eq!(named_open.to_value(&save_ctx), named_open_input);",
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&named_open).unwrap(), named_open_input);"
        : "",
      useSerdeFeature
        ? '    let named_open_known = serde_json::from_value::<FixtureNamedOpenBase>(json!({"kind": "managed", "label": "known", "resourceId": "res-1"})).unwrap();'
        : '    let named_open_known = FixtureNamedOpenBase::load_from_value(&json!({"kind": "managed", "label": "known", "resourceId": "res-1"}), &load_ctx);',
      "    assert!(matches!(&named_open_known.kind, FixtureNamedOpenBaseKind::FixtureNamedOpenVariant { .. }));",
      '    let unclaimed_input = json!({"kind": "plain", "label": "leftover"});',
      useSerdeFeature
        ? "    let unclaimed = serde_json::from_value::<FixtureUnclaimedBase>(unclaimed_input.clone()).unwrap();"
        : "    let unclaimed = FixtureUnclaimedBase::load_from_value(&unclaimed_input, &load_ctx);",
      useSerdeFeature
        ? "    let canonical_unclaimed = FixtureUnclaimedBase::load_from_value(&unclaimed_input, &load_ctx);"
        : "",
      '    assert!(matches!(&unclaimed.kind, FixtureUnclaimedBaseKind::Custom { kind_name, .. } if kind_name == "plain"), "unclaimed closed discriminator value did not load as the base type");',
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&unclaimed).unwrap(), canonical_unclaimed.to_value(&save_ctx));"
        : "    assert_eq!(unclaimed.to_value(&save_ctx), unclaimed_input);",
      '    let claimed_input = json!({"kind": "managed", "label": "known", "resourceId": "res-1"});',
      useSerdeFeature
        ? "    let claimed = serde_json::from_value::<FixtureUnclaimedBase>(claimed_input.clone()).unwrap();"
        : "    let claimed = FixtureUnclaimedBase::load_from_value(&claimed_input, &load_ctx);",
      '    assert!(matches!(&claimed.kind, FixtureUnclaimedBaseKind::FixtureClaimedVariant { resource_id } if resource_id == "res-1"), "claimed discriminator value stopped dispatching to its subtype");',
      useSerdeFeature
        ? '    let missing_connection_error = serde_json::from_str::<FixtureToolbox>(r#"{"tools":{"custom":{"kind":"vendor"}},"inheritedMapBindingTool":{"kind":"function","name":"map","command":"run"},"inheritedListBindingTool":{"kind":"function","name":"list","command":"run"}}"#).expect_err("serde missing required CustomTool.connection");'
        : '    let missing_connection_error = FixtureToolbox::from_json(r#"{"tools":{"custom":{"kind":"vendor"}},"inheritedMapBindingTool":{"kind":"function","name":"map","command":"run"},"inheritedListBindingTool":{"kind":"function","name":"list","command":"run"}}"#, &load_ctx).expect_err("missing required CustomTool.connection");',
      "    let missing_connection_diagnostic = missing_connection_error.to_string();",
      '    assert!(missing_connection_diagnostic.contains("tools.custom.connection") && missing_connection_diagnostic.contains("missing required field"), "{missing_connection_diagnostic}");',
      '    let function_tool_input = json!({"kind": "function", "name": "search", "command": "run", "parameters": [{"name": "query", "kind": "string", "required": true}]});',
      useSerdeFeature
        ? "    let function_tool = serde_json::from_value::<FixtureTool>(function_tool_input.clone()).unwrap();"
        : "    let function_tool = FixtureTool::load_from_value(&function_tool_input, &load_ctx);",
      "    let canonical_function_tool = FixtureTool::load_from_value(&function_tool_input, &load_ctx);",
      useSerdeFeature
        ? "    let function_tool_saved = serde_json::to_value(&function_tool).unwrap();"
        : "    let function_tool_saved = function_tool.to_value(&save_ctx);",
      "    assert_eq!(function_tool_saved, canonical_function_tool.to_value(&save_ctx));",
      '    assert_eq!(function_tool_saved["parameters"]["query"]["kind"], json!("string"));',
      '    assert_eq!(function_tool_saved["parameters"]["query"]["required"], json!(true));',
      useSerdeFeature
        ? "    let function_tool_reloaded = serde_json::from_value::<FixtureTool>(function_tool_saved.clone()).unwrap();"
        : "    let function_tool_reloaded = FixtureTool::load_from_value(&function_tool_saved, &load_ctx);",
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&function_tool_reloaded).unwrap(), function_tool_saved);"
        : "    assert_eq!(function_tool_reloaded.to_value(&save_ctx), function_tool_saved);",
      useSerdeFeature
        ? '    let unnamed_function_tool = serde_json::from_value::<FixtureTool>(json!({"kind": "function", "name": "unnamed", "command": "run", "parameters": [{"kind": "string"}]})).unwrap();'
        : '    let unnamed_function_tool = FixtureTool::load_from_value(&json!({"kind": "function", "name": "unnamed", "command": "run", "parameters": [{"kind": "string"}]}), &load_ctx);',
      useSerdeFeature
        ? '    assert_eq!(serde_json::to_value(&unnamed_function_tool).unwrap()["parameters"], json!([{"kind": "string"}]));'
        : '    assert_eq!(unnamed_function_tool.to_value(&save_ctx)["parameters"], json!([{"kind": "string"}]));',
      useSerdeFeature
        ? '    let duplicate_function_tool = serde_json::from_value::<FixtureTool>(json!({"kind": "function", "name": "duplicate", "command": "run", "parameters": [{"name": "query", "kind": "string"}, {"name": "query", "kind": "number"}]})).unwrap();'
        : '    let duplicate_function_tool = FixtureTool::load_from_value(&json!({"kind": "function", "name": "duplicate", "command": "run", "parameters": [{"name": "query", "kind": "string"}, {"name": "query", "kind": "number"}]}), &load_ctx);',
      useSerdeFeature
        ? '    assert_eq!(serde_json::to_value(&duplicate_function_tool).unwrap()["parameters"], json!([{"name": "query", "kind": "string"}, {"name": "query", "kind": "number"}]));'
        : '    assert_eq!(duplicate_function_tool.to_value(&save_ctx)["parameters"], json!([{"name": "query", "kind": "string"}, {"name": "query", "kind": "number"}]));',
      '    let wildcard_tool_input = json!({"kind": "vendor", "name": "vendor", "description": "vendor description", "connection": {"kind": "future-auth", "name": "future"}, "config": {"enabled": true}});',
      useSerdeFeature
        ? "    let wildcard_tool = serde_json::from_value::<FixtureTool>(wildcard_tool_input.clone()).unwrap();"
        : "    let wildcard_tool = FixtureTool::load_from_value(&wildcard_tool_input, &load_ctx);",
      useSerdeFeature
        ? "    let canonical_wildcard_tool = FixtureTool::load_from_value(&wildcard_tool_input, &load_ctx);"
        : "",
      '    assert!(matches!(&wildcard_tool.kind, FixtureToolKind::FixtureCustomTool { .. }), "declared wildcard subtype did not own unknown tool kind");',
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&wildcard_tool).unwrap(), canonical_wildcard_tool.to_value(&save_ctx));"
        : "    assert_eq!(wildcard_tool.to_value(&save_ctx), wildcard_tool_input);",
      useSerdeFeature
        ? "    assert_eq!(serde_json::to_value(&wildcard_tool).unwrap(), wildcard_tool_input);"
        : "",
      useSerdeFeature
        ? "    let wildcard_tool_reloaded = serde_json::from_value::<FixtureTool>(serde_json::to_value(&wildcard_tool).unwrap()).unwrap();"
        : "    let wildcard_tool_reloaded = FixtureTool::load_from_value(&wildcard_tool.to_value(&save_ctx), &load_ctx);",
      '    assert!(matches!(&wildcard_tool_reloaded.kind, FixtureToolKind::FixtureCustomTool { .. }), "wildcard tool did not survive reload");',
      '    let wire = WireOptions::load_from_value(&json!({"maxOutputTokens": 256, "temperature": 0.7}), &load_ctx);',
      useSerdeFeature
        ? '    let reference: FixtureReference = serde_json::from_value(json!("ref-coerced")).unwrap();'
        : '    let reference = FixtureReference::load_from_value(&json!("ref-coerced"), &load_ctx);',
      "    let number_property = FixtureProperty::load_from_value(&json!(3.5), &load_ctx);",
      '    assert_eq!(number_property.to_value(&save_ctx), json!({"kind": "number", "default": 3.5}));',
      "    let omitted_model_info = ModelInfo::load_from_value(&json!({}), &load_ctx);",
      "    assert!(omitted_model_info.input_modalities.is_none());",
      "    assert!(omitted_model_info.output_modalities.is_empty());",
      "    assert!(omitted_model_info.owners.is_none());",
      "    assert!(omitted_model_info.default_owners.is_empty());",
      '    assert_eq!(omitted_model_info.to_value(&save_ctx), json!({"outputModalities": [], "defaultOwners": []}));',
      '    let explicit_model_info = ModelInfo::load_from_value(&json!({"inputModalities": [], "outputModalities": [], "owners": [], "defaultOwners": []}), &load_ctx);',
      "    assert!(matches!(explicit_model_info.input_modalities.as_ref(), Some(values) if values.is_empty()));",
      "    assert!(explicit_model_info.output_modalities.is_empty());",
      "    assert!(matches!(explicit_model_info.owners.as_ref(), Some(values) if values.is_empty()));",
      "    assert!(explicit_model_info.default_owners.is_empty());",
      '    assert_eq!(explicit_model_info.to_value(&save_ctx), json!({"inputModalities": [], "outputModalities": [], "owners": [], "defaultOwners": []}));',
      '    let unique_named = FixtureNamedPayloadCollection::load_from_value(&json!({"items": [{"name": "alpha", "payload": {"nested": [1, null]}}, {"name": "beta", "payload": "second"}]}), &load_ctx);',
      '    assert_eq!(unique_named.to_value(&save_ctx), json!({"items": {"alpha": {"payload": {"nested": [1, null]}}, "beta": {"payload": "second"}}}));',
      '    let lossy_named = FixtureNamedPayloadCollection::load_from_value(&json!({"items": [{"payload": {"nested": [1, null]}}, {"name": "", "payload": "second"}]}), &load_ctx);',
      '    assert_eq!(lossy_named.to_value(&save_ctx), json!({"items": [{"payload": {"nested": [1, null]}}, {"payload": "second"}]}));',
      '    let duplicate_named = FixtureNamedPayloadCollection::load_from_value(&json!({"items": [{"name": "dup", "payload": 1}, {"name": "dup", "payload": 2}]}), &load_ctx);',
      '    assert_eq!(duplicate_named.to_value(&save_ctx), json!({"items": [{"name": "dup", "payload": 1}, {"name": "dup", "payload": 2}]}));',
      "    let mut array_ctx = SaveContext::new();",
      '    array_ctx.collection_format = "array".to_string();',
      '    assert!(unique_named.to_value(&array_ctx).get("items").unwrap().is_array());',
      '    let bag = FixtureBag::load_from_value(&json!({"items": {"alpha": {"note": "first"}}, "secondItems": {"beta": "second"}}), &load_ctx);',
      '    assert_eq!(bag.items.len(), 1, "named object collection must load into an ordered list");',
      '    assert_eq!(bag.items[0].name, "alpha", "named object collection must adopt the key as name");',
      '    assert_eq!(bag.second_items[0].note.as_deref(), Some("second"), "named scalar shorthand must load into the primary field");',
      '    assert_eq!(bag.to_value(&save_ctx).get("items").unwrap(), &json!({"alpha": "first"}), "default object save must use shorthand");',
      "    let mut expand_ctx = SaveContext::new();",
      "    expand_ctx.use_shorthand = false;",
      '    assert_eq!(bag.to_value(&expand_ctx).get("items").unwrap(), &json!({"alpha": {"note": "first"}}), "use_shorthand=false must preserve the item object");',
      '    let error = FixtureNamedRoot::from_json(r#"{"inputs":{"profile":{"properties":{"arrayEntry":[]}}}}"#, &load_ctx).expect_err("array-valued named entry");',
      "    let message = error.to_string();",
      '    assert!(message.contains("inputs.profile.properties.arrayEntry") && message.contains("array"), "{message}");',
      "    // Issue #47: a failure inside an array element must carry the element index, so a",
      "    // diagnostic cannot silently degrade to naming only the field.",
      '    let indexed_error = FixtureIndexedList::from_json(r#"{"entries":[{"label":"first","detail":{"code":"ok"}},{"label":"second"}]}"#, &load_ctx).expect_err("missing required field inside an array element");',
      "    let indexed_message = indexed_error.to_string();",
      '    assert!(indexed_message.contains("entries[1].detail"), "array element diagnostic lost the element index: {indexed_message}");',
      '    println!("{}", json!({',
      useSerdeFeature
        ? '        "root": serde_json::to_value(&root).unwrap(),'
        : '        "root": root.to_value(&save_ctx),',
      '        "propertyCases": property_outputs,',
      useSerdeFeature
        ? '        "imageContent": serde_json::to_value(&image_content).unwrap(),'
        : '        "imageContent": image_content.to_value(&save_ctx),',
      '        "openai": wire.to_wire("openai"),',
      '        "openaiRoundTrip": WireOptions::from_wire("openai", &wire.to_wire("openai"), &load_ctx).to_wire("openai"),',
      '        "anthropic": wire.to_wire("anthropic"),',
      '        "unmapped": wire.to_wire("unmapped-provider"),',
      '        "emptyProvider": wire.to_wire(""),',
      useSerdeFeature
        ? '        "reference": serde_json::to_value(&reference).unwrap()'
        : '        "reference": reference.to_value(&save_ctx)',
      "    }));",
      "}",
      "",
    ].join("\n"),
  );

  try {
    const output = execFileSync(
      "cargo",
      useSerdeFeature
        ? [
            "run",
            "--quiet",
            "--features",
            "serde",
            "--bin",
            "conformance_validate",
          ]
        : ["run", "--quiet", "--bin", "conformance_validate"],
      {
        cwd: sourceDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CARGO_TARGET_DIR: targetDir,
          RUSTFLAGS: "-D warnings",
        },
      },
    ).trim();
    assertConformanceResult(target, output);
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated ${target} Rust executable conformance failed:\n${output || error.message}`,
    );
  } finally {
    for (const tempPath of [cargoPath, lockPath, libPath, runnerPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
  }
}

export function runRustUnknownAbstractConformance() {
  const outputRoot = path.join(validationRoot, "rust-unknown");
  const sourceDir = path.join(outputRoot, "rust");
  const cargoPath = path.join(sourceDir, "Cargo.toml");
  const libPath = path.join(sourceDir, "lib.rs");
  const runnerPath = path.join(sourceDir, "unknown_validate.rs");
  const initialFailureCount = failures.length;

  try {
    execFileSync(
      process.execPath,
      [
        path.join(packageRoot, "dist", "src", "cli.js"),
        "--output",
        outputRoot,
        "--targets",
        "rust",
        "--spec",
        path.join(
          packageRoot,
          "fixtures",
          "runtimes",
          "rust",
          "unknown-polymorphism",
          "main.tsp",
        ),
        "--root-object",
        "Typra.Fixtures.RustUnknown.Root",
        "--no-tests",
        "--no-format",
        "--deterministic",
      ],
      { cwd: packageRoot, stdio: "pipe" },
    );
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Rust abstract unknown fixture generation failed:\n${output || error.message}`,
    );
  }
  if (failures.length > initialFailureCount) return;

  const directConnectionPath = path.join(sourceDir, "connection.rs");
  const connectionPath = existsSync(directConnectionPath)
    ? directConnectionPath
    : walkFiles(
        sourceDir,
        (filePath) => path.basename(filePath) === "connection.rs",
      )[0];
  const connectionSource = existsSync(connectionPath)
    ? readFileSync(connectionPath, "utf8")
    : "";
  for (const expected of [
    "Unknown {",
    "kind_name: String",
    "raw: serde_json::Map<String, serde_json::Value>",
    "kind_name: kind_str.to_string()",
    'raw.remove("kind")',
    'raw.remove("name")',
    "ConnectionKind::Unknown { raw, .. }",
    "for (key, value) in raw",
  ]) {
    if (!connectionSource.includes(expected)) {
      fail(
        `Generated Rust abstract unknown fixture does not include expected content: ${expected}`,
      );
    }
  }
  if (failures.length > initialFailureCount) return;

  const targetDir = mkdtempSync(path.join(tmpdir(), "typra-rust-unknown-"));
  writeFileSync(
    cargoPath,
    [
      "[package]",
      'name = "rust_unknown"',
      'version = "0.0.0"',
      'edition = "2021"',
      "",
      "[dependencies]",
      'serde = { version = "1", features = ["derive"] }',
      'serde_json = "1"',
      'serde_yaml = "0.9"',
      "",
      "[lib]",
      'path = "lib.rs"',
      "",
      "[[bin]]",
      'name = "unknown_validate"',
      'path = "unknown_validate.rs"',
      "",
    ].join("\n"),
  );
  writeFileSync(libPath, '#[path = "mod.rs"] pub mod model;\n');
  writeFileSync(
    runnerPath,
    [
      "use ::rust_unknown::model::*;",
      "use serde_json::json;",
      "",
      "fn main() {",
      "    let load_ctx = LoadContext::new();",
      "    let save_ctx = SaveContext::new();",
      '    let input = json!({"kind": "future-auth", "name": "future", "endpoint": "https://future.test", "metadata": {"source": "future"}});',
      "    let mut connection = Connection::load_from_value(&input, &load_ctx);",
      '    assert_eq!(connection.kind_str(), "future-auth");',
      '    assert!(matches!(&connection.kind, ConnectionKind::Unknown { raw, .. } if raw.get("endpoint") == Some(&json!("https://future.test"))));',
      "    assert_eq!(connection.to_value(&save_ctx), input);",
      '    connection.name = Some("updated".to_string());',
      "    let mut updated = input.clone();",
      '    updated["name"] = json!("updated");',
      "    assert_eq!(connection.to_value(&save_ctx), updated);",
      '    let root_input = json!({"connection": input});',
      "    let root = Root::load_from_value(&root_input, &load_ctx);",
      "    assert_eq!(root.to_value(&save_ctx), root_input);",
      "}",
      "",
    ].join("\n"),
  );

  try {
    execFileSync("cargo", ["run", "--quiet", "--bin", "unknown_validate"], {
      cwd: sourceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CARGO_TARGET_DIR: targetDir,
        RUSTFLAGS: "-D warnings",
      },
    });
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated Rust abstract unknown conformance failed:\n${output || error.message}`,
    );
  } finally {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
  }
}

export function runRustDispatchRegressionCompile(context) {
  // Regression compile gate: the coerce-union + optional-field target bugs
  // (BUG1/BUG2/BUG3 and the 2.0.0 raw-string/import/unwrap defects) all surface
  // ONLY as compile errors in the generated SEAM conformance tests for a fixture
  // that couples an optional intermediate with a discriminated coerce union. The
  // integration fixture lacks that seam, so those bugs were never compiled in
  // typra CI — only downstream. This gate closes that gap by generating the
  // dispatch-target-regression fixture with tests, attaching compile-only
  // provider doubles, and `cargo build --tests` (compile, do not run).
  if (!commandExists("cargo")) {
    context.skip("cargo is not available");
    return;
  }
  const fixtureDir = path.join(
    packageRoot,
    "fixtures",
    "features",
    "dispatch-target-regression",
  );
  const outRoot = mkdtempSync(path.join(tmpdir(), "typra-rust-regression-"));
  const targetDir = mkdtempSync(
    path.join(tmpdir(), "typra-rust-regression-target-"),
  );
  try {
    execFileSync(
      process.execPath,
      [
        path.join(packageRoot, "dist", "src", "cli.js"),
        "--output",
        outRoot,
        "--targets",
        "rust",
        "--spec",
        path.join(fixtureDir, "main.tsp"),
        "--root-object",
        "Typra.Fixtures.Features.DispatchTargetRegression.Root",
        "--deterministic",
        "--no-format",
      ],
      { cwd: packageRoot, stdio: "pipe" },
    );
    const sourceDir = path.join(outRoot, "rust");
    if (!existsSync(sourceDir)) {
      fail("Rust dispatch-target-regression gate: no rust output generated.");
      return;
    }
    // Attach the committed compile-only provider doubles next to the emitted
    // seam conformance tests (they include it via #[path = "vector_adapters.rs"]).
    writeFileSync(
      path.join(sourceDir, "tests", "vector_adapters.rs"),
      readFileSync(
        path.join(fixtureDir, "vector-adapters", "rust", "vector_adapters.rs"),
        "utf8",
      ),
    );
    writeFileSync(
      path.join(sourceDir, "Cargo.toml"),
      [
        "[package]",
        'name = "dispatch_target_regression"',
        'version = "0.0.0"',
        'edition = "2021"',
        "autotests = false",
        "",
        "[dependencies]",
        'async-trait = "0.1"',
        'serde = { version = "1", features = ["derive"] }',
        'serde_json = "1"',
        'serde_yaml = "0.9"',
        "",
        "[dev-dependencies]",
        'tokio = { version = "1", features = ["macros", "rt"] }',
        "",
        "[features]",
        "serde = []",
        "",
        "[lib]",
        'path = "lib.rs"',
        "",
      ].join("\n"),
    );
    // The generated seam tests import `crate::model::*`; the per-model tests
    // import `crate::*`. Re-export the model at the crate root so both resolve,
    // and pull the emitted test tree in under cfg(test).
    writeFileSync(
      path.join(sourceDir, "lib.rs"),
      [
        '#[path = "mod.rs"]',
        "pub mod model;",
        "pub use model::*;",
        "",
        "#[cfg(test)]",
        '#[path = "tests/main.rs"]',
        "mod conformance;",
        "",
      ].join("\n"),
    );
    try {
      execFileSync("cargo", ["build", "--tests"], {
        cwd: sourceDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      });
    } catch (error) {
      const output =
        `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
      fail(
        `Rust dispatch-target-regression compile gate failed:\n${output || error.message}`,
      );
    }
  } finally {
    for (const dir of [outRoot, targetDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

export function runRustVectorConformanceCompile(context) {
  // Typed @vector conformance ENTRYPOINT gate (prompty#511 Cat 1 / typra#306,
  // Track A). The emitter emits `run_<seam>_conformance<S: <Seam>>(seam: &S)` as
  // a library module (`vector_conformance.rs`) of the model crate; a consumer
  // migrates a plain seam off the stringly adapter registry by authoring only a
  // real `impl <Seam>` and one typed call. This gate proves that path stays
  // compilable end-to-end: generate the typed-seam-conformance fixture, attach
  // the committed typed double as a test module, and `cargo build --tests`.
  //
  // Red-first: if the entrypoint is not emitted, `crate::model::vector_conformance`
  // is unresolved and the double fails to compile — so this gate fails on `main`.
  if (!commandExists("cargo")) {
    context.skip("cargo is not available");
    return;
  }
  const fixtureDir = path.join(
    packageRoot,
    "fixtures",
    "features",
    "typed-seam-conformance",
  );
  const outRoot = mkdtempSync(path.join(tmpdir(), "typra-rust-typedseam-"));
  const targetDir = mkdtempSync(
    path.join(tmpdir(), "typra-rust-typedseam-target-"),
  );
  try {
    execFileSync(
      process.execPath,
      [
        path.join(packageRoot, "dist", "src", "cli.js"),
        "--output",
        outRoot,
        "--targets",
        "rust",
        "--spec",
        path.join(fixtureDir, "main.tsp"),
        "--root-object",
        "Typra.Fixtures.Features.TypedSeamConformance.Root",
        "--deterministic",
        "--no-format",
      ],
      { cwd: packageRoot, stdio: "pipe" },
    );
    const sourceDir = path.join(outRoot, "rust");
    if (!existsSync(sourceDir)) {
      fail("Rust typed-seam-conformance gate: no rust output generated.");
      return;
    }
    if (!existsSync(path.join(sourceDir, "vector_conformance.rs"))) {
      fail(
        "Rust typed-seam-conformance gate: emitter did not emit vector_conformance.rs " +
          "(the typed conformance entrypoint). The committed double cannot resolve " +
          "crate::model::vector_conformance — this is the red-first signal.",
      );
      return;
    }
    // Attach the committed typed double as a test module of the generated crate.
    writeFileSync(
      path.join(sourceDir, "typed_conformance.rs"),
      readFileSync(
        path.join(fixtureDir, "vector-adapters", "rust", "typed_conformance.rs"),
        "utf8",
      ),
    );
    writeFileSync(
      path.join(sourceDir, "Cargo.toml"),
      [
        "[package]",
        'name = "typed_seam_conformance"',
        'version = "0.0.0"',
        'edition = "2021"',
        "autotests = false",
        "",
        "[dependencies]",
        'async-trait = "0.1"',
        'serde = { version = "1", features = ["derive"] }',
        'serde_json = "1"',
        'serde_yaml = "0.9"',
        "",
        "[dev-dependencies]",
        'tokio = { version = "1", features = ["macros", "rt"] }',
        "",
        "[features]",
        "serde = []",
        "",
        "[lib]",
        'path = "lib.rs"',
        "",
      ].join("\n"),
    );
    // Re-export the model at the crate root and pull the committed typed double
    // in under cfg(test); it calls the emitted entrypoint with its real impl.
    writeFileSync(
      path.join(sourceDir, "lib.rs"),
      [
        '#[path = "mod.rs"]',
        "pub mod model;",
        "pub use model::*;",
        "",
        "#[cfg(test)]",
        '#[path = "typed_conformance.rs"]',
        "mod typed_conformance;",
        "",
      ].join("\n"),
    );
    try {
      execFileSync("cargo", ["build", "--tests"], {
        cwd: sourceDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      });
    } catch (error) {
      const output =
        `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
      fail(
        `Rust typed-seam-conformance compile gate failed:\n${output || error.message}`,
      );
    }
  } finally {
    for (const dir of [outRoot, targetDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

export function runRustSensitiveNeverLoadedCompile(context) {
  // Whole-tree COMPILE gate for the Rust never-loaded-field family (E0063). The
  // `serialization` feature fixture's `@serializable` Root carries two fields
  // that are never LOADED — a bare `@sensitive scratch` (withheld from both
  // directions) and a `@sensitive("load") computedAt` (save-only). Neither field
  // gets a load assignment, yet both remain struct fields, so the Rust driver's
  // explicit `Self { .. }` load literal is incomplete and the model crate fails
  // to compile with E0063 ("missing fields ... in initializer"). Render WITHOUT
  // tests and `cargo build` the model crate.
  //
  // Red-first: on the pre-fix emitter the `Self { .. }` literal lists only the
  // loaded fields and omits `scratch`/`computed_at` → E0063. Green once the
  // driver fills any never-loaded field from `..Default::default()` (every data
  // struct derives `Default`). This is the compile witness for the latent bug the
  // string-asserted `serialization` fixture never exercised because it was never
  // compiled.
  if (!commandExists("cargo")) {
    context.skip("cargo is not available");
    return;
  }
  const fixtureDir = path.join(
    packageRoot,
    "fixtures",
    "features",
    "serialization",
  );
  const outRoot = mkdtempSync(path.join(tmpdir(), "typra-rust-sensitive-"));
  const targetDir = mkdtempSync(
    path.join(tmpdir(), "typra-rust-sensitive-target-"),
  );
  try {
    execFileSync(
      process.execPath,
      [
        path.join(packageRoot, "dist", "src", "cli.js"),
        "--output",
        outRoot,
        "--targets",
        "rust",
        "--spec",
        path.join(fixtureDir, "main.tsp"),
        "--root-object",
        "Typra.Fixtures.Features.Serialization.Root",
        "--deterministic",
        "--no-format",
        "--no-tests",
      ],
      { cwd: packageRoot, stdio: "pipe" },
    );
    const sourceDir = path.join(outRoot, "rust");
    if (!existsSync(sourceDir)) {
      fail("Rust sensitive-never-loaded gate: no rust output generated.");
      return;
    }
    writeFileSync(
      path.join(sourceDir, "Cargo.toml"),
      [
        "[package]",
        'name = "sensitive_never_loaded_compile"',
        'version = "0.0.0"',
        'edition = "2021"',
        "",
        "[dependencies]",
        'async-trait = "0.1"',
        'serde = { version = "1", features = ["derive"] }',
        'serde_json = "1"',
        'serde_yaml = "0.9"',
        "",
        "[features]",
        "serde = []",
        "",
        "[lib]",
        'path = "lib.rs"',
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(sourceDir, "lib.rs"),
      '#[path = "mod.rs"] pub mod model;\n',
    );
    try {
      execFileSync("cargo", ["build"], {
        cwd: sourceDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CARGO_TARGET_DIR: targetDir,
          RUSTFLAGS: "-D warnings",
        },
      });
    } catch (error) {
      const output =
        `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
      fail(
        `Rust sensitive-never-loaded compile gate failed:\n${output || error.message}`,
      );
    }
  } finally {
    for (const dir of [outRoot, targetDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

export function runRustSerializableClosureCompile(context) {
  // Whole-tree COMPILE gate for the "@serializable-closure conformance" defect
  // family (prompty#511). The `serializable-closure-compile` fixture couples a
  // @serializable root with genuinely non-serializable, closure-UNREACHABLE
  // types — including a collection PARENT (`Group`) holding a `Vec` of a
  // non-serializable ELEMENT (`GroupItem`). Their load/save are correctly pruned
  // to plain structs. A driver that emits a per-field `save_<field>`/`load_<field>`
  // helper gated only on "has a collection field" (NOT on closure membership)
  // calls the pruned element codec and fails to compile with E0599 — a failure
  // that per-file string assertions never see. Render WITHOUT tests and
  // `cargo build` the model crate.
  //
  // Red-first: on the pre-2.1.5 emitter `Group` emits `save_items`/`load_items`
  // calling `GroupItem::to_value`/`load_from_value`, which are (correctly) pruned
  // — so the crate fails to compile. Green once the collection-helper emission is
  // gated on the serializable closure (shipped 2.1.5).
  if (!commandExists("cargo")) {
    context.skip("cargo is not available");
    return;
  }
  const fixtureDir = path.join(
    packageRoot,
    "fixtures",
    "features",
    "serializable-closure-compile",
  );
  const outRoot = mkdtempSync(path.join(tmpdir(), "typra-rust-closure-"));
  const targetDir = mkdtempSync(
    path.join(tmpdir(), "typra-rust-closure-target-"),
  );
  try {
    execFileSync(
      process.execPath,
      [
        path.join(packageRoot, "dist", "src", "cli.js"),
        "--output",
        outRoot,
        "--targets",
        "rust",
        "--spec",
        path.join(fixtureDir, "main.tsp"),
        "--root-object",
        "Typra.Fixtures.Features.SerializableClosureCompile.Root",
        "--deterministic",
        "--no-format",
        "--no-tests",
      ],
      { cwd: packageRoot, stdio: "pipe" },
    );
    const sourceDir = path.join(outRoot, "rust");
    if (!existsSync(sourceDir)) {
      fail("Rust serializable-closure gate: no rust output generated.");
      return;
    }
    writeFileSync(
      path.join(sourceDir, "Cargo.toml"),
      [
        "[package]",
        'name = "serializable_closure_compile"',
        'version = "0.0.0"',
        'edition = "2021"',
        "",
        "[dependencies]",
        'async-trait = "0.1"',
        'serde = { version = "1", features = ["derive"] }',
        'serde_json = "1"',
        'serde_yaml = "0.9"',
        "",
        "[features]",
        "serde = []",
        "",
        "[lib]",
        'path = "lib.rs"',
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(sourceDir, "lib.rs"),
      '#[path = "mod.rs"] pub mod model;\n',
    );
    try {
      execFileSync("cargo", ["build"], {
        cwd: sourceDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CARGO_TARGET_DIR: targetDir,
          RUSTFLAGS: "-D warnings",
        },
      });
    } catch (error) {
      const output =
        `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
      fail(
        `Rust serializable-closure compile gate failed:\n${output || error.message}`,
      );
    }
  } finally {
    for (const dir of [outRoot, targetDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}
