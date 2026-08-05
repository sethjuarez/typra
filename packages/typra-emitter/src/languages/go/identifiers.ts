import { toPascalCase } from "../../ir/visitor.js";

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
