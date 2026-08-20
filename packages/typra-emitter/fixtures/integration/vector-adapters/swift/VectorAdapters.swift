// Reference adapters for the integration fixture's @vector suite. Copied into
// each Swift target's Tests/TypraFixturesTests dir by validate-fixtures before
// the generated conformance suite runs. See fixtures/integration/vector-adapters.
import Foundation

enum VectorAdapters {
  static func adapters() -> [String: VectorAdapter] {
    var m: [String: VectorAdapter] = [:]
    m["CanonicalEnginePort.authorize"] = VectorAdapter(authorizeInvoke)
    m["CanonicalEnginePort.format"] = VectorAdapter(formatInvoke)
    return m
  }

  static func waivers() -> [String: String] { return [:] }
  static func doubles() -> Any? { return nil }

  static func authorizeInvoke(_ input: Any?, _ ctx: VectorContext) throws -> Any? {
    return ["approved": true]
  }

  static func formatInvoke(_ input: Any?, _ ctx: VectorContext) throws -> Any? {
    return (input as? [String: Any])?["messages"]
  }
}
