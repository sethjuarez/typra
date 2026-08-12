import { EmitTarget } from "./lib.js";
import { validateOutputContributorTargets } from "./output-contributors.js";

export type NativeSerializationMode = NonNullable<
  EmitTarget["native-serialization"]
>;

export function validateNativeSerializationTargets(
  targets: readonly EmitTarget[],
): string[] {
  return validateOutputContributorTargets(targets);
}
