import {
  KNOWN_TEST_FAILURES,
  assertKnownTestFailures,
  commandExists,
  cpSync,
  execFileSync,
  existsSync,
  fail,
  generatedRoot,
  mkdtempSync,
  packageRoot,
  path,
  requirePythonRunner,
  rmSync,
  runCommand,
  runPythonCommand,
  tmpdir,
  unlinkSync,
  validationRoot,
  walkFiles,
  writeFileSync,
} from "../harness.mjs";
import {
  assertConformanceResult,
  fixtureRootSampleJsonLiteral,
  imageContentSample,
  propertyCorpusJsonLiteral,
  wireOptionsSample,
} from "../conformance.mjs";

export function runPythonCompile(target = "python") {
  const sourceDir = path.join(generatedRoot, target);
  const sourceFiles = walkFiles(sourceDir, (file) => file.endsWith(".py"));
  if (sourceFiles.length === 0) {
    fail(`No generated ${target} files found to compile.`);
    return;
  }
  runPythonCommand(`Generated ${target} source syntax validation`, [
    "-m",
    "py_compile",
    ...sourceFiles,
  ]);
}

/**
 * Lints the generated Python with ruff's pyflakes (`F`) rules — the
 * "compiler warning" equivalent for Python: unused imports/variables and
 * undefined names. We deliberately scope to `F` rather than ruff's opinionated
 * style rules (import ordering, naming, try/except shape) because the emitter
 * makes intentional choices there (e.g. `_TypeName.py` module names). This gate
 * is what catches regressions like the unused `dataclasses.field` import.
 */
export function runPythonRuffCheck(target = "python") {
  const sourceDir = path.join(generatedRoot, target);
  if (!existsSync(sourceDir)) {
    fail(`No generated ${target} directory found to lint.`);
    return;
  }
  if (!commandExists("uv")) {
    fail(
      `Generated ${target} lint validation cannot run because uv is not available.`,
    );
    return;
  }
  runCommand(
    `Generated ${target} ruff lint validation`,
    "uv",
    [
      "run",
      "--python",
      "3.12",
      "--with",
      "ruff",
      "ruff",
      "check",
      sourceDir,
      "--select",
      "F",
      "--no-cache",
    ],
    { cwd: packageRoot },
  );
}

/**
 * Runs the generated Python tests. Compiling them proved nothing about whether they pass —
 * Python was the last backend whose generated suite was never executed, which is how the
 * literal and factory defects fixed in #107 reached main unnoticed. See #96.
 */
export function runPythonGeneratedTests(
  target = "python",
  packageName = "fixtures",
) {
  const sourceDir = path.join(generatedRoot, target);
  const testsDir = path.join(sourceDir, "tests");
  const testFiles = existsSync(testsDir)
    ? walkFiles(testsDir, (file) => file.endsWith(".py"))
    : [];
  if (testFiles.length === 0) {
    fail(`No generated ${target} tests found to run.`);
    return;
  }
  // The generated tests import a configured package name, but validation target directories are
  // named for their mode. Stage a copy under the import name rather than a symlink: symlinks need
  // elevation on Windows.
  const stageRoot = mkdtempSync(path.join(tmpdir(), `typra-${target}-tests-`));
  const packageDir = path.join(stageRoot, packageName);
  try {
    cpSync(sourceDir, packageDir, {
      recursive: true,
      filter: (source) =>
        !path.basename(source).startsWith("__pycache__") &&
        path.basename(source) !== ".pytest_cache",
    });

    let output = "";
    let crashed = null;
    try {
      const runner = requirePythonRunner(`Generated ${target} tests`);
      if (!runner) return;
      output = execFileSync(
        runner.command,
        [
          ...runner.argsPrefix,
          "-m",
          "pytest",
          path.join(packageDir, "tests"),
          "-q",
          "-p",
          "no:cacheprovider",
        ],
        {
          cwd: stageRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONPATH: stageRoot,
            PYTHONDONTWRITEBYTECODE: "1",
          },
        },
      );
    } catch (error) {
      output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`;
      crashed = error;
    }

    const failed = new Set();
    for (const match of output.matchAll(
      /^(?:FAILED|ERROR)\s+(\S+?)(?:\s|$)/gm,
    )) {
      // pytest prints paths relative to whatever rootdir it infers, so anchor the key to the
      // tests directory instead. A list entry must not break because rootdir moved.
      failed.add(match[1].replace(/^.*?tests[\\/]/, ""));
    }
    assertKnownTestFailures(target, failed, KNOWN_TEST_FAILURES[target], {
      crashed,
      output,
      crashMessage: `Generated ${target} tests failed to collect or run`,
    });
  } finally {
    if (existsSync(stageRoot)) {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

export function runPythonExecutableConformance(
  target = "python",
  packageName = "python",
) {
  const sourceDir = path.join(generatedRoot, target);
  const runner = [
    "import json",
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(path.dirname(sourceDir))})`,
    `from ${packageName} import FixtureBag, FixtureCheckpoint, FixtureClaimedVariant, FixtureConnection, FixtureContent, FixtureCustomTool, FixtureIndexedList, FixtureNamedPayloadCollection, FixtureNamedRoot, FixtureReference, FixtureRoot, FixtureTool, FixtureToolbox, FixtureUnclaimedBase, LoadContext, ModelInfo, SaveContext, WireOptions`,
    `property_cases = json.loads(${propertyCorpusJsonLiteral})`,
    `root = FixtureRoot.load(json.loads(${fixtureRootSampleJsonLiteral}))`,
    "root = FixtureRoot.load(json.loads(json.dumps(root.save())))",
    'checkpoint = FixtureCheckpoint.load({"pendingToolRequests": [{"id": "call-a", "name": "echo"}, {"id": "call-b", "name": "echo"}]})',
    "checkpoint = FixtureCheckpoint.load(json.loads(json.dumps(checkpoint.save())))",
    'assert [request.id for request in checkpoint.pending_tool_requests] == ["call-a", "call-b"]',
    'assert [request.name for request in checkpoint.pending_tool_requests] == ["echo", "echo"]',
    "omitted_model_info = ModelInfo.load({})",
    "assert omitted_model_info.input_modalities is None",
    "assert omitted_model_info.output_modalities == []",
    "assert omitted_model_info.owners is None",
    "assert omitted_model_info.default_owners == []",
    'assert omitted_model_info.save() == {"outputModalities": [], "defaultOwners": []}',
    'explicit_model_info = ModelInfo.load({"inputModalities": [], "outputModalities": []})',
    "assert explicit_model_info.input_modalities == []",
    "assert explicit_model_info.output_modalities == []",
    'assert explicit_model_info.save() == {"inputModalities": [], "outputModalities": [], "defaultOwners": []}',
    `image_content = FixtureContent.load(${JSON.stringify(imageContentSample)})`,
    'known_content = FixtureContent.load({"kind": "text", "value": "hello"}).save()',
    'assert known_content["kind"] == "text" and known_content["value"] == "hello"',
    'for invalid_kind in ("video", "Text"):',
    "    try:",
    '        FixtureContent.load({"kind": invalid_kind, "value": "hello"})',
    "    except ValueError as error:",
    "        message = str(error)",
    '        assert "kind" in message and invalid_kind in message',
    "    else:",
    '        raise AssertionError(f"closed discriminator unexpectedly accepted {invalid_kind}")',
    'unknown_connection_input = {"kind": "future-auth", "name": "future", "config": {"nested": [1, None, {"enabled": True}]}, "nullable": None}',
    "unknown_connection = FixtureConnection.load(unknown_connection_input)",
    'unknown_connection_input["config"]["nested"][0] = 999',
    'unknown_connection.kind = "future-auth-mutated"',
    "unknown_connection_saved = unknown_connection.save()",
    'assert unknown_connection_saved["kind"] == "future-auth-mutated" and unknown_connection_saved["name"] == "future" and unknown_connection_saved["nullable"] is None',
    'assert unknown_connection_saved["config"]["nested"][0] == 1',
    'unknown_connection_saved["config"]["nested"][0] = 777',
    "unknown_connection_saved_again = unknown_connection.save()",
    'assert unknown_connection_saved_again["config"]["nested"][0] == 1',
    "assert FixtureConnection.load(json.loads(json.dumps(unknown_connection_saved_again))).save() == unknown_connection_saved_again",
    'case_collision_input = {"kind": "Custom", "name": "case-sensitive-unknown", "payload": {"mode": "future"}}',
    "case_collision = FixtureConnection.load(case_collision_input)",
    "assert type(case_collision) is FixtureConnection and case_collision.save() == case_collision_input",
    'known_connection = FixtureConnection.load({"kind": "custom", "name": "known", "endpoint": "https://example.test"})',
    'assert type(known_connection) is not FixtureConnection and known_connection.save()["endpoint"] == "https://example.test"',
    'unclaimed = FixtureUnclaimedBase.load({"kind": "plain", "label": "leftover"})',
    'assert type(unclaimed) is FixtureUnclaimedBase and unclaimed.kind == "plain" and unclaimed.label == "leftover", "unclaimed closed discriminator value did not load as the base type"',
    'claimed = FixtureUnclaimedBase.load({"kind": "managed", "label": "known", "resourceId": "res-1"})',
    'assert type(claimed) is FixtureClaimedVariant and claimed.save()["resourceId"] == "res-1", "claimed discriminator value stopped dispatching to its subtype"',
    'for invalid_connection_input in ({}, {"kind": ""}, {"kind": None}, {"kind": 42}):',
    "    try:",
    "        FixtureConnection.load(invalid_connection_input)",
    "    except ValueError as error:",
    "        message = str(error)",
    '        assert "kind" in message or "discriminator" in message',
    "    else:",
    '        raise AssertionError("invalid FixtureConnection discriminator was accepted")',
    'wildcard_tool = FixtureTool.load({"kind": "vendor", "name": "vendor", "description": "vendor description", "connection": {"kind": "future-auth", "name": "future"}, "config": {"enabled": True}})',
    'assert type(wildcard_tool) is FixtureCustomTool, "declared wildcard subtype did not own unknown tool kind"',
    "wildcard_tool_saved = wildcard_tool.save()",
    'assert wildcard_tool_saved["kind"] == "vendor" and wildcard_tool_saved["name"] == "vendor" and wildcard_tool_saved["config"]["enabled"] is True, "wildcard tool payload changed"',
    'assert type(FixtureTool.load(wildcard_tool_saved)) is FixtureCustomTool, "wildcard tool did not survive reload"',
    "try:",
    '    FixtureToolbox.load({"tools": {"custom": {"kind": "vendor"}}, "inheritedMapBindingTool": {"kind": "function", "name": "map", "command": "run"}, "inheritedListBindingTool": {"kind": "function", "name": "list", "command": "run"}})',
    "except ValueError as error:",
    "    diagnostic = str(error)",
    '    assert "tools.custom.connection" in diagnostic and "missing required field" in diagnostic',
    "else:",
    '    raise AssertionError("missing required CustomTool.connection was accepted")',
    `wire = WireOptions.load(${JSON.stringify(wireOptionsSample)})`,
    'reference = FixtureReference.load("ref-coerced")',
    'unique_named = FixtureNamedPayloadCollection.load({"items": [{"name": "alpha", "payload": {"nested": [1, None]}}, {"name": "beta", "payload": "second"}]})',
    "unique_saved = unique_named.save()",
    'assert isinstance(unique_saved["items"], dict) and list(unique_saved["items"]) == ["alpha", "beta"]',
    'lossy_saved = FixtureNamedPayloadCollection.load({"items": [{"payload": {"nested": [1, None]}}, {"name": "", "payload": "second"}]}).save()',
    'assert isinstance(lossy_saved["items"], list) and len(lossy_saved["items"]) == 2 and "name" not in lossy_saved["items"][1]',
    'duplicate_saved = FixtureNamedPayloadCollection.load({"items": [{"name": "dup", "payload": 1}, {"name": "dup", "payload": 2}]}).save()',
    'assert isinstance(duplicate_saved["items"], list) and len(duplicate_saved["items"]) == 2',
    'assert isinstance(unique_named.save(SaveContext(collection_format="array"))["items"], list)',
    'bag = FixtureBag.load({"items": {"alpha": {"note": "first"}}, "secondItems": {"beta": "second"}})',
    'assert len(bag.items) == 1 and bag.items[0].name == "alpha", "named object collection must load into an ordered list"',
    'assert bag.second_items[0].note == "second", "named scalar shorthand must load into the primary field"',
    "object_bag = bag.save()",
    'assert object_bag["items"]["alpha"] == "first", "default object save must use shorthand"',
    "expanded_bag = bag.save(SaveContext(use_shorthand=False))",
    'assert isinstance(expanded_bag["items"]["alpha"], dict), "useShorthand=False must preserve the item object"',
    "try:",
    '    FixtureNamedRoot.load({"inputs": {"profile": {"properties": {"arrayEntry": []}}}})',
    "except TypeError as error:",
    "    message = str(error)",
    '    assert "inputs.profile.properties.arrayEntry" in message and "array" in message',
    "else:",
    '    raise AssertionError("array-valued named entry was accepted")',
    "# Issue #47: a failure inside an array element must carry the element index, so a",
    "# diagnostic cannot silently degrade to naming only the field.",
    "try:",
    '    FixtureIndexedList.load({"entries": [{"label": "first", "detail": {"code": "ok"}}, {"label": "second"}]})',
    "except Exception as error:",
    '    assert "entries[1].detail" in str(error), "array element diagnostic lost the element index: " + str(error)',
    "else:",
    '    raise AssertionError("missing required field inside an array element was accepted")',
    "print(json.dumps({",
    '    "root": root.save(),',
    '    "propertyCases": [{"id": entry["id"], "seed": entry["seed"], "caseId": entry["caseId"], "root": FixtureRoot.load(entry["input"]).save()} for entry in property_cases],',
    '    "imageContent": image_content.save(),',
    '    "openai": wire.to_wire("openai"),',
    '    "openaiRoundTrip": WireOptions.from_wire("openai", wire.to_wire("openai")).to_wire("openai"),',
    '    "anthropic": wire.to_wire("anthropic"),',
    '    "unmapped": wire.to_wire("unmapped-provider"),',
    '    "emptyProvider": wire.to_wire(""),',
    '    "reference": reference.save(),',
    "}, sort_keys=True))",
    "",
  ].join("\n");

  if (!existsSync(sourceDir)) {
    fail(`No generated ${target} directory found for executable conformance.`);
    return;
  }
  const python = requirePythonRunner(
    `Generated ${target} executable conformance`,
  );
  if (!python) return;

  const runnerPath = path.join(validationRoot, `${target}-conformance.py`);
  writeFileSync(runnerPath, runner);
  try {
    const output = execFileSync(
      python.command,
      [...python.argsPrefix, runnerPath],
      {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    assertConformanceResult(target, output);
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated ${target} executable conformance failed:\n${output || error.message}`,
    );
  } finally {
    if (existsSync(runnerPath)) {
      unlinkSync(runnerPath);
    }
  }
}
