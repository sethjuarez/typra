import {
  getDoc,
  getNamespaceFullName,
  getTypeName,
  Interface,
  Model,
  Namespace,
  Operation,
  Program,
  Type,
} from "@typespec/compiler";
import { getStateScalar, OperationEffectEntry } from "../decorators.js";
import { StateKeys } from "../lib.js";
import { TypeNode } from "./ast.js";
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
    params[name] = typeToCallableName(property.type);
  }
  return params;
}

function typeToCallableName(type: Type): string {
  if (type.kind === "Intrinsic" && type.name === "void") {
    return "void";
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
