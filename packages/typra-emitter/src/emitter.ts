import { EmitContext, resolvePath, Namespace, Model } from "@typespec/compiler";
import { resolveModel, TypeNode, enumerateTypes } from "./ir/ast.js";
import { TypraEmitterOptions, EmitTarget } from "./lib.js";
import { generateMarkdown } from "./languages/markdown/driver.js";
import { generatePython } from "./languages/python/driver.js";
import { generateCsharp } from "./languages/csharp/driver.js";
import { generateTypeScript } from "./languages/typescript/driver.js";
import { generateGo } from "./languages/go/driver.js";
import { generateJava } from "./languages/java/driver.js";
import { generateRust } from "./languages/rust/driver.js";
import { emitGeneratedFile, emitGeneratedManifest } from "./cleanup/generated-file.js";
import { buildExportSurfaceSnapshot, emitExportSurfaceSnapshot } from "./contract-surface.js";
import { reportTypeSpecCompatibility, shouldBlockUnsupportedTypeSpecToolchain } from "./compatibility.js";
import { buildHydrationBoundarySnapshot, emitHydrationBoundarySnapshot } from "./hydration-seams.js";

// Generator options passed to each generator
export interface GeneratorOptions {
  omitModels?: string[];
  additionalModels?: TypeNode[];
}

/**
 * Filter nodes based on omit-models option.
 * Matches against model name (e.g., "AgentManifest") or fully qualified name (e.g., "Prompty.AgentManifest")
 */
export function filterNodes(nodes: TypeNode[], options?: GeneratorOptions): TypeNode[] {
  const omitModels = options?.omitModels || [];

  // Include additional root models and their type trees
  const additionalModels = options?.additionalModels || [];
  if (additionalModels.length > 0) {
    const existingNames = new Set(nodes.map(n => `${n.typeName.namespace}.${n.typeName.name}`));
    const visited = new Set(existingNames);
    for (const additionalModel of additionalModels) {
      for (const subNode of enumerateTypes(additionalModel, new Set())) {
        const fullName = `${subNode.typeName.namespace}.${subNode.typeName.name}`;
        if (!visited.has(fullName)) {
          nodes.push(subNode);
          visited.add(fullName);
        }

      }
    }
  }

  if (omitModels.length === 0) return nodes;

  return nodes.filter(node => {
    const name = node.typeName.name;
    const fullName = `${node.typeName.namespace}.${name}`;
    return !omitModels.includes(name) && !omitModels.includes(fullName);
  });
}

export function inferRootNamespace(rootObject: string): string {
  const lastDot = rootObject.lastIndexOf(".");
  return lastDot > 0 ? rootObject.slice(0, lastDot) : "Typra";
}

function inferRootAlias(rootNamespace: string): string {
  return rootNamespace.split(".").filter(Boolean).at(-1) || rootNamespace || "Typra";
}

function isUninstantiatedTemplate(model: Model): boolean {
  return !!(
    model.node &&
    "templateParameters" in model.node &&
    model.node.templateParameters.length > 0 &&
    !model.templateMapper
  );
}

function collectNamespaceModels(namespace: Namespace, models: Model[] = []): Model[] {
  for (const [, model] of namespace.models) {
    models.push(model);
  }

  for (const [, childNamespace] of namespace.namespaces) {
    collectNamespaceModels(childNamespace, models);
  }

  return models;
}

// Generator function type for code emitters
type GeneratorFn = (
  context: EmitContext<TypraEmitterOptions>,
  model: TypeNode,
  target: EmitTarget,
  options?: GeneratorOptions
) => Promise<void>;

// Registry of available code generators
const generators: Record<string, GeneratorFn> = {
  markdown: generateMarkdown,
  python: generatePython,
  csharp: generateCsharp,
  typescript: generateTypeScript,
  go: generateGo,
  java: generateJava,
  rust: generateRust,
};


export async function $onEmit(context: EmitContext<TypraEmitterOptions>) {
  const toolchain = reportTypeSpecCompatibility(context);
  if (shouldBlockUnsupportedTypeSpecToolchain(context.options, toolchain)) {
    return;
  }

  const options = {
    emitterOutputDir: context.emitterOutputDir,
    ...context.options,
  }


  // resolving top level model
  // this is the "Model" entry point for the emitter
  const rootObject = options["root-object"];
  const m = context.program.resolveTypeReference(rootObject);
  if (!m[0] || m[0].kind !== "Model") {
    throw new Error(
      `${rootObject} model not found or is not a model type.`
    );
  }

  const rootNamespace = options["root-namespace"] || inferRootNamespace(rootObject);
  const rootAlias = options["root-alias"] || inferRootAlias(rootNamespace);

  const model = resolveModel(context.program, m[0], new Set(), rootNamespace, rootAlias);
  if (options["root-alias"]) {
    model.typeName = {
      namespace: model.typeName.namespace,
      name: options["root-alias"]
    }
  }

  // Discover additional models not reachable from the root.
  // If root-namespace is specified, resolve all models in that namespace
  // so new types are automatically emitted without manual additional-roots.
  const additionalModels: TypeNode[] = [];
  const visited = new Set<string>();

  // Collect names already in the main model tree to avoid duplicates
  const collectNames = (node: TypeNode) => {
    visited.add(`${node.typeName.namespace}.${node.typeName.name}`);
    for (const child of node.childTypes) {
      collectNames(child);
    }
    for (const prop of node.properties) {
      if (prop.type) {
        collectNames(prop.type);
        for (const child of prop.type.childTypes) {
          collectNames(child);
        }
      }
    }
  };
  collectNames(model);

  // Resolve the namespace and iterate all models
  const nsRef = context.program.resolveTypeReference(rootNamespace);
  if (nsRef[0] && nsRef[0].kind === "Namespace") {
    const ns = nsRef[0] as Namespace;
    for (const nsModel of collectNamespaceModels(ns)) {
      const fullName = `${rootNamespace}.${nsModel.name}`;
      if (visited.has(fullName)) continue;

      // Skip uninstantiated template declarations (e.g., Named<T>, Id<T>)
      if (isUninstantiatedTemplate(nsModel)) {
        continue;
      }

      const additionalNode = resolveModel(
        context.program, nsModel, new Set(),
        rootNamespace,
        rootAlias
      );
      additionalModels.push(additionalNode);
      visited.add(fullName);
    }
  }

  // Also process any explicit additional-roots (for types outside the namespace)
  const additionalRoots = options["additional-roots"] || [];
  for (const rootName of additionalRoots) {
    if (visited.has(rootName)) continue;
    const ref = context.program.resolveTypeReference(rootName);
    if (!ref[0] || ref[0].kind !== "Model") {
      console.warn(`Warning: additional-root '${rootName}' not found or is not a model type. Skipping.`);
      continue;
    }
    const additionalNode = resolveModel(
      context.program, ref[0], new Set(),
      rootNamespace,
      rootAlias
    );
    additionalModels.push(additionalNode);
    visited.add(rootName);
  }

  const targets = options["emit-targets"] || [];
  const generatorOptions: GeneratorOptions = {
    omitModels: options["omit-models"] || [],
    additionalModels: additionalModels,
  };
  const exportSurfaceNodes = filterNodes(Array.from(enumerateTypes(model)), {
    omitModels: generatorOptions.omitModels,
    additionalModels: [...additionalModels],
  });

  // Dispatch to registered generators
  for (const target of targets) {
    const generatorName = target.type.toLowerCase().trim();
    const generator = generators[generatorName];
    if (generator) {
      await generator(context, model, target, generatorOptions);
    }
  }

  await emitGeneratedFile(
    context,
    resolvePath(context.emitterOutputDir, "json-ast", "model.json"),
    JSON.stringify(model.getSanitizedObject(), null, 2),
    { marker: false },
  );

  const exportSurfaceSnapshot = buildExportSurfaceSnapshot(rootObject, rootNamespace, rootAlias, targets, exportSurfaceNodes, toolchain);
  await emitExportSurfaceSnapshot(context, exportSurfaceSnapshot);

  await emitHydrationBoundarySnapshot(
    context,
    buildHydrationBoundarySnapshot(exportSurfaceSnapshot, options),
  );

  await emitGeneratedManifest(context);
}
