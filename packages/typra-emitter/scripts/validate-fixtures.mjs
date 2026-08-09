import { execFileSync as nodeExecFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareExpectedExecution, TOOLCHAIN_UNAVAILABLE } from "./validation-execution.mjs";

const packageRoot = process.cwd();

/**
 * Node defaults `maxBuffer` to 1 MB and throws ENOBUFS past it. The verifier's `--json`
 * self-compare already emits ~1 MB for the current fixture set, so any fixture growth makes
 * every child process here fail in a way that is indistinguishable from a real tool failure.
 * These are all build/test/verify steps whose output we want in full.
 */
const CHILD_PROCESS_MAX_BUFFER = 64 * 1024 * 1024;

function execFileSync(file, args, options = {}) {
  return nodeExecFileSync(file, args, { maxBuffer: CHILD_PROCESS_MAX_BUFFER, ...options });
}
const sourceGeneratedRoot = path.join(packageRoot, "generated", "fixtures");
const validationRoot = mkdtempSync(path.join(tmpdir(), "typra-fixtures-"));
const generatedRoot = path.join(validationRoot, "fixtures");
const packageNodeModules = path.resolve(packageRoot, "..", "..", "node_modules");
const scratchEntries = new Set([
  ".build",
  ".classes",
  "__pycache__",
  "bin",
  "obj",
  "target",
]);
cpSync(sourceGeneratedRoot, generatedRoot, {
  recursive: true,
  filter: source => !scratchEntries.has(path.basename(source)),
});
if (existsSync(packageNodeModules)) {
  symlinkSync(packageNodeModules, path.join(validationRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}
process.on("exit", () => rmSync(validationRoot, { recursive: true, force: true }));
const failures = [];
const CSHARP_TARGET_FRAMEWORK = "net10.0";

const EXPECTED_VALIDATION_STAGE_IDS = [
  "generated-targets",
  "empty-target-dirs",
  "output-hygiene",
  "structured-load-coverage",
  "static-fixture-coverage",
  "static-conformance-matrix",
  "export-surface-snapshot",
  "hydration-boundary-snapshot",
  "generated-output-report",
  "actual-generated-surface",
  "typra-verify",
  "consumer-smoke",
  "typescript.compile",
  "typescript-zod.compile",
  "python.compile",
  "python_pydantic.compile",
  "python.generated-tests",
  "python_pydantic.generated-tests",
  "go.generated-tests",
  "rust.generated-tests",
  "swift.generated-tests",
  "csharp.build",
  "csharp.consumer-nullability-build",
  "csharp.generated-tests",
  "csharp.protocol-scaffold-build",
  "java.build",
  "java.generated-tests",
  "java-jackson.build",
  "java-jackson.generated-tests",
  "executable-conformance",
];

const EXPECTED_EXECUTABLE_CONFORMANCE_TARGET_IDS = [
  "typescript",
  "typescript-zod",
  "python",
  "python_pydantic",
  "go",
  "rust",
  "rust-unknown",
  "csharp",
  "java",
  "swift",
];

const JACKSON_VERSION = "2.17.2";
const JACKSON_ARTIFACTS = [
  "jackson-annotations",
  "jackson-core",
  "jackson-databind",
];
const fixtureRootSample = {
  name: "fixture-root",
  description: "A generated fixture with broad emitter coverage.",
  tags: ["typespec", "emitter", "validation"],
  metadata: {
    source: "fixture",
    version: 1,
  },
  typedRecords: {
    counts: {
      alpha: 1,
      beta: 2,
    },
    owners: {
      primary: {
        id: "owner-typed-1",
        displayName: "Typed Owner",
      },
    },
  },
  owner: {
    id: "owner-1",
    displayName: "Fixture Owner",
  },
  content: {
    kind: "text",
    value: "hello from a polymorphic sample",
  },
  contentItems: [
    {
      kind: "text",
      value: "hello from a polymorphic collection",
    },
  ],
  status: "complete",
  mode: "bulk",
  zeroValues: {
    emptyText: "",
    zeroCount: 0,
    zeroRatio: 0,
    falseFlag: false,
    emptyItems: [],
  },
  // absentText is deliberately omitted: an absent optional must stay off the wire, while the
  // explicitly-zero optionals below must stay on it. See FixtureOptionalStates in main.tsp.
  optionalStates: {
    presentText: "present",
    emptyText: "",
    zeroCount: 0,
    falseFlag: false,
    emptyItems: [],
  },
  // int32 extremes plus an integral and a negative float. A mismatch that survives the 6dp
  // rounding in normalizeConformanceValue is genuine; a divergence below 5e-7 is not visible to
  // it, and narrowing to float32 is not covered. See FixtureNumericBounds in main.tsp.
  numericBounds: {
    int32Min: -2147483648,
    int32Max: 2147483647,
    negativeCount: -42,
    wholeRatio: 2,
    preciseRatio: -0.125,
  },
  // Characters a serializer must escape or encode rather than copy. TAB is the sharpest: RFC 8259
  // forbids an unescaped character below U+0020, so a writer that copies it emits a document that
  // is not JSON. See FixtureAdversarialText in main.tsp for what this case does and does not cover.
  adversarialText: {
    tabbed: "column\tseparated",
    multiline: "first line\nsecond line",
    quoted: 'she said "hello" once',
    backslashed: 'back\\slash and \\"escaped\\" text',
    unicodeText: "café — naïve ✓",
    astralText: "emoji 🙂 tail",
    paddedText: "  padded  ",
  },
  // Discriminator values no subtype claims outright. wildcardSelected is the shape behind the
  // original missing-required-field defect: connection is a required complex field on a subtype
  // whose discriminator is a wildcard. See FixtureDiscriminatorEdges in main.tsp.
  discriminatorEdges: {
    wildcardSelected: {
      kind: "vendor-extension",
      name: "wildcard-selected tool",
      connection: { kind: "custom", endpoint: "https://example.test" },
      config: { enabled: true },
    },
    openUnknown: { kind: "vendor-unrecognized", label: "absorbed by the open base" },
    unclaimedClosed: { kind: "plain", label: "permitted but unclaimed" },
    namedOpenUnknown: { kind: "vendor-specific", label: "unrecognized named open kind" },
  },
  // Collections at zero, one and many. The keyed dual-form fields accept either a list of named
  // items or a map keyed by name; given unique, non-empty names both forms canonicalize to the
  // same map-shaped saved output. Array order is compared; key order within the saved keyed map
  // is not, because the normalizer sorts object keys. See FixtureCollectionCardinality in main.tsp.
  collectionCardinality: {
    repeatedTags: ["alpha", "beta", "alpha"],
    singleTag: ["only"],
    mixedContent: [
      { kind: "image", url: "https://example.test/first.png" },
      { kind: "text", value: "second element" },
      { kind: "text", value: "third element" },
    ],
    listForm: [
      { name: "alpha", first: "alpha first", second: "alpha second" },
      { name: "beta", first: "beta first", second: "beta second" },
    ],
    mapForm: {
      epsilon: { first: "epsilon first", second: "epsilon second" },
      delta: { first: "delta first", second: "delta second" },
    },
    singleListForm: [{ name: "solo", first: "solo first", second: "solo second" }],
    singleMapForm: {
      lone: { first: "lone first", second: "lone second" },
    },
    emptyForm: [],
  },
  // Polymorphic dispatch chained several levels deep. propertyTree nests
  // object -> array -> union -> object -> integer, so five dispatch decisions are chained with a
  // collection in the middle; branchTrees varies recursion depth between elements of one
  // collection. Every value is written as a full kind-tagged object so that scalar coercion into
  // FixtureProperty stays out of this class. See FixtureDeepNesting in main.tsp.
  deepNesting: {
    propertyTree: {
      kind: "object",
      name: "tree-root",
      description: "root of the nested tree",
      additionalProperties: {
        kind: "array",
        name: "level-one-array",
        items: {
          kind: "union",
          name: "level-two-union",
          anyOf: [
            { kind: "string", name: "level-three-string", required: true },
            {
              kind: "object",
              name: "level-three-object",
              additionalProperties: { kind: "integer", name: "level-four-integer", nullable: true },
            },
          ],
        },
      },
    },
    branchTrees: [
      { kind: "string", name: "shallow-leaf" },
      { kind: "array", name: "one-deep", items: { kind: "boolean", name: "nested-boolean" } },
      {
        kind: "union",
        name: "two-deep",
        anyOf: [
          { kind: "number", name: "union-number" },
          { kind: "array", name: "union-array", items: { kind: "string", name: "deepest-string" } },
        ],
      },
    ],
  },
};
// One canonical conformance input, embedded into every target program.
//
// The seven conformance runners each used to hand-write this payload in their own target
// syntax. Nothing asserted those copies agreed, and they had already drifted -- the C# copy
// carried a `metadata.nullable` key no other target was given. Divergent inputs compared
// against a single shared expectation quietly weakens the oracle, because a target can pass
// on a payload its peers never saw. Every runner now parses this one document through its
// standard JSON entry point, so widening the corpus is a single edit to fixtureRootSample.
const fixtureRootSampleJsonLiteral = JSON.stringify(JSON.stringify(fixtureRootSample));

// The C# runner previously smuggled an extra `metadata.nullable` key into its private copy of
// the payload to prove Record<unknown> preserves explicit nulls. That assertion is worth
// keeping, so it now runs against its own explicit variant rather than silently changing the
// shared input out from under the cross-language comparison.
const fixtureRootNullMetadataJsonLiteral = JSON.stringify(JSON.stringify({
  ...fixtureRootSample,
  metadata: { ...fixtureRootSample.metadata, nullable: null },
}));

const wireOptionsSample = {
  maxOutputTokens: 256,
  temperature: 0.7,
};
const imageContentSample = {
  kind: "image",
  url: "https://example.com/fixture.png",
};
const fixtureRootExpected = {
  ...fixtureRootSample,
  status: "ready",
  mode: "batch",
  // A keyed collection is written in its map form regardless of which form it was read from, so
  // the list-form inputs converge on the shape the map-form inputs were given in, and the entry
  // name moves from the body to the key. That canonicalization holds because these names are
  // unique and non-empty; a duplicated or empty name would fall back to list form instead.
  collectionCardinality: {
    ...fixtureRootSample.collectionCardinality,
    listForm: {
      alpha: { first: "alpha first", second: "alpha second" },
      beta: { first: "beta first", second: "beta second" },
    },
    singleListForm: {
      solo: { first: "solo first", second: "solo second" },
    },
    emptyForm: {},
  },
};
const conformanceCanonical = {
  root: fixtureRootExpected,
  imageContent: imageContentSample,
  openai: {
    max_completion_tokens: 256,
    temperature: 0.7,
  },
  anthropic: {
    max_tokens: 256,
  },
  // A provider with no @knownAs mapping at all must produce an empty payload, as must an empty
  // provider string. Emitting fields under their schema names for an unmapped or empty provider
  // is a defect (swift emitted for any unmapped provider; java emitted for the empty provider).
  unmapped: {},
  emptyProvider: {},
  reference: {
    id: "ref-coerced",
    label: "coerced reference",
  },
};
const conformanceExpected = normalizeConformanceValue(conformanceCanonical);

// Known cross-language divergences: real, open defects that this corpus catches today.
//
// These are NOT accepted behaviour, and this is not a mute switch. Each entry pins the exact
// wrong output a target currently produces, which keeps the gate green on a tracked defect
// without going blind to it:
//   - if the target's output changes in any *other* way, the gate still fails;
//   - if the target starts matching canonical output, the gate fails and demands the entry be
//     deleted, so the suppression cannot outlive the bug it documents.
const conformanceKnownDivergences = {};

function fail(message) {
  failures.push(message);
}

function runExpectedExecutionPlan({ label, expectedIds, implementations, allowedSkips = {} }) {
  const executed = [];
  const skipped = [];

  for (const id of expectedIds) {
    const run = implementations.get(id);
    if (!run) continue;

    const beforeSkipCount = skipped.length;
    // A stage that intentionally does no work must call context.skip(); every other no-op path
    // should call fail(), otherwise invocation would be misreported as real execution.
    run({
      skip(reason) {
        skipped.push({ id, reason });
      },
    });
    if (!skipped.slice(beforeSkipCount).some(entry => entry.id === id)) {
      executed.push(id);
    }
  }

  const result = compareExpectedExecution({
    label,
    expected: expectedIds,
    implemented: [...implementations.keys()],
    executed,
    skipped,
    allowedSkips,
  });
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }
  for (const message of result.failures) {
    fail(message);
  }
}

function normalizeConformanceValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeConformanceValue(item));
  }
  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      normalized[key] = normalizeConformanceValue(value[key]);
    }
    return normalized;
  }
  if (typeof value === "number") {
    return Math.round(value * 1_000_000) / 1_000_000;
  }
  return value;
}

function assertConformanceResult(target, rawOutput) {
  let actual;
  try {
    actual = normalizeConformanceValue(JSON.parse(rawOutput));
  } catch (error) {
    const lastLine = rawOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
    try {
      actual = normalizeConformanceValue(JSON.parse(lastLine ?? ""));
    } catch {
      fail(`Executable conformance for ${target} did not emit valid JSON: ${error.message}\n${rawOutput}`);
      return;
    }
  }

  const actualJson = JSON.stringify(actual);
  const divergence = conformanceKnownDivergences[target];

  if (actualJson === JSON.stringify(conformanceExpected)) {
    if (divergence) {
      fail(
        `Executable conformance for ${target} now matches canonical output, but a known divergence ` +
        `is still recorded for ${divergence.issue}. The defect appears fixed -- delete the ` +
        `conformanceKnownDivergences entry so the gate holds the corrected behaviour from now on.`,
      );
    }
    return;
  }

  if (divergence && actualJson === JSON.stringify(divergence.expected)) {
    console.warn(
      `[known divergence] ${target} conformance differs from canonical output as recorded in ` +
      `${divergence.issue}: ${divergence.summary}`,
    );
    return;
  }

  fail(`Executable conformance for ${target} did not match canonical output.\nExpected: ${JSON.stringify(conformanceExpected)}\nActual: ${actualJson}`);
}

function requirePath(relativePath) {
  const fullPath = path.join(packageRoot, relativePath);
  if (!existsSync(fullPath)) {
    fail(`Missing expected fixture artifact: ${relativePath}`);
  }
  return fullPath;
}

function read(relativePath) {
  const fullPath = requirePath(relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

function assertIncludes(relativePath, ...needles) {
  const content = read(relativePath);
  for (const needle of needles) {
    if (!content.includes(needle)) {
      fail(`${relativePath} does not include expected content: ${needle}`);
    }
  }
}

function assertExcludes(relativePath, ...needles) {
  const content = read(relativePath);
  for (const needle of needles) {
    if (content.includes(needle)) {
      fail(`${relativePath} includes unexpected content: ${needle}`);
    }
  }
}

function assertMarkdownFrontmatterFirst(relativePath) {
  const content = read(relativePath);
  if (!content.startsWith("---\n")) {
    fail(`${relativePath} must start with YAML frontmatter.`);
    return;
  }

  const closingDelimiter = "\n---\n";
  const closingIndex = content.indexOf(closingDelimiter, 4);
  if (closingIndex < 0) {
    fail(`${relativePath} is missing a closing YAML frontmatter delimiter.`);
    return;
  }

  const afterFrontmatter = content.slice(closingIndex + closingDelimiter.length);
  if (!afterFrontmatter.startsWith("<!-- <auto-generated by typra-emitter> -->\n")) {
    fail(`${relativePath} must emit the generated marker after YAML frontmatter.`);
  }
}

function assertArrayIncludes(label, actual, ...expected) {
  for (const value of expected) {
    if (!actual.includes(value)) {
      fail(`${label} does not include expected value: ${value}`);
    }
  }
}

function assertConformanceMatrix() {
  const matrix = readJson(path.join("fixtures", "conformance-matrix.json"));
  if (!matrix) return;

  if (matrix.version !== 1) {
    fail("Conformance matrix has an unexpected version.");
  }
  if (!Array.isArray(matrix.targets) || matrix.targets.length === 0) {
    fail("Conformance matrix must declare at least one target.");
    return;
  }
  if (!Array.isArray(matrix.cases) || matrix.cases.length === 0) {
    fail("Conformance matrix must declare at least one case.");
    return;
  }
  if (!Array.isArray(matrix.rules) || matrix.rules.length === 0) {
    fail("Conformance matrix must declare at least one semantic rule.");
    return;
  }

  const caseIds = new Set();
  for (const conformanceCase of matrix.cases) {
    if (!conformanceCase.id) {
      fail("Conformance matrix contains a case without an id.");
      continue;
    }
    if (caseIds.has(conformanceCase.id)) {
      fail(`Conformance matrix contains duplicate case id: ${conformanceCase.id}`);
    }
    caseIds.add(conformanceCase.id);
  }

  const enforcedCases = new Set();
  const ruleIds = new Set();
  for (const rule of matrix.rules) {
    if (!rule.id) {
      fail("Conformance matrix contains a rule without an id.");
      continue;
    }
    if (ruleIds.has(rule.id)) {
      fail(`Conformance matrix contains duplicate rule id: ${rule.id}`);
    }
    ruleIds.add(rule.id);

    if (rule.status === "enforced") {
      if (rule.verification === "fixture-evidence") {
        if (!rule.case) {
          fail(`Enforced fixture-evidence rule ${rule.id} must reference a case.`);
        } else if (!caseIds.has(rule.case)) {
          fail(`Enforced conformance rule ${rule.id} references unknown case ${rule.case}.`);
        } else {
          enforcedCases.add(rule.case);
        }
      } else if (rule.verification === "unit-test") {
        if (Object.prototype.hasOwnProperty.call(rule, "case")) {
          fail(`Unit-test conformance rule ${rule.id} must not reference a fixture case.`);
        }
      } else {
        fail(`Enforced conformance rule ${rule.id} must declare verification as fixture-evidence or unit-test.`);
      }
      if (
        (rule.verification === "unit-test" || Object.prototype.hasOwnProperty.call(rule, "test")) &&
        (typeof rule.test !== "string" || !existsSync(path.join(packageRoot, "..", "..", rule.test)))
      ) {
        fail(`Enforced conformance rule ${rule.id} must reference an existing test file.`);
      }
    } else if (rule.status === "known-gap") {
      if (Object.prototype.hasOwnProperty.call(rule, "case")) {
        fail(`Known-gap conformance rule ${rule.id} must not reference a case until it is promoted to enforced.`);
      }
      if (caseIds.has(rule.id)) {
        fail(`Known-gap conformance rule ${rule.id} collides with an existing case id.`);
      }
      if (typeof rule.issue !== "string" || !/^#\d+$/.test(rule.issue)) {
        fail(`Known-gap conformance rule ${rule.id} must reference a GitHub issue like #123.`);
      }
    } else {
      fail(`Conformance rule ${rule.id} has unsupported status: ${rule.status}`);
    }
  }

  for (const conformanceCase of matrix.cases) {
    if (!enforcedCases.has(conformanceCase.id)) {
      fail(`Conformance case ${conformanceCase.id} is not referenced by an enforced rule.`);
    }
  }

  for (const conformanceCase of matrix.cases) {
    const evidenceTargets = [...new Set([...matrix.targets, ...Object.keys(conformanceCase.evidence ?? {})])];
    for (const target of evidenceTargets) {
      const evidence = conformanceCase.evidence?.[target];
      if (!Array.isArray(evidence) || evidence.length === 0) {
        fail(`Conformance case ${conformanceCase.id} is missing evidence for target ${target}.`);
        continue;
      }

      for (const item of evidence) {
        if (!item.path) {
          fail(`Conformance case ${conformanceCase.id}/${target} contains evidence without a path.`);
          continue;
        }
        if (!Array.isArray(item.snippets) || item.snippets.length === 0) {
          fail(`Conformance case ${conformanceCase.id}/${target}/${item.path} has no snippets.`);
          continue;
        }
        assertIncludes(item.path, ...item.snippets);
      }
    }
  }
}

function readJson(relativePath) {
  const content = read(relativePath);
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function walkFiles(dir, predicate = () => true) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, predicate));
    } else if (predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

const GENERATED_TEXT_EXTENSIONS = new Set([
  ".cs",
  ".go",
  ".java",
  ".json",
  ".md",
  ".py",
  ".rs",
  ".swift",
  ".toml",
  ".ts",
  ".yaml",
  ".yml",
]);

function isGeneratedTextFile(file) {
  if (file.includes(`${path.sep}.build${path.sep}`)) {
    return false;
  }
  return GENERATED_TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
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

function assertGeneratedStructuredLoadCoverage() {
  const exportSurface = readJson(path.join("generated", "fixtures", ".typra-generated", "export-surfaces.json"));
  const kebabCase = value => value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  const snakeCase = value => kebabCase(value).replace(/-/g, "_");
  const pascalCase = value => value
    .split(/[_-]/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join("");
  const suites = [
    {
      target: "typescript",
      outputRoot: "generated/fixtures/typescript",
      dir: path.join(generatedRoot, "typescript", "tests"),
      testFile: file => file.endsWith(".test.ts"),
      expectedTestPath: (name, group) => path.join(generatedRoot, "typescript", "tests", group || "", `${kebabCase(name)}.test.ts`),
      hasStructuredLoad: content => content.includes("should load from JSON - example 1"),
    },
    {
      target: "python",
      outputRoot: "generated/fixtures/python",
      dir: path.join(generatedRoot, "python", "tests"),
      testFile: file => file.endsWith(".py"),
      expectedTestPath: (name, group) => path.join(generatedRoot, "python", "tests", group || "", `test_${snakeCase(name)}.py`),
      hasStructuredLoad: content => /def test_load_json_\w+\(/.test(content),
    },
    {
      target: "python_pydantic",
      outputRoot: "generated/fixtures/python_pydantic",
      dir: path.join(generatedRoot, "python_pydantic", "tests"),
      testFile: file => file.endsWith(".py"),
      expectedTestPath: (name, group) => path.join(generatedRoot, "python_pydantic", "tests", group || "", `test_${snakeCase(name)}.py`),
      hasStructuredLoad: content => /def test_load_json_\w+\(/.test(content),
    },
    {
      target: "go",
      outputRoot: "generated/fixtures/go",
      dir: path.join(generatedRoot, "go", "tests"),
      testFile: file => file.endsWith("_test.go"),
      expectedTestPath: name => path.join(generatedRoot, "go", "tests", `${snakeCase(name)}_test.go`),
      hasStructuredLoad: content => /func Test\w+LoadJSON\(t \*testing\.T\)/.test(content),
    },
    {
      target: "java",
      outputRoot: "generated/fixtures/java",
      dir: path.join(generatedRoot, "java", "tests"),
      testFile: file => file.endsWith("GeneratedTest.java"),
      expectedTestPath: name => path.join(generatedRoot, "java", "tests", `${name}GeneratedTest.java`),
      hasStructuredLoad: content => /\.fromJson\(jsonData1\)/.test(content),
    },
    {
      target: "csharp",
      outputRoot: "generated/fixtures/csharp",
      dir: path.join(generatedRoot, "csharp", "tests"),
      testFile: file => file.endsWith("ConversionTests.cs"),
      expectedTestPath: (name, group) => path.join(generatedRoot, "csharp", "tests", group || "", `${name}ConversionTests.cs`),
      hasStructuredLoad: content => /\bLoadJsonInput1?\(/.test(content),
    },
    {
      target: "rust",
      outputRoot: "generated/fixtures/rust",
      dir: path.join(generatedRoot, "rust", "tests"),
      testFile: file => file.endsWith("_test.rs"),
      expectedTestPath: (_name, group, source) => {
        const moduleName = source.split("::").at(-1);
        return path.join(generatedRoot, "rust", "tests", group || "", `${moduleName}_test.rs`);
      },
      hasStructuredLoad: content => /fn test_\w+_load_json\(\)/.test(content),
    },
    {
      target: "swift",
      outputRoot: "generated/fixtures/swift",
      dir: path.join(generatedRoot, "swift", "Tests", "TypraFixturesTests"),
      testFile: file => file.endsWith("Tests.swift"),
      expectedTestPath: (_name, group, source) => {
        const moduleName = path.basename(source, ".swift");
        return path.join(generatedRoot, "swift", "Tests", "TypraFixturesTests", group || "", `${pascalCase(moduleName)}Tests.swift`);
      },
      hasStructuredLoad: content => /func testJSONRoundTrip1\(\) throws/.test(content),
    },
  ];

  for (const suite of suites) {
    const target = exportSurface?.targets?.find(entry => entry.outputRoot === suite.outputRoot);
    if (target && suite.expectedTestPath) {
      const missing = (target.exports ?? [])
        .filter(entry => entry.kind === "value" && !entry.protocol)
        .map(entry => suite.expectedTestPath(entry.name, entry.group, entry.source))
        .filter((file, index, files) => files.indexOf(file) === index)
        .filter(file => !existsSync(file));
      if (missing.length > 0) {
        fail(
          `Generated ${suite.target} fixture exports without test files:\n`
          + missing.map(file => `  ${path.relative(packageRoot, file)}`).join("\n"),
        );
      }
    }

    const files = walkFiles(suite.dir, file => {
      const basename = path.basename(file);
      const lower = basename.toLowerCase();
      const normalized = lower.replace(/[^a-z0-9]/g, "");
      return suite.testFile(file)
        && !normalized.includes("protocolscaffolds")
        && lower !== "test_context.py"
        && lower !== "conformancetests.swift";
    });
    if (files.length === 0) {
      fail(`No generated ${suite.target} fixture tests found for structured load coverage.`);
      continue;
    }

    const missing = files.filter(file => !suite.hasStructuredLoad(readFileSync(file, "utf8")));
    if (missing.length > 0) {
      fail(
        `Generated ${suite.target} fixture tests without structured JSON load coverage:\n`
        + missing.map(file => `  ${path.relative(packageRoot, file)}`).join("\n"),
      );
    }
  }
}

function isMarkerOnlyContent(content) {
  const trimmed = content.trim();
  return trimmed === "# <auto-generated by typra-emitter>" ||
    trimmed === "// <auto-generated by typra-emitter>" ||
    trimmed === "<!-- <auto-generated by typra-emitter> -->";
}

function findTypeScriptCli(startDir) {
  let current = startDir;
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(candidate)) {
      return candidate;
    }
    current = path.dirname(current);
  }
  fail("Unable to locate local TypeScript compiler for generated fixture validation.");
  return undefined;
}

function typeScriptTypeRoots(tscCli) {
  return [path.resolve(path.dirname(tscCli), "..", "..", "@types")];
}

function runGeneratedTypeScriptCompileFor(targetDir, label) {
  const sourceDir = path.join(generatedRoot, targetDir);
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".ts"));

  if (sourceFiles.length === 0) {
    fail(`No generated ${label} files found to compile.`);
    return;
  }
  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  const ambientPath = path.join(sourceDir, "test-globals.validate.d.ts");
  const configPath = path.join(sourceDir, "tsconfig.validate.json");
  writeFileSync(ambientPath, [
    "declare function describe(name: string, fn: () => void): void;",
    "declare function it(name: string, fn: () => void): void;",
    "declare function expect(actual: unknown): {",
    "  toBeDefined(): void;",
    "  toBe(expected: unknown): void;",
    "  toEqual(expected: unknown): void;",
    "  toBeInstanceOf(expected: unknown): void;",
    "};",
    "",
  ].join("\n"));
  writeFileSync(configPath, JSON.stringify({
    compilerOptions: {
      noEmit: true,
      target: "ES2022",
      module: "commonjs",
      moduleResolution: "node",
      esModuleInterop: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: typeScriptTypeRoots(tscCli),
      lib: ["ES2022"],
    },
    files: [...sourceFiles, ambientPath],
  }, null, 2));

  try {
    execFileSync(
      process.execPath,
      [tscCli, "-p", configPath],
      { cwd: packageRoot, stdio: "pipe" },
    );
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated ${label} source and tests do not compile:\n${output || error.message}`);
  } finally {
    for (const tempPath of [configPath, ambientPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
  }
}

function runGeneratedTypeScriptCompile() {
  runGeneratedTypeScriptCompileFor("typescript", "TypeScript");
}

function runGeneratedTypeScriptZodCompile() {
  runGeneratedTypeScriptCompileFor("typescript-zod", "TypeScript Zod");
}

function runTypraVerify() {
  const cliPath = path.join(packageRoot, "dist", "src", "verify-cli.js");
  if (!existsSync(cliPath)) {
    fail("Unable to locate built typra-verify CLI for generated fixture validation.");
    return;
  }

  try {
    const output = execFileSync(
      process.execPath,
      [cliPath, "--baseline", generatedRoot, "--current", generatedRoot],
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
        fail(`typra-verify fixture output does not include expected summary: ${expected}`);
      }
    }

    const jsonOutput = execFileSync(
      process.execPath,
      [cliPath, "--baseline", generatedRoot, "--current", generatedRoot, "--json"],
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
      fail("typra-verify JSON fixture output does not describe a clean self-compare.");
    }
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`typra-verify failed against generated fixtures:\n${output || error.message}`);
  }
}

function runTypraConsumerSmoke() {
  const cliPath = path.join(packageRoot, "dist", "src", "consumer-smoke.js");
  if (!existsSync(cliPath)) {
    fail("Unable to locate built typra-consumer-smoke CLI for generated fixture validation.");
    return;
  }

  const configPath = path.join(generatedRoot, "typra-smoke.validate.json");
  writeFileSync(configPath, JSON.stringify({
    verify: {
      baseline: generatedRoot,
      current: generatedRoot,
    },
  }, null, 2));

  try {
    execFileSync(
      process.execPath,
      [cliPath, "--config", configPath],
      { cwd: packageRoot, stdio: "pipe" },
    );
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`typra-consumer-smoke failed against generated fixtures:\n${output || error.message}`);
  } finally {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  }
}

function commandExists(command) {
  try {
    if (process.platform === "win32") {
      execFileSync("where", [command], { stdio: "ignore" });
    } else {
      execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function resolveCommand(candidates) {
  return candidates.find(command => commandExists(command));
}

function requirePythonCommand(label) {
  const command = resolveCommand(["python3", "python"]);
  if (!command) {
    fail(`${label} cannot run because neither python nor python3 is available.`);
  }
  return command;
}

function runCommand(label, command, args, options = {}) {
  if (!commandExists(command)) {
    fail(`${label} cannot run because ${command} is not available.`);
    return;
  }
  try {
    execFileSync(command, args, { cwd: packageRoot, stdio: "pipe", ...options });
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`${label} failed:\n${output || error.message}`);
  }
}

function runGoFormatCheck(sourceDir) {
  if (!commandExists("gofmt")) {
    fail("Generated Go formatting validation cannot run because gofmt is not available.");
    return;
  }
  try {
    const output = execFileSync("gofmt", ["-l", "."], { cwd: sourceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (output) {
      fail(`Generated Go files are not gofmt-formatted:\n${output}`);
    }
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated Go formatting validation failed:\n${output || error.message}`);
  }
}

function runPythonCompile(target = "python") {
  const sourceDir = path.join(generatedRoot, target);
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".py"));
  if (sourceFiles.length === 0) {
    fail(`No generated ${target} files found to compile.`);
    return;
  }
  const python = requirePythonCommand(`Generated ${target} source syntax validation`);
  if (!python) return;
  runCommand(`Generated ${target} source syntax validation`, python, ["-m", "py_compile", ...sourceFiles]);
}

/**
 * Tests the gate knowingly tolerates, each tied to a filed defect.
 *
 * Asserted in BOTH directions, exactly like the C# list: an unlisted failure fails the gate,
 * and a listed test that starts passing also fails the gate, so fixing the underlying issue
 * forces the entry out instead of leaving a permanent mute behind.
 */
// Intentionally empty: every generated Python test passes.
const PYTHON_KNOWN_TEST_FAILURES = new Map();

/**
 * Runs the generated Python tests. Compiling them proved nothing about whether they pass —
 * Python was the last backend whose generated suite was never executed, which is how the
 * literal and factory defects fixed in #107 reached main unnoticed. See #96.
 */
function runPythonGeneratedTests(target = "python", packageName = "fixtures") {
  const sourceDir = path.join(generatedRoot, target);
  const testsDir = path.join(sourceDir, "tests");
  const testFiles = existsSync(testsDir) ? walkFiles(testsDir, file => file.endsWith(".py")) : [];
  if (testFiles.length === 0) {
    fail(`No generated ${target} tests found to run.`);
    return;
  }
  const python = requirePythonCommand(`Generated ${target} tests`);
  if (!python) return;

  // The generated tests import a configured package name, but validation target directories are
  // named for their mode. Stage a copy under the import name rather than a symlink: symlinks need
  // elevation on Windows.
  const stageRoot = mkdtempSync(path.join(tmpdir(), `typra-${target}-tests-`));
  const packageDir = path.join(stageRoot, packageName);
  try {
    cpSync(sourceDir, packageDir, {
      recursive: true,
      filter: source => !path.basename(source).startsWith("__pycache__")
        && path.basename(source) !== ".pytest_cache",
    });

    let output = "";
    let crashed = null;
    try {
      output = execFileSync(
        python,
        ["-m", "pytest", path.join(packageDir, "tests"), "-q", "-p", "no:cacheprovider"],
        {
          cwd: stageRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PYTHONPATH: stageRoot, PYTHONDONTWRITEBYTECODE: "1" },
        },
      );
    } catch (error) {
      output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`;
      crashed = error;
    }

    const failed = new Set();
    for (const match of output.matchAll(/^(?:FAILED|ERROR)\s+(\S+?)(?:\s|$)/gm)) {
      // pytest prints paths relative to whatever rootdir it infers, so anchor the key to the
      // tests directory instead. A list entry must not break because rootdir moved.
      failed.add(match[1].replace(/^.*?tests[\\/]/, ""));
    }
    // A collection error produces no per-test lines, so it must not read as "nothing failed".
    if (crashed && failed.size === 0) {
      fail(`Generated ${target} tests failed to collect or run:\n${output.trim() || crashed.message}`);
      return;
    }

    const unexpected = [...failed].filter(name => !PYTHON_KNOWN_TEST_FAILURES.has(name));
    if (unexpected.length > 0) {
      fail(`Generated ${target} tests failed:\n` + unexpected.map(name => `  ${name}`).join("\n"));
    }
    const fixed = [...PYTHON_KNOWN_TEST_FAILURES.keys()].filter(name => !failed.has(name));
    if (fixed.length > 0) {
      fail(
        "Generated Python tests listed as known failures now pass. Remove them from "
        + "PYTHON_KNOWN_TEST_FAILURES in scripts/validate-fixtures.mjs:\n"
        + fixed.map(name => `  ${name} (#${PYTHON_KNOWN_TEST_FAILURES.get(name)})`).join("\n"),
      );
    }
  } finally {
    if (existsSync(stageRoot)) {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

function runGoTests() {
  const sourceDir = path.join(generatedRoot, "go");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".go"));
  if (sourceFiles.length === 0) {
    fail("No generated Go files found to test.");
    return;
  }

  const modPath = path.join(sourceDir, "go.mod");
  const sumPath = path.join(sourceDir, "go.sum");
  writeFileSync(modPath, [
    "module fixtures",
    "",
    "go 1.22",
    "",
    "require gopkg.in/yaml.v3 v3.0.1",
    "",
  ].join("\n"));
  try {
    runGoFormatCheck(sourceDir);
    runCommand("Generated Go module dependency resolution", "go", ["mod", "tidy"], { cwd: sourceDir });
    runCommand("Generated Go vet", "go", ["vet", "./..."], { cwd: sourceDir });
    runCommand("Generated Go source and tests", "go", ["test", "./..."], { cwd: sourceDir });
  } finally {
    for (const tempPath of [modPath, sumPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
  }
}

function runRustTests() {
  const sourceDir = path.join(generatedRoot, "rust");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".rs"));
  if (sourceFiles.length === 0) {
    fail("No generated Rust files found to test.");
    return;
  }

  const cargoPath = path.join(sourceDir, "Cargo.toml");
  const lockPath = path.join(sourceDir, "Cargo.lock");
  const libPath = path.join(sourceDir, "lib.rs");
  const targetDir = mkdtempSync(path.join(tmpdir(), "typra-rust-"));
  writeFileSync(cargoPath, [
    "[package]",
    'name = "fixtures"',
    'version = "0.0.0"',
    'edition = "2021"',
    "",
    "[dependencies]",
    'async-trait = "0.1"',
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    'serde_yaml = "0.9"',
    "",
    "[lib]",
    'path = "lib.rs"',
    "",
  ].join("\n"));
  writeFileSync(libPath, '#[path = "mod.rs"] pub mod model;\n');
  try {
    runCommand("Generated Rust source and tests", "cargo", ["test", "--quiet"], {
      cwd: sourceDir,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
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

function runSwiftTests(context = {}) {
  const sourceDir = path.join(generatedRoot, "swift");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".swift"));
  if (sourceFiles.length === 0) {
    fail("No generated Swift files found to test.");
    return;
  }

  if (!commandExists("swift")) {
    if (process.env.CI_SWIFT_REQUIRED === "1") {
      fail("Generated Swift validation cannot run because swift is not available.");
    } else {
      console.warn("Warning: swift is not available. Skipping generated Swift compile/test validation.");
      context.skip?.(TOOLCHAIN_UNAVAILABLE);
    }
    return;
  }

  const buildDir = mkdtempSync(path.join(tmpdir(), "typra-swift-"));
  const inheritedPropertyTest = path.join(
    sourceDir,
    "Tests",
    "TypraFixturesTests",
    "InheritedPropertyRoundTripTests.swift",
  );
  const env = swiftToolchainEnv();
  writeFileSync(inheritedPropertyTest, `import XCTest
@testable import TypraFixtures

final class InheritedPropertyRoundTripTests: XCTestCase {
  private func roundTrip(_ json: String) throws -> [String: Any] {
    let loaded = try FixtureProperty.fromJSON(json)
    let reloaded = try FixtureProperty.load(loaded.save())
    return try reloaded.save()
  }

  private func assertMetadata(_ value: [String: Any], name: String) {
    XCTAssertEqual(value["name"] as? String, name)
    XCTAssertEqual(value["description"] as? String, "\\(name) description")
    XCTAssertEqual(value["required"] as? Bool, true)
    XCTAssertEqual(value["nullable"] as? Bool, false)
    XCTAssertEqual(value["default"] as? String, "fallback")
    XCTAssertEqual(value["example"] as? String, "example")
    XCTAssertEqual(value["enumValues"] as? [String], ["one", "two"])
  }

  func testArrayPropertyRetainsInheritedMetadata() throws {
    let value = try roundTrip("""
    {"kind":"array","name":"array","description":"array description","required":true,"nullable":false,"default":"fallback","example":"example","enumValues":["one","two"],"items":{"kind":"string"}}
    """)
    assertMetadata(value, name: "array")
    XCTAssertNotNil(value["items"])
  }

  func testObjectPropertyRetainsInheritedMetadata() throws {
    let value = try roundTrip("""
    {"kind":"object","name":"object","description":"object description","required":true,"nullable":false,"default":"fallback","example":"example","enumValues":["one","two"],"additionalProperties":{"kind":"string"}}
    """)
    assertMetadata(value, name: "object")
    XCTAssertNotNil(value["additionalProperties"])
  }

  func testUnionPropertyRetainsInheritedMetadata() throws {
    let value = try roundTrip("""
    {"kind":"union","name":"union","description":"union description","required":true,"nullable":false,"default":"fallback","example":"example","enumValues":["one","two"],"anyOf":[{"kind":"string"},{"kind":"boolean"}]}
    """)
    assertMetadata(value, name: "union")
    XCTAssertEqual((value["anyOf"] as? [[String: Any]])?.count, 2)
  }

  func testAllToolVariantsRetainInheritedMetadata() throws {
    let variants: [[String: Any]] = [
      ["kind": "function", "name": "function", "description": "function description", "command": "run"],
      ["kind": "prompt", "name": "prompt", "description": "prompt description", "prompt": "hello"],
      ["kind": "mcp", "name": "mcp", "description": "mcp description", "server": "local"],
      ["kind": "http", "name": "http", "description": "http description", "endpoint": "https://example.test"],
      ["kind": "custom", "name": "custom", "description": "custom description", "connection": ["kind": "future-auth", "name": "future"], "config": ["enabled": true]],
    ]
    for input in variants {
      let output = try FixtureTool.load(input).save()
      XCTAssertEqual(output["name"] as? String, input["name"] as? String)
      XCTAssertEqual(output["description"] as? String, input["description"] as? String)
    }

    let wildcardInput: [String: Any] = [
      "kind": "vendor",
      "name": "vendor",
      "description": "vendor description",
      "connection": ["kind": "future-auth", "name": "future"],
      "config": ["enabled": true],
    ]
    let wildcard = try FixtureTool.load(wildcardInput)
    guard case .fixtureCustomTool(let custom) = wildcard else {
      throw TypraRuntimeError.unsupported("Expected FixtureCustomTool wildcard")
    }
    XCTAssertEqual(custom.kind, "vendor")
    let wildcardOutput = try wildcard.save()
    XCTAssertEqual(wildcardOutput["kind"] as? String, "vendor")
    XCTAssertEqual(wildcardOutput["name"] as? String, "vendor")
    XCTAssertEqual((wildcardOutput["config"] as? [String: Any])?["enabled"] as? Bool, true)
    let wildcardReloaded = try FixtureTool.load(wildcardOutput)
    guard case .fixtureCustomTool(let reloadedCustom) = wildcardReloaded else {
      throw TypraRuntimeError.unsupported("Expected reloaded FixtureCustomTool wildcard")
    }
    XCTAssertEqual(reloadedCustom.kind, "vendor")
  }

  func testToolBindingsLoadAndRoundTripMapAndListForms() throws {
    func functionTool(_ input: [String: Any]) throws -> FixtureFunctionTool {
      let loaded = try FixtureTool.load(input)
      guard case .fixtureFunctionTool(let tool) = loaded else {
        throw TypraRuntimeError.unsupported("Expected FixtureFunctionTool")
      }
      return tool
    }

    let mapTool = try functionTool([
      "kind": "function",
      "name": "map-tool",
      "command": "run",
      "bindings": [
        "zeta": ["source": "result.text"],
        "alpha": ["source": "customer.name"],
      ],
    ])
    XCTAssertEqual(mapTool.bindings?.compactMap { $0.name }, ["alpha", "zeta"])
    let mapOutput = try mapTool.save()
    let mapBindings = mapOutput["bindings"] as? [String: Any]
    XCTAssertEqual(mapBindings?["alpha"] as? String, "customer.name")
    XCTAssertEqual(mapBindings?["zeta"] as? String, "result.text")
    let mapReloaded = try functionTool(mapOutput)
    XCTAssertEqual(mapReloaded.bindings?.compactMap { $0.name }, ["alpha", "zeta"])

    let listTool = try functionTool([
      "kind": "function",
      "name": "list-tool",
      "command": "run",
      "bindings": [
        ["name": "zeta", "source": "result.text"],
        ["name": "alpha", "source": "customer.name"],
      ],
    ])
    XCTAssertEqual(listTool.bindings?.compactMap { $0.name }, ["zeta", "alpha"])
    let listOutput = try listTool.save(SaveContext(collectionFormat: "array"))
    let listBindings = listOutput["bindings"] as? [[String: Any]]
    XCTAssertEqual(listBindings?.count, 2)
    XCTAssertEqual(listBindings?[0]["name"] as? String, "zeta")
    XCTAssertEqual(listBindings?[0]["source"] as? String, "result.text")
    let listReloaded = try functionTool(listOutput)
    XCTAssertEqual(listReloaded.bindings?.compactMap { $0.name }, ["zeta", "alpha"])

    let scalarTool = try functionTool([
      "kind": "function",
      "name": "scalar-tool",
      "command": "run",
      "bindings": [
        "zeta": "result.text",
        "alpha": "customer.name",
      ],
    ])
    XCTAssertEqual(scalarTool.bindings?.compactMap { $0.name }, ["alpha", "zeta"])
    XCTAssertEqual(scalarTool.bindings?.first { $0.name == "alpha" }?.source, "customer.name")
    let scalarOutput = try scalarTool.save()
    XCTAssertEqual((scalarOutput["bindings"] as? [String: Any])?["alpha"] as? String, "customer.name")
    let scalarReloaded = try functionTool(scalarOutput)
    XCTAssertEqual(scalarReloaded.bindings?.compactMap { $0.name }, ["alpha", "zeta"])
  }

  func testScalarPropertyCoercionDispatchesToTypedVariant() throws {
    let output = try FixtureProperty.load("hello").save()
    XCTAssertEqual(output["kind"] as? String, "string")
    XCTAssertEqual(output["default"] as? String, "hello")
  }

  func testClosedContentDiscriminatorIsExactAndStrict() throws {
    let known = try FixtureContent.load(["kind": "text", "value": "hello"]).save()
    XCTAssertEqual(known["kind"] as? String, "text")
    XCTAssertEqual(known["value"] as? String, "hello")

    for invalidKind in ["video", "Text"] {
      XCTAssertThrowsError(try FixtureContent.load(["kind": invalidKind, "value": "hello"])) { error in
        let message = String(describing: error)
        XCTAssertTrue(message.contains("kind"), message)
        XCTAssertTrue(message.contains(invalidKind), message)
      }
    }
  }

  func testUnknownConnectionDiscriminatorIsLossless() throws {
    let input: [String: Any] = [
      "kind": "future-auth",
      "name": "future",
      "config": ["nested": [1, NSNull(), ["enabled": true]]],
      "nullable": NSNull(),
    ]
    let output = try FixtureConnection.load(input).save()
    XCTAssertEqual(output["kind"] as? String, "future-auth")
    XCTAssertEqual(output["name"] as? String, "future")
    XCTAssertTrue(output["nullable"] is NSNull)
    let nested = (output["config"] as? [String: Any])?["nested"] as? [Any]
    XCTAssertEqual(nested?[0] as? Int, 1)
    XCTAssertTrue(nested?[1] is NSNull)
    XCTAssertEqual((nested?[2] as? [String: Any])?["enabled"] as? Bool, true)

    let reloaded = try FixtureConnection.load(output).save()
    XCTAssertEqual(reloaded["kind"] as? String, "future-auth")
    XCTAssertEqual(((reloaded["config"] as? [String: Any])?["nested"] as? [Any])?.count, 3)

    let caseCollision = try FixtureConnection.load([
      "kind": "Custom",
      "name": "case-sensitive-unknown",
      "payload": ["mode": "future"],
    ])
    guard case .unknown(let casePayload) = caseCollision else {
      throw TypraRuntimeError.unsupported("Expected wrong-case Connection to remain unknown")
    }
    XCTAssertEqual(casePayload["kind"] as? String, "Custom")
    XCTAssertEqual((casePayload["payload"] as? [String: Any])?["mode"] as? String, "future")

    let known = try FixtureConnection.load([
      "kind": "custom",
      "name": "known",
      "endpoint": "https://example.test",
    ])
    guard case .fixtureCustomConnection(let custom) = known else {
      throw TypraRuntimeError.unsupported("Expected exact Connection discriminator to dispatch")
    }
    XCTAssertEqual(custom.endpoint, "https://example.test")
  }

  func testInvalidConnectionDiscriminatorsAreRejected() throws {
    for input in [
      ["name": "missing-kind"],
      ["kind": "", "name": "blank-kind"],
      ["kind": NSNull(), "name": "null-kind"],
    ] as [[String: Any]] {
      XCTAssertThrowsError(try FixtureConnection.load(input).save()) { error in
        let message = String(describing: error)
        XCTAssertTrue(message.contains("kind"), message)
      }
    }
  }

  func testNamedCollectionsUseLosslessFallbackAndRejectNestedArrays() throws {
    let unique = try FixtureNamedPayloadCollection.load([
      "items": [
        ["name": "alpha", "payload": ["nested": [1, NSNull()]]],
        ["name": "beta", "payload": "second"],
      ],
    ])
    XCTAssertEqual((try unique.save()["items"] as? [String: Any])?.count, 2)
    XCTAssertNotNil(try unique.save(SaveContext(collectionFormat: "array"))["items"] as? [[String: Any]])

    let unnamed = try FixtureNamedPayloadCollection.load([
      "items": [
        ["payload": ["nested": [1, NSNull()]]],
        ["name": "", "payload": "second"],
      ],
    ])
    let unnamedItems = try unnamed.save()["items"] as? [[String: Any]]
    XCTAssertEqual(unnamedItems?.count, 2)
    XCTAssertEqual(unnamedItems?[1]["name"] as? String, "")

    let duplicate = try FixtureNamedPayloadCollection.load([
      "items": [
        ["name": "dup", "payload": 1],
        ["name": "dup", "payload": 2],
      ],
    ])
    XCTAssertEqual((try duplicate.save()["items"] as? [[String: Any]])?.count, 2)

    XCTAssertThrowsError(try FixtureNamedRoot.load([
      "inputs": ["profile": ["properties": ["arrayEntry": []]]],
    ])) { error in
      let message = String(describing: error)
      XCTAssertTrue(message.contains("inputs.profile.properties.arrayEntry"), message)
      XCTAssertTrue(message.contains("array"), message)
    }
  }

  func testEntryShorthandRoundTripsThroughNamedCollections() throws {
    let bag = try FixtureBag.load([
      "items": ["alpha": ["note": "first"]],
      "secondItems": ["beta": "second"],
    ])
    XCTAssertEqual(bag.items.count, 1, "named object collection must load into an ordered list")
    XCTAssertEqual(bag.items.first?.name, "alpha", "named object collection must adopt the key as name")
    XCTAssertEqual(bag.secondItems.first?.note, "second", "named scalar shorthand must load into the primary field")

    let objectBag = try bag.save()["items"] as? [String: Any]
    XCTAssertEqual(objectBag?["alpha"] as? String, "first", "default object save must use shorthand")

    let expandedBag = try bag.save(SaveContext(useShorthand: false))["items"] as? [String: Any]
    XCTAssertNotNil(expandedBag?["alpha"] as? [String: Any], "useShorthand=false must preserve the item object")
  }

  func testMissingRequiredCustomToolConnectionIsRejectedPathfully() throws {
    do {
      _ = try FixtureToolbox.fromJSON("""
      {"tools":{"custom":{"kind":"vendor"}},"inheritedMapBindingTool":{"kind":"function","name":"map","command":"run"},"inheritedListBindingTool":{"kind":"function","name":"list","command":"run"}}
      """)
      XCTFail("missing required CustomTool.connection was accepted")
    } catch {
      let diagnostic = String(describing: error)
      XCTAssertTrue(diagnostic.contains("tools.custom.connection"), diagnostic)
      XCTAssertTrue(diagnostic.contains("missing required field"), diagnostic)
    }
  }
}
`);
  try {
    runCommand(
      "Generated Swift package tests",
      "swift",
      ["test", "--package-path", sourceDir, "--scratch-path", buildDir],
      { cwd: sourceDir, env },
    );
  } finally {
    if (existsSync(inheritedPropertyTest)) {
      unlinkSync(inheritedPropertyTest);
    }
    if (existsSync(buildDir)) {
      rmSync(buildDir, { recursive: true, force: true });
    }
  }
}

function findSwiftWindowsSdk() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const platformsRoot = path.join(localAppData, "Programs", "Swift", "Platforms");
  if (!existsSync(platformsRoot)) return undefined;
  const versions = readdirSync(platformsRoot)
    .map(version => path.join(platformsRoot, version, "Windows.platform", "Developer", "SDKs", "Windows.sdk"))
    .filter(candidate => existsSync(candidate));
  return versions.sort((left, right) => right.localeCompare(left))[0];
}

function findWindowsGitExecPath() {
  const inherited = process.env.GIT_EXEC_PATH;
  if (inherited && existsSync(path.join(inherited, "git-remote-https.exe"))) {
    return inherited;
  }

  const candidates = [];
  try {
    const gitPaths = execFileSync("where", ["git"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    for (const gitPath of gitPaths) {
      const normalized = path.normalize(gitPath);
      const lower = normalized.toLowerCase();
      if (lower.endsWith(`${path.sep}cmd${path.sep}git.exe`)) {
        candidates.push(path.join(path.dirname(path.dirname(normalized)), "mingw64", "libexec", "git-core"));
      } else if (lower.endsWith(`${path.sep}mingw64${path.sep}bin${path.sep}git.exe`)) {
        candidates.push(path.join(path.dirname(path.dirname(normalized)), "libexec", "git-core"));
      }
    }
  } catch {
    // Fall through to common install locations.
  }

  candidates.push(
    "C:\\Program Files\\Git\\mingw64\\libexec\\git-core",
    "C:\\Program Files (x86)\\Git\\mingw64\\libexec\\git-core",
  );

  return candidates.find(candidate => existsSync(path.join(candidate, "git-remote-https.exe")));
}

function runCSharpBuild() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".cs") && !file.includes(`${path.sep}tests${path.sep}`));
  if (sourceFiles.length === 0) {
    fail("No generated C# files found to build.");
    return;
  }

  const projectPath = path.join(sourceDir, "TypraFixtureValidation.csproj");
  const stubsPath = path.join(sourceDir, "TypraFixtureValidation.Stubs.cs");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-"));
  const binDir = path.join(outputRoot, "bin");
  const objDir = path.join(outputRoot, "obj");
  writeFileSync(projectPath, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
    "    <Nullable>enable</Nullable>",
    "    <WarningsAsErrors>nullable</WarningsAsErrors>",
    "    <ImplicitUsings>enable</ImplicitUsings>",
    "  </PropertyGroup>",
    "  <ItemGroup>",
    '    <Compile Remove="tests/**/*.cs" />',
    '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n"));
  writeFileSync(stubsPath, buildCSharpValidationStubs(sourceDir));
  try {
    runCommand(
      "Generated C# source build",
      "dotnet",
      ["build", projectPath, "--nologo", "--verbosity", "quiet", "-p:BaseOutputPath=" + `${binDir}${path.sep}`, "-p:BaseIntermediateOutputPath=" + `${objDir}${path.sep}`],
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

function runCSharpConsumerNullabilityBuild() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const libraryProjectPath = path.join(sourceDir, "TypraFixtureConsumerLibrary.csproj");
  const stubsPath = path.join(sourceDir, "TypraFixtureConsumerLibrary.Stubs.cs");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-consumer-"));
  const libraryBinDir = path.join(outputRoot, "library-bin");
  const libraryObjDir = path.join(outputRoot, "library-obj");
  const consumerDir = path.join(outputRoot, "consumer");
  const consumerProjectPath = path.join(consumerDir, "TypraFixtureConsumer.csproj");
  const consumerProgramPath = path.join(consumerDir, "Program.cs");
  mkdirSync(consumerDir, { recursive: true });

  writeFileSync(libraryProjectPath, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
    "    <Nullable>enable</Nullable>",
    "    <WarningsAsErrors>nullable</WarningsAsErrors>",
    "    <ImplicitUsings>enable</ImplicitUsings>",
    "    <AssemblyName>TypraFixtureConsumerLibrary</AssemblyName>",
    "  </PropertyGroup>",
    "  <ItemGroup>",
    '    <Compile Remove="tests/**/*.cs" />',
    '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n"));
  writeFileSync(stubsPath, buildCSharpValidationStubs(sourceDir));

  try {
    runCommand(
      "Generated C# consumer library build",
      "dotnet",
      ["build", libraryProjectPath, "--nologo", "--verbosity", "quiet", "-p:BaseOutputPath=" + `${libraryBinDir}${path.sep}`, "-p:BaseIntermediateOutputPath=" + `${libraryObjDir}${path.sep}`],
      { cwd: sourceDir },
    );
    const libraryPath = path.join(libraryBinDir, "Debug", CSHARP_TARGET_FRAMEWORK, "TypraFixtureConsumerLibrary.dll");
    if (!existsSync(libraryPath)) {
      fail(`Generated C# consumer library was not found at ${libraryPath}.`);
      return;
    }
    writeFileSync(consumerProjectPath, [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      "    <OutputType>Exe</OutputType>",
      `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
      "    <Nullable>enable</Nullable>",
      "    <WarningsAsErrors>nullable</WarningsAsErrors>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "  </PropertyGroup>",
      "  <ItemGroup>",
      '    <Reference Include="TypraFixtureConsumerLibrary">',
      `      <HintPath>${libraryPath}</HintPath>`,
      "    </Reference>",
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"));
    writeFileSync(consumerProgramPath, [
      "using Typra.Fixtures;",
      "",
      "IDictionary<string, object?> nullableInterface = new Dictionary<string, object?> { [\"null\"] = null };",
      "Dictionary<string, object?> nullableConcrete = new() { [\"null\"] = null };",
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
    ].join("\n"));
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

/**
 * Tests the gate knowingly tolerates, each tied to a filed defect.
 *
 * This list is asserted in BOTH directions: an unlisted failure fails the gate, and a listed
 * test that starts passing also fails the gate. That second half is what stops the list from
 * rotting into a permanent mute — fixing the underlying issue forces the entry to be removed.
 */
// Intentionally empty: every generated C# test passes. An entry here mutes one test and must
// cite the issue that will remove it.
const CSHARP_KNOWN_TEST_FAILURES = new Map();

function runCSharpGeneratedTests() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const testsDir = path.join(sourceDir, "tests");
  const testFiles = existsSync(testsDir) ? walkFiles(testsDir, file => file.endsWith(".cs")) : [];
  if (testFiles.length === 0) {
    fail("No generated C# tests found to build.");
    return;
  }

  const projectPath = path.join(sourceDir, "TypraFixtureTestsValidation.csproj");
  const stubsPath = path.join(sourceDir, "TypraFixtureTestsValidation.Stubs.cs");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-tests-"));
  const binDir = path.join(outputRoot, "bin");
  const objDir = path.join(outputRoot, "obj");
  // Every generated test compiles and runs. Restricting this to a hand-picked file hid the
  // other backends' worth of coverage: 65 generated test files existed and 1 was built. See #94.
  writeFileSync(projectPath, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
    "    <Nullable>enable</Nullable>",
    "    <WarningsAsErrors>nullable</WarningsAsErrors>",
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
  ].join("\n"));
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
          "test", projectPath, "--nologo", "--verbosity", "normal",
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
    for (const match of output.matchAll(/^\s*(?:X\s+(\S+?)|Failed\s+([A-Za-z_][\w.]*))(?:\s|\[|$)/gm)) {
      const testName = match[1] ?? match[2];
      if (testName && testName !== "to") failed.add(testName);
    }
    // A build break produces no per-test lines at all, so it must not read as "nothing failed".
    if (crashed && failed.size === 0) {
      fail(`Generated C# tests failed to build or run:\n${output.trim() || crashed.message}`);
      return;
    }

    const unexpected = [...failed].filter(name => !CSHARP_KNOWN_TEST_FAILURES.has(name));
    if (unexpected.length > 0) {
      fail(
        "Generated C# tests failed:\n"
        + unexpected.map(name => `  ${name}`).join("\n"),
      );
    }
    const fixed = [...CSHARP_KNOWN_TEST_FAILURES.keys()].filter(name => !failed.has(name));
    if (fixed.length > 0) {
      fail(
        "Generated C# tests listed as known failures now pass. Remove them from "
        + "CSHARP_KNOWN_TEST_FAILURES in scripts/validate-fixtures.mjs:\n"
        + fixed.map(name => `  ${name} (#${CSHARP_KNOWN_TEST_FAILURES.get(name)})`).join("\n"),
      );
    }
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

function runCSharpProtocolScaffoldBuild() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const scaffoldPath = path.join(sourceDir, "tests", "ProtocolScaffolds.cs");
  if (!existsSync(scaffoldPath)) {
    fail("No generated C# protocol scaffold found to build.");
    return;
  }

  const projectPath = path.join(sourceDir, "TypraFixtureScaffoldValidation.csproj");
  const stubsPath = path.join(sourceDir, "TypraFixtureScaffoldValidation.Stubs.cs");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-scaffold-"));
  const binDir = path.join(outputRoot, "bin");
  const objDir = path.join(outputRoot, "obj");
  writeFileSync(projectPath, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
    "    <Nullable>enable</Nullable>",
    "    <WarningsAsErrors>nullable</WarningsAsErrors>",
    "    <ImplicitUsings>enable</ImplicitUsings>",
    "  </PropertyGroup>",
    "  <ItemGroup>",
    '    <Compile Remove="tests/**/*.cs" />',
    '    <Compile Include="tests/ProtocolScaffolds.cs" />',
    '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n"));
  writeFileSync(stubsPath, buildCSharpValidationStubs(sourceDir));
  try {
    runCommand(
      "Generated C# protocol scaffold build",
      "dotnet",
      ["build", projectPath, "--nologo", "--verbosity", "quiet", "-p:BaseOutputPath=" + `${binDir}${path.sep}`, "-p:BaseIntermediateOutputPath=" + `${objDir}${path.sep}`],
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

function runJavaBuild() {
  runJavaTargetBuild("java", "Generated Java source build");
}

function runJavaJacksonBuild() {
  const classpath = jacksonClasspath();
  if (!classpath) return;
  runJavaTargetBuild("java-jackson", "Generated Java Jackson source build", classpath);
}

function runJavaTargetBuild(targetDir, label, classpath = "") {
  const sourceDir = path.join(generatedRoot, targetDir);
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".java"));
  if (sourceFiles.length === 0) {
    fail(`No generated Java files found to build for ${targetDir}.`);
    return;
  }

  const classesDir = path.join(sourceDir, ".classes");
  rmSync(classesDir, { recursive: true, force: true });
  mkdirSync(classesDir, { recursive: true });
  try {
    runCommand(label, "javac", [...javaClasspathArgs(classpath), "-d", classesDir, ...sourceFiles], { cwd: sourceDir });
  } finally {
    rmSync(classesDir, { recursive: true, force: true });
  }
}

function runJavaGeneratedTests() {
  runJavaTargetGeneratedTests("java", "Generated Java tests", "typra.fixtures.TypraGeneratedTests");
}

function runJavaJacksonGeneratedTests() {
  const classpath = jacksonClasspath();
  if (!classpath) return;
  runJavaTargetGeneratedTests("java-jackson", "Generated Java Jackson tests", "typra.fixtures.TypraGeneratedTests", classpath);
}

function runJavaTargetGeneratedTests(targetDir, label, mainClass, classpath = "") {
  const sourceDir = path.join(generatedRoot, targetDir);
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".java"));
  const classesDir = path.join(sourceDir, ".classes");
  if (sourceFiles.length === 0) {
    fail(`No generated Java files found to test for ${targetDir}.`);
    return;
  }

  rmSync(classesDir, { recursive: true, force: true });
  mkdirSync(classesDir, { recursive: true });
  try {
    const initialFailureCount = failures.length;
    runCommand(`${label} build`, "javac", [...javaClasspathArgs(classpath), "-d", classesDir, ...sourceFiles], { cwd: sourceDir });
    if (failures.length > initialFailureCount) return;
    execFileSync("java", ["-cp", javaRuntimeClasspath(classesDir, classpath), mainClass], { cwd: sourceDir, stdio: "pipe" });
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`${label} failed:\n${output || error.message}`);
  } finally {
    rmSync(classesDir, { recursive: true, force: true });
  }
}

function javaClasspathArgs(classpath) {
  return classpath ? ["-cp", classpath] : [];
}

function javaRuntimeClasspath(classesDir, classpath) {
  return classpath ? `${classesDir}${path.delimiter}${classpath}` : classesDir;
}

function jacksonClasspath() {
  const jarDir = path.join(validationRoot, "jackson");
  mkdirSync(jarDir, { recursive: true });
  const jars = [];
  for (const artifact of JACKSON_ARTIFACTS) {
    const jarPath = path.join(jarDir, `${artifact}-${JACKSON_VERSION}.jar`);
    jars.push(jarPath);
    if (existsSync(jarPath)) continue;
    const initialFailureCount = failures.length;
    const url = `https://repo1.maven.org/maven2/com/fasterxml/jackson/core/${artifact}/${JACKSON_VERSION}/${artifact}-${JACKSON_VERSION}.jar`;
    runCommand(`Download ${artifact}`, "curl", ["-fsSL", url, "-o", jarPath]);
    if (failures.length > initialFailureCount) return null;
  }
  return jars.join(path.delimiter);
}

function buildCSharpValidationStubs(sourceDir) {
  const members = [];
  for (const file of walkFiles(sourceDir, file => file.endsWith(".cs") && !file.includes(`${path.sep}tests${path.sep}`))) {
    const content = readFileSync(file, "utf8");
    const interfaceMatch = content.match(/public\s+partial\s+interface\s+I(?<typeName>\w+)Helpers\s*\{(?<body>[\s\S]*?)\n\}/);
    if (!interfaceMatch?.groups) continue;

    const { typeName, body } = interfaceMatch.groups;
    const implementations = [];
    for (const line of body.split(/\r?\n/)) {
      const method = line.trim().match(/^(?<returnType>[\w?<>,. ]+)\s+(?<name>\w+)\((?<params>[^)]*)\);$/);
      if (method?.groups) {
        const { returnType, name, params } = method.groups;
        const bodyText = returnType.trim() === "void" ? " { }" : " => default!;";
        implementations.push(`    public ${returnType.trim()} ${name}(${params})${bodyText}`);
        continue;
      }
      const property = line.trim().match(/^(?<returnType>[\w?<>,. ]+)\s+(?<name>\w+)\s+\{\s+get;\s+\}$/);
      if (property?.groups) {
        implementations.push(`    public ${property.groups.returnType.trim()} ${property.groups.name} => default!;`);
      }
    }

    if (implementations.length > 0) {
      members.push(`public partial class ${typeName}\n{\n${implementations.join("\n")}\n}`);
    }
  }

  return [
    "namespace Typra.Fixtures;",
    "",
    ...members,
    "",
  ].join("\n");
}

function runTypeScriptExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "typescript");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".ts") && !file.includes(`${path.sep}.typra-conformance${path.sep}`) && !file.includes(`${path.sep}tests${path.sep}`));
  if (sourceFiles.length === 0) {
    fail("No generated TypeScript files found for executable conformance.");
    return;
  }
  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  const runnerPath = path.join(sourceDir, "conformance.validate.ts");
  const configPath = path.join(sourceDir, "tsconfig.conformance.json");
  const outDir = path.join(sourceDir, ".typra-conformance");
  writeFileSync(runnerPath, [
    'import { FixtureBag, FixtureConnection, FixtureContent, FixtureCustomTool, FixtureIndexedList, FixtureNamedPayloadCollection, FixtureNamedRoot, FixtureReference, FixtureRoot, FixtureTool, FixtureToolbox, SaveContext, WireOptions } from "./index";',
    "",
    `const root = FixtureRoot.load(JSON.parse(${fixtureRootSampleJsonLiteral}));`,
    `const imageContent = FixtureContent.load(${JSON.stringify(imageContentSample)});`,
    'const knownContent = FixtureContent.load({ kind: "text", value: "hello" }).save();',
    'if (knownContent.kind !== "text" || knownContent.value !== "hello") throw new Error("closed discriminator known value did not round-trip");',
    'for (const kind of ["video", "Text"]) {',
    "  try {",
    '    FixtureContent.load({ kind, value: "hello" });',
    '    throw new Error(`closed discriminator unexpectedly accepted ${kind}`);',
    "  } catch (error) {",
    "    const message = String(error);",
    '    if (!message.includes("kind") || !message.includes(kind)) throw error;',
    "  }",
    "}",
    'const unknownConnectionInput = { kind: "future-auth", name: "future", config: { nested: [1, null, { enabled: true }] }, nullable: null };',
    "const unknownConnection = FixtureConnection.load(unknownConnectionInput);",
    "unknownConnectionInput.config.nested[0] = 999;",
    'unknownConnection.kind = "future-auth-mutated";',
    "const unknownConnectionSaved = unknownConnection.save();",
    'if (unknownConnectionSaved.kind !== "future-auth-mutated" || unknownConnectionSaved.name !== "future" || !("nullable" in unknownConnectionSaved) || unknownConnectionSaved.nullable !== null) throw new Error("unknown connection modeled/null payload changed");',
    'if ((unknownConnectionSaved.config as { nested: unknown[] }).nested[0] !== 1) throw new Error("unknown connection raw payload aliased load input");',
    "(unknownConnectionSaved.config as { nested: unknown[] }).nested[0] = 777;",
    "const unknownConnectionSavedAgain = unknownConnection.save();",
    'if ((unknownConnectionSavedAgain.config as { nested: unknown[] }).nested[0] !== 1) throw new Error("unknown connection raw payload aliased save output");',
    "const unknownConnectionReloaded = FixtureConnection.load(JSON.parse(JSON.stringify(unknownConnectionSavedAgain))).save();",
    'if (JSON.stringify(unknownConnectionReloaded) !== JSON.stringify(unknownConnectionSavedAgain)) throw new Error("unknown connection payload did not survive load-save-reload");',
    'const caseCollisionInput = { kind: "Custom", name: "case-sensitive-unknown", payload: { mode: "future" } };',
    "const caseCollision = FixtureConnection.load(caseCollisionInput);",
    "const caseCollisionSaved = caseCollision.save();",
    'if (caseCollision.constructor !== FixtureConnection || caseCollisionSaved.kind !== "Custom" || caseCollisionSaved.name !== "case-sensitive-unknown" || (caseCollisionSaved.payload as { mode: string }).mode !== "future" || Object.keys(caseCollisionSaved).length !== 3) throw new Error("wrong-case connection discriminator did not remain unknown");',
    'const knownConnection = FixtureConnection.load({ kind: "custom", name: "known", endpoint: "https://example.test" });',
    'if (knownConnection.constructor === FixtureConnection || knownConnection.save().endpoint !== "https://example.test") throw new Error("known connection dispatch regressed");',
    'const wildcardTool = FixtureTool.load({ kind: "vendor", name: "vendor", description: "vendor description", connection: { kind: "future-auth", name: "future" }, config: { enabled: true } });',
    'if (!(wildcardTool instanceof FixtureCustomTool)) throw new Error("declared wildcard subtype did not own unknown tool kind");',
    "const wildcardToolSaved = wildcardTool.save();",
    'if (wildcardToolSaved.kind !== "vendor" || wildcardToolSaved.name !== "vendor" || (wildcardToolSaved.config as { enabled: boolean }).enabled !== true) throw new Error("wildcard tool payload changed");',
    'if (!(FixtureTool.load(wildcardToolSaved) instanceof FixtureCustomTool)) throw new Error("wildcard tool did not survive reload");',
    "try {",
    '  FixtureToolbox.load({ tools: { custom: { kind: "vendor" } }, inheritedMapBindingTool: { kind: "function", name: "map", command: "run" }, inheritedListBindingTool: { kind: "function", name: "list", command: "run" } } as any);',
    '  throw new Error("missing required CustomTool.connection was accepted");',
    "} catch (error) {",
    "  const diagnostic = String(error);",
    '  if (!diagnostic.includes("tools.custom.connection") || !diagnostic.includes("missing required field")) throw error;',
    "}",
    "try {",
    '  FixtureIndexedList.load({ entries: [{ label: "first", detail: { code: "ok" } }, { label: "second" }] } as any);',
    '  throw new Error("missing required field inside an array element was accepted");',
    "} catch (error) {",
    "  const diagnostic = String(error);",
    '  if (!diagnostic.includes("entries[1].detail")) throw new Error("array element diagnostic lost the element index: " + diagnostic);',
    "}",
    `const wire = WireOptions.load(${JSON.stringify(wireOptionsSample)});`,
    'const reference = FixtureReference.load("ref-coerced" as any);',
    'const uniqueNamed = FixtureNamedPayloadCollection.load({ items: [{ name: "alpha", payload: { nested: [1, null] } }, { name: "beta", payload: "second" }] });',
    'const uniqueSaved = uniqueNamed.save();',
    'if (Array.isArray(uniqueSaved.items) || Object.keys(uniqueSaved.items as object).join(",") !== "alpha,beta") throw new Error("unique named collection did not save as object");',
    'const lossyNamed = FixtureNamedPayloadCollection.load({ items: [{ payload: { nested: [1, null] } }, { name: "", payload: "second" }] });',
    'const lossySaved = lossyNamed.save();',
    'if (!Array.isArray(lossySaved.items) || lossySaved.items.length !== 2 || "name" in lossySaved.items[1]) throw new Error("unnamed collection did not preserve whole-array fallback");',
    'const duplicateSaved = FixtureNamedPayloadCollection.load({ items: [{ name: "dup", payload: 1 }, { name: "dup", payload: 2 }] }).save();',
    'if (!Array.isArray(duplicateSaved.items) || duplicateSaved.items.length !== 2) throw new Error("duplicate named collection lost entries");',
    'if (!Array.isArray(uniqueNamed.save(new SaveContext({ collectionFormat: "array" })).items)) throw new Error("explicit array format was ignored");',
    'try { FixtureNamedRoot.load({ inputs: { profile: { properties: { arrayEntry: [] } } } }); throw new Error("array-valued named entry was accepted"); } catch (error) { const message = String(error); if (!message.includes("inputs.profile.properties.arrayEntry") || !message.includes("array")) throw error; }',
    'const bag = FixtureBag.load({ items: { alpha: { note: "first" } }, secondItems: { beta: "second" } });',
    'if (bag.items.length !== 1 || bag.items[0].name !== "alpha") throw new Error("named object collection must load into an ordered list");',
    'if (bag.secondItems[0].note !== "second") throw new Error("named scalar shorthand must load into the primary field");',
    'const objectBag = bag.save();',
    'if ((objectBag.items as any).alpha !== "first") throw new Error("default object save must use shorthand");',
    'const expandedBag = bag.save(new SaveContext({ useShorthand: false }));',
    'if (typeof (expandedBag.items as any).alpha !== "object") throw new Error("useShorthand=false must preserve the item object");',
    "console.log(JSON.stringify({",
    "  root: root.save(),",
    "  imageContent: imageContent.save(),",
    '  openai: wire.toWire("openai"),',
    '  anthropic: wire.toWire("anthropic"),',
    '  unmapped: wire.toWire("unmapped-provider"),',
    '  emptyProvider: wire.toWire(""),',
    "  reference: reference.save(),",
    "}));",
    "",
  ].join("\n"));
  writeFileSync(configPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      moduleResolution: "node",
      esModuleInterop: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: typeScriptTypeRoots(tscCli),
      lib: ["ES2022"],
      outDir,
      rootDir: sourceDir,
    },
    files: [...sourceFiles, runnerPath],
  }, null, 2));

  try {
    execFileSync(process.execPath, [tscCli, "-p", configPath], { cwd: packageRoot, stdio: "pipe" });
    writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2));
    const output = execFileSync(process.execPath, [path.join(outDir, "conformance.validate.js")], { cwd: outDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    assertConformanceResult("typescript", output);
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated TypeScript executable conformance failed:\n${output || error.message}`);
  } finally {
    for (const tempPath of [runnerPath, configPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

function runTypeScriptZodExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "typescript-zod");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".ts") && !file.includes(`${path.sep}.typra-conformance${path.sep}`) && !file.includes(`${path.sep}tests${path.sep}`));
  if (sourceFiles.length === 0) {
    fail("No generated TypeScript Zod files found for executable conformance.");
    return;
  }
  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  const runnerPath = path.join(sourceDir, "conformance.validate.ts");
  const configPath = path.join(sourceDir, "tsconfig.conformance.json");
  const outDir = path.join(sourceDir, ".typra-conformance");
  writeFileSync(runnerPath, [
    'import { FixtureConnection, FixtureContent, FixtureRoot, FixtureToolbox, WireOptions } from "./index";',
    "",
    "function stable(value: unknown): string {",
    "  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(stable(item))));",
    "  if (value && typeof value === \"object\") {",
    "    const result: Record<string, unknown> = {};",
    "    for (const key of Object.keys(value as Record<string, unknown>).sort()) result[key] = (value as Record<string, unknown>)[key];",
    "    for (const key of Object.keys(result)) result[key] = JSON.parse(stable(result[key]));",
    "    return JSON.stringify(result);",
    "  }",
    "  return JSON.stringify(value);",
    "}",
    "function assertSame(label: string, actual: unknown, expected: unknown): void {",
    "  const actualJson = stable(actual);",
    "  const expectedJson = stable(expected);",
    "  if (actualJson !== expectedJson) throw new Error(`${label} diverged\\nactual=${actualJson}\\nexpected=${expectedJson}`);",
    "}",
    "function assertSchemaAgrees<T extends { save(): Record<string, unknown> }>(label: string, model: { load(data: Record<string, unknown>): T; schema: { parse(data: unknown): Record<string, unknown> } }, input: Record<string, unknown>): void {",
    "  const expected = model.load(input).save();",
    "  const actual = model.schema.parse(input);",
    "  assertSame(label, actual, expected);",
    "}",
    `assertSchemaAgrees("FixtureRoot", FixtureRoot, JSON.parse(${fixtureRootSampleJsonLiteral}));`,
    `assertSchemaAgrees("FixtureContent", FixtureContent, ${JSON.stringify(imageContentSample)});`,
    'assertSchemaAgrees("WireOptions", WireOptions, { maxOutputTokens: 256, temperature: 0.7 });',
    'assertSchemaAgrees("FixtureConnection open unknown", FixtureConnection, { kind: "future-auth", name: "future", config: { nested: [1, null, { enabled: true }] }, nullable: null });',
    'try { FixtureContent.schema.parse({ kind: "video", value: "hello" }); throw new Error("closed discriminator Zod schema accepted an unknown content kind"); } catch (error) { const message = String(error); if (!message.includes("video") && !message.includes("discriminator")) throw error; }',
    'try { FixtureToolbox.schema.parse({ tools: { custom: { kind: "vendor" } }, inheritedMapBindingTool: { kind: "function", name: "map", command: "run" }, inheritedListBindingTool: { kind: "function", name: "list", command: "run" } } as any); throw new Error("Zod schema accepted missing required CustomTool.connection"); } catch (error) { const message = String(error); if (!message.includes("tools.custom.connection") || !message.includes("missing required field")) throw error; }',
    "console.log(JSON.stringify({ ok: true }));",
    "",
  ].join("\n"));
  writeFileSync(configPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      moduleResolution: "node",
      esModuleInterop: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: typeScriptTypeRoots(tscCli),
      lib: ["ES2022"],
      outDir,
      rootDir: sourceDir,
    },
    files: [...sourceFiles, runnerPath],
  }, null, 2));

  try {
    execFileSync(process.execPath, [tscCli, "-p", configPath], { cwd: packageRoot, stdio: "pipe" });
    writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2));
    const output = execFileSync(process.execPath, [path.join(outDir, "conformance.validate.js")], { cwd: outDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const result = JSON.parse(output);
    if (result.ok !== true) {
      fail(`Generated TypeScript Zod executable conformance emitted an unexpected result: ${output}`);
    }
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated TypeScript Zod executable conformance failed:\n${output || error.message}`);
  } finally {
    for (const tempPath of [runnerPath, configPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

function runPythonExecutableConformance(target = "python", packageName = "python") {
  const sourceDir = path.join(generatedRoot, target);
  const runner = [
    "import json",
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(path.dirname(sourceDir))})`,
    `from ${packageName} import FixtureBag, FixtureCheckpoint, FixtureConnection, FixtureContent, FixtureCustomTool, FixtureIndexedList, FixtureNamedPayloadCollection, FixtureNamedRoot, FixtureReference, FixtureRoot, FixtureTool, FixtureToolbox, LoadContext, ModelInfo, SaveContext, WireOptions`,
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
    "assert type(known_connection) is not FixtureConnection and known_connection.save()[\"endpoint\"] == \"https://example.test\"",
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
    '    "imageContent": image_content.save(),',
    '    "openai": wire.to_wire("openai"),',
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
  const python = requirePythonCommand(`Generated ${target} executable conformance`);
  if (!python) return;

  try {
    const output = execFileSync(python, ["-c", runner], { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    assertConformanceResult(target, output);
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated ${target} executable conformance failed:\n${output || error.message}`);
  }
}

function runGoExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "go");
  const modPath = path.join(sourceDir, "go.mod");
  const sumPath = path.join(sourceDir, "go.sum");
  const cmdDir = path.join(sourceDir, "cmd", "conformance");
  const runnerPath = path.join(cmdDir, "main.go");
  if (!existsSync(sourceDir)) {
    fail("No generated Go directory found for executable conformance.");
    return;
  }

  writeFileSync(modPath, [
    "module fixtures",
    "",
    "go 1.22",
    "",
    "require gopkg.in/yaml.v3 v3.0.1",
    "",
  ].join("\n"));
  rmSync(cmdDir, { recursive: true, force: true });
  mkdirp(cmdDir);
  writeFileSync(runnerPath, [
    "package main",
    "",
    "import (",
    '\t"encoding/json"',
    '\t"fmt"',
    '\t"reflect"',
    '\t"sort"',
    '\t"strconv"',
    '\t"strings"',
    "",
    '\t"fixtures"',
    '\t"gopkg.in/yaml.v3"',
    ")",
    "",
    "func main() {",
    "\tloadCtx := fixtures.NewLoadContext()",
    "\tsaveCtx := fixtures.NewSaveContext()",
    "\tvar rootData interface{}",
    `\tif err := json.Unmarshal([]byte(${fixtureRootSampleJsonLiteral}), &rootData); err != nil {`,
    "\t\tpanic(err)",
    "\t}",
    "\troot, err := fixtures.LoadFixtureRoot(rootData, loadCtx)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    '\twire, err := fixtures.LoadWireOptions(map[string]interface{}{"maxOutputTokens": 256, "temperature": 0.7}, loadCtx)',
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    '\treference, err := fixtures.FixtureReferenceFromJSON("\\"ref-coerced\\"")',
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    '\treferenceFromYAML, err := fixtures.FixtureReferenceFromYAML("ref-coerced\\n")',
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    '\tif referenceFromYAML.Id != "ref-coerced" {',
    '\t\tpanic("FixtureReferenceFromYAML did not preserve scalar id")',
    "\t}",
    '\tconst multilineYAML = "value: \\"first line with trailing space\\\\ \\\\nsecond line\\\\n\\"\\n"',
    "\tmultilineMap := map[string]interface{}{}",
    "\tif err := yaml.Unmarshal([]byte(multilineYAML), &multilineMap); err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tmultiline, err := fixtures.LoadFixtureMultilineWhitespace(multilineMap, loadCtx)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    '\tconst expectedMultiline = "first line with trailing space \\nsecond line\\n"',
    "\tif multiline.Value != expectedMultiline {",
    '\t\tpanic("LoadFixtureMultilineWhitespace did not preserve trailing spaces")',
    "\t}",
    "\tmultilineFromYAML, err := fixtures.FixtureMultilineWhitespaceFromYAML(multilineYAML)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tif multilineFromYAML.Value != expectedMultiline {",
    '\t\tpanic("FixtureMultilineWhitespaceFromYAML did not preserve trailing spaces")',
    "\t}",
    '\tconst promptyValue = "system:\\nYou are helpful.\\n\\nKeep this space \\nPreserve ordinary lines.\\nKeep this too \\nuser:{{question}}"',
    '\tpromptyYAML := "value: " + strconv.Quote(promptyValue) + "\\n"',
    "\tpromptyMap := map[string]interface{}{}",
    "\tif err := yaml.Unmarshal([]byte(promptyYAML), &promptyMap); err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tprompty, err := fixtures.LoadFixturePromptyWhitespace(promptyMap, loadCtx)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tif prompty.Value != promptyValue {",
    '\t\tpanic("LoadFixturePromptyWhitespace did not preserve multiline content")',
    "\t}",
    "\tpromptyFromYAML, err := fixtures.FixturePromptyWhitespaceFromYAML(promptyYAML)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tif promptyFromYAML.Value != promptyValue {",
    '\t\tpanic("FixturePromptyWhitespaceFromYAML did not preserve multiline content")',
    "\t}",
    "\tomittedModelInfo, err := fixtures.LoadModelInfo(map[string]interface{}{}, loadCtx)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tomittedModelInfoSaved := omittedModelInfo.Save(saveCtx)",
    '\tif _, ok := omittedModelInfoSaved["inputModalities"]; ok {',
    '\t\tpanic("ModelInfo emitted absent optional inputModalities")',
    "\t}",
    '\tif _, ok := omittedModelInfoSaved["owners"]; ok {',
    '\t\tpanic("ModelInfo emitted absent optional owners")',
    "\t}",
    '\tif values, ok := omittedModelInfoSaved["outputModalities"].([]string); !ok || len(values) != 0 {',
    '\t\tpanic("ModelInfo did not materialize explicit outputModalities default")',
    "\t}",
    '\tif values, ok := omittedModelInfoSaved["defaultOwners"].([]interface{}); !ok || len(values) != 0 {',
    '\t\tpanic("ModelInfo did not materialize explicit defaultOwners default")',
    "\t}",
    '\texplicitModelInfo, err := fixtures.LoadModelInfo(map[string]interface{}{"inputModalities": []string{}}, loadCtx)',
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    '\tif values, ok := explicitModelInfo.Save(saveCtx)["inputModalities"].([]string); !ok || len(values) != 0 {',
    '\t\tpanic("ModelInfo did not preserve explicit empty inputModalities")',
    "\t}",
    '\timageContent, err := fixtures.LoadFixtureContent(map[string]interface{}{"kind": "image", "url": "https://example.com/fixture.png"}, loadCtx)',
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    '\tknownContent, err := fixtures.LoadFixtureContent(map[string]interface{}{"kind": "text", "value": "hello"}, loadCtx)',
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    '\tknownSaved := knownContent.(interface { Save(*fixtures.SaveContext) map[string]interface{} }).Save(saveCtx)',
    '\tif knownSaved["kind"] != "text" || knownSaved["value"] != "hello" {',
    '\t\tpanic("closed discriminator known value did not round-trip")',
    "\t}",
    '\tfor _, invalidKind := range []string{"video", "Text"} {',
    '\t\t_, invalidErr := fixtures.LoadFixtureContent(map[string]interface{}{"kind": invalidKind, "value": "hello"}, loadCtx)',
    '\t\tif invalidErr == nil || !strings.Contains(invalidErr.Error(), "kind") || !strings.Contains(invalidErr.Error(), invalidKind) {',
    '\t\t\tpanic("closed discriminator did not reject exact invalid value")',
    "\t\t}",
    "\t}",
    '\tunknownInput := map[string]interface{}{',
    '\t\t"kind": "future-auth",',
    '\t\t"name": "future",',
    '\t\t"config": map[string]interface{}{"nested": []interface{}{1.0, nil, map[string]interface{}{"enabled": true}}},',
    '\t\t"nullable": nil,',
    "\t}",
    "\tunknownConnection, err := fixtures.LoadFixtureConnection(unknownInput, loadCtx)",
    "\tif err != nil { panic(err) }",
    "\tunknownValue, ok := unknownConnection.(fixtures.FixtureConnection)",
    '\tif !ok { panic("unknown connection did not load as open base fallback") }',
    '\tunknownInput["config"].(map[string]interface{})["nested"].([]interface{})[0] = 999.0',
    '\tunknownValue.Kind = "future-auth-mutated"',
    "\tunknownSaved := unknownValue.Save(saveCtx)",
    '\tif unknownSaved["kind"] != "future-auth-mutated" || unknownSaved["name"] != "future" { panic("unknown connection modeled fields were not authoritative") }',
    '\tif _, ok := unknownSaved["nullable"]; !ok || unknownSaved["nullable"] != nil { panic("unknown connection explicit null was not preserved") }',
    '\tif unknownSaved["config"].(map[string]interface{})["nested"].([]interface{})[0] != 1.0 { panic("unknown connection raw payload aliased load input") }',
    '\tunknownSaved["config"].(map[string]interface{})["nested"].([]interface{})[0] = 777.0',
    "\tunknownSavedAgain := unknownValue.Save(saveCtx)",
    '\tif unknownSavedAgain["config"].(map[string]interface{})["nested"].([]interface{})[0] != 1.0 { panic("unknown connection raw payload aliased save output") }',
    '\tunknownJSON, err := json.Marshal(unknownSavedAgain)',
    "\tif err != nil { panic(err) }",
    "\tunknownReloaded, err := fixtures.FixtureConnectionFromJSON(string(unknownJSON))",
    "\tif err != nil { panic(err) }",
    "\tunknownReloadedValue, ok := unknownReloaded.(fixtures.FixtureConnection)",
    '\tif !ok || !reflect.DeepEqual(unknownReloadedValue.Save(saveCtx), unknownSavedAgain) { panic("unknown connection payload did not survive load-save-reload") }',
    '\tcaseCollisionInput := map[string]interface{}{"kind": "Custom", "name": "case-sensitive-unknown", "payload": map[string]interface{}{"mode": "future"}}',
    "\tcaseCollision, err := fixtures.LoadFixtureConnection(caseCollisionInput, loadCtx)",
    "\tif err != nil { panic(err) }",
    "\tcaseCollisionValue, ok := caseCollision.(fixtures.FixtureConnection)",
    '\tif !ok || !reflect.DeepEqual(caseCollisionValue.Save(saveCtx), caseCollisionInput) { panic("wrong-case connection discriminator was not preserved as unknown") }',
    '\twildcardToolInput := map[string]interface{}{"kind": "vendor", "name": "vendor", "description": "vendor description", "connection": map[string]interface{}{"kind": "future-auth", "name": "future"}, "config": map[string]interface{}{"enabled": true}}',
    "\twildcardTool, err := fixtures.LoadFixtureTool(wildcardToolInput, loadCtx)",
    "\tif err != nil { panic(err) }",
    "\twildcardToolValue, ok := wildcardTool.(fixtures.FixtureCustomTool)",
    '\tif !ok { panic("declared wildcard subtype did not own unknown tool kind") }',
    "\twildcardToolSaved := wildcardToolValue.Save(saveCtx)",
    '\tif wildcardToolSaved["kind"] != "vendor" || wildcardToolSaved["name"] != "vendor" { panic("wildcard tool payload changed") }',
    '\tif wildcardToolSaved["config"].(map[string]interface{})["enabled"] != true { panic("wildcard tool config payload changed") }',
    "\twildcardToolReloaded, err := fixtures.LoadFixtureTool(wildcardToolSaved, loadCtx)",
    "\tif err != nil { panic(err) }",
    '\tif _, ok := wildcardToolReloaded.(fixtures.FixtureCustomTool); !ok { panic("wildcard tool did not survive reload") }',
    '\tknownConnection, err := fixtures.LoadFixtureConnection(map[string]interface{}{"kind": "custom", "name": "known", "endpoint": "https://example.test"}, loadCtx)',
    "\tif err != nil { panic(err) }",
    '\tif _, ok := knownConnection.(fixtures.FixtureCustomConnection); !ok { panic("known connection dispatch regressed") }',
    // Issue #46 asks for round-trip coverage of all four named-collection wire shapes:
    // array form, name-keyed object form, duplicate names, and unnamed entries.
    "\tnamedBindings := map[string]interface{}{",
    '\t\t"inheritedMapBindingTool": map[string]interface{}{"kind": "function", "name": "map", "command": "run"},',
    '\t\t"inheritedListBindingTool": map[string]interface{}{"kind": "function", "name": "list", "command": "run"},',
    "\t}",
    "\tnewToolbox := func(tools interface{}) map[string]interface{} {",
    "\t\tinput := map[string]interface{}{}",
    "\t\tfor k, v := range namedBindings { input[k] = v }",
    '\t\tinput["tools"] = tools',
    "\t\treturn input",
    "\t}",
    // 1. Name-keyed object form: the key must be folded into the entry's `name`.
    '\tkeyedToolbox, err := fixtures.LoadFixtureToolbox(newToolbox(map[string]interface{}{',
    '\t\t"alpha": map[string]interface{}{"kind": "function", "command": "run-alpha"},',
    '\t\t"beta": map[string]interface{}{"kind": "function", "command": "run-beta"},',
    "\t}), loadCtx)",
    '\tif err != nil { panic("name-keyed named-collection form was rejected: " + err.Error()) }',
    '\tif len(keyedToolbox.Tools) != 2 { panic(fmt.Sprintf("name-keyed form dropped entries: got %d", len(keyedToolbox.Tools))) }',
    "\tkeyedNames := []string{}",
    "\tfor _, t := range keyedToolbox.Tools { keyedNames = append(keyedNames, t.(fixtures.FixtureFunctionTool).Name) }",
    "\tsort.Strings(keyedNames)",
    '\tif !reflect.DeepEqual(keyedNames, []string{"alpha", "beta"}) { panic(fmt.Sprintf("name-keyed form lost the key as name: %v", keyedNames)) }',
    // 2. Array form must load equivalently.
    '\tarrayToolbox, err := fixtures.LoadFixtureToolbox(newToolbox([]interface{}{',
    '\t\tmap[string]interface{}{"kind": "function", "name": "alpha", "command": "run-alpha"},',
    '\t\tmap[string]interface{}{"kind": "function", "name": "beta", "command": "run-beta"},',
    "\t}), loadCtx)",
    "\tif err != nil { panic(err) }",
    '\tif !reflect.DeepEqual(arrayToolbox.Save(saveCtx)["tools"], keyedToolbox.Save(saveCtx)["tools"]) { panic("array and name-keyed forms did not converge on save") }',
    // 3. Duplicate names must NOT collapse. A name-keyed object cannot represent them, so
    //    save has to fall back to the array form rather than silently dropping an entry.
    '\tdupToolbox, err := fixtures.LoadFixtureToolbox(newToolbox([]interface{}{',
    '\t\tmap[string]interface{}{"kind": "function", "name": "dup", "command": "first"},',
    '\t\tmap[string]interface{}{"kind": "function", "name": "dup", "command": "second"},',
    "\t}), loadCtx)",
    "\tif err != nil { panic(err) }",
    '\tdupSaved, ok := dupToolbox.Save(saveCtx)["tools"].([]interface{})',
    '\tif !ok { panic("duplicate-named entries were saved as an object, which cannot represent them") }',
    '\tif len(dupSaved) != 2 { panic(fmt.Sprintf("duplicate-named entries collapsed on save: got %d", len(dupSaved))) }',
    '\tif dupSaved[0].(map[string]interface{})["command"] != "first" || dupSaved[1].(map[string]interface{})["command"] != "second" { panic("duplicate-named entries lost their distinct payloads") }',
    // 4. Unnamed entries likewise force the array form.
    '\tunnamedToolbox, err := fixtures.LoadFixtureToolbox(newToolbox([]interface{}{',
    '\t\tmap[string]interface{}{"kind": "function", "command": "anonymous"},',
    "\t}), loadCtx)",
    "\tif err != nil { panic(err) }",
    '\tunnamedSaved, ok := unnamedToolbox.Save(saveCtx)["tools"].([]interface{})',
    '\tif !ok { panic("unnamed entry was saved as an object, which cannot represent it") }',
    '\tif len(unnamedSaved) != 1 || unnamedSaved[0].(map[string]interface{})["command"] != "anonymous" { panic("unnamed entry lost its payload") }',
    // Issue #54: an ABSTRACT base with an OPEN discriminator must absorb unknown kinds losslessly
    // rather than error. Abstractness is not closedness; only a closed union is exhaustive.
    '\tabstractOpenInput := map[string]interface{}{',
    '\t\t"kind": "vendor-managed",',
    '\t\t"label": "future",',
    '\t\t"settings": map[string]interface{}{"nested": []interface{}{1.0, nil, map[string]interface{}{"enabled": true}}},',
    "\t}",
    "\tabstractOpen, err := fixtures.LoadFixtureAbstractOpenConnection(abstractOpenInput, loadCtx)",
    '\tif err != nil { panic("abstract open base rejected an unknown discriminator: " + err.Error()) }',
    "\tabstractOpenValue, ok := abstractOpen.(fixtures.FixtureAbstractOpenConnection)",
    '\tif !ok { panic("unknown kind on abstract open base did not load as the base type") }',
    '\tif abstractOpenValue.Kind != "vendor-managed" { panic("abstract open base did not preserve the unknown discriminator value") }',
    "\tabstractOpenSaved := abstractOpenValue.Save(saveCtx)",
    '\tif !reflect.DeepEqual(abstractOpenSaved, abstractOpenInput) { panic("abstract open base did not round-trip the complete unknown payload") }',
    '\tabstractOpenInput["settings"].(map[string]interface{})["nested"].([]interface{})[0] = 999.0',
    '\tif abstractOpenValue.Save(saveCtx)["settings"].(map[string]interface{})["nested"].([]interface{})[0] != 1.0 { panic("abstract open base raw payload aliased load input") }',
    '\tabstractKnown, err := fixtures.LoadFixtureAbstractOpenConnection(map[string]interface{}{"kind": "managed", "label": "known", "resourceId": "res-1"}, loadCtx)',
    "\tif err != nil { panic(err) }",
    '\tif _, ok := abstractKnown.(fixtures.FixtureManagedConnection); !ok { panic("known subtype dispatch on abstract open base regressed") }',
    // Issue #37: a CLOSED discriminator union is not the same thing as an exhaustive
    // dispatch. A permitted value that no subtype claims must load as the base type.
    '\tunclaimed, err := fixtures.LoadFixtureUnclaimedBase(map[string]interface{}{"kind": "plain", "label": "leftover"}, loadCtx)',
    '\tif err != nil { panic("closed union rejected a permitted but unclaimed discriminator value: " + err.Error()) }',
    "\tunclaimedValue, ok := unclaimed.(fixtures.FixtureUnclaimedBase)",
    '\tif !ok { panic("unclaimed discriminator value did not load as the base type") }',
    '\tif unclaimedValue.Kind != "plain" || unclaimedValue.Label == nil || *unclaimedValue.Label != "leftover" { panic("unclaimed discriminator value lost its payload") }',
    '\tclaimed, err := fixtures.LoadFixtureUnclaimedBase(map[string]interface{}{"kind": "managed", "label": "known", "resourceId": "res-1"}, loadCtx)',
    "\tif err != nil { panic(err) }",
    '\tif _, ok := claimed.(fixtures.FixtureClaimedVariant); !ok { panic("claimed discriminator value stopped dispatching to its subtype") }',
    // Issue #47: a failure inside an array element must carry the element index.
    '\t_, arrayIndexErr := fixtures.LoadFixtureIndexedList(map[string]interface{}{"entries": []interface{}{',
    '\t\tmap[string]interface{}{"label": "first", "detail": map[string]interface{}{"code": "ok"}},',
    '\t\tmap[string]interface{}{"label": "second"},',
    "\t}}, loadCtx)",
    '\tif arrayIndexErr == nil { panic("missing required field inside an array element was not rejected") }',
    '\tif !strings.Contains(arrayIndexErr.Error(), "entries[1].detail") { panic("array element diagnostic lost the element index: " + arrayIndexErr.Error()) }',
    // Numeric coercions must match what a real decoder actually produces. encoding/json
    // yields float64 for EVERY JSON number -- never int, never float32 -- while yaml.v3
    // yields int for integers and float64 for floats. Feeding Go-native int32/float32
    // values in directly (as the generated tests do) exercises none of that, which is why
    // the decoder-native bridging cases could regress without any fixture drift.
    "\tfor _, numeric := range []struct {",
    "\t\tname     string",
    "\t\tencoded  string",
    "\t\tdecoder  string",
    "\t\twantType string",
    "\t}{",
    '\t\t{"json integer", "7", "json", "fixtures.FixtureIntegerProperty"},',
    '\t\t{"json fractional", "3.5", "json", "fixtures.FixtureNumberProperty"},',
    '\t\t{"json integral float", "7.0", "json", "fixtures.FixtureIntegerProperty"},',
    '\t\t{"yaml integer", "7", "yaml", "fixtures.FixtureIntegerProperty"},',
    '\t\t{"yaml fractional", "3.5", "yaml", "fixtures.FixtureNumberProperty"},',
    "\t} {",
    "\t\tvar decoded interface{}",
    '\t\tif numeric.decoder == "json" {',
    "\t\t\tif err := json.Unmarshal([]byte(numeric.encoded), &decoded); err != nil { panic(err) }",
    "\t\t} else {",
    "\t\t\tif err := yaml.Unmarshal([]byte(numeric.encoded), &decoded); err != nil { panic(err) }",
    "\t\t}",
    "\t\tcoerced, err := fixtures.LoadFixtureProperty(decoded, loadCtx)",
    '\t\tif err != nil { panic(numeric.name + ": decoder-native numeric coercion failed: " + err.Error()) }',
    '\t\tif got := fmt.Sprintf("%T", coerced); got != numeric.wantType {',
    '\t\t\tpanic(numeric.name + ": expected " + numeric.wantType + " but got " + got + " (a bare FixtureProperty means no coercion case matched the decoded type)")',
    "\t\t}",
    "\t}",
    '\t_, missingConnectionErr := fixtures.LoadFixtureToolbox(map[string]interface{}{"tools": map[string]interface{}{"custom": map[string]interface{}{"kind": "vendor"}}, "inheritedMapBindingTool": map[string]interface{}{"kind": "function", "name": "map", "command": "run"}, "inheritedListBindingTool": map[string]interface{}{"kind": "function", "name": "list", "command": "run"}}, loadCtx)',
    '\tif missingConnectionErr == nil || !strings.Contains(missingConnectionErr.Error(), "tools.custom.connection") || !strings.Contains(missingConnectionErr.Error(), "missing required field") { panic("missing required CustomTool.connection was not rejected pathfully") }',
    '\tunionProperty, err := fixtures.LoadFixtureProperty(map[string]interface{}{',
    '\t\t"kind": "union",',
    '\t\t"description": "combined scalar property",',
    '\t\t"anyOf": []interface{}{',
    '\t\t\tmap[string]interface{}{"kind": "string", "description": "text"},',
    '\t\t\tmap[string]interface{}{"kind": "boolean", "description": "flag"},',
    "\t\t},",
    "\t}, loadCtx)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tloadedUnion, ok := unionProperty.(fixtures.FixtureUnionProperty)",
    "\tif !ok {",
    '\t\tpanic("LoadFixtureProperty did not dispatch to FixtureUnionProperty")',
    "\t}",
    '\tif loadedUnion.Description == nil || *loadedUnion.Description != "combined scalar property" {',
    '\t\tpanic("FixtureUnionProperty did not load inherited description")',
    "\t}",
    "\tif len(loadedUnion.AnyOf) != 2 {",
    '\t\tpanic("FixtureUnionProperty did not load anyOf branches")',
    "\t}",
    "\tfor _, branch := range loadedUnion.AnyOf {",
    "\t\tsavable, ok := branch.(interface {",
    "\t\t\tSave(*fixtures.SaveContext) map[string]interface{}",
    "\t\t})",
    "\t\tif !ok {",
    '\t\t\tpanic("FixtureUnionProperty anyOf branch is not savable")',
    "\t\t}",
    "\t\tbase := savable.Save(saveCtx)",
    "\t\tif base[\"kind\"] == \"\" || base[\"description\"] == nil {",
    '\t\t\tpanic("FixtureUnionProperty anyOf scalar branch did not load base fields")',
    "\t\t}",
    "\t}",
    '\tuniqueNamed, err := fixtures.LoadFixtureNamedPayloadCollection(map[string]interface{}{"items": []interface{}{map[string]interface{}{"name": "alpha", "payload": map[string]interface{}{"nested": []interface{}{1, nil}}}, map[string]interface{}{"name": "beta", "payload": "second"}}}, loadCtx)',
    "\tif err != nil { panic(err) }",
    '\tif values, ok := uniqueNamed.Save(saveCtx)["items"].(map[string]interface{}); !ok || len(values) != 2 { panic("unique named collection did not save as object") }',
    '\tlossyNamed, err := fixtures.LoadFixtureNamedPayloadCollection(map[string]interface{}{"items": []interface{}{map[string]interface{}{"payload": map[string]interface{}{"nested": []interface{}{1, nil}}}, map[string]interface{}{"name": "", "payload": "second"}}}, loadCtx)',
    "\tif err != nil { panic(err) }",
    '\tif values, ok := lossyNamed.Save(saveCtx)["items"].([]interface{}); !ok || len(values) != 2 { panic("unnamed collection did not preserve whole-array fallback") }',
    '\tduplicateNamed, err := fixtures.LoadFixtureNamedPayloadCollection(map[string]interface{}{"items": []interface{}{map[string]interface{}{"name": "dup", "payload": 1}, map[string]interface{}{"name": "dup", "payload": 2}}}, loadCtx)',
    "\tif err != nil { panic(err) }",
    '\tif values, ok := duplicateNamed.Save(saveCtx)["items"].([]interface{}); !ok || len(values) != 2 { panic("duplicate named collection lost entries") }',
    '\tfunctionBindingInput := map[string]interface{}{"source": "preferred_unit"}',
    '\tfunctionToolFromMap, err := fixtures.LoadFixtureFunctionTool(map[string]interface{}{"kind": "function", "name": "convert", "command": "convert", "bindings": map[string]interface{}{"unit": functionBindingInput}}, loadCtx)',
    "\tif err != nil { panic(err) }",
    '\tif len(functionToolFromMap.Bindings) != 1 || functionToolFromMap.Bindings[0].Name == nil || *functionToolFromMap.Bindings[0].Name != "unit" || functionToolFromMap.Bindings[0].Source != "preferred_unit" { panic("direct derived loader lost named-map bindings") }',
    '\tif _, mutated := functionBindingInput["name"]; mutated { panic("named-map load mutated its input binding") }',
    '\tfor _, bindingKey := range []string{"unit", "unitMUT"} {',
    '\t\tbindingSource := "preferred_" + bindingKey',
    '\t\tfunctionTool, err := fixtures.LoadFixtureFunctionTool(map[string]interface{}{"kind": "function", "name": "convert", "command": "convert", "bindings": map[string]interface{}{bindingKey: bindingSource}}, loadCtx)',
    "\t\tif err != nil { panic(err) }",
    '\t\tif len(functionTool.Bindings) != 1 || functionTool.Bindings[0].Name == nil || *functionTool.Bindings[0].Name != bindingKey || functionTool.Bindings[0].Source != bindingSource { panic("direct derived loader lost named scalar bindings") }',
    '\t\tfunctionToolSaved := functionTool.Save(saveCtx)',
    '\t\tbindings, ok := functionToolSaved["bindings"].(map[string]interface{})',
    '\t\tif !ok || bindings[bindingKey] != bindingSource { panic("named scalar bindings did not save canonically") }',
    '\t\tfunctionToolReloaded, err := fixtures.LoadFixtureFunctionTool(functionToolSaved, loadCtx)',
    "\t\tif err != nil { panic(err) }",
    '\t\tif len(functionToolReloaded.Bindings) != 1 || functionToolReloaded.Bindings[0].Name == nil || *functionToolReloaded.Bindings[0].Name != bindingKey || functionToolReloaded.Bindings[0].Source != bindingSource { panic("direct derived named scalar bindings did not survive reload") }',
    "\t}",
    '\tarrayCtx := fixtures.NewSaveContext()',
    '\tarrayCtx.CollectionFormat = fixtures.CollectionFormatArray',
    '\tif _, ok := uniqueNamed.Save(arrayCtx)["items"].([]interface{}); !ok { panic("explicit array format was ignored") }',
    '\tbag, bagErr := fixtures.LoadFixtureBag(map[string]interface{}{"items": map[string]interface{}{"alpha": map[string]interface{}{"note": "first"}}, "secondItems": map[string]interface{}{"beta": "second"}}, loadCtx)',
    "\tif bagErr != nil { panic(bagErr) }",
    '\tif len(bag.Items) != 1 || bag.Items[0].Name != "alpha" { panic("named object collection must load into an ordered list") }',
    '\tif bag.SecondItems[0].Note == nil || *bag.SecondItems[0].Note != "second" { panic("named scalar shorthand must load into the primary field") }',
    '\tobjectBagItems, ok := bag.Save(saveCtx)["items"].(map[string]interface{})',
    '\tif !ok || objectBagItems["alpha"] != "first" { panic("default object save must use shorthand") }',
    "\texpandCtx := fixtures.NewSaveContext()",
    "\texpandCtx.UseShorthand = false",
    '\texpandedBagItems, ok := bag.Save(expandCtx)["items"].(map[string]interface{})',
    '\tif !ok { panic("useShorthand=false must keep the object collection form") }',
    '\tif _, ok := expandedBagItems["alpha"].(map[string]interface{}); !ok { panic("useShorthand=false must preserve the item object") }',
    '\t_, namedErr := fixtures.LoadFixtureNamedRoot(map[string]interface{}{"inputs": map[string]interface{}{"profile": map[string]interface{}{"properties": map[string]interface{}{"arrayEntry": []interface{}{}}}}}, loadCtx)',
    '\tif namedErr == nil || !strings.Contains(namedErr.Error(), "inputs.profile.properties.arrayEntry") || !strings.Contains(namedErr.Error(), "array") { panic("array-valued named entry was accepted") }',
    "\timageContentSaved := imageContent.(interface {",
    "\t\tSave(*fixtures.SaveContext) map[string]interface{}",
    "\t}).Save(saveCtx)",
    "\tencoded, err := json.Marshal(map[string]interface{}{",
    '\t\t"root": root.Save(saveCtx),',
    '\t\t"imageContent": imageContentSaved,',
    '\t\t"openai": wire.ToWire("openai"),',
    '\t\t"anthropic": wire.ToWire("anthropic"),',
    '\t\t"unmapped": wire.ToWire("unmapped-provider"),',
    '\t\t"emptyProvider": wire.ToWire(""),',
    '\t\t"reference": reference.Save(saveCtx),',
    "\t})",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tfmt.Println(string(encoded))",
    "}",
    "",
  ].join("\n"));

  try {
    const initialFailureCount = failures.length;
    runCommand("Generated Go conformance module dependency resolution", "go", ["mod", "tidy"], { cwd: sourceDir });
    if (failures.length > initialFailureCount) return;
    const output = execFileSync("go", ["run", "./cmd/conformance"], { cwd: sourceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    assertConformanceResult("go", output);
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated Go executable conformance failed:\n${output || error.message}`);
  } finally {
    for (const tempPath of [modPath, sumPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
    rmSync(path.join(sourceDir, "cmd"), { recursive: true, force: true });
  }
}

function runRustExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "rust");
  const cargoPath = path.join(sourceDir, "Cargo.toml");
  const lockPath = path.join(sourceDir, "Cargo.lock");
  const libPath = path.join(sourceDir, "lib.rs");
  const runnerPath = path.join(sourceDir, "conformance_validate.rs");
  const targetDir = mkdtempSync(path.join(tmpdir(), "typra-rust-conformance-"));
  if (!existsSync(sourceDir)) {
    fail("No generated Rust directory found for executable conformance.");
    return;
  }

  writeFileSync(cargoPath, [
    "[package]",
    'name = "fixtures"',
    'version = "0.0.0"',
    'edition = "2021"',
    "",
    "[dependencies]",
    'async-trait = "0.1"',
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    'serde_yaml = "0.9"',
    "",
    "[lib]",
    'path = "lib.rs"',
    "",
    "[[bin]]",
    'name = "conformance_validate"',
    'path = "conformance_validate.rs"',
    "",
  ].join("\n"));
  writeFileSync(libPath, '#[path = "mod.rs"] pub mod model;\n');
  writeFileSync(runnerPath, [
    "use fixtures::model::*;",
    "use serde_json::json;",
    "",
    "fn main() {",
    "    let load_ctx = LoadContext::new();",
    "    let save_ctx = SaveContext::new();",
    `    let root_value: serde_json::Value = serde_json::from_str(${fixtureRootSampleJsonLiteral}).unwrap();`,
    "    let root = FixtureRoot::load_from_value(&root_value, &load_ctx);",
    '    let image_content = FixtureContent::load_from_value(&json!({"kind": "image", "url": "https://example.com/fixture.png"}), &load_ctx);',
    '    let known_content = FixtureContent::from_json(r#"{"kind":"text","value":"hello"}"#, &load_ctx).expect("known closed discriminator");',
    '    assert_eq!(known_content.to_value(&save_ctx), json!({"kind": "text", "value": "hello"}));',
    '    for invalid_kind in ["video", "Text"] {',
    '        let input = format!(r#"{{"kind":"{}","value":"hello"}}"#, invalid_kind);',
    '        let error = FixtureContent::from_json(&input, &load_ctx).expect_err("invalid closed discriminator");',
    '        let message = error.to_string();',
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
    "    let mut unknown_connection = FixtureConnection::load_from_value(&unknown_connection_input, &load_ctx);",
    '    assert_eq!(unknown_connection.kind_str(), "future-auth");',
    '    assert!(matches!(&unknown_connection.kind, FixtureConnectionKind::Custom { raw, .. } if raw.get("endpoint") == Some(&json!("https://future.test")) && raw.get("providerOptions") == unknown_connection_input.get("providerOptions")));',
    "    assert_eq!(unknown_connection.to_value(&save_ctx), unknown_connection_input);",
    "    let reloaded_unknown_connection = FixtureConnection::load_from_value(&unknown_connection.to_value(&save_ctx), &load_ctx);",
    "    assert_eq!(reloaded_unknown_connection.to_value(&save_ctx), unknown_connection_input);",
    '    unknown_connection.name = Some("updated".to_string());',
    "    let mut updated_unknown_connection = unknown_connection_input.clone();",
    '    updated_unknown_connection["name"] = json!("updated");',
    "    assert_eq!(unknown_connection.to_value(&save_ctx), updated_unknown_connection);",
    '    let known_connection_input = json!({"kind": "custom", "name": "known", "endpoint": "https://known.test"});',
    "    let known_connection = FixtureConnection::load_from_value(&known_connection_input, &load_ctx);",
    "    assert!(matches!(known_connection.kind, FixtureConnectionKind::FixtureCustomConnection { .. }));",
    "    assert_eq!(known_connection.to_value(&save_ctx), known_connection_input);",
    // A named open-enum discriminator must round-trip an unrecognized kind losslessly.
    // (This is adjacent to issue #38 but does not reproduce it — see the fixture doc.)
    '    let named_open_input = json!({"kind": "vendor-specific", "label": "future", "extra": {"nested": [1, null]}});',
    "    let named_open = FixtureNamedOpenBase::load_from_value(&named_open_input, &load_ctx);",
    '    assert_eq!(named_open.kind_str(), "vendor-specific");',
    "    assert_eq!(named_open.to_value(&save_ctx), named_open_input);",
    '    let named_open_known = FixtureNamedOpenBase::load_from_value(&json!({"kind": "managed", "label": "known", "resourceId": "res-1"}), &load_ctx);',
    "    assert!(matches!(named_open_known.kind, FixtureNamedOpenBaseKind::FixtureNamedOpenVariant { .. }));",
    '    let missing_connection_error = FixtureToolbox::from_json(r#"{"tools":{"custom":{"kind":"vendor"}},"inheritedMapBindingTool":{"kind":"function","name":"map","command":"run"},"inheritedListBindingTool":{"kind":"function","name":"list","command":"run"}}"#, &load_ctx).expect_err("missing required CustomTool.connection");',
    "    let missing_connection_diagnostic = missing_connection_error.to_string();",
    '    assert!(missing_connection_diagnostic.contains("tools.custom.connection") && missing_connection_diagnostic.contains("missing required field"), "{missing_connection_diagnostic}");',
    '    let function_tool_input = json!({"kind": "function", "name": "search", "command": "run", "parameters": [{"name": "query", "kind": "string", "required": true}]});',
    "    let function_tool = FixtureTool::load_from_value(&function_tool_input, &load_ctx);",
    "    let function_tool_saved = function_tool.to_value(&save_ctx);",
    '    assert_eq!(function_tool_saved["parameters"]["query"]["kind"], json!("string"));',
    '    assert_eq!(function_tool_saved["parameters"]["query"]["required"], json!(true));',
    "    let function_tool_reloaded = FixtureTool::load_from_value(&function_tool_saved, &load_ctx);",
    "    assert_eq!(function_tool_reloaded.to_value(&save_ctx), function_tool_saved);",
    '    let unnamed_function_tool = FixtureTool::load_from_value(&json!({"kind": "function", "name": "unnamed", "command": "run", "parameters": [{"kind": "string"}]}), &load_ctx);',
    '    assert_eq!(unnamed_function_tool.to_value(&save_ctx)["parameters"], json!([{"kind": "string"}]));',
    '    let duplicate_function_tool = FixtureTool::load_from_value(&json!({"kind": "function", "name": "duplicate", "command": "run", "parameters": [{"name": "query", "kind": "string"}, {"name": "query", "kind": "number"}]}), &load_ctx);',
    '    assert_eq!(duplicate_function_tool.to_value(&save_ctx)["parameters"], json!([{"name": "query", "kind": "string"}, {"name": "query", "kind": "number"}]));',
    '    let wildcard_tool_input = json!({"kind": "vendor", "name": "vendor", "description": "vendor description", "connection": {"kind": "future-auth", "name": "future"}, "config": {"enabled": true}});',
    "    let wildcard_tool = FixtureTool::load_from_value(&wildcard_tool_input, &load_ctx);",
    '    assert!(matches!(&wildcard_tool.kind, FixtureToolKind::FixtureCustomTool { .. }), "declared wildcard subtype did not own unknown tool kind");',
    "    assert_eq!(wildcard_tool.to_value(&save_ctx), wildcard_tool_input);",
    "    let wildcard_tool_reloaded = FixtureTool::load_from_value(&wildcard_tool.to_value(&save_ctx), &load_ctx);",
    '    assert!(matches!(&wildcard_tool_reloaded.kind, FixtureToolKind::FixtureCustomTool { .. }), "wildcard tool did not survive reload");',
    '    let wire = WireOptions::load_from_value(&json!({"maxOutputTokens": 256, "temperature": 0.7}), &load_ctx);',
    '    let reference = FixtureReference::load_from_value(&json!("ref-coerced"), &load_ctx);',
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
    '    let mut array_ctx = SaveContext::new();',
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
    '    let message = error.to_string();',
    '    assert!(message.contains("inputs.profile.properties.arrayEntry") && message.contains("array"), "{message}");',
    "    // Issue #47: a failure inside an array element must carry the element index, so a",
    "    // diagnostic cannot silently degrade to naming only the field.",
    '    let indexed_error = FixtureIndexedList::from_json(r#"{"entries":[{"label":"first","detail":{"code":"ok"}},{"label":"second"}]}"#, &load_ctx).expect_err("missing required field inside an array element");',
    "    let indexed_message = indexed_error.to_string();",
    '    assert!(indexed_message.contains("entries[1].detail"), "array element diagnostic lost the element index: {indexed_message}");',
    "    println!(\"{}\", json!({",
    '        "root": root.to_value(&save_ctx),',
    '        "imageContent": image_content.to_value(&save_ctx),',
    '        "openai": wire.to_wire("openai"),',
    '        "anthropic": wire.to_wire("anthropic"),',
    '        "unmapped": wire.to_wire("unmapped-provider"),',
    '        "emptyProvider": wire.to_wire(""),',
    '        "reference": reference.to_value(&save_ctx)',
    "    }));",
    "}",
    "",
  ].join("\n"));

  try {
    const output = execFileSync("cargo", ["run", "--quiet", "--bin", "conformance_validate"], {
      cwd: sourceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
    }).trim();
    assertConformanceResult("rust", output);
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated Rust executable conformance failed:\n${output || error.message}`);
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

function runRustUnknownAbstractConformance() {
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
        "--output", outputRoot,
        "--targets", "rust",
        "--spec", path.join(packageRoot, "fixtures", "rust-unknown", "main.tsp"),
        "--root-object", "Typra.Fixtures.RustUnknown.Root",
        "--no-tests",
        "--no-format",
        "--deterministic",
      ],
      { cwd: packageRoot, stdio: "pipe" },
    );
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Rust abstract unknown fixture generation failed:\n${output || error.message}`);
  }
  if (failures.length > initialFailureCount) return;

  const connectionPath = path.join(sourceDir, "connection.rs");
  const connectionSource = existsSync(connectionPath) ? readFileSync(connectionPath, "utf8") : "";
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
      fail(`Generated Rust abstract unknown fixture does not include expected content: ${expected}`);
    }
  }
  if (failures.length > initialFailureCount) return;

  const targetDir = mkdtempSync(path.join(tmpdir(), "typra-rust-unknown-"));
  writeFileSync(cargoPath, [
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
  ].join("\n"));
  writeFileSync(libPath, '#[path = "mod.rs"] pub mod model;\n');
  writeFileSync(runnerPath, [
    "use rust_unknown::model::*;",
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
  ].join("\n"));

  try {
    execFileSync("cargo", ["run", "--quiet", "--bin", "unknown_validate"], {
      cwd: sourceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
    });
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated Rust abstract unknown conformance failed:\n${output || error.message}`);
  } finally {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
  }
}

function runCSharpExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const projectPath = path.join(sourceDir, "TypraFixtureConformance.csproj");
  const stubsPath = path.join(sourceDir, "TypraFixtureConformance.Stubs.cs");
  const programPath = path.join(sourceDir, "TypraFixtureConformance.Program.cs");
  const binDir = path.join(sourceDir, "bin");
  const objDir = path.join(sourceDir, "obj");
  if (!existsSync(sourceDir)) {
    fail("No generated C# directory found for executable conformance.");
    return;
  }

  writeFileSync(projectPath, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    "    <OutputType>Exe</OutputType>",
    `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
    "    <Nullable>enable</Nullable>",
    "    <WarningsAsErrors>nullable</WarningsAsErrors>",
    "    <ImplicitUsings>enable</ImplicitUsings>",
    "  </PropertyGroup>",
    "  <ItemGroup>",
    '    <Compile Remove="tests/**/*.cs" />',
    '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n"));
  writeFileSync(stubsPath, buildCSharpValidationStubs(sourceDir));
  writeFileSync(programPath, [
    "using System.Text.Json;",
    "using Typra.Fixtures;",
    "",
    `var root = FixtureRoot.FromJson(${fixtureRootSampleJsonLiteral});`,
    'if (root.Metadata is null) throw new InvalidOperationException("Record<unknown> metadata must load from the canonical conformance payload");',
    `var nullMetadataRoot = FixtureRoot.FromJson(${fixtureRootNullMetadataJsonLiteral});`,
    "var nullMetadata = nullMetadataRoot.Metadata;",
    'if (nullMetadata is null || !nullMetadata.ContainsKey("nullable") || nullMetadata["nullable"] is not null) throw new InvalidOperationException("Record<unknown> must preserve explicit null values during load");',
    "var savedNullMetadata = nullMetadataRoot.Save();",
    'if (savedNullMetadata["metadata"] is not IDictionary<string, object?> savedMetadata || !savedMetadata.ContainsKey("nullable") || savedMetadata["nullable"] is not null) throw new InvalidOperationException("Record<unknown> must preserve explicit null values during save");',
    "var reloadedRoot = FixtureRoot.Load(savedNullMetadata);",
    'if (reloadedRoot.Metadata is null || !reloadedRoot.Metadata.ContainsKey("nullable") || reloadedRoot.Metadata["nullable"] is not null) throw new InvalidOperationException("Record<unknown> must preserve explicit null values after reload");',
    "IDictionary<string, object?> nullableValues = new Dictionary<string, object?> { [\"value\"] = \"nullable\", [\"null\"] = null };",
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
    '    ["imageContent"] = imageContent.Save(),',
    '    ["openai"] = wire.ToWire("openai"),',
    '    ["anthropic"] = wire.ToWire("anthropic"),',
    '    ["unmapped"] = wire.ToWire("unmapped-provider"),',
    '    ["emptyProvider"] = wire.ToWire(""),',
    '    ["reference"] = reference.Save(),',
    "}));",
    "",
  ].join("\n"));

  try {
    const output = execFileSync("dotnet", ["run", "--project", projectPath, "--verbosity", "quiet"], { cwd: sourceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    assertConformanceResult("csharp", output);
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated C# executable conformance failed:\n${output || error.message}`);
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

function runJavaExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "java");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".java"));
  const runnerPath = path.join(sourceDir, "ConformanceValidate.java");
  const classesDir = path.join(sourceDir, ".classes");
  if (sourceFiles.length === 0) {
    fail("No generated Java files found for executable conformance.");
    return;
  }

  writeFileSync(runnerPath, [
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
    "    Map<String, Object> expandedBag = bag.save(new SaveContext(null, null, \"object\", false));",
    '    require(((Map<?, ?>) expandedBag.get("items")).get("alpha") instanceof Map<?, ?>, "useShorthand=false must preserve the item object");',
    "    Map<String, Object> arrayBag = bag.save(new SaveContext(null, null, \"array\", true));",
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
    "    beta.name = \"\";",
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
    "    String controlSample = \"a\" + ((char) 1) + \"b\";",
    "    String encodedControl = TypraJson.stringify(controlSample);",
    "    require(encodedControl.indexOf((char) 1) < 0, \"control characters must not be copied verbatim into JSON output\");",
    "    require(controlSample.equals(TypraJson.parse(encodedControl)), \"control characters must round-trip through JSON\");",
    "",
    "    Map<String, Object> output = new LinkedHashMap<>();",
    '    output.put("root", reloadedRoot.save(new SaveContext()));',
    '    output.put("imageContent", reloadedImageContent.save(new SaveContext()));',
    '    output.put("openai", wire.toWire("openai"));',
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
  ].join("\n"));

  rmSync(classesDir, { recursive: true, force: true });
  mkdirSync(classesDir, { recursive: true });
  try {
    const initialFailureCount = failures.length;
    runCommand("Generated Java executable conformance build", "javac", ["-d", classesDir, ...sourceFiles, runnerPath], { cwd: sourceDir });
    if (failures.length > initialFailureCount) return;
    const output = execFileSync("java", ["-cp", classesDir, "typra.fixtures.ConformanceValidate"], { cwd: sourceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    assertConformanceResult("java", output);
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated Java executable conformance failed:\n${output || error.message}`);
  } finally {
    if (existsSync(runnerPath)) {
      unlinkSync(runnerPath);
    }
    rmSync(classesDir, { recursive: true, force: true });
  }
}

function appendGitConfig(env, key, value) {
  const index = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const nextIndex = Number.isFinite(index) && index >= 0 ? index : 0;
  env.GIT_CONFIG_COUNT = String(nextIndex + 1);
  env[`GIT_CONFIG_KEY_${nextIndex}`] = key;
  env[`GIT_CONFIG_VALUE_${nextIndex}`] = value;
}

function swiftToolchainEnv() {
  const env = { ...process.env };
  if (process.platform === "win32" && !env.SDKROOT) {
    const sdkRoot = findSwiftWindowsSdk();
    if (sdkRoot) {
      env.SDKROOT = sdkRoot;
    }
  }
  if (process.platform === "win32") {
    const gitExecPath = findWindowsGitExecPath();
    if (gitExecPath) {
      env.GIT_EXEC_PATH = gitExecPath;
    }
  }
  appendGitConfig(env, "safe.bareRepository", "all");
  return env;
}

/**
 * Swift was the only conformance-matrix target with no executable conformance run: its sources
 * compiled and its generated package tests ran, but nothing ever checked that the Swift backend
 * produces the same canonical output as the other six. Conformance evidence was asserted for a
 * backend whose behaviour was never compared.
 *
 * The canonical payload is emitted from inside an XCTest rather than a separate executable target
 * so that the generated `Package.swift` is not rewritten, reusing the same toolchain plumbing as
 * `runSwiftTests`. `swift test` interleaves its own progress output, so the payload is tagged with
 * a sentinel and extracted rather than read off the last line.
 */
function runSwiftExecutableConformance(context = {}) {
  const sourceDir = path.join(generatedRoot, "swift");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".swift"));
  if (sourceFiles.length === 0) {
    fail("No generated Swift files found for executable conformance.");
    return;
  }

  if (!commandExists("swift")) {
    if (process.env.CI_SWIFT_REQUIRED === "1") {
      fail("Generated Swift executable conformance cannot run because swift is not available.");
    } else {
      console.warn("Warning: swift is not available. Skipping generated Swift executable conformance.");
      context.skip?.(TOOLCHAIN_UNAVAILABLE);
    }
    return;
  }

  const runnerPath = path.join(sourceDir, "Tests", "TypraFixturesTests", "ConformanceValidateTests.swift");
  const buildDir = mkdtempSync(path.join(tmpdir(), "typra-swift-conformance-"));

  writeFileSync(runnerPath, `import XCTest
import Foundation
@testable import TypraFixtures

final class ConformanceValidateTests: XCTestCase {
  func testEmitsCanonicalConformancePayload() throws {
    let rootData = try JSONSerialization.jsonObject(with: Data(${fixtureRootSampleJsonLiteral}.utf8)) as! [String: Any]
    let root = try FixtureRoot.load(rootData)
    let imageContent = try FixtureContent.load(["kind": "image", "url": "https://example.com/fixture.png"])
    let wire = try WireOptions.load(["maxOutputTokens": 256, "temperature": 0.7])
    let reference = try FixtureReference.fromYAML("\\"ref-coerced\\"")

    let payload: [String: Any] = [
      "root": try root.save(),
      "imageContent": try imageContent.save(),
      "openai": try wire.toWire("openai"),
      "anthropic": try wire.toWire("anthropic"),
      "unmapped": try wire.toWire("unmapped-provider"),
      "emptyProvider": try wire.toWire(""),
      "reference": try reference.save(),
    ]

    let encoded = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    print("TYPRA_CONFORMANCE:" + String(decoding: encoded, as: UTF8.self))
  }

  // An open discriminator must absorb a value that no subtype claims, carry the
  // whole payload verbatim, and replay it on save. Every other backend runner
  // asserts this; swift did not, which is the same "asserted somewhere, but not
  // everywhere" gap that let the toWire defect reach a release.
  func testUnknownDiscriminatorCarrierRoundTrips() throws {
    let input: [String: Any] = [
      "kind": "future-auth",
      "name": "future",
      "config": ["nested": [1, NSNull(), ["enabled": true]]],
      "nullable": NSNull(),
    ]
    let saved = try FixtureConnection.load(input).save()
    XCTAssertEqual(saved["kind"] as? String, "future-auth", "unknown carrier lost its discriminator")
    XCTAssertEqual(saved["name"] as? String, "future", "unknown carrier lost a modeled field")
    XCTAssertTrue(saved["nullable"] is NSNull, "unknown carrier dropped an explicit null")
    XCTAssertNotNil(saved["config"], "unknown carrier dropped an unmodeled nested field")

    let reloaded = try FixtureConnection.load(saved).save()
    let first = try JSONSerialization.data(withJSONObject: saved, options: [.sortedKeys])
    let second = try JSONSerialization.data(withJSONObject: reloaded, options: [.sortedKeys])
    XCTAssertEqual(first, second, "unknown carrier payload did not survive a reload")
  }

  // Both declared named-collection forms load equivalently, while an array-valued
  // entry in the name-keyed object form is rejected. Locking both halves together
  // keeps a fix for one from silently breaking the other.
  func testNamedCollectionHonoursBothDeclaredForms() throws {
    let listForm = try FixtureNamedPayloadCollection.load(["items": [["name": "alpha", "payload": "one"]]])
    let objectForm = try FixtureNamedPayloadCollection.load(["items": ["alpha": ["payload": "one"]]])
    XCTAssertEqual(listForm.items.count, 1, "list form did not load a single entry")
    XCTAssertEqual(objectForm.items.count, 1, "name-keyed object form did not load a single entry")
    XCTAssertEqual(listForm.items.first?.name, "alpha", "list form lost the entry name")
    XCTAssertEqual(objectForm.items.first?.name, "alpha", "name-keyed object form did not adopt the key as the name")

    XCTAssertThrowsError(try FixtureNamedPayloadCollection.load(["items": ["alpha": ["one", "two"]]])) { error in
      XCTAssertTrue(
        String(describing: error).contains("category array"),
        "array-valued entry in name-keyed object form was not rejected as a category array"
      )
    }
  }

  // Issue #47: a failure inside an array element must carry the element index, so a
  // diagnostic cannot silently degrade to naming only the field.
  func testArrayElementDiagnosticCarriesTheIndex() throws {
    let input: [String: Any] = [
      "entries": [
        ["label": "first", "detail": ["code": "ok"]],
        ["label": "second"],
      ]
    ]
    XCTAssertThrowsError(try FixtureIndexedList.load(input)) { error in
      XCTAssertTrue(
        String(describing: error).contains("entries[1].detail"),
        "array element diagnostic lost the element index"
      )
    }
  }
}
`);

  try {
    const output = execFileSync(
      "swift",
      ["test", "--package-path", sourceDir, "--scratch-path", buildDir, "--filter", "ConformanceValidateTests"],
      { cwd: sourceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: swiftToolchainEnv() },
    );
    assertConformanceResult("swift", extractConformancePayload(output));
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated Swift executable conformance failed:\n${output || error.message}`);
  } finally {
    if (existsSync(runnerPath)) {
      unlinkSync(runnerPath);
    }
    rmSync(buildDir, { recursive: true, force: true });
  }
}

/** Pulls the sentinel-tagged payload out of a test runner's interleaved output. */
function extractConformancePayload(rawOutput) {
  const marker = "TYPRA_CONFORMANCE:";
  const line = rawOutput.split(/\r?\n/).find(entry => entry.includes(marker));
  if (!line) {
    return rawOutput;
  }
  return line.slice(line.indexOf(marker) + marker.length).trim();
}

function mkdirp(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
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
      ["python_pydantic", () => runPythonExecutableConformance("python_pydantic", "python_pydantic")],
      ["go", runGoExecutableConformance],
      ["rust", runRustExecutableConformance],
      ["rust-unknown", runRustUnknownAbstractConformance],
      ["csharp", runCSharpExecutableConformance],
      ["java", runJavaExecutableConformance],
      ["swift", runSwiftExecutableConformance],
    ]),
    allowedSkips: { swift: TOOLCHAIN_UNAVAILABLE },
  });
}

function assertGeneratedTargets() {
  for (const target of ["typescript", "typescript-zod", "python", "python_pydantic", "go", "java", "java-jackson", "csharp", "rust", "swift", "markdown", "json-ast"]) {
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
    "display(",
    "fromJson",
  );
  assertIncludes(
    path.join("generated", "fixtures", "typescript", "wire-options.ts"),
    "toWire(provider: string)",
    "max_completion_tokens",
    "max_tokens",
  );
  assertIncludes(
    path.join("generated", "fixtures", "typescript-zod", "fixture-content.ts"),
    'import { z } from "zod";',
    'static readonly wireSchema',
    'z.discriminatedUnion("kind"',
    'static readonly schema',
  );
  assertIncludes(
    path.join("generated", "fixtures", "typescript-zod", "fixture-connection.ts"),
    "wireObjectSchemaWithoutName",
    ".passthrough()",
    "return FixtureConnection.load(data as Record<string, unknown>).save();",
    "ctx.addIssue({ code: z.ZodIssueCode.custom, message: String(error) });",
    "}).pipe(FixtureConnection.wireSchema)",
  );
  assertIncludes(
    path.join("generated", "fixtures", "typescript", "tests", "fixture-root.test.ts"),
    "should load from JSON - example 1",
    "expect(instance.name).toEqual(\"fixture-root\")",
    "should round-trip YAML - example 1",
  );
  assertIncludes(
    path.join("generated", "fixtures", "typescript", "tests", "fixture-content.test.ts"),
    "describe(\"FixtureContent\"",
  );
  assertIncludes(
    path.join("generated", "fixtures", "typescript", "tests", "protocol-scaffolds.test.ts"),
    "describe(\"protocol scaffolds\", () => {",
    "it(\"compiles compile-only protocol implementations\", () => {",
    "class CompileOnlyEventSink implements EventSink",
    "throw new Error(\"EventSink.emit is a compile-only protocol scaffold.\")",
  );

  assertIncludes(
    path.join("generated", "fixtures", "python", "_FixtureReference.py"),
    "def named(",
    "def display(",
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
    'output_modalities: list[str] | None = Field(default_factory=list, alias="outputModalities")',
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
    path.join("generated", "fixtures", "swift", "Sources", "TypraFixtures", "model_info.swift"),
    "public var inputModalities: [String]? = nil",
    "public var outputModalities: [String]? = []",
    "public var owners: [FixtureOwner]? = nil",
    "public var defaultOwners: [FixtureOwner]? = []",
  );
  assertIncludes(
    path.join("generated", "fixtures", "python", "tests", "test_protocol_scaffolds.py"),
    "from __future__ import annotations",
    "class CompileOnlyCheckpointStore(CheckpointStore):",
    "def save(self, checkpoint: Checkpoint) -> None:",
    "async def save_async(self, checkpoint: Checkpoint) -> None:",
    "class CompileOnlyEventSink(EventSink):",
    "del event",
    "raise NotImplementedError(\"EventSink.emit is a compile-only protocol scaffold.\")",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "wire_options.go"),
    "func (",
    "ToWire(provider string)",
    "max_completion_tokens",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "tests", "fixture_root_test.go"),
    "Expected Tags length to be 3",
    "Expected Content to be fixtures.TextContent",
    "Expected Owner.DisplayName",
    "TestFixtureRootFromJSONInvalid",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "tests", "fixture_reference_test.go"),
    "FixtureReferenceFromJSON(string(jsonBytes))",
    "FixtureReferenceFromYAML(string(yamlBytes))",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "tests", "fixture_multiline_whitespace_test.go"),
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
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "tests", "protocol_scaffolds_test.go"),
    'typra "fixtures"',
    "var _ typra.EventSink = (*compileOnlyEventSink)(nil)",
    "return errors.New(\"compile-only protocol scaffold\")",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "WireOptions.java"),
    "public Map<String, Object> toWire(String provider)",
    "max_completion_tokens",
    "max_tokens",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "FixtureRoot.java"),
    "return fromJson(json, new LoadContext());",
    "return fromYaml(yaml, new LoadContext());",
    "public String toYaml()",
    "result.status = FixtureStatus.fromValue",
    "result.put(\"status\", obj.status.value)",
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
    "@JsonProperty(\"status\")",
    "value.save(new SaveContext())",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java-jackson", "tests", "FixtureRootGeneratedTest.java"),
    "assertJacksonMatches(instance1, jsonData1, FixtureRoot.class",
    "mapper.writeValueAsString(instance)",
    "mapper.readValue(sourceJson, type)",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "FixtureStatus.java"),
    "public enum FixtureStatus",
    "fromValue(String value)",
    "case \"complete\":",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "FixtureReference.java"),
    "return FixtureReferenceMethods.display(this, prefix);",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "FixtureReferenceMethods.java"),
    "// <typra-editable-seam>",
    "Typra editable seam. This file is created once and is safe to edit.",
    "public static String display(FixtureReference self, String prefix)",
  );
  assertExcludes(
    path.join("generated", "fixtures", "java", "FixtureReferenceMethods.java"),
    "// <auto-generated by typra-emitter>",
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
    path.join("generated", "fixtures", "java", "tests", "FixtureRootGeneratedTest.java"),
    "FixtureRoot.fromJson(jsonData1)",
    "String yamlRoundtrip1 = instance1.toYaml();",
    "FixtureRoot fromYaml1 = FixtureRoot.fromYaml(yamlRoundtrip1);",
    "assertThrows(() -> FixtureRoot.fromYaml(\":\\n  broken\")",
    "assertThrows(() -> FixtureRoot.fromJson(\"{\")",
  );
  assertIncludes(
    path.join("generated", "fixtures", "java", "tests", "ProtocolScaffoldsGeneratedTest.java"),
    "final class ProtocolScaffoldsGeneratedTest",
    "throw new UnsupportedOperationException(\"EventSink.emit is a compile-only protocol scaffold.\")",
  );
  assertIncludes(
    path.join("generated", "fixtures", "csharp", "FixtureReference.cs"),
    "public static FixtureReference Named(",
    "Display(",
  );
  assertIncludes(
    path.join("generated", "fixtures", "csharp", "tests", "ProtocolScaffolds.cs"),
    "internal sealed class CompileOnlyEventSink : IEventSink",
    "throw new NotSupportedException(\"EventSink.emit is a compile-only protocol scaffold.\")",
    "Task.FromException(new NotSupportedException(\"CheckpointStore.save is a compile-only protocol scaffold.\"))",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "fixture_reference.rs"),
    "pub fn named(",
    "fn display(&self, prefix: &String) -> String;",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "fixture_property.rs"),
    "if let Some(value) = value.as_i64() {",
    'kind: FixturePropertyKind::FixtureIntegerProperty, default: Some(value.into())',
    "if let Some(value) = value.as_f64() {",
    'kind: FixturePropertyKind::FixtureNumberProperty, default: Some(value.into())',
  );
  // The float32-declared coercion must not narrow through f32: serde_json holds an
  // exact f64 and the vector contract requires "the unmodified scalar".
  assertExcludes(
    path.join("generated", "fixtures", "rust", "fixture_property.rs"),
    "value.as_f64().map(|value| value as f32)",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "tests", "protocol_scaffolds_test.rs"),
    "impl EventSink for CompileOnlyEventSink",
    "panic!(\"EventSink.emit is a compile-only protocol scaffold.\")",
  );
  assertIncludes(
    path.join("generated", "fixtures", "swift", "Sources", "TypraFixtures", "fixture_root.swift"),
    "public struct FixtureRoot: TypraModel",
    "public static func load(_ data: Any",
    "public func save(_ context: SaveContext",
    'try FixtureContent.load(value, context: context.at("content"))',
  );
  assertIncludes(
    path.join("generated", "fixtures", "swift", "Sources", "TypraFixtures", "wire_options.swift"),
    "public func toWire(_ provider: String",
    "max_completion_tokens",
    "max_tokens",
  );
  assertIncludes(
    path.join("generated", "fixtures", "swift", "Tests", "TypraFixturesTests", "ProtocolScaffoldsTests.swift"),
    "final class ProtocolScaffoldsTests",
    "final class CompileOnlyEventSink: EventSink",
    "EventSink.emit is a compile-only protocol scaffold.",
  );
  assertIncludes(
    path.join("generated", "fixtures", "markdown", "FixtureRoot.md"),
    "FixtureOwner",
    "FixtureContent",
  );
  assertMarkdownFrontmatterFirst(path.join("generated", "fixtures", "markdown", "FixtureRoot.md"));
  assertIncludes(
    path.join("generated", "fixtures", "markdown", "WireOptions.md"),
    "WireOptions",
    "maxOutputTokens",
  );
  assertMarkdownFrontmatterFirst(path.join("generated", "fixtures", "markdown", "WireOptions.md"));
}

function assertExportSurfaceSnapshot() {
  const snapshot = readJson(path.join("generated", "fixtures", ".typra-generated", "export-surfaces.json"));
  if (!snapshot) return;

  if (snapshot.emitter !== "typra-emitter" || snapshot.version !== 1) {
    fail("Export surface snapshot has an unexpected emitter/version.");
  }
  const toolchainPackages = snapshot.toolchain?.packages ?? [];
  const toolchainNames = toolchainPackages.map(entry => entry.name);
  const sortedToolchainNames = [...toolchainNames].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(toolchainNames) !== JSON.stringify(sortedToolchainNames)) {
    fail("Export surface snapshot toolchain metadata is not sorted by package name.");
  }
  for (const packageName of ["@typespec/compiler", "@typespec/json-schema", "@typra/emitter"]) {
    const entry = toolchainPackages.find(item => item.name === packageName);
    if (!entry?.version || !entry?.supportedRange || typeof entry.supported !== "boolean") {
      fail(`Export surface snapshot is missing complete toolchain metadata for ${packageName}.`);
    }
  }
  if (snapshot.root?.object !== "Typra.Fixtures.FixtureRoot") {
    fail("Export surface snapshot does not record the fixture root object.");
  }

  const targets = new Map((snapshot.targets ?? []).map(target => [target.target, target]));
  for (const target of ["typescript", "python", "go", "java", "csharp", "rust", "swift", "markdown"]) {
    if (!targets.has(target)) {
      fail(`Export surface snapshot is missing target: ${target}`);
    }
  }
  if (!snapshot.targets?.some(target => target.target === "typescript" && target.outputRoot?.endsWith("generated/fixtures/typescript-zod"))) {
    fail("Export surface snapshot is missing the TypeScript Zod output root.");
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
    "TypeScript pipeline modules",
    targets.get("typescript")?.groups?.find(group => group.name === "pipeline")?.modules ?? [],
    "event-sink",
    "checkpoint-store",
  );
  assertArrayIncludes(
    "Python pipeline modules",
    targets.get("python")?.groups?.find(group => group.name === "pipeline")?.modules ?? [],
    "_EventSink",
    "_CheckpointStore",
  );
  assertArrayIncludes(
    "C# grouped sources",
    (targets.get("csharp")?.exports ?? []).map(entry => entry.source),
    "events/Checkpoint.cs",
    "pipeline/EventSink.cs",
    "pipeline/CheckpointStore.cs",
  );

  if (targets.get("go")?.packageName !== "fixtures") {
    fail(`Go export surface package name drifted: ${targets.get("go")?.packageName}`);
  }
  if (targets.get("java")?.packageName !== "typra.fixtures") {
    fail(`Java export surface package name drifted: ${targets.get("java")?.packageName}`);
  }

  const typeScriptProtocols = targets.get("typescript")?.protocols ?? [];
  const eventSink = typeScriptProtocols.find(protocol => protocol.name === "EventSink");
  if (!eventSink) {
    fail("Export surface snapshot is missing EventSink protocol.");
  } else {
    const emit = eventSink.methods.find(method => method.name === "emit");
    if (emit?.returns !== "void") {
      fail("EventSink.emit return shape drifted from void.");
    }
  }
}

function assertHydrationBoundarySnapshot() {
  const snapshot = readJson(path.join("generated", "fixtures", ".typra-generated", "hydration-seams.json"));
  if (!snapshot) return;

  if (snapshot.emitter !== "typra-emitter" || snapshot.version !== 1) {
    fail("Hydration boundary snapshot has an unexpected emitter/version.");
  }
  const seams = snapshot.seams ?? [];
  const eventSink = seams.find(seam => seam.contract === "EventSink" && seam.target === "typescript");
  if (!eventSink) {
    fail("Hydration boundary snapshot is missing the TypeScript EventSink protocol seam.");
  } else if (eventSink.generatedSource !== "./pipeline/event-sink" || eventSink.seamKind !== "protocol-adapter") {
    fail("Hydration boundary snapshot EventSink seam drifted.");
  }
}

function assertGeneratedOutputReport() {
  const report = readJson(path.join("generated", "fixtures", ".typra-generated", "report.json"));
  if (!report) {
    fail("Generated output report is missing.");
    return;
  }

  if (report.emitter !== "typra-emitter" || report.version !== 1) {
    fail("Generated output report has an unexpected emitter/version.");
  }
  if (report.generatedAt !== "1970-01-01T00:00:00.000Z") {
    fail("Generated output report must use deterministic generatedAt in fixture mode.");
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
    fail("Generated output report summary must report clean hygiene for fixtures.");
  }
  if (report.generation?.deterministicOutput !== true || report.generation?.rootObject !== "Typra.Fixtures.FixtureRoot") {
    fail("Generated output report must record deterministic generation context.");
  }
  if (!report.generation?.emitTargets?.some(entry => entry.type === "TypeScript" && entry.outputDir?.endsWith("generated/fixtures/typescript"))) {
    fail("Generated output report must record emit target context.");
  }
  if (!report.emittedFiles.some(entry => entry.path.endsWith("generated/fixtures/python/_FixtureRoot.py"))) {
    fail("Generated output report is missing a representative Python emitted file.");
  }
  if (!Array.isArray(report.skippedFiles)) {
    fail("Generated output report must list skipped files.");
  }
  if (!Array.isArray(report.staleMarkerOwnedRemovals) || !Array.isArray(report.preservedUnmarkedSkippedFiles)) {
    fail("Generated output report must list cleanup action summaries.");
  }
  if (report.hygiene?.lineEndings !== "lf" || report.hygiene?.finalNewline !== true || report.hygiene?.trailingWhitespace !== "trimmed") {
    fail("Generated output report hygiene policy drifted.");
  }
  if (report.protectedPathTouches?.status !== "requires-verifier-baseline") {
    fail("Generated output report must mark protected path touches as verifier-baseline scoped.");
  }
  if (!Array.isArray(report.protectedPathTouches?.matchedFiles)) {
    fail("Generated output report must include protected path matched files.");
  }
  if (report.cleanup?.status !== "safe-noop") {
    fail("Generated output report cleanup status must be stable for fixtures.");
  }
  if (!report.driftGuidance?.metadataToCompare?.includes(".typra-generated/export-surfaces.json")) {
    fail("Generated output report must guide consumers to compare export surface metadata.");
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
    'export type { EventSink } from "./pipeline/event-sink";',
    'export type { CheckpointStore } from "./pipeline/checkpoint-store";',
  );
  assertIncludes(
    path.join("generated", "fixtures", "python", "__init__.py"),
    "from .pipeline import (",
    "    EventSink,",
    "    CheckpointStore,",
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
    path.join("generated", "fixtures", "rust", "pipeline", "mod.rs"),
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
    path.join("generated", "fixtures", "typescript", "pipeline", "event-sink.ts"),
    "emit(event: unknown): void;",
  );
  assertIncludes(
    path.join("generated", "fixtures", "python", "pipeline", "_EventSink.py"),
    "def emit(self, event: Any) -> None:",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "pipeline", "event_sink.rs"),
    "fn emit(&self, event: &serde_json::Value) -> ();",
  );
  assertIncludes(
    path.join("generated", "fixtures", "swift", "Package.swift"),
    'name: "TypraFixtures"',
    '.testTarget(name: "TypraFixturesTests"',
  );
  assertIncludes(
    path.join("generated", "fixtures", "swift", "Sources", "TypraFixtures", "pipeline", "event_sink.swift"),
    "public protocol EventSink",
    "func emit(event: Any) throws",
  );
}

function assertNoEmptyTargetDirs() {
  for (const target of ["typescript", "python", "python_pydantic", "go", "java", "java-jackson", "csharp", "rust", "swift", "markdown"]) {
    const dir = path.join(generatedRoot, target);
    if (existsSync(dir) && statSync(dir).isDirectory() && walkFiles(dir).length === 0) {
      fail(`Generated target directory is empty: ${target}`);
    }
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
      ["static-fixture-coverage", assertStaticFixtureCoverage],
      ["static-conformance-matrix", assertConformanceMatrix],
      ["export-surface-snapshot", assertExportSurfaceSnapshot],
      ["hydration-boundary-snapshot", assertHydrationBoundarySnapshot],
      ["generated-output-report", assertGeneratedOutputReport],
      ["actual-generated-surface", assertActualGeneratedSurface],
      ["typra-verify", runTypraVerify],
      ["consumer-smoke", runTypraConsumerSmoke],
      ["typescript.compile", runGeneratedTypeScriptCompile],
      ["typescript-zod.compile", runGeneratedTypeScriptZodCompile],
      ["python.compile", () => runPythonCompile()],
      ["python_pydantic.compile", () => runPythonCompile("python_pydantic")],
      ["python.generated-tests", () => runPythonGeneratedTests()],
      ["python_pydantic.generated-tests", () => runPythonGeneratedTests("python_pydantic", "fixtures_pydantic")],
      ["go.generated-tests", runGoTests],
      ["rust.generated-tests", runRustTests],
      ["swift.generated-tests", runSwiftTests],
      ["csharp.build", runCSharpBuild],
      ["csharp.consumer-nullability-build", runCSharpConsumerNullabilityBuild],
      ["csharp.generated-tests", runCSharpGeneratedTests],
      ["csharp.protocol-scaffold-build", runCSharpProtocolScaffoldBuild],
      ["java.build", runJavaBuild],
      ["java.generated-tests", runJavaGeneratedTests],
      ["java-jackson.build", runJavaJacksonBuild],
      ["java-jackson.generated-tests", runJavaJacksonGeneratedTests],
      ["executable-conformance", runExecutableConformance],
    ]),
    allowedSkips: { "swift.generated-tests": TOOLCHAIN_UNAVAILABLE },
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
