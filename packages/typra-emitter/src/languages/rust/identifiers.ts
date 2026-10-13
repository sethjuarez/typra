/**
 * Rust variant name for a string-enum wire value. The model, load defaults, the expression
 * visitor, and generated tests must all agree, so every site calls this one rule:
 * split on non-alphanumerics and upper-case each segment's first letter
 * ("subtle_push" → "SubtlePush", "gpt-4o" → "Gpt4o", "camelCase" → "CamelCase").
 */
export function rustEnumVariantName(value: string): string {
  const name = value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
  if (!name) return "Empty";
  if (name === "Self") return "SelfValue";
  return /^[0-9]/.test(name) ? `V${name}` : name;
}

/**
 * Normalizing values to identifiers is not injective ("foo_bar" and "fooBar" both become
 * "FooBar"), so fail generation instead of emitting an enum Rust cannot compile.
 */
export function assertDistinctRustVariants(enumDef: {
  name: string;
  values: string[];
  isOpen?: boolean;
}): void {
  const seen = new Map<string, string>();
  if (enumDef.isOpen) seen.set("Other", "<open-enum fallback>");
  for (const value of new Set(enumDef.values)) {
    const variant = rustEnumVariantName(value);
    const prior = seen.get(variant);
    if (prior !== undefined) {
      throw new Error(
        `Rust enum ${enumDef.name}: values "${prior}" and "${value}" both map to variant ${variant}.`,
      );
    }
    seen.set(variant, value);
  }
}
