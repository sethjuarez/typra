import Foundation

enum VectorAdapters {
  static func adapters() -> [String: VectorAdapter] {
    var m: [String: VectorAdapter] = [:]
    m["Echo.echo"] = VectorAdapter(asynchronous: echoInvoke)
    m["Sum.sum"] = VectorAdapter(sync: sumInvoke)
    m["Note.note"] = VectorAdapter(sync: noteInvoke)
    return m
  }

  static func waivers() -> [String: String] { return [:] }
  static func doubles() -> Any? { return nil }

  static func echoInvoke(_ input: Any?, _ ctx: VectorContext) async throws -> Any? {
    // Await on XCTest's runtime to prove an adapter may drive real async work.
    await Task.yield()
    let payload = (input as? [String: Any])?["payload"] as? String ?? ""
    if payload.isEmpty {
      throw VectorError("empty", payload: ["code": "empty"])
    }
    return payload.uppercased()
  }

  static func noteInvoke(_ input: Any?, _ ctx: VectorContext) throws -> Any? {
    let text = (input as? [String: Any])?["text"] as? String ?? ""
    return text + "!"
  }

  static func sumInvoke(_ input: Any?, _ ctx: VectorContext) throws -> Any? {
    let values = (input as? [String: Any])?["values"] as? [Any] ?? []
    var total = 0
    for value in values {
      if let number = value as? NSNumber { total += number.intValue }
    }
    return total
  }

}
