import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { EmitContext, NoTarget } from "@typespec/compiler";
import { TypraEmitterOptions } from "./lib.js";

export const SUPPORTED_TYPESPEC_COMPILER_VERSION = "1.10.0";
export const SUPPORTED_TYPESPEC_JSON_SCHEMA_VERSION = "1.10.0";

const require = createRequire(import.meta.url);

export interface ToolchainPackageMetadata {
  name: string;
  version: string;
  supportedRange: string;
  supported: boolean;
}

export interface ToolchainMetadata {
  packages: ToolchainPackageMetadata[];
}

interface CompatibilityDiagnosticContext {
  options: Pick<TypraEmitterOptions, "allow-unsupported-typespec-version">;
  program: {
    reportDiagnostic(diagnostic: {
      code: string;
      message: string;
      severity: "error" | "warning";
      target: typeof NoTarget;
    }): void;
  };
}

export function getToolchainMetadata(): ToolchainMetadata {
  const emitterVersion = resolveNearestPackageVersion("@typra/emitter", dirname(fileURLToPath(import.meta.url)));
  return buildToolchainMetadata([
    {
      name: "@typespec/compiler",
      version: resolveInstalledPackageVersion("@typespec/compiler"),
      supportedRange: SUPPORTED_TYPESPEC_COMPILER_VERSION,
    },
    {
      name: "@typespec/json-schema",
      version: resolveInstalledPackageVersion("@typespec/json-schema"),
      supportedRange: SUPPORTED_TYPESPEC_JSON_SCHEMA_VERSION,
    },
    {
      name: "@typra/emitter",
      version: emitterVersion,
      supportedRange: emitterVersion,
    },
  ]);
}

export function buildToolchainMetadata(
  packages: Array<Omit<ToolchainPackageMetadata, "supported"> & Partial<Pick<ToolchainPackageMetadata, "supported">>>,
): ToolchainMetadata {
  return {
    packages: packages
      .map((entry) => ({
        ...entry,
        supported: entry.supported ?? isSupportedVersion(entry.version, entry.supportedRange),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function reportTypeSpecCompatibility(context: EmitContext<TypraEmitterOptions>): ToolchainMetadata {
  const toolchain = getToolchainMetadata();
  reportToolchainCompatibility(context, toolchain);
  return toolchain;
}

export function shouldBlockUnsupportedTypeSpecToolchain(
  options: Pick<TypraEmitterOptions, "allow-unsupported-typespec-version">,
  toolchain: ToolchainMetadata,
): boolean {
  return options["allow-unsupported-typespec-version"] !== true && getUnsupportedTypeSpecPackages(toolchain).length > 0;
}

export function reportToolchainCompatibility(context: CompatibilityDiagnosticContext, toolchain: ToolchainMetadata): void {
  const unsupported = getUnsupportedTypeSpecPackages(toolchain);
  if (unsupported.length === 0) {
    return;
  }

  context.program.reportDiagnostic({
    code: "typra-emitter-unsupported-typespec-version",
    message: formatUnsupportedTypeSpecVersionMessage(unsupported, context.options["allow-unsupported-typespec-version"] === true),
    severity: context.options["allow-unsupported-typespec-version"] === true ? "warning" : "error",
    target: NoTarget,
  });
}

export function getUnsupportedTypeSpecPackages(toolchain: ToolchainMetadata): ToolchainPackageMetadata[] {
  return toolchain.packages.filter(
    (entry) => (entry.name === "@typespec/compiler" || entry.name === "@typespec/json-schema") && !entry.supported,
  );
}

export function formatUnsupportedTypeSpecVersionMessage(
  unsupported: ToolchainPackageMetadata[],
  allowedUnsupportedVersion: boolean,
): string {
  const actual = unsupported.map((entry) => `${entry.name}@${entry.version}`).join(", ");
  const expected = unsupported.map((entry) => `${entry.name}@${entry.supportedRange}`).join(", ");
  const action = allowedUnsupportedVersion
    ? "Generation will continue because allow-unsupported-typespec-version is enabled."
    : "Pin the TypeSpec toolchain to the supported versions, or set allow-unsupported-typespec-version: true to continue with a warning.";

  return `@typra/emitter has only been validated with ${expected}; found ${actual}. ${action}`;
}

function isSupportedVersion(version: string, supportedRange: string): boolean {
  return version === supportedRange;
}

function resolveInstalledPackageVersion(packageName: string): string {
  try {
    const packageEntry = require.resolve(packageName);
    return resolveNearestPackageVersion(packageName, dirname(packageEntry));
  } catch {
    return "unresolved";
  }
}

function resolveNearestPackageVersion(expectedPackageName: string, startDir: string): string {
  let current = startDir;
  while (current !== dirname(current)) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) {
      const metadata = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
      if (metadata.name === expectedPackageName && typeof metadata.version === "string") {
        return metadata.version;
      }
    }
    current = dirname(current);
  }

  return "unresolved";
}
