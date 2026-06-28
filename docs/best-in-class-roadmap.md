# Best-in-class emitter roadmap

Typra is now in a strong "ship after review" state for the current emitter work. This roadmap captures the next investments that would move it from high confidence on known fixtures to best-in-class confidence across the TypeSpec input space.

## 1. Executable conformance specification

Define a language-neutral semantic contract and make every target prove it with executable tests.

- Cover `load`, `save`, `fromJson`, `toJson`, provider wire mappings, scalar coercions, enums, open enums, polymorphic dispatch, optionals, null handling, and error behavior.
- Track each semantic feature by target language in a generated conformance matrix.
- Treat missing or divergent semantics as explicit gaps, not implicit emitter behavior.

## 2. Fixture and shape fuzzing

Generate TypeSpec fixture shapes programmatically so confidence grows beyond hand-authored examples.

- Combine nested models, collections, dictionaries, unions, named enums, open enums, optional fields, default values, aliases, provider mappings, and reserved-word names.
- Generate sample payloads and expected round-trip behavior for each shape.
- Compile and run generated code in every supported language as part of CI.

## 3. Golden API snapshots

Snapshot the public generated API shape for each target so accidental breaking changes are visible.

- Track class/type names, field names, method names, enum values, package/module layout, and exported symbols.
- Separate semantic breakage from additive API changes.
- Require intentional updates to snapshots when the generated API changes.

## 4. Runtime semantics contract

Write down the exact behavior shared by all emitted runtimes.

- Unknown fields: preserved, ignored, or rejected.
- Missing required fields: defaulted or rejected.
- Nulls: accepted, defaulted, or rejected by field kind.
- Coercion failures: error shape and timing.
- Enum failures and open enum behavior.
- Provider wire mapping precedence.
- Discriminator dispatch rules and fallback behavior.

## 5. Production-grade diagnostics

Improve diagnostics when a TypeSpec shape cannot be represented cleanly or portably.

- Emit actionable messages with source location when possible.
- Explain unsupported constructs and suggest alternatives.
- Distinguish warnings, portability risks, and hard errors.
- Include diagnostics in conformance tests for intentionally unsupported shapes.

## 6. Consumer smoke projects

Add tiny downstream projects that consume generated output as real packages or modules.

- TypeScript package import smoke.
- Python package import smoke.
- Go module smoke.
- Rust crate smoke.
- C# project smoke.
- Java package/classpath smoke.

These catch packaging, exports, module layout, and runtime integration issues that fixture-only tests can miss.

## 7. Language polish

Make each target feel idiomatic without losing cross-language semantic parity.

- Java: formatter integration, package layout options, optional accessors/builders, stronger error types.
- Go: idiomatic error returns where appropriate, richer validation behavior, package layout options.
- Rust: stronger typed errors and feature flags.
- C#: nullable annotations and idiomatic options for records/classes.
- Python and TypeScript: stricter runtime validation options.

## 8. Release and compatibility gate

Make release confidence explicit.

- Gate releases on TypeSpec compiler compatibility, language toolchain versions, generated fixture validation, conformance matrix status, and consumer smoke projects.
- Generate release notes from semantic/API changes.
- Keep package dry-run validation in the release path.

## Suggested next step

The highest-leverage next investment is the executable conformance specification plus fuzzed fixture generation. Together, they move confidence from "high for current known cases" to "systematically defended across the input space."
