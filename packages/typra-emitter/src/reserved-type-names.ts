import { NoTarget, type DiagnosticTarget, type Program } from "@typespec/compiler";
import type { TypeNode } from "./ir/ast.js";
import type { EmitTarget } from "./lib.js";
import { csharpReservedTypeName } from "./languages/csharp/identifiers.js";
import { goReservedTypeName } from "./languages/go/identifiers.js";
import { javaReservedTypeName } from "./languages/java/identifiers.js";
import { pythonReservedTypeName } from "./languages/python/identifiers.js";
import { rustReservedTypeName } from "./languages/rust/identifiers.js";
import { swiftReservedTypeName } from "./languages/swift/identifiers.js";
import { typescriptReservedTypeName } from "./languages/typescript/identifiers.js";

/**
 * Each runtime owns the model, interface, and enum names its generated code cannot
 * carry (#358). Clashes with generated support files are caught when files are
 * written (`typra-emitter-generated-file-collision`), so no file list lives here.
 */
const RESERVED_TYPE_NAME_RULES: Record<string, (name: string) => string | undefined> = {
  typescript: typescriptReservedTypeName,
  python: pythonReservedTypeName,
  go: goReservedTypeName,
  csharp: csharpReservedTypeName,
  java: javaReservedTypeName,
  rust: rustReservedTypeName,
  swift: swiftReservedTypeName,
};

/** Why `name` cannot be emitted for `target`, or undefined when it can. */
export function reservedTypeNameReason(
  target: string,
  name: string,
): string | undefined {
  return RESERVED_TYPE_NAME_RULES[target]?.(name);
}

/**
 * Reports every emitted model, interface, and enum whose name a selected target
 * cannot represent (#358). Returns false when any error was reported.
 */
export function validateReservedTypeNames(
  program: Program,
  options: { targets: readonly EmitTarget[]; nodes: readonly TypeNode[] },
): boolean {
  const declarations = new Map<
    string,
    { name: string; target: DiagnosticTarget | typeof NoTarget }
  >();
  const declare = (
    node: TypeNode,
    name: string,
    fallback?: DiagnosticTarget,
  ) => {
    const namespace = node.typeName.namespace;
    const key = `${namespace}.${name}`;
    if (!name || declarations.has(key)) return;
    const [resolved] = program.resolveTypeReference(namespace ? key : name);
    declarations.set(key, { name, target: resolved ?? fallback ?? NoTarget });
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

  const targets = options.targets.map((target) =>
    target.type.toLowerCase().trim(),
  );
  let ok = true;
  for (const declaration of declarations.values()) {
    const reasons = new Set<string>();
    for (const target of targets) {
      const reason = reservedTypeNameReason(target, declaration.name);
      if (reason) reasons.add(`${target} (${reason})`);
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