import path from "node:path";

import { TOOLCHAIN_UNAVAILABLE } from "./validation-execution.mjs";

/**
 * Formatter-idempotency guard (issue #238).
 *
 * When `emitTarget.format !== false` (the default) each language driver shells out to an external
 * formatter (`gofmt`, `swift-format`, `rustfmt`/`cargo fmt`, `ruff`, `prettier`, `dotnet format`,
 * `google-java-format`) whose *presence* changes the emitted bytes — same input + same emitter
 * version produces different output depending on host tooling. #237 made that drift *attributable*
 * (a loud warning instead of a silent `catch {}`); this guard closes the reproducibility hole
 * itself by proving native (`format:false`) output is a byte-level no-op under the default
 * formatter, so `format:true` and `format:false` agree.
 *
 * The guard copies the emitted native tree, runs the language's default formatter over the copy,
 * and asserts zero diff. It skips when the formatter binary is absent so toolchain-less CI stays
 * green; the invariant locks on dev machines and formatter-equipped CI.
 *
 * A `locked` target must be idempotent today (its native output is already formatter-clean and the
 * guard fails on any drift). A `deferred` target is a *documented skipped-lock*: the pretty-printer
 * gap is real and not yet closed (see the per-target `reason`), so the guard records the deferral
 * rather than forcing a fragile one-shot template rewrite. Future language ports inherit the guard
 * by default so this class of latent determinism defect is caught at the source.
 *
 * NOTE: no runtime is `locked` today — an audit of native (`format:false`) output found every
 * target drifts under its default formatter (Go included: it ships `format:true`, and its native
 * output rewrites ~118/144 files under gofmt+goimports). The guard is therefore the enforcement
 * scaffold plus the audit of record; promoting a language to `locked` once its templates match its
 * formatter is a one-line status flip that then fails on any regression. A `locked` target must be
 * `measurable` (see `assertLockedTargetsMeasurable`): the harness can only enforce the invariant on
 * targets whose native drift it can actually measure.
 */

export const IDEMPOTENCY_DEFERRED = "idempotency-deferred";

/**
 * The reproducibility invariant is measured empirically. `native` records the last observed drift
 * (formatter-changed files / total files) so a deferred target's documented gap is auditable and a
 * regression that *widens* it — or a fix that closes it — is visible in review. Set the env flag
 * `TYPRA_IDEMPOTENCY_MEASURE=1` to re-measure deferred targets live.
 */
export const IDEMPOTENCY_TARGETS = [
  {
    id: "go",
    stageId: "idempotency.go",
    dir: "go",
    extension: ".go",
    tool: "gofmt",
    status: "deferred",
    measurable: false,
    native: "118/144",
    reason:
      "Go ships format:true, so its committed fixture tree is already gofmt-formatted; the guard " +
      "cannot measure native idempotency from it. Emitting a format:false Go tree and running the " +
      "driver pipeline (gofmt, then goimports) rewrites ~118/144 files, so native Go is not yet " +
      "formatter-idempotent. Aligning the templates — and reproducing goimports' import grouping — " +
      "is deferred (#238).",
  },
  {
    id: "typescript",
    stageId: "idempotency.typescript",
    dir: "typescript",
    extension: ".ts",
    tool: "prettier",
    status: "locked",
  },
  {
    id: "typescript-zod",
    stageId: "idempotency.typescript-zod",
    dir: "typescript-zod",
    extension: ".ts",
    tool: "prettier",
    status: "deferred",
    native: "59/148",
    reason:
      "the deterministic native reflow closes single-line drift (imports, quotes, trailing commas, " +
      "long-statement wrapping) but prettier still reflows the emitter's multi-line zod schema " +
      "chains — member-chain breaking of `z.object({…}).passthrough()`, single-array-argument " +
      "hugging of `z.union([…])`, and the `z.any().transform(…).pipe(…)` / discriminated-union " +
      "`.refine(…)` layout; reproducing that pretty-printer for the zod schema emit is deferred (#238).",
  },
  {
    id: "python",
    stageId: "idempotency.python",
    dir: "python",
    extension: ".py",
    tool: "ruff format",
    status: "locked",
  },
  {
    id: "python_pydantic",
    stageId: "idempotency.python_pydantic",
    dir: "python_pydantic",
    extension: ".py",
    tool: "ruff format",
    status: "locked",
  },
  {
    id: "rust",
    stageId: "idempotency.rust",
    dir: "rust",
    extension: ".rs",
    tool: "rustfmt",
    status: "deferred",
    native: "129/129",
    reason:
      "rustfmt reflows the emitter's long signatures, derive lists, and match arms; reproducing " +
      "its pretty-printer in the templates is deferred (#238).",
  },
  {
    id: "rust-serde",
    stageId: "idempotency.rust-serde",
    dir: "rust-serde",
    extension: ".rs",
    tool: "rustfmt",
    status: "deferred",
    native: "129/129",
    reason:
      "rustfmt reflows the emitter's long signatures, derive lists, and match arms; reproducing " +
      "its pretty-printer in the templates is deferred (#238).",
  },
  {
    id: "swift",
    stageId: "idempotency.swift",
    dir: "swift",
    extension: ".swift",
    tool: "swift-format",
    status: "deferred",
    native: "123/126",
    reason:
      "swift-format applies 100-column line-wrapping (long signatures, switch arms, call chains, " +
      "multi-arg inits) plus multiline trailing commas that the emitter emits as single long " +
      "lines; reproducing its pretty-printer is a large change, deferred (#238).",
  },
  {
    id: "swift-codable",
    stageId: "idempotency.swift-codable",
    dir: "swift-codable",
    extension: ".swift",
    tool: "swift-format",
    status: "deferred",
    native: "123/126",
    reason:
      "swift-format applies 100-column line-wrapping plus multiline trailing commas that the " +
      "emitter emits as single long lines; reproducing its pretty-printer is deferred (#238).",
  },
  {
    id: "csharp",
    stageId: "idempotency.csharp",
    dir: "csharp",
    extension: ".cs",
    tool: "dotnet format",
    status: "deferred",
    measurable: false,
    native: "unmeasured",
    reason:
      "dotnet format runs against a project rather than a loose file tree and reflows layout; the " +
      "gap has not been measured and closing it is deferred (#238).",
  },
  {
    id: "java",
    stageId: "idempotency.java",
    dir: "java",
    extension: ".java",
    tool: "google-java-format",
    status: "deferred",
    native: "unmeasured",
    reason:
      "google-java-format reflows the emitter's layout; the gap has not been measured (the binary " +
      "is not part of the default toolchain) and closing it is deferred (#238).",
  },
  {
    id: "java-jackson",
    stageId: "idempotency.java-jackson",
    dir: "java-jackson",
    extension: ".java",
    tool: "google-java-format",
    status: "deferred",
    native: "unmeasured",
    reason:
      "google-java-format reflows the emitter's layout; the gap has not been measured (the binary " +
      "is not part of the default toolchain) and closing it is deferred (#238).",
  },
];

/**
 * Registry invariant: a `locked` target must be measurable. `decideIdempotencyOutcome` demands a
 * drift measurement before it can pass/fail a locked target, but `runIdempotencyGuard` never
 * measures a `measurable: false` target — so a locked + `measurable: false` entry would abort the
 * whole `validate:fixtures` run with an uncaught throw instead of a recorded failure. Enforce the
 * constraint at module load (and expose it for unit tests) so a bad `status: "locked"` flip fails
 * loudly and early with a clear message. See #238.
 */
export function assertLockedTargetsMeasurable(targets = IDEMPOTENCY_TARGETS) {
  for (const target of targets) {
    if (target.status === "locked" && target.measurable === false) {
      throw new Error(
        `Idempotency registry misconfigured: target "${target.id}" is locked but measurable:false. ` +
          "A locked target must be measurable so the guard can check its native output for drift.",
      );
    }
  }
}

assertLockedTargetsMeasurable();

/**
 * Compare an emitted native tree against its formatted copy, returning the per-file drift. A file
 * counts as changed when the formatter rewrote its bytes, dropped it, or created a new one. Both
 * trees are enumerated symmetrically so formatter-*added* files are caught, not just rewrites and
 * deletions, and `ignoreSegments` (e.g. build scratch dirs) is applied to both sides so an excluded
 * directory is never mistaken for a deletion.
 *
 * The filesystem primitives are injected so the core diff is pure and unit-testable without
 * reaching for the real `node:fs`.
 */
export function computeTreeDiff({
  sourceDir,
  formattedDir,
  extension,
  walkFiles,
  readFileSync,
  existsSync,
  ignoreSegments = new Set(),
}) {
  const collect = (root) => {
    const rels = [];
    for (const file of walkFiles(root, (f) => f.endsWith(extension))) {
      const rel = path.relative(root, file);
      const segments = rel.split(/[\\/]/);
      if (segments.some((segment) => ignoreSegments.has(segment))) continue;
      rels.push(rel);
    }
    return rels;
  };

  const relativePaths = new Set([
    ...collect(sourceDir),
    ...collect(formattedDir),
  ]);
  const changedFiles = [];
  for (const relativePath of relativePaths) {
    const sourceFile = path.join(sourceDir, relativePath);
    const formattedFile = path.join(formattedDir, relativePath);
    if (!existsSync(sourceFile) || !existsSync(formattedFile)) {
      changedFiles.push(relativePath);
      continue;
    }
    if (readFileSync(sourceFile, "utf8") !== readFileSync(formattedFile, "utf8")) {
      changedFiles.push(relativePath);
    }
  }
  changedFiles.sort();
  return {
    total: relativePaths.size,
    changed: changedFiles.length,
    changedFiles,
  };
}

/**
 * Decide what a single idempotency stage should do, given its declared status, whether the default
 * formatter is available, and (when measured) the observed drift. Kept pure so the locked / deferred
 * / toolchain-unavailable matrix is unit-testable in isolation from the validation harness.
 *
 * - `locked`   + no formatter        → skip (toolchain-unavailable; CI without the tool stays green)
 * - `locked`   + zero drift          → pass (the invariant holds)
 * - `locked`   + non-zero drift      → fail (native output is not formatter-idempotent)
 * - `deferred` (any tool/drift)      → skip (documented skipped-lock; see the target's `reason`)
 */
export function decideIdempotencyOutcome({ status, toolAvailable, drift }) {
  if (status === "deferred") {
    return { action: "skip", reason: IDEMPOTENCY_DEFERRED };
  }
  if (status !== "locked") {
    throw new Error(`Unknown idempotency status: ${status}`);
  }
  if (!toolAvailable) {
    return { action: "skip", reason: TOOLCHAIN_UNAVAILABLE };
  }
  if (!drift) {
    throw new Error(
      "A locked idempotency target must be measured before an outcome can be decided.",
    );
  }
  if (drift.changed > 0) {
    return { action: "fail", drift };
  }
  return { action: "pass" };
}

/** The allowed-skip reason for each idempotency stage, for the validation execution plan. */
export function idempotencyAllowedSkips() {
  const allowed = {};
  for (const target of IDEMPOTENCY_TARGETS) {
    allowed[target.stageId] =
      target.status === "locked" ? TOOLCHAIN_UNAVAILABLE : IDEMPOTENCY_DEFERRED;
  }
  return allowed;
}
