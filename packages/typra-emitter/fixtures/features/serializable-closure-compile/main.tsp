import "@typra/emitter";

// Whole-tree COMPILE gate for the "@serializable-closure conformance" defect
// family (prompty#511). Every member of this family is the same shape: a
// serialization-dependent construct (a wire method, a per-field collection
// save/load helper, a protocol conformance, a codable delegation) emitted
// against a type whose load/save was correctly PRUNED because it is outside the
// `@serializable` closure. The construct then references a symbol that no longer
// exists and the generated tree fails to COMPILE — a failure that string-level
// fixture assertions never see because they inspect one file at a time.
//
// This fixture deliberately couples, in one namespace:
//   * a `@serializable` root (in-closure: keeps load/save + conformance), and
//   * three genuinely non-serializable, closure-UNREACHABLE shapes:
//       - a standalone scalar type (Swift `: TypraModel` / Go wire family),
//       - a `@knownAs` wire-mapped standalone type (Go wire family),
//       - a collection PARENT holding a collection of a non-serializable ELEMENT
//         (Rust/Java per-field `save_<field>`/`load_<field>` helper family).
//
// Rendered and COMPILED per target by the `*.serializable-closure-compile`
// validation stages. Green on a correct emitter (non-serializable types emit as
// plain structs); red the moment any driver re-emits a serialization construct
// outside the closure gate — the exact class of regression that shipped as
// 2.1.3 (Go wire), 2.1.5 (Rust collection helpers) and 2.1.6 (Swift conformance).
//
// NOTE: fields are plain scalars on purpose. This fixture isolates the CLOSURE
// family; it intentionally avoids `@sensitive`/never-loaded fields so a compile
// failure here can only mean a closure-gate regression, nothing else.

namespace Typra.Fixtures.Features.SerializableClosureCompile;

// In-closure serialization root: load/save + conformance MUST be emitted, and
// must compile. Holds only scalars so the closure is exactly {Root}. One field
// is named after a C# reserved word (`base`) so the C# compile gate proves a
// keyword-named field survives the generated model codec — the driver
// PascalCases it to a property (`Base`) and suffixes its local (`baseValue`),
// so a keyword field must never leak an unescaped bare identifier into the
// load/save body. (The stricter `var @base` conformance-local escaping of the
// 2.1.4 family is exercised by the separate `csharp.vector-conformance-compile`
// gate, which compiles conformance code; this closure gate renders `--no-tests`
// and covers the model codec.) `base` is not a reserved word in
// Java/Rust/Swift, so it stays a plain scalar field there.
@serializable
model Root {
  @sample(#{ id: "root-1", label: "primary" })
  id: string;

  label: string;

  base: string;
}

// Non-serializable standalone scalar type, unreachable from any `@serializable`
// root or seam boundary. Its load/save are pruned, so any conformance/marker or
// codec the driver stamps on it UNCONDITIONALLY (rather than gated on the
// closure) references pruned members and fails to compile. This is the Swift
// `: TypraModel` (2.1.6) family witness.
model Standalone {
  @sample(#{ name: "standalone" })
  name: string;
}

// Non-serializable standalone type that ALSO carries a `@knownAs` provider wire
// mapping. Wire conversion routes through the type's save/load, so a driver that
// emits wire methods outside the closure gate references pruned save/load and
// fails to compile. This is the Go wire (2.1.3) family witness.
@@knownAs(WireDetached.label, "foundry", "detached_label");
model WireDetached {
  @sample(#{ label: "wire" })
  label: string;
}

// Non-serializable ELEMENT of a non-serializable collection PARENT. Both are
// closure-unreachable, so both emit as plain structs with no codec.
model GroupItem {
  @sample(#{ tag: "item" })
  tag: string;
}

// Non-serializable collection PARENT holding `GroupItem[]`. A driver that emits
// per-field `save_items`/`load_items` helpers gated only on "has a collection
// field" (not on closure membership) will call the pruned `GroupItem` codec and
// fail to compile. This is the Rust collection-helper (2.1.5) family witness.
model Group {
  @sample(#{ items: #[#{ tag: "item" }] })
  items: GroupItem[];
}
