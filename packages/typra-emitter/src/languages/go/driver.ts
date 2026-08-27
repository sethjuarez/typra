import { EmitContext, resolvePath } from "@typespec/compiler";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { EmitTarget, TypraEmitterOptions } from "../../lib.js";
import { BaseTestContext, enumerateTypes, TypeNode } from "../../ir/ast.js";
import { GeneratorOptions, filterNodes } from "../../emitter.js";
import {
  resolveCustomFormatters,
  runCustomFormatters,
} from "../formatter-runner.js";

import {
  buildBaseTestContext,
  goTestOptions,
} from "../../testing/test-context.js";
import { toSnakeCase } from "../../ir/utilities.js";
import { TypeRegistry } from "../../ir/expansion.js";
import { GoExprVisitor } from "./visitor.js";
import {
  lowerFile,
  lowerType,
  collectPolymorphicTypeNames,
} from "../../ir/lower.js";
import { emitGoFileContent, protocolGoType } from "./emitter.js";
import { formatGoSource } from "./go-format.js";
import { emitGoContext } from "./scaffolding.js";
import { emitGoTest } from "./test-emitter.js";
import { buildGoFieldNames } from "./identifiers.js";
import { emitGeneratedFile } from "../../cleanup/generated-file.js";
import { projectNamespace } from "../../ir/namespace.js";
import { buildVectorConformanceCodeModel } from "../../ir/code-model.js";
import { goFieldName } from "./identifiers.js";
import {
  isClosedPolymorphicDispatch,
  dispatchDefaultSlotBase,
} from "../../ir/declarations.js";
import {
  assertTypedDispatchSupported,
  CallableVectorSnapshotEntry,
  collectDispatchedContracts,
  DispatchedContract,
  isTypedDispatchEntry,
  classifyCallableParam,
} from "../../ir/vector.js";
import {
  collectProtocolNodes,
  emitGoProtocolScaffolds,
  shouldEmitCompileOnlyProtocolScaffolds,
} from "../../protocol-scaffolds.js";

/**
 * Type mapping from TypeSpec scalar types to Go types.
 */
export const goTypeMapper: Record<string, string> = {
  string: "string",
  number: "float64",
  array: "[]",
  object: "map[string]interface{}",
  boolean: "bool",
  int64: "int64",
  int32: "int32",
  float64: "float64",
  float32: "float32",
  integer: "int",
  float: "float64",
  numeric: "float64",
  any: "interface{}",
  dictionary: "map[string]interface{}",
};

/**
 * Main entry point for Go code generation.
 */
export const generateGo = async (
  context: EmitContext<TypraEmitterOptions>,
  node: TypeNode,
  emitTarget: EmitTarget,
  options?: GeneratorOptions,
): Promise<void> => {
  const allTypes = Array.from(enumerateTypes(node));
  const nodes = filterNodes(allTypes, options);

  // Build the expression IR infrastructure
  const registry = TypeRegistry.fromTypeGraph(allTypes);
  const visitor = new GoExprVisitor(registry);

  const namespaceProjection = projectNamespace({
    target: "go",
    sourceNamespace: node.typeName.namespace,
    semanticRoot: options?.rootNamespace,
    emitTarget,
  });
  const packageName = namespaceProjection.packageName!;

  // Collect all polymorphic type names across all nodes
  const polymorphicTypeNames = new Set<string>();
  const scalarCoercibleTypeNames = new Set<string>();
  for (const n of nodes) {
    const polyTypes = n.retrievePolymorphicTypes();
    if (polyTypes) {
      polymorphicTypeNames.add(n.typeName.name);
    }
    if (n.coercions.length > 0) {
      scalarCoercibleTypeNames.add(n.typeName.name);
    }
  }
  const declarationUniverse = nodes.map((n) =>
    lowerType(n, registry, polymorphicTypeNames),
  );

  // Emit context file (LoadContext/SaveContext utilities)
  const contextContent = emitGoContext({
    header: "Typra Context",
    packageName,
  });
  await emitGoFile(
    context,
    "context.go",
    contextContent,
    emitTarget["output-dir"],
  );

  // Emit each base type and its children as a single file (Go stays flat — no subfolders)
  for (const n of nodes) {
    // Skip child types - they're rendered with their parent
    if (!n.base) {
      const fileDecl = lowerFile(n, registry, polymorphicTypeNames);
      // Go stays flat: pass group as a header comment only, no subfolder emission
      const fileContent = emitGoFileContent(
        fileDecl.types,
        packageName,
        visitor,
        polymorphicTypeNames,
        fileDecl.enums,
        n.group || "",
        scalarCoercibleTypeNames,
        declarationUniverse,
      );
      const fileName = toSnakeCase(n.typeName.name) + ".go";
      await emitGoFile(
        context,
        fileName,
        fileContent,
        emitTarget["output-dir"],
        emitTarget["output-dir"],
      );
    }

    // Emit test file for each type (skip protocols — they have no data to test)
    if (emitTarget["test-dir"] && !n.isProtocol) {
      const importPath = emitTarget["import-path"] || packageName;
      const fieldNames = buildGoFieldNames(
        collectInheritedPropertyNames(n, registry),
      );
      const testContext = {
        ...buildTestContext(n, packageName, registry),
        importPath,
        fieldNames,
      };
      const testContent = emitGoTest(testContext);
      const testFileName = toSnakeCase(n.typeName.name) + "_test.go";
      await emitGoFile(
        context,
        testFileName,
        testContent,
        emitTarget["test-dir"],
        emitTarget["test-dir"],
      );
    }
  }

  // Part III: emit one behavioral @dispatch resolver per dispatched seam into
  // the LIBRARY (issue #282), the twin of the shape discriminator load switch.
  // Go has no compile-time completeness for an interface set, so enforcement is
  // runtime: a typed provider struct plus a NewXProvider collection guard that
  // errors when a consumer omits a variant slot (a forgotten attachment cannot
  // silently skip), and a ResolveX switch that errors on an unknown
  // discriminator. NOTE: emission currently rides the presence of @vector cases;
  // decoupling it is a tracked follow-up (issue #282).
  if ((options?.callableVectors?.vectors.length ?? 0) > 0) {
    for (const dispatched of collectDispatchedContracts(
      options!.callableVectors!.vectors,
    )) {
      await emitGoFile(
        context,
        toSnakeCase(dispatched.contract) + "_resolver.go",
        emitGoDispatchResolver(dispatched, packageName),
        emitTarget["output-dir"],
        emitTarget["output-dir"],
      );
    }
  }

  if (
    emitTarget["test-dir"] &&
    shouldEmitCompileOnlyProtocolScaffolds(emitTarget)
  ) {
    const importPath = emitTarget["import-path"] || packageName;
    const scaffoldContent = emitGoProtocolScaffolds(
      collectProtocolNodes(nodes),
      packageName,
      importPath,
    );
    await emitGoFile(
      context,
      "protocol_scaffolds_test.go",
      scaffoldContent,
      emitTarget["test-dir"],
      emitTarget["test-dir"],
    );
  }

  if (
    emitTarget["test-dir"] &&
    (options?.callableVectors?.vectors.length ?? 0) > 0
  ) {
    const adapterImportPath =
      emitTarget["vector-adapter-path"] ?? "vectoradapters";
    const runnerImportPath = goVectorRunnerImportPath(adapterImportPath);
    const importPath = emitTarget["import-path"] || packageName;
    const allVectors = options!.callableVectors!.vectors;
    // A `@dispatch` seam routes through the typed resolver rail (issue #282 §8):
    // its vectors get a per-interface, typed `${iface}_conformance_test.go` file
    // in the seam's package. Undispatched seams — INCLUDING a @dispatch whose
    // discriminator model is not polymorphic (no `decl`, so no typed rail) — keep
    // the stringly JSON interpreter (vectorrunner) + monolithic
    // vector_conformance_test.go, so no vector is dropped from both rails.
    const undispatched = allVectors.filter(
      (entry) => !isTypedDispatchEntry(entry),
    );

    if (undispatched.length > 0) {
      // The shared runner is its own importable package (`vectorrunner`). A Go
      // directory may hold only one non-test package, so the runner cannot be a
      // sibling FILE of the harness the way it is on every other target — it is a
      // sibling PACKAGE of the runtime-authored `vectoradapters` package, emitted
      // under the module root so it resolves alongside it.
      await emitGoFile(
        context,
        "vector_runner.go",
        emitGoVectorRunner(adapterImportPath),
        resolvePath(emitTarget["output-dir"] ?? "vectorrunner", "vectorrunner"),
        emitTarget["output-dir"],
      );

      await emitGoFile(
        context,
        "vector_conformance_test.go",
        emitGoVectorConformanceTest(
          { ...options!.callableVectors!, vectors: undispatched },
          packageName,
          adapterImportPath,
          runnerImportPath,
        ),
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
      // §8.5: never emit an empty conformance file — but the resolver above is
      // still emitted for a zero-vector dispatched seam so control 2 keeps biting.
      if (ifaceVectors.length === 0) continue;
      await emitGoFile(
        context,
        `${toSnakeCase(dispatched.contract)}_conformance_test.go`,
        emitGoInterfaceConformanceTest(
          dispatched,
          ifaceVectors,
          packageName,
          importPath,
          adapterImportPath,
        ),
        emitTarget["test-dir"],
        emitTarget["test-dir"],
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
      formatGoFiles(outputDir, testDir);
    }
  }
};

/**
 * Format Go files using gofmt and goimports.
 */
function formatGoFiles(outputDir: string, testDir?: string): void {
  const dirs = [outputDir, ...(testDir ? [testDir] : [])];

  for (const dir of dirs) {
    // Run gofmt — use execFileSync to avoid shell injection
    try {
      execFileSync("gofmt", ["-w", dir], {
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (error) {
      console.warn(
        `Warning: gofmt formatting failed for ${dir}. You may need to install Go.`,
      );
    }

    // Run goimports if available
    try {
      execFileSync("goimports", ["-w", dir], {
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (error) {
      // goimports is optional, don't warn if not available
    }
  }
}

/**
 * Build context for rendering a test file.
 */
function buildTestContext(
  node: TypeNode,
  packageName: string,
  registry: TypeRegistry,
): BaseTestContext {
  return buildBaseTestContext(node, packageName, goTestOptions, (name) =>
    registry.get(name),
  );
}

function collectInheritedPropertyNames(
  node: TypeNode,
  registry: TypeRegistry,
): string[] {
  const chain: TypeNode[] = [];
  const visited = new Set<string>();
  let current: TypeNode | undefined = node;
  while (current && !visited.has(current.typeName.name)) {
    visited.add(current.typeName.name);
    chain.unshift(current);
    current = current.base ? registry.get(current.base.name) : undefined;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const type of chain) {
    for (const prop of type.properties) {
      if (!seen.has(prop.name)) {
        names.push(prop.name);
        seen.add(prop.name);
      }
    }
  }
  return names;
}

/**
 * Emit the Part III behavioral @dispatch resolver for one seam (issue #282): a
 * typed provider struct with one slot per @dispatch variant, a variant list, a
 * NewXProvider collection guard, and a ResolveX switch that is the twin of the
 * shape discriminator load switch. Go cannot enforce provider completeness at
 * compile time, so the guard is runtime: NewXProvider errors when a consumer
 * omits a variant key (a forgotten attachment cannot silently skip), while a
 * present-but-nil slot is a legitimate valid-but-unimplemented variant. The
 * resolve switch throws on an unknown discriminator exactly when the shape load
 * switch does — a closed dispatch with no default.
 */
function emitGoDispatchResolver(
  entry: DispatchedContract,
  packageName: string,
): string {
  const seam = goFieldName(entry.contract);
  const provider = `${seam}Provider`;
  const rawField = entry.decl.discriminatorField;
  // Preserve the SAME variant order the shape load switch emits, keeping the two
  // switches a faithful twin without a locale-dependent comparator.
  const variants = entry.decl.variants;
  const variantsVar = `${seam[0].toLowerCase()}${seam.slice(1)}Variants`;
  // Throw on an unknown discriminator exactly when the shape load switch does —
  // a closed dispatch with no default (template_format.go default arm).
  const rejectsUnknown = isClosedPolymorphicDispatch(entry.decl);
  // An open dispatch with a declared wildcard child (`CustomModel { provider:
  // "*" }`) gains an optional default struct field; an unknown discriminator
  // routes to it instead of returning (nil, nil) — the behavioral twin of the
  // shape loader's `*`-tolerant fallback. Closed / open-self-reference keeps its
  // error/(nil, nil) arm. The default slot is OUTSIDE variantsVar so it is
  // optional (a consumer may omit the catch-all).
  const defaultSlotBase = dispatchDefaultSlotBase(entry.decl);
  const defaultSlotField = defaultSlotBase ? goFieldName(defaultSlotBase) : null;
  const defaultSlotKey = defaultSlotBase ? toSnakeCase(defaultSlotBase) : null;

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "",
    `package ${packageName}`,
    "",
    'import "fmt"',
    "",
    `// ${provider} carries one ${seam} impl per @dispatch variant, the twin of the`,
    "// shape discriminator's variant set. A nil slot models a valid-but-",
    `// unimplemented variant; use New${provider} so a forgotten variant is a`,
    "// collection-time error rather than a silent nil.",
    `type ${provider} struct {`,
  ];
  for (const variant of variants) {
    lines.push(`\t${goFieldName(variant.value)} ${seam}`);
  }
  if (defaultSlotField) {
    lines.push(
      `\t// ${defaultSlotField} is the catch-all for an unknown discriminator (the`,
    );
    lines.push("\t// declared `*` child); optional, nil when no catch-all is attached.");
    lines.push(`\t${defaultSlotField} ${seam}`);
  }
  lines.push("}");
  lines.push("");
  lines.push(
    `// ${variantsVar} is every @dispatch variant the ${seam} seam must cover, in`,
  );
  lines.push("// shape order — the runtime completeness guard checks against it.");
  lines.push(
    `var ${variantsVar} = []string{${variants
      .map((variant) => JSON.stringify(variant.value))
      .join(", ")}}`,
  );
  lines.push("");
  lines.push(
    `// New${provider} builds a ${provider} from a variant->impl map, erroring when`,
  );
  lines.push(
    "// a variant is ABSENT (a forgotten attachment). A present key with a nil",
  );
  lines.push(
    "// value is allowed and marks a variant as valid-but-unimplemented.",
  );
  lines.push(
    `func New${provider}(impls map[string]${seam}) (${provider}, error) {`,
  );
  lines.push(`\tprovider := ${provider}{}`);
  lines.push("\tmissing := []string{}");
  lines.push(`\tfor _, kind := range ${variantsVar} {`);
  lines.push("\t\timpl, ok := impls[kind]");
  lines.push("\t\tif !ok {");
  lines.push("\t\t\tmissing = append(missing, kind)");
  lines.push("\t\t\tcontinue");
  lines.push("\t\t}");
  lines.push("\t\tswitch kind {");
  for (const variant of variants) {
    lines.push(`\t\tcase ${JSON.stringify(variant.value)}:`);
    lines.push(`\t\t\tprovider.${goFieldName(variant.value)} = impl`);
  }
  lines.push("\t\t}");
  lines.push("\t}");
  if (defaultSlotField && defaultSlotKey) {
    lines.push(
      `\tif impl, ok := impls[${JSON.stringify(defaultSlotKey)}]; ok {`,
    );
    lines.push(`\t\tprovider.${defaultSlotField} = impl`);
    lines.push("\t}");
  }
  lines.push("\tif len(missing) > 0 {");
  lines.push(
    `\t\treturn ${provider}{}, fmt.Errorf("${seam} provider is missing @dispatch variant(s): %v", missing)`,
  );
  lines.push("\t}");
  lines.push("\treturn provider, nil");
  lines.push("}");
  lines.push("");
  lines.push(
    `// Resolve${seam} maps a '${rawField}' discriminator to the attached ${seam}`,
  );
  if (rejectsUnknown) {
    lines.push(
      "// impl — the behavioral twin of the shape discriminator load switch. An",
    );
    lines.push(
      "// unknown discriminator is a hard error; a known variant returns its slot",
    );
    lines.push(
      "// (possibly nil for a valid-but-unimplemented variant) for the caller to",
    );
    lines.push("// skip explicitly, never a silent miss.");
  } else if (defaultSlotField) {
    lines.push(
      "// impl — the behavioral twin of the shape discriminator load switch. A",
    );
    lines.push(
      "// known variant returns its slot; an unknown discriminator routes to the",
    );
    lines.push(
      `// ${defaultSlotField} default slot (the declared \`*\` child), mirroring the`,
    );
    lines.push("// shape loader's `*`-tolerant fallback, never a silent miss.");
  } else {
    lines.push(
      "// impl — the behavioral twin of the shape discriminator load switch. A",
    );
    lines.push(
      "// known variant returns its slot (possibly nil for a valid-but-",
    );
    lines.push(
      "// unimplemented variant); an unknown discriminator returns (nil, nil),",
    );
    lines.push(
      "// mirroring the open shape loader's non-throwing arm, for the caller to",
    );
    lines.push("// skip explicitly.");
  }
  lines.push(
    `func Resolve${seam}(${goDispatchParam(rawField)} string, registry ${provider}) (${seam}, error) {`,
  );
  lines.push(`\tswitch ${goDispatchParam(rawField)} {`);
  for (const variant of variants) {
    lines.push(`\tcase ${JSON.stringify(variant.value)}:`);
    lines.push(`\t\treturn registry.${goFieldName(variant.value)}, nil`);
  }
  if (rejectsUnknown) {
    lines.push("\tdefault:");
    lines.push(
      `\t\treturn nil, fmt.Errorf("unknown ${seam} discriminator field '${rawField}' value: %s", ${goDispatchParam(
        rawField,
      )})`,
    );
  } else if (defaultSlotField) {
    lines.push("\tdefault:");
    lines.push(`\t\treturn registry.${defaultSlotField}, nil`);
  } else {
    lines.push("\tdefault:");
    lines.push("\t\treturn nil, nil");
  }
  lines.push("\t}");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Lower-camel a discriminator field to a safe Go parameter identifier (e.g.
 * `kind`). `goFieldName` yields an exported PascalCase name (never a keyword,
 * since Go keywords are lowercase), but lower-casing the leading letter can
 * collide with a keyword (`type`, `map`, ...), which is a compile error as a
 * parameter name — so a keyword is suffixed with `_`. Falls back to
 * `discriminator` for a field that lowers to empty.
 */
function goDispatchParam(field: string): string {
  const exported = goFieldName(field);
  const candidate = `${exported[0].toLowerCase()}${exported.slice(1)}`;
  if (!candidate) {
    return "discriminator";
  }
  return GO_KEYWORDS.has(candidate) ? `${candidate}_` : candidate;
}

// The 25 Go keywords (spec: https://go.dev/ref/spec#Keywords). A discriminator
// field that lower-camels to one of these cannot be a bare parameter name.
const GO_KEYWORDS = new Set<string>([
  "break",
  "case",
  "chan",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "fallthrough",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "import",
  "interface",
  "map",
  "package",
  "range",
  "return",
  "select",
  "struct",
  "switch",
  "type",
  "var",
]);

/**
 * Write generated Go content to file.
 */
async function emitGoFile(
  context: EmitContext<TypraEmitterOptions>,
  filename: string,
  content: string,
  outputDir?: string,
  outputRoot?: string,
): Promise<void> {
  outputDir = outputDir || `${context.emitterOutputDir}/go`;
  const filePath = resolvePath(outputDir, filename);

  await emitGeneratedFile(context, filePath, formatGoSource(content), {
    outputRoot: outputRoot || outputDir,
  });
}

/**
 * Build a Go test-function identifier for a vector. Must be a unique,
 * exported `TestXxx(t *testing.T)` name so `go test` discovers it.
 */
function goVectorSlug(
  index: number,
  entry: { contract: string; operation: string; vector: { name?: string } },
): string {
  const name = entry.vector.name ?? "unnamed";
  const raw = `${entry.contract} ${entry.operation} ${name}`;
  const pascal = raw
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  return `TestVector${index}${pascal || "Unnamed"}`;
}

/**
 * Compute the Go import path of the emitted shared runner package. The runner is
 * a sibling PACKAGE of the runtime-authored `vectoradapters` package (a Go
 * directory holds only one non-test package, so the runner cannot be a sibling
 * FILE of the harness). Deriving from the adapter import path keeps the runner in
 * the same module as the adapter it borrows port types from.
 */
function goVectorRunnerImportPath(adapterImportPath: string): string {
  const slash = adapterImportPath.lastIndexOf("/");
  return slash >= 0
    ? `${adapterImportPath.slice(0, slash)}/vectorrunner`
    : "vectorrunner";
}

/**
 * Emit the shared, seam-agnostic `@vector` conformance runner (package
 * `vectorrunner`). It holds the relocated interpreter and reads ZERO
 * runtime-authored values: every seam table (adapters, waivers, capabilities,
 * doubles) and the harness base directory are injected through the `Seam`
 * struct. The body is spec-independent, so it regenerates byte-identical.
 */
function emitGoVectorRunner(adapterImportPath: string): string {
  const lines: string[] = [
    "// Copyright (c) Microsoft. All rights reserved.",
    "// WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "//",
    "// Shared @vector behavioral conformance runner. The interpreter lives here,",
    "// decoupled from any runtime-authored data: every seam table (adapters,",
    "// waivers, capabilities, doubles) and the harness base directory are injected",
    "// through the Seam struct, so this file reads ZERO authored values and is",
    "// value-independent.",
    "//",
    "// PACKAGE ASYMMETRY (Go-specific): on every other target the runner is a",
    "// sibling FILE of the harness in the test directory. Go forbids two non-test",
    "// packages in one directory, so the runner is instead its own regular package",
    "// `vectorrunner`, emitted as a sibling of the runtime-authored `vectoradapters`",
    "// package under the module root. It imports `vectoradapters` for its port",
    "// TYPES ONLY (Context, Adapter) — never for authored values. The harness",
    "// `_test.go` imports BOTH this package and `vectoradapters`, and injects the",
    "// authored tables it loads from the latter into RunVector via Seam.",
    "//",
    "// Adapter contract: the adapter is invoked exactly once per vector and must not",
    "// spawn its own concurrency, keeping conformance deterministic. Go has no",
    "// awaitable type, so the invocation is a plain synchronous call — an adapter",
    "// that fronts async work blocks internally before returning.",
    "//",
    "// @sync classification is not separately enforced here: Go is the one target",
    "// with no awaitable type, so every adapter is already synchronous and a @sync",
    "// operation cannot be violated. Enforcement is a no-op by construction.",
    "// See docs: reference/vector-conformance.",
    "",
    "package vectorrunner",
    "",
    "import (",
    '\t"encoding/json"',
    '\t"fmt"',
    '\t"os"',
    '\t"path/filepath"',
    '\t"strings"',
    '\t"testing"',
    "",
    `\tvectoradapters ${JSON.stringify(adapterImportPath)}`,
    ")",
    "",
    "// Seam is the runtime-authored table set the harness injects. The runner reads",
    "// ZERO authored values directly; everything flows through here. Capabilities is",
    "// populated only when a vector declares `requires` (otherwise left nil and",
    "// never consulted), keeping requirement-free harnesses byte-identical.",
    "type Seam struct {",
    "\tAdapters     map[string]vectoradapters.Adapter",
    "\tWaivers      map[string]string",
    "\tCapabilities map[string]func(vectoradapters.Context) bool",
    "\tDoubles      map[string]any",
    "\tBaseDir      string",
    "}",
    "",
    "// Canonical round-trips a value through generic JSON so map keys sort",
    "// regardless of whether the adapter returned a struct or a map.",
    "func Canonical(t *testing.T, value any) string {",
    "\tt.Helper()",
    "\traw, err := json.Marshal(value)",
    "\tif err != nil {",
    '\t\tt.Fatalf("failed to marshal value: %v", err)',
    "\t}",
    "\tvar normalized any",
    "\tif err := json.Unmarshal(raw, &normalized); err != nil {",
    '\t\tt.Fatalf("failed to normalize value: %v", err)',
    "\t}",
    "\tout, err := json.Marshal(normalized)",
    "\tif err != nil {",
    '\t\tt.Fatalf("failed to re-marshal value: %v", err)',
    "\t}",
    "\treturn string(out)",
    "}",
    "",
    "func resolveRefs(t *testing.T, value any, dir string) any {",
    "\tswitch typed := value.(type) {",
    "\tcase []any:",
    "\t\tout := make([]any, len(typed))",
    "\t\tfor i, item := range typed {",
    "\t\t\tout[i] = resolveRefs(t, item, dir)",
    "\t\t}",
    "\t\treturn out",
    "\tcase map[string]any:",
    "\t\tif len(typed) == 1 {",
    "\t\t\tfor key, raw := range typed {",
    "\t\t\t\tstr, isStr := raw.(string)",
    '\t\t\t\tif isStr && key == "$env" {',
    "\t\t\t\t\treturn os.Getenv(str)",
    "\t\t\t\t}",
    '\t\t\t\tif isStr && key == "$file" {',
    "\t\t\t\t\tdata, err := os.ReadFile(filepath.Join(dir, str))",
    "\t\t\t\t\tif err != nil {",
    '\t\t\t\t\t\tt.Fatalf("failed to read $file %q: %v", str, err)',
    "\t\t\t\t\t}",
    "\t\t\t\t\treturn string(data)",
    "\t\t\t\t}",
    '\t\t\t\tif isStr && key == "$json" {',
    "\t\t\t\t\tdata, err := os.ReadFile(filepath.Join(dir, str))",
    "\t\t\t\t\tif err != nil {",
    '\t\t\t\t\t\tt.Fatalf("failed to read $json %q: %v", str, err)',
    "\t\t\t\t\t}",
    "\t\t\t\t\tvar parsed any",
    "\t\t\t\t\tif err := json.Unmarshal(data, &parsed); err != nil {",
    '\t\t\t\t\t\tt.Fatalf("failed to parse $json %q: %v", str, err)',
    "\t\t\t\t\t}",
    "\t\t\t\t\treturn parsed",
    "\t\t\t\t}",
    "\t\t\t}",
    "\t\t}",
    "\t\tout := make(map[string]any, len(typed))",
    "\t\tfor key, item := range typed {",
    "\t\t\tout[key] = resolveRefs(t, item, dir)",
    "\t\t}",
    "\t\treturn out",
    "\tdefault:",
    "\t\treturn value",
    "\t}",
    "}",
    "",
    "// resolveDispatchKey walks a deterministic field-access path (e.g.",
    "// `agent.template.format.kind`) over a resolved vector input to read the",
    "// @dispatch discriminator value that selects the concrete seam implementation.",
    "// The bool is false if any hop is missing or the terminal value is not a string.",
    "func resolveDispatchKey(root any, dotted string) (string, bool) {",
    "\tnode := root",
    '\tfor _, key := range strings.Split(dotted, ".") {',
    "\t\tm, ok := node.(map[string]any)",
    "\t\tif !ok {",
    '\t\t\treturn "", false',
    "\t\t}",
    "\t\tnext, exists := m[key]",
    "\t\tif !exists {",
    '\t\t\treturn "", false',
    "\t\t}",
    "\t\tnode = next",
    "\t}",
    "\tstr, ok := node.(string)",
    "\treturn str, ok",
    "}",
    "",
    "// RunVector replays a single vector through the injected seam. Behavior is",
    "// identical to the previously inlined interpreter; only the data source moved",
    "// from package-level authored globals to the Seam parameter.",
    "//",
    "// Behavioral polymorphic dispatch (@dispatch): the optional variadic dispatch",
    "// path selects the concrete implementation from the seam's per-key registry",
    "// (adapters keyed `Contract.operation#key`). An impl absent for a valid key",
    "// reuses the capability-absent skip. Undispatched seams pass no path and keep",
    "// the single-adapter lookup unchanged.",
    "func RunVector(t *testing.T, contract string, operation string, vector map[string]any, seam Seam, dispatch ...string) {",
    '\toperationKey := contract + "." + operation',
    '\tvectorName := "unnamed"',
    '\tif name, ok := vector["name"].(string); ok {',
    "\t\tvectorName = name",
    "\t}",
    '\tvectorID := operationKey + ":" + vectorName',
    "",
    '\tvar adapter vectoradapters.Adapter',
    "\tvar ok bool",
    '\tif len(dispatch) > 0 && dispatch[0] != "" {',
    "\t\t// Dispatched seam: resolve the implementation from the discriminator",
    "\t\t// value read at the dispatch path on the vector input.",
    '\t\tdispatchInput := resolveRefs(t, vector["input"], seam.BaseDir)',
    "\t\tdispatchKey, keyOK := resolveDispatchKey(dispatchInput, dispatch[0])",
    "\t\tif !keyOK {",
    '\t\t\tt.Fatalf("%s: @dispatch path %q did not resolve to a string discriminator on the vector input.", vectorID, dispatch[0])',
    "\t\t\treturn",
    "\t\t}",
    '\t\tadapter, ok = seam.Adapters[operationKey+"#"+dispatchKey]',
    "\t\tif !ok {",
    '\t\t\tadapter, ok = seam.Adapters[operation+"#"+dispatchKey]',
    "\t\t}",
    "\t\tif !ok {",
    '\t\t\tt.Skipf("SKIP %s (requirement unavailable: %s)", vectorID, dispatchKey)',
    "\t\t\treturn",
    "\t\t}",
    "\t} else {",
    "\t\tadapter, ok = seam.Adapters[operationKey]",
    "\t\tif !ok {",
    "\t\t\tadapter, ok = seam.Adapters[operation]",
    "\t\t}",
    "\t\tif !ok {",
    "\t\t\twaiver, hasWaiver := seam.Waivers[operationKey]",
    "\t\t\tif !hasWaiver {",
    "\t\t\t\twaiver, hasWaiver = seam.Waivers[operation]",
    "\t\t\t}",
    '\t\t\tif hasWaiver && waiver != "" {',
    '\t\t\t\tt.Skipf("SKIP %s (waived: %s)", vectorID, waiver)',
    "\t\t\t\treturn",
    "\t\t\t}",
    '\t\t\tt.Fatalf("No vector adapter registered for %s. Register "+',
    '\t\t\t\t"VectorAdapters[%q] in the package referenced by \'vector-adapter-path\', "+',
    '\t\t\t\t"or add an explicit waiver. @vector conformance never skips silently.",',
    "\t\t\t\toperationKey, operationKey)",
    "\t\t\treturn",
    "\t\t}",
    "\t}",
    "",
    "\t// Requirement guard: a vector may declare abstract capability tokens in",
    "\t// \"requires\". Each is resolved against the injected capability table BEFORE",
    "\t// the adapter runs. An unregistered token is a hard failure (never skip",
    "\t// silently); an unavailable one yields a clean skip so an absent credential",
    "\t// never reaches Invoke as an empty value. The table is nil (and this block",
    "\t// inert) unless a vector declared `requires`.",
    "\tvar requires []string",
    "\tif raw, ok := vector[\"requires\"].([]any); ok {",
    "\t\tfor _, item := range raw {",
    "\t\t\tif token, isStr := item.(string); isStr {",
    "\t\t\t\trequires = append(requires, token)",
    "\t\t\t}",
    "\t\t}",
    "\t}",
    "\tif len(requires) > 0 {",
    "\t\tcapabilities := seam.Capabilities",
    "\t\tfor _, token := range requires {",
    "\t\t\tif _, ok := capabilities[token]; !ok {",
    "\t\t\t\tt.Fatalf(\"No capability predicate registered for requirement token %q. \"+",
    "\t\t\t\t\t\"Register VectorCapabilities[%q] in the package referenced by \"+",
    "\t\t\t\t\t\"'vector-adapter-path'. @vector conformance never skips silently.\", token, token)",
    "\t\t\t\treturn",
    "\t\t\t}",
    "\t\t}",
    "\t\tprovider, _ := vector[\"provider\"].(string)",
    "\t\ttargetAPI, _ := vector[\"targetApi\"].(string)",
    "\t\tcapCtx := vectoradapters.Context{",
    "\t\t\tContract:  contract,",
    "\t\t\tOperation: operation,",
    "\t\t\tVector:    vector,",
    "\t\t\tProvider:  provider,",
    "\t\t\tTargetAPI: targetAPI,",
    "\t\t\tDoubles:   seam.Doubles,",
    "\t\t\tBaseDir:   seam.BaseDir,",
    "\t\t}",
    "\t\tfor _, token := range requires {",
    "\t\t\tif !capabilities[token](capCtx) {",
    "\t\t\t\tt.Skipf(\"SKIP %s (requirement unavailable: %s)\", vectorID, token)",
    "\t\t\t\treturn",
    "\t\t\t}",
    "\t\t}",
    "\t}",
    "",
    "\t// Per-vector waiver, consulted even when an adapter IS registered. Keyed by",
    "\t// the full vector id (\"Contract.operation:name\") or \"operation:name\" so it",
    "\t// never collides with an operation-level waiver. xfail: a waived vector that",
    "\t// fails is an expected failure (green); xpass: a waived vector that passes is",
    "\t// surfaced as a hard failure so stale waivers get removed.",
    "\tvectorWaiver, vectorWaived := seam.Waivers[vectorID]",
    "\tif !vectorWaived {",
    '\t\tvectorWaiver, vectorWaived = seam.Waivers[operation+":"+vectorName]',
    "\t}",
    '\tvectorWaived = vectorWaived && vectorWaiver != ""',
    "",
    "\t// Evaluate the vector without failing the test directly: return \"\" on a",
    "\t// match, or a mismatch message on any failure, so the waiver decision below",
    "\t// can turn a failure into an xfail.",
    "\tmismatch := func() string {",
    "\t\tbaseDir := seam.BaseDir",
    '\t\tprovider, _ := vector["provider"].(string)',
    '\t\ttargetAPI, _ := vector["targetApi"].(string)',
    "\t\tctx := vectoradapters.Context{",
    "\t\t\tContract:  contract,",
    "\t\t\tOperation: operation,",
    "\t\t\tVector:    vector,",
    "\t\t\tProvider:  provider,",
    "\t\t\tTargetAPI: targetAPI,",
    "\t\t\tDoubles:   seam.Doubles,",
    "\t\t\tBaseDir:   baseDir,",
    "\t\t}",
    '\t\tinput := resolveRefs(t, vector["input"], baseDir)',
    "\t\tnormalize := adapter.Normalize",
    "\t\tif normalize == nil {",
    "\t\t\tnormalize = func(value any, _ vectoradapters.Context) any { return value }",
    "\t\t}",
    "",
    '\t\tif _, isError := vector["expectedError"]; isError {',
    "\t\t\t_, err := adapter.Invoke(input, ctx)",
    "\t\t\tif err == nil {",
    '\t\t\t\treturn fmt.Sprintf("%s: expected the adapter to signal an error, but it returned a value.", vectorID)',
    "\t\t\t}",
    "\t\t\tvar observed any",
    "\t\t\tif carrier, ok := err.(interface{ TypraVector() any }); ok {",
    "\t\t\t\tobserved = carrier.TypraVector()",
    "\t\t\t} else {",
    '\t\t\t\tobserved = map[string]any{"message": err.Error()}',
    "\t\t\t}",
    "\t\t\tgot := Canonical(t, normalize(observed, ctx))",
    '\t\t\twant := Canonical(t, vector["expectedError"])',
    "\t\t\tif got != want {",
    '\t\t\t\treturn fmt.Sprintf("%s error mismatch\\n want %s\\n got  %s", vectorID, want, got)',
    "\t\t\t}",
    '\t\t\treturn ""',
    "\t\t}",
    "",
    "\t\tobserved, err := adapter.Invoke(input, ctx)",
    "\t\tif err != nil {",
    '\t\t\treturn fmt.Sprintf("%s: adapter returned an unexpected error: %v", vectorID, err)',
    "\t\t}",
    "\t\tgot := Canonical(t, normalize(observed, ctx))",
    '\t\twant := Canonical(t, vector["expected"])',
    "\t\tif got != want {",
    '\t\t\treturn fmt.Sprintf("%s mismatch\\n want %s\\n got  %s", vectorID, want, got)',
    "\t\t}",
    '\t\treturn ""',
    "\t}()",
    "",
    "\tif vectorWaived {",
    '\t\tif mismatch != "" {',
    '\t\t\tt.Logf("XFAIL %s (waived: %s)", vectorID, vectorWaiver)',
    "\t\t\treturn",
    "\t\t}",
    '\t\tt.Fatalf("XPASS %s: waived vector unexpectedly passed; remove the waiver (%s)", vectorID, vectorWaiver)',
    "\t\treturn",
    "\t}",
    '\tif mismatch != "" {',
    '\t\tt.Fatalf("%s", mismatch)',
    "\t}",
    "}",
    "",
  ];
  return lines.join("\n");
}

/**
 * Render a JSON payload as a Go source string literal. Go raw-string literals
 * (backtick-delimited) keep the JSON readable, but a payload containing a
 * backtick — e.g. a ```python markdown fence in vector input — would TERMINATE
 * the raw string mid-literal and fail to compile. When the payload contains a
 * backtick, fall back to a Go interpreted (double-quoted) literal instead:
 * `JSON.stringify` produces a JSON string whose escaping (\" \\ \n \t \uXXXX)
 * is a valid Go interpreted string literal, so the byte content is preserved.
 */
function goEmbeddedStringLiteral(raw: string): string {
  return raw.includes("`") ? JSON.stringify(raw) : `\`${raw}\``;
}

/**
 * Emit the thin Go `@vector` conformance harness. It authors NO interpreter
 * logic: it imports the shared `vectorrunner` package plus the runtime-authored
 * `vectoradapters` package, loads the authored seam tables from the latter, and
 * hands them to `vectorrunner.RunVector` per vector. The capability table is
 * loaded into the seam only when a vector declares `requires`, so requirement-
 * free harnesses regenerate byte-identical.
 */
function emitGoVectorConformanceTest(
  vectors: NonNullable<GeneratorOptions["callableVectors"]>,
  packageName: string,
  adapterImportPath: string,
  runnerImportPath: string,
): string {
  const model = buildVectorConformanceCodeModel(vectors);
  const hasRequires = model.vectors.some(
    (entry) => (entry.vector.requires?.length ?? 0) > 0,
  );

  const lines: string[] = [
    "// Copyright (c) Microsoft. All rights reserved.",
    "// WARNING: This is an auto-generated file. DO NOT EDIT THIS FILE DIRECTLY.",
    "//",
    "// Thin @vector behavioral conformance harness. The interpreter lives in the",
    "// shared `vectorrunner` package; this file only loads the runtime-authored",
    "// seam tables from the package referenced by the target's 'vector-adapter-path'",
    "// option and injects them into vectorrunner.RunVector. A vector with no adapter",
    "// and no explicit waiver is a hard failure — conformance never skips silently.",
    "// See docs: reference/vector-conformance.",
    "",
    `package ${packageName}_test`,
    "",
    "import (",
    '\t"encoding/json"',
    '\t"path/filepath"',
    '\t"runtime"',
    '\t"testing"',
    "",
    `\tvectoradapters ${JSON.stringify(adapterImportPath)}`,
    `\t${JSON.stringify(runnerImportPath)}`,
    ")",
    "",
    "// vcBaseDir resolves $file/$json vector inputs relative to THIS harness file",
    "// (computed here, not in the runner, so it points at the test directory).",
    "func vcBaseDir() string {",
    "\t_, file, _, ok := runtime.Caller(0)",
    "\tif !ok {",
    '\t\treturn "."',
    "\t}",
    "\treturn filepath.Dir(file)",
    "}",
    "",
    "// vcSeam assembles the runtime-authored seam the runner interprets. It reads",
    "// the authored registries from the vectoradapters package and injects them; the",
    "// runner itself reads none of these directly.",
    "func vcSeam() vectorrunner.Seam {",
    "\treturn vectorrunner.Seam{",
    "\t\tAdapters: vectoradapters.VectorAdapters,",
    "\t\tWaivers:  vectoradapters.VectorWaivers,",
    "\t\tDoubles:  vectoradapters.VectorDoubles,",
    ...(hasRequires
      ? ["\t\tCapabilities: vectoradapters.VectorCapabilities,"]
      : []),
    "\t\tBaseDir: vcBaseDir(),",
    "\t}",
    "}",
    "",
  ];

  model.vectors.forEach((entry, index) => {
    const vectorJSON = JSON.stringify(entry.vector, null, 2);
    const dispatchArg = entry.dispatch
      ? `, ${JSON.stringify(entry.dispatch.path)}`
      : "";
    lines.push(
      `func ${goVectorSlug(index, entry)}(t *testing.T) {`,
      `\tvectorJSON := ${goEmbeddedStringLiteral(vectorJSON)}`,
      "\tvar vector map[string]any",
      "\tif err := json.Unmarshal([]byte(vectorJSON), &vector); err != nil {",
      '\t\tt.Fatalf("failed to decode vector: %v", err)',
      "\t}",
      `\tvectorrunner.RunVector(t, ${JSON.stringify(
        entry.contract,
      )}, ${JSON.stringify(entry.operation)}, vector, vcSeam()${dispatchArg})`,
      "}",
      "",
    );
  });
  return lines.join("\n");
}

/**
 * Part III typed per-interface @vector conformance (issue #282 §8): the twin of
 * the per-model `${model}_test.go` file. Routes each vector's discriminator
 * through the emitted `Resolve${Seam}` switch against a consumer-attached typed
 * provider, invokes the typed seam, and asserts the result reproduces
 * `expected`. Go has no compile-time completeness, so a forgotten @dispatch slot
 * errors at provider collection (`New${Seam}Provider`) rather than compiling —
 * conformance never silently skips.
 */
function emitGoInterfaceConformanceTest(
  dispatched: DispatchedContract,
  entries: CallableVectorSnapshotEntry[],
  packageName: string,
  importPath: string,
  adapterImportPath: string,
): string {
  const seam = goFieldName(dispatched.contract);
  const rawField = dispatched.decl.discriminatorField;
  // §8.5: sort by vector name so regen is byte-stable regardless of snapshot order.
  const sorted = [...entries].sort((left, right) =>
    (left.vector.name ?? "").localeCompare(right.vector.name ?? ""),
  );
  // Disambiguate Test* function names: two vector names that PascalCase to the
  // same identifier would emit duplicate Go funcs and fail to compile.
  const seen = new Map<string, number>();

  const lines: string[] = [
    "// <auto-generated by typra-emitter>",
    "// Code generated by Typra emitter; DO NOT EDIT.",
    "//",
    `// Part III TYPED @vector conformance for ${dispatched.contract} — the per-interface`,
    "// twin of the per-model ${model}_test.go file (issue #282 §8). Each test builds",
    "// the operation inputs from the vector JSON, reads the shape discriminator, routes",
    `// it through the emitted Resolve${seam} against the consumer-attached provider`,
    `// (vectoradapters.${seam}Provider()), invokes the typed seam, and asserts the`,
    "// result reproduces `expected`. Go has no compile-time completeness, so a dropped",
    `// @dispatch slot errors at provider collection (New${seam}Provider) rather than`,
    "// compiling — conformance never silently skips.",
    "// See docs: reference/vector-conformance.",
    "",
    `package ${packageName}_test`,
    "",
    "import (",
    '\t"encoding/json"',
    '\t"testing"',
    "",
    `\tfixtures ${JSON.stringify(importPath)}`,
    `\tvectoradapters ${JSON.stringify(adapterImportPath)}`,
    ")",
    "",
  ];

  sorted.forEach((entry, index) => {
    assertTypedDispatchSupported(entry);
    const paramNames = Object.keys(entry.params);
    const method = goFieldName(entry.operation);
    const accessor = goDiscriminatorAccessor(entry.dispatch!.path);
    const inputJSON = JSON.stringify(entry.vector.input ?? {}, null, 2);
    const expected = entry.vector.expected;
    const label = entry.vector.name ?? entry.operation;

    lines.push(
      `func ${uniqueGoTestName(dispatched.contract, entry, index, seen)}(t *testing.T) {`,
    );
    lines.push(`\tinputJSON := ${goEmbeddedStringLiteral(inputJSON)}`);
    lines.push("\tvar payload map[string]any");
    lines.push(
      "\tif err := json.Unmarshal([]byte(inputJSON), &payload); err != nil {",
    );
    lines.push('\t\tt.Fatalf("failed to decode vector input: %v", err)');
    lines.push("\t}");
    for (const paramName of paramNames) {
      const shape = classifyCallableParam(entry.params[paramName]);
      const key = JSON.stringify(paramName);
      if (shape.bareModel) {
        const paramType = goFieldName(entry.params[paramName]);
        lines.push(
          `\t${paramName}, err := fixtures.Load${paramType}(payload[${key}], fixtures.NewLoadContext())`,
        );
        lines.push("\tif err != nil {");
        lines.push(`\t\tt.Fatalf("${paramName} parse: %v", err)`);
        lines.push("\t}");
      } else {
        // Non-model param (scalar, `Record<unknown>`, optional, array) decoded
        // into the mapped Go type via a JSON round-trip. Scoped braces keep the
        // marshal/unmarshal errors from colliding with the seam-resolve `err`.
        lines.push(`\tvar ${paramName} ${protocolGoType(entry.params[paramName])}`);
        lines.push("\t{");
        lines.push(`\t\t${paramName}Bytes, marshalErr := json.Marshal(payload[${key}])`);
        lines.push("\t\tif marshalErr != nil {");
        lines.push(`\t\t\tt.Fatalf("${paramName} marshal: %v", marshalErr)`);
        lines.push("\t\t}");
        lines.push(
          `\t\tif unmarshalErr := json.Unmarshal(${paramName}Bytes, &${paramName}); unmarshalErr != nil {`,
        );
        lines.push(`\t\t\tt.Fatalf("${paramName} parse: %v", unmarshalErr)`);
        lines.push("\t\t}");
        lines.push("\t}");
      }
    }
    lines.push(`\t${goDispatchParam(rawField)} := ${accessor}`);
    lines.push(
      `\timpl, err := fixtures.Resolve${seam}(${goDispatchParam(
        rawField,
      )}, vectoradapters.${seam}Provider())`,
    );
    lines.push("\tif err != nil {");
    lines.push(
      `\t\tt.Fatalf("resolve %q: %v", ${goDispatchParam(rawField)}, err)`,
    );
    lines.push("\t}");
    lines.push("\tif impl == nil {");
    lines.push(
      `\t\tt.Fatalf("${label}: no ${dispatched.contract} attached for %q", ${goDispatchParam(
        rawField,
      )})`,
    );
    lines.push("\t}");
    const call = `impl.${method}(${paramNames.join(", ")})`;
    lines.push(`\tactual, err := ${call}`);
    lines.push("\tif err != nil {");
    lines.push(`\t\tt.Fatalf("${label}: %v", err)`);
    lines.push("\t}");
    if (typeof expected === "string") {
      lines.push(`\tif actual != ${JSON.stringify(expected)} {`);
      lines.push(
        `\t\tt.Fatalf("${label} misrouted: got %q want %q", actual, ${JSON.stringify(
          expected,
        )})`,
      );
      lines.push("\t}");
    } else {
      // No scalar `expected` (e.g. an expectedError vector): reaching here means
      // the route resolved and the seam ran without error, which is the
      // assertion. A dispatched fixture needing richer comparison extends this
      // arm (reproduce-before-fix). `actual` is referenced to satisfy the
      // compiler.
      lines.push("\t_ = actual");
    }
    lines.push("}");
    lines.push("");
  });

  return lines.join("\n");
}

/**
 * Read the shape discriminator off a LOADED param for the typed conformance
 * harness. A Go polymorphic union field is `interface{}` with no exported
 * discriminator accessor, so — mirroring the emitted union's own Save switch
 * (template.go) — assert the concrete value to the anonymous Save interface and
 * read the raw wire field off the serialized map. The path head is a param
 * local (guaranteed by assertTypedDispatchSupported); middle segments navigate
 * exported struct fields via goFieldName.
 */
function goDiscriminatorAccessor(path: string): string {
  const segments = path.split(".");
  const rawField = segments[segments.length - 1];
  const container = [
    segments[0],
    ...segments.slice(1, -1).map((segment) => goFieldName(segment)),
  ].join(".");
  return `${container}.(interface {\n\t\tSave(*fixtures.SaveContext) map[string]interface{}\n\t}).Save(fixtures.NewSaveContext())[${JSON.stringify(
    rawField,
  )}].(string)`;
}

/**
 * A collision-safe exported Go test name for a per-interface conformance vector:
 * `Test${Seam}${Operation}${VectorName}`, PascalCased, with a numeric suffix on
 * the rare identifier collision so two vector names never emit duplicate funcs.
 */
function uniqueGoTestName(
  contract: string,
  entry: { operation: string; vector: { name?: string } },
  index: number,
  seen: Map<string, number>,
): string {
  const raw = `${contract} ${entry.operation} ${entry.vector.name ?? "unnamed"}`;
  const pascal =
    raw
      .replace(/[^A-Za-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("") || `Unnamed${index}`;
  const base = `Test${pascal}`;
  const prior = seen.get(base);
  if (prior === undefined) {
    seen.set(base, 0);
    return base;
  }
  seen.set(base, prior + 1);
  return `${base}${prior + 1}`;
}