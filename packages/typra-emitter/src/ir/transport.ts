import {
  getTypeName,
  Interface,
  Namespace,
  Operation,
  Program,
  Type,
} from "@typespec/compiler";
import {
  getHttpOperation,
  HttpOperation,
  HttpOperationParameter,
  HttpOperationResponse,
  HttpVerb,
} from "@typespec/http";
import {
  CallableContract,
  CallableOperation,
  collectNamespaceCallableInterfaces,
  lowerTypeSpecCallableContract,
} from "./callable.js";

export type TransportBindingKind =
  | "path"
  | "query"
  | "header"
  | "cookie"
  | "body";

export interface TransportBinding {
  name: string;
  wireName: string;
  type: string;
  kind: TransportBindingKind;
  optional: boolean;
}

export interface TransportResponse {
  statusCodes: string[];
  body?: string;
  contentTypes: string[];
}

export interface TransportOperation {
  contract: string;
  operation: string;
  callable: CallableOperation;
  verb: HttpVerb;
  path: string;
  uriTemplate: string;
  bindings: TransportBinding[];
  responses: TransportResponse[];
}

export interface TransportContract {
  name: string;
  namespace: string;
  callable: CallableContract;
  operations: TransportOperation[];
}

export function lowerTypeSpecTransportContracts(
  program: Program,
  namespace: Namespace,
  rootNamespace: string,
  rootAlias: string,
): TransportContract[] {
  return collectNamespaceCallableInterfaces(namespace)
    .map((iface) =>
      lowerInterfaceTransportContract(program, iface, rootNamespace, rootAlias),
    )
    .filter((contract): contract is TransportContract => contract !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function lowerInterfaceTransportContract(
  program: Program,
  iface: Interface,
  rootNamespace: string,
  rootAlias: string,
): TransportContract | undefined {
  const callable = lowerTypeSpecCallableContract(
    program,
    iface,
    rootNamespace,
    rootAlias,
  );
  const operations = Array.from(iface.operations.values())
    .map((operation) =>
      lowerOperationTransport(program, operation, callable.operations),
    )
    .filter((operation): operation is TransportOperation => operation !== undefined)
    .sort((left, right) => left.operation.localeCompare(right.operation));

  if (operations.length === 0) return undefined;
  return {
    name: callable.name,
    namespace: callable.namespace,
    callable,
    operations,
  };
}

function lowerOperationTransport(
  program: Program,
  operation: Operation,
  callableOperations: CallableOperation[],
): TransportOperation | undefined {
  const [httpOperation, diagnostics] = getHttpOperation(program, operation);
  if (diagnostics.length > 0 || !hasExplicitHttpMetadata(httpOperation)) {
    return undefined;
  }
  const callable = callableOperations.find(
    (candidate) => candidate.name === operation.name,
  );
  if (!callable) return undefined;

  return {
    contract: httpOperation.container.name,
    operation: operation.name,
    callable,
    verb: httpOperation.verb,
    path: httpOperation.path,
    uriTemplate: httpOperation.uriTemplate,
    bindings: lowerBindings(httpOperation),
    responses: httpOperation.responses.map(lowerResponse),
  };
}

function hasExplicitHttpMetadata(httpOperation: HttpOperation): boolean {
  return (
    httpOperation.path !== "/" ||
    httpOperation.uriTemplate !== "/" ||
    httpOperation.parameters.parameters.length > 0 ||
    httpOperation.parameters.body !== undefined
  );
}

function lowerBindings(httpOperation: HttpOperation): TransportBinding[] {
  const bindings: TransportBinding[] = httpOperation.parameters.parameters.map(
    lowerParameterBinding,
  );
  const body = httpOperation.parameters.body;
  if (body) {
    bindings.push({
      name: body.property?.name ?? "body",
      wireName: body.property?.name ?? "body",
      type: typeName(body.type),
      kind: "body",
      optional: false,
    });
  }
  return bindings.sort((left, right) =>
    `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`),
  );
}

function lowerParameterBinding(parameter: HttpOperationParameter): TransportBinding {
  return {
    name: parameter.param.name,
    wireName: bindingWireName(parameter),
    type: typeName(parameter.param.type),
    kind: parameter.type,
    optional: parameter.param.optional,
  };
}

function bindingWireName(parameter: HttpOperationParameter): string {
  return parameter.name;
}

function lowerResponse(response: HttpOperationResponse): TransportResponse {
  const firstBody = response.responses.find((content) => content.body)?.body;
  return {
    statusCodes: [formatStatusCodes(response.statusCodes)],
    ...(firstBody ? { body: typeName(firstBody.type) } : {}),
    contentTypes: response.responses.flatMap(
      (content) => content.body?.contentTypes ?? [],
    ),
  };
}

function formatStatusCodes(
  statusCodes: HttpOperationResponse["statusCodes"],
): string {
  if (statusCodes === "*") return "*";
  if (typeof statusCodes === "number") return String(statusCodes);
  return `${statusCodes.start}-${statusCodes.end}`;
}

function typeName(type: Type): string {
  if (type.kind === "Intrinsic" && type.name === "void") return "void";
  return getTypeName(type, { nameOnly: true, printable: true });
}
