import { toSnakeCase } from "../../ir/utilities.js";

/** Strict and reserved Rust keywords (2015–2024 editions); each needs `r#` as a field name. */
const RUST_KEYWORDS = new Set([
  "as",
  "break",
  "const",
  "continue",
  "crate",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "async",
  "await",
  "dyn",
  "abstract",
  "become",
  "box",
  "do",
  "final",
  "gen",
  "macro",
  "override",
  "priv",
  "try",
  "typeof",
  "unsized",
  "virtual",
  "yield",
]);

/**
 * Rust field identifier for a source property. Model, loaders, the expression visitor,
 * operation bindings, and generated tests must agree, so every site calls this rule.
 * `self`/`super`/`crate` cannot be raw identifiers, so they gain a trailing `_`.
 */
export function rustFieldName(name: string): string {
  const snake = toSnakeCase(name);
  if (snake === "_") return "value_";
  if (snake === "self" || snake === "super" || snake === "crate") {
    return `${snake}_`;
  }
  return RUST_KEYWORDS.has(snake) ? `r#${snake}` : snake;
}

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

/**
 * Escape arbitrary text into the body of a double-quoted Rust string literal.
 * Every non-ASCII code point is emitted as `\u{..}` so the generated source is
 * pure ASCII — this sidesteps both the Rust raw-string `#`-fence ceiling and the
 * `text_direction_codepoint_in_literal` deny-lint (bidi controls such as U+202E
 * are rejected even inside raw strings). The unescaped &str still carries the
 * exact original characters, so `serde_json::from_str` sees faithful JSON.
 */
export function rustStringLiteralBody(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (cp === 0x0a) {
      out += "\\n";
    } else if (cp === 0x0d) {
      out += "\\r";
    } else if (cp === 0x09) {
      out += "\\t";
    } else if (cp >= 0x20 && cp <= 0x7e) {
      out += ch;
    } else {
      out += `\\u{${cp.toString(16)}}`;
    }
  }
  return out;
}

/** A complete double-quoted Rust string literal for arbitrary text. */
export function rustStringLiteral(text: string): string {
  return `"${rustStringLiteralBody(text)}"`;
}

/**
 * Rust types the generated code references unqualified; a same-named model,
 * interface, or enum shadows or redeclares them (#358). Calibrated by native compiles.
 */
const RESERVED_TYPE_NAMES = new Set<string>([
  "Box",
  "Result",
  "String",
  "LoadContext",
  "SaveContext",
]);

/** Why a model, interface, or enum named `name` cannot be emitted, or undefined. */
export function rustReservedTypeName(name: string): string | undefined {
  if (RESERVED_TYPE_NAMES.has(name)) {
    return `shadows or redeclares the '${name}' type`;
  }
  // Each type lives in a module named by its snake_case, and module paths
  // (`mod type;`, `use super::self::...`) cannot carry keywords.
  const module = toSnakeCase(name);
  if (RUST_KEYWORDS.has(module)) {
    return `its module name '${module}' is a Rust keyword`;
  }
  return undefined;
}
