import { execFileSync as nodeExecFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
const fixtureRootSample = {
  name: "fixture-root",
  description: "A generated fixture with broad emitter coverage.",
  tags: ["typespec", "emitter", "validation"],
  metadata: {
    source: "fixture",
    version: 1,
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
};
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
};
const conformanceExpected = normalizeConformanceValue({
  root: fixtureRootExpected,
  imageContent: imageContentSample,
  openai: {
    max_completion_tokens: 256,
    temperature: 0.7,
  },
  anthropic: {
    max_tokens: 256,
  },
  reference: {
    id: "ref-coerced",
    label: "coerced reference",
  },
});

function fail(message) {
  failures.push(message);
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

  if (JSON.stringify(actual) !== JSON.stringify(conformanceExpected)) {
    fail(`Executable conformance for ${target} did not match canonical output.\nExpected: ${JSON.stringify(conformanceExpected)}\nActual: ${JSON.stringify(actual)}`);
  }
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

  for (const conformanceCase of matrix.cases) {
    if (!conformanceCase.id) {
      fail("Conformance matrix contains a case without an id.");
      continue;
    }

    for (const target of matrix.targets) {
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

function runGeneratedTypeScriptCompile() {
  const sourceDir = path.join(generatedRoot, "typescript");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".ts"));

  if (sourceFiles.length === 0) {
    fail("No generated TypeScript files found to compile.");
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
    fail(`Generated TypeScript source and tests do not compile:\n${output || error.message}`);
  } finally {
    for (const tempPath of [configPath, ambientPath]) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
  }
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

function runPythonCompile() {
  const sourceDir = path.join(generatedRoot, "python");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".py"));
  if (sourceFiles.length === 0) {
    fail("No generated Python files found to compile.");
    return;
  }
  runCommand("Generated Python source syntax validation", "python", ["-m", "py_compile", ...sourceFiles]);
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

function runSwiftTests() {
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
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "safe.bareRepository";
    env.GIT_CONFIG_VALUE_0 = "all";
  }
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
    XCTAssertNil(unnamedItems?[1]["name"])

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
    "    <TargetFramework>net8.0</TargetFramework>",
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
    "    <TargetFramework>net8.0</TargetFramework>",
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
    const libraryPath = path.join(libraryBinDir, "Debug", "net8.0", "TypraFixtureConsumerLibrary.dll");
    if (!existsSync(libraryPath)) {
      fail(`Generated C# consumer library was not found at ${libraryPath}.`);
      return;
    }
    writeFileSync(consumerProjectPath, [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      "    <OutputType>Exe</OutputType>",
      "    <TargetFramework>net8.0</TargetFramework>",
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

function runCSharpNullabilityTestsBuild() {
  const sourceDir = path.join(generatedRoot, "csharp");
  const testPath = path.join(sourceDir, "tests", "FixtureUnknownRecordsConversionTests.cs");
  if (!existsSync(testPath)) {
    fail("No generated C# unknown-record nullability test found to build.");
    return;
  }

  const projectPath = path.join(sourceDir, "TypraFixtureTestsValidation.csproj");
  const stubsPath = path.join(sourceDir, "TypraFixtureTestsValidation.Stubs.cs");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "typra-csharp-tests-"));
  const binDir = path.join(outputRoot, "bin");
  const objDir = path.join(outputRoot, "obj");
  writeFileSync(projectPath, [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    "    <TargetFramework>net8.0</TargetFramework>",
    "    <Nullable>enable</Nullable>",
    "    <WarningsAsErrors>nullable</WarningsAsErrors>",
    "    <ImplicitUsings>enable</ImplicitUsings>",
    "    <IsTestProject>true</IsTestProject>",
    "    <IsPackable>false</IsPackable>",
    "  </PropertyGroup>",
    "  <ItemGroup>",
    '    <Compile Remove="tests/**/*.cs" />',
    '    <Compile Include="tests/FixtureUnknownRecordsConversionTests.cs" />',
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
    runCommand(
      "Generated C# nullability tests build",
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
    "    <TargetFramework>net8.0</TargetFramework>",
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
  const sourceDir = path.join(generatedRoot, "java");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".java"));
  if (sourceFiles.length === 0) {
    fail("No generated Java files found to build.");
    return;
  }

  const classesDir = path.join(sourceDir, ".classes");
  rmSync(classesDir, { recursive: true, force: true });
  mkdirSync(classesDir, { recursive: true });
  try {
    runCommand("Generated Java source build", "javac", ["-d", classesDir, ...sourceFiles], { cwd: sourceDir });
  } finally {
    rmSync(classesDir, { recursive: true, force: true });
  }
}

function runJavaGeneratedTests() {
  const sourceDir = path.join(generatedRoot, "java");
  const sourceFiles = walkFiles(sourceDir, file => file.endsWith(".java"));
  const classesDir = path.join(sourceDir, ".classes");
  if (sourceFiles.length === 0) {
    fail("No generated Java files found to test.");
    return;
  }

  rmSync(classesDir, { recursive: true, force: true });
  mkdirSync(classesDir, { recursive: true });
  try {
    const initialFailureCount = failures.length;
    runCommand("Generated Java tests build", "javac", ["-d", classesDir, ...sourceFiles], { cwd: sourceDir });
    if (failures.length > initialFailureCount) return;
    execFileSync("java", ["-cp", classesDir, "typra.fixtures.TypraGeneratedTests"], { cwd: sourceDir, stdio: "pipe" });
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated Java tests failed:\n${output || error.message}`);
  } finally {
    rmSync(classesDir, { recursive: true, force: true });
  }
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
    'import { FixtureConnection, FixtureContent, FixtureCustomTool, FixtureNamedPayloadCollection, FixtureNamedRoot, FixtureReference, FixtureRoot, FixtureTool, FixtureToolbox, SaveContext, WireOptions } from "./index";',
    "",
    `const root = FixtureRoot.load(${JSON.stringify(fixtureRootSample)});`,
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
    "console.log(JSON.stringify({",
    "  root: root.save(),",
    "  imageContent: imageContent.save(),",
    '  openai: wire.toWire("openai"),',
    '  anthropic: wire.toWire("anthropic"),',
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

function runPythonExecutableConformance() {
  const sourceDir = path.join(generatedRoot, "python");
  const runner = [
    "import json",
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(generatedRoot)})`,
    "from python import FixtureCheckpoint, FixtureConnection, FixtureContent, FixtureCustomTool, FixtureNamedPayloadCollection, FixtureNamedRoot, FixtureReference, FixtureRoot, FixtureTool, FixtureToolbox, LoadContext, ModelInfo, SaveContext, WireOptions",
    `root = FixtureRoot.load(${JSON.stringify(fixtureRootSample)})`,
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
    "try:",
    '    FixtureNamedRoot.load({"inputs": {"profile": {"properties": {"arrayEntry": []}}}})',
    "except TypeError as error:",
    "    message = str(error)",
    '    assert "inputs.profile.properties.arrayEntry" in message and "array" in message',
    "else:",
    '    raise AssertionError("array-valued named entry was accepted")',
    "print(json.dumps({",
    '    "root": root.save(),',
    '    "imageContent": image_content.save(),',
    '    "openai": wire.to_wire("openai"),',
    '    "anthropic": wire.to_wire("anthropic"),',
    '    "reference": reference.save(),',
    "}, sort_keys=True))",
    "",
  ].join("\n");

  if (!existsSync(sourceDir)) {
    fail("No generated Python directory found for executable conformance.");
    return;
  }
  if (!commandExists("python")) {
    fail("Generated Python executable conformance cannot run because python is not available.");
    return;
  }

  try {
    const output = execFileSync("python", ["-c", runner], { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    assertConformanceResult("python", output);
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated Python executable conformance failed:\n${output || error.message}`);
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
    "\troot, err := fixtures.LoadFixtureRoot(map[string]interface{}{",
    '\t\t"name": "fixture-root",',
    '\t\t"description": "A generated fixture with broad emitter coverage.",',
    '\t\t"tags": []interface{}{"typespec", "emitter", "validation"},',
    '\t\t"metadata": map[string]interface{}{"source": "fixture", "version": 1},',
    '\t\t"owner": map[string]interface{}{"id": "owner-1", "displayName": "Fixture Owner"},',
    '\t\t"content": map[string]interface{}{"kind": "text", "value": "hello from a polymorphic sample"},',
    '\t\t"contentItems": []interface{}{map[string]interface{}{"kind": "text", "value": "hello from a polymorphic collection"}},',
    '\t\t"status": "complete",',
    '\t\t"mode": "bulk",',
    "\t}, loadCtx)",
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
    "    let root = FixtureRoot::load_from_value(&json!({",
    '        "name": "fixture-root",',
    '        "description": "A generated fixture with broad emitter coverage.",',
    '        "tags": ["typespec", "emitter", "validation"],',
    '        "metadata": {"source": "fixture", "version": 1},',
    '        "owner": {"id": "owner-1", "displayName": "Fixture Owner"},',
    '        "content": {"kind": "text", "value": "hello from a polymorphic sample"},',
    '        "contentItems": [{"kind": "text", "value": "hello from a polymorphic collection"}],',
    '        "status": "complete",',
    '        "mode": "bulk"',
    "    }), &load_ctx);",
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
    '    let error = FixtureNamedRoot::from_json(r#"{"inputs":{"profile":{"properties":{"arrayEntry":[]}}}}"#, &load_ctx).expect_err("array-valued named entry");',
    '    let message = error.to_string();',
    '    assert!(message.contains("inputs.profile.properties.arrayEntry") && message.contains("array"), "{message}");',
    "    println!(\"{}\", json!({",
    '        "root": root.to_value(&save_ctx),',
    '        "imageContent": image_content.to_value(&save_ctx),',
    '        "openai": wire.to_wire("openai"),',
    '        "anthropic": wire.to_wire("anthropic"),',
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
    "    <TargetFramework>net8.0</TargetFramework>",
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
    "var root = FixtureRoot.Load(new Dictionary<string, object?>",
    "{",
    '    ["name"] = "fixture-root",',
    '    ["description"] = "A generated fixture with broad emitter coverage.",',
    '    ["tags"] = new List<object?> { "typespec", "emitter", "validation" },',
    '    ["metadata"] = new Dictionary<string, object?> { ["source"] = "fixture", ["version"] = 1, ["nullable"] = null },',
    '    ["owner"] = new Dictionary<string, object?> { ["id"] = "owner-1", ["displayName"] = "Fixture Owner" },',
    '    ["content"] = new Dictionary<string, object?> { ["kind"] = "text", ["value"] = "hello from a polymorphic sample" },',
    '    ["contentItems"] = new List<object?> { new Dictionary<string, object?> { ["kind"] = "text", ["value"] = "hello from a polymorphic collection" } },',
    '    ["status"] = "complete",',
    '    ["mode"] = "bulk",',
    "});",
    'if (root.Metadata is null || !root.Metadata.ContainsKey("nullable") || root.Metadata["nullable"] is not null) throw new InvalidOperationException("Record<unknown> must preserve explicit null values during load");',
    "var savedRoot = root.Save();",
    'if (savedRoot["metadata"] is not IDictionary<string, object?> savedMetadata || !savedMetadata.ContainsKey("nullable") || savedMetadata["nullable"] is not null) throw new InvalidOperationException("Record<unknown> must preserve explicit null values during save");',
    "var reloadedRoot = FixtureRoot.Load(savedRoot);",
    'if (reloadedRoot.Metadata is null || !reloadedRoot.Metadata.ContainsKey("nullable") || reloadedRoot.Metadata["nullable"] is not null) throw new InvalidOperationException("Record<unknown> must preserve explicit null values after reload");',
    'root.Metadata.Remove("nullable");',
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
    'try { FixtureNamedRoot.FromJson("""{"inputs":{"profile":{"properties":{"arrayEntry":[]}}}}"""); throw new InvalidOperationException("array-valued named entry was accepted"); } catch (ArgumentException error) { if (!error.Message.Contains("inputs.profile.properties.arrayEntry") || !error.Message.Contains("array")) throw; }',
    "Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object?>",
    "{",
    '    ["root"] = root.Save(),',
    '    ["imageContent"] = imageContent.Save(),',
    '    ["openai"] = wire.ToWire("openai"),',
    '    ["anthropic"] = wire.ToWire("anthropic"),',
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
    "    Map<String, Object> owner = new LinkedHashMap<>();",
    '    owner.put("id", "owner-1");',
    '    owner.put("displayName", "Fixture Owner");',
    "    Map<String, Object> metadata = new LinkedHashMap<>();",
    '    metadata.put("source", "fixture");',
    '    metadata.put("version", 1);',
    "    Map<String, Object> content = new LinkedHashMap<>();",
    '    content.put("kind", "text");',
    '    content.put("value", "hello from a polymorphic sample");',
    "    Map<String, Object> contentItem = new LinkedHashMap<>();",
    '    contentItem.put("kind", "text");',
    '    contentItem.put("value", "hello from a polymorphic collection");',
    "    Map<String, Object> imageContentData = new LinkedHashMap<>();",
    '    imageContentData.put("kind", "image");',
    '    imageContentData.put("url", "https://example.com/fixture.png");',
    "    Map<String, Object> rootData = new LinkedHashMap<>();",
    '    rootData.put("name", "fixture-root");',
    '    rootData.put("description", "A generated fixture with broad emitter coverage.");',
    '    rootData.put("tags", java.util.List.of("typespec", "emitter", "validation"));',
    '    rootData.put("metadata", metadata);',
    '    rootData.put("owner", owner);',
    '    rootData.put("content", content);',
    '    rootData.put("contentItems", java.util.List.of(contentItem));',
    '    rootData.put("status", "complete");',
    '    rootData.put("mode", "bulk");',
    "    Map<String, Object> wireData = new LinkedHashMap<>();",
    '    wireData.put("maxOutputTokens", 256);',
    '    wireData.put("temperature", 0.7);',
    "    FixtureRoot root = FixtureRoot.fromYaml(TypraYaml.stringify(rootData));",
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
    "    Map<String, Object> output = new LinkedHashMap<>();",
    '    output.put("root", reloadedRoot.save(new SaveContext()));',
    '    output.put("imageContent", reloadedImageContent.save(new SaveContext()));',
    '    output.put("openai", wire.toWire("openai"));',
    '    output.put("anthropic", wire.toWire("anthropic"));',
    '    output.put("reference", reloadedReference.save(new SaveContext()));',
    "    System.out.println(TypraJson.stringify(output));",
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

function mkdirp(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function runExecutableConformance() {
  runTypeScriptExecutableConformance();
  runPythonExecutableConformance();
  runGoExecutableConformance();
  runRustExecutableConformance();
  runRustUnknownAbstractConformance();
  runCSharpExecutableConformance();
  runJavaExecutableConformance();
}

function assertGeneratedTargets() {
  for (const target of ["typescript", "python", "go", "java", "csharp", "rust", "swift", "markdown", "json-ast"]) {
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
    path.join("generated", "fixtures", "typescript", "model-info.ts"),
    "inputModalities?: string[];",
    "outputModalities?: string[] = [];",
    "owners?: FixtureOwner[];",
    "defaultOwners?: FixtureOwner[] = [];",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "model_info.go"),
    "InputModalities  []string",
    "OutputModalities []string",
    "OutputModalities: []string{}",
    'json:"outputModalities" yaml:"outputModalities"',
    "Owners           []FixtureOwner",
    "DefaultOwners    []FixtureOwner",
    "DefaultOwners:    []FixtureOwner{}",
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
    "if let Some(value) = value.as_f64().map(|value| value as f32) {",
    'kind: FixturePropertyKind::FixtureNumberProperty, default: Some(value.into())',
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
  for (const target of ["typescript", "python", "go", "java", "csharp", "rust", "swift", "markdown"]) {
    const dir = path.join(generatedRoot, target);
    if (existsSync(dir) && statSync(dir).isDirectory() && walkFiles(dir).length === 0) {
      fail(`Generated target directory is empty: ${target}`);
    }
  }
}

assertGeneratedTargets();
assertNoEmptyTargetDirs();
assertGeneratedOutputHygiene();
assertStaticFixtureCoverage();
assertConformanceMatrix();
assertExportSurfaceSnapshot();
assertHydrationBoundarySnapshot();
assertGeneratedOutputReport();
assertActualGeneratedSurface();
runTypraVerify();
runTypraConsumerSmoke();
runGeneratedTypeScriptCompile();
runPythonCompile();
runGoTests();
runRustTests();
runSwiftTests();
runCSharpBuild();
runCSharpConsumerNullabilityBuild();
runCSharpNullabilityTestsBuild();
runCSharpProtocolScaffoldBuild();
runJavaBuild();
runJavaGeneratedTests();
runExecutableConformance();

if (failures.length > 0) {
  console.error("Fixture validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Fixture validation passed.");
