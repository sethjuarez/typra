import type { EmitTarget } from "./lib.js";

export type OutputContributorKind = string;

export interface OutputContributorIdentity {
  target: string;
  kind: OutputContributorKind;
  provider: string;
}

export interface OutputRequest extends OutputContributorIdentity {
  source: "core" | "native-serialization" | "outputs";
}

export interface OutputContributorContext {
  target: EmitTarget;
  request: OutputRequest;
}

export interface OutputContributor extends OutputContributorIdentity {
  validateOptions?: (target: EmitTarget, request: OutputRequest) => string[];
  emitFiles?: (context: OutputContributorContext) => Promise<void> | void;
  emitTests?: (context: OutputContributorContext) => Promise<void> | void;
  runtimeDependencies?:
    | readonly string[]
    | ((context: OutputContributorContext) => readonly string[]);
}

const MODEL_PROVIDER = "typra";

const CONTRIBUTOR_REGISTRY: OutputContributor[] = [
  ...[
    "typescript",
    "python",
    "csharp",
    "go",
    "java",
    "rust",
    "swift",
    "markdown",
  ].map((target): OutputContributor => ({
    target,
    kind: "models",
    provider: MODEL_PROVIDER,
  })),
  nativeSerialization("typescript", "zod"),
  nativeSerialization("typescript", "standard-schema"),
  nativeSerialization("python", "pydantic"),
  nativeSerialization("java", "jackson"),
  nativeSerialization("rust", "serde"),
  nativeSerialization("swift", "codable"),
  {
    target: "typescript",
    kind: "consumer",
    provider: "fetch",
  },
  {
    target: "python",
    kind: "server",
    provider: "fastapi",
    runtimeDependencies: ["fastapi"],
  },
  {
    target: "python",
    kind: "server",
    provider: "starlette",
    runtimeDependencies: ["starlette"],
  },
  {
    target: "python",
    kind: "consumer",
    provider: "httpx",
  },
];

function nativeSerialization(
  target: string,
  provider: string,
  validateOptions?: OutputContributor["validateOptions"],
): OutputContributor {
  return {
    target,
    kind: "native-serialization",
    provider,
    validateOptions,
  };
}

export function normalizeOutputRequests(target: EmitTarget): OutputRequest[] {
  const targetType = normalizeTarget(target.type);
  const requests: OutputRequest[] = [];
  const addRequest = (request: OutputRequest) => {
    const existingIndex = requests.findIndex(
      (existing) =>
        existing.target === request.target &&
        existing.kind === request.kind &&
        existing.provider === request.provider,
    );
    if (existingIndex >= 0) {
      if (request.source === "native-serialization") {
        requests[existingIndex] = request;
      }
    } else {
      requests.push(request);
    }
  };

  addRequest({
      target: targetType,
      kind: "models",
      provider: MODEL_PROVIDER,
      source: "core",
  });
  for (const output of target.outputs ?? []) {
    addRequest({
      target: targetType,
      kind: output.kind,
      provider: output.provider ?? MODEL_PROVIDER,
      source: "outputs",
    });
  }
  const nativeSerialization = target["native-serialization"] ?? "none";
  if (nativeSerialization !== "none") {
    addRequest({
      target: targetType,
      kind: "native-serialization",
      provider: nativeSerialization,
      source: "native-serialization",
    });
  }
  return requests;
}

export function validateOutputContributorTargets(
  targets: readonly EmitTarget[],
): string[] {
  const errors: string[] = [];
  for (const target of targets) {
    for (const request of normalizeOutputRequests(target)) {
      const contributor = findContributor(request);
      if (!contributor) {
        errors.push(formatUnsupportedContributor(target, request));
        continue;
      }
      errors.push(...(contributor.validateOptions?.(target, request) ?? []));
    }
  }
  return errors;
}

export function findContributor(
  identity: OutputContributorIdentity,
): OutputContributor | undefined {
  const target = normalizeTarget(identity.target);
  return CONTRIBUTOR_REGISTRY.find(
    (contributor) =>
      contributor.target === target &&
      contributor.kind === identity.kind &&
      contributor.provider === identity.provider,
  );
}

export function contributorsFor(
  target: string,
  kind: OutputContributorKind,
): OutputContributor[] {
  const targetType = normalizeTarget(target);
  return CONTRIBUTOR_REGISTRY.filter(
    (contributor) =>
      contributor.target === targetType && contributor.kind === kind,
  );
}

function formatUnsupportedContributor(
  target: EmitTarget,
  request: OutputRequest,
): string {
  if (request.kind === "native-serialization") {
    const supportedModes = [
      "none",
      ...contributorsFor(target.type, "native-serialization").map(
        (contributor) => contributor.provider,
      ),
    ];
    return (
      `Target "${target.type}" does not support native-serialization "${request.provider}". ` +
      `Supported value${supportedModes.length === 1 ? "" : "s"}: ${supportedModes.map((value) => `"${value}"`).join(", ")}.`
    );
  }
  return `Target "${target.type}" does not support output contributor "${request.kind}:${request.provider}".`;
}

function normalizeTarget(target: string): string {
  return target.toLowerCase().trim();
}
