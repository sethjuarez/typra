// Shared plumbing for tests that prove generated code against real toolchains: render a
// spec with the CLI, then compile (and optionally run a small probe program) per target.
// Each builder returns the combined toolchain output and throws with it on failure, so a
// red test shows the compiler's own diagnostic.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The emitter package root (this module runs from `dist/test`). */
export const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

export function toolAvailable(tool: string, args = ["--version"]): boolean {
  try {
    execFileSync(tool, args, { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function run(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    return execFileSync(tool, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `${tool} ${args.join(" ")} failed:\n${err.stdout ?? ""}${err.stderr ?? ""}`.trim() ||
        err.message,
    );
  }
}

/** A scratch directory under the package so specs can resolve `@typra/emitter`. */
export function scratchDir(prefix: string): string {
  return mkdtempSync(path.join(packageRoot, `tmp-${prefix}-`));
}

export function removeDir(dir: string): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** Renders `spec` (a file path or inline TypeSpec source) into `<root>/out/<target>`. */
export function generate(
  root: string,
  spec: string,
  rootObject: string,
  targets: string[],
  options: { tests?: boolean } = {},
): string {
  let specPath = spec;
  if (spec.includes("\n")) {
    specPath = path.join(root, "main.tsp");
    writeFileSync(specPath, spec);
  }
  const out = path.join(root, "out");
  run(
    process.execPath,
    [
      path.join(packageRoot, "dist", "src", "cli.js"),
      "--output",
      out,
      "--targets",
      targets.join(","),
      "--spec",
      specPath,
      "--root-object",
      rootObject,
      "--deterministic",
      "--no-format",
      ...(options.tests ? [] : ["--no-tests"]),
    ],
    packageRoot,
  );
  return out;
}

export function readSources(dir: string, extension: string): string {
  return listFiles(dir, extension)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

function listFiles(dir: string, extension: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** javac the emitted tree (warnings as errors) plus an optional `Main` probe, then run it. */
export function buildJava(sourceDir: string, main?: string): string {
  const classes = path.join(sourceDir, ".classes");
  mkdirSync(classes, { recursive: true });
  const sources = listFiles(sourceDir, ".java");
  if (main) {
    const mainPath = path.join(sourceDir, ".probe", "Main.java");
    mkdirSync(path.dirname(mainPath), { recursive: true });
    writeFileSync(mainPath, main);
    sources.push(mainPath);
  }
  let output = run(
    "javac",
    ["-Xlint:all", "-Werror", "-d", classes, ...sources],
    sourceDir,
  );
  if (main) output += run("java", ["-cp", classes, "Main"], sourceDir);
  return output;
}

/** dotnet-build the emitted tree (warnings as errors); with `program`, run it as an exe. */
export function buildCSharp(sourceDir: string, program?: string): string {
  const project = path.join(sourceDir, "Probe.csproj");
  writeFileSync(
    project,
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      "    <TargetFramework>net10.0</TargetFramework>",
      `    <OutputType>${program ? "Exe" : "Library"}</OutputType>`,
      "    <Nullable>enable</Nullable>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
      "  </PropertyGroup>",
      "  <ItemGroup>",
      '    <Compile Remove="tests/**/*.cs" />',
      '    <PackageReference Include="YamlDotNet" Version="16.3.0" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
  );
  if (program) writeFileSync(path.join(sourceDir, "Program.cs"), program);
  return run(
    "dotnet",
    [
      ...(program ? ["run", "--project", project] : ["build", project]),
      "--nologo",
      "-v",
      "q",
    ],
    sourceDir,
  );
}

/**
 * Builds and vets the emitted Go package as module `probe`. `testSource` becomes an
 * in-package `probe_test.go` (its `package` clause is filled in) and runs via `go test`.
 */
export function buildGo(sourceDir: string, testSource?: string): string {
  const goFile = listFiles(sourceDir, ".go").find((file) =>
    path.dirname(file) === sourceDir,
  );
  const pkg = goFile
    ? /^package\s+(\w+)/m.exec(readFileSync(goFile, "utf8"))?.[1]
    : undefined;
  if (!pkg) throw new Error(`no Go package found in ${sourceDir}`);
  writeFileSync(
    path.join(sourceDir, "go.mod"),
    "module probe\n\ngo 1.22\n\nrequire gopkg.in/yaml.v3 v3.0.1\n",
  );
  if (testSource) {
    writeFileSync(
      path.join(sourceDir, "probe_test.go"),
      `package ${pkg}\n\n${testSource}`,
    );
  }
  const env = { ...process.env, GOFLAGS: "-mod=mod" };
  let output = run("go", ["vet", "."], sourceDir, env);
  if (testSource) output += run("go", ["test", "-count=1", "."], sourceDir, env);
  return output;
}

/**
 * Type-checks the emitted TypeScript under `strict` as CommonJS into `<sourceDir>/.js`;
 * `probe` (CommonJS, requiring `./index.js`) then runs against the compiled output.
 */
export function buildTypeScript(sourceDir: string, probe?: string): string {
  const outDir = path.join(sourceDir, ".js");
  writeFileSync(
    path.join(sourceDir, "tsconfig.probe.json"),
    JSON.stringify({
      include: ["**/*.ts"],
      exclude: [".js", "tests"],
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022"],
        module: "commonjs",
        moduleResolution: "node",
        strict: true,
        skipLibCheck: true,
        rootDir: ".",
        outDir,
      },
    }),
  );
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  let output = run(
    process.execPath,
    [tsc, "-p", "tsconfig.probe.json"],
    sourceDir,
  );
  if (probe) {
    writeFileSync(path.join(outDir, "package.json"), '{"type":"commonjs"}\n');
    writeFileSync(path.join(outDir, "probe.cjs"), probe);
    output += run(process.execPath, ["probe.cjs"], outDir);
  }
  return output;
}

/** Runs `script` with the emitted Python package importable as `packageName`. */
export function buildPython(
  sourceDir: string,
  script: string,
  packageName = "probe_model",
): string {
  const root = `${sourceDir}-pyroot`;
  cpSync(sourceDir, path.join(root, packageName), { recursive: true });
  writeFileSync(path.join(root, "probe.py"), script);
  return run(
    "uv",
    [
      "run",
      "--python",
      "3.12",
      "--with",
      "pydantic",
      "--with",
      "pytest",
      "--with",
      "PyYAML",
      "python",
      "probe.py",
    ],
    root,
  );
}

/**
 * Builds the emitted Swift package and runs `main` as an executable `Probe` target that
 * depends on the package's library module (import it by the returned name; `main` may use
 * the `MODULE` placeholder). Yams is swapped for a local stub so the build needs no network.
 */
export function buildSwift(sourceDir: string, main: string): string {
  const manifestPath = path.join(sourceDir, "Package.swift");
  const original = readFileSync(manifestPath, "utf8");
  const module = /\.target\(name: "([^"]+)"/.exec(original)?.[1];
  if (!module) throw new Error(`no Swift library target in:\n${original}`);
  const manifest = original
    .replace(/\.package\(url: "[^"]*Yams[^"]*"[^)]*\)/, '.package(path: "Yams")')
    .replace(
      /(\.target\(name: "[^"]+"[^\n]*\))/,
      `$1,\n    .executableTarget(name: "Probe", dependencies: ["${module}"], path: "Sources/Probe")`,
    );
  if (!manifest.includes('.package(path: "Yams")') || !manifest.includes('"Probe"')) {
    throw new Error(`unexpected Swift manifest:\n${manifest}`);
  }
  writeFileSync(manifestPath, manifest);
  const yams = path.join(sourceDir, "Yams", "Sources", "Yams");
  mkdirSync(yams, { recursive: true });
  writeFileSync(
    path.join(sourceDir, "Yams", "Package.swift"),
    [
      "// swift-tools-version: 5.9",
      "import PackageDescription",
      'let package = Package(name: "Yams", products: [.library(name: "Yams", targets: ["Yams"])], targets: [.target(name: "Yams")])',
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(yams, "Yams.swift"),
    [
      "public func load(yaml: String) throws -> Any? { nil }",
      'public func dump(object: Any) throws -> String { "" }',
      "",
    ].join("\n"),
  );
  const probe = path.join(sourceDir, "Sources", "Probe");
  mkdirSync(probe, { recursive: true });
  writeFileSync(path.join(probe, "main.swift"), main.replaceAll("MODULE", module));
  return run("swift", ["run", "Probe"], sourceDir);
}

const cargoTargetDir = path.join(tmpdir(), "typra-native-probe-cargo-target");

/**
 * cargo-test the emitted crate (warnings denied) as library `probe`, mounting the
 * generated module as `probe::model`. `testSource` becomes `tests/probe.rs`.
 */
export function buildRust(sourceDir: string, testSource?: string): string {
  writeFileSync(
    path.join(sourceDir, "Cargo.toml"),
    [
      "[package]",
      'name = "probe"',
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
  if (testSource) {
    mkdirSync(path.join(sourceDir, "tests"), { recursive: true });
    writeFileSync(path.join(sourceDir, "tests", "probe.rs"), testSource);
  }
  return run(
    "cargo",
    [testSource ? "test" : "build", "--quiet"],
    sourceDir,
    { ...process.env, CARGO_TARGET_DIR: cargoTargetDir, RUSTFLAGS: "-D warnings" },
  );
}
