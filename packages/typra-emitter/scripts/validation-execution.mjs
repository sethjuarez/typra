export const TOOLCHAIN_UNAVAILABLE = "toolchain-unavailable";

function unique(values) {
  return [...new Set(values)];
}

function sortedDifference(left, right) {
  const rightSet = new Set(right);
  return unique(left).filter(value => !rightSet.has(value)).sort();
}

function formatList(values) {
  return values.map(value => `  ${value}`).join("\n");
}

export function compareExpectedExecution({
  label,
  expected,
  implemented,
  executed,
  skipped = [],
  allowedSkips = {},
}) {
  const expectedIds = unique(expected);
  const implementedIds = unique(implemented);
  const executedIds = unique(executed);
  const skippedById = new Map(skipped.map(entry => [entry.id, entry.reason]));
  const allowedSkipReasons = new Map(Object.entries(allowedSkips));
  const failures = [];
  const warnings = [];

  const missingImplementations = sortedDifference(expectedIds, implementedIds);
  if (missingImplementations.length > 0) {
    failures.push(`${label} is missing implementations for declared targets/stages:\n${formatList(missingImplementations)}`);
  }

  const unexpectedImplementations = sortedDifference(implementedIds, expectedIds);
  if (unexpectedImplementations.length > 0) {
    failures.push(`${label} has implementations that are not declared as expected targets/stages:\n${formatList(unexpectedImplementations)}`);
  }

  const unexpectedExecutions = sortedDifference(executedIds, expectedIds);
  if (unexpectedExecutions.length > 0) {
    failures.push(`${label} executed targets/stages that are not declared as expected:\n${formatList(unexpectedExecutions)}`);
  }

  const unexpectedSkips = [];
  const allowedSkippedIds = [];
  for (const [id, reason] of skippedById) {
    if (!expectedIds.includes(id)) {
      unexpectedSkips.push(`${id} (${reason})`);
      continue;
    }
    if (allowedSkipReasons.get(id) !== reason) {
      unexpectedSkips.push(`${id} (${reason})`);
      continue;
    }
    allowedSkippedIds.push(id);
  }
  if (unexpectedSkips.length > 0) {
    failures.push(`${label} skipped targets/stages without an allowed toolchain-unavailable declaration:\n${formatList(unexpectedSkips.sort())}`);
  }

  const completedOrAllowed = [...executedIds, ...allowedSkippedIds];
  const missingExecutions = sortedDifference(expectedIds, completedOrAllowed);
  if (missingExecutions.length > 0) {
    failures.push(`${label} did not execute declared targets/stages:\n${formatList(missingExecutions)}`);
  }

  const allowedSkippedExpected = allowedSkippedIds.sort();
  if (allowedSkippedExpected.length > 0) {
    warnings.push(`${label} skipped declared targets/stages because the local toolchain is unavailable:\n${formatList(allowedSkippedExpected)}`);
  }

  return { failures, warnings };
}
