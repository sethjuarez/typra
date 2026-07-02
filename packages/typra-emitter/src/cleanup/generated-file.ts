import { EmitContext, Program, emitFile, resolvePath } from "@typespec/compiler";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, relative, resolve } from "path";
import { TypraEmitterOptions } from "../lib.js";

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
  reason: "empty";
  action: "none" | "removed-marker-owned" | "preserved-unmarked";
}

export interface GeneratedOutputReport {
  emitter: "typra-emitter";
  version: 1;
  generatedAt: string;
  emittedFiles: GeneratedManifestEntry[];
  skippedFiles: SkippedGeneratedFileEntry[];
  staleMarkerOwnedRemovals: string[];
  preservedUnmarkedSkippedFiles: string[];
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
  };
  formatter: {
    status: "not-recorded";
    note: string;
  };
}

const generatedFilesByProgram = new WeakMap<Program, Map<string, GeneratedManifestEntry>>();
const skippedFilesByProgram = new WeakMap<Program, Map<string, SkippedGeneratedFileEntry>>();
const warningsByProgram = new WeakMap<Program, Set<string>>();
const DETERMINISTIC_GENERATED_AT = "1970-01-01T00:00:00.000Z";

export async function emitGeneratedFile(
  context: EmitContext<TypraEmitterOptions>,
  filePath: string,
  content: string,
  options: { marker?: boolean; outputRoot?: string; allowEmpty?: boolean } = {},
): Promise<void> {
  const marker = options.marker ?? shouldMark(filePath);
  const normalizedContent = normalizeGeneratedContent(content, { allowEmpty: options.allowEmpty });
  if (!normalizedContent && !options.allowEmpty) {
    const result = removeSkippedGeneratedFile(filePath);
    recordSkippedFile(context.program, filePath, result.action);
    if (result.warning) {
      recordWarning(context.program, result.warning);
    }
    return;
  }

  const finalContent = marker ? addMarker(filePath, normalizedContent) : normalizedContent;
  recordGeneratedFile(context.program, filePath, marker, options.outputRoot);

  await emitFile(context.program, {
    path: filePath,
    content: finalContent,
  });
}

export async function emitGeneratedManifest(context: EmitContext<TypraEmitterOptions>): Promise<GeneratedManifest> {
  const manifest = buildGeneratedManifest(context);
  await emitFile(context.program, {
    path: resolvePath(context.emitterOutputDir, ".typra-generated", "manifest.json"),
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
    path: resolvePath(context.emitterOutputDir, ".typra-generated", "report.json"),
    content: `${JSON.stringify(report, null, 2)}\n`,
  });
}

export function buildGeneratedManifest(context: EmitContext<TypraEmitterOptions>): GeneratedManifest {
  const entries = getGeneratedFileEntries(context.program);
  const manifest: GeneratedManifest = {
    emitter: "typra-emitter",
    version: 1,
    generatedAt: context.options["deterministic-output"] ? DETERMINISTIC_GENERATED_AT : new Date().toISOString(),
    files: entries,
  };

  return manifest;
}

export function buildGeneratedOutputReport(
  context: EmitContext<TypraEmitterOptions>,
  manifest: GeneratedManifest,
): GeneratedOutputReport {
  const skippedFiles = getSkippedFileEntries(context.program);
  return {
    emitter: "typra-emitter",
    version: 1,
    generatedAt: manifest.generatedAt,
    emittedFiles: manifest.files,
    skippedFiles,
    staleMarkerOwnedRemovals: skippedFiles
      .filter((entry) => entry.action === "removed-marker-owned")
      .map((entry) => entry.path),
    preservedUnmarkedSkippedFiles: skippedFiles
      .filter((entry) => entry.action === "preserved-unmarked")
      .map((entry) => entry.path),
    warnings: getWarnings(context.program),
    hygiene: {
      lineEndings: "lf",
      finalNewline: true,
      trailingWhitespace: "trimmed",
      emptyArtifacts: "skipped-unless-allowed",
      marker: "typra-emitter",
    },
    protectedPathTouches: {
      status: "requires-verifier-baseline",
      configuredPatterns: [...(context.options["protected-paths"] ?? [])].sort((left, right) => left.localeCompare(right)),
    },
    formatter: {
      status: "not-recorded",
      note: "Target formatters run in language drivers; per-file formatter status is not recorded in generated metadata yet.",
    },
  };
}

function recordGeneratedFile(program: Program, filePath: string, marker: boolean, outputRoot?: string): void {
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

function recordSkippedFile(program: Program, filePath: string, action: SkippedGeneratedFileEntry["action"]): void {
  let entries = skippedFilesByProgram.get(program);
  if (!entries) {
    entries = new Map<string, SkippedGeneratedFileEntry>();
    skippedFilesByProgram.set(program, entries);
  }
  entries.set(normalizePath(filePath), {
    path: normalizePath(filePath),
    reason: "empty",
    action,
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
  return [...(generatedFilesByProgram.get(program)?.values() ?? [])]
    .sort((left, right) => left.path.localeCompare(right.path));
}

function getSkippedFileEntries(program: Program): SkippedGeneratedFileEntry[] {
  return [...(skippedFilesByProgram.get(program)?.values() ?? [])]
    .sort((left, right) => left.path.localeCompare(right.path));
}

function getWarnings(program: Program): string[] {
  return [...(warningsByProgram.get(program)?.values() ?? [])]
    .sort((left, right) => left.localeCompare(right));
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

function addMarkdownMarkerAfterFrontmatter(content: string, marker: string): string {
  const closingDelimiter = "\n---\n";
  const closingIndex = content.indexOf(closingDelimiter, 4);
  if (closingIndex < 0) {
    return content.startsWith(marker) ? content : `${marker}\n${content}`;
  }

  const markerIndex = closingIndex + closingDelimiter.length;
  const beforeMarker = content.slice(0, markerIndex);
  const afterMarker = content.slice(markerIndex);
  return afterMarker.startsWith(marker) ? content : `${beforeMarker}${marker}\n${afterMarker}`;
}

function markerFor(filePath: string): string {
  if (filePath.endsWith(".md")) {
    return "<!-- <auto-generated by typra-emitter> -->";
  }
  if (filePath.endsWith(".py") || filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    return "# <auto-generated by typra-emitter>";
  }
  return "// <auto-generated by typra-emitter>";
}

function normalizePath(filePath: string): string {
  return relative(process.cwd(), resolve(filePath)).replace(/\\/g, "/");
}

function normalizeGeneratedContent(content: string, options: { allowEmpty?: boolean } = {}): string {
  const normalizedLines = content.replace(/\r\n?/g, "\n").split("\n").map(line => line.trimEnd());
  while (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1] === "") {
    normalizedLines.pop();
  }

  if (normalizedLines.length === 0) {
    return options.allowEmpty ? "" : "";
  }

  return `${normalizedLines.join("\n")}\n`;
}

function removeSkippedGeneratedFile(filePath: string): { action: SkippedGeneratedFileEntry["action"]; warning?: string } {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    return { action: "none" };
  }

  const existingContent = readFileSync(absolutePath, "utf8");
  if (!existingContent.includes("<auto-generated by typra-emitter>")) {
    const warning = `Warning: skipped empty generated output but preserved unmarked file: ${normalizePath(filePath)}`;
    console.warn(warning);
    return { action: "preserved-unmarked", warning };
  }

  unlinkSync(absolutePath);
  return { action: "removed-marker-owned" };
}
