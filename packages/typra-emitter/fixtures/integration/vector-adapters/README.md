# Integration fixture — reference vector adapters

The integration fixture (`fixtures/integration/main.tsp`) declares `@vector`
behavioral vectors on `CanonicalEnginePort` (see
`model/pipeline/canonical-ports.tsp`). The emitter renders a per-target
conformance suite that replays each vector through a **runtime-authored**
adapter resolved from the target's `vector-adapter-path` option — a vector with
no adapter and no waiver is a hard failure, so the full validation matrix needs
a real adapter for every emitted target.

These files are the reviewable reference adapters. `scripts/validate-fixtures.mjs`
copies them into each target's generated tree (into the location the emitted
suite imports from) before that target compiles and runs. They are **not** part
of the emitter output and never land in `generated/` in git.

Each adapter implements the two reference vectors:

| operation                       | behavior                                  |
| ------------------------------- | ----------------------------------------- |
| `CanonicalEnginePort.authorize` | returns `{ "approved": true }`            |
| `CanonicalEnginePort.format`    | passthrough: returns the input `messages` |

One adapter per source language; variant targets reuse the base-language file:

| source file                     | targets                          |
| ------------------------------- | -------------------------------- |
| `typescript/vector-adapters.ts` | `typescript`, `typescript-zod`   |
| `python/vector_adapters.py`     | `python`, `python_pydantic`      |
| `go/adapters.go`                | `go`                             |
| `rust/vector_adapters.rs`       | `rust`, `rust-serde`             |
| `csharp/VectorAdapters.cs`      | `csharp`                         |
| `java/VectorAdapters.java`      | `java-jackson`                   |
| `swift/VectorAdapters.swift`    | `swift`, `swift-codable`         |

The type definitions (`Context`/`Adapter`/`VectorError` etc.) mirror the shapes
the generated suites expect; keep them in sync with the emitter drivers under
`src/languages/*/driver.ts` if the adapter seam changes.

The vectors execute behaviorally on every target that runs its generated tests.
`typescript-zod` uniquely has no test-execution stage (its generated tests are
compile-only by existing convention), so its adapter provides compile coverage
while the behavior is executed on the base `typescript` target. Plain `java`
does not emit the suite, so only `java-jackson` carries a Java adapter.
