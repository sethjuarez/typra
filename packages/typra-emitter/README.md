# @typra/emitter

`@typra/emitter` generates runtime model surfaces from TypeSpec. Use it when
you want TypeSpec to be the source of truth for shared model contracts and need
generated code, tests, JSON AST output, or documentation for one or more
runtimes.

Typra is emitter-only: it generates model/protocol surfaces, but it does not
ship runtime service implementations or product-specific contracts.

## Transport ownership boundary

TypeSpec remains the durable source of truth for HTTP contracts. Typra lowers the
contract-visible transport shape into shared IR and projects equivalent
producer/consumer seams from that IR, including path, query, header, cookie,
body, content type, status, auth requirements, and success/error response
selection behavior.

Generated producer seams bind HTTP requests to callable handler
protocols/interfaces. Generated consumer seams bind callable-shaped client
methods to an injected transport function and hydrate only status-matched 2xx
success bodies through Typra model `load()` helpers. Non-2xx responses are
reported through the transport error seam with the original status/body instead
of being loaded as success models. Wildcard/default response bodies are used as a
2xx success fallback only when an operation has no explicit success response, so
default error envelopes do not override declared success models.

Auth requirements modeled with TypeSpec HTTP are emitted as metadata on the
adapter/client seams. Generated code reports the requirement shape, but it does
not acquire tokens, refresh credentials, store secrets, or enforce provider
policy.

Host applications own runtime policy: business logic, token acquisition and
refresh, credential storage, cookie jars, retries, logging, tracing, persistence,
deployment, and provider-specific identity behavior. Cookie values modeled in
TypeSpec are projected as contract-visible bindings; session management and
cookie persistence remain host-owned.

### Runtime auth integration

Typra treats TypeSpec HTTP auth as contract metadata, not runtime behavior. A
producer projection can expose `AUTH_REQUIREMENTS` so the host can wire its own
middleware, dependency injection, or request guards. A consumer projection passes
the same requirement metadata to the injected transport seam so the host can
choose how to attach credentials.

For example, a generated TypeScript fetch client passes:

```ts
{
  method: "GET",
  url,
  headers,
  cookies,
  auth: {
    options: [{ schemes: [{ id: "BearerAuth", type: "http", scheme: "Bearer" }] }],
  },
}
```

The host-owned transport decides whether that metadata means a bearer token,
API-key lookup, mTLS context, test credential, or no credential at all. Typra
does not synthesize an `Authorization` header, manage refresh, persist tokens,
retry after challenges, or interpret provider-specific identity policy.

## Install

```powershell
npm install --save-dev @typra/emitter @typespec/compiler@1.10.0 @typespec/json-schema@1.10.0
```

Typra currently validates against TypeSpec compiler and JSON schema emitter
`1.10.0`. Unvalidated TypeSpec versions report a clear diagnostic during emit;
set `allow-unsupported-typespec-version: true` only when you intentionally accept
possible generated output churn.

## Current release highlights

The current package focuses on cross-runtime semantic parity, native interop
options that delegate to Typra's canonical load/save path, and validation that
keeps generated output reviewable:

- `typra-generate` supports every emitted runtime, accepts a `--spec`
  TypeSpec entrypoint, and resolves the installed TypeSpec compiler directly.
- Invalid programmatic targets and misspelled `emit-targets` configuration now
  fail clearly instead of being ignored.
- TypeScript can opt into Zod validators; Python can opt into Pydantic v2;
  Java can opt into Jackson; Rust can opt into explicit serde; and Swift can opt
  into explicit `Codable`.
- Publish runs generated-fixture validation, including Swift, and npm packing
  always builds the distributable artifacts.
- Cross-language validation includes generated native-interop variants and a
  save-side executable conformance oracle.

## Configure TypeSpec

Add the emitter to `tspconfig.yaml`:

```yaml
emit:
  - "@typra/emitter"

options:
  "@typra/emitter":
    emitter-output-dir: "{cwd}/generated"
    root-object: "MyProject.ApiRoot"
    root-namespace: "MyProject"
    emit-targets:
      - type: TypeScript
        output-dir: "generated/typescript"
        test-dir: "generated/typescript/tests"
        import-path: "../index"
        # Optional: emit Zod validators that validate Typra's canonical load/save wire shape.
        native-serialization: "zod"
      - type: Swift
        output-dir: "generated/swift"
        test-dir: "generated/swift/Tests/MyProjectTests"
        package-name: "MyProject"
      - type: Java
        output-dir: "generated/java"
        test-dir: "generated/java/tests"
        package-name: "myproject.api"
```

Import the emitter library from your TypeSpec entry point:

```typespec
import "@typra/emitter";

namespace MyProject;
```

Use TypeSpec-native `interface`/`op` declarations for new callable seams. Typra
operation decorators describe runtime-only callable effects: `@runtimeCancellable`,
`@sync`, `@optionalOperation`, and `@effect(#{ atomic: true, nonFatal: true })`.
Runtime cancellation is emitted as a native synthetic parameter and never
becomes a model or serialized field. Set `cancellation-token-path` to the full
runtime-native symbol path, such as `crate::engine::CancellationToken` for Rust
or `prompty.core.cancellation.CancellationToken` for Python.

Python supports opt-in Pydantic v2 model emission with
`native-serialization: "pydantic"` on the Python target. The default remains
`"none"` and keeps dataclass output. In Pydantic mode, generated
`model_validate()`, `model_validate_json()`, `model_dump()`, and
`model_dump_json()` delegate to Typra's generated `load()`, `save()`, and
`to_json()` methods so Typra's pathful diagnostics and wire semantics remain
the authoritative contract. `model_validate_strings()` hard-fails because
Pydantic's string-coercing validation would bypass Typra's loader semantics.

Compile with TypeSpec:

```powershell
npx tsp compile ./path/to/main.tsp --config ./tspconfig.yaml
```

## CLI

The package includes `typra-generate`, `typra-verify`, and a generic
`typra-consumer-smoke` harness:

```powershell
npx typra-generate --help
npx typra-generate --spec ./typespec/main.tsp --root-object MyProject.ApiRoot --deterministic -o ./generated
npx typra-verify --baseline ./baseline --current ./generated
npx typra-consumer-smoke --config ./typra-smoke.json
```

`typra-verify` compares committed `.typra-generated` metadata against current
generated metadata and prints deterministic review summaries for exports,
protocols, files, package/module identity, toolchain, protected paths, schema
evolution, stale cleanup dry-runs, hydration seams, and breaking-change
classification. It never deletes files.

## Supported output

Typra includes emitters for:

- TypeScript
- Python
- C#
- Go
- Java
- Rust
- Swift
- Markdown documentation
- JSON AST

The Typra fixture slice validates TypeScript, Python, C#, Go, Java, Rust,
Swift, Markdown, and JSON AST generation from synthetic TypeSpec shapes.
Fixture validation also exercises generated metadata, verifier CLI output,
consumer smoke wiring, and cross-language generated-code compile/test surfaces.
Broad integration coverage lives under `fixtures/integration/`. Focused,
runtime-agnostic feature coverage lives under `fixtures/features/<feature>/`;
runtime-specific quirks live under
`fixtures/runtimes/<runtime>/<case>/` so generated output can be inspected by
feature or runtime without turning the top-level fixture folder into a flat list
of test names.

### Go parity and validation

Generated Go models include `Load*`, `Save`, `ToJSON`, `ToYAML`,
`*FromJSON`, and `*FromYAML` helpers. For models with scalar coercions,
`*FromJSON` and `*FromYAML` pass the parsed scalar value through to `Load*` so
JSON/YAML shorthand inputs behave the same way as direct `Load*` calls.

Nested object and polymorphic collection loads return child load errors instead
of discarding them. Abstract polymorphic dispatch reports unknown or missing
discriminators as Go errors, while default variants continue to handle fallback
cases.

`npm run validate:fixtures` regenerates the fixture slice and verifies Go with
`gofmt -l`, `go vet ./...`, `go test ./...`, generated coercion helper tests,
and executable conformance alongside the other runtime targets. The executable
conformance step is save-side: each backend saves the canonical fixture sample
and the harness compares normalized output across the target set, with every
semantic rule recorded in the rule-by-backend conformance matrix.

## Generated files

Generated source files include Typra markers, and the emitter records a
generated-file manifest for each output root. Stale-file deletion is not enabled
yet, so Typra will not remove hand-authored runtime files.

For CI or committed generated output, enable deterministic metadata with the
TypeSpec emitter option:

```yaml
options:
  "@typra/emitter":
    deterministic-output: true
```

This keeps `.typra-generated/manifest.json` stable across equivalent
generations by replacing wall-clock `generatedAt` values with a fixed timestamp.
Generated text artifacts are also normalized to LF line endings, trimmed trailing
whitespace, and final newlines. Blank generated artifacts are skipped unless the
file format requires an empty sentinel such as Python `py.typed`.

Each generation also writes `.typra-generated/report.json`, a stable single-run
report that lists emitted files, skipped empty outputs, marker-owned stale files
removed during skipped-output cleanup, preserved unmarked skipped files, hygiene
policy, and warnings. Baseline-aware checks such as protected-path touches remain
in `typra-verify`, and per-file formatter status is not recorded yet.

Rust targets can opt into case-insensitive string-union/enum parsing without
changing the default case-sensitive behavior:

```yaml
emit-targets:
  - type: Rust
    output-dir: generated/rust
    enum-parsing: case-insensitive
```

When enabled, generated Rust `from_str_opt` methods accept enum values with
ASCII case differences while preserving the canonical serialized casing.

Java targets can opt into Jackson databind support without changing the default
generated Java surface:

```yaml
emit-targets:
  - type: Java
    output-dir: generated/java
    native-serialization: jackson
```

`native-serialization` defaults to `none`. With `jackson`, generated Java models
include Jackson annotations and serializers/deserializers that delegate to
Typra's generated `save` and `load`, so Jackson output is derived from the same
wire mapping as Typra JSON/YAML helpers. The emitter does not create or mutate a
consumer build manifest; projects enabling this option must provide
`jackson-databind` on their Java compile/runtime classpath.

Rust targets can also make the existing serde support explicit without changing
the default generated model surface:

```yaml
emit-targets:
  - type: Rust
    output-dir: generated/rust
    native-serialization: serde
```

Rust already emits `#[cfg(feature = "serde")]` `Serialize`/`Deserialize` impls
for generated models and string unions for compatibility with current output.
The impls delegate through Typra's canonical `to_value`/`load_from_value`
mapping so serde output cannot silently diverge from Typra save semantics.
Consumers should declare a crate feature named `serde` and include the `serde`
dependency when compiling with that feature. Set `native-serialization: none`
to opt out of these Rust impls.

Consumers can declare hand-authored boundaries in verifier config:

```json
{
  "protectedPaths": ["src/adapters/**"],
  "hydrationZones": ["src/extensions/**"]
}
```

The emitter records hydration seam metadata for generated protocol adapters, but
runtime behavior remains hand-authored by the consuming project.

## Links

- Repository: <https://github.com/sethjuarez/typra>
- Package: <https://www.npmjs.com/package/@typra/emitter>
