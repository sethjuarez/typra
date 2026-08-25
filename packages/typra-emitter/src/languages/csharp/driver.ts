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
import { lowerType, collectPolymorphicTypeNames } from "../../ir/lower.js";
import {
  emitCSharpClass,
  emitCSharpEnum,
  isCSharpSinglePrecision,
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
  const allTypeDecls = nodes.map((nd) => lowerType(nd, registry, polyNames));
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
    const typeDecl = lowerType(n, registry, polyNames);
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
    await emitCsharpFile(
      context,
      node,
      emitCSharpVectorConformanceTest(
        options!.callableVectors!,
        csharpNamespace,
        emitTarget["vector-adapter-path"] ?? `${csharpNamespace}.Conformance`,
      ),
      "VectorConformanceTests.cs",
      emitTarget["test-dir"],
      emitTarget["test-dir"],
    );
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
 * Emit the C# closed-loop `@vector` behavioral conformance suite (xUnit). Each
 * vector is replayed through a runtime-authored `VectorAdapters` registry in the
 * namespace named by the target's `vector-adapter-path` option. A vector with no
 * adapter and no explicit waiver is a hard `Assert.Fail` — this suite never skips
 * silently; an explicit non-empty waiver becomes a visible `Console.WriteLine`
 * marker and a passing test (xUnit v2 has no runtime skip).
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
    "// Enforced @vector behavioral conformance. Each vector is replayed through a",
    "// runtime-authored VectorAdapters registry in the namespace named by the",
    "// target's 'vector-adapter-path' option. A vector with no adapter and no",
    "// explicit waiver is a hard failure — this suite never skips silently.",
    "//",
    "// Adapter contract: Invoke may return either a plain JsonNode (as object?) or a",
    "// Task/ValueTask that resolves to one. The harness awaits the result before",
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
    "using System.IO;",
    "using System.Linq;",
    "using System.Runtime.CompilerServices;",
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
    "public class VectorConformanceTests",
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
    '    private static string BaseDir([CallerFilePath] string path = "") =>',
    '        Path.GetDirectoryName(path) ?? ".";',
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
    "    private static async Task RunVector(string contract, string operation, JsonObject vector, bool sync)",
    "    {",
    '        var operationKey = $"{contract}.{operation}";',
    '        var vectorName = (string?)vector["name"] ?? "unnamed";',
    '        var vectorId = $"{operationKey}:{vectorName}";',
    "",
    "        var adapters = VectorAdapters.Adapters();",
    "        if (!adapters.TryGetValue(operationKey, out var adapter) &&",
    "            !adapters.TryGetValue(operation, out adapter))",
    "        {",
    "            var waivers = VectorAdapters.Waivers();",
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
    ...(hasRequires
      ? [
          "        // Requirement guard: a vector may declare abstract capability tokens in",
          "        // \"requires\". Each is resolved against the runtime-supplied Capabilities()",
          "        // table BEFORE the adapter runs. An unregistered token is a hard failure",
          "        // (never skip silently); an unavailable one yields a clean skip so an",
          "        // absent credential never reaches Invoke as an empty value.",
          "        var requires = (vector[\"requires\"] as JsonArray)?",
          "            .Select(node => (string?)node)",
          "            .Where(token => token is not null)",
          "            .Select(token => token!)",
          "            .ToList() ?? new List<string>();",
          "        if (requires.Count > 0)",
          "        {",
          "            var capabilities = VectorAdapters.Capabilities();",
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
          "                Doubles = VectorAdapters.Doubles(),",
          "                BaseDir = BaseDir(),",
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
        ]
      : []),
    "        // Per-vector waiver, consulted even when an adapter IS registered. Keyed",
    "        // by the vector id (\"Contract.operation:name\") or \"operation:name\" so it",
    "        // never collides with an operation-level waiver. xfail: a waived vector",
    "        // that fails is an expected failure (green); xpass: a waived vector that",
    "        // passes is surfaced as a hard failure so stale waivers get removed.",
    "        var vectorWaivers = VectorAdapters.Waivers();",
    "        if (!vectorWaivers.TryGetValue(vectorId, out var vectorWaiver))",
    "            vectorWaivers.TryGetValue($\"{operation}:{vectorName}\", out vectorWaiver);",
    "        var waived = !string.IsNullOrEmpty(vectorWaiver);",
    "",
    "        Exception? vectorFailure = null;",
    "        try",
    "        {",
    "        var baseDir = BaseDir();",
    "        var ctx = new VectorContext",
    "        {",
    "            Contract = contract,",
    "            Operation = operation,",
    "            Vector = vector.DeepClone(),",
    '            Provider = (string?)vector["provider"],',
    '            TargetApi = (string?)vector["targetApi"],',
    "            Doubles = VectorAdapters.Doubles(),",
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
      `        await RunVector(${JSON.stringify(entry.contract)}, ${JSON.stringify(
        entry.operation,
      )}, vector, ${entry.sync ? "true" : "false"});`,
    );
    lines.push("    }");
    lines.push("");
  });
  lines.push("}");
  return lines.join("\n");
}

/**
 * Format C# files using dotnet format.
 * Runs formatter from the .NET project root (where .csproj or .sln is located).
 */
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
