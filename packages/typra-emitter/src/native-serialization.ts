import { EmitTarget } from "./lib.js";

export type NativeSerializationMode = NonNullable<EmitTarget["native-serialization"]>;

const SUPPORTED_NATIVE_SERIALIZATION = new Map<string, Set<NativeSerializationMode>>([
  ["typescript", new Set(["none", "zod", "standard-schema"])],
  ["python", new Set(["none", "pydantic"])],
  ["csharp", new Set(["none"])],
  ["go", new Set(["none"])],
  ["java", new Set(["none", "jackson"])],
  ["rust", new Set(["none", "serde"])],
  ["swift", new Set(["none", "codable"])],
  ["markdown", new Set(["none"])],
]);

function supportedModesFor(targetType: string): Set<NativeSerializationMode> {
  return SUPPORTED_NATIVE_SERIALIZATION.get(targetType.toLowerCase().trim()) ?? new Set(["none"]);
}

export function validateNativeSerializationTargets(targets: readonly Pick<EmitTarget, "type" | "native-serialization">[]): string[] {
  const errors: string[] = [];
  for (const target of targets) {
    const targetType = target.type.toLowerCase().trim();
    const mode = target["native-serialization"] ?? "none";
    const supportedModes = supportedModesFor(targetType);
    if (!supportedModes.has(mode)) {
      errors.push(
        `Target "${target.type}" does not support native-serialization "${mode}". `
        + `Supported value${supportedModes.size === 1 ? "" : "s"}: ${[...supportedModes].map(value => `"${value}"`).join(", ")}.`,
      );
    }
  }
  return errors;
}
