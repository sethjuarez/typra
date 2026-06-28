import { EmitContext, emitFile, resolvePath } from "@typespec/compiler";
import { EmitTarget, TypraEmitterOptions } from "./lib.js";
import { TypeNode } from "./ir/ast.js";
import { toKebabCase, toSnakeCase } from "./ir/utilities.js";
import { getToolchainMetadata, ToolchainMetadata } from "./compatibility.js";

export interface ExportSurfaceMethod {
  name: string;
  returns: string;
  params: Record<string, string>;
  optional: boolean;
  sync: boolean;
}

export interface ExportSurfaceProtocol {
  name: string;
  group: string;
  symbol: string;
  source: string;
  methods: ExportSurfaceMethod[];
}

export interface ExportSurfaceEntry {
  name: string;
  kind: "type" | "value";
  group: string;
  source: string;
  protocol: boolean;
}

export interface ExportSurfaceGroup {
  name: string;
  exports: string[];
  modules: string[];
}

export interface TargetExportSurface {
  target: string;
  outputRoot: string;
  packageName?: string;
  namespace?: string;
  rootExports: string[];
  exports: ExportSurfaceEntry[];
  groups: ExportSurfaceGroup[];
  protocols: ExportSurfaceProtocol[];
  modules: string[];
}

export interface ExportSurfaceSnapshot {
  emitter: "typra-emitter";
  version: 1;
  toolchain: ToolchainMetadata;
  root: {
    object: string;
    namespace: string;
    alias: string;
  };
  targets: TargetExportSurface[];
}

export function buildExportSurfaceSnapshot(
  rootObject: string,
  rootNamespace: string,
  rootAlias: string,
  targets: EmitTarget[],
  nodes: TypeNode[],
  toolchain: ToolchainMetadata = getToolchainMetadata(),
): ExportSurfaceSnapshot {
  return {
    emitter: "typra-emitter",
    version: 1,
    toolchain,
    root: {
      object: rootObject,
      namespace: rootNamespace,
      alias: rootAlias,
    },
    targets: targets
      .map((target) => buildTargetSurface(rootNamespace, target, nodes))
      .sort((left, right) => left.target.localeCompare(right.target)),
  };
}

export async function emitExportSurfaceSnapshot(
  context: EmitContext<TypraEmitterOptions>,
  snapshot: ExportSurfaceSnapshot,
): Promise<void> {
  await emitFile(context.program, {
    path: resolvePath(context.emitterOutputDir, ".typra-generated", "export-surfaces.json"),
    content: `${JSON.stringify(snapshot, null, 2)}\n`,
  });
}

function buildTargetSurface(rootNamespace: string, target: EmitTarget, nodes: TypeNode[]): TargetExportSurface {
  const targetName = normalizeTarget(target.type);
  const baseTypes = nodes.filter((node) => !node.base).sort(compareNodes);
  const groups = buildGroups(targetName, baseTypes);
  const exports = buildExports(targetName, baseTypes);
  const rootExports = uniqueSorted(exports.map((entry) => entry.name));
  const protocols = nodes
    .filter((node) => node.isProtocol)
    .sort(compareNodes)
    .map((node) => ({
      name: node.typeName.name,
      group: node.group || "",
      symbol: node.typeName.name,
      source: sourceFor(targetName, node, node.group || ""),
      methods: node.methods
        .map((method) => ({
          name: method.name,
          returns: method.returns,
          params: sortRecord(method.params),
          optional: method.optional,
          sync: method.sync,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }));

  return {
    target: targetName,
    outputRoot: target["output-dir"] || targetName,
    ...targetMetadata(rootNamespace, targetName, target),
    rootExports,
    exports,
    groups,
    protocols,
    modules: buildModules(targetName, baseTypes),
  };
}

function buildExports(targetName: string, baseTypes: TypeNode[]): ExportSurfaceEntry[] {
  return baseTypes
    .flatMap((node) => {
      const group = node.group || "";
      const source = sourceFor(targetName, node, group);
      const kind: ExportSurfaceEntry["kind"] = node.isProtocol ? "type" : "value";
      return [node, ...node.childTypes].map((exportedNode) => ({
        name: exportedNode.typeName.name,
        kind,
        group,
        source,
        protocol: node.isProtocol,
      }));
    })
    .sort((left, right) => {
      const byGroup = left.group.localeCompare(right.group);
      if (byGroup !== 0) return byGroup;
      return left.name.localeCompare(right.name);
    });
}

function buildGroups(targetName: string, baseTypes: TypeNode[]): ExportSurfaceGroup[] {
  const groupMap = new Map<string, TypeNode[]>();
  for (const node of baseTypes) {
    const group = node.group || "";
    if (!group) continue;
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group)!.push(node);
  }

  return Array.from(groupMap.entries())
    .map(([name, groupNodes]) => ({
      name,
      exports: uniqueSorted(groupNodes.flatMap((node) => [node.typeName.name, ...node.childTypes.map((child) => child.typeName.name)])),
      modules: uniqueSorted(groupNodes.map((node) => groupModuleName(targetName, node))),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildModules(targetName: string, baseTypes: TypeNode[]): string[] {
  if (targetName === "rust") {
    return uniqueSorted(["context", ...baseTypes.map((node) => node.group || moduleName(node))]);
  }

  return uniqueSorted(baseTypes.map((node) => sourceFor(targetName, node, node.group || "")));
}

function targetMetadata(rootNamespace: string, targetName: string, target: EmitTarget): Pick<TargetExportSurface, "packageName" | "namespace"> {
  if (targetName === "go") {
    return {
      packageName: target["package-name"] || goPackageNameFromNamespace(rootNamespace),
    };
  }

  if (targetName === "csharp") {
    return {
      namespace: target.namespace || rootNamespace,
    };
  }

  if (targetName === "java") {
    return {
      packageName: target["package-name"] || rootNamespace.toLowerCase(),
    };
  }

  if (targetName === "typescript") {
    return {
      namespace: target.namespace || rootNamespace.replace(/\.Core$/, ""),
    };
  }

  if (targetName === "python") {
    return {
      packageName: rootNamespace.toLowerCase(),
    };
  }

  return {};
}

function sourceFor(targetName: string, node: TypeNode, group: string): string {
  const name = node.typeName.name;
  switch (targetName) {
    case "typescript":
      return group ? `./${group}/${toKebabCase(name)}` : `./${toKebabCase(name)}`;
    case "python":
      return group ? `.${group}` : `._${name}`;
    case "rust":
      return group ? `${group}::${toSnakeCase(name)}` : toSnakeCase(name);
    case "go":
      return `${toSnakeCase(name)}.go`;
    case "csharp":
      return group ? `${group}/${name}.cs` : `${name}.cs`;
    case "java":
      return `${name}.java`;
    default:
      return name;
  }
}

function moduleName(node: TypeNode): string {
  return toSnakeCase(node.typeName.name);
}

function groupModuleName(targetName: string, node: TypeNode): string {
  switch (targetName) {
    case "typescript":
      return toKebabCase(node.typeName.name);
    case "python":
      return `_${node.typeName.name}`;
    case "csharp":
      return `${node.typeName.name}.cs`;
    case "java":
      return `${node.typeName.name}.java`;
    default:
      return moduleName(node);
  }
}

function normalizeTarget(target: string): string {
  return target.toLowerCase().trim();
}

function goPackageNameFromNamespace(namespace: string): string {
  return namespace.toLowerCase().replace(/\./g, "");
}

function compareNodes(left: TypeNode, right: TypeNode): number {
  const leftGroup = left.group || "";
  const rightGroup = right.group || "";
  const byGroup = leftGroup.localeCompare(rightGroup);
  if (byGroup !== 0) return byGroup;
  return left.typeName.name.localeCompare(right.typeName.name);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}
