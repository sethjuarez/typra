// Pure policy for the generated-test-category parity guard (issue #328 class).
//
// This module holds the *logic* of the guard so it can be unit-tested in
// isolation (see test-category-parity-policy.test.mjs) as well as driven
// against the real generated fixtures by validate-fixtures.mjs. It performs no
// I/O of its own: callers inject a `readFile(relPath) -> string | null` reader
// (null meaning "file absent"), and the function returns a flat list of
// human-readable failure strings (empty === the policy holds).
//
// The policy is bidirectionally exhaustive. It fails when:
//   - the guard's backend set diverges from the canonical backend list (a newly
//     added backend can't silently skip the guard, nor a removed one linger);
//   - a backend has no entry for a tracked category (a silent per-backend gap);
//   - a category references an unknown/stale backend (a drifted matrix);
//   - a marker list is empty, or a waiver has no reason;
//   - a required marker substring is absent from the backend's test file — the
//     exact #328 failure mode when a category (e.g. a `fromWire` direction) is
//     dropped for some backends.

/**
 * @param {object} params
 * @param {Record<string, string>} params.wireOptionsTestFiles backend -> test file path
 * @param {Record<string, Record<string, string[] | { waived: string }>>} params.testCategoryParity category -> backend -> markers|waiver
 * @param {string[]} params.canonicalBackends the project's canonical backend list
 * @param {(relPath: string) => string | null} params.readFile reader; null === file absent
 * @returns {string[]} failure messages (empty === policy holds)
 */
export function checkTestCategoryParity({
  wireOptionsTestFiles,
  testCategoryParity,
  canonicalBackends,
  readFile,
}) {
  const failures = [];
  const fail = (message) => failures.push(message);

  const parityBackends = Object.keys(wireOptionsTestFiles);
  const canonicalSet = new Set(canonicalBackends);

  for (const backend of parityBackends) {
    if (!canonicalSet.has(backend)) {
      fail(
        `Test-category parity: backend "${backend}" is not in the canonical backend list ` +
          `(REQUIRED_CONFORMANCE_MATRIX_TARGETS). Remove it here or add it to the canonical list.`,
      );
    }
  }
  for (const backend of canonicalBackends) {
    if (!(backend in wireOptionsTestFiles)) {
      fail(
        `Test-category parity: canonical backend "${backend}" has no WireOptions test file entry. ` +
          `Every supported backend must be covered so #328-class gaps cannot land silently.`,
      );
    }
  }

  for (const [category, byBackend] of Object.entries(testCategoryParity)) {
    for (const backend of Object.keys(byBackend)) {
      if (!(backend in wireOptionsTestFiles)) {
        fail(
          `Test-category parity: category "${category}" references unknown backend "${backend}". ` +
            `Matrix has drifted from the backend set.`,
        );
      }
    }
    for (const backend of parityBackends) {
      const entry = byBackend[backend];
      if (entry === undefined) {
        fail(
          `Test-category parity: backend "${backend}" has no entry (markers or a waiver with a reason) ` +
            `for category "${category}". Every backend must declare each tracked category so #328-class gaps cannot land silently.`,
        );
        continue;
      }
      if (Array.isArray(entry)) {
        if (entry.length === 0) {
          fail(
            `Test-category parity: backend "${backend}" category "${category}" has an empty marker list. ` +
              `Provide marker substrings, or a { waived: "<reason>" } to skip deliberately.`,
          );
          continue;
        }
        const relPath = wireOptionsTestFiles[backend];
        const text = readFile(relPath);
        if (text === null || text === undefined) {
          fail(
            `Test-category parity: backend "${backend}" category "${category}" test file is missing: ${relPath}`,
          );
          continue;
        }
        for (const marker of entry) {
          if (!text.includes(marker)) {
            fail(
              `Test-category parity: backend "${backend}" category "${category}" is missing marker ` +
                `${JSON.stringify(marker)} in ${relPath}.`,
            );
          }
        }
        continue;
      }
      if (
        entry &&
        typeof entry === "object" &&
        typeof entry.waived === "string" &&
        entry.waived.trim().length > 0
      ) {
        continue; // deliberate waiver with a reason
      }
      fail(
        `Test-category parity: backend "${backend}" category "${category}" must be an array of marker ` +
          `substrings or { waived: "<non-empty reason>" }.`,
      );
    }
  }

  return failures;
}
