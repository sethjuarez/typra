import {
  CSHARP_TARGET_FRAMEWORK,
  KNOWN_TEST_FAILURES,
  assertKnownTestFailures,
  buildCSharpValidationStubs,
  commandExists,
  execFileSync,
  existsSync,
  fail,
  generatedRoot,
  mkdirSync,
  mkdtempSync,
  packageRoot,
  path,
  readFileSync,
  rmSync,
  runCommand,
  tmpdir,
  unlinkSync,
  walkFiles,
  writeFileSync,
} from "../harness.mjs";
import {
  assertConformanceResult,
  fixtureRootNullMetadataJsonLiteral,
  fixtureRootSampleJsonLiteral,
  propertyCorpusJsonLiteral,
} from "../conformance.mjs";

export function runCSharpBuild() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const sourceFiles = walkFiles(
    sourceDir,
    (file) =>
      file.endsWith(".cs") && !file.includes(`${path.sep}tests${path.sep}`),
  );
  if (sourceFiles.length === 0) {
    fail("No generated C# files found to build.");
    return;
  }

  const projectPath = path.join(sourceDir, "TypraFixtureValidation.csproj");
  const stubsPath = path.join(sourceDir, "TypraFixtureValidation.Stubs.cs");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-"));
  const binDir = path.join(outputRoot, "bin");
  const objDir = path.join(outputRoot, "obj");
  writeFileSync(
    projectPath,
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
      "    <Nullable>enable</Nullable>",
      "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "  </PropertyGroup>",
      "  <ItemGroup>",
      '    <Compile Remove="tests/**/*.cs" />',
      '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
  );
  writeFileSync(stubsPath, buildCSharpValidationStubs(sourceDir));
  try {
    runCommand(
      "Generated C# source build",
      "dotnet",
      [
        "build",
        projectPath,
        "--nologo",
        "--verbosity",
        "quiet",
        "-p:BaseOutputPath=" + `${binDir}${path.sep}`,
        "-p:BaseIntermediateOutputPath=" + `${objDir}${path.sep}`,
      ],
      { cwd: sourceDir },
    );
  } finally {
    for (const tempPath of [projectPath, stubsPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(outputRoot)) {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }
}

export function runCSharpConsumerNullabilityBuild() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const libraryProjectPath = path.join(
    sourceDir,
    "TypraFixtureConsumerLibrary.csproj",
  );
  const stubsPath = path.join(
    sourceDir,
    "TypraFixtureConsumerLibrary.Stubs.cs",
  );
  const outputRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-consumer-"));
  const libraryBinDir = path.join(outputRoot, "library-bin");
  const libraryObjDir = path.join(outputRoot, "library-obj");
  const consumerDir = path.join(outputRoot, "consumer");
  const consumerProjectPath = path.join(
    consumerDir,
    "TypraFixtureConsumer.csproj",
  );
  const consumerProgramPath = path.join(consumerDir, "Program.cs");
  mkdirSync(consumerDir, { recursive: true });

  writeFileSync(
    libraryProjectPath,
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
      "    <Nullable>enable</Nullable>",
      "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "    <AssemblyName>TypraFixtureConsumerLibrary</AssemblyName>",
      "  </PropertyGroup>",
      "  <ItemGroup>",
      '    <Compile Remove="tests/**/*.cs" />',
      '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
  );
  writeFileSync(stubsPath, buildCSharpValidationStubs(sourceDir));

  try {
    runCommand(
      "Generated C# consumer library build",
      "dotnet",
      [
        "build",
        libraryProjectPath,
        "--nologo",
        "--verbosity",
        "quiet",
        "-p:BaseOutputPath=" + `${libraryBinDir}${path.sep}`,
        "-p:BaseIntermediateOutputPath=" + `${libraryObjDir}${path.sep}`,
      ],
      { cwd: sourceDir },
    );
    const libraryPath = path.join(
      libraryBinDir,
      "Debug",
      CSHARP_TARGET_FRAMEWORK,
      "TypraFixtureConsumerLibrary.dll",
    );
    if (!existsSync(libraryPath)) {
      fail(`Generated C# consumer library was not found at ${libraryPath}.`);
      return;
    }
    writeFileSync(
      consumerProjectPath,
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        "    <OutputType>Exe</OutputType>",
        `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
        "    <Nullable>enable</Nullable>",
        "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
        "    <ImplicitUsings>enable</ImplicitUsings>",
        "  </PropertyGroup>",
        "  <ItemGroup>",
        '    <Reference Include="TypraFixtureConsumerLibrary">',
        `      <HintPath>${libraryPath}</HintPath>`,
        "    </Reference>",
        "  </ItemGroup>",
        "</Project>",
        "",
      ].join("\n"),
    );
    writeFileSync(
      consumerProgramPath,
      [
        "using Typra.Fixtures;",
        "",
        'IDictionary<string, object?> nullableInterface = new Dictionary<string, object?> { ["null"] = null };',
        'Dictionary<string, object?> nullableConcrete = new() { ["null"] = null };',
        "var value = new FixtureUnknownRecords",
        "{",
        "    RequiredValues = nullableInterface,",
        "    OptionalValues = nullableConcrete,",
        "};",
        'value.RequiredValues["explicitNull"] = null;',
        'value.OptionalValues["explicitNull"] = null;',
        "value.OptionalValues = null;",
        "_ = value.RequiredValues.Count;",
        "_ = value.OptionalValues?.Count;",
        "",
      ].join("\n"),
    );
    runCommand(
      "Generated C# external consumer nullability build",
      "dotnet",
      ["build", consumerProjectPath, "--nologo", "--verbosity", "quiet"],
      { cwd: consumerDir },
    );
  } finally {
    for (const tempPath of [libraryProjectPath, stubsPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(outputRoot)) {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }
}

export function runCSharpGeneratedTests() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const testsDir = path.join(sourceDir, "tests");
  const testFiles = existsSync(testsDir)
    ? walkFiles(testsDir, (file) => file.endsWith(".cs"))
    : [];
  if (testFiles.length === 0) {
    fail("No generated C# tests found to build.");
    return;
  }

  const projectPath = path.join(
    sourceDir,
    "TypraFixtureTestsValidation.csproj",
  );
  const stubsPath = path.join(
    sourceDir,
    "TypraFixtureTestsValidation.Stubs.cs",
  );
  const outputRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-tests-"));
  const binDir = path.join(outputRoot, "bin");
  const objDir = path.join(outputRoot, "obj");
  // Every generated test compiles and runs. Restricting this to a hand-picked file hid the
  // other backends' worth of coverage: 65 generated test files existed and 1 was built. See #94.
  writeFileSync(
    projectPath,
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
      "    <Nullable>enable</Nullable>",
      "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "    <IsTestProject>true</IsTestProject>",
      "    <IsPackable>false</IsPackable>",
      "  </PropertyGroup>",
      "  <ItemGroup>",
      '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />',
      '    <PackageReference Include="xunit" Version="2.9.3" />',
      '    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.4" />',
      '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
  );
  writeFileSync(stubsPath, buildCSharpValidationStubs(sourceDir));
  try {
    if (!commandExists("dotnet")) {
      fail("Generated C# tests cannot run because dotnet is not available.");
      return;
    }
    let output = "";
    let crashed = null;
    try {
      output = execFileSync(
        "dotnet",
        [
          "test",
          projectPath,
          "--nologo",
          "--verbosity",
          "normal",
          "-p:BaseOutputPath=" + `${binDir}${path.sep}`,
          "-p:BaseIntermediateOutputPath=" + `${objDir}${path.sep}`,
        ],
        { cwd: sourceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`;
      crashed = error;
    }

    const failed = new Set();
    for (const match of output.matchAll(
      /^\s*(?:X\s+(\S+?)|Failed\s+([A-Za-z_][\w.]*))(?:\s|\[|$)/gm,
    )) {
      const testName = match[1] ?? match[2];
      if (testName && testName !== "to") failed.add(testName);
    }
    assertKnownTestFailures("csharp", failed, KNOWN_TEST_FAILURES.csharp, {
      crashed,
      output,
      crashMessage: "Generated C# tests failed to build or run",
    });
  } finally {
    for (const tempPath of [projectPath, stubsPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(outputRoot)) {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }
}

export function runCSharpProtocolScaffoldBuild() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const scaffoldPath = path.join(sourceDir, "tests", "ProtocolScaffolds.cs");
  if (!existsSync(scaffoldPath)) {
    fail("No generated C# protocol scaffold found to build.");
    return;
  }

  const projectPath = path.join(
    sourceDir,
    "TypraFixtureScaffoldValidation.csproj",
  );
  const stubsPath = path.join(
    sourceDir,
    "TypraFixtureScaffoldValidation.Stubs.cs",
  );
  const outputRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-scaffold-"));
  const binDir = path.join(outputRoot, "bin");
  const objDir = path.join(outputRoot, "obj");
  writeFileSync(
    projectPath,
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
      "    <Nullable>enable</Nullable>",
      "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "  </PropertyGroup>",
      "  <ItemGroup>",
      '    <Compile Remove="tests/**/*.cs" />',
      '    <Compile Include="tests/ProtocolScaffolds.cs" />',
      '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
  );
  writeFileSync(stubsPath, buildCSharpValidationStubs(sourceDir));
  try {
    runCommand(
      "Generated C# protocol scaffold build",
      "dotnet",
      [
        "build",
        projectPath,
        "--nologo",
        "--verbosity",
        "quiet",
        "-p:BaseOutputPath=" + `${binDir}${path.sep}`,
        "-p:BaseIntermediateOutputPath=" + `${objDir}${path.sep}`,
      ],
      { cwd: sourceDir },
    );
  } finally {
    for (const tempPath of [projectPath, stubsPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(outputRoot)) {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }
}

export function runCSharpExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const projectPath = path.join(sourceDir, "TypraFixtureConformance.csproj");
  const stubsPath = path.join(sourceDir, "TypraFixtureConformance.Stubs.cs");
  const programPath = path.join(
    sourceDir,
    "TypraFixtureConformance.Program.cs",
  );
  const binDir = path.join(sourceDir, "bin");
  const objDir = path.join(sourceDir, "obj");
  if (!existsSync(sourceDir)) {
    fail("No generated C# directory found for executable conformance.");
    return;
  }

  writeFileSync(
    projectPath,
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      "    <OutputType>Exe</OutputType>",
      `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
      "    <Nullable>enable</Nullable>",
      "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "  </PropertyGroup>",
      "  <ItemGroup>",
      '    <Compile Remove="tests/**/*.cs" />',
      '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
  );
  writeFileSync(stubsPath, buildCSharpValidationStubs(sourceDir));
  writeFileSync(
    programPath,
    [
      "using System.Text.Json;",
      "using Typra.Fixtures;",
      "",
      `var root = FixtureRoot.FromJson(${fixtureRootSampleJsonLiteral});`,
      `using var propertyDocument = JsonDocument.Parse(${propertyCorpusJsonLiteral});`,
      "var propertyOutputs = new List<Dictionary<string, object?>>();",
      "foreach (var entry in propertyDocument.RootElement.EnumerateArray())",
      "{",
      '    var propertyRoot = FixtureRoot.FromJson(entry.GetProperty("input").GetRawText());',
      "    propertyOutputs.Add(new Dictionary<string, object?>",
      "    {",
      '        ["id"] = entry.GetProperty("id").GetString(),',
      '        ["seed"] = entry.GetProperty("seed").GetString(),',
      '        ["caseId"] = entry.GetProperty("caseId").GetString(),',
      '        ["root"] = propertyRoot.Save(),',
      "    });",
      "}",
      'if (root.Metadata is null) throw new InvalidOperationException("Record<unknown> metadata must load from the canonical conformance payload");',
      `var nullMetadataRoot = FixtureRoot.FromJson(${fixtureRootNullMetadataJsonLiteral});`,
      "var nullMetadata = nullMetadataRoot.Metadata;",
      'if (nullMetadata is null || !nullMetadata.ContainsKey("nullable") || nullMetadata["nullable"] is not null) throw new InvalidOperationException("Record<unknown> must preserve explicit null values during load");',
      "var savedNullMetadata = nullMetadataRoot.Save();",
      'if (savedNullMetadata["metadata"] is not IDictionary<string, object?> savedMetadata || !savedMetadata.ContainsKey("nullable") || savedMetadata["nullable"] is not null) throw new InvalidOperationException("Record<unknown> must preserve explicit null values during save");',
      "var reloadedRoot = FixtureRoot.Load(savedNullMetadata);",
      'if (reloadedRoot.Metadata is null || !reloadedRoot.Metadata.ContainsKey("nullable") || reloadedRoot.Metadata["nullable"] is not null) throw new InvalidOperationException("Record<unknown> must preserve explicit null values after reload");',
      'IDictionary<string, object?> nullableValues = new Dictionary<string, object?> { ["value"] = "nullable", ["null"] = null };',
      "var unknownRecords = new FixtureUnknownRecords { RequiredValues = nullableValues, OptionalValues = nullableValues };",
      'if (unknownRecords.RequiredValues["null"] is not null || unknownRecords.OptionalValues["null"] is not null) throw new InvalidOperationException("Record<unknown> API must accept nullable-valued dictionaries");',
      "var unknownRecordData = new Dictionary<string, object?>",
      "{",
      '    ["requiredValues"] = new Dictionary<string, object?> { ["null"] = null },',
      '    ["optionalValues"] = new Dictionary<string, object?> { ["null"] = null },',
      "};",
      "var reloadedUnknownRecords = FixtureUnknownRecords.Load(FixtureUnknownRecords.Load(unknownRecordData).Save());",
      'if (reloadedUnknownRecords.RequiredValues["null"] is not null || reloadedUnknownRecords.OptionalValues?["null"] is not null) throw new InvalidOperationException("Record<unknown> null values must survive load/save/reload");',
      "unknownRecords.OptionalValues = null;",
      'if (unknownRecords.OptionalValues is not null) throw new InvalidOperationException("optional Record<unknown> must accept an absent dictionary");',
      'var wire = WireOptions.Load(new Dictionary<string, object?> { ["maxOutputTokens"] = 256, ["temperature"] = 0.7 });',
      'var imageContent = FixtureContent.Load(new Dictionary<string, object?> { ["kind"] = "image", ["url"] = "https://example.com/fixture.png" });',
      'var knownContent = FixtureContent.Load(new Dictionary<string, object?> { ["kind"] = "text", ["value"] = "hello" }).Save();',
      'if (!Equals(knownContent["kind"], "text") || !Equals(knownContent["value"], "hello")) throw new InvalidOperationException("closed discriminator known value did not round-trip");',
      'foreach (var invalidKind in new[] { "video", "Text" })',
      "{",
      "    try",
      "    {",
      '        FixtureContent.Load(new Dictionary<string, object?> { ["kind"] = invalidKind, ["value"] = "hello" });',
      '        throw new InvalidOperationException($"closed discriminator unexpectedly accepted {invalidKind}");',
      "    }",
      "    catch (ArgumentException error)",
      "    {",
      '        if (!error.Message.Contains("kind") || !error.Message.Contains(invalidKind)) throw;',
      "    }",
      "}",
      "var unknownConnectionInput = new Dictionary<string, object?>",
      "{",
      '    ["kind"] = "future-auth",',
      '    ["name"] = "future",',
      '    ["config"] = new Dictionary<string, object?> { ["nested"] = new List<object?> { 1, null, new Dictionary<string, object?> { ["enabled"] = true } } },',
      '    ["nullable"] = null,',
      "};",
      "var unknownConnection = FixtureConnection.Load(unknownConnectionInput);",
      '((List<object?>)((Dictionary<string, object?>)unknownConnectionInput["config"]!)["nested"]!)[0] = 999;',
      'unknownConnection.Kind = "future-auth-mutated";',
      "var unknownConnectionSaved = unknownConnection.Save();",
      'if (!Equals(unknownConnectionSaved["kind"], "future-auth-mutated") || !Equals(unknownConnectionSaved["name"], "future") || !unknownConnectionSaved.ContainsKey("nullable") || unknownConnectionSaved["nullable"] is not null) throw new InvalidOperationException("unknown connection modeled/null payload changed");',
      'if (((List<object?>)((Dictionary<string, object?>)unknownConnectionSaved["config"]!)["nested"]!)[0] is not int first || first != 1) throw new InvalidOperationException("unknown connection raw payload aliased load input");',
      '((List<object?>)((Dictionary<string, object?>)unknownConnectionSaved["config"]!)["nested"]!)[0] = 777;',
      "var unknownConnectionSavedAgain = unknownConnection.Save();",
      'if (((List<object?>)((Dictionary<string, object?>)unknownConnectionSavedAgain["config"]!)["nested"]!)[0] is not int second || second != 1) throw new InvalidOperationException("unknown connection raw payload aliased save output");',
      "var unknownConnectionReloaded = FixtureConnection.Load(unknownConnectionSavedAgain).Save();",
      'if (JsonSerializer.Serialize(unknownConnectionReloaded) != JsonSerializer.Serialize(unknownConnectionSavedAgain)) throw new InvalidOperationException("unknown connection payload did not survive reload");',
      'var caseCollisionInput = new Dictionary<string, object?> { ["kind"] = "Custom", ["name"] = "case-sensitive-unknown", ["payload"] = new Dictionary<string, object?> { ["mode"] = "future" } };',
      "var caseCollision = FixtureConnection.Load(caseCollisionInput);",
      'if (caseCollision.GetType() != typeof(FixtureConnection) || JsonSerializer.Serialize(caseCollision.Save()) != JsonSerializer.Serialize(caseCollisionInput)) throw new InvalidOperationException("wrong-case connection discriminator did not remain unknown");',
      'var wildcardToolInput = new Dictionary<string, object?> { ["kind"] = "vendor", ["name"] = "vendor", ["description"] = "vendor description", ["connection"] = new Dictionary<string, object?> { ["kind"] = "future-auth", ["name"] = "future" }, ["config"] = new Dictionary<string, object?> { ["enabled"] = true } };',
      "var wildcardTool = FixtureTool.Load(wildcardToolInput);",
      'if (wildcardTool.GetType() != typeof(FixtureCustomTool)) throw new InvalidOperationException("declared wildcard subtype did not own unknown tool kind");',
      "var wildcardToolSaved = wildcardTool.Save();",
      'if (!Equals(wildcardToolSaved["kind"], "vendor") || !Equals(wildcardToolSaved["name"], "vendor")) throw new InvalidOperationException("wildcard tool payload changed");',
      'if (((Dictionary<string, object?>)wildcardToolSaved["config"]!)["enabled"] is not bool wildcardEnabled || !wildcardEnabled) throw new InvalidOperationException("wildcard tool config payload changed");',
      'if (FixtureTool.Load(wildcardToolSaved).GetType() != typeof(FixtureCustomTool)) throw new InvalidOperationException("wildcard tool did not survive reload");',
      'var knownConnection = FixtureConnection.Load(new Dictionary<string, object?> { ["kind"] = "custom", ["name"] = "known", ["endpoint"] = "https://example.test" });',
      'if (knownConnection.GetType() == typeof(FixtureConnection) || !Equals(knownConnection.Save()["endpoint"], "https://example.test")) throw new InvalidOperationException("known connection dispatch regressed");',
      'var unclaimed = FixtureUnclaimedBase.Load(new Dictionary<string, object?> { ["kind"] = "plain", ["label"] = "leftover" });',
      'if (unclaimed.GetType() != typeof(FixtureUnclaimedBase) || unclaimed.Kind != "plain" || unclaimed.Label != "leftover") throw new InvalidOperationException("unclaimed closed discriminator value did not load as the base type");',
      'var claimed = FixtureUnclaimedBase.Load(new Dictionary<string, object?> { ["kind"] = "managed", ["label"] = "known", ["resourceId"] = "res-1" });',
      'if (claimed.GetType() != typeof(FixtureClaimedVariant) || !Equals(claimed.Save()["resourceId"], "res-1")) throw new InvalidOperationException("claimed discriminator value stopped dispatching to its subtype");',
      "foreach (var invalidConnectionInput in new Dictionary<string, object?>[]",
      "{",
      "    new(),",
      '    new() { ["kind"] = "" },',
      '    new() { ["kind"] = null },',
      '    new() { ["kind"] = 42 },',
      "})",
      "{",
      "    try",
      "    {",
      "        FixtureConnection.Load(invalidConnectionInput);",
      '        throw new InvalidOperationException("invalid FixtureConnection discriminator was accepted");',
      "    }",
      "    catch (ArgumentException error)",
      "    {",
      '        if (!error.Message.Contains("kind") && !error.Message.Contains("discriminator")) throw;',
      "    }",
      "}",
      'try { FixtureToolbox.FromJson("""{"tools":{"custom":{"kind":"vendor"}},"inheritedMapBindingTool":{"kind":"function","name":"map","command":"run"},"inheritedListBindingTool":{"kind":"function","name":"list","command":"run"}}"""); throw new InvalidOperationException("missing required CustomTool.connection was accepted"); } catch (ArgumentException error) { if (!error.Message.Contains("tools.custom.connection") || !error.Message.Contains("missing required field")) throw; }',
      'var reference = FixtureReference.FromJson("\\"ref-coerced\\"");',
      'var uniqueNamed = FixtureNamedPayloadCollection.FromJson("""{"items":[{"name":"alpha","payload":{"nested":[1,null]}},{"name":"beta","payload":"second"}]}""");',
      'if (uniqueNamed.Save()["items"] is not IDictionary<string, object?> uniqueItems || uniqueItems.Count != 2) throw new InvalidOperationException("unique named collection did not save as object");',
      'var lossyNamed = FixtureNamedPayloadCollection.FromJson("""{"items":[{"payload":{"nested":[1,null]}},{"name":"","payload":"second"}]}""");',
      'if (lossyNamed.Save()["items"] is not IList<Dictionary<string, object?>> lossyItems || lossyItems.Count != 2 || lossyItems[1].ContainsKey("name")) throw new InvalidOperationException("unnamed collection did not preserve whole-array fallback");',
      'var duplicateNamed = FixtureNamedPayloadCollection.FromJson("""{"items":[{"name":"dup","payload":1},{"name":"dup","payload":2}]}""");',
      'if (duplicateNamed.Save()["items"] is not IList<Dictionary<string, object?>> duplicateItems || duplicateItems.Count != 2) throw new InvalidOperationException("duplicate named collection lost entries");',
      'var functionBindingInput = new Dictionary<string, object?> { ["source"] = "preferred_unit" };',
      'var functionToolFromMap = FixtureFunctionTool.Load(new Dictionary<string, object?> { ["kind"] = "function", ["name"] = "convert", ["command"] = "convert", ["bindings"] = new Dictionary<string, object?> { ["unit"] = functionBindingInput } });',
      'if (functionToolFromMap.Bindings is not { Count: 1 } || functionToolFromMap.Bindings[0].Name != "unit" || functionToolFromMap.Bindings[0].Source != "preferred_unit") throw new InvalidOperationException("direct derived loader lost named-map bindings");',
      'if (functionBindingInput.ContainsKey("name")) throw new InvalidOperationException("named-map load mutated its input binding");',
      'foreach (var bindingKey in new[] { "unit", "unitMUT" })',
      "{",
      '    var bindingSource = $"preferred_{bindingKey}";',
      '    var functionTool = FixtureFunctionTool.Load(new Dictionary<string, object?> { ["kind"] = "function", ["name"] = "convert", ["command"] = "convert", ["bindings"] = new Dictionary<string, object?> { [bindingKey] = bindingSource } });',
      '    if (functionTool.Bindings is not { Count: 1 } || functionTool.Bindings[0].Name != bindingKey || functionTool.Bindings[0].Source != bindingSource) throw new InvalidOperationException("direct derived loader lost named scalar bindings");',
      "    var functionToolSaved = functionTool.Save();",
      '    if (functionToolSaved["bindings"] is not IDictionary<string, object?> bindings || !Equals(bindings[bindingKey], bindingSource)) throw new InvalidOperationException("named scalar bindings did not save canonically");',
      "    var functionToolReloaded = FixtureFunctionTool.Load(functionToolSaved);",
      '    if (functionToolReloaded.Bindings is not { Count: 1 } || functionToolReloaded.Bindings[0].Name != bindingKey || functionToolReloaded.Bindings[0].Source != bindingSource) throw new InvalidOperationException("direct derived named scalar bindings did not survive reload");',
      "}",
      'var yamlFunctionTool = FixtureFunctionTool.FromYaml("""',
      "kind: function",
      "name: convert",
      "command: convert",
      "bindings:",
      "  unit:",
      "    source: preferred_unit",
      '""");',
      'if (yamlFunctionTool.Bindings is not { Count: 1 } || yamlFunctionTool.Bindings[0].Name != "unit" || yamlFunctionTool.Bindings[0].Source != "preferred_unit") throw new InvalidOperationException("YAML named-map bindings diverged from JSON");',
      'var arrayFunctionTool = FixtureFunctionTool.FromJson("""{"kind":"function","name":"convert","command":"convert","bindings":[{"name":"unit","source":"preferred_unit"}]}""");',
      'if (arrayFunctionTool.Bindings is not { Count: 1 } || arrayFunctionTool.Bindings[0].Name != "unit" || arrayFunctionTool.Bindings[0].Source != "preferred_unit") throw new InvalidOperationException("array-form bindings regressed");',
      'if (uniqueNamed.Save(new SaveContext { CollectionFormat = "array" })["items"] is not IList<Dictionary<string, object?>>) throw new InvalidOperationException("explicit array format was ignored");',
      'var bag = FixtureBag.FromJson("""{"items":{"alpha":{"note":"first"}},"secondItems":{"beta":"second"}}""");',
      'if (bag.Items.Count != 1 || bag.Items[0].Name != "alpha") throw new InvalidOperationException("named object collection must load into an ordered list");',
      'if (bag.SecondItems[0].Note != "second") throw new InvalidOperationException("named scalar shorthand must load into the primary field");',
      'if (bag.Save()["items"] is not IDictionary<string, object?> bagItems || bagItems["alpha"] as string != "first") throw new InvalidOperationException("default object save must use shorthand");',
      'if (bag.Save(new SaveContext { UseShorthand = false })["items"] is not IDictionary<string, object?> expandedBagItems || expandedBagItems["alpha"] is not IDictionary<string, object?>) throw new InvalidOperationException("useShorthand=false must preserve the item object");',
      'try { FixtureNamedRoot.FromJson("""{"inputs":{"profile":{"properties":{"arrayEntry":[]}}}}"""); throw new InvalidOperationException("array-valued named entry was accepted"); } catch (ArgumentException error) { if (!error.Message.Contains("inputs.profile.properties.arrayEntry") || !error.Message.Contains("array")) throw; }',
      "// Issue #47: a failure inside an array element must carry the element index, so a",
      "// diagnostic cannot silently degrade to naming only the field.",
      'try { FixtureIndexedList.FromJson("""{"entries":[{"label":"first","detail":{"code":"ok"}},{"label":"second"}]}"""); throw new InvalidOperationException("missing required field inside an array element was accepted"); } catch (ArgumentException error) { if (!error.Message.Contains("entries[1].detail")) throw new InvalidOperationException("array element diagnostic lost the element index: " + error.Message); }',
      "Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object?>",
      "{",
      '    ["root"] = root.Save(),',
      '    ["propertyCases"] = propertyOutputs,',
      '    ["imageContent"] = imageContent.Save(),',
      '    ["openai"] = wire.ToWire("openai"),',
      '    ["openaiRoundTrip"] = WireOptions.FromWire("openai", wire.ToWire("openai")).ToWire("openai"),',
      '    ["anthropic"] = wire.ToWire("anthropic"),',
      '    ["unmapped"] = wire.ToWire("unmapped-provider"),',
      '    ["emptyProvider"] = wire.ToWire(""),',
      '    ["reference"] = reference.Save(),',
      "}));",
      "",
    ].join("\n"),
  );

  try {
    const output = execFileSync(
      "dotnet",
      ["run", "--project", projectPath, "--verbosity", "quiet"],
      { cwd: sourceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    assertConformanceResult("csharp", output);
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated C# executable conformance failed:\n${output || error.message}`,
    );
  } finally {
    for (const tempPath of [projectPath, stubsPath, programPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    for (const tempDir of [binDir, objDir]) {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }
}

export function runCSharpVectorConformanceCompile(context) {
  // Red-first gate for the typed conformance ENTRYPOINT (issue #511 Cat 1,
  // typra#306 Track A). The emitter emits `VectorConformance.Run<Seam>-
  // ConformanceAsync(seam)` into the LIBRARY beside the seam interface; a
  // consumer migrates a plain seam off the stringly VectorRunner registry by
  // authoring only a real ITransformer impl and one typed call. This gate
  // proves that path stands ALONE: generate the typed-seam-conformance fixture,
  // DROP the stringly-rail `tests/` package (VectorRunner + the monolithic
  // VectorConformanceTests that need a hand-authored Conformance adapter), attach
  // the committed typed double, and `dotnet test`.
  //
  // Red-first: if the entrypoint is not emitted, VectorConformance.cs does not
  // exist and the double cannot resolve the entrypoint — so this fails on `main`.
  if (!commandExists("dotnet")) {
    context.skip("dotnet is not available");
    return;
  }
  const fixtureDir = path.join(
    packageRoot,
    "fixtures",
    "features",
    "typed-seam-conformance",
  );
  const outRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-typedseam-"));
  const buildRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-typedseam-o-"));
  try {
    execFileSync(
      process.execPath,
      [
        path.join(packageRoot, "dist", "src", "cli.js"),
        "--output",
        outRoot,
        "--targets",
        "csharp",
        "--spec",
        path.join(fixtureDir, "main.tsp"),
        "--root-object",
        "Typra.Fixtures.Features.TypedSeamConformance.Root",
        "--deterministic",
        "--no-format",
      ],
      { cwd: packageRoot, stdio: "pipe" },
    );
    const sourceDir = path.join(outRoot, "csharp");
    if (!existsSync(sourceDir)) {
      fail("C# typed-seam-conformance gate: no csharp output generated.");
      return;
    }
    if (!existsSync(path.join(sourceDir, "VectorConformance.cs"))) {
      fail(
        "C# typed-seam-conformance gate: emitter did not emit " +
          "VectorConformance.cs (the typed conformance entrypoint). The " +
          "committed double cannot resolve VectorConformance — this is the " +
          "red-first signal.",
      );
      return;
    }
    // The typed entrypoint stands alone: drop the stringly rail (VectorRunner +
    // the monolithic VectorConformanceTests) that would otherwise need a
    // hand-authored Conformance adapter namespace to compile.
    const stringlyTests = path.join(sourceDir, "tests");
    if (existsSync(stringlyTests)) {
      rmSync(stringlyTests, { recursive: true, force: true });
    }
    // Attach the committed typed double + a validation stubs shim (any hydration
    // `I<Type>Helpers` a consumer would implement), then a single test csproj
    // that compiles the emitted library + entrypoint + double and runs xUnit.
    writeFileSync(
      path.join(sourceDir, "TypedConformanceTests.cs"),
      readFileSync(
        path.join(fixtureDir, "vector-adapters", "csharp", "TypedConformanceTests.cs"),
        "utf8",
      ),
    );
    writeFileSync(
      path.join(sourceDir, "TypraTypedSeamConformance.Stubs.cs"),
      buildCSharpValidationStubs(sourceDir),
    );
    const projectPath = path.join(
      sourceDir,
      "TypraTypedSeamConformance.csproj",
    );
    writeFileSync(
      projectPath,
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
        "    <Nullable>enable</Nullable>",
        "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
        "    <ImplicitUsings>enable</ImplicitUsings>",
        "    <IsTestProject>true</IsTestProject>",
        "    <IsPackable>false</IsPackable>",
        "  </PropertyGroup>",
        "  <ItemGroup>",
        '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />',
        '    <PackageReference Include="xunit" Version="2.9.3" />',
        '    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.4" />',
        '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
        "  </ItemGroup>",
        "</Project>",
        "",
      ].join("\n"),
    );
    try {
      execFileSync(
        "dotnet",
        [
          "test",
          projectPath,
          "--nologo",
          "--verbosity",
          "quiet",
          "-p:BaseOutputPath=" + `${path.join(buildRoot, "bin")}${path.sep}`,
          "-p:BaseIntermediateOutputPath=" +
            `${path.join(buildRoot, "obj")}${path.sep}`,
        ],
        { cwd: sourceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      const output =
        `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
      fail(
        `C# typed-seam-conformance compile/run gate failed:\n${output || error.message}`,
      );
    }
  } finally {
    for (const tempDir of [outRoot, buildRoot]) {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }
}
