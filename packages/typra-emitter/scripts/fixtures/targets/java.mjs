import {
  KNOWN_TEST_FAILURES,
  assertKnownTestFailures,
  execFileSync,
  existsSync,
  fail,
  failures,
  generatedRoot,
  jacksonClasspath,
  javaClasspathArgs,
  javaRuntimeClasspath,
  mkdirSync,
  path,
  rmSync,
  runCommand,
  unlinkSync,
  walkFiles,
  writeFileSync,
} from "../harness.mjs";
import {
  assertConformanceResult,
  fixtureRootSampleJsonLiteral,
  propertyCorpusJsonLiteral,
} from "../conformance.mjs";

export function runJavaBuild() {
  runJavaTargetBuild("java", "Generated Java source build");
}

export function runJavaJacksonBuild() {
  const classpath = jacksonClasspath();
  if (!classpath) return;
  runJavaTargetBuild(
    "java-jackson",
    "Generated Java Jackson source build",
    classpath,
  );
}

export function runJavaTargetBuild(targetDir, label, classpath = "") {
  const sourceDir = path.join(generatedRoot, targetDir);
  const sourceFiles = walkFiles(sourceDir, (file) => file.endsWith(".java"));
  if (sourceFiles.length === 0) {
    fail(`No generated Java files found to build for ${targetDir}.`);
    return;
  }

  const classesDir = path.join(sourceDir, ".classes");
  rmSync(classesDir, { recursive: true, force: true });
  mkdirSync(classesDir, { recursive: true });
  try {
    runCommand(
      label,
      "javac",
      [
        ...javaClasspathArgs(classpath),
        "-Xlint:all",
        "-Werror",
        "-d",
        classesDir,
        ...sourceFiles,
      ],
      { cwd: sourceDir },
    );
  } finally {
    rmSync(classesDir, { recursive: true, force: true });
  }
}

export function runJavaGeneratedTests() {
  runJavaTargetGeneratedTests("java", "Generated Java tests");
}

export function runJavaJacksonGeneratedTests() {
  const classpath = jacksonClasspath();
  if (!classpath) return;
  runJavaTargetGeneratedTests(
    "java-jackson",
    "Generated Java Jackson tests",
    classpath,
  );
}

export function runJavaTargetGeneratedTests(targetDir, label, classpath = "") {
  const sourceDir = path.join(generatedRoot, targetDir);
  const sourceFiles = walkFiles(sourceDir, (file) => file.endsWith(".java"));
  const classesDir = path.join(sourceDir, ".classes");
  const runnerPath = path.join(sourceDir, "TypraGeneratedTestsValidation.java");
  if (sourceFiles.length === 0) {
    fail(`No generated Java files found to test for ${targetDir}.`);
    return;
  }

  rmSync(classesDir, { recursive: true, force: true });
  mkdirSync(classesDir, { recursive: true });
  const generatedTestClasses = walkFiles(
    path.join(sourceDir, "tests"),
    (file) => file.endsWith("GeneratedTest.java"),
  )
    .map((file) => path.basename(file, ".java"))
    .filter((name) => name !== "TypraGeneratedTests")
    .sort((left, right) => left.localeCompare(right));
  if (generatedTestClasses.length === 0) {
    fail("No generated Java test classes found to run.");
    return;
  }
  // The @vector conformance suite (VectorConformanceTests) also exposes a static
  // run() but does not end in GeneratedTest, so include it explicitly when the
  // target emitted it (and its reference adapter has been authored).
  const runClasses = [...generatedTestClasses];
  if (
    existsSync(path.join(sourceDir, "tests", "VectorConformanceTests.java"))
  ) {
    runClasses.push("VectorConformanceTests");
  }
  writeFileSync(
    runnerPath,
    [
      "package typra.fixtures;",
      "",
      "public final class TypraGeneratedTestsValidation {",
      "  private TypraGeneratedTestsValidation() { }",
      "  public static void main(String[] args) {",
      "    int failed = 0;",
      ...runClasses.flatMap((name) => [
        "    try {",
        `      ${name}.run();`,
        `      System.out.println("PASS ${name}");`,
        "    } catch (Throwable error) {",
        "      failed++;",
        `      System.err.println("FAIL ${name}");`,
        "      error.printStackTrace(System.err);",
        "    }",
      ]),
      "    if (failed > 0) System.exit(1);",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  try {
    const initialFailureCount = failures.length;
    runCommand(
      `${label} build`,
      "javac",
      [
        ...javaClasspathArgs(classpath),
        "-Xlint:all",
        "-Werror",
        "-d",
        classesDir,
        ...sourceFiles,
        runnerPath,
      ],
      { cwd: sourceDir },
    );
    if (failures.length > initialFailureCount) return;
    let output = "";
    let crashed = null;
    try {
      output = execFileSync(
        "java",
        [
          "-cp",
          javaRuntimeClasspath(classesDir, classpath),
          "typra.fixtures.TypraGeneratedTestsValidation",
        ],
        { cwd: sourceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`;
      crashed = error;
    }
    const failed = new Set(
      [...output.matchAll(/^FAIL\s+(\S+)/gm)].map((match) => match[1]),
    );
    assertKnownTestFailures(targetDir, failed, KNOWN_TEST_FAILURES[targetDir], {
      crashed,
      output,
      crashMessage: `${label} failed to build or run`,
    });
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`${label} failed:\n${output || error.message}`);
  } finally {
    if (existsSync(runnerPath)) {
      unlinkSync(runnerPath);
    }
    rmSync(classesDir, { recursive: true, force: true });
  }
}

export function runJavaExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "java");
  const sourceFiles = walkFiles(sourceDir, (file) => file.endsWith(".java"));
  const runnerPath = path.join(sourceDir, "ConformanceValidate.java");
  const classesDir = path.join(sourceDir, ".classes");
  if (sourceFiles.length === 0) {
    fail("No generated Java files found for executable conformance.");
    return;
  }

  writeFileSync(
    runnerPath,
    [
      "package typra.fixtures;",
      "",
      "import java.util.LinkedHashMap;",
      "import java.util.List;",
      "import java.util.Map;",
      "import java.util.concurrent.atomic.AtomicInteger;",
      "",
      "public final class ConformanceValidate {",
      "  public static void main(String[] args) {",
      "    Map<String, Object> imageContentData = new LinkedHashMap<>();",
      '    imageContentData.put("kind", "image");',
      '    imageContentData.put("url", "https://example.com/fixture.png");',
      `    FixtureRoot root = FixtureRoot.fromYaml(${fixtureRootSampleJsonLiteral});`,
      `    List<Object> propertyCases = (List<Object>) TypraJson.parse(${propertyCorpusJsonLiteral});`,
      "    List<Object> propertyOutputs = new java.util.ArrayList<>();",
      "    for (Object rawEntry : propertyCases) {",
      "      Map<String, Object> entry = (Map<String, Object>) rawEntry;",
      '      FixtureRoot propertyRoot = FixtureRoot.load((Map<String, Object>) entry.get("input"), new LoadContext());',
      "      Map<String, Object> propertyOutput = new LinkedHashMap<>();",
      '      propertyOutput.put("id", entry.get("id"));',
      '      propertyOutput.put("seed", entry.get("seed"));',
      '      propertyOutput.put("caseId", entry.get("caseId"));',
      '      propertyOutput.put("root", propertyRoot.save(new SaveContext()));',
      "      propertyOutputs.add(propertyOutput);",
      "    }",
      "    Map<String, Object> wireData = new LinkedHashMap<>();",
      '    wireData.put("maxOutputTokens", 256);',
      '    wireData.put("temperature", 0.7);',
      "    FixtureContent imageContent = FixtureContent.fromYaml(TypraYaml.stringify(imageContentData));",
      "    Map<String, Object> exactCaseContentData = new LinkedHashMap<>();",
      '    exactCaseContentData.put("kind", "text");',
      '    exactCaseContentData.put("text", "exact-case discriminator");',
      "    FixtureAbstractContent exactCaseContent = FixtureAbstractContent.load(exactCaseContentData, new LoadContext());",
      '    require(exactCaseContent instanceof FixtureAbstractTextContent, "exact discriminator must dispatch to its abstract variant");',
      '    require("exact-case discriminator".equals(((FixtureAbstractTextContent) exactCaseContent).text), "abstract discriminator dispatch must load variant fields");',
      "    Map<String, Object> wrongCaseContentData = new LinkedHashMap<>();",
      '    wrongCaseContentData.put("kind", "Text");',
      '    wrongCaseContentData.put("text", "wrong-case discriminator");',
      "    boolean wrongCaseRejected = false;",
      "    try {",
      "      FixtureAbstractContent.load(wrongCaseContentData, new LoadContext());",
      "    } catch (IllegalArgumentException expected) {",
      "      wrongCaseRejected = true;",
      "    }",
      '    require(wrongCaseRejected, "polymorphic discriminator dispatch must be case-sensitive");',
      '    FixtureContent knownContent = FixtureContent.load(Map.of("kind", "text", "value", "hello"), new LoadContext());',
      '    require("text".equals(knownContent.save(new SaveContext()).get("kind")) && "hello".equals(knownContent.save(new SaveContext()).get("value")), "closed discriminator known value must round-trip");',
      '    for (String invalidKind : List.of("video", "Text")) {',
      "      try {",
      '        FixtureContent.load(Map.of("kind", invalidKind, "value", "hello"), new LoadContext());',
      '        throw new AssertionError("closed discriminator unexpectedly accepted " + invalidKind);',
      "      } catch (IllegalArgumentException error) {",
      '        require(error.getMessage().contains("kind") && error.getMessage().contains(invalidKind), "closed discriminator error must preserve exact value");',
      "      }",
      "    }",
      "    Map<String, Object> unknownConfig = new LinkedHashMap<>();",
      '    unknownConfig.put("nested", new java.util.ArrayList<>(java.util.Arrays.asList(1, null, Map.of("enabled", true))));',
      "    Map<String, Object> unknownConnectionInput = new LinkedHashMap<>();",
      '    unknownConnectionInput.put("kind", "future-auth");',
      '    unknownConnectionInput.put("name", "future");',
      '    unknownConnectionInput.put("config", unknownConfig);',
      '    unknownConnectionInput.put("nullable", null);',
      "    FixtureConnection unknownConnection = FixtureConnection.load(unknownConnectionInput, new LoadContext());",
      '    ((List<Object>) unknownConfig.get("nested")).set(0, 999);',
      '    unknownConnection.kind = "future-auth-mutated";',
      "    Map<String, Object> unknownConnectionSaved = unknownConnection.save(new SaveContext());",
      '    require("future-auth-mutated".equals(unknownConnectionSaved.get("kind")) && "future".equals(unknownConnectionSaved.get("name")) && unknownConnectionSaved.containsKey("nullable") && unknownConnectionSaved.get("nullable") == null, "unknown connection modeled/null payload changed");',
      '    require(((List<?>) ((Map<?, ?>) unknownConnectionSaved.get("config")).get("nested")).get(0).equals(1), "unknown connection raw payload aliased load input");',
      '    ((List<Object>) ((Map<?, ?>) unknownConnectionSaved.get("config")).get("nested")).set(0, 777);',
      "    Map<String, Object> unknownConnectionSavedAgain = unknownConnection.save(new SaveContext());",
      '    require(((List<?>) ((Map<?, ?>) unknownConnectionSavedAgain.get("config")).get("nested")).get(0).equals(1), "unknown connection raw payload aliased save output");',
      '    require(FixtureConnection.load(unknownConnectionSavedAgain, new LoadContext()).save(new SaveContext()).equals(unknownConnectionSavedAgain), "unknown connection payload did not survive load-save-reload");',
      '    Map<String, Object> caseCollisionInput = new LinkedHashMap<>(Map.of("kind", "Custom", "name", "case-sensitive-unknown", "payload", Map.of("mode", "future")));',
      "    FixtureConnection caseCollision = FixtureConnection.load(caseCollisionInput, new LoadContext());",
      '    require(caseCollision.getClass() == FixtureConnection.class && caseCollision.save(new SaveContext()).equals(caseCollisionInput), "wrong-case connection discriminator did not remain unknown");',
      '    Map<String, Object> wildcardToolInput = new LinkedHashMap<>(Map.of("kind", "vendor", "name", "vendor", "description", "vendor description", "connection", Map.of("kind", "future-auth", "name", "future"), "config", Map.of("enabled", true)));',
      "    FixtureTool wildcardTool = FixtureTool.load(wildcardToolInput, new LoadContext());",
      '    require(wildcardTool.getClass() == FixtureCustomTool.class, "declared wildcard subtype did not own unknown tool kind");',
      "    Map<String, Object> wildcardToolSaved = wildcardTool.save(new SaveContext());",
      '    require("vendor".equals(wildcardToolSaved.get("kind")) && "vendor".equals(wildcardToolSaved.get("name")), "wildcard tool payload changed");',
      '    require(Boolean.TRUE.equals(((Map<?, ?>) wildcardToolSaved.get("config")).get("enabled")), "wildcard tool config payload changed");',
      '    require(FixtureTool.load(wildcardToolSaved, new LoadContext()).getClass() == FixtureCustomTool.class, "wildcard tool did not survive reload");',
      '    FixtureConnection knownConnection = FixtureConnection.load(Map.of("kind", "custom", "name", "known", "endpoint", "https://example.test"), new LoadContext());',
      '    require(knownConnection instanceof FixtureCustomConnection && "https://example.test".equals(knownConnection.save(new SaveContext()).get("endpoint")), "known connection dispatch regressed");',
      '    FixtureUnclaimedBase unclaimed = FixtureUnclaimedBase.load(Map.of("kind", "plain", "label", "leftover"), new LoadContext());',
      '    require(unclaimed.getClass() == FixtureUnclaimedBase.class && "plain".equals(unclaimed.kind) && "leftover".equals(unclaimed.label), "unclaimed closed discriminator value did not load as the base type");',
      '    FixtureUnclaimedBase claimed = FixtureUnclaimedBase.load(Map.of("kind", "managed", "label", "known", "resourceId", "res-1"), new LoadContext());',
      '    require(claimed instanceof FixtureClaimedVariant && "res-1".equals(claimed.save(new SaveContext()).get("resourceId")), "claimed discriminator value stopped dispatching to its subtype");',
      "    List<Map<String, Object>> invalidConnectionInputs = new java.util.ArrayList<>();",
      "    invalidConnectionInputs.add(new LinkedHashMap<>());",
      '    invalidConnectionInputs.add(new LinkedHashMap<>(Map.of("kind", "")));',
      "    Map<String, Object> nullDiscriminatorConnection = new LinkedHashMap<>();",
      '    nullDiscriminatorConnection.put("kind", null);',
      "    invalidConnectionInputs.add(nullDiscriminatorConnection);",
      '    invalidConnectionInputs.add(new LinkedHashMap<>(Map.of("kind", 42)));',
      "    for (Map<String, Object> invalidConnectionInput : invalidConnectionInputs) {",
      "      try {",
      "        FixtureConnection.load(invalidConnectionInput, new LoadContext());",
      '        throw new AssertionError("invalid FixtureConnection discriminator was accepted");',
      "      } catch (IllegalArgumentException error) {",
      '        require(error.getMessage().contains("kind") || error.getMessage().contains("discriminator"), "invalid FixtureConnection discriminator diagnostic lost field context");',
      "      }",
      "    }",
      "    try {",
      '      FixtureToolbox.fromJson("{\\"tools\\":{\\"custom\\":{\\"kind\\":\\"vendor\\"}},\\"inheritedMapBindingTool\\":{\\"kind\\":\\"function\\",\\"name\\":\\"map\\",\\"command\\":\\"run\\"},\\"inheritedListBindingTool\\":{\\"kind\\":\\"function\\",\\"name\\":\\"list\\",\\"command\\":\\"run\\"}}");',
      '      throw new AssertionError("missing required CustomTool.connection was accepted");',
      "    } catch (IllegalArgumentException error) {",
      '      require(error.getMessage().contains("tools.custom.connection") && error.getMessage().contains("missing required field"), "missing required CustomTool.connection diagnostic was not pathful");',
      "    }",
      "    WireOptions wire = WireOptions.load(wireData, new LoadContext());",
      '    FixtureReference reference = FixtureReference.fromYaml("\\"ref-coerced\\"");',
      "    FixtureRoot reloadedRoot = FixtureRoot.fromYaml(root.toYaml());",
      "    FixtureContent reloadedImageContent = FixtureContent.fromYaml(imageContent.toYaml());",
      "    FixtureReference reloadedReference = FixtureReference.fromYaml(reference.toYaml());",
      "",
      "    Map<String, Object> bagItem = new LinkedHashMap<>();",
      '    bagItem.put("note", "first");',
      "    Map<String, Object> bagItems = new LinkedHashMap<>();",
      '    bagItems.put("alpha", bagItem);',
      "    Map<String, Object> bagData = new LinkedHashMap<>();",
      '    bagData.put("items", bagItems);',
      '    bagData.put("secondItems", Map.of("beta", "second"));',
      "    FixtureBag bag = FixtureBag.load(bagData, new LoadContext());",
      '    require(bag.items.size() == 1 && "alpha".equals(bag.items.get(0).name), "named object collection must load into an ordered list");',
      '    require("second".equals(bag.secondItems.get(0).note), "named scalar shorthand must load into the primary field");',
      "    Map<String, Object> objectBag = bag.save(new SaveContext());",
      '    require(objectBag.get("items") instanceof Map<?, ?>, "named collections must save as objects by default");',
      '    require("first".equals(((Map<?, ?>) objectBag.get("items")).get("alpha")), "default object save must use shorthand");',
      '    Map<String, Object> expandedBag = bag.save(new SaveContext(null, null, "object", false));',
      '    require(((Map<?, ?>) expandedBag.get("items")).get("alpha") instanceof Map<?, ?>, "useShorthand=false must preserve the item object");',
      '    Map<String, Object> arrayBag = bag.save(new SaveContext(null, null, "array", true));',
      '    require(arrayBag.get("items") instanceof List<?>, "collectionFormat=array must save named collections as arrays");',
      "    FixtureNamedPayload alpha = new FixtureNamedPayload();",
      '    alpha.name = "alpha";',
      '    alpha.payload = Map.of("nested", java.util.Arrays.asList(1, null));',
      "    FixtureNamedPayload beta = new FixtureNamedPayload();",
      '    beta.name = "beta";',
      '    beta.payload = "second";',
      "    FixtureNamedPayloadCollection uniqueNamed = new FixtureNamedPayloadCollection();",
      "    uniqueNamed.items = new java.util.ArrayList<>(List.of(alpha, beta));",
      '    require(uniqueNamed.save(new SaveContext()).get("items") instanceof Map<?, ?>, "unique named collection did not save as object");',
      "    FixtureNamedPayload unnamed = new FixtureNamedPayload();",
      "    unnamed.payload = alpha.payload;",
      '    beta.name = "";',
      "    FixtureNamedPayloadCollection lossyNamed = new FixtureNamedPayloadCollection();",
      "    lossyNamed.items = new java.util.ArrayList<>(List.of(unnamed, beta));",
      '    require(lossyNamed.save(new SaveContext()).get("items") instanceof List<?> values && values.size() == 2 && !((Map<?, ?>) values.get(1)).containsKey("name"), "unnamed collection did not preserve whole-array fallback");',
      '    alpha.name = "dup"; beta.name = "dup";',
      "    FixtureNamedPayloadCollection duplicateNamed = new FixtureNamedPayloadCollection();",
      "    duplicateNamed.items = new java.util.ArrayList<>(List.of(alpha, beta));",
      '    require(duplicateNamed.save(new SaveContext()).get("items") instanceof List<?> values && values.size() == 2, "duplicate named collection lost entries");',
      '    require(uniqueNamed.save(new SaveContext(null, null, "array", true)).get("items") instanceof List<?>, "explicit array format was ignored");',
      "    try {",
      '      FixtureNamedRoot.load(Map.of("inputs", Map.of("profile", Map.of("properties", Map.of("arrayEntry", List.of())))), new LoadContext());',
      '      throw new AssertionError("array-valued named entry was accepted");',
      "    } catch (IllegalArgumentException error) {",
      '      require(error.getMessage().contains("inputs.profile.properties.arrayEntry") && error.getMessage().contains("array"), "array-valued named entry error lost recursive path");',
      "    }",
      "",
      "    // Issue #47: a failure inside an array element must carry the element index, so a",
      "    // diagnostic cannot silently degrade to naming only the field.",
      "    try {",
      '      FixtureIndexedList.load(Map.of("entries", List.of(Map.of("label", "first", "detail", Map.of("code", "ok")), Map.of("label", "second"))), new LoadContext());',
      '      throw new AssertionError("missing required field inside an array element was accepted");',
      "    } catch (IllegalArgumentException error) {",
      '      require(error.getMessage().contains("entries[1].detail"), "array element diagnostic lost the element index: " + error.getMessage());',
      "    }",
      "",
      "    FixtureUnionProperty union = new FixtureUnionProperty();",
      "    union.anyOf.add(new FixtureProperty());",
      '    require(union.save(new SaveContext()).get("anyOf") instanceof List<?>, "ordinary Property collections must remain arrays");',
      "    union.anyOf.clear();",
      "    AtomicInteger postSaveCount = new AtomicInteger();",
      "    union.save(new SaveContext(null, value -> { postSaveCount.incrementAndGet(); return value; }));",
      '    require(postSaveCount.get() == 1, "derived save must invoke postSave exactly once");',
      "",
      "    FixtureOptionalDefaults optionalDefaults = FixtureOptionalDefaults.load(Map.of(), new LoadContext());",
      '    require(optionalDefaults.mode == null, "omitted optional scalar defaults must remain absent");',
      '    require(!optionalDefaults.save(new SaveContext()).containsKey("mode"), "absent optional scalar defaults must not serialize");',
      '    require(new FixtureRoot().status == FixtureStatus.DRAFT, "required enums must initialize to a valid constant");',
      '    require(new FixtureRoot().save(new SaveContext()).containsKey("status"), "required enums must always serialize");',
      '    require(((Number) TypraJson.parse("1")).longValue() == 1L, "JSON integer parsing must retain its numeric value");',
      '    require(((Number) TypraYaml.parse("1")).longValue() == 1L, "YAML integer parsing must retain its numeric value");',
      "    // The fixture corpus reaches the named escapes but not the general control-character",
      "    // branch, so U+0001 is checked directly: it must not be copied verbatim, and it must",
      "    // survive a round trip through the writer and the reader.",
      '    String controlSample = "a" + ((char) 1) + "b";',
      "    String encodedControl = TypraJson.stringify(controlSample);",
      '    require(encodedControl.indexOf((char) 1) < 0, "control characters must not be copied verbatim into JSON output");',
      '    require(controlSample.equals(TypraJson.parse(encodedControl)), "control characters must round-trip through JSON");',
      "",
      "    Map<String, Object> output = new LinkedHashMap<>();",
      '    output.put("root", reloadedRoot.save(new SaveContext()));',
      '    output.put("propertyCases", propertyOutputs);',
      '    output.put("imageContent", reloadedImageContent.save(new SaveContext()));',
      '    output.put("openai", wire.toWire("openai"));',
      '    output.put("openaiRoundTrip", WireOptions.fromWire("openai", wire.toWire("openai")).toWire("openai"));',
      '    output.put("anthropic", wire.toWire("anthropic"));',
      '    output.put("unmapped", wire.toWire("unmapped-provider"));',
      '    output.put("emptyProvider", wire.toWire(""));',
      '    output.put("reference", reloadedReference.save(new SaveContext()));',
      "    System.out.flush();",
      "    // stdout defaults to the platform charset, which is not UTF-8 on Windows, so the payload",
      "    // is written through an explicit UTF-8 stream. Without this the non-ASCII strings arrive",
      "    // mangled and a harness encoding artifact is misread as an emitter divergence.",
      "    java.io.PrintStream utf8Out = new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true, java.nio.charset.StandardCharsets.UTF_8);",
      "    utf8Out.println(TypraJson.stringify(output));",
      "    utf8Out.flush();",
      "  }",
      "",
      "  private static void require(boolean condition, String message) {",
      "    if (!condition) throw new AssertionError(message);",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  rmSync(classesDir, { recursive: true, force: true });
  mkdirSync(classesDir, { recursive: true });
  try {
    const initialFailureCount = failures.length;
    runCommand(
      "Generated Java executable conformance build",
      "javac",
      ["-d", classesDir, ...sourceFiles, runnerPath],
      { cwd: sourceDir },
    );
    if (failures.length > initialFailureCount) return;
    const output = execFileSync(
      "java",
      ["-cp", classesDir, "typra.fixtures.ConformanceValidate"],
      { cwd: sourceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    assertConformanceResult("java", output);
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated Java executable conformance failed:\n${output || error.message}`,
    );
  } finally {
    if (existsSync(runnerPath)) {
      unlinkSync(runnerPath);
    }
    rmSync(classesDir, { recursive: true, force: true });
  }
}
