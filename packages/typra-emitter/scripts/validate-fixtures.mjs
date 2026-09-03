import {
  assertArrayIncludes,
  assertExcludes,
  assertIncludes,
  assertMarkdownFrontmatterFirst,
  AUTHORED_VECTOR_ADAPTER_SEGMENTS,
  execFileSync,
  existsSync,
  fail,
  failures,
  generatedRoot,
  isGeneratedTextFile,
  mkdirSync,
  packageRoot,
  path,
  readFileSync,
  readJson,
  requirePath,
  runExpectedExecutionPlan,
  statSync,
  toPascalCase,
  unlinkSync,
  validationRoot,
  walkFiles,
  writeFileSync,
} from "./fixtures/harness.mjs";
import {
  assertExecutableConformanceAgreement,
  assertExecutableConformanceCoverage,
} from "./fixtures/conformance.mjs";
import {
  runGeneratedTypeScriptCompile,
  runGeneratedTypeScriptWebCompile,
  runGeneratedTypeScriptZodCompile,
  runGeneratedTypeScriptZodWebCompile,
  runTypeScriptExecutableConformance,
  runTypeScriptGeneratedTests,
  runTypeScriptVectorConformanceCompile,
  runTypeScriptWebRuntimeSmoke,
  runTypeScriptZodExecutableConformance,
  runTypeScriptZodWebRuntimeSmoke,
} from "./fixtures/targets/typescript.mjs";
import {
  runPythonCompile,
  runPythonExecutableConformance,
  runPythonGeneratedTests,
  runPythonRuffCheck,
  runPythonVectorConformanceCompile,
} from "./fixtures/targets/python.mjs";
import {
  runGoExecutableConformance,
  runGoTests,
  runGoVectorBridgeCompile,
  runGoVectorConformanceCompile,
} from "./fixtures/targets/go.mjs";
import {
  runRustDispatchRegressionCompile,
  runRustExecutableConformance,
  runRustTests,
  runRustUnknownAbstractConformance,
  runRustVectorConformanceCompile,
} from "./fixtures/targets/rust.mjs";
import {
  runCSharpBuild,
  runCSharpConsumerNullabilityBuild,
  runCSharpExecutableConformance,
  runCSharpGeneratedTests,
  runCSharpProtocolScaffoldBuild,
  runCSharpVectorConformanceCompile,
} from "./fixtures/targets/csharp.mjs";
import {
  runJavaBuild,
  runJavaExecutableConformance,
  runJavaGeneratedTests,
  runJavaJacksonBuild,
  runJavaJacksonGeneratedTests,
  runJavaVectorConformanceCompile,
} from "./fixtures/targets/java.mjs";
import {
  runSwiftCodableExecutableConformance,
  runSwiftCodableTests,
  runSwiftExecutableConformance,
  runSwiftTests,
  runSwiftVectorConformanceCompile,
} from "./fixtures/targets/swift.mjs";
import { runIdempotencyGuard } from "./fixtures/idempotency-runner.mjs";
import {
  IDEMPOTENCY_TARGETS,
  idempotencyAllowedSkips,
} from "./idempotency-guard.mjs";
import {
  REQUIRED_CONFORMANCE_MATRIX_TARGETS,
  validateConformanceMatrix,
} from "./conformance-matrix-policy.mjs";

const EXPECTED_VALIDATION_STAGE_IDS = [
  "generated-targets",
  "empty-target-dirs",
  "output-hygiene",
  "structured-load-coverage",
  "focused-feature-fixtures",
  "static-fixture-coverage",
  "static-conformance-matrix",
  "export-surface-snapshot",
  "hydration-boundary-snapshot",
  "generated-output-report",
  "actual-generated-surface",
  "typra-verify",
  "consumer-smoke",
  "vector-adapters.author",
  "typescript.compile",
  "typescript-zod.compile",
  "typescript.web-compile",
  "typescript-zod.web-compile",
  "typescript.web-runtime",
  "typescript-zod.web-runtime",
  "typescript.runtime-neutrality",
  "typescript.generated-tests",
  "typescript.vector-conformance-compile",
  "python.compile",
  "python_pydantic.compile",
  "python.lint",
  "python_pydantic.lint",
  "python.generated-tests",
  "python_pydantic.generated-tests",
  "python.vector-conformance-compile",
  "go.generated-tests",
  "go.vector-bridge-compile",
  "go.vector-conformance-compile",
  "rust.generated-tests",
  "rust.dispatch-regression-compile",
  "rust.vector-conformance-compile",
  "rust-serde.generated-tests",
  "swift.generated-tests",
  "swift.vector-conformance-compile",
  "swift-codable.generated-tests",
  "csharp.build",
  "csharp.consumer-nullability-build",
  "csharp.generated-tests",
  "csharp.protocol-scaffold-build",
  "csharp.vector-conformance-compile",
  "java.build",
  "java.generated-tests",
  "java.vector-conformance-compile",
  "java-jackson.build",
  "java-jackson.generated-tests",
  ...IDEMPOTENCY_TARGETS.map((target) => target.stageId),
  "executable-conformance",
];

const EXPECTED_EXECUTABLE_CONFORMANCE_TARGET_IDS = [
  "typescript",
  "typescript-zod",
  "python",
  "python_pydantic",
  "go",
  "rust",
  "rust-serde",
  "rust-unknown",
  "csharp",
  "java",
  "swift",
  "swift-codable",
];

function assertConformanceMatrix() {
  const matrix = readJson(path.join("fixtures", "conformance-matrix.json"));
  if (!matrix) return;

  const policyComparison = validateConformanceMatrix(matrix);
  for (const message of policyComparison.failures) {
    fail(message);
  }

  if (!Array.isArray(matrix.cases) || matrix.cases.length === 0) {
    return;
  }
  if (!Array.isArray(matrix.rules) || matrix.rules.length === 0) {
    return;
  }

  const caseIds = new Set();
  for (const conformanceCase of matrix.cases) {
    if (!conformanceCase.id) {
      fail("Conformance matrix contains a case without an id.");
      continue;
    }
    if (caseIds.has(conformanceCase.id)) {
      fail(
        `Conformance matrix contains duplicate case id: ${conformanceCase.id}`,
      );
    }
    caseIds.add(conformanceCase.id);
  }

  const enforcedCases = new Set();
  for (const rule of matrix.rules) {
    if (
      !rule ||
      typeof rule !== "object" ||
      Array.isArray(rule) ||
      typeof rule.id !== "string" ||
      rule.id.length === 0
    ) {
      continue;
    }

    if (rule.status === "enforced") {
      if (rule.verification === "fixture-evidence") {
        if (!rule.case) {
          fail(
            `Enforced fixture-evidence rule ${rule.id} must reference a case.`,
          );
        } else if (!caseIds.has(rule.case)) {
          fail(
            `Enforced conformance rule ${rule.id} references unknown case ${rule.case}.`,
          );
        } else {
          enforcedCases.add(rule.case);
        }
      } else if (rule.verification === "unit-test") {
        if (Object.prototype.hasOwnProperty.call(rule, "case")) {
          fail(
            `Unit-test conformance rule ${rule.id} must not reference a fixture case.`,
          );
        }
      }
      if (
        (rule.verification === "unit-test" ||
          Object.prototype.hasOwnProperty.call(rule, "test")) &&
        (typeof rule.test !== "string" ||
          !existsSync(path.join(packageRoot, "..", "..", rule.test)))
      ) {
        fail(
          `Enforced conformance rule ${rule.id} must reference an existing test file.`,
        );
      }
    } else if (rule.status === "known-gap") {
      if (Object.prototype.hasOwnProperty.call(rule, "case")) {
        fail(
          `Known-gap conformance rule ${rule.id} must not reference a case until it is promoted to enforced.`,
        );
      }
      if (caseIds.has(rule.id)) {
        fail(
          `Known-gap conformance rule ${rule.id} collides with an existing case id.`,
        );
      }
    }
  }

  for (const conformanceCase of matrix.cases) {
    if (!enforcedCases.has(conformanceCase.id)) {
      fail(
        `Conformance case ${conformanceCase.id} is not referenced by an enforced rule.`,
      );
    }
  }

  for (const conformanceCase of matrix.cases) {
    const evidenceTargets = [
      ...new Set([
        ...REQUIRED_CONFORMANCE_MATRIX_TARGETS,
        ...Object.keys(conformanceCase.evidence ?? {}),
      ]),
    ];
    for (const target of evidenceTargets) {
      const evidence = conformanceCase.evidence?.[target];
      if (!Array.isArray(evidence) || evidence.length === 0) {
        fail(
          `Conformance case ${conformanceCase.id} is missing evidence for target ${target}.`,
        );
        continue;
      }

      for (const item of evidence) {
        if (!item.path) {
          fail(
            `Conformance case ${conformanceCase.id}/${target} contains evidence without a path.`,
          );
          continue;
        }
        if (!Array.isArray(item.snippets) || item.snippets.length === 0) {
          fail(
            `Conformance case ${conformanceCase.id}/${target}/${item.path} has no snippets.`,
          );
          continue;
        }
        assertIncludes(item.path, ...item.snippets);
      }
    }
  }
}

function findFocusedFeatureFixtures() {
  return walkFiles(path.join(packageRoot, "fixtures", "features"), (filePath) =>
    filePath.endsWith(`${path.sep}main.tsp`),
  ).sort();
}

function assertGeneratedOutputHygiene() {
  for (const file of walkFiles(generatedRoot, isGeneratedTextFile)) {
    const relativePath = path.relative(packageRoot, file);
    const content = readFileSync(file, "utf8");
    const basename = path.basename(file);

    if (content.includes("\r")) {
      fail(`${relativePath} must use LF line endings.`);
    }
    if (content.length === 0 && basename !== "py.typed") {
      fail(`${relativePath} must not be empty.`);
      continue;
    }
    if (content.length > 0 && !content.endsWith("\n")) {
      fail(`${relativePath} must end with a newline.`);
    }
    if (isMarkerOnlyContent(content)) {
      fail(`${relativePath} must not contain only the generated marker.`);
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (/[ \t]+$/.test(lines[index])) {
        fail(`${relativePath}:${index + 1} has trailing whitespace.`);
      }
    }
  }
}

// Node builtins whose presence in the shipped TypeScript library would couple
// the generated code to a Node runtime and break web/edge/Deno consumers. The
// generated library must stay runtime-neutral: host capabilities (transport,
// file/env resolution, YAML) are injected or centralized behind a seam, never
// imported directly into the emitted model classes. The injected
// TypraFetchTransport in the generated fetch client is the intended pattern.
const NODE_ONLY_MODULES = new Set([
  "fs",
  "fs/promises",
  "path",
  "os",
  "crypto",
  "stream",
  "util",
  "child_process",
  "http",
  "https",
  "net",
  "tls",
  "zlib",
  "events",
  "url",
  "process",
  "module",
  "worker_threads",
  "buffer",
  "readline",
  "dns",
  "cluster",
  "vm",
  "perf_hooks",
]);

// The @vector conformance runner, generated tests, and consumer-authored vector
// adapters legitimately run under Node and live under each target's `tests/` dir
// (or are authored, not emitted), so they are excluded from the shipped-library
// runtime-neutrality guard.
function isShippedTypeScriptLibraryFile(relativeSegments, basename) {
  if (!basename.endsWith(".ts")) return false;
  if (relativeSegments.includes("tests")) return false;
  if (AUTHORED_VECTOR_ADAPTER_SEGMENTS.has(basename)) return false;
  return true;
}

function findTypeScriptRuntimeCoupling(content) {
  // Blank out comments before scanning so prose like "...data to process." or a
  // JSDoc mention of require() is never mistaken for real Node coupling. Newlines
  // are preserved so reported line numbers still point at the source line.
  const withoutBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
  const findings = [];
  const lines = withoutBlockComments.split("\n");
  const importPattern = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
  for (let index = 0; index < lines.length; index++) {
    // Drop a trailing line comment (but not the // inside a URL like https://).
    const line = lines[index].replace(/(?<!:)\/\/.*$/, "");
    const lineNumber = index + 1;

    if (/\brequire\s*\(/.test(line)) {
      findings.push({ lineNumber, reason: "CommonJS require() call" });
    }
    if (/(?<![A-Za-z0-9_$.])process\s*\./.test(line)) {
      findings.push({ lineNumber, reason: "Node process global" });
    }

    importPattern.lastIndex = 0;
    let match;
    while ((match = importPattern.exec(line)) !== null) {
      const specifier = match[1];
      const normalized = specifier.startsWith("node:")
        ? specifier.slice("node:".length)
        : specifier;
      if (specifier.startsWith("node:") || NODE_ONLY_MODULES.has(normalized)) {
        findings.push({
          lineNumber,
          reason: `import of Node builtin "${specifier}"`,
        });
      }
    }
  }
  return findings;
}

function assertTypeScriptRuntimeNeutrality(context) {
  const targetRoots = ["typescript", "typescript-zod"]
    .map((target) => path.join(generatedRoot, target))
    .filter((root) => existsSync(root));

  if (targetRoots.length === 0) {
    context.skip("no TypeScript targets generated");
    return;
  }

  for (const root of targetRoots) {
    for (const file of walkFiles(root, isGeneratedTextFile)) {
      const relativeToTarget = path.relative(root, file);
      const segments = relativeToTarget.split(path.sep);
      const basename = path.basename(file);
      if (!isShippedTypeScriptLibraryFile(segments, basename)) continue;

      const relativePath = path.relative(packageRoot, file);
      const content = readFileSync(file, "utf8");
      for (const finding of findTypeScriptRuntimeCoupling(content)) {
        fail(
          `${relativePath}:${finding.lineNumber} couples the shipped TypeScript ` +
            `library to Node (${finding.reason}). The generated library must stay ` +
            `runtime-neutral so web/edge/Deno consumers can import it; inject or ` +
            `centralize the host capability behind a seam instead (see the ` +
            `injected TypraFetchTransport and LoadContext.parseYaml).`,
        );
      }
    }
  }
}

function assertGeneratedStructuredLoadCoverage() {
  const exportSurface = readJson(
    path.join(
      "generated",
      "fixtures",
      ".typra-generated",
      "export-surfaces.json",
    ),
  );
  const kebabCase = (value) =>
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase();
  const snakeCase = (value) => kebabCase(value).replace(/-/g, "_");
  const pascalCase = (value) =>
    value
      .split(/[_-]/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("");
  const suites = [
    {
      target: "typescript",
      outputRoot: "generated/fixtures/typescript",
      dir: path.join(generatedRoot, "typescript", "tests"),
      testFile: (file) => file.endsWith(".test.ts"),
      expectedTestPath: (name, group) =>
        path.join(
          generatedRoot,
          "typescript",
          "tests",
          group || "",
          `${kebabCase(name)}.test.ts`,
        ),
      hasStructuredLoad: (content) =>
        content.includes("should load from JSON - example 1"),
    },
    {
      target: "python",
      outputRoot: "generated/fixtures/python",
      dir: path.join(generatedRoot, "python", "tests"),
      testFile: (file) => file.endsWith(".py"),
      expectedTestPath: (name, group) =>
        path.join(
          generatedRoot,
          "python",
          "tests",
          group || "",
          `test_${snakeCase(name)}.py`,
        ),
      hasStructuredLoad: (content) => /def test_load_json_\w+\(/.test(content),
    },
    {
      target: "python_pydantic",
      outputRoot: "generated/fixtures/python_pydantic",
      dir: path.join(generatedRoot, "python_pydantic", "tests"),
      testFile: (file) => file.endsWith(".py"),
      expectedTestPath: (name, group) =>
        path.join(
          generatedRoot,
          "python_pydantic",
          "tests",
          group || "",
          `test_${snakeCase(name)}.py`,
        ),
      hasStructuredLoad: (content) => /def test_load_json_\w+\(/.test(content),
    },
    {
      target: "swift-codable",
      outputRoot: "generated/fixtures/swift-codable",
      dir: path.join(
        generatedRoot,
        "swift-codable",
        "Tests",
        "TypraFixturesTests",
      ),
      testFile: (file) => file.endsWith("Tests.swift"),
      expectedTestPath: (_name, group, source) => {
        const moduleName = path.basename(source, ".swift");
        return path.join(
          generatedRoot,
          "swift-codable",
          "Tests",
          "TypraFixturesTests",
          group || "",
          `${pascalCase(moduleName)}Tests.swift`,
        );
      },
      hasStructuredLoad: (content) =>
        /func testJSONRoundTrip\d+\(\) throws/.test(content),
    },
    {
      target: "go",
      outputRoot: "generated/fixtures/go",
      dir: path.join(generatedRoot, "go", "tests"),
      testFile: (file) => file.endsWith("_test.go"),
      expectedTestPath: (name) =>
        path.join(generatedRoot, "go", "tests", `${snakeCase(name)}_test.go`),
      hasStructuredLoad: (content) =>
        /func Test\w+LoadJSON\(t \*testing\.T\)/.test(content),
    },
    {
      target: "java",
      outputRoot: "generated/fixtures/java",
      dir: path.join(generatedRoot, "java", "tests"),
      testFile: (file) => file.endsWith("GeneratedTest.java"),
      expectedTestPath: (name) =>
        path.join(generatedRoot, "java", "tests", `${name}GeneratedTest.java`),
      hasStructuredLoad: (content) => /\.fromJson\(jsonData1\)/.test(content),
    },
    {
      target: "csharp",
      outputRoot: "generated/fixtures/csharp",
      dir: path.join(generatedRoot, "csharp", "tests"),
      testFile: (file) => file.endsWith("ConversionTests.cs"),
      expectedTestPath: (name, group) =>
        path.join(
          generatedRoot,
          "csharp",
          "tests",
          // C# folders mirror PascalCase namespaces, so the emitter PascalCases
          // every group segment (see csharpGroupFolder in the C# driver). Mirror
          // that here or this check fails on case-sensitive filesystems (Linux CI)
          // while silently passing on case-insensitive Windows/macOS.
          group
            ? group.split("/").filter(Boolean).map(pascalCase).join("/")
            : "",
          `${name}ConversionTests.cs`,
        ),
      hasStructuredLoad: (content) => /\bLoadJsonInput1?\(/.test(content),
    },
    {
      target: "rust",
      outputRoot: "generated/fixtures/rust",
      dir: path.join(generatedRoot, "rust", "tests"),
      testFile: (file) => file.endsWith("_test.rs"),
      expectedTestPath: (_name, group, source) => {
        const moduleName = source.split("::").at(-1);
        return path.join(
          generatedRoot,
          "rust",
          "tests",
          group || "",
          `${moduleName}_test.rs`,
        );
      },
      hasStructuredLoad: (content) => /fn test_\w+_load_json\(\)/.test(content),
    },
    {
      target: "rust-serde",
      outputRoot: "generated/fixtures/rust-serde",
      dir: path.join(generatedRoot, "rust-serde", "tests"),
      testFile: (file) => file.endsWith("_test.rs"),
      expectedTestPath: (_name, group, source) => {
        const moduleName = source.split("::").at(-1);
        return path.join(
          generatedRoot,
          "rust-serde",
          "tests",
          group || "",
          `${moduleName}_test.rs`,
        );
      },
      hasStructuredLoad: (content) => /fn test_\w+_load_json\(\)/.test(content),
    },
    {
      target: "swift",
      outputRoot: "generated/fixtures/swift",
      dir: path.join(generatedRoot, "swift", "Tests", "TypraFixturesTests"),
      testFile: (file) => file.endsWith("Tests.swift"),
      expectedTestPath: (_name, group, source) => {
        const moduleName = path.basename(source, ".swift");
        return path.join(
          generatedRoot,
          "swift",
          "Tests",
          "TypraFixturesTests",
          group || "",
          `${pascalCase(moduleName)}Tests.swift`,
        );
      },
      hasStructuredLoad: (content) =>
        /func testJSONRoundTrip1\(\) throws/.test(content),
    },
  ];

  for (const suite of suites) {
    const target = exportSurface?.targets?.find(
      (entry) => entry.outputRoot === suite.outputRoot,
    );
    if (target && suite.expectedTestPath) {
      const missing = (target.exports ?? [])
        .filter((entry) => entry.kind === "value" && !entry.protocol)
        .map((entry) =>
          suite.expectedTestPath(entry.name, entry.group, entry.source),
        )
        .filter((file, index, files) => files.indexOf(file) === index)
        .filter((file) => !existsSync(file));
      if (missing.length > 0) {
        fail(
          `Generated ${suite.target} fixture exports without test files:\n` +
            missing
              .map((file) => `  ${path.relative(packageRoot, file)}`)
              .join("\n"),
        );
      }
    }

    const files = walkFiles(suite.dir, (file) => {
      const basename = path.basename(file);
      const lower = basename.toLowerCase();
      const normalized = lower.replace(/[^a-z0-9]/g, "");
      return (
        suite.testFile(file) &&
        !normalized.includes("protocolscaffolds") &&
        !normalized.includes("vectorconformance") &&
        !normalized.includes("vectorrunner") &&
        lower !== "test_context.py" &&
        lower !== "conformancetests.swift"
      );
    });
    if (files.length === 0) {
      fail(
        `No generated ${suite.target} fixture tests found for structured load coverage.`,
      );
      continue;
    }

    const missing = files.filter(
      (file) => !suite.hasStructuredLoad(readFileSync(file, "utf8")),
    );
    if (missing.length > 0) {
      fail(
        `Generated ${suite.target} fixture tests without structured JSON load coverage:\n` +
          missing
            .map((file) => `  ${path.relative(packageRoot, file)}`)
            .join("\n"),
      );
    }
  }
}

function assertFocusedFeatureFixtures() {
  const fixtures = findFocusedFeatureFixtures();
  assertArrayIncludes(
    "Focused feature fixtures",
    fixtures.map((fixture) =>
      path
        .relative(path.join(packageRoot, "fixtures"), fixture)
        .split(path.sep)
        .join("/"),
    ),
    "features/samples/main.tsp",
    "features/serialization/main.tsp",
    "features/vectors/main.tsp",
    "features/model-shapes/main.tsp",
    "features/scalars/main.tsp",
    "features/collections/main.tsp",
    "features/coercions/main.tsp",
    "features/defaults/main.tsp",
    "features/docs/main.tsp",
    "features/enums/main.tsp",
    "features/namespaces/main.tsp",
    "features/polymorphism/main.tsp",
    "features/protocols/main.tsp",
    "features/wire/main.tsp",
    "features/transport/main.tsp",
    "features/dispatch/main.tsp",
    "features/dispatch-union-coerce/main.tsp",
    "features/dispatch-vector-params/main.tsp",
    "features/dispatch-vector-coerce/main.tsp",
    "features/dispatch-target-regression/main.tsp",
    "features/typed-seam-conformance/main.tsp",
  );

  for (const fixture of fixtures) {
    const relative = path
      .relative(path.join(packageRoot, "fixtures", "features"), fixture)
      .split(path.sep);
    const featureName = relative[0];
    const outputRoot = path.join(
      validationRoot,
      "focused-features",
      featureName,
    );

    try {
      execFileSync(
        process.execPath,
        [
          path.join(packageRoot, "dist", "src", "cli.js"),
          "--output",
          outputRoot,
          "--targets",
          "markdown",
          "--spec",
          fixture,
          "--root-object",
          `Typra.Fixtures.Features.${toPascalCase(featureName)}.Root`,
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
        `Focused feature fixture ${featureName} failed to compile:\n${output || error.message}`,
      );
      continue;
    }

    const modelPath = path.join(outputRoot, "json-ast", "model.json");
    const model = existsSync(modelPath)
      ? JSON.parse(readFileSync(modelPath, "utf8"))
      : undefined;
    if (!model) {
      fail(`Focused feature fixture ${featureName} did not generate JSON AST.`);
      continue;
    }

    if (featureName === "samples") {
      const properties = model.properties ?? [];
      const inline = properties.find((field) => field.name === "inline");
      const fileBacked = properties.find(
        (field) => field.name === "fileBacked",
      );
      if (
        !JSON.stringify(inline?.samples ?? []).includes("inline-sample") ||
        !JSON.stringify(fileBacked?.samples ?? []).includes(
          "file-backed-sample",
        )
      ) {
        fail(
          "Focused samples fixture must preserve both inline and imported sample payloads.",
        );
      }
    }

    if (featureName === "vectors") {
      const vectorPath = path.join(
        outputRoot,
        ".typra-generated",
        "vectors.json",
      );
      const vectors = existsSync(vectorPath)
        ? JSON.parse(readFileSync(vectorPath, "utf8"))
        : undefined;
      const serialized = JSON.stringify(vectors ?? {});
      for (const expected of [
        "inline-success",
        "file-backed-success",
        "file-backed-error",
        "expectedError",
        // JSON-string vector set carrying a keyword `model` field name and an
        // opaque provider wire payload (see fixtures/features/vectors).
        "wire-payload-model-key",
        '"model":{"id":"cfg-1"',
        '"model":"demo-model"',
        // Sparse model-typed vector inputs must survive verbatim: opaque
        // evidence is never normalized to canonical `save()` form, so the
        // required-with-default `ProviderConfig.id` must NOT be materialized.
        "sparse-empty-model-input",
        '"request":{},"signal":"noop"',
        '"request":{"model":{"provider":"openai"}},"signal":"noop"',
      ]) {
        if (!serialized.includes(expected)) {
          fail(
            `Focused vectors fixture did not preserve expected vector payload: ${expected}`,
          );
        }
      }
    }

    if (featureName === "serialization") {
      // The generic loop renders markdown to prove the fixture compiles; opt-in
      // serialization is a target-specific behavior, so assert on rendered Go
      // (the golden-reference runtime). Red-first gate for issue #306.
      const goRoot = path.join(outputRoot, "go-render");
      try {
        execFileSync(
          process.execPath,
          [
            path.join(packageRoot, "dist", "src", "cli.js"),
            "--output",
            goRoot,
            "--targets",
            "go",
            "--spec",
            fixture,
            "--root-object",
            "Typra.Fixtures.Features.Serialization.Root",
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
          `Serialization fixture failed to render Go:\n${output || error.message}`,
        );
      }

      const readGo = (name) => {
        const file = path.join(goRoot, "go", name);
        return existsSync(file) ? readFileSync(file, "utf8") : "";
      };
      const root = readGo("root.go");
      const detached = readGo("detached.go");
      const bodyOf = (source, header) => {
        // Function bodies close with a column-0 `}`; inner blocks are indented,
        // so `\n}` matches only the terminal brace.
        const start = source.indexOf(header);
        if (start < 0) return "";
        const end = source.indexOf("\n}", start);
        return end < 0 ? source.slice(start) : source.slice(start, end + 2);
      };

      // Opt-in: a `@serializable` root emits load + save over its closure.
      if (
        !root.includes("func LoadRoot(") ||
        !root.includes("func (obj Root) Save(")
      ) {
        fail("@serializable Root must emit load/save.");
      }
      // Negative: a `@sample`-only, unreachable model emits NO load/save —
      // `@sample` alone never implies serialization intent.
      if (
        detached.includes("func LoadDetached(") ||
        detached.includes("func (obj Detached) Save(")
      ) {
        fail("@sample-only Detached must NOT emit load/save.");
      }
      // Negative: a non-serialized model with `@knownAs` wire mappings must emit
      // NO wire methods. Go's ToWire/FromWire route through Save()/Load, which
      // are pruned for non-serialized types — emitting them dangles those
      // symbols and breaks `go build` (the Go-only regression, matching the
      // other 6 targets, which nest wire emission inside the serialized block).
      if (
        detached.includes("func (obj *Detached) ToWire(") ||
        detached.includes("func DetachedFromWire(")
      ) {
        fail(
          "@sample-only Detached with @knownAs must NOT emit ToWire/FromWire — they call the pruned Save()/Load and break the Go build.",
        );
      }
      // A non-serialized Go file must not request unused serialization imports.
      if (
        detached.includes("encoding/json") ||
        detached.includes("gopkg.in/yaml.v3")
      ) {
        fail(
          "Non-serialized Go file must not import encoding/json or gopkg.in/yaml.v3.",
        );
      }
      // No test file for a non-serialized type.
      if (existsSync(path.join(goRoot, "go", "detached_test.go"))) {
        fail("@sample-only Detached must NOT emit a test file.");
      }

      // Swift-specific gate (red-first for the 2.1.6 emitter-drift fix): Swift's
      // `TypraModel` protocol REQUIRES load + save, so it is a serialization
      // marker, not a bare base marker. A non-serializable type whose load/save
      // are (correctly) pruned must therefore NOT declare `: TypraModel` — else
      // it conforms to a protocol it cannot satisfy and `swift build` fails with
      // "type 'Detached' does not conform to protocol 'TypraModel'". Render Swift
      // and assert the pruned `Detached` emits a PLAIN struct (no conformance),
      // with no load/save/wire — matching Go's plain struct.
      const swiftRoot = path.join(outputRoot, "swift-render");
      try {
        execFileSync(
          process.execPath,
          [
            path.join(packageRoot, "dist", "src", "cli.js"),
            "--output",
            swiftRoot,
            "--targets",
            "swift",
            "--spec",
            fixture,
            "--root-object",
            "Typra.Fixtures.Features.Serialization.Root",
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
          `Serialization fixture failed to render Swift:\n${output || error.message}`,
        );
      }
      const findSwift = (basename) => {
        const found = walkFiles(
          swiftRoot,
          (file) => path.basename(file) === basename,
        );
        return found.length === 1 ? readFileSync(found[0], "utf8") : "";
      };
      const detachedSwift = findSwift("detached.swift");
      const rootSwift = findSwift("root.swift");
      // Positive: the `@serializable` Root keeps its serialization conformance.
      if (!rootSwift.includes("struct Root: TypraModel")) {
        fail("@serializable Root must declare `: TypraModel` in Swift.");
      }
      // Negative: the pruned, non-serializable Detached must be a plain struct.
      if (/struct Detached\b[^{]*:\s*[^{]*TypraModel/.test(detachedSwift)) {
        fail(
          "@sample-only Detached must NOT declare `: TypraModel` in Swift — its load/save are pruned, so the conformance is unsatisfiable and breaks `swift build`.",
        );
      }
      if (
        detachedSwift.includes("func save(") ||
        detachedSwift.includes("static func load(") ||
        detachedSwift.includes("func toWire(") ||
        detachedSwift.includes("static func fromWire(")
      ) {
        fail(
          "@sample-only Detached must NOT emit load/save/wire methods in Swift.",
        );
      }

      // @sensitive field withholding is a per-direction omission on the
      // participating type (the closure stays total).
      const saveBody = bodyOf(root, "func (obj Root) Save(");
      const loadBody = bodyOf(root, "func LoadRoot(");
      // `@sensitive("save")` — write-only secret: loaded, never saved.
      if (saveBody.includes('"apiKey"')) {
        fail('@sensitive("save") apiKey must be omitted from save.');
      }
      if (!loadBody.includes('"apiKey"')) {
        fail('@sensitive("save") apiKey must remain loadable.');
      }
      // bare `@sensitive` — withheld from both directions.
      if (saveBody.includes('"scratch"') || loadBody.includes('"scratch"')) {
        fail("bare @sensitive scratch must be omitted from load and save.");
      }
      // `@sensitive("load")` — save-only: persisted but never reloaded.
      if (!saveBody.includes('"computedAt"')) {
        fail('@sensitive("load") computedAt must remain savable.');
      }
      if (loadBody.includes('"computedAt"')) {
        fail('@sensitive("load") computedAt must be omitted from load.');
      }

      // Round-trip TEST emission must gate on serializability across EVERY
      // target, not just Go. `@sample` no longer implies `@serializable`, so a
      // `@sample`-only, non-serializable type (Detached) gets a model with NO
      // load/save — and any generated round-trip test that calls the missing
      // load/save fails to compile. Go already prunes the per-type test file
      // (the reference behavior); this locks the same contract for the other
      // six drivers. Red-first for the 2.1.1 emitter-drift fix: render WITH
      // tests and assert no target emits a Detached round-trip test file.
      const allTestsRoot = path.join(outputRoot, "all-tests-render");
      try {
        execFileSync(
          process.execPath,
          [
            path.join(packageRoot, "dist", "src", "cli.js"),
            "--output",
            allTestsRoot,
            "--targets",
            "go,python,typescript,csharp,java,swift,rust",
            "--spec",
            fixture,
            "--root-object",
            "Typra.Fixtures.Features.Serialization.Root",
            "--no-format",
            "--deterministic",
          ],
          { cwd: packageRoot, stdio: "pipe" },
        );
      } catch (error) {
        const output =
          `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
        fail(
          `Serialization fixture failed to render all targets with tests:\n${output || error.message}`,
        );
      }

      // Per-target path where each driver writes a type's round-trip test. Go is
      // the golden reference (already gated); the other six must match.
      const detachedTestFiles = {
        go: ["go", "detached_test.go"],
        python: [
          "python",
          "tests",
          "fixtures",
          "features",
          "serialization",
          "test_detached.py",
        ],
        typescript: [
          "typescript",
          "tests",
          "fixtures",
          "features",
          "serialization",
          "detached.test.ts",
        ],
        csharp: [
          "csharp",
          "tests",
          "Fixtures",
          "Features",
          "Serialization",
          "DetachedConversionTests.cs",
        ],
        java: ["java", "tests", "DetachedGeneratedTest.java"],
        swift: [
          "swift",
          "tests",
          "Fixtures",
          "Features",
          "Serialization",
          "DetachedTests.swift",
        ],
        rust: [
          "rust",
          "tests",
          "fixtures",
          "features",
          "serialization",
          "detached_test.rs",
        ],
      };
      for (const [target, segments] of Object.entries(detachedTestFiles)) {
        if (existsSync(path.join(allTestsRoot, ...segments))) {
          fail(
            `${target}: @sample-only Detached must NOT emit a round-trip test file (its model has no load/save). Gate per-type test emission on the serialization closure, matching Go.`,
          );
        }
      }

      // A generated load → save → load round-trip test must NOT assert that a
      // `@sensitive("save")` field survives: `save()` omits it, so the reloaded
      // instance carries the default, not the original value. Root.apiKey is
      // `@sensitive("save")` and carries a `@sample` value, so a naive driver
      // emits `reloaded.apiKey == "sk-secret-value"` — an assertion that is
      // false by construction (the security property the annotation guarantees).
      // Rust is exempt: its round-trip test asserts load-ok + to_json-ok only,
      // never field survival, so it can't emit the inverted assertion. Red-first
      // for the 2.1.2 emitter-drift fix.
      const sensitiveRoundtripChecks = {
        go: { file: ["go", "tests", "root_test.go"], sensitive: "ApiKey", normal: "Name" },
        python: {
          file: [
            "python",
            "tests",
            "fixtures",
            "features",
            "serialization",
            "test_root.py",
          ],
          sensitive: "api_key",
          normal: "name",
        },
        typescript: {
          file: [
            "typescript",
            "tests",
            "fixtures",
            "features",
            "serialization",
            "root.test.ts",
          ],
          sensitive: "apiKey",
          normal: "name",
        },
        csharp: {
          file: [
            "csharp",
            "tests",
            "Fixtures",
            "Features",
            "Serialization",
            "RootConversionTests.cs",
          ],
          sensitive: "ApiKey",
          normal: "Name",
        },
        java: {
          file: ["java", "tests", "RootGeneratedTest.java"],
          sensitive: "apiKey",
          normal: "name",
        },
        swift: {
          file: [
            "swift",
            "tests",
            "Fixtures",
            "Features",
            "Serialization",
            "RootTests.swift",
          ],
          sensitive: "apiKey",
          normal: "name",
        },
      };
      for (const [target, spec] of Object.entries(sensitiveRoundtripChecks)) {
        const filePath = path.join(allTestsRoot, ...spec.file);
        if (!existsSync(filePath)) {
          fail(
            `${target}: @serializable Root must emit a round-trip test file (expected ${spec.file.join("/")}).`,
          );
          continue;
        }
        const testLines = readFileSync(filePath, "utf8").split("\n");
        // The reloaded (post-save) instance is the only place `reloaded` and a
        // field accessor co-occur — load-side assertions use `instance`. Java's
        // `reloaded0` still contains the `reloaded` substring.
        const assertsSensitiveSurvives = testLines.some(
          (line) => line.includes("reloaded") && line.includes(spec.sensitive),
        );
        if (assertsSensitiveSurvives) {
          fail(
            `${target}: round-trip test must NOT assert @sensitive("save") apiKey survives load→save→load — save() omits it, so the reloaded value is default. Exclude @sensitive("save") fields from post-save reload assertions.`,
          );
        }
        // Positive control: the non-sensitive field must still be asserted, so
        // the fix drops only the withheld field, not the whole reload check.
        const assertsNormalSurvives = testLines.some(
          (line) => line.includes("reloaded") && line.includes(spec.normal),
        );
        if (!assertsNormalSurvives) {
          fail(
            `${target}: round-trip test must still assert the non-sensitive field survives load→save→load.`,
          );
        }
      }
    }

    if (featureName === "protocols") {
      const exportSurfacePath = path.join(
        outputRoot,
        ".typra-generated",
        "export-surfaces.json",
      );
      const exportSurface = existsSync(exportSurfacePath)
        ? JSON.parse(readFileSync(exportSurfacePath, "utf8"))
        : undefined;
      const protocols = exportSurface?.targets?.[0]?.protocols ?? [];
      const methods =
        protocols.find((protocol) => protocol.name === "CheckpointStore")
          ?.methods ?? [];
      const load = methods.find((method) => method.name === "load");
      const observe = methods.find((method) => method.name === "observe");
      const save = methods.find((method) => method.name === "save");
      if (
        load?.sync !== true ||
        observe?.optional !== true ||
        observe?.nonFatal !== true ||
        save?.runtimeCancellable !== true
      ) {
        fail(
          "Focused protocols fixture must preserve native operation decorator metadata.",
        );
      }

      const optionalSeam =
        protocols.find((protocol) => protocol.name === "OptionalSeam")
          ?.methods ?? [];
      const writeSummary = optionalSeam.find(
        (method) => method.name === "writeSummary",
      );
      const loadCheckpoint = optionalSeam.find(
        (method) => method.name === "loadCheckpoint",
      );
      const preRender = optionalSeam.find(
        (method) => method.name === "preRender",
      );
      if (
        // GAP 1: optional param keeps its optionality via the trailing "?".
        writeSummary?.params?.summary !== "SessionSummary?" ||
        // GAP 2: `Checkpoint | null` folds to the nullable "?" spelling.
        loadCheckpoint?.returns !== "Checkpoint?" ||
        // GAP 3: optional, value-returning op stays optional + sync.
        preRender?.optional !== true ||
        preRender?.sync !== true ||
        preRender?.returns !== "string"
      ) {
        fail(
          "Focused protocols fixture must carry native-op optional/nullable lowering (optional param, nullable return, optional value-returning op).",
        );
      }
    }

    if (featureName === "dispatch") {
      const exportSurfacePath = path.join(
        outputRoot,
        ".typra-generated",
        "export-surfaces.json",
      );
      const exportSurface = existsSync(exportSurfacePath)
        ? JSON.parse(readFileSync(exportSurfacePath, "utf8"))
        : undefined;
      const protocols = exportSurface?.targets?.[0]?.protocols ?? [];
      const renderer = protocols.find(
        (protocol) => protocol.name === "Renderer",
      );
      // The @dispatch discriminator must resolve to the unique field-access path
      // from the seam parameter (`agent` → `agent.template.format.kind`), never
      // a guessed path, and carry the discriminator's owning model + field.
      if (
        renderer?.dispatch?.path !== "agent.template.format.kind" ||
        renderer?.dispatch?.discriminator?.model !== "TemplateFormat" ||
        renderer?.dispatch?.discriminator?.field !== "kind"
      ) {
        fail(
          "Focused dispatch fixture must resolve the @dispatch discriminator to the unique access path agent.template.format.kind.",
        );
      }

      const vectorPath = path.join(
        outputRoot,
        ".typra-generated",
        "vectors.json",
      );
      const vectors = existsSync(vectorPath)
        ? JSON.parse(readFileSync(vectorPath, "utf8"))
        : undefined;
      const serialized = JSON.stringify(vectors ?? {});
      for (const expected of ["mustache-basic", "jinja2-basic"]) {
        if (!serialized.includes(expected)) {
          fail(
            `Focused dispatch fixture did not preserve expected vector: ${expected}`,
          );
        }
      }
    }
  }
}

function isMarkerOnlyContent(content) {
  const trimmed = content.trim();
  return (
    trimmed === "# <auto-generated by typra-emitter>" ||
    trimmed === "// <auto-generated by typra-emitter>" ||
    trimmed === "<!-- <auto-generated by typra-emitter> -->"
  );
}

// Operation keys the integration fixture's reference vector adapters register.
// The @vector coverage gate in `typra verify` checks the runtime's declared
// adapters against the vectors snapshot; the fixture's runtime is the reference
// adapter set authored by `authorVectorAdapters`, so declare the same keys here.
const FIXTURE_VECTOR_ADAPTER_KEYS = [
  "CanonicalEnginePort.authorize",
  "CanonicalEnginePort.format",
];

function writeFixtureVerifyConfig() {
  const configPath = path.join(generatedRoot, "typra-verify.validate.json");
  writeFileSync(
    configPath,
    JSON.stringify({ vectorAdapters: FIXTURE_VECTOR_ADAPTER_KEYS }, null, 2),
  );
  return configPath;
}

function runTypraVerify() {
  const cliPath = path.join(packageRoot, "dist", "src", "verify-cli.js");
  if (!existsSync(cliPath)) {
    fail(
      "Unable to locate built typra-verify CLI for generated fixture validation.",
    );
    return;
  }

  try {
    const verifyConfigPath = writeFixtureVerifyConfig();
    const output = execFileSync(
      process.execPath,
      [
        cliPath,
        "--baseline",
        generatedRoot,
        "--current",
        generatedRoot,
        "--config",
        verifyConfigPath,
      ],
      { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const expected of [
      "Typra verify: passed",
      "exports: +0 / -0 / changed 0",
      "protocols: +0 / -0 / changed 0",
      "files: +0 / deleted 0 / ownership changed 0",
      "package names changed: 0",
    ]) {
      if (!output.includes(expected)) {
        fail(
          `typra-verify fixture output does not include expected summary: ${expected}`,
        );
      }
    }

    const jsonOutput = execFileSync(
      process.execPath,
      [
        cliPath,
        "--baseline",
        generatedRoot,
        "--current",
        generatedRoot,
        "--config",
        verifyConfigPath,
        "--json",
      ],
      { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const result = JSON.parse(jsonOutput);
    if (
      result.ok !== true ||
      result.breakingChange !== "patch" ||
      result.summary?.exports?.added !== 0 ||
      result.summary?.protocols?.changed !== 0 ||
      result.summary?.files?.deleted !== 0
    ) {
      fail(
        "typra-verify JSON fixture output does not describe a clean self-compare.",
      );
    }
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `typra-verify failed against generated fixtures:\n${output || error.message}`,
    );
  }
}

function runTypraConsumerSmoke() {
  const cliPath = path.join(packageRoot, "dist", "src", "consumer-smoke.js");
  if (!existsSync(cliPath)) {
    fail(
      "Unable to locate built typra-consumer-smoke CLI for generated fixture validation.",
    );
    return;
  }

  const configPath = path.join(generatedRoot, "typra-smoke.validate.json");
  const verifyConfigPath = writeFixtureVerifyConfig();
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        verify: {
          baseline: generatedRoot,
          current: generatedRoot,
          config: verifyConfigPath,
        },
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(process.execPath, [cliPath, "--config", configPath], {
      cwd: packageRoot,
      stdio: "pipe",
    });
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `typra-consumer-smoke failed against generated fixtures:\n${output || error.message}`,
    );
  } finally {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  }
}

function runExecutableConformance() {
  runExpectedExecutionPlan({
    label: "Executable conformance validation",
    expectedIds: EXPECTED_EXECUTABLE_CONFORMANCE_TARGET_IDS,
    implementations: new Map([
      ["typescript", runTypeScriptExecutableConformance],
      ["typescript-zod", runTypeScriptZodExecutableConformance],
      ["python", () => runPythonExecutableConformance()],
      [
        "python_pydantic",
        () =>
          runPythonExecutableConformance("python_pydantic", "python_pydantic"),
      ],
      ["go", runGoExecutableConformance],
      ["rust", () => runRustExecutableConformance()],
      [
        "rust-serde",
        () => runRustExecutableConformance("rust-serde", "fixtures_serde"),
      ],
      ["rust-unknown", runRustUnknownAbstractConformance],
      ["csharp", runCSharpExecutableConformance],
      ["java", runJavaExecutableConformance],
      ["swift", () => runSwiftExecutableConformance()],
      ["swift-codable", () => runSwiftCodableExecutableConformance()],
    ]),
  });
  assertExecutableConformanceCoverage();
  assertExecutableConformanceAgreement();
}

function assertGeneratedTargets() {
  for (const target of [
    "typescript",
    "typescript-zod",
    "python",
    "python_pydantic",
    "go",
    "java",
    "java-jackson",
    "csharp",
    "rust",
    "rust-serde",
    "swift",
    "swift-codable",
    "markdown",
    "json-ast",
  ]) {
    requirePath(path.join("generated", "fixtures", target));
  }
}

function assertStaticFixtureCoverage() {
  assertIncludes(
    path.join("generated", "fixtures", "json-ast", "model.json"),
    "FixtureRoot",
    "FixtureOwner",
    "FixtureContent",
    "samples",
    "allowedValues",
    "parseAliases",
  );

  assertIncludes(
    path.join("generated", "fixtures", "typescript", "fixture-reference.ts"),
    "static named(",
    "fromJson",
  );
  assertIncludes(
    path.join("generated", "fixtures", "typescript", "wire-options.ts"),
    "toWire(provider: string)",
    "static fromWire(",
    "const inverse: Record<string, string> = {}",
    "canonical[inverse[k] ?? k] = v",
    "return WireOptions.load(canonical, context)",
    "max_completion_tokens",
    "max_tokens",
  );
  assertIncludes(
    path.join("generated", "fixtures", "python", "_WireOptions.py"),
    "def to_wire(self, provider: str)",
    "def from_wire(",
    "inverse[w] = field_name",
    "canonical[inverse.get(k, k)] = v",
    "return WireOptions.load(canonical, context)",
    "max_completion_tokens",
    "max_tokens",
  );
  assertIncludes(
    path.join("generated", "fixtures", "typescript-zod", "fixture-content.ts"),
    'import { z } from "zod";',
    "static readonly wireSchema",
    "z.discriminatedUnion(",
    '"kind",',
    "static readonly schema",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "typescript-zod",
      "fixture-connection.ts",
    ),
    "wireObjectSchemaWithoutName",
    ".passthrough()",
    "return FixtureConnection.load(data as Record<string, unknown>).save();",
    "ctx.addIssue({ code: z.ZodIssueCode.custom, message: String(error) });",
    "}).pipe(FixtureConnection.wireSchema)",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "typescript",
      "tests",
      "fixture-root.test.ts",
    ),
    "should load from JSON - example 1",
    'expect(instance.name).toEqual("fixture-root")',
    "should round-trip YAML - example 1",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "typescript",
      "tests",
      "fixture-content.test.ts",
    ),
    'describe("FixtureContent"',
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "typescript",
      "tests",
      "protocol-scaffolds.test.ts",
    ),
    'describe("protocol scaffolds", () => {',
    'it("compiles compile-only protocol implementations", () => {',
    "class CompileOnlyEventSink implements EventSink",
    'throw new Error("EventSink.emit is a compile-only protocol scaffold.");',
  );

  assertIncludes(
    path.join("generated", "fixtures", "python", "_FixtureReference.py"),
    "def named(",
  );
  assertIncludes(
    path.join("generated", "fixtures", "python", "_ModelInfo.py"),
    "input_modalities: list[str] | None = None",
    "output_modalities: list[str] | None = field(default_factory=list)",
    "owners: list[FixtureOwner] | None = None",
    "default_owners: list[FixtureOwner] | None = field(default_factory=list)",
  );
  assertIncludes(
    path.join("generated", "fixtures", "python_pydantic", "_ModelInfo.py"),
    "from pydantic import BaseModel, ConfigDict, Field",
    "class ModelInfo(BaseModel):",
    "model_config = ConfigDict(populate_by_name=True, arbitrary_types_allowed=True)",
    'input_modalities: list[str] | None = Field(default=None, alias="inputModalities")',
    "output_modalities: list[str] | None = Field(",
    'default_factory=list, alias="outputModalities"',
    "def model_dump(self, *args: Any, **kwargs: Any) -> dict[str, Any]:",
    "return self.save()",
  );
  assertIncludes(
    path.join("generated", "fixtures", "typescript", "model-info.ts"),
    "inputModalities?: string[];",
    "outputModalities?: string[] = [];",
    "owners?: FixtureOwner[];",
    "defaultOwners?: FixtureOwner[] = [];",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "model_info.go"),
    "InputModalities",
    'json:"inputModalities,omitempty"',
    "OutputModalities",
    'json:"outputModalities"',
    "OutputModalities:",
    "[]string{}",
    'json:"outputModalities" yaml:"outputModalities"',
    "Owners",
    'json:"owners,omitempty"',
    "DefaultOwners",
    'json:"defaultOwners"',
    "DefaultOwners:",
    "[]FixtureOwner{}",
    'json:"defaultOwners" yaml:"defaultOwners"',
  );
  // Dead-store elimination for the Go LoadContext guard (CodeQL
  // go/useless-assignment-to-local). A leaf loader that never threads `ctx` into a
  // nested load keeps the `ctx *LoadContext` parameter for a uniform API but must not
  // emit the dead `if ctx == nil { ctx = NewLoadContext() }` prologue.
  assertIncludes(
    path.join("generated", "fixtures", "go", "fixture_owner.go"),
    "func LoadFixtureOwner(data interface{}, ctx *LoadContext) (FixtureOwner, error) {",
  );
  assertExcludes(
    path.join("generated", "fixtures", "go", "fixture_owner.go"),
    "ctx = NewLoadContext()",
    "if ctx == nil {",
  );
  // A nested loader that threads `ctx` into a nested load still needs the guard.
  assertIncludes(
    path.join("generated", "fixtures", "go", "model_info.go"),
    "if ctx == nil {",
    "ctx = NewLoadContext()",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "ModelInfo.java"),
    "public List<String> inputModalities = null;",
    "public List<String> outputModalities = new ArrayList<>();",
    "public List<FixtureOwner> owners = null;",
    "public List<FixtureOwner> defaultOwners = new ArrayList<>();",
  );
  assertIncludes(
    path.join("generated", "fixtures", "csharp", "ModelInfo.cs"),
    "public IList<string>? InputModalities { get; set; }",
    "public IList<string>? OutputModalities { get; set; } = [];",
    "public IList<FixtureOwner>? Owners { get; set; }",
    "public IList<FixtureOwner>? DefaultOwners { get; set; } = [];",
  );
  assertIncludes(
    path.join("generated", "fixtures", "csharp", "FixtureUnknownRecords.cs"),
    "public IDictionary<string, object?> RequiredValues { get; set; } = new Dictionary<string, object?>();",
    "public IDictionary<string, object?>? OptionalValues { get; set; }",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "model_info.rs"),
    "pub input_modalities: Option<Vec<String>>",
    "pub output_modalities: Vec<String>",
    'output_modalities: value.get("outputModalities").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()',
    "pub owners: Option<Vec<FixtureOwner>>",
    "pub default_owners: Vec<FixtureOwner>",
    'default_owners: value.get("defaultOwners").map(|v| Self::load_default_owners(v, ctx)).unwrap_or_default()',
    'output_modalities: value.get("outputModalities").and_then',
    ".unwrap_or_default()",
    'result.insert("outputModalities".to_string(), serde_json::to_value(&self.output_modalities)',
    'result.insert("defaultOwners".to_string(), Self::save_default_owners(&self.default_owners, ctx))',
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "swift",
      "Sources",
      "TypraFixtures",
      "model_info.swift",
    ),
    "public var inputModalities: [String]? = nil",
    "public var outputModalities: [String]? = []",
    "public var owners: [FixtureOwner]? = nil",
    "public var defaultOwners: [FixtureOwner]? = []",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "python",
      "tests",
      "test_protocol_scaffolds.py",
    ),
    "from __future__ import annotations",
    "class CompileOnlyCheckpointStore(CheckpointStore):",
    "def save(self, checkpoint: Checkpoint) -> None:",
    "async def save_async(self, checkpoint: Checkpoint) -> None:",
    "class CompileOnlyEventSink(EventSink):",
    "del event",
    'raise NotImplementedError("EventSink.emit is a compile-only protocol scaffold.")',
  );
  assertIncludes(
    path.join("generated", "fixtures", "csharp", "WireOptions.cs"),
    "public Dictionary<string, object?> ToWire(string provider)",
    "public static WireOptions FromWire(string provider, Dictionary<string, object?> data, LoadContext? context = null)",
    "var inverse = new Dictionary<string, string>();",
    "return Load(canonical, context);",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "wire_options.rs"),
    "pub fn to_wire(&self, provider: &str)",
    "pub fn from_wire(provider: &str, data: &serde_json::Value, ctx: &LoadContext) -> Self {",
    "Self::load_from_value(&serde_json::Value::Object(canonical), ctx)",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "wire_options.go"),
    "func (",
    "ToWire(provider string)",
    "max_completion_tokens",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "wire_options.go"),
    "func WireOptionsFromWire(provider string",
    "inverse := make(map[string]string)",
    "return LoadWireOptions(canonical, ctx)",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "tests", "fixture_root_test.go"),
    "Expected Tags length to be 3",
    "Expected Content to be fixtures.TextContent",
    "Expected Owner.DisplayName",
    "TestFixtureRootFromJSONInvalid",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "go",
      "tests",
      "fixture_reference_test.go",
    ),
    "FixtureReferenceFromJSON(string(jsonBytes))",
    "FixtureReferenceFromYAML(string(yamlBytes))",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "go",
      "tests",
      "fixture_multiline_whitespace_test.go",
    ),
    'value: "first line with two spaces  \\n\\n  \\nlast line with three spaces   \\n"',
    'value: "first line with trailing space \\nsecond line\\n"',
    "func TestFixtureMultilineWhitespaceLoadYAML(t *testing.T)",
    "func TestFixtureMultilineWhitespaceFromYAML(t *testing.T)",
    "func TestFixtureMultilineWhitespaceLoadYAML1(t *testing.T)",
    "func TestFixtureMultilineWhitespaceFromYAML1(t *testing.T)",
    'instance.Value != "first line with two spaces  \\n\\n  \\nlast line with three spaces   \\n"',
    'instance.Value != "first line with trailing space \\nsecond line\\n"',
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "tests", "wire_options_test.go"),
    "TestWireOptionsToWire",
    "max_completion_tokens",
    "max_tokens",
    "WireOptionsFromWire(",
    "reflect.DeepEqual(",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "go",
      "tests",
      "protocol_scaffolds_test.go",
    ),
    'typra "fixtures"',
    "var _ typra.EventSink = (*compileOnlyEventSink)(nil)",
    'return errors.New("compile-only protocol scaffold")',
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "WireOptions.java"),
    "public Map<String, Object> toWire(String provider)",
    "max_completion_tokens",
    "max_tokens",
    "public static WireOptions fromWire(String provider, Map<String, Object> data, LoadContext context) {",
    "if (w != null) inverse.put(w, e.getKey());",
    "return load(canonical, context);",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "java",
      "tests",
      "WireOptionsGeneratedTest.java",
    ),
    "WireOptions openaiRestored = WireOptions.fromWire(\"openai\", openaiWire);",
    "openaiRestored.toWire(\"openai\").keySet()",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "FixtureRoot.java"),
    "return fromJson(json, new LoadContext());",
    "return fromYaml(yaml, new LoadContext());",
    "public String toYaml()",
    "result.status = FixtureStatus.fromValue",
    'result.put("status", obj.status.value)',
  );
  assertExcludes(
    path.join("generated", "fixtures", "java", "FixtureRoot.java"),
    "com.fasterxml.jackson",
    "@JsonSerialize",
    "@JsonProperty",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java-jackson", "FixtureRoot.java"),
    "import com.fasterxml.jackson.annotation.JsonProperty;",
    "@JsonSerialize(using = FixtureRoot.TypraJacksonSerializer.class)",
    "@JsonDeserialize(using = FixtureRoot.TypraJacksonDeserializer.class)",
    '@JsonProperty("status")',
    "value.save(new SaveContext())",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "java-jackson",
      "tests",
      "FixtureRootGeneratedTest.java",
    ),
    "assertJacksonMatches(instance1, jsonData1, FixtureRoot.class",
    "mapper.writeValueAsString(instance)",
    "mapper.readValue(sourceJson, type)",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "FixtureStatus.java"),
    "public enum FixtureStatus",
    "fromValue(String value)",
    'case "complete":',
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "TypraJson.java"),
    "public static Object parse(String json)",
    "private static final class Parser",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "TypraYaml.java"),
    "public static String stringify(Object value)",
    "public static Object parse(String yaml)",
    "private static final class Parser",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "java",
      "tests",
      "FixtureRootGeneratedTest.java",
    ),
    "FixtureRoot.fromJson(jsonData1)",
    "String yamlRoundtrip1 = instance1.toYaml();",
    "FixtureRoot fromYaml1 = FixtureRoot.fromYaml(yamlRoundtrip1);",
    'assertThrows(() -> FixtureRoot.fromYaml(":\\n  broken")',
    'assertThrows(() -> FixtureRoot.fromJson("{")',
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "java",
      "tests",
      "ProtocolScaffoldsGeneratedTest.java",
    ),
    "final class ProtocolScaffoldsGeneratedTest",
    'throw new UnsupportedOperationException("EventSink.emit is a compile-only protocol scaffold.")',
  );
  assertIncludes(
    path.join("generated", "fixtures", "csharp", "FixtureReference.cs"),
    "public static FixtureReference Named(",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "csharp",
      "tests",
      "ProtocolScaffolds.cs",
    ),
    "internal sealed class CompileOnlyEventSink : IEventSink",
    'Task.FromException(new NotSupportedException("EventSink.emit is a compile-only protocol scaffold."))',
    'Task.FromException(new NotSupportedException("CheckpointStore.save is a compile-only protocol scaffold."))',
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "fixture_reference.rs"),
    "pub fn named(",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust-serde", "fixture_root.rs"),
    '#[cfg(feature = "serde")]',
    "impl serde::Serialize for FixtureRoot",
    "self.to_value(&SaveContext::default())",
    "impl<'de> serde::Deserialize<'de> for FixtureRoot",
    "Self::load_from_value(&value, &LoadContext::default())",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust-serde", "fixture_connection.rs"),
    "raw: serde_json::Map<String, serde_json::Value>",
    "impl serde::Serialize for FixtureConnectionKind",
    "FixtureConnection::load_from_value(&value, &LoadContext::default()).kind",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "rust-serde",
      "tests",
      "fixture_discriminator_edges_test.rs",
    ),
    '#[cfg(feature = "serde")]',
    "serde_json::from_str(json)",
    "serde_json::to_value(&instance)",
    "serde serialize must equal canonical to_value",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "fixture_property.rs"),
    "if let Some(value) = value.as_i64() {",
    "kind: FixturePropertyKind::FixtureIntegerProperty, default: Some(value.into())",
    "if let Some(value) = value.as_f64() {",
    "kind: FixturePropertyKind::FixtureNumberProperty, default: Some(value.into())",
  );
  // The float32-declared coercion must not narrow through f32: serde_json holds an
  // exact f64 and the vector contract requires "the unmodified scalar".
  assertExcludes(
    path.join("generated", "fixtures", "rust", "fixture_property.rs"),
    "value.as_f64().map(|value| value as f32)",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "rust",
      "tests",
      "protocol_scaffolds_test.rs",
    ),
    "impl EventSink for CompileOnlyEventSink",
    'Err("EventSink.emit is a compile-only protocol scaffold.".into())',
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "swift",
      "Sources",
      "TypraFixtures",
      "fixture_root.swift",
    ),
    "public struct FixtureRoot: TypraModel",
    "public static func load(_ data: Any",
    "public func save(_ context: SaveContext",
    'try FixtureContent.load(value, context: context.at("content"))',
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "swift",
      "Sources",
      "TypraFixtures",
      "wire_options.swift",
    ),
    "public func toWire(_ provider: String",
    "max_completion_tokens",
    "max_tokens",
    "public static func fromWire(_ provider: String, _ data: [String: Any], context: LoadContext = LoadContext()) throws -> WireOptions {",
    "return try load(canonical, context: context)",
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "swift",
      "Tests",
      "TypraFixturesTests",
      "ProtocolScaffoldsTests.swift",
    ),
    "final class ProtocolScaffoldsTests",
    "final class CompileOnlyEventSink: EventSink",
    "EventSink.emit is a compile-only protocol scaffold.",
  );
  assertIncludes(
    path.join("generated", "fixtures", "markdown", "FixtureRoot.md"),
    "FixtureOwner",
    "FixtureContent",
  );
  assertMarkdownFrontmatterFirst(
    path.join("generated", "fixtures", "markdown", "FixtureRoot.md"),
  );
  assertIncludes(
    path.join("generated", "fixtures", "markdown", "WireOptions.md"),
    "WireOptions",
    "maxOutputTokens",
  );
  assertMarkdownFrontmatterFirst(
    path.join("generated", "fixtures", "markdown", "WireOptions.md"),
  );
}

function assertExportSurfaceSnapshot() {
  const snapshot = readJson(
    path.join(
      "generated",
      "fixtures",
      ".typra-generated",
      "export-surfaces.json",
    ),
  );
  if (!snapshot) return;

  if (snapshot.emitter !== "typra-emitter" || snapshot.version !== 1) {
    fail("Export surface snapshot has an unexpected emitter/version.");
  }
  const toolchainPackages = snapshot.toolchain?.packages ?? [];
  const toolchainNames = toolchainPackages.map((entry) => entry.name);
  const sortedToolchainNames = [...toolchainNames].sort((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(toolchainNames) !== JSON.stringify(sortedToolchainNames)) {
    fail(
      "Export surface snapshot toolchain metadata is not sorted by package name.",
    );
  }
  for (const packageName of [
    "@typespec/compiler",
    "@typespec/json-schema",
    "@typra/emitter",
  ]) {
    const entry = toolchainPackages.find((item) => item.name === packageName);
    if (
      !entry?.version ||
      !entry?.supportedRange ||
      typeof entry.supported !== "boolean"
    ) {
      fail(
        `Export surface snapshot is missing complete toolchain metadata for ${packageName}.`,
      );
    }
  }
  if (snapshot.root?.object !== "Typra.Fixtures.FixtureRoot") {
    fail("Export surface snapshot does not record the fixture root object.");
  }

  const targets = new Map(
    (snapshot.targets ?? []).map((target) => [target.target, target]),
  );
  for (const target of [
    "typescript",
    "python",
    "go",
    "java",
    "csharp",
    "rust",
    "swift",
    "markdown",
  ]) {
    if (!targets.has(target)) {
      fail(`Export surface snapshot is missing target: ${target}`);
    }
  }
  if (
    !snapshot.targets?.some(
      (target) =>
        target.target === "typescript" &&
        target.outputRoot?.endsWith("generated/fixtures/typescript-zod"),
    )
  ) {
    fail("Export surface snapshot is missing the TypeScript Zod output root.");
  }
  if (
    !snapshot.targets?.some(
      (target) =>
        target.target === "rust" &&
        target.outputRoot?.endsWith("generated/fixtures/rust-serde"),
    )
  ) {
    fail("Export surface snapshot is missing the Rust serde output root.");
  }
  if (
    !snapshot.targets?.some(
      (target) =>
        target.target === "swift" &&
        target.outputRoot?.endsWith("generated/fixtures/swift-codable"),
    )
  ) {
    fail("Export surface snapshot is missing the Swift Codable output root.");
  }

  assertArrayIncludes(
    "TypeScript root exports",
    targets.get("typescript")?.rootExports ?? [],
    "FixtureRoot",
    "FixtureContent",
    "TextContent",
    "ImageContent",
    "EventSink",
    "CheckpointStore",
  );
  assertArrayIncludes(
    "Python root exports",
    targets.get("python")?.rootExports ?? [],
    "FixtureRoot",
    "FixtureContent",
    "TextContent",
    "ImageContent",
    "EventSink",
    "CheckpointStore",
  );
  assertArrayIncludes(
    "Rust root modules",
    targets.get("rust")?.modules ?? [],
    "context",
    "events",
    "pipeline",
  );
  assertArrayIncludes(
    "TypeScript root modules",
    targets.get("typescript")?.modules ?? [],
    "./event-sink",
    "./checkpoint-store",
  );
  assertArrayIncludes(
    "Python root modules",
    targets.get("python")?.modules ?? [],
    "._EventSink",
    "._CheckpointStore",
  );
  assertArrayIncludes(
    "C# grouped sources",
    (targets.get("csharp")?.exports ?? []).map((entry) => entry.source),
    "events/Checkpoint.cs",
    "EventSink.cs",
    "CheckpointStore.cs",
  );

  if (targets.get("go")?.packageName !== "fixtures") {
    fail(
      `Go export surface package name drifted: ${targets.get("go")?.packageName}`,
    );
  }
  if (targets.get("java")?.packageName !== "typra.fixtures") {
    fail(
      `Java export surface package name drifted: ${targets.get("java")?.packageName}`,
    );
  }

  const typeScriptProtocols = targets.get("typescript")?.protocols ?? [];
  const eventSink = typeScriptProtocols.find(
    (protocol) => protocol.name === "EventSink",
  );
  if (!eventSink) {
    fail("Export surface snapshot is missing EventSink protocol.");
  } else {
    const emit = eventSink.methods.find((method) => method.name === "emit");
    if (emit?.returns !== "void") {
      fail("EventSink.emit return shape drifted from void.");
    }
  }
}

function assertHydrationBoundarySnapshot() {
  const snapshot = readJson(
    path.join(
      "generated",
      "fixtures",
      ".typra-generated",
      "hydration-seams.json",
    ),
  );
  if (!snapshot) return;

  if (snapshot.emitter !== "typra-emitter" || snapshot.version !== 1) {
    fail("Hydration boundary snapshot has an unexpected emitter/version.");
  }
  const seams = snapshot.seams ?? [];
  const eventSink = seams.find(
    (seam) => seam.contract === "EventSink" && seam.target === "typescript",
  );
  if (!eventSink) {
    fail(
      "Hydration boundary snapshot is missing the TypeScript EventSink protocol seam.",
    );
  } else if (
    eventSink.generatedSource !== "./event-sink" ||
    eventSink.seamKind !== "protocol-adapter"
  ) {
    fail("Hydration boundary snapshot EventSink seam drifted.");
  }
}

function assertGeneratedOutputReport() {
  const report = readJson(
    path.join("generated", "fixtures", ".typra-generated", "report.json"),
  );
  if (!report) {
    fail("Generated output report is missing.");
    return;
  }

  if (report.emitter !== "typra-emitter" || report.version !== 1) {
    fail("Generated output report has an unexpected emitter/version.");
  }
  if (report.generatedAt !== "1970-01-01T00:00:00.000Z") {
    fail(
      "Generated output report must use deterministic generatedAt in fixture mode.",
    );
  }
  if (!Array.isArray(report.emittedFiles) || report.emittedFiles.length === 0) {
    fail("Generated output report must list emitted files.");
  }
  if (report.summary?.emittedFiles !== report.emittedFiles.length) {
    fail("Generated output report summary must count emitted files.");
  }
  if (report.summary?.skippedFiles !== report.skippedFiles?.length) {
    fail("Generated output report summary must count skipped files.");
  }
  if (report.summary?.hygiene !== "clean") {
    fail(
      "Generated output report summary must report clean hygiene for fixtures.",
    );
  }
  if (
    report.generation?.deterministicOutput !== true ||
    report.generation?.rootObject !== "Typra.Fixtures.FixtureRoot"
  ) {
    fail(
      "Generated output report must record deterministic generation context.",
    );
  }
  if (
    !report.generation?.emitTargets?.some(
      (entry) =>
        entry.type === "TypeScript" &&
        entry.outputDir?.endsWith("generated/fixtures/typescript"),
    )
  ) {
    fail("Generated output report must record emit target context.");
  }
  if (
    !report.emittedFiles.some((entry) =>
      entry.path.endsWith("generated/fixtures/python/_FixtureRoot.py"),
    )
  ) {
    fail(
      "Generated output report is missing a representative Python emitted file.",
    );
  }
  if (!Array.isArray(report.skippedFiles)) {
    fail("Generated output report must list skipped files.");
  }
  if (
    !Array.isArray(report.staleMarkerOwnedRemovals) ||
    !Array.isArray(report.preservedUnmarkedSkippedFiles)
  ) {
    fail("Generated output report must list cleanup action summaries.");
  }
  if (
    report.hygiene?.lineEndings !== "lf" ||
    report.hygiene?.finalNewline !== true ||
    report.hygiene?.trailingWhitespace !== "trimmed"
  ) {
    fail("Generated output report hygiene policy drifted.");
  }
  if (report.protectedPathTouches?.status !== "requires-verifier-baseline") {
    fail(
      "Generated output report must mark protected path touches as verifier-baseline scoped.",
    );
  }
  if (!Array.isArray(report.protectedPathTouches?.matchedFiles)) {
    fail("Generated output report must include protected path matched files.");
  }
  if (
    report.cleanup?.status !== "safe-noop" &&
    !(
      report.cleanup?.status === "review-recommended" &&
      report.staleMarkerOwnedRemovals?.length > 0
    )
  ) {
    fail("Generated output report cleanup status must be stable for fixtures.");
  }
  if (
    !report.driftGuidance?.metadataToCompare?.includes(
      ".typra-generated/export-surfaces.json",
    )
  ) {
    fail(
      "Generated output report must guide consumers to compare export surface metadata.",
    );
  }
  if (report.formatter?.status !== "not-recorded") {
    fail("Generated output report must not claim per-file formatter status.");
  }
}

function assertActualGeneratedSurface() {
  assertIncludes(
    path.join("generated", "fixtures", "typescript", "index.ts"),
    'export { FixtureRoot } from "./fixture-root";',
    "FixtureContent,",
    "TextContent,",
    "ImageContent,",
    '} from "./fixture-content";',
    'export type { EventSink } from "./event-sink";',
    'export type { CheckpointStore } from "./checkpoint-store";',
  );
  assertIncludes(
    path.join("generated", "fixtures", "python", "__init__.py"),
    "from ._EventSink import EventSink",
    "from ._CheckpointStore import CheckpointStore",
    '    "EventSink",',
    '    "CheckpointStore",',
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "mod.rs"),
    "pub mod events;\npub use events::*;",
    "pub mod pipeline;\npub use pipeline::*;",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "fixture_root.rs"),
    "pub enum FixtureStatus",
    "pub enum FixtureMode",
    "Self::from_str_ignore_case_opt(s)",
    "pub fn from_str_ignore_case_opt(s: &str) -> Option<Self>",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "mod.rs"),
    "pub mod event_sink;\npub use event_sink::*;",
    "pub mod checkpoint_store;\npub use checkpoint_store::*;",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "fixture_root.go"),
    "package fixtures",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "FixtureRoot.java"),
    "package typra.fixtures;",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "event_sink.go"),
    "package fixtures",
  );
  assertIncludes(
    path.join("generated", "fixtures", "typescript", "event-sink.ts"),
    "emit(event: unknown, signal?: AbortSignal): Promise<void>;",
  );
  assertIncludes(
    path.join("generated", "fixtures", "python", "_EventSink.py"),
    "def emit(self, event: Any, cancellation: CancellationToken | None = None) -> None:",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "event_sink.rs"),
    "async fn emit(&self, event: &serde_json::Value, cancellation: &CancellationToken) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;",
  );
  assertIncludes(
    path.join("generated", "fixtures", "swift", "Package.swift"),
    'name: "TypraFixtures"',
    '.testTarget(name: "TypraFixturesTests"',
  );
  assertIncludes(
    path.join(
      "generated",
      "fixtures",
      "swift",
      "Sources",
      "TypraFixtures",
      "event_sink.swift",
    ),
    "public protocol EventSink",
    "func emit(event: Any) async throws",
  );
}

function assertNoEmptyTargetDirs() {
  for (const target of [
    "typescript",
    "python",
    "python_pydantic",
    "go",
    "java",
    "java-jackson",
    "csharp",
    "rust",
    "swift",
    "markdown",
  ]) {
    const dir = path.join(generatedRoot, target);
    if (
      existsSync(dir) &&
      statSync(dir).isDirectory() &&
      walkFiles(dir).length === 0
    ) {
      fail(`Generated target directory is empty: ${target}`);
    }
  }
}

function authorVectorAdapters() {
  const adapterSourceRoot = path.join(
    packageRoot,
    "fixtures",
    "integration",
    "vector-adapters",
  );
  // Reference adapter source -> the targets that consume it (variant targets
  // reuse their base language's adapter). Dest is relative to the target's
  // generated tree and must match the location the emitted suite imports from.
  const adapterCopyPlan = [
    {
      src: "typescript/vector-adapters.ts",
      targets: [
        { dir: "typescript", dest: "tests/vector-adapters.ts" },
        { dir: "typescript-zod", dest: "tests/vector-adapters.ts" },
      ],
    },
    {
      src: "python/vector_adapters.py",
      targets: [
        { dir: "python", dest: "tests/vector_adapters.py" },
        { dir: "python_pydantic", dest: "tests/vector_adapters.py" },
      ],
    },
    {
      src: "go/adapters.go",
      targets: [{ dir: "go", dest: "vectoradapters/adapters.go" }],
    },
    {
      src: "rust/vector_adapters.rs",
      targets: [
        { dir: "rust", dest: "tests/vector_adapters.rs" },
        { dir: "rust-serde", dest: "tests/vector_adapters.rs" },
      ],
    },
    {
      src: "csharp/VectorAdapters.cs",
      targets: [{ dir: "csharp", dest: "tests/VectorAdapters.cs" }],
    },
    {
      src: "java/VectorAdapters.java",
      targets: [
        { dir: "java", dest: "tests/VectorAdapters.java" },
        { dir: "java-jackson", dest: "tests/VectorAdapters.java" },
      ],
    },
    {
      src: "swift/VectorAdapters.swift",
      targets: [
        { dir: "swift", dest: "Tests/TypraFixturesTests/VectorAdapters.swift" },
        {
          dir: "swift-codable",
          dest: "Tests/TypraFixturesTests/VectorAdapters.swift",
        },
      ],
    },
  ];

  let authored = 0;
  for (const entry of adapterCopyPlan) {
    const sourcePath = path.join(adapterSourceRoot, entry.src);
    if (!existsSync(sourcePath)) {
      fail(`Missing reference vector adapter source: ${entry.src}`);
      continue;
    }
    // Normalize to LF so authored files stay gofmt/hygiene clean regardless of
    // how the committed source was checked out on the host.
    const contents = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
    for (const target of entry.targets) {
      const targetRoot = path.join(generatedRoot, target.dir);
      if (!existsSync(targetRoot)) {
        // Target was not emitted (e.g. filtered run) — nothing to author into.
        continue;
      }
      const destPath = path.join(targetRoot, target.dest);
      mkdirSync(path.dirname(destPath), { recursive: true });
      writeFileSync(destPath, contents);
      authored += 1;
    }
  }

  if (authored === 0) {
    fail("Vector adapter authoring copied no files; generated tree missing.");
  }
}

function runDeclaredValidationStages() {
  runExpectedExecutionPlan({
    label: "Fixture validation",
    expectedIds: EXPECTED_VALIDATION_STAGE_IDS,
    implementations: new Map([
      ["generated-targets", assertGeneratedTargets],
      ["empty-target-dirs", assertNoEmptyTargetDirs],
      ["output-hygiene", assertGeneratedOutputHygiene],
      ["structured-load-coverage", assertGeneratedStructuredLoadCoverage],
      ["focused-feature-fixtures", assertFocusedFeatureFixtures],
      ["static-fixture-coverage", assertStaticFixtureCoverage],
      ["static-conformance-matrix", assertConformanceMatrix],
      ["export-surface-snapshot", assertExportSurfaceSnapshot],
      ["hydration-boundary-snapshot", assertHydrationBoundarySnapshot],
      ["generated-output-report", assertGeneratedOutputReport],
      ["actual-generated-surface", assertActualGeneratedSurface],
      ["typra-verify", runTypraVerify],
      ["consumer-smoke", runTypraConsumerSmoke],
      ["vector-adapters.author", authorVectorAdapters],
      ["typescript.compile", runGeneratedTypeScriptCompile],
      ["typescript-zod.compile", runGeneratedTypeScriptZodCompile],
      ["typescript.web-compile", runGeneratedTypeScriptWebCompile],
      ["typescript-zod.web-compile", runGeneratedTypeScriptZodWebCompile],
      ["typescript.web-runtime", runTypeScriptWebRuntimeSmoke],
      ["typescript-zod.web-runtime", runTypeScriptZodWebRuntimeSmoke],
      ["typescript.runtime-neutrality", assertTypeScriptRuntimeNeutrality],
      ["python.compile", () => runPythonCompile()],
      ["python_pydantic.compile", () => runPythonCompile("python_pydantic")],
      ["python.lint", () => runPythonRuffCheck()],
      ["python_pydantic.lint", () => runPythonRuffCheck("python_pydantic")],
      ["typescript.generated-tests", runTypeScriptGeneratedTests],
      [
        "typescript.vector-conformance-compile",
        runTypeScriptVectorConformanceCompile,
      ],
      ["python.generated-tests", () => runPythonGeneratedTests()],
      [
        "python_pydantic.generated-tests",
        () => runPythonGeneratedTests("python_pydantic", "fixtures_pydantic"),
      ],
      [
        "python.vector-conformance-compile",
        (context) => runPythonVectorConformanceCompile(context),
      ],
      ["go.generated-tests", runGoTests],
      [
        "go.vector-bridge-compile",
        (context) => runGoVectorBridgeCompile(context),
      ],
      [
        "go.vector-conformance-compile",
        (context) => runGoVectorConformanceCompile(context),
      ],
      ["rust.generated-tests", () => runRustTests()],
      [
        "rust.dispatch-regression-compile",
        (context) => runRustDispatchRegressionCompile(context),
      ],
      [
        "rust.vector-conformance-compile",
        (context) => runRustVectorConformanceCompile(context),
      ],
      [
        "rust-serde.generated-tests",
        () => runRustTests("rust-serde", "fixtures_serde"),
      ],
      ["swift.generated-tests", () => runSwiftTests()],
      [
        "swift.vector-conformance-compile",
        (context) => runSwiftVectorConformanceCompile(context),
      ],
      ["swift-codable.generated-tests", () => runSwiftCodableTests()],
      ["csharp.build", runCSharpBuild],
      ["csharp.consumer-nullability-build", runCSharpConsumerNullabilityBuild],
      ["csharp.generated-tests", runCSharpGeneratedTests],
      ["csharp.protocol-scaffold-build", runCSharpProtocolScaffoldBuild],
      [
        "csharp.vector-conformance-compile",
        (context) => runCSharpVectorConformanceCompile(context),
      ],
      ["java.build", runJavaBuild],
      ["java.generated-tests", runJavaGeneratedTests],
      [
        "java.vector-conformance-compile",
        (context) => runJavaVectorConformanceCompile(context),
      ],
      ["java-jackson.build", runJavaJacksonBuild],
      ["java-jackson.generated-tests", runJavaJacksonGeneratedTests],
      ...IDEMPOTENCY_TARGETS.map((target) => [
        target.stageId,
        (context) => runIdempotencyGuard(target, context),
      ]),
      ["executable-conformance", runExecutableConformance],
    ]),
    allowedSkips: {
      ...idempotencyAllowedSkips(),
      "typescript.runtime-neutrality": "no TypeScript targets generated",
      "rust.dispatch-regression-compile": "cargo is not available",
      "rust.vector-conformance-compile": "cargo is not available",
      "go.vector-bridge-compile": "go is not available",
      "go.vector-conformance-compile": "go is not available",
      "python.vector-conformance-compile": "uv is not available",
      "swift.vector-conformance-compile": "swift is not available",
      "csharp.vector-conformance-compile": "dotnet is not available",
      "java.vector-conformance-compile": "javac is not available",
    },
  });
}

runDeclaredValidationStages();

if (failures.length > 0) {
  console.error("Fixture validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Fixture validation passed.");
