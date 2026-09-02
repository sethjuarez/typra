import { EmitContext, resolvePath } from "@typespec/compiler";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import {
  resolveCustomFormatters,
  runCustomFormatters,
} from "../formatter-runner.js";
import { enumerateTypes, TypeNode } from "../../ir/ast.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import { scalarValue } from "../../ir/utilities.js";
import * as YAML from "yaml";
import { resolve, dirname } from "path";
import { execFileSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { TypeRegistry } from "../../ir/expansion.js";
import { CSharpExprVisitor } from "./visitor.js";
import {
  lowerType,
  collectPolymorphicTypeNames,
  computeSerializationClosure,
} from "../../ir/lower.js";
import {
  emitCSharpClass,
  emitCSharpEnum,
  isCSharpSinglePrecision,
  protocolCSharpType,
} from "./emitter.js";
import { emitCSharpContext, emitCSharpUtils } from "./scaffolding.js";
import { emitCSharpTest } from "./test-emitter.js";
import { toPascalCase } from "../../ir/visitor.js";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import {
  applyNamespaceGroups,
  projectNamespace,
  restoreNamespaceGroups,
} from "../../ir/namespace.js";
import {
  collectProtocolNodes,
  emitCSharpProtocolScaffolds,
  shouldEmitCompileOnlyProtocolScaffolds,
} from "../../protocol-scaffolds.js";
import {
  buildExampleSamples,
  TypeResolver,
} from "../../testing/test-context.js";
import { buildVectorConformanceCodeModel } from "../../ir/code-model.js";
import {
  isClosedPolymorphicDispatch,
  dispatchDefaultSlotBase,
} from "../../ir/declarations.js";
import {
  collectDispatchedContracts,
  DispatchedContract,
  CallableVectorSnapshotEntry,
  isTypedDispatchEntry,
  assertTypedDispatchSupported,
  classifyCallableParam,
  isTypedSeamEntry,
} from "../../ir/vector.js";

/**
 * Stale generated files are removed centrally by `pruneStaleGeneratedFiles`, which uses the
 * previous run's manifest to decide ownership rather than guessing from file names.
 */

function cleanupGeneratedCSharpFiles(relDir: string | undefined): void {
  void relDir;
  return;
}

/**
 * Render a type's group as an idiomatic C# subfolder path. C# folders (like the
 * namespaces they mirror) are PascalCase, so every segment is PascalCased —
 * whether the group came from a namespace projection (already PascalCase) or from
 * a lowercase TSP source subfolder (e.g. `connection`, `tools`). Without this a
 * flat-namespace schema emits lowercase `connection/Connection.cs` while a nested
 * one emits `Contracts/Core/Thing.cs`, so folder casing is inconsistent.
 */
export function csharpGroupFolder(group: string): string {
  return group
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => toPascalCase(segment))
    .join("/");
}

export const generateCsharp = async (
  context: EmitContext<TypraEmitterOptions>,
  node: TypeNode,
  emitTarget: EmitTarget,
  options?: GeneratorOptions,
) => {
  const allTypes = Array.from(enumerateTypes(node));
  // filterNodes appends namespace-discovered `additionalModels` (types not
  // reachable from the root object). Run it first so namespace projection also
  // covers those additional models, not just the root-reachable subgraph.
  const nodes = filterNodes(allTypes, options);
  const namespaceGroupSnapshots = applyNamespaceGroups(nodes, {
    target: "csharp",
    semanticRoot: options?.rootNamespace,
    emitTarget,
    namespaceOutput: options?.namespaceOutput,
  });

  cleanupGeneratedCSharpFiles(emitTarget["output-dir"]);
  cleanupGeneratedCSharpFiles(emitTarget["test-dir"]);

  // Build the expression IR infrastructure
  const registry = TypeRegistry.fromTypeGraph(allTypes);
  const visitor = new CSharpExprVisitor(registry);

  const csharpNamespace = projectNamespace({
    target: "csharp",
    sourceNamespace: node.typeName.namespace,
    semanticRoot: options?.rootNamespace,
    emitTarget,
  }).targetNamespace!;

  // Emit context classes (LoadContext, SaveContext)
  const contextCode = emitCSharpContext(csharpNamespace);
  await emitCsharpFile(
    context,
    node,
    contextCode,
    "Context.cs",
    emitTarget["output-dir"],
  );

  const utils = emitCSharpUtils(csharpNamespace);

  await emitCsharpFile(
    context,
    node,
    utils,
    "Utils.cs",
    emitTarget["output-dir"],
  );

  // Build Declaration IR once (loop-invariant)
  const polyNames = collectPolymorphicTypeNames(allTypes[0], registry);
  // Serialization is opt-in via `@serializable`: compute the closure once and
  // thread it so only its members emit load/save.
  const serializationClosure = computeSerializationClosure(nodes, registry);
  const allTypeDecls = nodes.map((nd) =>
    lowerType(nd, registry, polyNames, serializationClosure),
  );
  const findTypeDecl = (name: string) =>
    allTypeDecls.find((t) => t.typeName.name === name);

  // Collect and emit unique enum types from all fields
  // Map each enum to the group of the first type that uses it
  const emittedEnums = new Set<string>();
  const enumGroup = new Map<string, string>(); // enumName → group
  for (let i = 0; i < allTypeDecls.length; i++) {
    const typeDecl = allTypeDecls[i];
    const nodeGroup = nodes[i]?.group || "";
    for (const field of typeDecl.fields) {
      if (field.enumName && !emittedEnums.has(field.enumName)) {
        enumGroup.set(field.enumName, nodeGroup);
      }
    }
  }
  for (const typeDecl of allTypeDecls) {
    for (const field of typeDecl.fields) {
      if (
        field.enumName &&
        !field.isOpenEnum &&
        field.allowedValues.length > 0 &&
        !emittedEnums.has(field.enumName)
      ) {
        emittedEnums.add(field.enumName);
        const enumCode = emitCSharpEnum(
          {
            name: field.enumName,
            values: field.allowedValues,
            parseAliases: field.parseAliases,
            isOpen: field.isOpenEnum,
          },
          csharpNamespace,
        );
        const csEnumName =
          field.enumName.charAt(0).toUpperCase() + field.enumName.slice(1);
        const grp = enumGroup.get(field.enumName) || "";
        const enumFolder = csharpGroupFolder(grp);
        const enumOutDir = enumFolder
          ? `${emitTarget["output-dir"]}/${enumFolder}`
          : emitTarget["output-dir"];
        await emitCsharpFile(
          context,
          nodes[0],
          enumCode,
          `${csEnumName}.cs`,
          enumOutDir,
          emitTarget["output-dir"],
        );
      }
    }
  }

  for (const n of nodes) {
    const typeDecl = lowerType(n, registry, polyNames, serializationClosure);
    const classCode = emitCSharpClass(
      typeDecl,
      csharpNamespace,
      visitor,
      allTypeDecls,
      findTypeDecl,
    );
    // Emit into group subfolder (C# uses namespaces, no re-export files needed)
    const groupFolder = csharpGroupFolder(n.group);
    const outDir = groupFolder
      ? `${emitTarget["output-dir"]}/${groupFolder}`
      : emitTarget["output-dir"];
    await emitCsharpFile(
      context,
      n,
      classCode,
      `${n.typeName.name}.cs`,
      outDir,
      emitTarget["output-dir"],
    );
    if (emitTarget["test-dir"] && !n.isProtocol) {
      const testDir = groupFolder
        ? `${emitTarget["test-dir"]}/${groupFolder}`
        : emitTarget["test-dir"];
      await emitCsharpFile(
        context,
        n,
        renderTests(n, csharpNamespace, (name) => registry.get(name)),
        `${n.typeName.name}ConversionTests.cs`,
        testDir,
        emitTarget["test-dir"],
      );
    }
  }

  if (
    emitTarget["test-dir"] &&
    shouldEmitCompileOnlyProtocolScaffolds(emitTarget)
  ) {
    const scaffoldContent = emitCSharpProtocolScaffolds(
      collectProtocolNodes(nodes),
      csharpNamespace,
    );
    if (scaffoldContent) {
      await emitCsharpFile(
        context,
        node,
        scaffoldContent,
        "ProtocolScaffolds.cs",
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }
  }

  if (
    emitTarget["test-dir"] &&
    (options?.callableVectors?.vectors.length ?? 0) > 0
  ) {
    const adapterNamespace =
      emitTarget["vector-adapter-path"] ?? `${csharpNamespace}.Conformance`;
    const allVectors = options!.callableVectors!.vectors;
    // A `@dispatch` seam routes through the typed resolver rail (issue #282 §8):
    // its vectors get a per-interface, typed `${Interface}ConformanceTests` file
    // in the seam's namespace folder. Undispatched seams — INCLUDING a @dispatch
    // whose discriminator model is not polymorphic (no `decl`, so no typed rail) —
    // keep the stringly JSON interpreter (`VectorRunner`) + monolithic
    // `VectorConformanceTests`, so no vector is dropped from both rails.
    const undispatched = allVectors.filter(
      (entry) => !isTypedDispatchEntry(entry),
    );

    if (undispatched.length > 0) {
      await emitCsharpFile(
        context,
        node,
        emitCSharpVectorRunner(csharpNamespace, adapterNamespace),
        "VectorRunner.cs",
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
      await emitCsharpFile(
        context,
        node,
        emitCSharpVectorConformanceTest(
          { ...options!.callableVectors!, vectors: undispatched },
          csharpNamespace,
          adapterNamespace,
        ),
        "VectorConformanceTests.cs",
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }

    for (const dispatched of collectDispatchedContracts(allVectors)) {
      const ifaceVectors = allVectors.filter(
        (entry) =>
          isTypedDispatchEntry(entry) &&
          entry.namespace === dispatched.namespace &&
          entry.group === dispatched.group &&
          entry.contract === dispatched.contract,
      );
      // §8.5: never emit an empty conformance file — but the resolver below is
      // still emitted for a zero-vector dispatched seam so control 2 keeps biting.
      if (ifaceVectors.length === 0) continue;
      const conformanceFolder = csharpGroupFolder(dispatched.group);
      const conformanceDir = conformanceFolder
        ? `${emitTarget["test-dir"]}/${conformanceFolder}`
        : emitTarget["test-dir"];
      await emitCsharpFile(
        context,
        node,
        emitCSharpInterfaceConformanceTest(
          dispatched,
          ifaceVectors,
          csharpNamespace,
          adapterNamespace,
        ),
        `${dispatched.contract}ConformanceTests.cs`,
        conformanceDir,
        emitTarget["test-dir"],
      );
    }
  }

  // Part III: emit one behavioral @dispatch resolver (provider type + Resolve
  // switch, the twin of the shape Load switch) per dispatched seam interface,
  // into the LIBRARY beside the seam interface (issue #282). The provider is a
  // real extension point a consumer implements, so a forgotten slot fails to
  // compile — the same rail as the shape discriminator switch, itself a library
  // artifact. NOTE: emission currently rides the presence of @vector cases;
  // decoupling it to emit for every dispatched contract regardless of test
  // coverage is a tracked follow-up (issue #282).
  if ((options?.callableVectors?.vectors.length ?? 0) > 0) {
    for (const dispatched of collectDispatchedContracts(
      options!.callableVectors!.vectors,
    )) {
      const resolverFolder = csharpGroupFolder(dispatched.group);
      const resolverDir = resolverFolder
        ? `${emitTarget["output-dir"]}/${resolverFolder}`
        : emitTarget["output-dir"];
      await emitCsharpFile(
        context,
        node,
        emitCSharpDispatchResolver(dispatched, csharpNamespace),
        `${dispatched.contract}Resolver.cs`,
        resolverDir,
        emitTarget["output-dir"],
      );
    }
  }

  // Category 1 (issue #511): emit a typed @vector conformance entrypoint for
  // plain (undispatched) seams into the LIBRARY beside the seam interface. It
  // takes the consumer's REAL typed seam impl (typed as the emitted `I<Seam>`
  // interface, so a forgotten op fails to compile) and runs the seam's baked-in
  // vectors by calling methods directly — the idiomatic replacement for the
  // stringly VectorRunner registry + per-op marshalling double. Phase 2 widens
  // eligibility from scalar-only to model-in/model-out seams whose boundary
  // models live in the `@serializable` closure (see `isTypedSeamEntry`): a model
  // param decodes via `<Model>.FromJson(...)` and a model return compares through
  // `actual.ToJson()`, keeping it zero-diff on real surfaces. Phase 2 array
  // parity (`{ arrays: true }`) further admits `Model[]` seams — decoded/compared
  // element-wise into `List<Model>`. Carrier parity (`{ carriers: true }`)
  // admits an untyped `Record<unknown>` param (optional or not); it decodes via
  // the same generic `JsonSerializer.Deserialize<Dictionary<string, object?>>`
  // param branch with no extra emission, and stays param-only so the return
  // keeps its own rule. Emitted additively beside the stringly runner.
  if ((options?.callableVectors?.vectors.length ?? 0) > 0) {
    const conformanceEntries = options!.callableVectors!.vectors.filter((entry) =>
      isTypedSeamEntry(entry, serializationClosure, {
        arrays: true,
        carriers: true,
      }),
    );
    if (conformanceEntries.length > 0) {
      await emitCsharpFile(
        context,
        node,
        emitCSharpVectorConformanceEntrypoint(conformanceEntries, csharpNamespace),
        "VectorConformance.cs",
        emitTarget["output-dir"],
        emitTarget["output-dir"],
      );
    }
  }
  // Format emitted files if format option is enabled (default: true)
  if (emitTarget.format !== false) {
    const outputDir = emitTarget["output-dir"]
      ? resolve(process.cwd(), emitTarget["output-dir"])
      : context.emitterOutputDir;
    const testDir = emitTarget["test-dir"]
      ? resolve(process.cwd(), emitTarget["test-dir"])
      : undefined;

    const custom = resolveCustomFormatters(emitTarget.format);
    if (custom) {
      runCustomFormatters(custom, { dir: outputDir, testDir });
    } else {
      formatCSharpFiles(outputDir, testDir);
    }
  }
  restoreNamespaceGroups(namespaceGroupSnapshots);
};

// --- Test-rendering helpers ---

/**
 * Render the conversion-test file for one type.
 *
 * Exported for regression coverage: the payload completion below is easy to drop when this
 * driver diverges from the shared `buildBaseTestContext` path the other backends use.
 */
export const renderTests = (
  node: TypeNode,
  namespace: string,
  resolveType: TypeResolver,
): string => {
  const examples = buildExampleSamples(node, resolveType).map((sample) => {
    // Create YAML document and customize string scalar style for values with special chars
    const doc = new YAML.Document(sample);
    YAML.visit(doc, {
      Scalar(key, node) {
        // Only quote string values that contain special characters requiring escaping
        if (typeof node.value === "string") {
          const str = node.value as string;
          if (
            str.includes("\n") ||
            str.includes("\t") ||
            str.includes("#") ||
            str.includes(":") ||
            str.includes('"')
          ) {
            node.type = "QUOTE_DOUBLE";
          }
        }
      },
    });
    return {
      json: JSON.stringify(sample, null, 2).split("\n"),
      // `doubleQuotedMinMultiLineLength` (yaml's default is 40) folds a long double-quoted
      // scalar across lines using `\` line continuations. A space adjacent to such a fold is
      // not recoverable on reload, so the value silently loses one space per folded break.
      // Every backend that goes through `buildBaseTestContext` opts out of this via
      // `yamlDoubleQuotedMinMultiLineLength`; because this driver hand-rolls the document it
      // never inherited that, and its generated multiline fixtures did not round-trip. See #93.
      yaml: doc
        .toString({
          indent: 2,
          lineWidth: 0,
          doubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER,
        })
        .split("\n"),
      // Mirror the shared `buildValidations` filter in src/testing/test-context.ts: a
      // validation is only emitted for a key that is genuinely a scalar (or enum) property
      // of this node. Filtering on the sample alone asserts properties that do not exist on
      // the emitted class — a polymorphic base whose `@sample` shows a subtype payload, or a
      // complex field populated through a scalar coercion — and the generated test then
      // fails to compile against the generated loader.
      validations: Object.keys(sample)
        .filter((key) => isCSharpAssertableSampleKey(key, sample[key], node))
        .map((key) => {
          const val = sample[key];
          // Check if this field is a closed enum — if so, use EnumName.MemberName syntax
          // Skip discriminator fields — their enums are excluded from generation
          const prop = node.properties.find((p) => p.name === key);
          const isDiscriminator = node.discriminator === key;
          if (
            prop &&
            prop.enumName &&
            !prop.isOpenEnum &&
            !isDiscriminator &&
            typeof val === "string"
          ) {
            const csEnumName = toPascalCase(prop.enumName);
            const memberName = toPascalCase(val);
            return {
              key: renderName(key),
              value: `${csEnumName}.${memberName}`,
              isExpression: true,
            };
          }
          return {
            key: renderName(key),
            value: val,
            isExpression: false,
          };
        }),
    };
  });

  const coercions = node.coercions.map((alt) => {
    const example = alt.example
      ? typeof alt.example === "string"
        ? '"' + alt.example + '"'
        : alt.example.toString()
      : scalarValue[alt.scalar] || "None";
    return {
      title: alt.title || alt.scalar,
      scalar: alt.scalar,
      value: example,
      // using 'validations' (plural) for consistency across languages
      validations: Object.keys(alt.expansion)
        .filter((key) => typeof alt.expansion[key] !== "object")
        .map((key) => {
          const value =
            alt.expansion[key] === "{value}" ? example : alt.expansion[key];
          // Check if this field is a closed enum (skip discriminator fields)
          const prop = node.properties.find((p) => p.name === key);
          const isDiscriminator = node.discriminator === key;
          if (prop && prop.enumName && !prop.isOpenEnum && !isDiscriminator) {
            // Extract the raw string value (strip quotes if present from example substitution)
            const rawValue =
              typeof value === "string"
                ? value.replace(/^"|"$/g, "")
                : String(value);
            const csEnumName = toPascalCase(prop.enumName);
            const memberName = toPascalCase(rawValue);
            return {
              key: renderName(key),
              value: `${csEnumName}.${memberName}`,
              delimiter: "",
            };
          }
          return {
            key: renderName(key),
            value: value,
            delimiter:
              typeof value === "string" &&
              !value.includes('"') &&
              alt.expansion[key] !== "{value}"
                ? '"'
                : "",
          };
        }),
    };
  });

  return emitCSharpTest({
    node,
    namespace,
    examples,
    coercions,
    factories: node.factories,
    singlePrecisionKeys: new Set(
      node.properties
        .filter(
          (p) =>
            p.isScalar &&
            !p.isCollection &&
            isCSharpSinglePrecision(p.typeName.name),
        )
        .map((p) => renderName(p.name)),
    ),
    renderName,
    renderCsharpFactoryMethodName: (factoryName: string) =>
      renderCsharpFactoryMethodName(factoryName, node),
    renderCsharpFactoryTestValue,
  });
};

/**
 * Whether a `@sample` key should become an assertion in the generated conversion test.
 *
 * Mirrors the shared `buildValidations` filter in src/testing/test-context.ts: only a key that
 * is genuinely a scalar (or enum) property of this node is assertable. Filtering on the sample
 * alone asserts members that do not exist on the emitted class — a polymorphic base whose
 * `@sample` carries a subtype payload, or a complex field populated through a scalar coercion —
 * and the generated test then fails to compile against the generated loader.
 */
export const isCSharpAssertableSampleKey = (
  key: string,
  value: unknown,
  node: TypeNode,
): boolean => {
  const prop = node.properties.find((p) => p.name === key);
  return typeof value !== "object" && Boolean(prop?.isScalar || prop?.enumName);
};

const renderName = (name: string): string => {
  // convert snake_case to PascalCase
  const pascal = name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  // capitalize the first letter
  return pascal.charAt(0).toUpperCase() + pascal.slice(1);
};

const renderCsharpFactoryParamType = (typeStr: string): string => {
  switch (typeStr) {
    case "string":
      return "string";
    case "boolean":
      return "bool";
    case "integer":
    case "int32":
      return "int";
    case "int64":
      return "long";
    case "float":
    case "float32":
      return "float";
    case "float64":
      return "double";
    case "unknown":
      return "object?";
    default:
      return "object?";
  }
};

// Returns a factory method name that won't clash with C# property names on the same type.
// If the capitalized factory name matches a property name, prefix with "Create".
const renderCsharpFactoryMethodName = (
  factoryName: string,
  node: TypeNode,
): string => {
  const methodName = factoryName.charAt(0).toUpperCase() + factoryName.slice(1);
  const propertyNames = node.properties.map((p) => renderName(p.name));
  // Also consider zero-param non-verb method stubs that C# emits as properties
  for (const m of node.methods) {
    if (!m.params?.length) {
      const mName = renderName(m.name);
      if (!propertyNames.includes(mName)) {
        propertyNames.push(mName);
      }
    }
  }
  if (propertyNames.includes(methodName)) {
    return `Create${methodName}`;
  }
  return methodName;
};

const renderCsharpFactoryTestValue = (typeStr: string): string => {
  switch (typeStr) {
    case "string":
      return '"test"';
    case "boolean":
      return "true";
    case "integer":
    case "int32":
      return "42";
    case "int64":
      return "42L";
    case "float":
    case "float32":
      return "3.14f";
    case "float64":
      return "3.14";
    case "unknown":
      return '"test"';
    default:
      return '"test"';
  }
};

const emitCsharpFile = async (
  context: EmitContext<TypraEmitterOptions>,
  type: TypeNode,
  python: string,
  filename: string,
  outputDir?: string,
  outputRoot?: string,
) => {
  outputDir = outputDir || `${context.emitterOutputDir}/CSharp`;
  const typePath = type.typeName.namespace.split(".");

  // replace typename with file
  typePath.push(filename);
  const path = resolvePath(outputDir, filename);
  await emitGeneratedFile(context, path, python, {
    outputRoot: outputRoot || outputDir,
  });
};

/**
 * Escape every non-ASCII UTF-16 code unit in a JSON document to a `\uXXXX` JSON
 * escape. The result is still valid JSON (only string-content characters change,
 * and `\uXXXX` is their canonical JSON form), but the emitted source stays pure
 * ASCII so a bidi control or homoglyph cannot alter how the file reads. The C#
 * JSON parser restores the original code points at runtime.
 */
function jsonAsciiEscape(json: string): string {
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    if (code > 0x7e) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += json[i];
    }
  }
  return out;
}

/**
 * Build a unique xUnit fact-method identifier for a vector.
 */
function csharpVectorSlug(
  index: number,
  entry: { contract: string; operation: string; vector: { name?: string } },
): string {
  const raw = `${entry.contract}_${entry.operation}_${entry.vector.name ?? "unnamed"}`;
  const pascal = raw
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");
  return `Vector${index}${pascal || "Unnamed"}`;
}

/**
 * Emit the seam-agnostic C# `@vector` runner (`VectorRunner.cs`). This module is
 * the relocated interpreter that the thin `VectorConformanceTests` harness drives:
 * reference resolution ($env/$file/$json), canonical/stable JSON, adapter lookup
 * with bare-operation fallback, the requirement/capability guard, per-vector
 * waiver xfail/xpass, await-if-awaitable with @sync enforcement, and the
 * canonical-equality assertion.
 *
 * It reads ZERO authored values: every adapter/waiver/capability/double table and
 * the base directory are injected by the harness through the `VectorSeam` it
 * receives, so this interpreter's behavior is fully determined by its inputs and
 * is independently unit-testable with injected fakes. Because it holds no
 * per-schema data, its text is constant across every generated target.
 *
 * Option A (nominally-typed target): the runner imports the runtime-authored
 * adapter namespace for its port TYPES ONLY (`VectorContext`, `VectorAdapter`,
 * `VectorException`) and never reads its authored registries. Unlike Go — where
 * the runner must be its own package — C# permits multiple classes per directory,
 * so the runner is a sibling FILE of the harness in the same test namespace.
 */
function emitCSharpVectorRunner(
  testNamespace: string,
  adapterNamespace: string,
): string {
  return [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Seam-agnostic @vector behavioral conformance runner. The interpreter lives",
    "// here, decoupled from any runtime-authored data: every seam table (adapters,",
    "// waivers, capabilities, doubles) and the harness base directory are injected",
    "// through the VectorSeam struct, so this file reads ZERO authored values and",
    "// is value-independent.",
    "//",
    "// PORT-TYPES-ONLY IMPORT (Option A): this file imports the runtime-authored",
    "// adapter namespace for its port TYPES ONLY (VectorContext, VectorAdapter,",
    "// VectorException) — never for its authored registries. Unlike Go, where a",
    "// directory holds one non-test package and the runner must be its own package,",
    "// C# allows many classes per directory, so the runner is a sibling FILE of the",
    "// harness in the same test namespace. The harness loads the authored tables",
    "// and injects them via VectorSeam.",
    "//",
    "// Adapter contract: Invoke may return either a plain JsonNode (as object?) or a",
    "// Task/ValueTask that resolves to one. The runner awaits the result before",
    "// normalizing, so an async runtime pipeline runs on xUnit's own async test.",
    "// Each vector performs exactly one awaited invocation and spawns no background",
    "// concurrency, so conformance stays deterministic.",
    "//",
    "// Classification is ENFORCED: an operation marked `@sync` (the sync argument",
    "// threaded from each per-vector test) must resolve synchronously — if its",
    "// adapter returns a Task/ValueTask the vector is a hard failure. An",
    "// async-capable operation (the default) stays permissive: a plain value or a",
    "// Task/ValueTask both pass.",
    "// See docs: reference/vector-conformance.",
    "#nullable enable",
    "using System;",
    "using System.Collections.Generic;",
    "using System.IO;",
    "using System.Linq;",
    "using System.Runtime.ExceptionServices;",
    "using System.Text;",
    "using System.Text.Json;",
    "using System.Text.Json.Nodes;",
    "using System.Threading.Tasks;",
    "using Xunit;",
    `using ${adapterNamespace};`,
    "",
    `namespace ${testNamespace}.Conformance;`,
    "",
    "// Runtime-authored seam tables injected by the harness. The runner reads ZERO",
    "// authored values directly; everything flows through here. Capabilities is",
    "// populated only when a vector declares `requires` (otherwise left null and",
    "// never consulted), keeping requirement-free harnesses byte-identical.",
    "public sealed class VectorSeam",
    "{",
    "    public required IReadOnlyDictionary<string, VectorAdapter> Adapters { get; init; }",
    "    public required IReadOnlyDictionary<string, string> Waivers { get; init; }",
    "    public IReadOnlyDictionary<string, Func<VectorContext, bool>>? Capabilities { get; init; }",
    "    public JsonNode? Doubles { get; init; }",
    "    public required string BaseDir { get; init; }",
    "}",
    "",
    "public static class VectorRunner",
    "{",
    "    private static JsonNode? ResolveRefs(JsonNode? value, string dir)",
    "    {",
    "        switch (value)",
    "        {",
    "            case JsonArray arr:",
    "            {",
    "                var outArr = new JsonArray();",
    "                foreach (var item in arr)",
    "                {",
    "                    outArr.Add(ResolveRefs(item?.DeepClone(), dir));",
    "                }",
    "                return outArr;",
    "            }",
    "            case JsonObject obj:",
    "            {",
    "                if (obj.Count == 1)",
    "                {",
    "                    foreach (var kv in obj)",
    "                    {",
    "                        if (kv.Value is JsonValue jv && jv.TryGetValue<string>(out var raw))",
    "                        {",
    "                            switch (kv.Key)",
    "                            {",
    '                                case "$env":',
    "                                    return JsonValue.Create(",
    "                                        Environment.GetEnvironmentVariable(raw) ?? \"\");",
    '                                case "$file":',
    "                                    return JsonValue.Create(",
    "                                        File.ReadAllText(Path.Combine(dir, raw)));",
    '                                case "$json":',
    "                                    return JsonNode.Parse(",
    "                                        File.ReadAllText(Path.Combine(dir, raw)));",
    "                            }",
    "                        }",
    "                    }",
    "                }",
    "                var outObj = new JsonObject();",
    "                foreach (var kv in obj)",
    "                {",
    "                    outObj[kv.Key] = ResolveRefs(kv.Value?.DeepClone(), dir);",
    "                }",
    "                return outObj;",
    "            }",
    "            default:",
    "                return value?.DeepClone();",
    "        }",
    "    }",
    "",
    "    // Walks a deterministic field-access path (e.g. `agent.template.format.kind`)",
    "    // over a resolved vector input to read the @dispatch discriminator value that",
    "    // selects the concrete seam implementation. Returns null if any hop is missing",
    "    // or the terminal value is not a string, so the caller can fail loudly.",
    "    private static string? ResolveDispatchKey(JsonNode? root, string dotted)",
    "    {",
    "        var node = root;",
    "        foreach (var key in dotted.Split('.'))",
    "        {",
    "            node = node is JsonObject obj ? obj[key] : null;",
    "            if (node is null) { return null; }",
    "        }",
    "        return node is JsonValue value && value.TryGetValue<string>(out var s) ? s : null;",
    "    }",
    "",
    "    private static string Canonical(JsonNode? node)",
    "    {",
    '        if (node is null) return "null";',
    "        if (node is JsonObject obj)",
    "        {",
    '            var sb = new StringBuilder("{");',
    "            var first = true;",
    "            foreach (var kv in obj.OrderBy(p => p.Key, StringComparer.Ordinal))",
    "            {",
    "                if (!first) sb.Append(',');",
    "                first = false;",
    "                sb.Append(JsonSerializer.Serialize(kv.Key))",
    "                    .Append(':')",
    "                    .Append(Canonical(kv.Value));",
    "            }",
    "            return sb.Append('}').ToString();",
    "        }",
    "        if (node is JsonArray arr)",
    "        {",
    '            var sb = new StringBuilder("[");',
    "            for (var i = 0; i < arr.Count; i++)",
    "            {",
    "                if (i > 0) sb.Append(',');",
    "                sb.Append(Canonical(arr[i]));",
    "            }",
    "            return sb.Append(']').ToString();",
    "        }",
    "        return node.ToJsonString();",
    "    }",
    "",
    "    private static async Task<JsonNode?> AwaitIfAwaitable(object? result)",
    "    {",
    "        switch (result)",
    "        {",
    "            case null:",
    "                return null;",
    "            case JsonNode node:",
    "                return node;",
    "            case Task<JsonNode?> task:",
    "                return await task.ConfigureAwait(false);",
    "            case ValueTask<JsonNode?> valueTask:",
    "                return await valueTask.ConfigureAwait(false);",
    "            case Task task:",
    "                await task.ConfigureAwait(false);",
    "                return task.GetType().GetProperty(\"Result\")?.GetValue(task) as JsonNode;",
    "            default:",
    "                return result as JsonNode;",
    "        }",
    "    }",
    "",
    "    // A Task/ValueTask is the .NET-native awaitable. @sync enforcement keys off",
    "    // this shape: a synchronously-callable operation must never return one.",
    "    private static bool IsAwaitable(object? result) =>",
    "        result is Task || result is ValueTask || result is ValueTask<JsonNode?>;",
    "",
    "    // Exactly one invocation, with @sync classification enforced before awaiting.",
    "    private static async Task<JsonNode?> InvokeAdapter(",
    "        VectorAdapter adapter, JsonNode? input, VectorContext ctx, bool sync, string vectorId)",
    "    {",
    "        var raw = adapter.Invoke(input, ctx);",
    "        if (sync && IsAwaitable(raw))",
    "        {",
    "            Assert.Fail(",
    '                $"{vectorId}: operation is @sync but its adapter returned an " +',
    "                \"awaitable. A @sync operation must resolve synchronously — drop @sync \" +",
    '                "to make it async-capable, or make the adapter synchronous.");',
    "        }",
    "        return await AwaitIfAwaitable(raw);",
    "    }",
    "",
    "    public static async Task RunVector(",
    "        string contract, string operation, JsonObject vector, bool sync, VectorSeam seam,",
    "        string? dispatchPath = null)",
    "    {",
    '        var operationKey = $"{contract}.{operation}";',
    '        var vectorName = (string?)vector["name"] ?? "unnamed";',
    '        var vectorId = $"{operationKey}:{vectorName}";',
    "",
    "        // Behavioral polymorphic dispatch (@dispatch): dispatchPath (non-null for a",
    "        // dispatched seam) is the discriminator access path. The concrete impl is",
    "        // resolved once from the discriminator value read at that path on the vector",
    "        // input and looked up in the seam's per-key registry (adapters keyed",
    "        // `Contract.operation#key`). An impl absent for a valid key reuses the",
    "        // capability-absent skip. Undispatched seams pass null and keep the single",
    "        // adapter lookup unchanged.",
    "        var adapters = seam.Adapters;",
    "        VectorAdapter adapter;",
    "        if (!string.IsNullOrEmpty(dispatchPath))",
    "        {",
    '            var dispatchInput = ResolveRefs(vector["input"]?.DeepClone(), seam.BaseDir);',
    "            var dispatchKey = ResolveDispatchKey(dispatchInput, dispatchPath);",
    "            if (dispatchKey is null)",
    "            {",
    "                Assert.Fail(",
    "                    $\"{vectorId}: @dispatch path '{dispatchPath}' did not resolve to a \" +",
    '                    "string discriminator on the vector input.");',
    "                return;",
    "            }",
    '            if (!adapters.TryGetValue($"{operationKey}#{dispatchKey}", out adapter!) &&',
    '                !adapters.TryGetValue($"{operation}#{dispatchKey}", out adapter!))',
    "            {",
    '                Console.WriteLine($"SKIP {vectorId} (requirement unavailable: {dispatchKey})");',
    "                return;",
    "            }",
    "        }",
    "        else if (!adapters.TryGetValue(operationKey, out adapter!) &&",
    "            !adapters.TryGetValue(operation, out adapter!))",
    "        {",
    "            var waivers = seam.Waivers;",
    "            if ((waivers.TryGetValue(operationKey, out var reason) ||",
    "                 waivers.TryGetValue(operation, out reason)) &&",
    "                !string.IsNullOrEmpty(reason))",
    "            {",
    '                Console.WriteLine($"SKIP {vectorId} (waived: {reason})");',
    "                return;",
    "            }",
    "            Assert.Fail(",
    '                $"No vector adapter registered for {operationKey}. Register it in " +',
    "                \"the module referenced by 'vector-adapter-path', or add an explicit \" +",
    '                "waiver. @vector conformance never skips silently.");',
    "            return;",
    "        }",
    "",
    "        // Requirement guard: a vector may declare abstract capability tokens in",
    "        // \"requires\". Each is resolved against the seam-supplied capability table",
    "        // BEFORE the adapter runs. An unregistered token is a hard failure (never",
    "        // skip silently); an unavailable one yields a clean skip so an absent",
    "        // credential never reaches Invoke as an empty value. A requires-free",
    "        // harness injects no capability table and this guard stays inert.",
    "        var requires = (vector[\"requires\"] as JsonArray)?",
    "            .Select(node => (string?)node)",
    "            .Where(token => token is not null)",
    "            .Select(token => token!)",
    "            .ToList() ?? new List<string>();",
    "        if (requires.Count > 0)",
    "        {",
    "            var capabilities = seam.Capabilities ??",
    "                new Dictionary<string, Func<VectorContext, bool>>();",
    "            foreach (var token in requires)",
    "            {",
    "                if (!capabilities.ContainsKey(token))",
    "                {",
    "                    Assert.Fail(",
    '                        $"No capability predicate registered for requirement token \\"{token}\\". " +',
    '                        $"Register VectorAdapters.Capabilities()[\\"{token}\\"] in the module " +',
    "                        \"referenced by 'vector-adapter-path'. @vector conformance never skips silently.\");",
    "                    return;",
    "                }",
    "            }",
    "            var capabilityContext = new VectorContext",
    "            {",
    "                Contract = contract,",
    "                Operation = operation,",
    "                Vector = vector.DeepClone(),",
    '                Provider = (string?)vector["provider"],',
    '                TargetApi = (string?)vector["targetApi"],',
    "                Doubles = seam.Doubles,",
    "                BaseDir = seam.BaseDir,",
    "            };",
    "            foreach (var token in requires)",
    "            {",
    "                if (!capabilities[token](capabilityContext))",
    "                {",
    '                    Console.WriteLine($"SKIP {vectorId} (requirement unavailable: {token})");',
    "                    return;",
    "                }",
    "            }",
    "        }",
    "",
    "        // Per-vector waiver, consulted even when an adapter IS registered. Keyed",
    "        // by the vector id (\"Contract.operation:name\") or \"operation:name\" so it",
    "        // never collides with an operation-level waiver. xfail: a waived vector",
    "        // that fails is an expected failure (green); xpass: a waived vector that",
    "        // passes is surfaced as a hard failure so stale waivers get removed.",
    "        var vectorWaivers = seam.Waivers;",
    "        if (!vectorWaivers.TryGetValue(vectorId, out var vectorWaiver))",
    "            vectorWaivers.TryGetValue($\"{operation}:{vectorName}\", out vectorWaiver);",
    "        var waived = !string.IsNullOrEmpty(vectorWaiver);",
    "",
    "        Exception? vectorFailure = null;",
    "        try",
    "        {",
    "        var baseDir = seam.BaseDir;",
    "        var ctx = new VectorContext",
    "        {",
    "            Contract = contract,",
    "            Operation = operation,",
    "            Vector = vector.DeepClone(),",
    '            Provider = (string?)vector["provider"],',
    '            TargetApi = (string?)vector["targetApi"],',
    "            Doubles = seam.Doubles,",
    "            BaseDir = baseDir,",
    "        };",
    '        var input = ResolveRefs(vector["input"]?.DeepClone(), baseDir);',
    "        JsonNode? Normalize(JsonNode? v) =>",
    "            adapter!.Normalize is null ? v : adapter.Normalize(v, ctx);",
    "",
    '        if (vector.ContainsKey("expectedError"))',
    "        {",
    "            try",
    "            {",
    "                await InvokeAdapter(adapter!, input, ctx, sync, vectorId);",
    "                Assert.Fail(",
    '                    $"{vectorId}: expected the adapter to signal an error, but it " +',
    '                    "returned a value.");',
    "            }",
    "            catch (VectorException err)",
    "            {",
    "                var observed = err.Payload ??",
    "                    new JsonObject { [\"message\"] = err.Message };",
    '                Assert.Equal(Canonical(vector["expectedError"]), Canonical(Normalize(observed)));',
    "            }",
    "        }",
    "        else",
    "        {",
    "            var observed = await InvokeAdapter(adapter!, input, ctx, sync, vectorId);",
    '            Assert.Equal(Canonical(vector["expected"]), Canonical(Normalize(observed)));',
    "        }",
    "        }",
    "        catch (Exception ex)",
    "        {",
    "            vectorFailure = ex;",
    "        }",
    "        if (waived)",
    "        {",
    "            if (vectorFailure != null)",
    "            {",
    "                Console.WriteLine($\"XFAIL {vectorId} (waived: {vectorWaiver})\");",
    "                return;",
    "            }",
    "            Assert.Fail(",
    "                $\"XPASS {vectorId}: waived vector unexpectedly passed; \" +",
    "                $\"remove the waiver ({vectorWaiver}).\");",
    "        }",
    "        if (vectorFailure != null)",
    "            ExceptionDispatchInfo.Capture(vectorFailure).Throw();",
    "    }",
    "}",
    "",
  ].join("\n");
}

/**
 * Emit the thin C# `@vector` conformance harness (`VectorConformanceTests.cs`).
 * It holds no interpreter logic: it loads the runtime-authored registries from
 * the namespace named by the target's `vector-adapter-path` option, assembles a
 * `VectorSeam`, and threads it into `VectorRunner.RunVector` per vector. A vector
 * with no adapter and no explicit waiver is a hard failure — conformance never
 * skips silently. The capability table is injected only when a vector declares
 * `requires`, so requirement-free harnesses regenerate byte-identical.
 */
function emitCSharpVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  testNamespace: string,
  adapterNamespace: string,
): string {
  const model = buildVectorConformanceCodeModel(vectors);
  const hasRequires = model.vectors.some(
    (entry) => (entry.vector.requires?.length ?? 0) > 0,
  );

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    "// Thin @vector behavioral conformance harness. The interpreter lives in the",
    "// sibling VectorRunner file; this suite only loads the runtime-authored seam",
    "// tables from the namespace named by the target's 'vector-adapter-path' option",
    "// and injects them into VectorRunner.RunVector. A vector with no adapter and no",
    "// explicit waiver is a hard failure — conformance never skips silently.",
    "// See docs: reference/vector-conformance.",
    "#nullable enable",
    "using System.IO;",
    "using System.Runtime.CompilerServices;",
    "using System.Text.Json.Nodes;",
    "using System.Threading.Tasks;",
    "using Xunit;",
    `using ${adapterNamespace};`,
    "",
    `namespace ${testNamespace}.Conformance;`,
    "",
    "public class VectorConformanceTests",
    "{",
    "    // Resolves $file/$json vector inputs relative to THIS harness file (computed",
    "    // here, not in the runner, so it points at the test directory).",
    '    private static string BaseDir([CallerFilePath] string path = "") =>',
    '        Path.GetDirectoryName(path) ?? ".";',
    "",
    "    // Assembles the runtime-authored seam the runner interprets. It reads the",
    "    // authored registries from the VectorAdapters class and injects them; the",
    "    // runner itself reads none of these directly.",
    "    private static VectorSeam Seam() =>",
    "        new VectorSeam",
    "        {",
    "            Adapters = VectorAdapters.Adapters(),",
    "            Waivers = VectorAdapters.Waivers(),",
    ...(hasRequires ? ["            Capabilities = VectorAdapters.Capabilities(),"] : []),
    "            Doubles = VectorAdapters.Doubles(),",
    "            BaseDir = BaseDir(),",
    "        };",
    "",
  ];

  model.vectors.forEach((entry, index) => {
    const vectorJSON = jsonAsciiEscape(JSON.stringify(entry.vector, null, 2));
    lines.push("    [Fact]");
    lines.push(`    public async Task ${csharpVectorSlug(index, entry)}()`);
    lines.push("    {");
    lines.push('        string vectorJson = """');
    for (const line of vectorJSON.split("\n")) {
      lines.push(line);
    }
    lines.push('""";');
    lines.push(
      "        var vector = JsonNode.Parse(vectorJson) as JsonObject ?? new JsonObject();",
    );
    lines.push(
      `        await VectorRunner.RunVector(${JSON.stringify(entry.contract)}, ${JSON.stringify(
        entry.operation,
      )}, vector, ${entry.sync ? "true" : "false"}, Seam()${
        entry.dispatch ? `, ${JSON.stringify(entry.dispatch.path)}` : ""
      });`,
    );
    lines.push("    }");
    lines.push("");
  });
  lines.push("}");
  return lines.join("\n");
}

/**
 * PascalCase a `@vector` name (which may contain hyphens/spaces/dots) into a
 * unique, legal C# `[Fact]` method identifier — the typed twin of the
 * conversion-test method names. Falls back to a positional slug when a name is
 * absent or reduces to nothing, so emission stays total and deterministic.
 */
function csharpConformanceMethodName(name: string | undefined, index: number): string {
  const slug = (name ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  if (slug.length === 0) return `Vector${index}`;
  return /^[0-9]/.test(slug) ? `Vector${slug}` : slug;
}

/**
 * Ensure a `[Fact]` method identifier is unique within one conformance file.
 * On a collision, append a `_N` disambiguator (deterministic in emission order)
 * so distinct vectors never collapse to the same C# method.
 */
function uniqueMethodName(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}_${count + 1}`;
}

/**
 * Render the TYPED discriminator accessor the [Fact] reads to route a vector —
 * the behavioral twin of how the shape `Load` switch reaches its discriminator.
 * The first path segment is the operation parameter (a local built via
 * `FromJson`); the remaining segments are the emitted models' PascalCase
 * properties (e.g. `agent.template.format.kind` -> `agent.Template.Format.Kind`).
 */
function csharpDiscriminatorAccessor(path: string): string {
  const segments = path.split(".");
  const [head, ...rest] = segments;
  return [head, ...rest.map((segment) => toPascalCase(segment))].join(".");
}

/**
 * Emit the Part III TYPED per-interface conformance suite for one dispatched
 * seam — the `@vector` twin of the per-model `${Type}ConversionTests` file
 * (issue #282 §8). Where the monolithic `VectorConformanceTests` feeds the JSON
 * interpreter a stringly `Contract.operation#value` route, this suite is fully
 * typed: each `[Fact]` builds the operation inputs from the vector JSON via the
 * emitted models' `FromJson`, reads the SAME discriminator the shape `Load`
 * switch reads (through the typed accessor chain), routes it through the emitted
 * `${Interface}Resolver.Resolve` against a consumer-attached provider, invokes
 * the typed seam method, and asserts the result reproduces `expected`.
 *
 * The provider VALUE is authored by the consumer OUTSIDE the conformance tree —
 * a static `VectorProviders.${Interface}()` accessor returning the generated
 * `I${Interface}Provider` — so a dropped `@dispatch` slot fails to COMPILE (§5
 * control 2). Only the `[Fact]`s are emitted here; the resolver + provider TYPE
 * live in the colocated `${Interface}Resolver` file.
 */
function emitCSharpInterfaceConformanceTest(
  dispatched: DispatchedContract,
  entries: CallableVectorSnapshotEntry[],
  testNamespace: string,
  adapterNamespace: string,
): string {
  const provider = `I${dispatched.contract}Provider`;
  const resolver = `${dispatched.contract}Resolver`;
  const field = dispatched.decl.discriminatorField;
  // §8.5: sort by vector name so regen is byte-stable regardless of snapshot order.
  const sorted = [...entries].sort((left, right) =>
    (left.vector.name ?? "").localeCompare(right.vector.name ?? ""),
  );
  // Disambiguate [Fact] method names within the file: two vector names that
  // PascalCase to the same identifier (e.g. `foo-bar` / `foo bar`) would emit
  // duplicate C# methods and fail to compile.
  const seenMethods = new Map<string, number>();

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    `// Part III TYPED @vector conformance for ${dispatched.contract} — the per-interface`,
    "// twin of the per-model ConversionTests file (issue #282 §8). Each [Fact] builds",
    "// the operation inputs from the vector JSON, reads the shape discriminator, routes",
    `// it through the emitted ${resolver} against the consumer-attached provider, invokes`,
    "// the typed seam, and asserts the result reproduces `expected`. The provider VALUE",
    `// is authored by the consumer as VectorProviders.${dispatched.contract}() in the`,
    "// namespace named by 'vector-adapter-path' — a dropped @dispatch slot fails to",
    "// compile, so conformance never silently skips.",
    "// See docs: reference/vector-conformance.",
    "#nullable enable",
    "using System.Text.Json;",
    "using System.Threading.Tasks;",
    "using Xunit;",
    `using ${adapterNamespace};`,
    "",
    `namespace ${testNamespace};`,
    "",
    `public class ${dispatched.contract}ConformanceTests`,
    "{",
    "    // The consumer-attached provider of typed seam impls, one slot per @dispatch",
    "    // variant. Authored outside this tree; a forgotten slot cannot compile.",
    `    private static ${provider} Provider() => VectorProviders.${dispatched.contract}();`,
    "",
  ];

  sorted.forEach((entry, index) => {
    assertTypedDispatchSupported(entry);
    const method = entry.sync
      ? toPascalCase(entry.operation)
      : `${toPascalCase(entry.operation)}Async`;
    const accessor = csharpDiscriminatorAccessor(entry.dispatch!.path);
    const paramNames = Object.keys(entry.params);
    const inputJSON = jsonAsciiEscape(
      JSON.stringify(entry.vector.input ?? {}, null, 2),
    );
    const expected = entry.vector.expected;

    lines.push("    [Fact]");
    lines.push(
      `    public ${entry.sync ? "void" : "async Task"} ${uniqueMethodName(
        csharpConformanceMethodName(entry.vector.name, index),
        seenMethods,
      )}()`,
    );
    lines.push("    {");
    lines.push('        string inputJson = """');
    for (const line of inputJSON.split("\n")) {
      lines.push(line);
    }
    lines.push('""";');
    lines.push("        using var document = JsonDocument.Parse(inputJson);");
    lines.push("        var root = document.RootElement;");
    for (const paramName of paramNames) {
      const paramType = entry.params[paramName];
      const shape = classifyCallableParam(paramType);
      const key = JSON.stringify(paramName);
      if (shape.bareModel) {
        lines.push(
          `        var ${paramName} = ${paramType}.FromJson(root.GetProperty(${key}).GetRawText());`,
        );
      } else if (shape.optional) {
        // Optional non-model param: tolerate an absent property, decoding into
        // the mapped (nullable) C# type when present.
        lines.push(
          `        var ${paramName} = root.TryGetProperty(${key}, out var ${paramName}El)`,
          `            ? JsonSerializer.Deserialize<${protocolCSharpType(paramType)}>(${paramName}El.GetRawText())`,
          `            : default;`,
        );
      } else {
        // Non-model param (scalar, `Record<unknown>`, array) decoded into the
        // mapped C# type the seam signature expects.
        lines.push(
          `        var ${paramName} = JsonSerializer.Deserialize<${protocolCSharpType(
            paramType,
          )}>(root.GetProperty(${key}).GetRawText());`,
        );
      }
    }
    lines.push(`        var ${field} = ${accessor};`);
    lines.push(
      `        var impl = ${resolver}.Resolve(${field}, Provider());`,
    );
    lines.push(
      `        Assert.NotNull(impl);`,
    );
    const call = `impl!.${method}(${paramNames.join(", ")})`;
    if (entry.sync) {
      lines.push(`        var actual = ${call};`);
    } else {
      lines.push(`        var actual = await ${call};`);
    }
    if (typeof expected === "string") {
      lines.push(`        Assert.Equal(${JSON.stringify(expected)}, actual);`);
    } else {
      // No scalar `expected` to compare (e.g. an `expectedError` vector): the
      // typed invocation itself is the assertion — reaching here means the route
      // resolved and the seam ran without throwing. A dispatched fixture that
      // needs richer comparison will extend this arm (reproduce-before-fix).
      lines.push("        Assert.NotNull(actual);");
    }
    lines.push("    }");
    lines.push("");
  });

  lines.push("}");
  return lines.join("\n");
}

/**
 * Emit the Category 1 (issue #511) typed `@vector` conformance entrypoint for
 * plain (undispatched) scalar seams. Unlike the stringly `VectorRunner` +
 * per-op marshalling double, this file lives in the LIBRARY and takes the
 * consumer's REAL typed seam impl (typed as the emitted `I<Seam>` interface),
 * so a forgotten op cannot compile. Each seam gets one
 * `Run<Seam>Conformance[Async]` method that inlines its vectors, decodes the
 * scalar inputs from the vector JSON, calls the seam method directly, and
 * asserts the result reproduces `expected` (or that an `expectedError` was
 * thrown). Emitted additively; scalar-only so the real surface is untouched.
 */
function emitCSharpVectorConformanceEntrypoint(
  entries: CallableVectorSnapshotEntry[],
  namespace: string,
): string {
  const bySeam = new Map<string, CallableVectorSnapshotEntry[]>();
  for (const entry of entries) {
    if (!bySeam.has(entry.contract)) bySeam.set(entry.contract, []);
    bySeam.get(entry.contract)!.push(entry);
  }

  // Render a value's JSON as a C# string literal. JSON string escaping is a
  // subset of C#'s (`\"`, `\\`, `\n`, `\uXXXX` all valid), so double-stringify.
  const jsonLiteral = (value: unknown): string =>
    JSON.stringify(JSON.stringify(value ?? null));

  const seamNames = [...bySeam.keys()].sort();
  // Array-of-model params/returns build `List<Model>` locals and enumerate
  // `JsonElement` arrays, so pull in the collections + LINQ-free helpers only
  // when such a seam is present (keeps unused-using-free on scalar/model-only
  // surfaces).
  const hasModelArray = entries.some((entry) =>
    [...Object.values(entry.params), entry.returns].some((type) => {
      const shape = classifyCallableParam(type);
      return shape.array && shape.isModel && !shape.optional;
    }),
  );
  const usings = [
    "using System;",
    ...(hasModelArray ? ["using System.Collections.Generic;"] : []),
    "using System.Text.Json;",
    "using System.Text.Json.Nodes;",
    "using System.Threading.Tasks;",
  ];
  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Copyright (c) Microsoft. All rights reserved.",
    "// WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "//",
    "// Typed @vector conformance entrypoints (issue #511 Cat 1). Each method",
    "// takes a consumer's REAL typed seam impl and runs the seam's baked-in",
    "// vectors by calling methods directly -- the idiomatic replacement for the",
    "// stringly VectorRunner registry + per-op marshalling double. Typing the",
    "// parameter as the emitted I<Seam> interface lets the compiler enforce op",
    "// completeness, rather than a runtime map lookup. Emitted additively beside",
    "// the stringly runner.",
    "// See docs: reference/vector-conformance.",
    "#nullable enable",
    ...usings,
    "",
    `namespace ${namespace};`,
    "",
    "public static class VectorConformance",
    "{",
    "    // Canonicalize JSON text so structural compares ignore incidental",
    "    // formatting (whitespace, member order is irrelevant for scalars).",
    "    private static string Canonical(string json) =>",
    "        JsonNode.Parse(json)?.ToJsonString() ?? \"null\";",
    "",
  ];

  seamNames.forEach((seam) => {
    const seamEntries = [...bySeam.get(seam)!].sort((left, right) =>
      (left.vector.name ?? "").localeCompare(right.vector.name ?? ""),
    );
    const isAsync = seamEntries.some((entry) => !entry.sync);
    const fn = isAsync
      ? `Run${toPascalCase(seam)}ConformanceAsync`
      : `Run${toPascalCase(seam)}Conformance`;
    const signature = isAsync
      ? `    public static async Task ${fn}(I${seam} seam)`
      : `    public static void ${fn}(I${seam} seam)`;

    lines.push(
      `    /// <summary>Typed @vector conformance for ${seam}. Pass your real`,
      `    /// ${seam} impl; the I${seam} parameter proves every op is`,
      `    /// implemented at compile time.</summary>`,
      signature,
      "    {",
    );

    seamEntries.forEach((entry) => {
      const method = entry.sync
        ? toPascalCase(entry.operation)
        : `${toPascalCase(entry.operation)}Async`;
      const paramNames = Object.keys(entry.params);
      const label = entry.vector.name ?? entry.operation;
      const input = (entry.vector.input ?? {}) as Record<string, unknown>;
      const awaitPrefix = entry.sync ? "" : "await ";
      const hasExpectedError = entry.vector.expectedError !== undefined;

      lines.push("        {");
      lines.push(`            // vector: ${label}`);
      for (const paramName of paramNames) {
        const shape = classifyCallableParam(entry.params[paramName]);
        if (shape.bareModel) {
          // A model param in the `@serializable` closure decodes via the emitted
          // wire-correct `<Model>.FromJson(...)`; System.Text.Json would mismatch
          // the model's PascalCase properties against the lowercase wire shape.
          lines.push(
            `            var ${paramName} = ${shape.base}.FromJson(${jsonLiteral(
              input[paramName] ?? null,
            )});`,
          );
        } else if (shape.array && shape.isModel && !shape.optional) {
          // An array-of-model param decodes element-wise through the same
          // wire-correct `<Model>.FromJson(...)` into a `List<Model>` (the seam
          // signature's collection type) — enumerate the JSON array, no LINQ.
          lines.push(
            `            var ${paramName} = new List<${shape.base}>();`,
            `            foreach (var __item in JsonSerializer.Deserialize<JsonElement>(${jsonLiteral(
              input[paramName] ?? null,
            )}).EnumerateArray())`,
            "            {",
            `                ${paramName}.Add(${shape.base}.FromJson(__item.GetRawText()));`,
            "            }",
          );
        } else {
          // A required scalar param decodes into the seam's non-null type; the
          // deserializer's return is nullable, so null-forgive it (optional params
          // keep the nullable local the seam signature already expects).
          const forgive = shape.optional ? "" : "!";
          lines.push(
            `            var ${paramName} = JsonSerializer.Deserialize<${protocolCSharpType(
              entry.params[paramName],
            )}>(${jsonLiteral(input[paramName] ?? null)})${forgive};`,
          );
        }
      }
      const call = `${awaitPrefix}seam.${method}(${paramNames.join(", ")})`;
      const returnShape = classifyCallableParam(entry.returns);
      const returnsModel = returnShape.bareModel;
      const returnsModelArray =
        returnShape.array && returnShape.isModel && !returnShape.optional;

      if (hasExpectedError) {
        lines.push("            Exception? caught = null;");
        lines.push("            try");
        lines.push("            {");
        lines.push(`                ${call};`);
        lines.push("            }");
        lines.push("            catch (Exception error)");
        lines.push("            {");
        lines.push("                caught = error;");
        lines.push("            }");
        lines.push(
          `            if (caught is null) throw new SeamConformanceException(${JSON.stringify(
            `${label}: expected an error`,
          )});`,
        );
        if (typeof entry.vector.expectedError === "string") {
          lines.push(
            `            if (!caught.Message.Contains(${JSON.stringify(
              entry.vector.expectedError,
            )})) throw new SeamConformanceException(${JSON.stringify(
              `${label}: error message mismatch`,
            )});`,
          );
        }
      } else {
        lines.push(`            var actual = ${call};`);
        if (entry.vector.expected !== undefined) {
          // A model return serializes through the emitted wire-correct
          // `actual.ToJson()`; an array-of-model return serializes each element
          // the same way into a JSON array; a scalar return goes through
          // System.Text.Json.
          let serialized: string;
          if (returnsModelArray) {
            lines.push(
              "            var __parts = new List<string>();",
              "            foreach (var __item in actual)",
              "            {",
              "                __parts.Add(__item.ToJson());",
              "            }",
              '            var __serialized = "[" + string.Join(",", __parts) + "]";',
            );
            serialized = "__serialized";
          } else {
            serialized = returnsModel
              ? "actual.ToJson()"
              : "JsonSerializer.Serialize(actual)";
          }
          lines.push(
            `            if (Canonical(${serialized}) != Canonical(${jsonLiteral(
              entry.vector.expected,
            )}))`,
            `                throw new SeamConformanceException(${JSON.stringify(
              `${label} misrouted`,
            )});`,
          );
        } else {
          lines.push(
            `            if (actual is null) throw new SeamConformanceException(${JSON.stringify(
              `${label}: expected a result`,
            )});`,
          );
        }
      }
      lines.push("        }");
    });

    lines.push("    }");
    lines.push("");
  });

  lines.push("}");
  lines.push("");
  lines.push(
    "/// <summary>Thrown by an emitted conformance entrypoint when a vector's",
    "/// expectation is not met.</summary>",
    "public sealed class SeamConformanceException : Exception",
    "{",
    "    public SeamConformanceException(string message) : base(message) { }",
    "}",
  );
  return lines.join("\n");
}


/**
 * Emit the Part III C# dispatch resolver for one seam interface — the behavioral
 * twin of the shape `Load` switch (`emitter.ts:1081`). Where `Load` maps a
 * discriminator value to a constructed SHAPE, this maps it to a selected
 * BEHAVIOR (`I<Seam>` impl) read from a generated provider whose members ARE the
 * `dispatch.variants`. Because the provider surface is generated from the same
 * variant list, a consumer that forgets to DECLARE a slot fails to COMPILE
 * (missing interface member) — the strongest form of issue #282 §5 control 2.
 *
 * Members are nullable so a consumer can signal a valid-but-unimplemented
 * variant by returning null; the conformance harness then does an explicit skip
 * (§3.1) rather than a silent registration miss. This is compile-time *slot*
 * completeness, not implementation completeness — every slot present as `null`
 * still compiles, by design.
 *
 * The unknown-value arm mirrors the SHAPE switch's precedence
 * (`emitter.ts:1090`): shape falls back to a default/carrier SUBTYPE or throws
 * on a closed/abstract base. Behavioral dispatch has no "base implementation" to
 * fall back to, so a default/open dispatch yields `null` (explicit skip) while a
 * closed or abstract base throws — the same reject-vs-fallback decision, adapted
 * to the fact that a resolver selects an impl rather than constructing a value.
 */
function emitCSharpDispatchResolver(
  entry: DispatchedContract,
  seamNamespace: string,
): string {
  const seam = `I${entry.contract}`;
  const provider = `I${entry.contract}Provider`;
  const resolver = `${entry.contract}Resolver`;
  const field = entry.decl.discriminatorField;
  // Preserve the SAME variant order the shape `Load` switch emits
  // (`emitter.ts:1084` iterates `dispatch.variants` directly). Sharing the IR
  // order keeps the two switches a faithful twin and is deterministic without a
  // locale-dependent comparator.
  const variants = entry.decl.variants;
  // Closed (no fallback, no default): an unknown discriminator is a hard error,
  // exactly as the shape LoadKind switch throws. An open or default dispatch
  // yields null (harness explicit-skip) — and an abstract-open base routes
  // unknowns to a carrier in the shape loader, never throwing, so a bare
  // `isClosedPolymorphicDispatch` is the faithful twin of that throw arm.
  const rejectsUnknown = isClosedPolymorphicDispatch(entry.decl);
  // An open dispatch with a declared wildcard child (`CustomModel { provider:
  // "*" }`) gains a default provider slot; an unknown discriminator routes to it
  // instead of yielding null — the behavioral twin of the shape loader's
  // `*`-tolerant fallback. Closed / open-self-reference keeps its throw/null arm.
  const defaultSlotBase = dispatchDefaultSlotBase(entry.decl);
  const defaultSlot = defaultSlotBase ? toPascalCase(defaultSlotBase) : null;

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    `// Part III behavioral @dispatch resolver for ${seam} — the twin of the shape`,
    "// Load switch, emitted into the library beside the seam interface. The",
    "// provider surface below has one slot per @dispatch variant; a consumer",
    "// attaches concrete impls by satisfying it in an external, non-emitted file,",
    "// so a forgotten slot fails to compile.",
    "// See docs: reference/vector-conformance.",
    "#nullable enable",
    "using System;",
    "",
    `namespace ${seamNamespace};`,
    "",
    `/// <summary>`,
    `/// Consumer-attached provider of ${seam} impls, one slot per @dispatch`,
    `/// variant. Nullable: return null to signal a valid-but-unimplemented variant`,
    `/// to the caller (e.g. the conformance harness skips it), never a silent miss.`,
    `/// </summary>`,
    `public interface ${provider}`,
    "{",
  ];
  // Slot names are the PascalCase of the discriminator value. Every fixture
  // value today is a plain identifier (mustache/jinja2/liquid); non-identifier
  // values (leading digit, C# keyword, punctuation) would need a sanitizer +
  // collision guard. Deferred until a fixture exercises one (reproduce-before-fix).
  for (const variant of variants) {
    lines.push(
      `    ${seam}? ${toPascalCase(variant.value)} { get; }`,
    );
  }
  if (defaultSlot) {
    lines.push(
      `    /// <summary>Catch-all for an unknown discriminator (the declared '*' child).</summary>`,
    );
    lines.push(`    ${seam}? ${defaultSlot} { get; }`);
  }
  lines.push("}");
  lines.push("");
  lines.push(`/// <summary>`);
  lines.push(
    `/// Maps a '${field}' discriminator value to the selected ${seam} impl — the`,
  );
  lines.push(`/// behavioral twin of the shape Load switch.`);
  lines.push(`/// </summary>`);
  lines.push(`public static class ${resolver}`);
  lines.push("{");
  lines.push(
    `    public static ${seam}? Resolve(string ${field}, ${provider} registry) =>`,
  );
  lines.push(`        ${field} switch`);
  lines.push("        {");
  for (const variant of variants) {
    lines.push(
      `            ${JSON.stringify(variant.value)} => registry.${toPascalCase(
        variant.value,
      )},`,
    );
  }
  if (rejectsUnknown) {
    lines.push(
      `            _ => throw new ArgumentException($"Unknown ${entry.contract} discriminator '${field}' value: {${field}}"),`,
    );
  } else if (defaultSlot) {
    lines.push(`            _ => registry.${defaultSlot},`);
  } else {
    lines.push("            _ => null,");
  }
  lines.push("        };");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

function formatCSharpFiles(outputDir: string, testDir?: string): void {
  const dirs = [outputDir, ...(testDir ? [testDir] : [])];
  const formatted = new Set<string>();

  for (const dir of dirs) {
    const projectRoot = findDotNetProjectRoot(dir);
    if (!projectRoot) {
      console.warn(
        `Warning: Could not find .csproj or .sln file for ${dir}. Skipping formatting.`,
      );
      continue;
    }

    // Avoid formatting the same project twice
    if (formatted.has(projectRoot)) {
      continue;
    }
    formatted.add(projectRoot);

    try {
      execFileSync("dotnet", ["format", projectRoot], {
        cwd: dirname(projectRoot),
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (error) {
      console.warn(
        `Warning: dotnet format failed for ${projectRoot}. You may need to run it manually.`,
      );
    }
  }
}

/**
 * Find the .NET project root by traversing up from the output directory
 * looking for .csproj or .sln files.
 */
function findDotNetProjectRoot(startDir: string): string | undefined {
  let currentDir = resolve(startDir);
  const root = resolve("/");

  // On Windows, also check for drive root (e.g., "C:\")
  while (currentDir !== root && currentDir !== dirname(currentDir)) {
    // First check for .csproj (more specific)
    const files = existsSync(currentDir) ? readdirSync(currentDir) : [];
    const csprojFile = files.find((f: string) => f.endsWith(".csproj"));
    if (csprojFile) {
      return resolve(currentDir, csprojFile);
    }

    // Then check for .sln
    const slnFile = files.find((f: string) => f.endsWith(".sln"));
    if (slnFile) {
      return resolve(currentDir, slnFile);
    }

    currentDir = dirname(currentDir);
  }

  return undefined;
}
