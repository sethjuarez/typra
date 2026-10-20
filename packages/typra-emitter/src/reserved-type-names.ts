import { NoTarget, type DiagnosticTarget, type Program } from "@typespec/compiler";
import type { TypeNode } from "./ir/ast.js";
import type { EmitTarget } from "./lib.js";
import {
  relativeNamespaceProjection,
  resolveNamespaceOutputMode,
  type NamespaceOutputMode,
} from "./ir/namespace.js";
import { toKebabCase, toSnakeCase } from "./ir/utilities.js";

/**
 * Model, interface, and enum names a target's generated code cannot carry (#358).
 * Calibrated against native compiles of a one-model spec per candidate name.
 *
 * - `types`: standard or runtime-support types the generated code references
 *   unqualified, so a same-named declaration shadows or redeclares them. Exact match.
 * - `files`: runtime-support file stems emitted in the target's root directory.
 *   A root-level declaration whose file stem matches, ignoring case (Windows and
 *   macOS filesystems fold it: `_Context.py` vs `_context.py`), overwrites it.
 */
interface ReservedNames {
  types: readonly string[];
  files: readonly string[];
  fileStem: (name: string) => string;
}

const CONTEXT_TYPES = ["LoadContext", "SaveContext"];

const RESERVED: Record<string, ReservedNames> = {
  typescript: {
    types: ["String", "Object", "Error", "JSON", ...CONTEXT_TYPES],
    files: ["context", "index"],
    fileStem: toKebabCase,
  },
  python: {
    types: ["ClassVar", ...CONTEXT_TYPES],
    files: ["_context"],
    fileStem: (name) => `_${name}`,
  },
  go: {
    types: CONTEXT_TYPES,
    files: ["context"],
    fileStem: toSnakeCase,
  },
  csharp: {
    types: [
      "Convert",
      "Enumerable",
      "JsonElement",
      "JsonSerializer",
      ...CONTEXT_TYPES,
    ],
    files: ["context", "utils"],
    fileStem: (name) => name,
  },
  java: {
    types: [
      "ArrayList",
      "Boolean",
      "Character",
      "Double",
      "IllegalArgumentException",
      "Integer",
      "LinkedHashMap",
      "List",
      "Long",
      "Map",
      "Number",
      "Object",
      "String",
      "System",
      "TypraJson",
      "TypraMaps",
      "TypraYaml",
      ...CONTEXT_TYPES,
    ],
    files: [],
    fileStem: (name) => name,
  },
  rust: {
    types: ["Box", "Result", "String", ...CONTEXT_TYPES],
    files: ["context", "mod"],
    fileStem: toSnakeCase,
  },
  swift: {
    types: [
      "Bool",
      "Decimal",
      "Double",
      "Error",
      "Float",
      "Int",
      "Int64",
      "NSNumber",
      "String",
      "TypraCodableValue",
      "TypraCodingKey",
      "TypraModel",
      "TypraRuntime",
      "TypraRuntimeError",
      ...CONTEXT_TYPES,
    ],
    files: [],
    fileStem: (name) => name,
  },
};


// Go compiles `<name>_<GOOS>.go`, `<name>_<GOARCH>.go`, and `<name>_test.go` only
// under that OS/arch or `go test`, so a declaration whose snake_case file name
// ends in one of these segments silently drops out of ordinary builds.
const GO_FILE_SUFFIXES = new Set([
  "test",
  // GOOS
  "aix",
  "android",
  "darwin",
  "dragonfly",
  "freebsd",
  "hurd",
  "illumos",
  "ios",
  "js",
  "linux",
  "nacl",
  "netbsd",
  "openbsd",
  "plan9",
  "solaris",
  "wasip1",
  "windows",
  "zos",
  // GOARCH
  "386",
  "amd64",
  "amd64p32",
  "arm",
  "armbe",
  "arm64",
  "arm64be",
  "loong64",
  "mips",
  "mipsle",
  "mips64",
  "mips64le",
  "mips64p32",
  "mips64p32le",
  "ppc",
  "ppc64",
  "ppc64le",
  "riscv",
  "riscv64",
  "s390",
  "s390x",
  "sparc",
  "sparc64",
  "wasm",
]);

/** Why `name` cannot be emitted for `target`, or undefined when it can. */
export function reservedTypeNameReason(
  target: string,
  name: string,
  options: { atRoot?: boolean } = {},
): string | undefined {
  const reserved = RESERVED[target];
  if (!reserved) return undefined;
  if (reserved.types.includes(name)) {
    return `shadows or redeclares the '${name}' type`;
  }
  if (options.atRoot ?? true) {
    const stem = reserved.fileStem(name);
    const file = reserved.files.find((f) => f === stem.toLowerCase());
    if (file) {
      return `its file '${stem}' overwrites the generated '${file}' support file`;
    }
  }
  if (target === "go") {
    const segments = toSnakeCase(name).split("_");
    const last = segments[segments.length - 1];
    if (segments.length > 1 && GO_FILE_SUFFIXES.has(last)) {
      return `its file '${segments.join("_")}.go' is build-constrained by the '_${last}' suffix`;
    }
  }
  return undefined;
}

interface Declaration {
  name: string;
  namespace: string;
  /** Interfaces always emit at the target root; models follow namespace/group layout. */
  isProtocol: boolean;
  group: string;
  target: DiagnosticTarget | typeof NoTarget;
}

function isAtRoot(
  declaration: Declaration,
  rootNamespace: string,
  mode: NamespaceOutputMode,
): boolean {
  if (declaration.isProtocol) return true;
  if (declaration.group) return false;
  if (mode === "flat") return true;
  return (
    relativeNamespaceProjection(declaration.namespace, rootNamespace).segments
      .length === 0
  );
}

/**
 * Reports every emitted model, interface, and enum whose name a selected target
 * cannot represent (#358). Returns false when any error was reported.
 */
export function validateReservedTypeNames(
  program: Program,
  options: {
    targets: readonly EmitTarget[];
    nodes: readonly TypeNode[];
    rootNamespace: string;
    namespaceOutput?: NamespaceOutputMode;
  },
): boolean {
  const declarations = new Map<string, Declaration>();
  const declare = (
    node: TypeNode,
    name: string,
    fallback?: DiagnosticTarget,
  ) => {
    const namespace = node.typeName.namespace;
    const key = `${namespace}.${name}`;
    if (!name || declarations.has(key)) return;
    const [resolved] = program.resolveTypeReference(namespace ? key : name);
    declarations.set(key, {
      name,
      namespace,
      isProtocol: node.isProtocol,
      group: node.group,
      target: resolved ?? fallback ?? NoTarget,
    });
  };
  for (const node of options.nodes) {
    const model = node.model?.kind === "Model" ? node.model : undefined;
    declare(node, node.typeName.name, model);
    for (const property of node.properties) {
      if (property.enumName) {
        declare(node, property.enumName, property.property);
      }
    }
  }

  const targets = options.targets.map((target) => ({
    name: target.type.toLowerCase().trim(),
    mode: resolveNamespaceOutputMode({
      namespaceOutput: options.namespaceOutput,
      emitTarget: target,
    }),
  }));
  let ok = true;
  for (const declaration of declarations.values()) {
    const reasons = new Set<string>();
    for (const target of targets) {
      const reason = reservedTypeNameReason(target.name, declaration.name, {
        // Go emits every model into one flat package directory.
        atRoot:
          target.name === "go" ||
          isAtRoot(declaration, options.rootNamespace, target.mode),
      });
      if (reason) reasons.add(`${target.name} (${reason})`);
    }
    if (reasons.size === 0) continue;
    ok = false;
    program.reportDiagnostic({
      code: "typra-emitter-reserved-type-name",
      message: `Type name '${declaration.name}' cannot be emitted: in ${[...reasons].join("; ")}. Rename it.`,
      severity: "error",
      target: declaration.target,
    });
  }
  return ok;
}
