import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EmitContext, Program } from "@typespec/compiler";

import { buildToolchainMetadata } from "../src/compatibility.js";
import { ExportSurfaceSnapshot } from "../src/contract-surface.js";
import { buildGeneratedOutputReport, emitGeneratedFile, GeneratedManifest, pruneStaleGeneratedFilesAgainst } from "../src/cleanup/generated-file.js";
import { mkdirSync } from "node:fs";
import { HydrationBoundarySnapshot } from "../src/hydration-seams.js";
import { TypraEmitterOptions } from "../src/lib.js";
import { compareTypraMetadata, formatVerifySummary, SchemaNode, TypraMetadataSet } from "../src/verify/index.js";

describe("typra verifier", () => {
  it("passes clean metadata and formats deterministic zero-drift summaries", () => {
    const result = compareTypraMetadata(makeMetadata(), makeMetadata());

    assert.equal(result.ok, true);
    assert.equal(formatVerifySummary(result), [
      "Typra verify: passed",
      "exports: +0 / -0 / changed 0",
      "protocols: +0 / -0 / changed 0",
      "files: +0 / deleted 0 / ownership changed 0",
      "package names changed: 0",
      "modules: +0 / -0 / targets changed 0",
      "toolchain changed: 0 / unsupported 0",
      "protected path touches: 0",
      "hydration zone touches: 0",
      "stale cleanup dry-run candidates: 0",
      "schema: types +0 / -0, required fields +0, optional fields +0, requiredness changed 0, property types changed 0, wire names changed 0, discriminators changed 0, enum values changed 0",
      "breaking change classification: patch",
      "next action: no baseline update needed.",
      "",
    ].join("\n"));
    assert.equal(result.breakingChange, "patch");
    assert.deepEqual(result.moduleChanges, []);
    assert.equal(result.conformanceMap.find((entry) => entry.contract === "EventSink")?.targets[0].source, "./pipeline/event-sink");
  });

  it("reports additive exports and files without blocking", () => {
    const current = makeMetadata();
    current.exportSurface.targets[0].exports.push({
      name: "NewEvent",
      kind: "value",
      group: "events",
      source: "./events/new-event",
      protocol: false,
    });
    current.manifest.files.push({
      path: "generated/fixtures/typescript/events/new-event.ts",
      outputRoot: "generated/fixtures/typescript",
      marker: true,
    });

    const result = compareTypraMetadata(makeMetadata(), current);

    assert.equal(result.ok, true);
    assert.equal(result.breakingChange, "minor");
    assert.equal(result.summary.exports.added, 1);
    assert.equal(result.summary.files.added, 1);
    assert.deepEqual(result.failures, []);
  });

  it("allows additive target modules and reports them as a minor surface change", () => {
    const current = makeMetadata();
    current.exportSurface.targets[0].modules.push("./events/new-event");

    const result = compareTypraMetadata(makeMetadata(), current);

    assert.equal(result.ok, true);
    assert.equal(result.breakingChange, "minor");
    assert.deepEqual(result.summary.modules, { added: 1, removed: 0, changedTargets: 1 });
    assert.equal(result.summary.modulesChanged, 1);
    assert.deepEqual(result.moduleChanges, [
      { target: "typescript", added: ["./events/new-event"], removed: [] },
    ]);
    assert.deepEqual(result.failures, []);
    assert.match(formatVerifySummary(result), /modules: \+1 \/ -0 \/ targets changed 1/);
    assert.match(formatVerifySummary(result), /target module additions are compatible drift/);
  });

  it("blocks removal of existing target modules", () => {
    const current = makeMetadata();
    current.exportSurface.targets[0].modules = ["fixture-root"];

    const result = compareTypraMetadata(makeMetadata(), current);

    assert.equal(result.ok, false);
    assert.equal(result.breakingChange, "major");
    assert.deepEqual(result.summary.modules, { added: 0, removed: 1, changedTargets: 1 });
    assert.deepEqual(result.moduleChanges, [
      { target: "typescript", added: [], removed: ["pipeline"] },
    ]);
    assert.deepEqual(result.failures.map((failure) => failure.code), ["target.modules.removed"]);
  });

  it("blocks module relocation through the existing export surface", () => {
    const current = makeMetadata();
    current.exportSurface.targets[0].modules = ["fixture-root", "pipeline-v2"];
    current.exportSurface.targets[0].exports[1].source = "./pipeline-v2/event-sink";

    const result = compareTypraMetadata(makeMetadata(), current);

    assert.equal(result.ok, false);
    assert.equal(result.breakingChange, "major");
    assert.deepEqual(result.summary.modules, { added: 1, removed: 1, changedTargets: 1 });
    assert.deepEqual(result.moduleChanges, [
      { target: "typescript", added: ["pipeline-v2"], removed: ["pipeline"] },
    ]);
    assert.deepEqual(result.failures.map((failure) => failure.code), [
      "exports.changed",
      "target.modules.removed",
    ]);
  });

  it("blocks removed exports and generated files", () => {
    const current = makeMetadata();
    current.exportSurface.targets[0].exports = current.exportSurface.targets[0].exports.filter((entry) => entry.name !== "FixtureRoot");
    current.manifest.files = current.manifest.files.filter((entry) => !entry.path.endsWith("fixture-root.ts"));

    const result = compareTypraMetadata(makeMetadata(), current);

    assert.equal(result.ok, false);
    assert.equal(result.breakingChange, "major");
    assert.equal(result.summary.exports.removed, 1);
    assert.equal(result.summary.files.deleted, 1);
    assert.equal(result.summary.staleCleanupCandidates, 1);
    assert.deepEqual(result.staleCleanupDryRun[0].reasons, [
      "present in prior generated manifest",
      "prior entry was marked generated",
      "scoped to output root generated/fixtures/typescript",
      "not protected",
    ]);
    assert.deepEqual(result.failures.map((failure) => failure.code), ["exports.removed", "files.deleted"]);
    assert.match(
      formatVerifySummary(result),
      /next action: fix blocking drift before accepting the generated baseline; if intentional, regenerate and review the metadata diff\./,
    );
    assert.match(
      formatVerifySummary(result),
      /guidance:\n- stale cleanup candidates are available in --json output; delete only entries marked safe after review\./,
    );
  });

  it("blocks protocol void/no-value return regressions", () => {
    const current = makeMetadata();
    current.exportSurface.targets[0].protocols[0].methods[0].returns = "EventResult";

    const result = compareTypraMetadata(makeMetadata(), current);

    assert.equal(result.ok, false);
    assert.equal(result.summary.protocols.changed, 1);
    assert.deepEqual(result.failures.map((failure) => failure.code), ["protocols.changed"]);
    assert.match(formatVerifySummary(result), /protocols: \+0 \/ -0 \/ changed 1/);
  });

  it("guides baseline acceptance for additive generated drift", () => {
    const current = makeMetadata();
    current.manifest.files.push({
      path: "generated/fixtures/typescript/events/new-event.ts",
      outputRoot: "generated/fixtures/typescript",
      marker: true,
    });

    const result = compareTypraMetadata(makeMetadata(), current);

    assert.equal(result.ok, true);
    assert.equal(result.breakingChange, "minor");
    assert.match(
      formatVerifySummary(result),
      /next action: review the additive\/generated drift and accept the updated baseline if expected\./,
    );
  });

  it("reports schema evolution and classifies semantic breaking changes", () => {
    const current = makeMetadata();
    current.model!.properties![0].isOptional = true;
    current.model!.properties!.push({
      name: "requiredNewValue",
      typeName: { namespace: "", name: "string" },
      isOptional: false,
      knownAs: [],
      allowedValues: [],
      enumName: null,
      isOpenEnum: false,
    });
    current.model!.properties![1].knownAs = [{ provider: "openai", name: "summary" }];
    current.model!.properties![1].typeName = { namespace: "", name: "int32" };

    const result = compareTypraMetadata(makeMetadata(), current);

    assert.equal(result.ok, false);
    assert.equal(result.breakingChange, "major");
    assert.equal(result.summary.schema.addedRequiredProperties, 1);
    assert.equal(result.summary.schema.requirednessChanged, 1);
    assert.equal(result.summary.schema.propertyTypesChanged, 1);
    assert.equal(result.summary.schema.wireNamesChanged, 1);
    assert.deepEqual(result.schemaEvolution.map((change) => change.kind), [
      "property-added-required",
      "property-requiredness-changed",
      "property-type-changed",
      "property-wire-name-changed",
    ]);
  });

  it("blocks provider-only wire-name remaps and missing schema snapshots", () => {
    const baseline = makeMetadata();
    const current = makeMetadata();
    baseline.model!.properties![1].knownAs = [{ provider: "openai", name: "summary" }];
    current.model!.properties![1].knownAs = [{ provider: "anthropic", name: "summary" }];

    const providerResult = compareTypraMetadata(baseline, current);
    assert.equal(providerResult.ok, false);
    assert.equal(providerResult.summary.schema.wireNamesChanged, 1);
    assert.deepEqual(providerResult.schemaEvolution.map((change) => change.kind), ["property-wire-name-changed"]);

    const missingSchema = makeMetadata();
    missingSchema.model = undefined;
    const missingResult = compareTypraMetadata(makeMetadata(), missingSchema);
    assert.equal(missingResult.ok, false);
    assert.equal(missingResult.breakingChange, "major");
    assert.deepEqual(missingResult.failures.map((failure) => failure.code), ["schema.missing-model"]);
  });

  it("enforces protected paths recorded by emitted hydration metadata", () => {
    const baseline = makeMetadata();
    const current = makeMetadata();
    baseline.hydration!.protectedPaths = ["generated/fixtures/typescript/pipeline/**"];
    current.hydration!.protectedPaths = ["generated/fixtures/typescript/pipeline/**"];

    const result = compareTypraMetadata(baseline, current);

    assert.equal(result.ok, false);
    assert.equal(result.summary.protectedPathTouches, 1);
    assert.deepEqual(result.failures.map((failure) => failure.code), ["protected-path.touch"]);
    assert.match(
      formatVerifySummary(result),
      /generated files matched protected paths; treat this as hand-authored boundary drift/,
    );
  });

  it("matches globstar protected paths at the zone root and nested files", () => {
    const baseline = makeMetadata();
    const current = makeMetadata();

    const result = compareTypraMetadata(baseline, current, {
      protectedPaths: ["generated/fixtures/typescript/**/*.ts"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.summary.protectedPathTouches, 2);
    assert.deepEqual(result.failures.map((failure) => failure.code), [
      "protected-path.touch",
      "protected-path.touch",
    ]);
  });

  it("blocks removal of emitted protected path declarations", () => {
    const baseline = makeMetadata();
    const current = makeMetadata();
    baseline.hydration!.protectedPaths = ["generated/fixtures/typescript/pipeline/**"];

    const result = compareTypraMetadata(baseline, current);

    assert.equal(result.ok, false);
    assert.deepEqual(result.failures.map((failure) => failure.code), [
      "hydration-boundary.protected-paths",
      "protected-path.touch",
    ]);
  });

  it("allows bootstrapping hydration metadata for older baselines", () => {
    const baseline = makeMetadata();
    const current = makeMetadata();
    baseline.hydration = undefined;

    const result = compareTypraMetadata(baseline, current);

    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });

  it("blocks removal of previously emitted hydration metadata", () => {
    const current = makeMetadata();
    current.hydration = undefined;

    const result = compareTypraMetadata(makeMetadata(), current);

    assert.equal(result.ok, false);
    assert.deepEqual(result.failures.map((failure) => failure.code), ["hydration-boundary.changed"]);
  });

  it("marks stale cleanup dry-run candidates unsafe inside hydration zones", () => {
    const current = makeMetadata();
    current.manifest.files = current.manifest.files.filter((entry) => !entry.path.endsWith("event-sink.ts"));
    current.hydration!.hydrationZones = ["generated/fixtures/typescript/pipeline/**"];

    const result = compareTypraMetadata(makeMetadata(), current);

    assert.equal(result.summary.staleCleanupCandidates, 1);
    assert.equal(result.staleCleanupDryRun[0].safe, false);
    assert.deepEqual(result.staleCleanupDryRun[0].reasons, [
      "present in prior generated manifest",
      "prior entry was marked generated",
      "scoped to output root generated/fixtures/typescript",
      "not protected",
      "inside hydration zone",
    ]);
  });

  it("blocks package, module, toolchain, ownership, and protected path drift", () => {
    const current = makeMetadata();
    current.exportSurface.targets[0].packageName = "other";
    current.exportSurface.targets[0].modules = ["fixture-root", "pipeline/event-sink"];
    current.exportSurface.toolchain = buildToolchainMetadata([
      { name: "@typespec/compiler", version: "1.13.0", supportedRange: "1.10.0" },
      { name: "@typespec/json-schema", version: "1.10.0", supportedRange: "1.10.0" },
      { name: "@typra/emitter", version: "0.2.6", supportedRange: "0.2.6" },
    ]);
    current.manifest.files[0].marker = false;

    const result = compareTypraMetadata(makeMetadata(), current, {
      protectedPaths: ["generated/fixtures/typescript/pipeline/**"],
      hydrationZones: ["generated/fixtures/typescript/pipeline/**"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.summary.packageNamesChanged, 1);
    assert.equal(result.summary.modulesChanged, 1);
    assert.equal(result.summary.toolchain.changed, 1);
    assert.equal(result.summary.toolchain.unsupported, 1);
    assert.equal(result.summary.files.ownershipChanged, 1);
    assert.equal(result.summary.protectedPathTouches, 1);
    assert.equal(result.summary.hydrationZoneTouches, 1);
    assert.equal(result.hydrationBoundaries.hydrationZones[0], "generated/fixtures/typescript/pipeline/**");
    assert.deepEqual(result.failures.map((failure) => failure.code), [
      "files.ownership",
      "protected-path.touch",
      "target.modules.removed",
      "target.package",
      "toolchain.changed",
      "toolchain.unsupported",
    ]);
  });
});

describe("generated output report", () => {
  it("records protected-path matches and skipped cleanup guidance", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "typra-report-"));
    const staleFile = path.join(tempRoot, "stale.ts");
    writeFileSync(staleFile, "// <auto-generated by typra-emitter>\n");
    const context = makeReportContext({
      "deterministic-output": true,
      "protected-paths": ["generated/fixtures/typescript/**/*.ts"],
      "emit-targets": [
        {
          type: "TypeScript",
          "output-dir": "generated/fixtures/typescript",
          format: false,
        },
      ],
    });
    const manifest: GeneratedManifest = {
      emitter: "typra-emitter",
      version: 1,
      generatedAt: "1970-01-01T00:00:00.000Z",
      files: [
        {
          path: "generated/fixtures/typescript/pipeline/event-sink.ts",
          outputRoot: "generated/fixtures/typescript",
          marker: true,
        },
      ],
    };

    await emitGeneratedFile(context, staleFile, "");
    const report = buildGeneratedOutputReport(context, manifest);

    assert.equal(existsSync(staleFile), false);
    assert.equal(report.summary.protectedPathTouches, 1);
    assert.equal(report.summary.skippedFiles, 1);
    assert.deepEqual(report.protectedPathTouches.matchedFiles, ["generated/fixtures/typescript/pipeline/event-sink.ts"]);
    assert.match(report.protectedPathTouches.guidance, /run typra-verify against the committed baseline/);
    assert.equal(report.skippedFiles[0].ownership, "marker-owned");
    assert.equal(report.skippedFiles[0].status, "removed-stale-marker-owned");
    assert.equal(report.cleanup.status, "review-recommended");
    assert.deepEqual(report.cleanup.suggestions, [
      "Review removed marker-owned files and accept the generated baseline if the removal is expected.",
    ]);
  });

  it("allow-lists editable seams instead of deleting or warning about them", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "typra-seam-"));
    const seamFile = path.join(tempRoot, "MessageMethods.java");
    const seamContent = [
      "// <typra-editable-seam>",
      "// Typra editable seam. This file is created once and is safe to edit.",
      "package test;",
      "",
      "public final class MessageMethods {",
      '  public static String text(Message self) { return "hand-written"; }',
      "}",
      "",
    ].join("\n");
    writeFileSync(seamFile, seamContent);
    const context = makeReportContext({ "deterministic-output": true });
    const manifest: GeneratedManifest = {
      emitter: "typra-emitter",
      version: 1,
      generatedAt: "1970-01-01T00:00:00.000Z",
      files: [],
    };

    // An empty generated payload is what drives the cleaner's ownership decision.
    await emitGeneratedFile(context, seamFile, "");
    const report = buildGeneratedOutputReport(context, manifest);

    // The consumer's file and its hand-written body must survive untouched.
    assert.equal(existsSync(seamFile), true);
    assert.equal(readFileSync(seamFile, "utf8"), seamContent);

    assert.equal(report.skippedFiles[0].ownership, "editable-seam-owned");
    assert.equal(report.skippedFiles[0].status, "preserved-editable-seam");
    assert.equal(report.summary.preservedEditableSeamFiles, 1);
    assert.equal(report.preservedEditableSeamFiles.length, 1);

    // Allow-listed means clean: no ambiguous "unmarked" warning, no review churn.
    assert.equal(report.summary.preservedUnmarkedSkippedFiles, 0);
    assert.equal(report.summary.warnings, 0);
    assert.equal(report.summary.hygiene, "clean");
    assert.equal(report.cleanup.status, "safe-noop");
  });
});

function makeMetadata(): TypraMetadataSet {
  return {
    exportSurface: makeSnapshot(),
    manifest: makeManifest(),
    model: makeModel(),
    hydration: makeHydration(),
  };
}

function makeSnapshot(): ExportSurfaceSnapshot {
  return {
    emitter: "typra-emitter",
    version: 1,
    toolchain: buildToolchainMetadata([
      { name: "@typespec/compiler", version: "1.10.0", supportedRange: "1.10.0" },
      { name: "@typespec/json-schema", version: "1.10.0", supportedRange: "1.10.0" },
      { name: "@typra/emitter", version: "0.2.6", supportedRange: "0.2.6" },
    ]),
    root: {
      object: "Typra.Fixtures.FixtureRoot",
      namespace: "Typra.Fixtures",
      alias: "Fixtures",
    },
    targets: [
      {
        target: "typescript",
        outputRoot: "generated/fixtures/typescript",
        packageName: "fixtures",
        rootExports: ["EventSink", "FixtureRoot"],
        exports: [
          {
            name: "FixtureRoot",
            kind: "value",
            group: "",
            source: "./fixture-root",
            protocol: false,
          },
          {
            name: "EventSink",
            kind: "type",
            group: "pipeline",
            source: "./pipeline/event-sink",
            protocol: true,
          },
        ],
        groups: [
          {
            name: "pipeline",
            exports: ["EventSink"],
            modules: ["event-sink"],
          },
        ],
        protocols: [
          {
            name: "EventSink",
            group: "pipeline",
            symbol: "EventSink",
            source: "./pipeline/event-sink",
            methods: [
              {
                name: "emit",
                returns: "void",
                params: { event: "unknown" },
                optional: false,
                sync: true,
                runtimeCancellable: false,
                atomic: false,
                nonFatal: false,
              },
            ],
          },
        ],
        modules: ["fixture-root", "pipeline"],
      },
    ],
  };
}

function makeModel(): SchemaNode {
  return {
    typeName: { namespace: "Typra.Fixtures", name: "FixtureRoot" },
    discriminator: undefined,
    properties: [
      {
        name: "name",
        typeName: { namespace: "", name: "string" },
        isOptional: false,
        knownAs: [],
        allowedValues: [],
        enumName: null,
        isOpenEnum: false,
        isScalar: true,
      },
      {
        name: "description",
        typeName: { namespace: "", name: "string" },
        isOptional: true,
        knownAs: [],
        allowedValues: ["short", "long"],
        enumName: "DescriptionKind",
        isOpenEnum: false,
        isScalar: true,
      },
    ],
    childTypes: [],
  };
}

function makeHydration(): HydrationBoundarySnapshot {
  return {
    emitter: "typra-emitter",
    version: 1,
    protectedPaths: [],
    hydrationZones: [],
    seams: [
      {
        contract: "EventSink",
        target: "typescript",
        group: "pipeline",
        symbol: "EventSink",
        generatedSource: "./pipeline/event-sink",
        seamKind: "protocol-adapter",
      },
    ],
  };
}

function makeManifest(): GeneratedManifest {
  return {
    emitter: "typra-emitter",
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    files: [
      {
        path: "generated/fixtures/typescript/fixture-root.ts",
        outputRoot: "generated/fixtures/typescript",
        marker: true,
      },
      {
        path: "generated/fixtures/typescript/pipeline/event-sink.ts",
        outputRoot: "generated/fixtures/typescript",
        marker: true,
      },
    ],
  };
}

function makeReportContext(options: Partial<TypraEmitterOptions>): EmitContext<TypraEmitterOptions> {
  return {
    program: {} as Program,
    options: {
      "root-object": "Typra.Fixtures.FixtureRoot",
      ...options,
    },
  } as EmitContext<TypraEmitterOptions>;
}

describe("stale generated output pruning", () => {
  /** Manifest paths are stored relative to the working directory. */
  const asManifestPath = (file: string) => path.relative(process.cwd(), file).replace(/\\/g, "/");

  function seedRun(files: Array<{ name: string; content: string; marker?: boolean }>) {
    const root = mkdtempSync(path.join(tmpdir(), "typra-prune-"));
    mkdirSync(path.join(root, ".typra-generated"), { recursive: true });

    const written = files.map(file => {
      const absolute = path.join(root, file.name);
      writeFileSync(absolute, file.content);
      return { absolute, entry: { path: asManifestPath(absolute), outputRoot: asManifestPath(root), marker: file.marker ?? true } };
    });

    const previous: GeneratedManifest = {
      emitter: "typra-emitter",
      version: 1,
      generatedAt: "1970-01-01T00:00:00.000Z",
      files: written.map(item => item.entry),
    };
    writeFileSync(path.join(root, ".typra-generated", "manifest.json"), `${JSON.stringify(previous, null, 2)}\n`);

    const context = makeReportContext({ "deterministic-output": true });
    (context as { emitterOutputDir: string }).emitterOutputDir = root;
    return { root, context, written };
  }

  const generated = (body: string) => `// <auto-generated by typra-emitter>\n${body}\n`;

  it("deletes a generated file the current run no longer produces", () => {
    // A type that stops being emitted leaves its generated source and its generated test on
    // disk, where they keep compiling and keep running. A generated test for a deleted type
    // becomes a phantom failure in the consumer that reads as an emitter regression.
    const { context, written } = seedRun([
      { name: "custom-connection.ts", content: generated("export class CustomConnection {}") },
    ]);

    pruneStaleGeneratedFilesAgainst(context, new Set());

    assert.equal(existsSync(written[0].absolute), false, "stale generated file must be removed");
  });

  it("keeps a file the current run still generates", () => {
    // Counterpart guard: pruning keys on absence from the current run, so anything still
    // being emitted must survive regardless of what the previous manifest said.
    const { context, written } = seedRun([
      { name: "connection.ts", content: generated("export class Connection {}") },
    ]);

    pruneStaleGeneratedFilesAgainst(context, new Set([written[0].entry.path]));

    assert.equal(existsSync(written[0].absolute), true, "regenerated file must survive pruning");
  });

  it("preserves an editable seam and a consumer-replaced file", () => {
    // Typra deletes only what it still owns. A seam is consumer-owned by contract, and an
    // unmarked file means the consumer replaced the generated output with its own.
    const seam = "// <typra-editable-seam>\npublic class Hand {}\n";
    const handWritten = "export class Replaced {}\n";
    const { context, written } = seedRun([
      { name: "MessageMethods.java", content: seam },
      { name: "replaced.ts", content: handWritten },
    ]);

    pruneStaleGeneratedFilesAgainst(context, new Set());

    assert.equal(readFileSync(written[0].absolute, "utf8"), seam, "editable seam must survive untouched");
    assert.equal(readFileSync(written[1].absolute, "utf8"), handWritten, "consumer-replaced file must survive untouched");
  });

  it("leaves a file the previous run never claimed", () => {
    // `marker: false` records output Typra wrote but did not stamp, so it was never claimed.
    const { context, written } = seedRun([
      { name: "data.json", content: "{}\n", marker: false },
    ]);

    pruneStaleGeneratedFilesAgainst(context, new Set());

    assert.equal(existsSync(written[0].absolute), true, "unmarked manifest entry must not be deleted");
  });
});
