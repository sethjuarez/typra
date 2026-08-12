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
  getAuthenticationForOperation,
  type Authentication,
  type HttpAuth,
  type OAuth2Flow,
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

export interface TransportAuthRequirement {
  options: TransportAuthOption[];
}

export interface TransportAuthOption {
  schemes: TransportAuthScheme[];
}

export interface TransportAuthScheme {
  id: string;
  type: string;
  description?: string;
  scheme?: string;
  in?: "header" | "query" | "cookie";
  name?: string;
  scopes?: string[];
  flows?: TransportOAuth2Flow[];
  openIdConnectUrl?: string;
}

export interface TransportOAuth2Flow {
  type: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes: string[];
}

export interface TransportResponse {
  statusCodes: string[];
  kind: TransportResponseKind;
  body?: string;
  contentTypes: string[];
}

export type TransportResponseKind = "success" | "error" | "unknown";

export interface TransportOperation {
  contract: string;
  operation: string;
  callable: CallableOperation;
  verb: HttpVerb;
  path: string;
  uriTemplate: string;
  bindings: TransportBinding[];
  auth?: TransportAuthRequirement;
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

  const auth = lowerAuthentication(getAuthenticationForOperation(program, operation));
  return {
    contract: httpOperation.container.name,
    operation: operation.name,
    callable,
    verb: httpOperation.verb,
    path: httpOperation.path,
    uriTemplate: httpOperation.uriTemplate,
    bindings: lowerBindings(httpOperation),
    ...(auth ? { auth } : {}),
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
  return sortTransportBindings(bindings);
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
  const statusCodes = [formatStatusCodes(response.statusCodes)];
  return {
    statusCodes,
    kind: classifyStatusCodes(statusCodes),
    ...(firstBody ? { body: typeName(firstBody.type) } : {}),
    contentTypes: response.responses.flatMap(
      (content) => content.body?.contentTypes ?? [],
    ),
  };
}

function lowerAuthentication(
  authentication: Authentication | undefined,
): TransportAuthRequirement | undefined {
  if (!authentication || authentication.options.length === 0) return undefined;
  return {
    options: authentication.options.map((option) => ({
      schemes: option.schemes.map(lowerAuthScheme),
    })),
  };
}

function lowerAuthScheme(auth: HttpAuth): TransportAuthScheme {
  const base = {
    id: auth.id,
    type: auth.type,
    ...(auth.description ? { description: auth.description } : {}),
  };
  switch (auth.type) {
    case "http":
      return {
        ...base,
        scheme: auth.scheme,
      };
    case "apiKey":
      return {
        ...base,
        in: auth.in,
        name: auth.name,
      };
    case "oauth2":
      return {
        ...base,
        scopes: uniqueScopes(auth.flows.flatMap((flow) => flow.scopes)),
        flows: auth.flows.map(lowerOAuth2Flow),
      };
    case "openIdConnect":
      return {
        ...base,
        openIdConnectUrl: auth.openIdConnectUrl,
      };
    case "noAuth":
      return base;
  }
}

function lowerOAuth2Flow(flow: OAuth2Flow): TransportOAuth2Flow {
  return {
    type: flow.type,
    ...("authorizationUrl" in flow ? { authorizationUrl: flow.authorizationUrl } : {}),
    ...("tokenUrl" in flow ? { tokenUrl: flow.tokenUrl } : {}),
    ...(flow.refreshUrl ? { refreshUrl: flow.refreshUrl } : {}),
    scopes: uniqueScopes(flow.scopes),
  };
}

function uniqueScopes(scopes: readonly { value: string }[]): string[] {
  return Array.from(new Set(scopes.map((scope) => scope.value))).sort();
}

export function sortTransportBindings(
  bindings: readonly TransportBinding[],
): TransportBinding[] {
  return [...bindings].sort((left, right) =>
    `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`),
  );
}

export function transportBindingsByKind(
  operation: TransportOperation,
  kind: TransportBindingKind,
): TransportBinding[] {
  return operation.bindings.filter((binding) => binding.kind === kind);
}

export function firstSuccessStatusCode(
  operation: TransportOperation,
): number | undefined {
  for (const response of operation.responses) {
    if (response.kind !== "success") continue;
    const code = response.statusCodes[0];
    if (code && /^\d+$/.test(code)) return Number(code);
    const range = code ? /^(\d+)-\d+$/.exec(code) : undefined;
    if (range) return Number(range[1]);
  }
  return undefined;
}

export function successBodyResponses(
  operation: TransportOperation,
): TransportResponse[] {
  return operation.responses.filter(
    (response) => response.kind === "success" && response.body && response.body !== "void",
  );
}

export function unknownBodyResponses(
  operation: TransportOperation,
): TransportResponse[] {
  return operation.responses.filter(
    (response) => response.kind === "unknown" && response.body && response.body !== "void",
  );
}

export function successOrFallbackBodyResponses(
  operation: TransportOperation,
): TransportResponse[] {
  const explicitSuccess = successBodyResponses(operation);
  if (explicitSuccess.length > 0) return explicitSuccess;
  return operation.responses.some((response) => response.kind === "success")
    ? []
    : unknownBodyResponses(operation);
}

export function firstSuccessBodyResponse(
  operation: TransportOperation,
): TransportResponse | undefined {
  return successBodyResponses(operation)[0];
}

export function statusCodeMatches(statusCode: string, status: number): boolean {
  if (statusCode === "*") return true;
  if (/^\d+$/.test(statusCode)) return Number(statusCode) === status;
  const range = /^(\d+)-(\d+)$/.exec(statusCode);
  if (!range) return false;
  const start = Number(range[1]);
  const end = Number(range[2]);
  return status >= start && status <= end;
}

export function isSuccessStatusCode(statusCode: string): boolean {
  if (statusCode === "*") return false;
  if (/^\d+$/.test(statusCode)) {
    const status = Number(statusCode);
    return status >= 200 && status < 300;
  }
  const range = /^(\d+)-(\d+)$/.exec(statusCode);
  if (!range) return false;
  const start = Number(range[1]);
  const end = Number(range[2]);
  return start < 300 && end >= 200;
}

export function classifyStatusCodes(
  statusCodes: readonly string[],
): TransportResponseKind {
  if (statusCodes.some((statusCode) => statusCode === "*")) return "unknown";
  const hasSuccess = statusCodes.some(isSuccessStatusCode);
  if (hasSuccess) return "success";
  return statusCodes.length > 0 ? "error" : "unknown";
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
