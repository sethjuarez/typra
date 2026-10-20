import { toSnakeCase } from "../../ir/utilities.js";
import { toPascalCase } from "../../ir/visitor.js";
import { createUniqueEnumMemberNames } from "../enum-identifiers.js";

export function goEnumMemberNames(
  values: readonly string[],
): Map<string, string> {
  return createUniqueEnumMemberNames(
    values,
    (value) => toPascalCase(value).replace(/[^A-Za-z0-9_]/g, "_") || "Value",
  );
}

interface FieldNameCandidate {
  name: string;
  base: string;
  normalizedLeading: boolean;
  index: number;
}

export function goFieldName(name: string): string {
  const converted = toPascalCase(name);
  return converted.replace(/^[^A-Za-z]+/, "") || "Value";
}

export function buildGoFieldNames(
  names: readonly string[],
): ReadonlyMap<string, string> {
  const groups = new Map<string, FieldNameCandidate[]>();
  names.forEach((name, index) => {
    const converted = toPascalCase(name);
    const base = goFieldName(name);
    const candidates = groups.get(base) ?? [];
    candidates.push({
      name,
      base,
      normalizedLeading: converted !== base,
      index,
    });
    groups.set(base, candidates);
  });

  const result = new Map<string, string>();
  const occupied = new Set<string>();

  for (const candidates of groups.values()) {
    candidates.sort(
      (left, right) =>
        Number(left.normalizedLeading) - Number(right.normalizedLeading) ||
        left.index - right.index,
    );
    const preferred = candidates[0];
    result.set(preferred.name, preferred.base);
    occupied.add(preferred.base);
  }

  for (const candidates of groups.values()) {
    for (const candidate of candidates.slice(1)) {
      let suffix = 1;
      let identifier = `Field${candidate.base}`;
      while (occupied.has(identifier)) {
        suffix += 1;
        identifier = `Field${suffix}${candidate.base}`;
      }
      result.set(candidate.name, identifier);
      occupied.add(identifier);
    }
  }

  return result;
}

// Go compiles `<name>_<GOOS>.go`, `<name>_<GOARCH>.go`, and `<name>_test.go` only
// under that OS/arch or `go test`, so a declaration whose snake_case file name
// ends in one of these segments silently drops out of ordinary builds.
const GO_FILE_SUFFIXES = new Set([
  "test",
  // GOOS
  "aix",
  "android",
  "darwin",
  "dragonfly",
  "freebsd",
  "hurd",
  "illumos",
  "ios",
  "js",
  "linux",
  "nacl",
  "netbsd",
  "openbsd",
  "plan9",
  "solaris",
  "wasip1",
  "windows",
  "zos",
  // GOARCH
  "386",
  "amd64",
  "amd64p32",
  "arm",
  "armbe",
  "arm64",
  "arm64be",
  "loong64",
  "mips",
  "mipsle",
  "mips64",
  "mips64le",
  "mips64p32",
  "mips64p32le",
  "ppc",
  "ppc64",
  "ppc64le",
  "riscv",
  "riscv64",
  "s390",
  "s390x",
  "sparc",
  "sparc64",
  "wasm",
]);


const RESERVED_TYPE_NAMES = new Set<string>(["LoadContext", "SaveContext"]);

/** Why a model, interface, or enum named `name` cannot be emitted, or undefined. */
export function goReservedTypeName(name: string): string | undefined {
  if (RESERVED_TYPE_NAMES.has(name)) {
    return `shadows or redeclares the '${name}' type`;
  }
  const segments = toSnakeCase(name).split("_");
  const last = segments[segments.length - 1];
  if (segments.length > 1 && GO_FILE_SUFFIXES.has(last)) {
    return `its file '${segments.join("_")}.go' is build-constrained by the '_${last}' suffix`;
  }
  return undefined;
}
