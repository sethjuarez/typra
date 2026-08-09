export const REQUIRED_CONFORMANCE_MATRIX_TARGETS = [
  "typescript",
  "python",
  "csharp",
  "go",
  "java",
  "rust",
  "swift",
];

export function compareConformanceMatrixTargets(actual) {
  if (!Array.isArray(actual)) {
    return {
      ok: false,
      failures: ["Conformance matrix targets must be an array."],
    };
  }

  const actualSet = new Set(actual);
  const expectedSet = new Set(REQUIRED_CONFORMANCE_MATRIX_TARGETS);
  const missing = REQUIRED_CONFORMANCE_MATRIX_TARGETS.filter(
    (target) => !actualSet.has(target),
  );
  const extra = actual.filter((target) => !expectedSet.has(target));
  const duplicates = actual.filter(
    (target, index) => actual.indexOf(target) !== index,
  );
  const failures = [];
  if (missing.length > 0) {
    failures.push(
      `Conformance matrix targets are missing required backend(s): ${missing.join(", ")}.`,
    );
  }
  if (extra.length > 0) {
    failures.push(
      `Conformance matrix targets declare unsupported backend(s): ${extra.join(", ")}.`,
    );
  }
  if (duplicates.length > 0) {
    failures.push(
      `Conformance matrix targets contain duplicate backend(s): ${[...new Set(duplicates)].join(", ")}.`,
    );
  }
  return {
    ok: failures.length === 0,
    failures,
  };
}
