import "@typra/emitter";

namespace Typra.Fixtures.Features.TypedSeamConformance;

// ===========================================================================
// Plain (undispatched) seam reproduction for the TYPED @vector conformance
// ENTRYPOINT (prompty#511 Category 1 / typra#306, Track A).
//
// A seam WITHOUT `@dispatch` has no discriminator — it is a single
// implementation, not a variant set. Historically its `@vector` conformance
// rode the STRINGLY runner: the emitted per-interface test looks the impl up in
// a runtime adapter registry keyed on `Contract.operation`, so every consumer
// had to hand-author a marshalling double (decode JSON input → call the real
// impl → encode the result). That per-op marshalling boilerplate is the
// ~7×-duplicated bulk (Rust `vector_adapters.rs` ≈2.3k lines, etc.).
//
// The typed entrypoint replaces that registry with a generic fn
// `run_<seam>_conformance<S: <Seam>>(seam: &S)` carrying the seam's vectors
// baked in. The consumer's authored surface collapses to their real
// `impl <Seam>` plus a one-line typed call: no registry, no string keys, no
// boxed adapters. The `S: <Seam>` bound makes the compiler PROVE every op is
// implemented (Rust E0046), so completeness is a compile-time guarantee.
//
// This fixture is the minimal, domain-agnostic slice:
//   * ONE op, SCALAR in / SCALAR out.
//   * an `expected` pair (identity + trim) asserted by structural compare, and
//   * an `expectedError` pair (boom) asserted on the async op's error channel.
//   * NO `@dispatch`, NO `requires`/`normalization`/`provider`/`$ref` vector
//     features — provably eligible for the typed entrypoint.
//
// Red-first: on `main` the emitter has no typed entrypoint, so the committed
// typed double (which calls `run_transformer_conformance(&Impl)`) fails to
// compile (unresolved `crate::model::vector_conformance`). The entrypoint
// emitter makes it resolve and pass.
// ===========================================================================

@doc("Scalar-in / scalar-out plain seam: no discriminator, single implementation.")
interface Transformer {
  @vector(#{
    name: "identity",
    stage: "callable",
    input: #{ text: "hello seam" },
    expected: "hello seam",
  })
  @vector(#{
    name: "trim",
    stage: "callable",
    input: #{ text: "  padded  " },
    expected: "padded",
  })
  @vector(#{
    name: "boom",
    stage: "callable",
    input: #{ text: "boom" },
    expectedError: "boom not allowed",
  })
  @doc("Transform an input string into an output string.")
  transform(text: string): string;
}

@doc("Fixture root aggregating the plain-seam graph.")
@serializable
model Root {
  @doc("A sample input the seam transforms; present only to give the root a field.")
  seed: string = "";
}
