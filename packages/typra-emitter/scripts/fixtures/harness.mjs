import { execFileSync as nodeExecFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  compareExpectedExecution,
  TOOLCHAIN_UNAVAILABLE,
} from "../validation-execution.mjs";

export {
  cpSync,
  mkdtempSync,
  rmSync,
  tmpdir,
  existsSync,
  mkdirSync,
  path,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
};

export const packageRoot = process.cwd();

/**
 * Node defaults `maxBuffer` to 1 MB and throws ENOBUFS past it. The verifier's `--json`
 * self-compare already emits ~1 MB for the current fixture set, so any fixture growth makes
 * every child process here fail in a way that is indistinguishable from a real tool failure.
 * These are all build/test/verify steps whose output we want in full.
 */
export const CHILD_PROCESS_MAX_BUFFER = 64 * 1024 * 1024;

export function execFileSync(file, args, options = {}) {
  return nodeExecFileSync(file, args, {
    maxBuffer: CHILD_PROCESS_MAX_BUFFER,
    ...options,
  });
}

export const sourceGeneratedRoot = path.join(
  packageRoot,
  "generated",
  "fixtures",
);

export const validationRoot = mkdtempSync(
  path.join(tmpdir(), "typra-fixtures-"),
);

export const generatedRoot = path.join(validationRoot, "fixtures");

export const packageNodeModules = path.resolve(
  packageRoot,
  "..",
  "..",
  "node_modules",
);

export const scratchEntries = new Set([
  ".build",
  ".classes",
  "__pycache__",
  "bin",
  "obj",
  "target",
]);

// Path segments (dir names / file basenames) for the runtime-authored reference
// vector adapters. They are consumer-supplied, not emitter output, so the
// formatter-idempotency guard must ignore them — otherwise a non-idempotent
// adapter file would be mis-attributed as emitter drift. See authorVectorAdapters.
export const AUTHORED_VECTOR_ADAPTER_SEGMENTS = new Set([
  "vector-adapters.ts",
  "vector_adapters.py",
  "vectoradapters",
  "vector_adapters.rs",
  "VectorAdapters.cs",
  "VectorAdapters.java",
  "VectorAdapters.swift",
]);

cpSync(sourceGeneratedRoot, generatedRoot, {
  recursive: true,
  filter: (source) => !scratchEntries.has(path.basename(source)),
});

if (existsSync(packageNodeModules)) {
  symlinkSync(
    packageNodeModules,
    path.join(validationRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

process.on("exit", () =>
  rmSync(validationRoot, { recursive: true, force: true }),
);

export const failures = [];

export const CSHARP_TARGET_FRAMEWORK = "net10.0";

export const JACKSON_VERSION = "2.17.2";

export const JACKSON_ARTIFACTS = [
  "jackson-annotations",
  "jackson-core",
  "jackson-databind",
];

export const KNOWN_TEST_FAILURES = {
  typescript: new Map(),
  python: new Map(),
  python_pydantic: new Map(),
  csharp: new Map(),
  go: new Map(),
  java: new Map(),
  "java-jackson": new Map(),
  rust: new Map(),
  "rust-serde": new Map(),
  swift: new Map(),
  "swift-codable": new Map(),
};

export function fail(message) {
  failures.push(message);
}

export function runExpectedExecutionPlan({
  label,
  expectedIds,
  implementations,
  allowedSkips = {},
}) {
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
    if (!skipped.slice(beforeSkipCount).some((entry) => entry.id === id)) {
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

export function assertKnownTestFailures(
  target,
  failed,
  knownFailures,
  options = {},
) {
  const {
    crashed = null,
    output = "",
    crashMessage = `Generated ${target} tests failed to build, collect, or run`,
  } = options;
  if (crashed && failed.size === 0) {
    fail(`${crashMessage}:\n${output.trim() || crashed.message}`);
    return;
  }

  const unexpected = [...failed].filter((name) => !knownFailures.has(name));
  if (unexpected.length > 0) {
    fail(
      `Generated ${target} tests failed:\n` +
        unexpected.map((name) => `  ${name}`).join("\n"),
    );
  }

  const fixed = [...knownFailures.keys()].filter((name) => !failed.has(name));
  if (fixed.length > 0) {
    fail(
      `Generated ${target} tests listed as known failures now pass. Remove them from ` +
        `KNOWN_TEST_FAILURES.${target} in scripts/validate-fixtures.mjs:\n` +
        fixed
          .map((name) => `  ${name} (#${knownFailures.get(name)})`)
          .join("\n"),
    );
  }
}

export function requirePath(relativePath) {
  const fullPath = path.join(packageRoot, relativePath);
  if (!existsSync(fullPath)) {
    fail(`Missing expected fixture artifact: ${relativePath}`);
  }
  return fullPath;
}

export function read(relativePath) {
  const fullPath = requirePath(relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

export function assertIncludes(relativePath, ...needles) {
  const content = read(relativePath);
  for (const needle of needles) {
    if (!content.includes(needle)) {
      fail(`${relativePath} does not include expected content: ${needle}`);
    }
  }
}

export function assertExcludes(relativePath, ...needles) {
  const content = read(relativePath);
  for (const needle of needles) {
    if (content.includes(needle)) {
      fail(`${relativePath} includes unexpected content: ${needle}`);
    }
  }
}

export function assertMarkdownFrontmatterFirst(relativePath) {
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

  const afterFrontmatter = content.slice(
    closingIndex + closingDelimiter.length,
  );
  if (
    !afterFrontmatter.startsWith("<!-- <auto-generated by typra-emitter> -->\n")
  ) {
    fail(
      `${relativePath} must emit the generated marker after YAML frontmatter.`,
    );
  }
}

export function assertArrayIncludes(label, actual, ...expected) {
  for (const value of expected) {
    if (!actual.includes(value)) {
      fail(`${label} does not include expected value: ${value}`);
    }
  }
}

export function readJson(relativePath) {
  const content = read(relativePath);
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

export function walkFiles(dir, predicate = () => true) {
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

export function toPascalCase(value) {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

export const GENERATED_TEXT_EXTENSIONS = new Set([
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

export function isGeneratedTextFile(file) {
  if (file.includes(`${path.sep}.build${path.sep}`)) {
    return false;
  }
  return GENERATED_TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function commandExists(command) {
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

export function resolveCommand(candidates) {
  return candidates.find((command) => commandExists(command));
}

export function requirePythonRunner(label) {
  if (!commandExists("uv")) {
    fail(`${label} cannot run because uv is not available.`);
    return undefined;
  }
  return {
    command: "uv",
    argsPrefix: [
      "run",
      "--python",
      "3.12",
      "--with",
      "pydantic",
      "--with",
      "pytest",
      "--with",
      "pytest-asyncio",
      "--with",
      "PyYAML",
      "python",
    ],
  };
}

export function runPythonCommand(label, args, options = {}) {
  const runner = requirePythonRunner(label);
  if (!runner) return;
  runCommand(label, runner.command, [...runner.argsPrefix, ...args], options);
}

export function runCommand(label, command, args, options = {}) {
  if (!commandExists(command)) {
    fail(`${label} cannot run because ${command} is not available.`);
    return;
  }
  try {
    execFileSync(command, args, {
      cwd: packageRoot,
      stdio: "pipe",
      ...options,
    });
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(`${label} failed:\n${output || error.message}`);
  }
}

export function runGoFormatCheck(sourceDir) {
  if (!commandExists("gofmt")) {
    fail(
      "Generated Go formatting validation cannot run because gofmt is not available.",
    );
    return;
  }
  try {
    const output = execFileSync("gofmt", ["-l", "."], {
      cwd: sourceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (output) {
      fail(`Generated Go files are not gofmt-formatted:\n${output}`);
    }
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated Go formatting validation failed:\n${output || error.message}`,
    );
  }
}

export function findSwiftWindowsSdk() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const platformsRoot = path.join(
    localAppData,
    "Programs",
    "Swift",
    "Platforms",
  );
  if (!existsSync(platformsRoot)) return undefined;
  const versions = readdirSync(platformsRoot)
    .map((version) =>
      path.join(
        platformsRoot,
        version,
        "Windows.platform",
        "Developer",
        "SDKs",
        "Windows.sdk",
      ),
    )
    .filter((candidate) => existsSync(candidate));
  return versions.sort((left, right) => right.localeCompare(left))[0];
}

export function findWindowsGitExecPath() {
  const inherited = process.env.GIT_EXEC_PATH;
  if (inherited && existsSync(path.join(inherited, "git-remote-https.exe"))) {
    return inherited;
  }

  const candidates = [];
  try {
    const gitPaths = execFileSync("where", ["git"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const gitPath of gitPaths) {
      const normalized = path.normalize(gitPath);
      const lower = normalized.toLowerCase();
      if (lower.endsWith(`${path.sep}cmd${path.sep}git.exe`)) {
        candidates.push(
          path.join(
            path.dirname(path.dirname(normalized)),
            "mingw64",
            "libexec",
            "git-core",
          ),
        );
      } else if (
        lower.endsWith(`${path.sep}mingw64${path.sep}bin${path.sep}git.exe`)
      ) {
        candidates.push(
          path.join(
            path.dirname(path.dirname(normalized)),
            "libexec",
            "git-core",
          ),
        );
      }
    }
  } catch {
    // Fall through to common install locations.
  }

  candidates.push(
    "C:\\Program Files\\Git\\mingw64\\libexec\\git-core",
    "C:\\Program Files (x86)\\Git\\mingw64\\libexec\\git-core",
  );

  return candidates.find((candidate) =>
    existsSync(path.join(candidate, "git-remote-https.exe")),
  );
}

export function appendGitConfig(env, key, value) {
  const index = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const nextIndex = Number.isFinite(index) && index >= 0 ? index : 0;
  env.GIT_CONFIG_COUNT = String(nextIndex + 1);
  env[`GIT_CONFIG_KEY_${nextIndex}`] = key;
  env[`GIT_CONFIG_VALUE_${nextIndex}`] = value;
}

export function swiftToolchainEnv() {
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

/** Pulls the sentinel-tagged payload out of a test runner's interleaved output. */
export function mkdirp(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function javaClasspathArgs(classpath) {
  return classpath ? ["-cp", classpath] : [];
}

export function javaRuntimeClasspath(classesDir, classpath) {
  return classpath ? `${classesDir}${path.delimiter}${classpath}` : classesDir;
}

export function jacksonClasspath() {
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

export function buildCSharpValidationStubs(sourceDir) {
  const members = [];
  for (const file of walkFiles(
    sourceDir,
    (file) =>
      file.endsWith(".cs") && !file.includes(`${path.sep}tests${path.sep}`),
  )) {
    const content = readFileSync(file, "utf8");
    const interfaceMatch = content.match(
      /public\s+partial\s+interface\s+I(?<typeName>\w+)Helpers\s*\{(?<body>[\s\S]*?)\n\}/,
    );
    if (!interfaceMatch?.groups) continue;

    const { typeName, body } = interfaceMatch.groups;
    const implementations = [];
    for (const line of body.split(/\r?\n/)) {
      const method = line
        .trim()
        .match(
          /^(?<returnType>[\w?<>,. ]+)\s+(?<name>\w+)\((?<params>[^)]*)\);$/,
        );
      if (method?.groups) {
        const { returnType, name, params } = method.groups;
        const bodyText =
          returnType.trim() === "void" ? " { }" : " => default!;";
        implementations.push(
          `    public ${returnType.trim()} ${name}(${params})${bodyText}`,
        );
        continue;
      }
      const property = line
        .trim()
        .match(/^(?<returnType>[\w?<>,. ]+)\s+(?<name>\w+)\s+\{\s+get;\s+\}$/);
      if (property?.groups) {
        implementations.push(
          `    public ${property.groups.returnType.trim()} ${property.groups.name} => default!;`,
        );
      }
    }

    if (implementations.length > 0) {
      members.push(
        `public partial class ${typeName}\n{\n${implementations.join("\n")}\n}`,
      );
    }
  }

  return ["namespace Typra.Fixtures;", "", ...members, ""].join("\n");
}
