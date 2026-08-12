export const REQUIRED_CONFORMANCE_MATRIX_TARGETS = [
  "typescript",
  "python",
  "csharp",
  "go",
  "java",
  "rust",
  "swift",
];

const RULE_STATUSES = new Set(["enforced", "known-gap"]);
const RULE_VERIFICATIONS = new Set(["fixture-evidence", "unit-test"]);
const BACKEND_STATUSES = new Set(["implemented", "waived"]);

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

function issueLabel(value) {
  return typeof value === "string" && /^#\d+$/.test(value);
}

function ruleLabel(rule, index) {
  return typeof rule?.id === "string" && rule.id.length > 0
    ? rule.id
    : `rules[${index}]`;
}

function normalizeBackendCell(cell) {
  if (typeof cell === "string") {
    return { status: cell };
  }
  if (cell && typeof cell === "object" && !Array.isArray(cell)) {
    return cell;
  }
  return undefined;
}

export function validateConformanceMatrix(matrix) {
  const failures = [];
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    return {
      ok: false,
      failures: ["Conformance matrix must be a JSON object."],
    };
  }

  if (matrix.version !== 1) {
    failures.push("Conformance matrix has an unexpected version.");
  }
  failures.push(...compareConformanceMatrixTargets(matrix.targets).failures);

  if (!Array.isArray(matrix.cases) || matrix.cases.length === 0) {
    failures.push("Conformance matrix must declare at least one case.");
  }
  if (!Array.isArray(matrix.rules)) {
    failures.push("Conformance matrix rules must be an array.");
    return { ok: false, failures };
  }
  if (matrix.rules.length === 0) {
    failures.push("Conformance matrix must declare at least one semantic rule.");
  }

  const seenRuleIds = new Set();
  for (const [index, rule] of matrix.rules.entries()) {
    const label = ruleLabel(rule, index);
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      failures.push(`${label} must be an object.`);
      continue;
    }
    if (typeof rule.id !== "string" || rule.id.length === 0) {
      failures.push(`${label} must declare a non-empty id.`);
    } else if (seenRuleIds.has(rule.id)) {
      failures.push(`${label} duplicates a rule id.`);
    } else {
      seenRuleIds.add(rule.id);
    }
    if (!RULE_STATUSES.has(rule.status)) {
      failures.push(`${label} has unsupported status '${rule.status}'.`);
    }
    if (
      rule.verification !== undefined &&
      !RULE_VERIFICATIONS.has(rule.verification)
    ) {
      failures.push(
        `${label} has unsupported verification '${rule.verification}'.`,
      );
    }
    if (
      rule.status === "enforced" &&
      !RULE_VERIFICATIONS.has(rule.verification)
    ) {
      failures.push(
        `${label} is enforced but does not declare fixture-evidence or unit-test verification.`,
      );
    }
    if (rule.verification === "unit-test" && typeof rule.test !== "string") {
      failures.push(
        `${label} uses unit-test verification but does not declare a test path.`,
      );
    }
    if (rule.status === "known-gap" && !issueLabel(rule.issue)) {
      failures.push(
        `${label} is a known gap but does not declare an issue like #123.`,
      );
    }

    const targetComparison = compareConformanceMatrixTargets(
      rule.backends &&
        typeof rule.backends === "object" &&
        !Array.isArray(rule.backends)
        ? Object.keys(rule.backends)
        : undefined,
    );
    for (const failure of targetComparison.failures) {
      failures.push(`${label}: ${failure}`);
    }
    if (
      !rule.backends ||
      typeof rule.backends !== "object" ||
      Array.isArray(rule.backends)
    ) {
      continue;
    }

    for (const target of REQUIRED_CONFORMANCE_MATRIX_TARGETS) {
      const cell = normalizeBackendCell(rule.backends[target]);
      if (!cell) {
        failures.push(
          `${label}.${target} backend cell must be a status string or object.`,
        );
        continue;
      }
      if (!BACKEND_STATUSES.has(cell.status)) {
        failures.push(
          `${label}.${target} has unsupported backend status '${cell.status}'.`,
        );
      }
      if (cell.status === "implemented" && rule.status !== "enforced") {
        failures.push(
          `${label}.${target} cannot be implemented while ${label} is ${rule.status}.`,
        );
      }
      if (cell.status === "implemented" && cell.issue !== undefined) {
        failures.push(
          `${label}.${target} is implemented and must not declare an issue waiver.`,
        );
      }
      if (cell.status === "waived") {
        if (rule.status !== "known-gap") {
          failures.push(
            `${label}.${target} is waived, but ${label} is not marked known-gap.`,
          );
        }
        if (!issueLabel(cell.issue)) {
          failures.push(
            `${label}.${target} waiver must declare an issue like #123.`,
          );
        } else if (issueLabel(rule.issue) && cell.issue !== rule.issue) {
          failures.push(
            `${label}.${target} waiver issue ${cell.issue} does not match ${rule.issue}.`,
          );
        }
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
