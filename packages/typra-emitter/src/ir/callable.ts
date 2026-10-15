import {
  getDoc,
  getNamespaceFullName,
  getTypeName,
  Interface,
  Model,
  ModelProperty,
  Namespace,
  Operation,
  Program,
  Scalar,
  Type,
  Union,
} from "@typespec/compiler";
import {
  getStateScalar,
  getStateValue,
  OperationEffectEntry,
} from "../decorators.js";
import { StateKeys } from "../lib.js";
import { Coercion, resolveModel, TypeNode } from "./ast.js";
import type { PolymorphicDispatchDecl } from "./declarations.js";
import { lowerPolymorphicDispatch } from "./lower.js";
import { CallableVector, lowerOperationVectors } from "./vector.js";

export type CallableContractSourceKind =
  | "legacy-protocol-model"
  | "typespec-interface";

export interface CallableSource {
  kind: CallableContractSourceKind;
  namespace: string;
  symbol: string;
  group: string;
}

export interface CallableHydrationSeam {
  seamKind: "protocol-adapter";
  implementation: "handwritten";
  generatedBoundary: "interface";
}

/**
 * Behavioral polymorphic dispatch metadata attached to a seam interface by
 * `@dispatch`. The interface is resolved at runtime by the value of the
 * discriminator field, read at a deterministic access path from the seam
 * methods' parameters. This carries the mechanism only — never a roster of
 * concrete implementations, which stay runtime-registered.
 */
export interface CallableDispatch {
  /** The discriminator ModelProperty, identified by its owning model + field. */
  discriminator: {
    /** Name of the model that declares the discriminator field. */
    model: string;
    /** Name of the discriminator field. */
    field: string;
  };
  /**
   * Deterministic field-access path from a seam parameter to the discriminator
   * field, e.g. `agent.template.format.kind`. Uniquely reachable from the
   * parameter set — an unreachable or ambiguous field is a diagnostic, not a
   * guessed path.
   */
  path: string;
  /**
   * The SAME lowered `PolymorphicDispatchDecl` that drives the discriminator
   * model's shape `Load` switch, resolved from `discriminator.model`. This is
   * the Part III IR edge: it lets every emitter render the behavioral resolver
   * as the twin of the shape switch (same `variants`, `isClosed`,
   * `defaultVariant`) instead of interpreting a stringly-typed runtime path.
   * Absent only when the discriminator model is not polymorphic (no
   * discriminator + child types), which keeps undispatched-adjacent shapes
   * byte-identical.
   */
  decl?: PolymorphicDispatchDecl;
}

export interface CallableOperation {
  name: string;
  returns: string;
  description: string;
  params: Record<string, string>;
  optional: boolean;
  sync: boolean;
  runtimeCancellable: boolean;
  atomic: boolean;
  nonFatal: boolean;
  vectors?: CallableVector[];
  source: CallableSource;
}

export interface CallableContract {
  name: string;
  namespace: string;
  group: string;
  description: string;
  source: CallableSource;
  hydration: CallableHydrationSeam;
  operations: CallableOperation[];
  /**
   * Present when the interface is decorated with `@dispatch`. Absent for plain
   * seam interfaces, keeping the shape byte-identical for undecorated contracts.
   */
  dispatch?: CallableDispatch;
}

export function lowerLegacyCallableContracts(
  nodes: TypeNode[],
): CallableContract[] {
  return nodes
    .filter((node) => node.isProtocol)
    .map(lowerLegacyCallableContract)
    .sort(compareCallableContracts);
}

export function lowerLegacyCallableContract(node: TypeNode): CallableContract {
  const source: CallableSource = {
    kind: "legacy-protocol-model",
    namespace: node.typeName.namespace,
    symbol: node.typeName.name,
    group: node.group || "",
  };

  return {
    name: node.typeName.name,
    namespace: node.typeName.namespace,
    group: node.group || "",
    description: node.description || "",
    source,
    hydration: {
      seamKind: "protocol-adapter",
      implementation: "handwritten",
      generatedBoundary: "interface",
    },
    operations: (node.methods || [])
      .map((method) => ({
        name: method.name,
        returns: method.returns,
        description: method.description,
        params: method.params || {},
        optional: method.optional ?? false,
        sync: method.sync ?? false,
        runtimeCancellable: method.runtimeCancellable ?? false,
        atomic: method.atomic ?? false,
        nonFatal: method.nonFatal ?? false,
        source,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    ...(node.dispatch ? { dispatch: node.dispatch } : {}),
  };
}

export function collectNamespaceCallableInterfaces(
  namespace: Namespace,
  interfaces: Interface[] = [],
): Interface[] {
  for (const [, iface] of namespace.interfaces) {
    if (isUninstantiatedTemplateInterface(iface)) continue;
    interfaces.push(iface);
  }

  for (const [, childNamespace] of namespace.namespaces) {
    collectNamespaceCallableInterfaces(childNamespace, interfaces);
  }

  return interfaces;
}

export function lowerTypeSpecCallableContracts(
  program: Program,
  namespace: Namespace,
  rootNamespace: string,
  rootAlias: string,
): CallableContract[] {
  return collectNamespaceCallableInterfaces(namespace)
    .map((iface) =>
      lowerTypeSpecCallableContract(program, iface, rootNamespace, rootAlias),
    )
    .sort(compareCallableContracts);
}

export function lowerTypeSpecCallableContract(
  program: Program,
  iface: Interface,
  rootNamespace: string,
  rootAlias: string,
): CallableContract {
  const namespace = getCallableNamespace(iface.namespace, rootNamespace);
  const name = applyRootAlias(
    getTypeName(iface, { nameOnly: true, printable: true }),
    rootNamespace,
    rootAlias,
  );
  const source: CallableSource = {
    kind: "typespec-interface",
    namespace,
    symbol: name,
    group: "",
  };

  return {
    name,
    namespace,
    group: "",
    description: getDoc(program, iface) || "",
    source,
    hydration: {
      seamKind: "protocol-adapter",
      implementation: "handwritten",
      generatedBoundary: "interface",
    },
    operations: Array.from(iface.operations.values())
      .map((operation) =>
        lowerTypeSpecCallableOperation(program, operation, source),
      )
      .sort((left, right) => left.name.localeCompare(right.name)),
    ...(resolveCallableDispatch(program, iface, rootNamespace, rootAlias) ??
      {}),
  };
}

export function callableContractToProtocolNode(
  contract: CallableContract,
): TypeNode {
  const node = new TypeNode({} as Model, contract.description);
  node.typeName = {
    namespace: contract.namespace,
    name: contract.name,
  };
  node.group = contract.group;
  node.isProtocol = true;
  node.dispatch = contract.dispatch;
  node.methods = contract.operations.map((operation) => ({
    name: operation.name,
    returns: operation.returns,
    description: operation.description,
    params: operation.params,
    optional: operation.optional,
    sync: operation.sync,
    runtimeCancellable: operation.runtimeCancellable,
    atomic: operation.atomic,
    nonFatal: operation.nonFatal,
  }));
  return node;
}

/**
 * Resolves the `@dispatch` discriminator for a seam interface into a
 * deterministic access path from its methods' parameters. Returns
 * `{ dispatch }` when the discriminator is uniquely reachable, or `undefined`
 * when the interface is not dispatched or when the field is unreachable or
 * ambiguously reachable (both reported as diagnostics — never a guessed path).
 */
function resolveCallableDispatch(
  program: Program,
  iface: Interface,
  rootNamespace: string,
  rootAlias: string,
): { dispatch: CallableDispatch } | undefined {
  const discriminator = getStateScalar<ModelProperty>(
    program,
    StateKeys.dispatch,
    iface,
  );
  // Guard against non-ModelProperty state (a mock program's stateMap may fall
  // back to another map): only a real discriminator ModelProperty is resolved.
  if (!discriminator || discriminator.kind !== "ModelProperty") return undefined;

  const paths = new Set<string>();
  for (const operation of iface.operations.values()) {
    for (const [paramName, param] of operation.parameters.properties) {
      for (const found of collectDispatchPaths(
        program,
        paramName,
        param.type,
        discriminator,
      )) {
        paths.add(found);
      }
    }
  }

  const candidates = Array.from(paths).sort();
  const field = discriminator.name;
  const model = discriminator.model?.name ?? "";

  if (candidates.length === 0) {
    program.reportDiagnostic({
      code: "typra-emitter-dispatch-unreachable",
      message: `@dispatch discriminator ${model}.${field} is not reachable from any parameter of interface ${iface.name}. The discriminator must be reachable via a field-access path from a seam method parameter.`,
      severity: "error",
      target: iface,
    });
    return undefined;
  }

  if (candidates.length > 1) {
    program.reportDiagnostic({
      code: "typra-emitter-dispatch-ambiguous",
      message: `@dispatch discriminator ${model}.${field} is ambiguously reachable from the parameters of interface ${iface.name} via multiple paths: ${candidates.join(
        ", ",
      )}. The discriminator must be uniquely reachable.`,
      severity: "error",
      target: iface,
    });
    return undefined;
  }

  return {
    dispatch: {
      discriminator: { model, field },
      path: candidates[0],
      ...resolveDispatchDecl(
        program,
        discriminator,
        rootNamespace,
        rootAlias,
      ),
    },
  };
}

/**
 * Resolves the discriminator model to the SAME `PolymorphicDispatchDecl` that
 * drives its shape `Load` switch, by lowering it through the shared shape rail
 * (`resolveModel` → `lowerPolymorphicDispatch`). Returns `{ decl }` when the
 * model is polymorphic (has a discriminator + child types), or `{}` otherwise
 * so the spread stays a no-op for non-polymorphic discriminator models.
 *
 * The discriminator model's shape lowering is the source of truth for the decl.
 * A user-authored discriminator model always carries a syntax `node`; synthetic
 * models fabricated by unit tests do not, and `resolveModel` cannot traverse
 * them. We detect that precise case up front and degrade to path-only dispatch,
 * so the `catch` is only a defense-in-depth net — not a way to swallow a shape
 * bug on a real model. Any genuine lowering failure on a real model still
 * surfaces through the independent shape pass, which lowers the SAME model.
 */
function resolveDispatchDecl(
  program: Program,
  discriminator: ModelProperty,
  rootNamespace: string,
  rootAlias: string,
): { decl?: PolymorphicDispatchDecl } {
  const model = discriminator.model;
  // A real, user-authored discriminator model always has a syntax node; a
  // model without one is synthetic (unit-test mock) and is not traversable.
  if (!model || !model.node) return {};
  try {
    const node: TypeNode = resolveModel(
      program,
      model,
      new Set(),
      rootNamespace,
      rootAlias,
    );
    const decl = lowerPolymorphicDispatch(node);
    return decl ? { decl } : {};
  } catch {
    return {};
  }
}

/**
 * When a union property is the coerce-canonical spelling of a single model,
 * return that model. A `@coerce(S)` on model M declares that a bare scalar `S`
 * IS an M — the scalar arm is pure shorthand for the canonical,
 * discriminator-bearing shape. So for a `M | S` union whose non-null arms are
 * exactly one Model M and one Scalar S, where M carries a coercion FROM S,
 * dispatch path resolution resolves the discriminator against M.
 *
 * A plain `A | B` union with no such coercion returns `undefined` and stays
 * unreachable: without a `@coerce` designating the canonical arm there is no
 * principled way to pick one, and guessing is exactly what the unreachable /
 * ambiguous diagnostics exist to prevent.
 *
 * This is a LOCAL read of the coercion state for path resolution only — it
 * never mutates or canonicalizes the union type, which remains the load-bearing
 * "accepts an object OR a shorthand scalar" wire contract consumed by schema
 * emission and the scalar→object constructors. It mirrors the local
 * `T | null → T?` fold in `typeToCallableName`, which likewise reads through a
 * union without rewriting it.
 */
function coerceCanonicalModelArm(
  program: Program,
  union: Union,
): Model | undefined {
  const variants = nonNullUnionVariants(union);
  if (variants.length !== 2) return undefined;
  const models = variants.filter(
    (variant): variant is Model =>
      variant.kind === "Model" && variant.name !== "Array",
  );
  const scalars = variants.filter(
    (variant): variant is Scalar => variant.kind === "Scalar",
  );
  if (models.length !== 1 || scalars.length !== 1) return undefined;
  const target = models[0];
  const scalarName = scalars[0].name;
  const coercions = getStateValue<Coercion>(
    program,
    StateKeys.coercions,
    target,
  );
  return coercions.some((coercion) => coercion.scalar === scalarName)
    ? target
    : undefined;
}

/**
 * Enumerates every distinct field-access path from a seam parameter to the
 * discriminator ModelProperty. Traversal is order-stable (declaration order)
 * and cycle-guarded per path; array-typed fields are not traversed because an
 * indexed hop is not a single scalar access. A `Model | scalar` field carrying
 * a `@coerce` FROM that scalar is traversed through its coerce-canonical model
 * arm (see `coerceCanonicalModelArm`), so a discriminator behind the common
 * "object OR shorthand string" union spelling stays reachable.
 */
function collectDispatchPaths(
  program: Program,
  rootName: string,
  rootType: Type,
  discriminator: ModelProperty,
): string[] {
  const found: string[] = [];

  const walk = (type: Type, prefix: string, visited: ReadonlySet<Model>) => {
    // A `Model | scalar` union with a `@coerce` FROM that scalar is the
    // shorthand spelling of the coerce-target model: resolve the discriminator
    // against the model arm at the SAME access path (the scalar arm is sugar for
    // it, not a distinct field hop). Only the coerce-designated arm is traversed
    // — a plain `A | B` union stays unreachable rather than guessing an arm.
    if (type.kind === "Union") {
      const target = coerceCanonicalModelArm(program, type);
      if (target) walk(target, prefix, visited);
      return;
    }
    if (type.kind !== "Model" || type.name === "Array") return;
    const model = type as Model;
    if (visited.has(model)) return;
    const nextVisited = new Set(visited);
    nextVisited.add(model);
    for (const [propName, property] of model.properties) {
      const propPath = `${prefix}.${propName}`;
      if (property === discriminator) {
        found.push(propPath);
        continue;
      }
      walk(property.type, propPath, nextVisited);
    }
  };

  walk(rootType, rootName, new Set());
  return found;
}

function lowerTypeSpecCallableOperation(
  program: Program,
  operation: Operation,
  source: CallableSource,
): CallableOperation {
  const vectors = lowerOperationVectors(program, operation);
  const effects =
    getStateScalar<OperationEffectEntry>(
      program,
      StateKeys.operationEffects,
      operation,
    ) ?? {};
  return {
    name: operation.name,
    returns: typeToCallableName(operation.returnType),
    description: getDoc(program, operation) || "",
    params: lowerOperationParameters(operation),
    optional: effects.optional === true,
    sync: effects.sync === true,
    runtimeCancellable: effects.runtimeCancellable === true,
    atomic: effects.atomic === true,
    nonFatal: effects.nonFatal === true,
    ...(vectors.length > 0 ? { vectors } : {}),
    source,
  };
}

function lowerOperationParameters(operation: Operation): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, property] of operation.parameters.properties) {
    const typeName = typeToCallableName(property.type);
    // Encode optionality with the trailing "?" the callable seam already uses for
    // nullability across every backend (Rust Option<T>, Go *T, C# T?, Python T | None,
    // TS T | undefined). Guard against double-suffixing when the type is already
    // nullable (e.g. an optional `T | null` parameter).
    params[name] =
      property.optional && !typeName.endsWith("?") ? `${typeName}?` : typeName;
  }
  return params;
}

/** Strip a `null` variant from a union, returning the remaining variant types. */
function nonNullUnionVariants(union: Union): Type[] {
  return Array.from(union.variants.values())
    .map((variant) => variant.type)
    .filter(
      (variant) => !(variant.kind === "Intrinsic" && variant.name === "null"),
    );
}

function typeToCallableName(type: Type): string {
  if (type.kind === "Intrinsic" && type.name === "void") {
    return "void";
  }

  if (type.kind === "Union") {
    const nonNull = nonNullUnionVariants(type);
    // `T | null` is the blessed nullable spelling on the operation seam: fold it to the
    // trailing-"?" encoding so backends render Option<T>/*T/T? instead of leaking raw
    // union text (and synthesizing a phantom `null` type import). Only a single non-null
    // variant collapses; genuine multi-variant unions fall through to getTypeName so the
    // existing unsupported-union diagnostics still surface downstream.
    if (nonNull.length === 1 && nonNull.length < type.variants.size) {
      const inner = typeToCallableName(nonNull[0]);
      return inner.endsWith("?") ? inner : `${inner}?`;
    }
  }

  if (type.kind === "Model" && type.name === "Array") {
    const elementType = (type as Model & { indexer?: { value?: Type } }).indexer
      ?.value;
    if (elementType) {
      return `${typeToCallableName(elementType)}[]`;
    }
  }

  return getTypeName(type, { nameOnly: true, printable: true });
}

function getCallableNamespace(
  namespace: Namespace | undefined,
  rootNamespace: string,
): string {
  if (!namespace) return rootNamespace;
  const fullName = getNamespaceFullName(namespace);
  if (!rootNamespace.includes(".")) {
    const parts = fullName.split(".");
    parts[0] = rootNamespace;
    return parts.join(".");
  }
  return fullName;
}

function applyRootAlias(
  name: string,
  rootNamespace: string,
  rootAlias: string,
): string {
  if (!rootAlias) return name;
  const rootName = rootNamespace.split(".").at(-1) || rootNamespace;
  return name.replace(rootName, rootAlias);
}

function isUninstantiatedTemplateInterface(iface: Interface): boolean {
  return !!(
    iface.node &&
    "templateParameters" in iface.node &&
    iface.node.templateParameters.length > 0 &&
    !(iface as Interface & { templateMapper?: unknown }).templateMapper
  );
}

function compareCallableContracts(
  left: CallableContract,
  right: CallableContract,
): number {
  const byGroup = left.group.localeCompare(right.group);
  if (byGroup !== 0) return byGroup;
  return left.name.localeCompare(right.name);
}
