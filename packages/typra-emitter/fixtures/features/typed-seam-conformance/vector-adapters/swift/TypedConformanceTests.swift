// Committed consumer double for the Swift typed @vector conformance entrypoint
// (issue #511 Cat 1, typra#306 Track A). This is the WHOLE authored surface a
// consumer needs to migrate a plain seam off the stringly VectorAdapters
// registry: a real `Transformer` protocol impl and one typed call to the
// emitted `runTransformerConformance`. No registry, no string keys, no per-op
// marshalling double.
//
// `runTransformerConformance` is emitted only when the entrypoint lands; on
// `main` the symbol does not exist, so this file fails to compile (the red-first
// signal). Conforming `TransformerImpl` to the emitted `Transformer` protocol
// obliges every op, so a forgotten method fails to COMPILE — completeness is not
// a runtime lookup.
import XCTest

@testable import TypraFixturesFeaturesTypedSeamConformance

private enum TransformerError: Error, CustomStringConvertible {
  case boom
  var description: String { "boom not allowed" }
}

private struct TransformerImpl: Transformer {
  func transform(text: String) async throws -> String {
    if text == "boom" { throw TransformerError.boom }
    return text.trimmingCharacters(in: .whitespaces)
  }
}

// A model-in/model-out seam impl: proves the typed entrypoint decodes the Note
// param via the emitted `Note.load(...)` and serializes the Note result back
// through `try actual.save()`. Uppercases the title and returns the value.
private struct ReviserImpl: Reviser {
  func revise(note: Note) async throws -> Note {
    var revised = note
    revised.title = note.title.uppercased()
    return revised
  }
}

// An array-of-model-in/array-of-model-out seam impl: proves the typed entrypoint
// decodes each `[Note]` element via `Note.load(...)` and serializes the `[Note]`
// result back through `try $0.save()`. Reverses the array.
private struct CollatorImpl: Collator {
  func collate(notes: [Note]) async throws -> [Note] {
    return notes.reversed()
  }
}

final class TypedConformanceTests: XCTestCase {
  func testTransformerTypedConformance() async throws {
    try await runTransformerConformance(TransformerImpl())
  }

  func testReviserTypedConformance() async throws {
    try await runReviserConformance(ReviserImpl())
  }

  func testCollatorTypedConformance() async throws {
    try await runCollatorConformance(CollatorImpl())
  }
}
