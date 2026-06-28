import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const packageRoot = process.cwd();
const generatedRoot = path.join(packageRoot, "generated", "fixtures");
const failures = [];

function fail(message) {
  failures.push(message);
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

function assertArrayIncludes(label, actual, ...expected) {
  for (const value of expected) {
    if (!actual.includes(value)) {
      fail(`${label} does not include expected value: ${value}`);
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

function runTypeScriptCompile() {
  const sourceDir = path.join(generatedRoot, "typescript");
  const sourceFiles = walkFiles(sourceDir, file =>
    file.endsWith(".ts") &&
    !file.includes(`${path.sep}tests${path.sep}`) &&
    !file.endsWith(`${path.sep}eslint.config.js`),
  );

  if (sourceFiles.length === 0) {
    fail("No generated TypeScript source files found to compile.");
    return;
  }

  const configPath = path.join(sourceDir, "tsconfig.validate.json");
  writeFileSync(configPath, JSON.stringify({
    compilerOptions: {
      noEmit: true,
      target: "ES2022",
      module: "commonjs",
      moduleResolution: "node",
      esModuleInterop: true,
      skipLibCheck: true,
      types: ["node"],
      lib: ["ES2022"],
    },
    files: sourceFiles,
  }, null, 2));

  const tscCli = findTypeScriptCli(packageRoot);
  if (!tscCli) return;

  try {
    execFileSync(
      process.execPath,
      [tscCli, "-p", configPath],
      { cwd: packageRoot, stdio: "pipe" },
    );
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`Generated TypeScript source does not compile:\n${output || error.message}`);
  } finally {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  }
}

function assertGeneratedTargets() {
  for (const target of ["typescript", "python", "go", "csharp", "rust", "markdown", "json-ast"]) {
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
    "should save to dictionary",
  );

  assertIncludes(
    path.join("generated", "fixtures", "python", "_FixtureReference.py"),
    "def named(",
    "def display(",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "wire_options.go"),
    "func (",
    "ToWire(provider string)",
    "max_completion_tokens",
  );
  assertIncludes(
    path.join("generated", "fixtures", "csharp", "FixtureReference.cs"),
    "public static FixtureReference Named(",
    "Display(",
  );
  assertIncludes(
    path.join("generated", "fixtures", "rust", "fixture_reference.rs"),
    "pub fn named(",
    "fn display(&self, prefix: &String) -> String;",
  );
  assertIncludes(
    path.join("generated", "fixtures", "markdown", "FixtureRoot.md"),
    "FixtureOwner",
    "FixtureContent",
  );
  assertIncludes(
    path.join("generated", "fixtures", "markdown", "WireOptions.md"),
    "WireOptions",
    "maxOutputTokens",
  );
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
  for (const target of ["typescript", "python", "go", "csharp", "rust", "markdown"]) {
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
    path.join("generated", "fixtures", "rust", "pipeline", "mod.rs"),
    "pub mod event_sink;\npub use event_sink::*;",
    "pub mod checkpoint_store;\npub use checkpoint_store::*;",
  );
  assertIncludes(
    path.join("generated", "fixtures", "go", "fixture_root.go"),
    "package fixtures",
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
}

function assertNoEmptyTargetDirs() {
  for (const target of ["typescript", "python", "go", "csharp", "rust", "markdown"]) {
    const dir = path.join(generatedRoot, target);
    if (existsSync(dir) && statSync(dir).isDirectory() && walkFiles(dir).length === 0) {
      fail(`Generated target directory is empty: ${target}`);
    }
  }
}

assertGeneratedTargets();
assertNoEmptyTargetDirs();
assertStaticFixtureCoverage();
assertExportSurfaceSnapshot();
assertActualGeneratedSurface();
runTypeScriptCompile();

if (failures.length > 0) {
  console.error("Fixture validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Fixture validation passed.");
