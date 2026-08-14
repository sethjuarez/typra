import {
  EmitContext,
  Program,
  emitFile,
  resolvePath,
} from "@typespec/compiler";
import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, relative, resolve } from "path";
import { TypraEmitterOptions } from "../lib.js";
import { globToRegExp } from "../path-patterns.js";

export interface GeneratedManifestEntry {
  outputRoot: string;
  path: string;
  marker: boolean;
}

export interface GeneratedManifest {
  emitter: "typra-emitter";
  version: 1;
  generatedAt: string;
  files: GeneratedManifestEntry[];
}

export interface SkippedGeneratedFileEntry {
  path: string;
  reason: "empty" | "not-regenerated";
  action:
    | "none"
    | "removed-marker-owned"
    | "preserved-unmarked"
    | "preserved-editable-seam"
    | "preserved-foreign-target";
  ownership:
    | "not-present"
    | "marker-owned"
    | "unmarked-existing"
    | "editable-seam-owned"
    | "foreign-target-owned";
  status:
    | "skipped-empty"
    | "removed-stale-marker-owned"
    | "preserved-unmarked"
    | "preserved-editable-seam"
    | "preserved-foreign-target";
  nextAction: string;
}

/**
 * Marker that hand-owned, consumer-editable files carry so the cleaner can allow-list them.
 * This is deliberately distinct from the generated marker: seam files are created once and
 * then owned by the consumer, so they must never be deleted or rewritten as generated output.
 */
export const EDITABLE_SEAM_MARKER = "<typra-editable-seam>";

const EDITABLE_SEAM_PATTERN =
  /^\uFEFF?[ \t]*(?:\/\/|#|<!--)[ \t]*<typra-editable-seam>/m;

export function hasEditableSeamMarker(content: string): boolean {
  return EDITABLE_SEAM_PATTERN.test(content);
}

export interface GeneratedOutputReport {
  emitter: "typra-emitter";
  version: 1;
  generatedAt: string;
  summary: {
    emittedFiles: number;
    skippedFiles: number;
    staleMarkerOwnedRemovals: number;
    preservedUnmarkedSkippedFiles: number;
    preservedEditableSeamFiles: number;
    warnings: number;
    protectedPathTouches: number;
    hygiene: "clean" | "warnings";
  };
  generation: {
    deterministicOutput: boolean;
    rootObject: string;
    rootNamespace?: string;
    rootAlias?: string;
    emitTargets: Array<{
      type: string;
      outputDir?: string;
      testDir?: string;
      packageName?: string;
      namespace?: string;
      format?: boolean;
      enumParsing?: "case-sensitive" | "case-insensitive";
      protocolScaffolds?: "none" | "compile-only";
    }>;
    protectedPaths: string[];
    hydrationZones: string[];
  };
  emittedFiles: GeneratedManifestEntry[];
  skippedFiles: SkippedGeneratedFileEntry[];
  staleMarkerOwnedRemovals: string[];
  preservedUnmarkedSkippedFiles: string[];
  preservedEditableSeamFiles: string[];
  warnings: string[];
  hygiene: {
    lineEndings: "lf";
    finalNewline: true;
    trailingWhitespace: "trimmed";
    emptyArtifacts: "skipped-unless-allowed";
    marker: "typra-emitter";
  };
  protectedPathTouches: {
    status: "requires-verifier-baseline";
    configuredPatterns: string[];
    matchedFiles: string[];
    guidance: string;
  };
  formatter: {
    status: "not-recorded";
    note: string;
  };
  cleanup: {
    status: "safe-noop" | "review-recommended";
    suggestions: string[];
  };
  driftGuidance: {
    updateBaselineWhen: string;
    fixGenerationWhen: string;
    metadataToCompare: string[];
    optionDriftSignals: string[];
    versionDriftSignals: string[];
  };
}

const generatedFilesByProgram = new WeakMap<
  Program,
  Map<string, GeneratedManifestEntry>
>();
const skippedFilesByProgram = new WeakMap<
  Program,
  Map<string, SkippedGeneratedFileEntry>
>();
const warningsByProgram = new WeakMap<Program, Set<string>>();
const DETERMINISTIC_GENERATED_AT = "1970-01-01T00:00:00.000Z";

export async function emitGeneratedFile(
  context: EmitContext<TypraEmitterOptions>,
  filePath: string,
  content: string,
  options: { marker?: boolean; outputRoot?: string; allowEmpty?: boolean } = {},
): Promise<void> {
  const marker = options.marker ?? shouldMark(filePath);
  const normalizedContent = normalizeGeneratedContent(content, {
    allowEmpty: options.allowEmpty,
  });
  if (!normalizedContent && !options.allowEmpty) {
    const result = removeSkippedGeneratedFile(filePath);
    recordSkippedFile(context.program, filePath, result.action);
    if (result.warning) {
      recordWarning(context.program, result.warning);
    }
    return;
  }

  const finalContent = marker
    ? addMarker(filePath, normalizedContent)
    : normalizedContent;
  recordGeneratedFile(context.program, filePath, marker, options.outputRoot);

  await emitFile(context.program, {
    path: filePath,
    content: finalContent,
  });
}

export function manifestPath(
  context: EmitContext<TypraEmitterOptions>,
): string {
  return resolvePath(
    context.emitterOutputDir,
    ".typra-generated",
    "manifest.json",
  );
}

/**
 * The output the current run produced, used to scope stale-file reconciliation. `paths` are the
 * files emitted this run; `roots` are the output roots those files were emitted into. Pruning is
 * confined to `roots` so a run scoped to a subset of targets never reconciles — and never deletes
 * — files owned by a target it did not emit.
 */
export interface CurrentRunOutputs {
  paths: Set<string>;
  roots: Set<string>;
}

/**
 * Delete files a previous run generated that this run no longer produces.
 *
 * When a type is renamed or removed its generated source stops being emitted, but the file
 * left on disk from the previous run keeps compiling and keeps running — a generated test for
 * a deleted type becomes a phantom failure in the consumer that reads as an emitter
 * regression. Nothing else can notice this: a run only knows what it emitted, so the previous
 * run's manifest is the only record of what used to exist.
 *
 * Ownership is deliberately conservative and mirrors `removeSkippedGeneratedFile`: a file is
 * removed only when the previous manifest records that Typra marked it, it still carries the
 * generated marker on disk, and it is not an editable seam. Anything the consumer has taken
 * ownership of is preserved and reported instead of deleted.
 *
 * Must run before the new manifest is written, since it reads the previous one.
 */
export function pruneStaleGeneratedFiles(
  context: EmitContext<TypraEmitterOptions>,
): void {
  const entries = buildGeneratedManifest(context).files;
  pruneStaleGeneratedFilesAgainst(context, {
    paths: new Set(entries.map((entry) => entry.path)),
    roots: new Set(entries.map((entry) => entry.outputRoot)),
  });
}

/**
 * True when two paths resolve to the same file on disk. On a case-insensitive filesystem this
 * recognizes paths that differ only in case as the same physical file; on a case-sensitive one
 * differently-cased paths resolve distinctly (or one does not exist) and this returns false.
 */
function isSameFileOnDisk(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * Core of {@link pruneStaleGeneratedFiles}, with the current run's output passed in explicitly
 * so the ownership rules can be exercised directly.
 */
export function pruneStaleGeneratedFilesAgainst(
  context: EmitContext<TypraEmitterOptions>,
  current: CurrentRunOutputs,
): void {
  const previous = readPreviousManifest(context);
  if (!previous) return;

  // Case-insensitive-filesystem reconciliation for case-only renames. A case-insensitive
  // filesystem (macOS, Windows) resolves paths that differ only in case to the same physical
  // file, so a target that used to emit `pipeline/Foo.cs` and now emits `Pipeline/Foo.cs`
  // records the old case in the previous manifest and the new case in this run. This index
  // lets the loop recognize that collision; see the guard below.
  const currentByLowerPath = new Map<string, string>();
  for (const currentPath of current.paths) {
    currentByLowerPath.set(currentPath.toLowerCase(), currentPath);
  }

  for (const entry of previous.files) {
    // Only files Typra marked are candidates; unmarked output was never claimed.
    if (!entry.marker) continue;
    if (current.paths.has(entry.path)) continue;

    const absolutePath = resolve(entry.path);
    if (!existsSync(absolutePath)) continue;

    // Case-only rename guard. On a case-insensitive filesystem the previous manifest's entry
    // and this run's differently-cased output name the same file on disk, so the exact-string
    // check above misses and this loop would unlink the file the run just wrote. Preserve it
    // when a case-insensitive current-path match resolves to the same physical file. On a
    // case-sensitive filesystem the two are genuinely distinct files, their real paths differ
    // (or the current one does not exist), and the stale entry is still pruned.
    const caseVariant = currentByLowerPath.get(entry.path.toLowerCase());
    if (
      caseVariant !== undefined &&
      caseVariant !== entry.path &&
      isSameFileOnDisk(absolutePath, resolve(caseVariant))
    ) {
      continue;
    }

    // Cross-target collateral-deletion guard. When several emit-targets share one
    // emitter-output-dir they also share one manifest, so a run scoped to a subset of those
    // targets sees every sibling target's file as "not emitted this run". Deleting on that
    // basis silently wipes targets the author never intended to touch. A file is only stale
    // relative to the output roots this run actually emitted into; anything owned by a target
    // absent from this run is preserved and reported, never deleted.
    if (!current.roots.has(entry.outputRoot)) {
      const warning = `Warning: preserved generated file owned by a target not in this run (output root ${entry.outputRoot}); scoped emit did not reconcile it: ${entry.path}`;
      console.warn(warning);
      recordWarning(context.program, warning);
      recordSkippedFile(
        context.program,
        absolutePath,
        "preserved-foreign-target",
        "not-regenerated",
      );
      continue;
    }

    const existingContent = readFileSync(absolutePath, "utf8");

    if (hasEditableSeamMarker(existingContent)) {
      recordSkippedFile(
        context.program,
        absolutePath,
        "preserved-editable-seam",
        "not-regenerated",
      );
      continue;
    }

    // The consumer replaced the file since it was generated, so Typra no longer owns it.
    if (!existingContent.includes("<auto-generated by typra-emitter>")) {
      const warning = `Warning: stale generated file is no longer produced but was preserved because it is unmarked: ${entry.path}`;
      console.warn(warning);
      recordWarning(context.program, warning);
      recordSkippedFile(
        context.program,
        absolutePath,
        "preserved-unmarked",
        "not-regenerated",
      );
      continue;
    }

    unlinkSync(absolutePath);
    recordSkippedFile(
      context.program,
      absolutePath,
      "removed-marker-owned",
      "not-regenerated",
    );
  }
}

function readPreviousManifest(
  context: EmitContext<TypraEmitterOptions>,
): GeneratedManifest | undefined {
  const previousPath = manifestPath(context);
  if (!existsSync(previousPath)) return undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(previousPath, "utf8"),
    ) as GeneratedManifest;
    return Array.isArray(parsed?.files) ? parsed : undefined;
  } catch {
    // A manifest we cannot parse tells us nothing about ownership, so delete nothing.
    return undefined;
  }
}

export async function emitGeneratedManifest(
  context: EmitContext<TypraEmitterOptions>,
): Promise<GeneratedManifest> {
  const manifest = buildGeneratedManifest(context);
  await emitFile(context.program, {
    path: manifestPath(context),
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });
  return manifest;
}

export async function emitGeneratedOutputReport(
  context: EmitContext<TypraEmitterOptions>,
  manifest: GeneratedManifest,
): Promise<void> {
  const report = buildGeneratedOutputReport(context, manifest);
  await emitFile(context.program, {
    path: resolvePath(
      context.emitterOutputDir,
      ".typra-generated",
      "report.json",
    ),
    content: `${JSON.stringify(report, null, 2)}\n`,
  });
}

export function buildGeneratedManifest(
  context: EmitContext<TypraEmitterOptions>,
): GeneratedManifest {
  const entries = getGeneratedFileEntries(context.program);
  const manifest: GeneratedManifest = {
    emitter: "typra-emitter",
    version: 1,
    generatedAt: context.options["deterministic-output"]
      ? DETERMINISTIC_GENERATED_AT
      : new Date().toISOString(),
    files: entries,
  };

  return manifest;
}

export function buildGeneratedOutputReport(
  context: EmitContext<TypraEmitterOptions>,
  manifest: GeneratedManifest,
): GeneratedOutputReport {
  const skippedFiles = getSkippedFileEntries(context.program);
  const warnings = getWarnings(context.program);
  const staleMarkerOwnedRemovals = skippedFiles
    .filter((entry) => entry.action === "removed-marker-owned")
    .map((entry) => entry.path);
  const preservedUnmarkedSkippedFiles = skippedFiles
    .filter((entry) => entry.action === "preserved-unmarked")
    .map((entry) => entry.path);
  const preservedEditableSeamFiles = skippedFiles
    .filter((entry) => entry.action === "preserved-editable-seam")
    .map((entry) => entry.path);
  const preservedForeignTargetFiles = skippedFiles
    .filter((entry) => entry.action === "preserved-foreign-target")
    .map((entry) => entry.path);
  const protectedPathPatterns = [
    ...(context.options["protected-paths"] ?? []),
  ].sort((left, right) => left.localeCompare(right));
  const protectedPathTouches = findProtectedPathTouches(
    manifest.files,
    protectedPathPatterns,
  );
  const cleanupSuggestions = buildCleanupSuggestions(
    staleMarkerOwnedRemovals,
    preservedUnmarkedSkippedFiles,
    preservedForeignTargetFiles,
  );
  return {
    emitter: "typra-emitter",
    version: 1,
    generatedAt: manifest.generatedAt,
    summary: {
      emittedFiles: manifest.files.length,
      skippedFiles: skippedFiles.length,
      staleMarkerOwnedRemovals: staleMarkerOwnedRemovals.length,
      preservedUnmarkedSkippedFiles: preservedUnmarkedSkippedFiles.length,
      preservedEditableSeamFiles: preservedEditableSeamFiles.length,
      warnings: warnings.length,
      protectedPathTouches: protectedPathTouches.length,
      hygiene: warnings.length === 0 ? "clean" : "warnings",
    },
    generation: {
      deterministicOutput: context.options["deterministic-output"] === true,
      rootObject: context.options["root-object"],
      ...(context.options["root-namespace"] && {
        rootNamespace: context.options["root-namespace"],
      }),
      ...(context.options["root-alias"] && {
        rootAlias: context.options["root-alias"],
      }),
      emitTargets: (context.options["emit-targets"] ?? [])
        .map((target) => ({
          type: target.type,
          ...(target["output-dir"] && {
            outputDir: normalizePath(target["output-dir"]),
          }),
          ...(target["test-dir"] && {
            testDir: normalizePath(target["test-dir"]),
          }),
          ...(target["package-name"] && {
            packageName: target["package-name"],
          }),
          ...(target.namespace && { namespace: target.namespace }),
          ...(target.format !== undefined && { format: target.format }),
          ...(target["enum-parsing"] && {
            enumParsing: target["enum-parsing"],
          }),
          ...(target["protocol-scaffolds"] && {
            protocolScaffolds: target["protocol-scaffolds"],
          }),
          ...(target["native-serialization"] && {
            nativeSerialization: target["native-serialization"],
          }),
        }))
        .sort((left, right) =>
          `${left.type}:${left.outputDir ?? ""}`.localeCompare(
            `${right.type}:${right.outputDir ?? ""}`,
          ),
        ),
      protectedPaths: protectedPathPatterns,
      hydrationZones: [...(context.options["hydration-zones"] ?? [])].sort(
        (left, right) => left.localeCompare(right),
      ),
    },
    emittedFiles: manifest.files,
    skippedFiles,
    staleMarkerOwnedRemovals,
    preservedUnmarkedSkippedFiles,
    preservedEditableSeamFiles,
    warnings,
    hygiene: {
      lineEndings: "lf",
      finalNewline: true,
      trailingWhitespace: "trimmed",
      emptyArtifacts: "skipped-unless-allowed",
      marker: "typra-emitter",
    },
    protectedPathTouches: {
      status: "requires-verifier-baseline",
      configuredPatterns: protectedPathPatterns,
      matchedFiles: protectedPathTouches,
      guidance:
        protectedPathTouches.length === 0
          ? "No emitted files matched configured protected paths in this generation."
          : "Generated output matched configured protected paths; run typra-verify against the committed baseline before accepting these changes.",
    },
    formatter: {
      status: "not-recorded",
      note: "Target formatters run in language drivers; per-file formatter status is not recorded in generated metadata yet.",
    },
    cleanup: {
      status:
        cleanupSuggestions.length === 0 ? "safe-noop" : "review-recommended",
      suggestions: cleanupSuggestions,
    },
    driftGuidance: {
      updateBaselineWhen:
        "Generated runtime output and metadata drift are expected and reviewed.",
      fixGenerationWhen:
        "Verifier reports blocking failures, protected-path touches are unexpected, or preserved unmarked skipped files should remain hand-authored.",
      metadataToCompare: [
        ".typra-generated/manifest.json",
        ".typra-generated/export-surfaces.json",
        ".typra-generated/hydration-seams.json",
        ".typra-generated/vectors.json",
        ".typra-generated/report.json",
        "json-ast/model.json",
      ],
      optionDriftSignals: [
        "root-object",
        "root-namespace",
        "root-alias",
        "emit-targets",
        "protected-paths",
        "hydration-zones",
        "deterministic-output",
        "native-serialization",
      ],
      versionDriftSignals: [
        "@typra/emitter",
        "@typespec/compiler",
        "@typespec/json-schema",
      ],
    },
  };
}

function recordGeneratedFile(
  program: Program,
  filePath: string,
  marker: boolean,
  outputRoot?: string,
): void {
  let entries = generatedFilesByProgram.get(program);
  if (!entries) {
    entries = new Map<string, GeneratedManifestEntry>();
    generatedFilesByProgram.set(program, entries);
  }
  entries.set(normalizePath(filePath), {
    outputRoot: normalizePath(outputRoot || dirname(filePath)),
    path: normalizePath(filePath),
    marker,
  });
}

function recordSkippedFile(
  program: Program,
  filePath: string,
  action: SkippedGeneratedFileEntry["action"],
  reason: SkippedGeneratedFileEntry["reason"] = "empty",
): void {
  let entries = skippedFilesByProgram.get(program);
  if (!entries) {
    entries = new Map<string, SkippedGeneratedFileEntry>();
    skippedFilesByProgram.set(program, entries);
  }
  entries.set(normalizePath(filePath), {
    path: normalizePath(filePath),
    reason,
    action,
    ...skippedFileGuidance(action, reason),
  });
}

function recordWarning(program: Program, warning: string): void {
  let warnings = warningsByProgram.get(program);
  if (!warnings) {
    warnings = new Set<string>();
    warningsByProgram.set(program, warnings);
  }
  warnings.add(warning);
}

function getGeneratedFileEntries(program: Program): GeneratedManifestEntry[] {
  return [...(generatedFilesByProgram.get(program)?.values() ?? [])].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
}

function getSkippedFileEntries(program: Program): SkippedGeneratedFileEntry[] {
  return [...(skippedFilesByProgram.get(program)?.values() ?? [])].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
}

function getWarnings(program: Program): string[] {
  return [...(warningsByProgram.get(program)?.values() ?? [])].sort(
    (left, right) => left.localeCompare(right),
  );
}

function shouldMark(filePath: string): boolean {
  if (filePath.endsWith("py.typed")) {
    return false;
  }
  return !filePath.endsWith(".json");
}

function addMarker(filePath: string, content: string): string {
  const marker = markerFor(filePath);
  if (filePath.endsWith(".md") && content.startsWith("---\n")) {
    return addMarkdownMarkerAfterFrontmatter(content, marker);
  }
  return content.startsWith(marker) ? content : `${marker}\n${content}`;
}

function addMarkdownMarkerAfterFrontmatter(
  content: string,
  marker: string,
): string {
  const closingDelimiter = "\n---\n";
  const closingIndex = content.indexOf(closingDelimiter, 4);
  if (closingIndex < 0) {
    return content.startsWith(marker) ? content : `${marker}\n${content}`;
  }

  const markerIndex = closingIndex + closingDelimiter.length;
  const beforeMarker = content.slice(0, markerIndex);
  const afterMarker = content.slice(markerIndex);
  return afterMarker.startsWith(marker)
    ? content
    : `${beforeMarker}${marker}\n${afterMarker}`;
}

function markerFor(filePath: string): string {
  if (filePath.endsWith(".md")) {
    return "<!-- <auto-generated by typra-emitter> -->";
  }
  if (
    filePath.endsWith(".py") ||
    filePath.endsWith(".txt") ||
    filePath.endsWith(".yaml") ||
    filePath.endsWith(".yml")
  ) {
    return "# <auto-generated by typra-emitter>";
  }
  return "// <auto-generated by typra-emitter>";
}

function normalizePath(filePath: string): string {
  return relative(process.cwd(), resolve(filePath)).replace(/\\/g, "/");
}

function normalizeGeneratedContent(
  content: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const normalizedLines = content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  while (
    normalizedLines.length > 0 &&
    normalizedLines[normalizedLines.length - 1] === ""
  ) {
    normalizedLines.pop();
  }

  if (normalizedLines.length === 0) {
    return options.allowEmpty ? "" : "";
  }

  return `${normalizedLines.join("\n")}\n`;
}

function removeSkippedGeneratedFile(filePath: string): {
  action: SkippedGeneratedFileEntry["action"];
  warning?: string;
} {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    return { action: "none" };
  }

  const existingContent = readFileSync(absolutePath, "utf8");

  // Editable seams are consumer-owned by contract. Allow-list them before any other
  // ownership check so they are never deleted and never raise an ambiguous warning.
  if (hasEditableSeamMarker(existingContent)) {
    return { action: "preserved-editable-seam" };
  }

  if (!existingContent.includes("<auto-generated by typra-emitter>")) {
    const warning = `Warning: skipped empty generated output but preserved unmarked file: ${normalizePath(filePath)}`;
    console.warn(warning);
    return { action: "preserved-unmarked", warning };
  }

  unlinkSync(absolutePath);
  return { action: "removed-marker-owned" };
}

function skippedFileGuidance(
  action: SkippedGeneratedFileEntry["action"],
  reason: SkippedGeneratedFileEntry["reason"] = "empty",
): Omit<SkippedGeneratedFileEntry, "path" | "reason" | "action"> {
  if (action === "removed-marker-owned") {
    return {
      ownership: "marker-owned",
      status: "removed-stale-marker-owned",
      nextAction:
        reason === "not-regenerated"
          ? "Review the deletion; this file was generated by a previous run but is no longer produced, so its source type was renamed or removed."
          : "Review the deletion; accept the baseline when this empty generated artifact is expected to disappear.",
    };
  }
  if (action === "preserved-editable-seam") {
    return {
      ownership: "editable-seam-owned",
      status: "preserved-editable-seam",
      nextAction:
        "No action needed; this file carries the Typra editable-seam marker and is owned by the consumer.",
    };
  }
  if (action === "preserved-foreign-target") {
    return {
      ownership: "foreign-target-owned",
      status: "preserved-foreign-target",
      nextAction:
        "No action needed; this file belongs to an emit target not included in this run. It was preserved because the run was scoped to a subset of targets sharing the emitter output dir. Re-run with the full emit-targets set to reconcile it.",
    };
  }
  if (action === "preserved-unmarked") {
    return {
      ownership: "unmarked-existing",
      status: "preserved-unmarked",
      nextAction:
        reason === "not-regenerated"
          ? "Review the file manually; Typra no longer generates it but will not delete a file it does not own."
          : "Review the file manually; Typra skipped empty output but preserved the unmarked existing file.",
    };
  }
  return {
    ownership: "not-present",
    status: "skipped-empty",
    nextAction:
      "No action needed unless this empty artifact should be emitted with allowEmpty.",
  };
}

function findProtectedPathTouches(
  files: GeneratedManifestEntry[],
  patterns: string[],
): string[] {
  const matchers = patterns.map((pattern) =>
    globToRegExp(normalizePath(pattern)),
  );
  if (matchers.length === 0) {
    return [];
  }
  return files
    .map((entry) => entry.path)
    .filter((filePath) => matchers.some((matcher) => matcher.test(filePath)))
    .sort((left, right) => left.localeCompare(right));
}

function buildCleanupSuggestions(
  staleMarkerOwnedRemovals: string[],
  preservedUnmarkedSkippedFiles: string[],
  preservedForeignTargetFiles: string[] = [],
): string[] {
  const suggestions: string[] = [];
  if (staleMarkerOwnedRemovals.length > 0) {
    suggestions.push(
      "Review removed marker-owned files and accept the generated baseline if the removal is expected.",
    );
  }
  if (preservedUnmarkedSkippedFiles.length > 0) {
    suggestions.push(
      "Inspect preserved unmarked files before accepting drift; Typra will not delete files it does not own.",
    );
  }
  if (preservedForeignTargetFiles.length > 0) {
    suggestions.push(
      "This run was scoped to a subset of emit-targets sharing the emitter output dir; files owned by the absent targets were preserved, not reconciled. Re-run with the full emit-targets set to reconcile them.",
    );
  }
  return suggestions;
}
