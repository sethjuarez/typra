export function createUniqueEnumMemberNames(
  values: readonly string[],
  normalize: (value: string) => string,
): Map<string, string> {
  const names = new Map<string, string>();
  const occupied = new Set<string>();

  for (const value of values) {
    if (names.has(value)) continue;

    const base = normalize(value) || "Value";
    let name = base;
    let suffix = 2;
    while (occupied.has(name)) {
      name = `${base}_${suffix}`;
      suffix += 1;
    }
    names.set(value, name);
    occupied.add(name);
  }

  return names;
}
