// Shared web-oriented TypeScript compile profile used to prove the shipped
// library type-checks against a web runtime rather than Node.
//
// Deliberately dependency-free (no harness import, which would copy the whole
// generated fixture tree on load) so unit tests can exercise the exact options
// the validation stage compiles with.
//
// The essence of the profile: no `@types/node` (so Node globals like `process`,
// `Buffer`, `require`, `module`, `__dirname` and any Node-typed API surface as a
// hard type error) and the DOM lib in their place (so the web capabilities the
// neutral library is allowed to use — `fetch`, `console`, `URL`, `TextEncoder` —
// still resolve). Bundler resolution mirrors how a web bundler resolves the
// package's extensionless relative imports and conditional dependency exports.
export const WEB_COMPILE_COMPILER_OPTIONS = {
  noEmit: true,
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
  skipLibCheck: true,
  strict: true,
  types: [],
  lib: ["ES2022", "DOM"],
};
