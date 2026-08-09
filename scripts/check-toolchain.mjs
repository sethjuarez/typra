import { execFileSync } from "node:child_process";

const checks = [
  {
    name: "Node.js",
    command: "node",
    args: ["--version"],
    required: true,
    versionRanges: [
      { minimum: "20.17.0", maximumExclusive: "21.0.0" },
      { minimum: "22.13.0", maximumExclusive: "23.0.0" },
      { minimum: "23.5.0" },
    ],
    expected: "22.x in CI; npm dependencies currently require >=22.13.0 or >=20.17.0 for some transitive packages.",
  },
  {
    name: "npm",
    command: "npm",
    args: ["--version"],
    required: true,
    minimumVersion: "11.0.0",
    expected: "11.x in CI.",
  },
  {
    name: "Python",
    command: ["python3", "python"],
    args: ["--version"],
    required: true,
    minimumVersion: "3.12.0",
    expected: "3.12 in CI; used for generated Python compile/tests/conformance.",
  },
  {
    name: "Python test dependencies",
    command: ["python3", "python"],
    args: ["-c", "import pytest, yaml"],
    required: true,
    expected: "pytest and PyYAML; install with `python -m pip install pytest PyYAML` for the interpreter reported above.",
  },
  {
    name: "Go",
    command: "go",
    args: ["version"],
    required: true,
    expected: "1.22.x in CI; used for generated Go formatting, vet, tests, and conformance.",
  },
  {
    name: "gofmt",
    command: "gofmt",
    args: ["-h"],
    required: true,
    expected: "Bundled with Go; used for generated Go formatting validation.",
    allowNonZero: true,
  },
  {
    name: "Java",
    command: "java",
    args: ["-version"],
    required: true,
    expected: "21 in CI; javac is also required for generated Java builds/tests.",
    stderr: true,
  },
  {
    name: "javac",
    command: "javac",
    args: ["-version"],
    required: true,
    expected: "21 in CI.",
    stderr: true,
  },
  {
    name: ".NET SDK",
    command: "dotnet",
    args: ["--version"],
    required: true,
    expected: ".NET SDK capable of targeting net10.0; used for generated C# builds/tests/conformance.",
  },
  {
    name: "Swift",
    command: "swift",
    args: ["--version"],
    required: process.env.CI_SWIFT_REQUIRED === "1",
    expected: "6.0 in CI; used for generated Swift package tests/conformance when Swift validation is required.",
  },
  {
    name: "Rust",
    command: "cargo",
    args: ["--version"],
    required: true,
    expected: "Cargo/Rust toolchain; used for generated Rust tests/conformance.",
  },
];

function commandExists(command) {
  try {
    const probe = process.platform === "win32" ? ["where", [command]] : ["sh", ["-c", `command -v ${command}`]];
    execFileSync(probe[0], probe[1], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveCommand(command) {
  const candidates = Array.isArray(command) ? command : [command];
  return candidates.find(candidate => commandExists(candidate));
}

function parseVersion(output) {
  const match = output.match(/v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

function compareVersions(actual, minimum) {
  for (let index = 0; index < minimum.length; index++) {
    const left = actual[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function satisfiesVersionRange(actual, range) {
  const minimum = parseVersion(range.minimum);
  const maximum = range.maximumExclusive ? parseVersion(range.maximumExclusive) : undefined;
  if (!minimum || compareVersions(actual, minimum) < 0) return false;
  if (maximum && compareVersions(actual, maximum) >= 0) return false;
  return true;
}

let missingRequired = false;

for (const check of checks) {
  const command = resolveCommand(check.command);
  if (!command) {
    const status = check.required ? "missing" : "missing optional";
    console.log(`✘ ${check.name}: ${status}. ${check.expected}`);
    missingRequired ||= check.required;
    continue;
  }

  try {
    const output = execFileSync(command, check.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const version = (check.stderr ? "" : output).trim().split(/\r?\n/)[0];
    if (check.minimumVersion || check.versionRanges) {
      const actual = parseVersion(output);
      const valid = check.versionRanges
        ? actual && check.versionRanges.some(range => satisfiesVersionRange(actual, range))
        : actual && compareVersions(actual, parseVersion(check.minimumVersion) ?? []) >= 0;
      if (!valid) {
        const required = check.versionRanges
          ? check.versionRanges.map(range => range.maximumExclusive ? `>=${range.minimum} <${range.maximumExclusive}` : `>=${range.minimum}`).join(" or ")
          : `>=${check.minimumVersion}`;
        console.log(`✘ ${check.name}: ${command}${version ? ` (${version})` : ""} does not satisfy ${required}. ${check.expected}`);
        missingRequired ||= check.required;
        continue;
      }
    }
    console.log(`✔ ${check.name}: ${command}${version ? ` (${version})` : ""}`);
  } catch (error) {
    const output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    if (check.allowNonZero && output) {
      console.log(`✔ ${check.name}: ${command}`);
      continue;
    }
    console.log(`✘ ${check.name}: ${command} failed. ${output || error.message}`);
    missingRequired ||= check.required;
  }
}

if (missingRequired) {
  process.exitCode = 1;
}
