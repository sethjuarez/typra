import {
  AUTHORED_VECTOR_ADAPTER_SEGMENTS,
  CSHARP_TARGET_FRAMEWORK,
  buildCSharpValidationStubs,
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
  unlinkSync,
  walkFiles,
  writeFileSync,
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
    // dotnet format has no loose-file-tree mode (unlike gofmt/ruff/prettier): it needs a real
    // project to load the compilation. The runner scaffolds a throwaway net10.0 project over the
    // copied tree (mirroring the csharp.build scaffold) and runs the same plain `dotnet format` the
    // production driver runs, then removes the scaffold before the diff. bin/obj are scratch-ignored
    // and the scaffolded Stubs.cs is deleted, so only emitter .cs files are diffed. See
    // runDotnetFormatOverTree for why --include-generated is intentionally omitted.
    formatCopy: (dir) => runDotnetFormatOverTree(dir),
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
 * Run `dotnet format` over a copied C# tree exactly as the production C# driver does
 * (`languages/csharp/driver.ts` `formatCSharpFiles` → `dotnet format <project>`), so the guard
 * measures the same no-op the driver would apply when `format:true`. dotnet format has no loose-file
 * mode, so we scaffold a throwaway net10.0 test project (globbing every .cs so the models AND generated
 * tests load) plus the same compile stubs the csharp.build stage uses, restore, format in place, then
 * delete the scaffold.
 *
 * IMPORTANT: do NOT pass `--include-generated`. Every emitted file starts with `// <auto-generated by
 * typra-emitter>`, so Roslyn/dotnet format treats them as generated and skips them by default — which
 * is precisely why native (`format:false`) output is byte-stable under the formatter: the production
 * driver runs the same plain `dotnet format`, so `format:true` leaves the generated files untouched
 * too. (With `--include-generated` the formatter reflows ~84 of them; the guard must mirror the driver,
 * not out-format it, or it would fail a lock that production actually honours.) The lock therefore
 * enforces the real invariant — if a future change dropped the `<auto-generated>` header, both the
 * driver and this guard would start reflowing the tree and the drift would surface here.
 *
 * The consumer-authored VectorAdapters.cs is excluded from the copy (AUTHORED_VECTOR_ADAPTER_SEGMENTS),
 * so re-provide it from the committed tree while formatting so the compilation resolves, then drop it
 * again — it must not count toward emitter drift. Package versions mirror
 * scripts/fixtures/targets/csharp.mjs; keep them in sync.
 */
export function runDotnetFormatOverTree(dir) {
  const csprojPath = path.join(dir, "TypraIdempotencyProbe.csproj");
  const stubsPath = path.join(dir, "TypraIdempotencyProbe.Stubs.cs");
  const csproj = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    `    <TargetFramework>${CSHARP_TARGET_FRAMEWORK}</TargetFramework>`,
    "    <Nullable>enable</Nullable>",
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
  ].join("\n");

  // Restore the consumer-authored vector adapters into the copy so the compilation resolves.
  const restoredAdapters = [];
  const adapterSource = path.join(generatedRoot, "csharp");
  for (const segment of AUTHORED_VECTOR_ADAPTER_SEGMENTS) {
    if (!segment.endsWith(".cs")) continue;
    for (const original of walkFiles(
      adapterSource,
      (f) => path.basename(f) === segment,
    )) {
      const rel = path.relative(adapterSource, original);
      const dest = path.join(dir, rel);
      if (existsSync(dest)) continue;
      cpSync(original, dest);
      restoredAdapters.push(dest);
    }
  }

  writeFileSync(csprojPath, csproj);
  writeFileSync(stubsPath, buildCSharpValidationStubs(dir));
  try {
    execFileSync("dotnet", ["format", csprojPath, "--verbosity", "quiet"], {
      cwd: dir,
      stdio: "pipe",
    });
  } finally {
    for (const scaffold of [csprojPath, stubsPath, ...restoredAdapters]) {
      if (existsSync(scaffold)) unlinkSync(scaffold);
    }
  }
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
