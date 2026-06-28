import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ExportSurfaceEntry, ExportSurfaceProtocol, ExportSurfaceSnapshot, TargetExportSurface } from "../contract-surface.js";
import { GeneratedManifest, GeneratedManifestEntry } from "../cleanup/generated-file.js";
import { HydrationBoundarySnapshot } from "../hydration-seams.js";

export interface TypraMetadataSet {
  exportSurface: ExportSurfaceSnapshot;
  manifest: GeneratedManifest;
  model?: SchemaNode;
  hydration?: HydrationBoundarySnapshot;
}

export interface TypraVerifyConfig {
  protectedPaths?: string[];
  hydrationZones?: string[];
}

export interface TypraVerifyFailure {
  code: string;
  message: string;
  blocking: boolean;
}

export interface TypraVerifySummary {
  exports: {
    added: number;
    removed: number;
    changed: number;
  };
  protocols: {
    added: number;
    removed: number;
    changed: number;
  };
  files: {
    added: number;
    deleted: number;
    ownershipChanged: number;
  };
  packageNamesChanged: number;
  modulesChanged: number;
  toolchain: {
    changed: number;
    unsupported: number;
  };
  protectedPathTouches: number;
  hydrationZoneTouches: number;
  staleCleanupCandidates: number;
  schema: {
    addedTypes: number;
    removedTypes: number;
    addedOptionalProperties: number;
    addedRequiredProperties: number;
    removedProperties: number;
    requirednessChanged: number;
    propertyTypesChanged: number;
    wireNamesChanged: number;
    discriminatorsChanged: number;
    enumValuesChanged: number;
  };
}

export interface TypraVerifyResult {
  ok: boolean;
  breakingChange: "patch" | "minor" | "major";
  summary: TypraVerifySummary;
  failures: TypraVerifyFailure[];
  schemaEvolution: SchemaEvolutionChange[];
  conformanceMap: ConformanceMapEntry[];
  staleCleanupDryRun: StaleCleanupCandidate[];
  hydrationBoundaries: HydrationBoundaryReport;
}

export interface SchemaNode {
  typeName?: { namespace?: string; name?: string };
  base?: { namespace?: string; name?: string };
  isAbstract?: boolean;
  isProtocol?: boolean;
  discriminator?: string;
  childTypes?: SchemaNode[];
  properties?: SchemaProperty[];
}

export interface SchemaProperty {
  name?: string;
  typeName?: { namespace?: string; name?: string };
  isOptional?: boolean;
  knownAs?: Array<{ provider?: string; name?: string }>;
  allowedValues?: string[];
  enumName?: string | null;
  isOpenEnum?: boolean;
  isScalar?: boolean;
  isCollection?: boolean;
  isAny?: boolean;
  isDict?: boolean;
  type?: SchemaNode;
}

export interface SchemaEvolutionChange {
  kind:
    | "type-added"
    | "type-removed"
    | "property-added-optional"
    | "property-added-required"
    | "property-removed"
    | "property-requiredness-changed"
    | "property-type-changed"
    | "property-wire-name-changed"
    | "type-discriminator-changed"
    | "property-enum-values-changed";
  path: string;
  severity: "patch" | "minor" | "major";
  message: string;
}

export interface ConformanceMapEntry {
  contract: string;
  protocol: boolean;
  targets: Array<{
    target: string;
    symbol: string;
    source: string;
    packageName?: string;
    namespace?: string;
    outputRoot: string;
    modules: string[];
    exported: boolean;
  }>;
}

export interface StaleCleanupCandidate {
  path: string;
  reasons: string[];
  safe: boolean;
}

export interface HydrationBoundaryReport {
  protectedPaths: string[];
  hydrationZones: string[];
  seams: HydrationBoundarySnapshot["seams"];
}

interface ComparableExport {
  target: string;
  entry: ExportSurfaceEntry;
}

interface ComparableProtocol {
  target: string;
  protocol: ExportSurfaceProtocol;
}

const EMPTY_SUMMARY: TypraVerifySummary = {
  exports: { added: 0, removed: 0, changed: 0 },
  protocols: { added: 0, removed: 0, changed: 0 },
  files: { added: 0, deleted: 0, ownershipChanged: 0 },
  packageNamesChanged: 0,
  modulesChanged: 0,
  toolchain: { changed: 0, unsupported: 0 },
  protectedPathTouches: 0,
  hydrationZoneTouches: 0,
  staleCleanupCandidates: 0,
  schema: {
    addedTypes: 0,
    removedTypes: 0,
    addedOptionalProperties: 0,
    addedRequiredProperties: 0,
    removedProperties: 0,
    requirednessChanged: 0,
    propertyTypesChanged: 0,
    wireNamesChanged: 0,
    discriminatorsChanged: 0,
    enumValuesChanged: 0,
  },
};

export function verifyTypraMetadata(options: {
  baselineRoot: string;
  currentRoot: string;
  configPath?: string;
}): TypraVerifyResult {
  return compareTypraMetadata(
    loadTypraMetadata(options.baselineRoot),
    loadTypraMetadata(options.currentRoot),
    options.configPath ? loadVerifyConfig(options.configPath) : undefined,
  );
}

export function loadTypraMetadata(root: string): TypraMetadataSet {
  return {
    exportSurface: readJson<ExportSurfaceSnapshot>(metadataFile(root, "export-surfaces.json")),
    manifest: readJson<GeneratedManifest>(metadataFile(root, "manifest.json")),
    model: readOptionalJson<SchemaNode>(modelFile(root)),
    hydration: readOptionalJson<HydrationBoundarySnapshot>(metadataFile(root, "hydration-seams.json")),
  };
}

export function loadVerifyConfig(configPath: string): TypraVerifyConfig {
  const config = readJson<TypraVerifyConfig>(configPath);
  if (config.protectedPaths !== undefined && !Array.isArray(config.protectedPaths)) {
    throw new Error(`Invalid Typra verifier config: protectedPaths must be an array.`);
  }
  if (config.protectedPaths?.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid Typra verifier config: protectedPaths entries must be strings.`);
  }
  if (config.hydrationZones !== undefined && !Array.isArray(config.hydrationZones)) {
    throw new Error(`Invalid Typra verifier config: hydrationZones must be an array.`);
  }
  if (config.hydrationZones?.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid Typra verifier config: hydrationZones entries must be strings.`);
  }
  return config;
}

export function compareTypraMetadata(
  baseline: TypraMetadataSet,
  current: TypraMetadataSet,
  config: TypraVerifyConfig = {},
): TypraVerifyResult {
  const summary = cloneSummary();
  const failures: TypraVerifyFailure[] = [];

  compareSnapshotIdentity(baseline.exportSurface, current.exportSurface, summary, failures);
  compareToolchain(baseline.exportSurface, current.exportSurface, summary, failures);
  compareExports(baseline.exportSurface, current.exportSurface, summary, failures);
  compareProtocols(baseline.exportSurface, current.exportSurface, summary, failures);
  compareManifest(baseline.manifest, current.manifest, summary, failures);
  compareHydrationBoundaryMetadata(baseline.hydration, current.hydration, failures);
  compareProtectedPaths(current.manifest, baseline.hydration, current.hydration, config, summary, failures);
  compareHydrationZones(current.manifest, current.hydration, config, summary);
  const schemaEvolution = compareSchemaEvolution(baseline.model, current.model, summary, failures);
  const conformanceMap = buildConformanceMap(current.exportSurface);
  const staleCleanupDryRun = buildStaleCleanupDryRun(baseline.manifest, current.manifest, config, baseline.hydration, current.hydration);
  summary.staleCleanupCandidates = staleCleanupDryRun.length;
  const hydrationBoundaries = buildHydrationBoundaryReport(current.hydration, config);

  failures.sort(compareFailures);
  const breakingChange = classifyBreakingChange(summary, schemaEvolution, failures);
  return {
    ok: failures.every((failure) => !failure.blocking),
    breakingChange,
    summary,
    failures,
    schemaEvolution,
    conformanceMap,
    staleCleanupDryRun,
    hydrationBoundaries,
  };
}

export function formatVerifySummary(result: TypraVerifyResult): string {
  const lines = [
    `Typra verify: ${result.ok ? "passed" : "failed"}`,
    `exports: +${result.summary.exports.added} / -${result.summary.exports.removed} / changed ${result.summary.exports.changed}`,
    `protocols: +${result.summary.protocols.added} / -${result.summary.protocols.removed} / changed ${result.summary.protocols.changed}`,
    `files: +${result.summary.files.added} / deleted ${result.summary.files.deleted} / ownership changed ${result.summary.files.ownershipChanged}`,
    `package names changed: ${result.summary.packageNamesChanged}`,
    `modules changed: ${result.summary.modulesChanged}`,
    `toolchain changed: ${result.summary.toolchain.changed} / unsupported ${result.summary.toolchain.unsupported}`,
    `protected path touches: ${result.summary.protectedPathTouches}`,
    `hydration zone touches: ${result.summary.hydrationZoneTouches}`,
    `stale cleanup dry-run candidates: ${result.summary.staleCleanupCandidates}`,
    `schema: types +${result.summary.schema.addedTypes} / -${result.summary.schema.removedTypes}, required fields +${result.summary.schema.addedRequiredProperties}, optional fields +${result.summary.schema.addedOptionalProperties}, requiredness changed ${result.summary.schema.requirednessChanged}, property types changed ${result.summary.schema.propertyTypesChanged}, wire names changed ${result.summary.schema.wireNamesChanged}, discriminators changed ${result.summary.schema.discriminatorsChanged}, enum values changed ${result.summary.schema.enumValuesChanged}`,
    `breaking change classification: ${result.breakingChange}`,
  ];

  const blocking = result.failures.filter((failure) => failure.blocking).sort(compareFailures);
  if (blocking.length > 0) {
    lines.push("blocking failures:");
    for (const failure of blocking) {
      lines.push(`- [${failure.code}] ${failure.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function compareSnapshotIdentity(
  baseline: ExportSurfaceSnapshot,
  current: ExportSurfaceSnapshot,
  summary: TypraVerifySummary,
  failures: TypraVerifyFailure[],
): void {
  if (baseline.emitter !== current.emitter || baseline.version !== current.version) {
    addFailure(failures, "snapshot.identity", `Snapshot identity changed from ${baseline.emitter}@${baseline.version} to ${current.emitter}@${current.version}.`);
  }
  if (stableStringify(baseline.root) !== stableStringify(current.root)) {
    addFailure(failures, "snapshot.root", `Root metadata changed from ${stableStringify(baseline.root)} to ${stableStringify(current.root)}.`);
  }

  const baselineTargets = mapTargets(baseline.targets);
  const currentTargets = mapTargets(current.targets);
  for (const target of sortedUnion([...baselineTargets.keys()], [...currentTargets.keys()])) {
    const left = baselineTargets.get(target);
    const right = currentTargets.get(target);
    if (!left || !right) {
      summary.packageNamesChanged += 1;
      addFailure(failures, "target.set", `Target set changed for ${target}.`);
      continue;
    }
    if ((left.packageName ?? "") !== (right.packageName ?? "")) {
      summary.packageNamesChanged += 1;
      addFailure(failures, "target.package", `${target} package name changed from ${left.packageName ?? "<none>"} to ${right.packageName ?? "<none>"}.`);
    }
    if ((left.namespace ?? "") !== (right.namespace ?? "")) {
      summary.packageNamesChanged += 1;
      addFailure(failures, "target.namespace", `${target} namespace changed from ${left.namespace ?? "<none>"} to ${right.namespace ?? "<none>"}.`);
    }
    if (stableStringify(left.modules) !== stableStringify(right.modules)) {
      summary.modulesChanged += 1;
      addFailure(failures, "target.modules", `${target} module list changed.`);
    }
  }
}

function compareToolchain(
  baseline: ExportSurfaceSnapshot,
  current: ExportSurfaceSnapshot,
  summary: TypraVerifySummary,
  failures: TypraVerifyFailure[],
): void {
  const baselinePackages = new Map(baseline.toolchain.packages.map((entry) => [entry.name, entry]));
  const currentPackages = new Map(current.toolchain.packages.map((entry) => [entry.name, entry]));

  for (const name of sortedUnion([...baselinePackages.keys()], [...currentPackages.keys()])) {
    const left = baselinePackages.get(name);
    const right = currentPackages.get(name);
    if (!left || !right || stableStringify(left) !== stableStringify(right)) {
      summary.toolchain.changed += 1;
      addFailure(failures, "toolchain.changed", `${name} toolchain metadata changed.`);
    }
    if (right && !right.supported) {
      summary.toolchain.unsupported += 1;
      addFailure(failures, "toolchain.unsupported", `${name}@${right.version} is outside supported range ${right.supportedRange}.`);
    }
  }
}

function compareExports(
  baseline: ExportSurfaceSnapshot,
  current: ExportSurfaceSnapshot,
  summary: TypraVerifySummary,
  failures: TypraVerifyFailure[],
): void {
  const baselineExports = mapExports(baseline.targets);
  const currentExports = mapExports(current.targets);
  for (const key of sortedUnion([...baselineExports.keys()], [...currentExports.keys()])) {
    const left = baselineExports.get(key);
    const right = currentExports.get(key);
    if (!left && right) {
      summary.exports.added += 1;
    } else if (left && !right) {
      summary.exports.removed += 1;
      addFailure(failures, "exports.removed", `${key} was removed.`);
    } else if (left && right && exportChanged(left.entry, right.entry)) {
      summary.exports.changed += 1;
      addFailure(failures, "exports.changed", `${key} changed from ${exportSignature(left.entry)} to ${exportSignature(right.entry)}.`);
    }
  }
}

function compareProtocols(
  baseline: ExportSurfaceSnapshot,
  current: ExportSurfaceSnapshot,
  summary: TypraVerifySummary,
  failures: TypraVerifyFailure[],
): void {
  const baselineProtocols = mapProtocols(baseline.targets);
  const currentProtocols = mapProtocols(current.targets);
  for (const key of sortedUnion([...baselineProtocols.keys()], [...currentProtocols.keys()])) {
    const left = baselineProtocols.get(key);
    const right = currentProtocols.get(key);
    if (!left && right) {
      summary.protocols.added += 1;
    } else if (left && !right) {
      summary.protocols.removed += 1;
      addFailure(failures, "protocols.removed", `${key} was removed.`);
    } else if (left && right && protocolSignature(left.protocol) !== protocolSignature(right.protocol)) {
      summary.protocols.changed += 1;
      addFailure(failures, "protocols.changed", `${key} signature changed.`);
    }
  }
}

function compareManifest(
  baseline: GeneratedManifest,
  current: GeneratedManifest,
  summary: TypraVerifySummary,
  failures: TypraVerifyFailure[],
): void {
  if (baseline.emitter !== current.emitter || baseline.version !== current.version) {
    addFailure(failures, "manifest.identity", `Manifest identity changed from ${baseline.emitter}@${baseline.version} to ${current.emitter}@${current.version}.`);
  }

  const baselineFiles = new Map(baseline.files.map((entry) => [normalizePath(entry.path), entry]));
  const currentFiles = new Map(current.files.map((entry) => [normalizePath(entry.path), entry]));
  for (const filePath of sortedUnion([...baselineFiles.keys()], [...currentFiles.keys()])) {
    const left = baselineFiles.get(filePath);
    const right = currentFiles.get(filePath);
    if (!left && right) {
      summary.files.added += 1;
    } else if (left && !right) {
      summary.files.deleted += 1;
      addFailure(failures, "files.deleted", `${filePath} was deleted from generated manifest.`);
    } else if (left && right && manifestOwnershipChanged(left, right)) {
      summary.files.ownershipChanged += 1;
      addFailure(failures, "files.ownership", `${filePath} generated ownership metadata changed.`);
    }
  }
}

function compareProtectedPaths(
  manifest: GeneratedManifest,
  baselineHydration: HydrationBoundarySnapshot | undefined,
  hydration: HydrationBoundarySnapshot | undefined,
  config: TypraVerifyConfig,
  summary: TypraVerifySummary,
  failures: TypraVerifyFailure[],
): void {
  const protectedPaths = getProtectedPathPatterns(config, baselineHydration, hydration);
  if (protectedPaths.length === 0) return;

  for (const entry of manifest.files) {
    const filePath = normalizePath(entry.path);
    if (protectedPaths.some((pattern) => pattern.test(filePath))) {
      summary.protectedPathTouches += 1;
      addFailure(failures, "protected-path.touch", `${filePath} matches a protected path.`);
    }
  }
}

function compareHydrationBoundaryMetadata(
  baseline: HydrationBoundarySnapshot | undefined,
  current: HydrationBoundarySnapshot | undefined,
  failures: TypraVerifyFailure[],
): void {
  if (!baseline && !current) return;
  if (!baseline && current) {
    return;
  }
  if (baseline && !current) {
    addFailure(failures, "hydration-boundary.changed", "Hydration boundary metadata was removed.");
    return;
  }
  if (!baseline || !current) return;
  if (baseline.emitter !== current.emitter || baseline.version !== current.version) {
    addFailure(failures, "hydration-boundary.changed", "Hydration boundary metadata identity changed.");
  }
  if (stableStringify(baseline.protectedPaths) !== stableStringify(current.protectedPaths)) {
    addFailure(failures, "hydration-boundary.protected-paths", "Hydration boundary protected paths changed.");
  }
  if (stableStringify(baseline.hydrationZones) !== stableStringify(current.hydrationZones)) {
    addFailure(failures, "hydration-boundary.zones", "Hydration zones changed.");
  }
  if (stableStringify(baseline.seams) !== stableStringify(current.seams)) {
    addFailure(failures, "hydration-boundary.seams", "Hydration seams changed.");
  }
}

function compareHydrationZones(
  manifest: GeneratedManifest,
  hydration: HydrationBoundarySnapshot | undefined,
  config: TypraVerifyConfig,
  summary: TypraVerifySummary,
): void {
  const configuredZones = [...(config.hydrationZones ?? []), ...(hydration?.hydrationZones ?? [])].map((entry) =>
    globToRegExp(normalizePath(entry)),
  );
  if (configuredZones.length === 0) return;

  for (const entry of manifest.files) {
    const filePath = normalizePath(entry.path);
    if (configuredZones.some((pattern) => pattern.test(filePath))) {
      summary.hydrationZoneTouches += 1;
    }
  }
}

function compareSchemaEvolution(
  baseline: SchemaNode | undefined,
  current: SchemaNode | undefined,
  summary: TypraVerifySummary,
  failures: TypraVerifyFailure[],
): SchemaEvolutionChange[] {
  if (!baseline && !current) return [];
  if (!baseline || !current) {
    addFailure(
      failures,
      "schema.missing-model",
      `Schema evolution could not run because ${baseline ? "current" : "baseline"} json-ast/model.json is missing.`,
    );
    return [
      {
        kind: baseline ? "type-removed" : "type-added",
        path: "json-ast/model.json",
        severity: "major",
        message: `${baseline ? "Current" : "Baseline"} json-ast/model.json is missing.`,
      },
    ];
  }

  const changes: SchemaEvolutionChange[] = [];
  const baselineTypes = flattenSchemaTypes(baseline);
  const currentTypes = flattenSchemaTypes(current);
  for (const typeName of sortedUnion([...baselineTypes.keys()], [...currentTypes.keys()])) {
    const left = baselineTypes.get(typeName);
    const right = currentTypes.get(typeName);
    if (!left && right) {
      summary.schema.addedTypes += 1;
      changes.push({
        kind: "type-added",
        path: typeName,
        severity: "minor",
        message: `${typeName} was added.`,
      });
      continue;
    }
    if (left && !right) {
      summary.schema.removedTypes += 1;
      changes.push({
        kind: "type-removed",
        path: typeName,
        severity: "major",
        message: `${typeName} was removed.`,
      });
      addFailure(failures, "schema.type-removed", `${typeName} was removed.`);
      continue;
    }
    if (!left || !right) continue;

    if ((left.discriminator ?? "") !== (right.discriminator ?? "")) {
      summary.schema.discriminatorsChanged += 1;
      changes.push({
        kind: "type-discriminator-changed",
        path: typeName,
        severity: "major",
        message: `${typeName} discriminator changed from ${left.discriminator ?? "<none>"} to ${right.discriminator ?? "<none>"}.`,
      });
      addFailure(failures, "schema.discriminator", `${typeName} discriminator changed.`);
    }

    compareSchemaProperties(typeName, left, right, summary, failures, changes);
  }

  return changes.sort((left, right) => `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`));
}

function compareSchemaProperties(
  typeName: string,
  baseline: SchemaNode,
  current: SchemaNode,
  summary: TypraVerifySummary,
  failures: TypraVerifyFailure[],
  changes: SchemaEvolutionChange[],
): void {
  const baselineProperties = mapSchemaProperties(baseline);
  const currentProperties = mapSchemaProperties(current);
  for (const propertyName of sortedUnion([...baselineProperties.keys()], [...currentProperties.keys()])) {
    const left = baselineProperties.get(propertyName);
    const right = currentProperties.get(propertyName);
    const pathName = `${typeName}.${propertyName}`;
    if (!left && right) {
      if (right.isOptional) {
        summary.schema.addedOptionalProperties += 1;
        changes.push({
          kind: "property-added-optional",
          path: pathName,
          severity: "minor",
          message: `${pathName} optional property was added.`,
        });
      } else {
        summary.schema.addedRequiredProperties += 1;
        changes.push({
          kind: "property-added-required",
          path: pathName,
          severity: "major",
          message: `${pathName} required property was added.`,
        });
        addFailure(failures, "schema.required-added", `${pathName} required property was added.`);
      }
      continue;
    }
    if (left && !right) {
      summary.schema.removedProperties += 1;
      changes.push({
        kind: "property-removed",
        path: pathName,
        severity: "major",
        message: `${pathName} property was removed.`,
      });
      addFailure(failures, "schema.property-removed", `${pathName} property was removed.`);
      continue;
    }
    if (!left || !right) continue;

    if ((left.isOptional ?? false) !== (right.isOptional ?? false)) {
      summary.schema.requirednessChanged += 1;
      changes.push({
        kind: "property-requiredness-changed",
        path: pathName,
        severity: "major",
        message: `${pathName} requiredness changed.`,
      });
      addFailure(failures, "schema.requiredness", `${pathName} requiredness changed.`);
    }
    if (stableStringify(propertyTypeSignature(left)) !== stableStringify(propertyTypeSignature(right))) {
      summary.schema.propertyTypesChanged += 1;
      changes.push({
        kind: "property-type-changed",
        path: pathName,
        severity: "major",
        message: `${pathName} type shape changed.`,
      });
      addFailure(failures, "schema.property-type", `${pathName} type shape changed.`);
    }
    if (stableStringify(normalizeKnownAs(left.knownAs)) !== stableStringify(normalizeKnownAs(right.knownAs))) {
      summary.schema.wireNamesChanged += 1;
      changes.push({
        kind: "property-wire-name-changed",
        path: pathName,
        severity: "major",
        message: `${pathName} wire-name mappings changed.`,
      });
      addFailure(failures, "schema.wire-name", `${pathName} wire-name mappings changed.`);
    }
    if (stableStringify(enumSignature(left)) !== stableStringify(enumSignature(right))) {
      summary.schema.enumValuesChanged += 1;
      changes.push({
        kind: "property-enum-values-changed",
        path: pathName,
        severity: "major",
        message: `${pathName} enum values changed.`,
      });
      addFailure(failures, "schema.enum", `${pathName} enum values changed.`);
    }
  }
}

function buildConformanceMap(snapshot: ExportSurfaceSnapshot): ConformanceMapEntry[] {
  const contracts = new Map<string, ConformanceMapEntry>();
  for (const target of snapshot.targets) {
    for (const entry of target.exports) {
      const key = `${entry.protocol ? "protocol" : "type"}:${entry.name}`;
      const mapEntry = contracts.get(key) ?? {
        contract: entry.name,
        protocol: entry.protocol,
        targets: [],
      };
      mapEntry.targets.push({
        target: target.target,
        symbol: entry.name,
        source: entry.source,
        packageName: target.packageName,
        namespace: target.namespace,
        outputRoot: target.outputRoot,
        modules: target.modules,
        exported: target.rootExports.includes(entry.name),
      });
      contracts.set(key, mapEntry);
    }
  }

  return Array.from(contracts.values())
    .map((entry) => ({
      ...entry,
      targets: entry.targets.sort((left, right) => left.target.localeCompare(right.target)),
    }))
    .sort((left, right) => `${left.protocol}:${left.contract}`.localeCompare(`${right.protocol}:${right.contract}`));
}

function buildStaleCleanupDryRun(
  baseline: GeneratedManifest,
  current: GeneratedManifest,
  config: TypraVerifyConfig,
  baselineHydration?: HydrationBoundarySnapshot,
  hydration?: HydrationBoundarySnapshot,
): StaleCleanupCandidate[] {
  const currentFiles = new Set(current.files.map((entry) => normalizePath(entry.path)));
  const protectedPaths = getProtectedPathPatterns(config, baselineHydration, hydration);
  const hydrationZones = [...(config.hydrationZones ?? []), ...(baselineHydration?.hydrationZones ?? []), ...(hydration?.hydrationZones ?? [])]
    .map((entry) => globToRegExp(normalizePath(entry)));

  return baseline.files
    .filter((entry) => !currentFiles.has(normalizePath(entry.path)))
    .map((entry) => {
      const filePath = normalizePath(entry.path);
      const reasons = [
        "present in prior generated manifest",
        entry.marker ? "prior entry was marked generated" : "prior entry was not marked generated",
        `scoped to output root ${normalizePath(entry.outputRoot)}`,
      ];
      const protectedMatch = protectedPaths.some((pattern) => pattern.test(filePath));
      const hydrationZoneMatch = hydrationZones.some((pattern) => pattern.test(filePath));
      reasons.push(protectedMatch ? "blocked by protected path" : "not protected");
      if (hydrationZoneMatch) reasons.push("inside hydration zone");
      return {
        path: filePath,
        reasons,
        safe: entry.marker && !protectedMatch && !hydrationZoneMatch,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildHydrationBoundaryReport(
  hydration: HydrationBoundarySnapshot | undefined,
  config: TypraVerifyConfig,
): HydrationBoundaryReport {
  return {
    protectedPaths: uniqueSorted([...(config.protectedPaths ?? []), ...(hydration?.protectedPaths ?? [])]),
    hydrationZones: uniqueSorted([...(config.hydrationZones ?? []), ...(hydration?.hydrationZones ?? [])]),
    seams: [...(hydration?.seams ?? [])].sort((left, right) =>
      `${left.target}:${left.group}:${left.contract}:${left.symbol}`.localeCompare(`${right.target}:${right.group}:${right.contract}:${right.symbol}`),
    ),
  };
}

function getProtectedPathPatterns(
  config: TypraVerifyConfig,
  baselineHydration?: HydrationBoundarySnapshot,
  hydration?: HydrationBoundarySnapshot,
): RegExp[] {
  return [...(config.protectedPaths ?? []), ...(baselineHydration?.protectedPaths ?? []), ...(hydration?.protectedPaths ?? [])]
    .map((entry) => globToRegExp(normalizePath(entry)));
}

function classifyBreakingChange(
  summary: TypraVerifySummary,
  schemaEvolution: SchemaEvolutionChange[],
  failures: TypraVerifyFailure[],
): "patch" | "minor" | "major" {
  if (failures.some((failure) => failure.blocking) || schemaEvolution.some((change) => change.severity === "major")) {
    return "major";
  }
  if (
    summary.exports.added > 0 ||
    summary.protocols.added > 0 ||
    summary.files.added > 0 ||
    summary.schema.addedOptionalProperties > 0 ||
    summary.schema.addedTypes > 0
  ) {
    return "minor";
  }
  return "patch";
}

function metadataFile(root: string, fileName: string): string {
  const direct = path.join(root, fileName);
  if (existsSync(direct)) return direct;
  return path.join(root, ".typra-generated", fileName);
}

function modelFile(root: string): string {
  const direct = path.join(root, "json-ast", "model.json");
  if (existsSync(direct)) return direct;
  const sibling = path.join(root, "..", "json-ast", "model.json");
  if (existsSync(sibling)) return sibling;
  return direct;
}

function readJson<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`Missing Typra verifier input: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function readOptionalJson<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function mapTargets(targets: TargetExportSurface[]): Map<string, TargetExportSurface> {
  return new Map(targets.map((target) => [target.target, target]));
}

function mapExports(targets: TargetExportSurface[]): Map<string, ComparableExport> {
  const entries = new Map<string, ComparableExport>();
  for (const target of targets) {
    for (const entry of target.exports) {
      entries.set(`${target.target}:${entry.group}:${entry.name}`, { target: target.target, entry });
    }
  }
  return entries;
}

function mapProtocols(targets: TargetExportSurface[]): Map<string, ComparableProtocol> {
  const entries = new Map<string, ComparableProtocol>();
  for (const target of targets) {
    for (const protocol of target.protocols) {
      entries.set(`${target.target}:${protocol.group}:${protocol.name}`, { target: target.target, protocol });
    }
  }
  return entries;
}

function exportChanged(left: ExportSurfaceEntry, right: ExportSurfaceEntry): boolean {
  return left.kind !== right.kind || left.source !== right.source || left.protocol !== right.protocol;
}

function exportSignature(entry: ExportSurfaceEntry): string {
  return stableStringify({
    kind: entry.kind,
    protocol: entry.protocol,
    source: entry.source,
  });
}

function protocolSignature(protocol: ExportSurfaceProtocol): string {
  return stableStringify({
    methods: protocol.methods,
    source: protocol.source,
    symbol: protocol.symbol,
  });
}

function manifestOwnershipChanged(left: GeneratedManifestEntry, right: GeneratedManifestEntry): boolean {
  return left.marker !== right.marker || normalizePath(left.outputRoot) !== normalizePath(right.outputRoot);
}

function addFailure(failures: TypraVerifyFailure[], code: string, message: string): void {
  failures.push({ code, message, blocking: true });
}

function cloneSummary(): TypraVerifySummary {
  return JSON.parse(JSON.stringify(EMPTY_SUMMARY)) as TypraVerifySummary;
}

function sortedUnion(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right])).sort((a, b) => a.localeCompare(b));
}

function compareFailures(left: TypraVerifyFailure, right: TypraVerifyFailure): number {
  const byCode = left.code.localeCompare(right.code);
  if (byCode !== 0) return byCode;
  return left.message.localeCompare(right.message);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function flattenSchemaTypes(root: SchemaNode): Map<string, SchemaNode> {
  const types = new Map<string, SchemaNode>();
  const visit = (node: SchemaNode | undefined): void => {
    if (!node) return;
    const key = schemaTypeKey(node);
    if (key && !types.has(key)) {
      types.set(key, node);
    }
    for (const child of node.childTypes ?? []) visit(child);
    for (const property of node.properties ?? []) visit(property.type);
  };
  visit(root);
  return types;
}

function schemaTypeKey(node: SchemaNode): string {
  const namespace = node.typeName?.namespace ?? "";
  const name = node.typeName?.name ?? "";
  return namespace ? `${namespace}.${name}` : name;
}

function mapSchemaProperties(node: SchemaNode): Map<string, SchemaProperty> {
  return new Map((node.properties ?? []).filter((property) => !!property.name).map((property) => [property.name!, property]));
}

function normalizeKnownAs(knownAs: SchemaProperty["knownAs"]): Array<{ provider: string; name: string }> {
  return (knownAs ?? [])
    .map((entry) => ({
      provider: entry.provider ?? "",
      name: entry.name ?? "",
    }))
    .sort((left, right) => `${left.provider}:${left.name}`.localeCompare(`${right.provider}:${right.name}`));
}

function propertyTypeSignature(property: SchemaProperty): {
  typeName: { namespace: string; name: string };
  isScalar: boolean;
  isCollection: boolean;
  isAny: boolean;
  isDict: boolean;
} {
  return {
    typeName: {
      namespace: property.typeName?.namespace ?? "",
      name: property.typeName?.name ?? "",
    },
    isScalar: property.isScalar ?? false,
    isCollection: property.isCollection ?? false,
    isAny: property.isAny ?? false,
    isDict: property.isDict ?? false,
  };
}

function enumSignature(property: SchemaProperty): { allowedValues: string[]; enumName: string; isOpenEnum: boolean } {
  return {
    allowedValues: [...(property.allowedValues ?? [])].sort((left, right) => left.localeCompare(right)),
    enumName: property.enumName ?? "",
    isOpenEnum: property.isOpenEnum ?? false,
  };
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}
