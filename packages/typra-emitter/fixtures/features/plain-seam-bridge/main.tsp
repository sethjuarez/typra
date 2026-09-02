import "@typra/emitter";

namespace Typra.Fixtures.Features.PlainSeamBridge;

// ===========================================================================
// Plain (undispatched) seam reproduction for the typed ADAPTER BRIDGE
// (prompty#511 Category 1 / typra#306, Track A).
//
// A seam WITHOUT `@dispatch` has no discriminator — it is a single
// implementation, not a variant set. Today its `@vector` conformance rides the
// STRINGLY runner: the emitted per-interface test calls `RunVector` keyed on
// `Contract.operation` and looks the impl up in a runtime adapter registry, so
// every consumer must hand-author a marshalling double (decode JSON input →
// call the real impl → encode the result). That per-op marshalling boilerplate
// is the ~7×-duplicated bulk (Rust `vector_adapters.rs` ≈2.3k lines, etc.).
//
// This fixture is the MINIMAL, domain-agnostic first slice for the bridge:
//   * ONE op, SCALAR in, SCALAR out — so `expected` is a bare string that
//     `RunVector`'s canonical comparator already asserts (dodging the
//     non-scalar-`expected` / opaque-input / cancellation hazards that make
//     larger seams unsafe to migrate first).
//   * NO `@dispatch`, NO `requires`/`normalization`/`provider`/`$ref` vector
//     features — provably bridge-eligible.
//
// Red-first target: on `main` the emitter has no bridge, so the generated seam
// test can only be satisfied by a hand-authored double. The bridge emitter must
// emit an `Adapter.Invoke(map)→map` shell that decodes `input.text`, calls a
// consumer-supplied typed impl `Transformer`, and re-encodes the string result
// — leaving the consumer only the typed impl + one registration line.
// ===========================================================================

@doc("Scalar-in / scalar-out plain seam: no discriminator, single implementation.")
interface Transformer {
  @vector(#{
    name: "identity",
    stage: "callable",
    input: #{ text: "hello bridge" },
    expected: "hello bridge",
  })
  @vector(#{
    name: "trim",
    stage: "callable",
    input: #{ text: "  padded  " },
    expected: "padded",
  })
  @doc("Transform an input string into an output string.")
  transform(text: string): string;
}

@doc("Fixture root aggregating the plain-seam graph.")
model Root {
  @doc("A sample input the seam transforms; present only to give the root a field.")
  seed: string = "";
}
