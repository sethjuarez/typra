import type { EmitTarget } from "../lib.js";
import type { TypeNode } from "./ast.js";

export type NamespaceTarget =
  | "typescript"
  | "python"
  | "csharp"
  | "java"
  | "go"
  | "rust"
  | "swift"
  | "markdown";

export interface NamespaceProjection {
  target: NamespaceTarget;
  sourceNamespace: string;
  semanticRoot: string;
  relativeNamespace: string[];
  isOutsideSemanticRoot: boolean;
  targetNamespace?: string;
  packageName?: string;
  moduleName?: string;
  importPath?: string;
  filesystemPath: string[];
  filesystemPathKind: "root-relative" | "package" | "flat";
  symbolPrefix?: string;
}

export interface NamespaceProjectionOptions {
  target: NamespaceTarget;
  sourceNamespace: string;
  semanticRoot?: string;
  emitTarget?: Pick<
    EmitTarget,
    "namespace" | "package-name" | "import-path" | "namespace-output"
  >;
}

export interface NamespaceGroupSnapshot {
  node: TypeNode;
  group: string;
}

export type NamespaceOutputMode = "structural" | "flat";

export function projectNamespace(
  options: NamespaceProjectionOptions,
): NamespaceProjection {
  const semanticRoot = options.semanticRoot || options.sourceNamespace;
  const relative = relativeNamespaceProjection(options.sourceNamespace, semanticRoot);
  const relativeNamespace = relative.segments;
  const configuredNamespace = options.emitTarget?.namespace;
  const configuredPackage = options.emitTarget?.["package-name"];
  const configuredImportPath = options.emitTarget?.["import-path"];

  switch (options.target) {
    case "typescript": {
      const targetNamespace =
        configuredNamespace || options.sourceNamespace.replace(/\.Core$/, "");
      return {
        target: options.target,
        sourceNamespace: options.sourceNamespace,
        semanticRoot,
        relativeNamespace,
        isOutsideSemanticRoot: relative.isOutsideSemanticRoot,
        targetNamespace,
        moduleName: toKebabSegments(relativeNamespace).join("/"),
        importPath: configuredImportPath ?? "../src/index",
        filesystemPath: toKebabSegments(relativeNamespace),
        filesystemPathKind: "root-relative",
      };
    }
    case "python": {
      const packageName =
        configuredPackage ?? lowerDotNamespace(options.sourceNamespace);
      const importPath = configuredImportPath ?? packageName;
      return {
        target: options.target,
        sourceNamespace: options.sourceNamespace,
        semanticRoot,
        relativeNamespace,
        isOutsideSemanticRoot: relative.isOutsideSemanticRoot,
        packageName,
        moduleName: lowerDotNamespace(relativeNamespace.join(".")),
        importPath,
        filesystemPath: toPythonSegments(relativeNamespace),
        filesystemPathKind: "root-relative",
      };
    }
    case "csharp": {
      const targetNamespace = configuredNamespace || options.sourceNamespace;
      return {
        target: options.target,
        sourceNamespace: options.sourceNamespace,
        semanticRoot,
        relativeNamespace,
        isOutsideSemanticRoot: relative.isOutsideSemanticRoot,
        targetNamespace,
        filesystemPath: relativeNamespace,
        filesystemPathKind: "root-relative",
      };
    }
    case "java": {
      const packageName = javaPackageName(
        configuredPackage ?? configuredNamespace ?? options.sourceNamespace,
      );
      return {
        target: options.target,
        sourceNamespace: options.sourceNamespace,
        semanticRoot,
        relativeNamespace,
        isOutsideSemanticRoot: relative.isOutsideSemanticRoot,
        packageName,
        filesystemPath: packageName.split("."),
        filesystemPathKind: "package",
      };
    }
    case "go": {
      const packageName =
        configuredPackage ?? goPackageNameFromNamespace(options.sourceNamespace);
      return {
        target: options.target,
        sourceNamespace: options.sourceNamespace,
        semanticRoot,
        relativeNamespace,
        isOutsideSemanticRoot: relative.isOutsideSemanticRoot,
        packageName,
        importPath: configuredImportPath ?? packageName,
        filesystemPath: [],
        filesystemPathKind: "flat",
      };
    }
    case "rust": {
      return {
        target: options.target,
        sourceNamespace: options.sourceNamespace,
        semanticRoot,
        relativeNamespace,
        isOutsideSemanticRoot: relative.isOutsideSemanticRoot,
        moduleName: toSnakeSegments(relativeNamespace).join("::"),
        importPath: configuredImportPath ?? "crate",
        filesystemPath: toSnakeSegments(relativeNamespace),
        filesystemPathKind: "root-relative",
      };
    }
    case "swift": {
      const moduleName = swiftModuleName(
        configuredPackage ?? options.sourceNamespace,
      );
      return {
        target: options.target,
        sourceNamespace: options.sourceNamespace,
        semanticRoot,
        relativeNamespace,
        isOutsideSemanticRoot: relative.isOutsideSemanticRoot,
        moduleName,
        filesystemPath: relativeNamespace,
        filesystemPathKind: "root-relative",
      };
    }
    case "markdown":
      return {
        target: options.target,
        sourceNamespace: options.sourceNamespace,
        semanticRoot,
        relativeNamespace,
        isOutsideSemanticRoot: relative.isOutsideSemanticRoot,
        filesystemPath: toKebabSegments(relativeNamespace),
        filesystemPathKind: "root-relative",
      };
  }
}

export function relativeNamespaceSegments(
  sourceNamespace: string,
  semanticRoot: string,
): string[] {
  return relativeNamespaceProjection(sourceNamespace, semanticRoot).segments;
}

export function applyNamespaceGroups(
  nodes: Iterable<TypeNode>,
  options: {
    target: NamespaceTarget;
    semanticRoot?: string;
    emitTarget?: Pick<
      EmitTarget,
      "namespace" | "package-name" | "import-path" | "namespace-output"
    >;
    namespaceOutput?: NamespaceOutputMode;
  },
): NamespaceGroupSnapshot[] {
  if (resolveNamespaceOutputMode(options) === "flat") {
    return [];
  }

  const snapshots: NamespaceGroupSnapshot[] = [];
  for (const node of nodes) {
    snapshots.push({ node, group: node.group });
    const projection = projectNamespace({
      target: options.target,
      sourceNamespace: node.typeName.namespace,
      semanticRoot: options.semanticRoot,
      emitTarget: options.emitTarget,
    });
    if (projection.filesystemPathKind !== "root-relative") continue;
    node.group = joinPathSegments([...projection.filesystemPath, node.group]);
  }

  return snapshots;
}

export function resolveNamespaceOutputMode(options: {
  namespaceOutput?: NamespaceOutputMode;
  emitTarget?: Pick<EmitTarget, "namespace-output">;
}): NamespaceOutputMode {
  return (
    options.emitTarget?.["namespace-output"] ??
    options.namespaceOutput ??
    "structural"
  );
}

export function restoreNamespaceGroups(
  snapshots: Iterable<NamespaceGroupSnapshot>,
): void {
  for (const snapshot of snapshots) {
    snapshot.node.group = snapshot.group;
  }
}

export function relativeNamespaceProjection(
  sourceNamespace: string,
  semanticRoot: string,
): { segments: string[]; isOutsideSemanticRoot: boolean } {
  if (sourceNamespace === semanticRoot) {
    return { segments: [], isOutsideSemanticRoot: false };
  }
  const prefix = `${semanticRoot}.`;
  if (sourceNamespace.startsWith(prefix)) {
    return {
      segments: sourceNamespace.slice(prefix.length).split(".").filter(Boolean),
      isOutsideSemanticRoot: false,
    };
  }
  return {
    segments: sourceNamespace.split(".").filter(Boolean),
    isOutsideSemanticRoot: true,
  };
}

export function javaPackageName(namespace: string): string {
  return (
    namespace
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, ".")
      .replace(/^\.+|\.+$/g, "") || "typra"
  );
}

export function goPackageNameFromNamespace(namespace: string): string {
  return namespace.toLowerCase().replace(/\./g, "");
}

export function swiftModuleName(rawName: string): string {
  const parts = rawName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => toPascalCase(part));
  const candidate = parts.join("") || "TypraGenerated";
  return /^[0-9]/.test(candidate) ? `Typra${candidate}` : candidate;
}

function lowerDotNamespace(namespace: string): string {
  return namespace.toLowerCase();
}

function toPythonSegments(segments: string[]): string[] {
  return segments.map((segment) => segment.toLowerCase());
}

function toKebabSegments(segments: string[]): string[] {
  return segments.map((segment) =>
    segment
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[\s_.]+/g, "-")
      .toLowerCase(),
  );
}

function toSnakeSegments(segments: string[]): string[] {
  return segments.map((segment) =>
    segment
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[\s.-]+/g, "_")
      .toLowerCase(),
  );
}

function toPascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function joinPathSegments(segments: string[]): string {
  return segments
    .flatMap((segment) => segment.split(/[\\/]+/))
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}
