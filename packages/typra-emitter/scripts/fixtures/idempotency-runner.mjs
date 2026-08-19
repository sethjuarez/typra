import {
  AUTHORED_VECTOR_ADAPTER_SEGMENTS,
  commandExists,
  cpSync,
  execFileSync,
  existsSync,
  fail,
  generatedRoot,
  mkdtempSync,
  packageRoot,
  path,
  readFileSync,
  rmSync,
  scratchEntries,
  swiftToolchainEnv,
  tmpdir,
  walkFiles,
} from "./harness.mjs";
import {
  computeTreeDiff,
  decideIdempotencyOutcome,
} from "../idempotency-guard.mjs";

export { IDEMPOTENCY_TARGETS } from "../idempotency-guard.mjs";

/**
 * Resolve the local prettier CLI (hoisted to the workspace root under npm workspaces). Returned as
 * a path so the idempotency guard can run it via `node` exactly as the TypeScript driver does.
 */
export function resolvePrettierCli() {
  let current = packageRoot;
  while (current !== path.dirname(current)) {
    const candidate = path.join(
      current,
      "node_modules",
      "prettier",
      "bin",
      "prettier.cjs",
    );
    if (existsSync(candidate)) {
      return candidate;
    }
    current = path.dirname(current);
  }
  return undefined;
}

/**
 * Per-target wiring for the formatter-idempotency guard (issue #238): how to detect the language's
 * default formatter and how to run it over a copied tree. Declarative target metadata (status,
 * measured drift, deferral reasons) lives in {@link IDEMPOTENCY_TARGETS}; only the impure execution
 * is kept here so the guard's decision logic stays unit-testable.
 */
export const IDEMPOTENCY_WIRING = {
  go: {
    toolAvailable: () => commandExists("gofmt"),
    // Mirror the Go driver's pipeline (gofmt then goimports) so a future locked measurement is
    // meaningful. goimports is optional in the driver, so only run it when present.
    formatCopy: (dir) => {
      execFileSync("gofmt", ["-w", dir], { stdio: "pipe" });
      if (commandExists("goimports")) {
        execFileSync("goimports", ["-w", dir], { stdio: "pipe" });
      }
    },
  },
  typescript: {
    toolAvailable: () => Boolean(resolvePrettierCli()),
    formatCopy: (dir) => runPrettierOverTree(dir),
  },
  "typescript-zod": {
    toolAvailable: () => Boolean(resolvePrettierCli()),
    formatCopy: (dir) => runPrettierOverTree(dir),
  },
  python: {
    toolAvailable: () => commandExists("uv"),
    formatCopy: (dir) => runRuffFormatOverTree(dir),
  },
  python_pydantic: {
    toolAvailable: () => commandExists("uv"),
    formatCopy: (dir) => runRuffFormatOverTree(dir),
  },
  rust: {
    toolAvailable: () => commandExists("rustfmt"),
    formatCopy: (dir) => runRustfmtOverTree(dir),
  },
  "rust-serde": {
    toolAvailable: () => commandExists("rustfmt"),
    formatCopy: (dir) => runRustfmtOverTree(dir),
  },
  swift: {
    toolAvailable: () => commandExists("swift-format"),
    formatCopy: (dir) => runSwiftFormatOverTree(dir),
  },
  "swift-codable": {
    toolAvailable: () => commandExists("swift-format"),
    formatCopy: (dir) => runSwiftFormatOverTree(dir),
  },
  csharp: {
    toolAvailable: () => commandExists("dotnet"),
    // dotnet format runs against a project rather than a loose file tree; the gap is unmeasured
    // (target.measurable === false), so no runner is wired.
  },
  java: {
    toolAvailable: () => commandExists("google-java-format"),
    formatCopy: (dir) => runGoogleJavaFormatOverTree(dir),
  },
  "java-jackson": {
    toolAvailable: () => commandExists("google-java-format"),
    formatCopy: (dir) => runGoogleJavaFormatOverTree(dir),
  },
};

export function runPrettierOverTree(dir) {
  const prettier = resolvePrettierCli();
  execFileSync(process.execPath, [prettier, "--write", `${dir}/**/*.ts`], {
    cwd: packageRoot,
    stdio: "pipe",
  });
}

export function runRuffFormatOverTree(dir) {
  execFileSync(
    "uv",
    ["run", "--python", "3.12", "--with", "ruff", "ruff", "format", dir],
    { cwd: packageRoot, stdio: "pipe" },
  );
}

export function runRustfmtOverTree(dir) {
  for (const file of walkFiles(dir, (f) => f.endsWith(".rs"))) {
    execFileSync("rustfmt", ["--edition", "2021", file], { stdio: "pipe" });
  }
}

export function runSwiftFormatOverTree(dir) {
  execFileSync("swift-format", ["format", "--in-place", "--recursive", dir], {
    stdio: "pipe",
    env: swiftToolchainEnv(),
  });
}

export function runGoogleJavaFormatOverTree(dir) {
  const files = walkFiles(dir, (f) => f.endsWith(".java"));
  if (files.length === 0) return;
  execFileSync("google-java-format", ["--replace", ...files], {
    stdio: "pipe",
  });
}

/**
 * Measure formatter drift by copying the emitted native tree, running the default formatter over
 * the copy, and diffing every file. The copy is discarded so the committed golden tree is never
 * mutated. Returns `{ total, changed, changedFiles }`.
 */
export function measureFormatterDrift(sourceDir, extension, formatCopy) {
  const copyDir = mkdtempSync(path.join(tmpdir(), "typra-idempotency-"));
  // Exclude build scratch and the consumer-authored vector adapters: neither is
  // emitter output, so neither should count toward native formatter drift.
  const ignore = new Set([
    ...scratchEntries,
    ...AUTHORED_VECTOR_ADAPTER_SEGMENTS,
  ]);
  try {
    cpSync(sourceDir, copyDir, {
      recursive: true,
      filter: (source) => !ignore.has(path.basename(source)),
    });
    formatCopy(copyDir);
    return computeTreeDiff({
      sourceDir,
      formattedDir: copyDir,
      extension,
      walkFiles,
      readFileSync,
      existsSync,
      ignoreSegments: ignore,
    });
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }
}

export const MEASURE_DEFERRED_IDEMPOTENCY =
  process.env.TYPRA_IDEMPOTENCY_MEASURE === "1";

/**
 * Run the formatter-idempotency guard for a single target (issue #238). `locked` targets assert a
 * byte-level no-op under the default formatter and fail on drift; `deferred` targets record a
 * documented skipped-lock. Both skip cleanly when the formatter binary is absent.
 */
export function runIdempotencyGuard(target, context) {
  const sourceDir = path.join(generatedRoot, target.dir);
  const sourceFiles = walkFiles(sourceDir, (file) =>
    file.endsWith(target.extension),
  );
  if (sourceFiles.length === 0) {
    fail(
      `Idempotency guard: no generated ${target.dir} ${target.extension} files found to check.`,
    );
    return;
  }

  const wiring = IDEMPOTENCY_WIRING[target.id];
  const toolAvailable = wiring.toolAvailable();
  const canMeasure =
    target.measurable !== false &&
    toolAvailable &&
    (target.status === "locked" || MEASURE_DEFERRED_IDEMPOTENCY);

  let drift = null;
  if (canMeasure) {
    try {
      drift = measureFormatterDrift(
        sourceDir,
        target.extension,
        wiring.formatCopy,
      );
    } catch (error) {
      const message = String(error?.message ?? error).split("\n")[0];
      if (target.status === "locked") {
        fail(
          `Idempotency guard: could not run ${target.tool} over generated ${target.dir}: ${message}`,
        );
        return;
      }
      console.warn(
        `Warning: idempotency drift for ${target.id} could not be measured: ${message}`,
      );
    }
  }

  const outcome = decideIdempotencyOutcome({
    status: target.status,
    toolAvailable,
    drift,
  });

  if (outcome.action === "fail") {
    const preview = drift.changedFiles
      .slice(0, 20)
      .map((file) => `  ${file}`)
      .join("\n");
    fail(
      `Idempotency guard: ${target.tool} rewrites ${drift.changed}/${drift.total} generated ` +
        `${target.dir} files, so native (format:false) output is not formatter-idempotent ` +
        `(format:true and format:false disagree):\n${preview}` +
        (drift.changed > 20 ? `\n  ... +${drift.changed - 20} more` : ""),
    );
    return;
  }

  if (outcome.action === "skip") {
    if (target.status === "deferred") {
      const measured = drift
        ? `${target.tool} rewrites ${drift.changed}/${drift.total} files`
        : `${target.tool} ${toolAvailable ? `drift ~${target.native}` : "unavailable"}`;
      console.warn(
        `Warning: idempotency deferred for ${target.id} (${measured}). ${target.reason}`,
      );
    }
    context.skip(outcome.reason);
    return;
  }
  // outcome.action === "pass": the locked invariant held.
}
