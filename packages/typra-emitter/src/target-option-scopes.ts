import type { EmitTarget } from "./lib.js";

// Some emit-target options are only meaningful for a single target because that
// is the only target whose build manifest the emitter owns. Rather than let them
// be silently ignored on other targets (a confusing no-op), we reject them so a
// consumer who genuinely needs the capability elsewhere files a drift report and
// we generalize the option deliberately. See #260 (test-resources) and #261
// (harness-test-dir); the broader split-package rationale is tracked separately.
// Keep this union pinned to the string / string[] options actually scoped here.
// Narrowing (rather than `keyof EmitTarget`) keeps `isPresent` total over the
// real value types and guards against a future boolean/object option being
// mis-judged "present" by a catch-all fallback.
type SwiftOnlyOptionKey = "test-resources" | "harness-test-dir";

interface ScopedOption {
  key: SwiftOnlyOptionKey;
  scope: string;
  issue: string;
}

const SWIFT_ONLY_OPTIONS: readonly ScopedOption[] = [
  { key: "test-resources", scope: "swift", issue: "#260" },
  { key: "harness-test-dir", scope: "swift", issue: "#261" },
];

function normalizeTarget(target: string): string {
  return target.toLowerCase().trim();
}

// An option counts as "present" only when it carries a meaningful value: an
// empty array or empty/whitespace string is an inert no-op and is not rejected.
function isPresent(value: EmitTarget[SwiftOnlyOptionKey]): boolean {
  if (value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value.trim().length > 0;
}

export function validateTargetOptionScopes(
  targets: readonly EmitTarget[],
): string[] {
  const errors: string[] = [];
  for (const target of targets) {
    if (normalizeTarget(target.type) === "swift") {
      continue;
    }
    for (const option of SWIFT_ONLY_OPTIONS) {
      if (isPresent(target[option.key])) {
        errors.push(
          `Target "${target.type}" does not support the ${option.scope}-only ` +
            `option "${String(option.key)}" (${option.issue}). It is honored ` +
            `only by the Swift target; remove it, or open an emitter-drift ` +
            `report with your layout so it can be generalized deliberately.`,
        );
      }
    }
  }
  return errors;
}
