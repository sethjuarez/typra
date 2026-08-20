import {
  KNOWN_TEST_FAILURES,
  assertKnownTestFailures,
  commandExists,
  execFileSync,
  existsSync,
  fail,
  generatedRoot,
  mkdtempSync,
  path,
  readFileSync,
  rmSync,
  swiftToolchainEnv,
  tmpdir,
  unlinkSync,
  walkFiles,
  writeFileSync,
} from "../harness.mjs";
import {
  assertConformanceResult,
  fixtureRootSampleJsonLiteral,
  propertyCorpusJsonLiteral,
} from "../conformance.mjs";

export function runSwiftTests(
  targetDir = "swift",
  label = "Swift",
) {
  const sourceDir = path.join(generatedRoot, targetDir);
  const sourceFiles = walkFiles(sourceDir, (file) => file.endsWith(".swift"));
  if (sourceFiles.length === 0) {
    fail(`No generated ${label} files found to test.`);
    return;
  }

  if (!commandExists("swift")) {
    fail(
      `Generated ${label} validation cannot run because swift is not available.`,
    );
    return;
  }

  const buildDir = mkdtempSync(path.join(tmpdir(), "typra-swift-"));
  const inheritedPropertyTest = path.join(
    sourceDir,
    "Tests",
    "TypraFixturesTests",
    "InheritedPropertyRoundTripTests.swift",
  );
  const env = swiftToolchainEnv();
  writeFileSync(
    inheritedPropertyTest,
    `import XCTest
@testable import TypraFixtures

final class InheritedPropertyRoundTripTests: XCTestCase {
  private func roundTrip(_ json: String) throws -> [String: Any] {
    let loaded = try FixtureProperty.fromJSON(json)
    let reloaded = try FixtureProperty.load(loaded.save())
    return try reloaded.save()
  }

  private func assertMetadata(_ value: [String: Any], name: String) {
    XCTAssertEqual(value["name"] as? String, name)
    XCTAssertEqual(value["description"] as? String, "\\(name) description")
    XCTAssertEqual(value["required"] as? Bool, true)
    XCTAssertEqual(value["nullable"] as? Bool, false)
    XCTAssertEqual(value["default"] as? String, "fallback")
    XCTAssertEqual(value["example"] as? String, "example")
    XCTAssertEqual(value["enumValues"] as? [String], ["one", "two"])
  }

  func testArrayPropertyRetainsInheritedMetadata() throws {
    let value = try roundTrip("""
    {"kind":"array","name":"array","description":"array description","required":true,"nullable":false,"default":"fallback","example":"example","enumValues":["one","two"],"items":{"kind":"string"}}
    """)
    assertMetadata(value, name: "array")
    XCTAssertNotNil(value["items"])
  }

  func testObjectPropertyRetainsInheritedMetadata() throws {
    let value = try roundTrip("""
    {"kind":"object","name":"object","description":"object description","required":true,"nullable":false,"default":"fallback","example":"example","enumValues":["one","two"],"additionalProperties":{"kind":"string"}}
    """)
    assertMetadata(value, name: "object")
    XCTAssertNotNil(value["additionalProperties"])
  }

  func testUnionPropertyRetainsInheritedMetadata() throws {
    let value = try roundTrip("""
    {"kind":"union","name":"union","description":"union description","required":true,"nullable":false,"default":"fallback","example":"example","enumValues":["one","two"],"anyOf":[{"kind":"string"},{"kind":"boolean"}]}
    """)
    assertMetadata(value, name: "union")
    XCTAssertEqual((value["anyOf"] as? [[String: Any]])?.count, 2)
  }

  func testAllToolVariantsRetainInheritedMetadata() throws {
    let variants: [[String: Any]] = [
      ["kind": "function", "name": "function", "description": "function description", "command": "run"],
      ["kind": "prompt", "name": "prompt", "description": "prompt description", "prompt": "hello"],
      ["kind": "mcp", "name": "mcp", "description": "mcp description", "server": "local"],
      ["kind": "http", "name": "http", "description": "http description", "endpoint": "https://example.test"],
      ["kind": "custom", "name": "custom", "description": "custom description", "connection": ["kind": "future-auth", "name": "future"], "config": ["enabled": true]],
    ]
    for input in variants {
      let output = try FixtureTool.load(input).save()
      XCTAssertEqual(output["name"] as? String, input["name"] as? String)
      XCTAssertEqual(output["description"] as? String, input["description"] as? String)
    }

    let wildcardInput: [String: Any] = [
      "kind": "vendor",
      "name": "vendor",
      "description": "vendor description",
      "connection": ["kind": "future-auth", "name": "future"],
      "config": ["enabled": true],
    ]
    let wildcard = try FixtureTool.load(wildcardInput)
    guard case .fixtureCustomTool(let custom, _) = wildcard else {
      throw TypraRuntimeError.unsupported("Expected FixtureCustomTool wildcard")
    }
    XCTAssertEqual(custom.kind, "vendor")
    let wildcardOutput = try wildcard.save()
    XCTAssertEqual(wildcardOutput["kind"] as? String, "vendor")
    XCTAssertEqual(wildcardOutput["name"] as? String, "vendor")
    XCTAssertEqual((wildcardOutput["config"] as? [String: Any])?["enabled"] as? Bool, true)
    let wildcardReloaded = try FixtureTool.load(wildcardOutput)
    guard case .fixtureCustomTool(let reloadedCustom, _) = wildcardReloaded else {
      throw TypraRuntimeError.unsupported("Expected reloaded FixtureCustomTool wildcard")
    }
    XCTAssertEqual(reloadedCustom.kind, "vendor")
  }

  func testToolBindingsLoadAndRoundTripMapAndListForms() throws {
    func functionTool(_ input: [String: Any]) throws -> FixtureFunctionTool {
      let loaded = try FixtureTool.load(input)
      guard case .fixtureFunctionTool(let tool) = loaded else {
        throw TypraRuntimeError.unsupported("Expected FixtureFunctionTool")
      }
      return tool
    }

    let mapTool = try functionTool([
      "kind": "function",
      "name": "map-tool",
      "command": "run",
      "bindings": [
        "zeta": ["source": "result.text"],
        "alpha": ["source": "customer.name"],
      ],
    ])
    XCTAssertEqual(mapTool.bindings?.compactMap { $0.name }, ["alpha", "zeta"])
    let mapOutput = try mapTool.save()
    let mapBindings = mapOutput["bindings"] as? [String: Any]
    XCTAssertEqual(mapBindings?["alpha"] as? String, "customer.name")
    XCTAssertEqual(mapBindings?["zeta"] as? String, "result.text")
    let mapReloaded = try functionTool(mapOutput)
    XCTAssertEqual(mapReloaded.bindings?.compactMap { $0.name }, ["alpha", "zeta"])

    let listTool = try functionTool([
      "kind": "function",
      "name": "list-tool",
      "command": "run",
      "bindings": [
        ["name": "zeta", "source": "result.text"],
        ["name": "alpha", "source": "customer.name"],
      ],
    ])
    XCTAssertEqual(listTool.bindings?.compactMap { $0.name }, ["zeta", "alpha"])
    let listOutput = try listTool.save(SaveContext(collectionFormat: "array"))
    let listBindings = listOutput["bindings"] as? [[String: Any]]
    XCTAssertEqual(listBindings?.count, 2)
    XCTAssertEqual(listBindings?[0]["name"] as? String, "zeta")
    XCTAssertEqual(listBindings?[0]["source"] as? String, "result.text")
    let listReloaded = try functionTool(listOutput)
    XCTAssertEqual(listReloaded.bindings?.compactMap { $0.name }, ["zeta", "alpha"])

    let scalarTool = try functionTool([
      "kind": "function",
      "name": "scalar-tool",
      "command": "run",
      "bindings": [
        "zeta": "result.text",
        "alpha": "customer.name",
      ],
    ])
    XCTAssertEqual(scalarTool.bindings?.compactMap { $0.name }, ["alpha", "zeta"])
    XCTAssertEqual(scalarTool.bindings?.first { $0.name == "alpha" }?.source, "customer.name")
    let scalarOutput = try scalarTool.save()
    XCTAssertEqual((scalarOutput["bindings"] as? [String: Any])?["alpha"] as? String, "customer.name")
    let scalarReloaded = try functionTool(scalarOutput)
    XCTAssertEqual(scalarReloaded.bindings?.compactMap { $0.name }, ["alpha", "zeta"])
  }

  func testScalarPropertyCoercionDispatchesToTypedVariant() throws {
    let output = try FixtureProperty.load("hello").save()
    XCTAssertEqual(output["kind"] as? String, "string")
    XCTAssertEqual(output["default"] as? String, "hello")
  }

  func testClosedContentDiscriminatorIsExactAndStrict() throws {
    let known = try FixtureContent.load(["kind": "text", "value": "hello"]).save()
    XCTAssertEqual(known["kind"] as? String, "text")
    XCTAssertEqual(known["value"] as? String, "hello")

    for invalidKind in ["video", "Text"] {
      XCTAssertThrowsError(try FixtureContent.load(["kind": invalidKind, "value": "hello"])) { error in
        let message = String(describing: error)
        XCTAssertTrue(message.contains("kind"), message)
        XCTAssertTrue(message.contains(invalidKind), message)
      }
    }
  }

  func testUnknownConnectionDiscriminatorIsLossless() throws {
    let input: [String: Any] = [
      "kind": "future-auth",
      "name": "future",
      "config": ["nested": [1, NSNull(), ["enabled": true]]],
      "nullable": NSNull(),
    ]
    let output = try FixtureConnection.load(input).save()
    XCTAssertEqual(output["kind"] as? String, "future-auth")
    XCTAssertEqual(output["name"] as? String, "future")
    XCTAssertTrue(output["nullable"] is NSNull)
    let nested = (output["config"] as? [String: Any])?["nested"] as? [Any]
    XCTAssertEqual(nested?[0] as? Int, 1)
    XCTAssertTrue(nested?[1] is NSNull)
    XCTAssertEqual((nested?[2] as? [String: Any])?["enabled"] as? Bool, true)

    let reloaded = try FixtureConnection.load(output).save()
    XCTAssertEqual(reloaded["kind"] as? String, "future-auth")
    XCTAssertEqual(((reloaded["config"] as? [String: Any])?["nested"] as? [Any])?.count, 3)

    let caseCollision = try FixtureConnection.load([
      "kind": "Custom",
      "name": "case-sensitive-unknown",
      "payload": ["mode": "future"],
    ])
    guard case .unknown(let casePayload) = caseCollision else {
      throw TypraRuntimeError.unsupported("Expected wrong-case Connection to remain unknown")
    }
    XCTAssertEqual(casePayload["kind"] as? String, "Custom")
    XCTAssertEqual((casePayload["payload"] as? [String: Any])?["mode"] as? String, "future")

    let known = try FixtureConnection.load([
      "kind": "custom",
      "name": "known",
      "endpoint": "https://example.test",
    ])
    guard case .fixtureCustomConnection(let custom) = known else {
      throw TypraRuntimeError.unsupported("Expected exact Connection discriminator to dispatch")
    }
    XCTAssertEqual(custom.endpoint, "https://example.test")
  }

  func testInvalidConnectionDiscriminatorsAreRejected() throws {
    for input in [
      ["name": "missing-kind"],
      ["kind": "", "name": "blank-kind"],
      ["kind": NSNull(), "name": "null-kind"],
    ] as [[String: Any]] {
      XCTAssertThrowsError(try FixtureConnection.load(input).save()) { error in
        let message = String(describing: error)
        XCTAssertTrue(message.contains("kind"), message)
      }
    }
  }

  func testNamedCollectionsUseLosslessFallbackAndRejectNestedArrays() throws {
    let unique = try FixtureNamedPayloadCollection.load([
      "items": [
        ["name": "alpha", "payload": ["nested": [1, NSNull()]]],
        ["name": "beta", "payload": "second"],
      ],
    ])
    XCTAssertEqual((try unique.save()["items"] as? [String: Any])?.count, 2)
    XCTAssertNotNil(try unique.save(SaveContext(collectionFormat: "array"))["items"] as? [[String: Any]])

    let unnamed = try FixtureNamedPayloadCollection.load([
      "items": [
        ["payload": ["nested": [1, NSNull()]]],
        ["name": "", "payload": "second"],
      ],
    ])
    let unnamedItems = try unnamed.save()["items"] as? [[String: Any]]
    XCTAssertEqual(unnamedItems?.count, 2)
    XCTAssertEqual(unnamedItems?[1]["name"] as? String, "")

    let duplicate = try FixtureNamedPayloadCollection.load([
      "items": [
        ["name": "dup", "payload": 1],
        ["name": "dup", "payload": 2],
      ],
    ])
    XCTAssertEqual((try duplicate.save()["items"] as? [[String: Any]])?.count, 2)

    XCTAssertThrowsError(try FixtureNamedRoot.load([
      "inputs": ["profile": ["properties": ["arrayEntry": []]]],
    ])) { error in
      let message = String(describing: error)
      XCTAssertTrue(message.contains("inputs.profile.properties.arrayEntry"), message)
      XCTAssertTrue(message.contains("array"), message)
    }
  }

  func testEntryShorthandRoundTripsThroughNamedCollections() throws {
    let bag = try FixtureBag.load([
      "items": ["alpha": ["note": "first"]],
      "secondItems": ["beta": "second"],
    ])
    XCTAssertEqual(bag.items.count, 1, "named object collection must load into an ordered list")
    XCTAssertEqual(bag.items.first?.name, "alpha", "named object collection must adopt the key as name")
    XCTAssertEqual(bag.secondItems.first?.note, "second", "named scalar shorthand must load into the primary field")

    let objectBag = try bag.save()["items"] as? [String: Any]
    XCTAssertEqual(objectBag?["alpha"] as? String, "first", "default object save must use shorthand")

    let expandedBag = try bag.save(SaveContext(useShorthand: false))["items"] as? [String: Any]
    XCTAssertNotNil(expandedBag?["alpha"] as? [String: Any], "useShorthand=false must preserve the item object")
  }

  func testMissingRequiredCustomToolConnectionIsRejectedPathfully() throws {
    do {
      _ = try FixtureToolbox.fromJSON("""
      {"tools":{"custom":{"kind":"vendor"}},"inheritedMapBindingTool":{"kind":"function","name":"map","command":"run"},"inheritedListBindingTool":{"kind":"function","name":"list","command":"run"}}
      """)
      XCTFail("missing required CustomTool.connection was accepted")
    } catch {
      let diagnostic = String(describing: error)
      XCTAssertTrue(diagnostic.contains("tools.custom.connection"), diagnostic)
      XCTAssertTrue(diagnostic.contains("missing required field"), diagnostic)
    }
  }
}
`,
  );
  try {
    let output = "";
    let crashed = null;
    try {
      output = execFileSync(
        "swift",
        [
          "test",
          "--package-path",
          sourceDir,
          "--scratch-path",
          buildDir,
          "-Xswiftc",
          "-warnings-as-errors",
        ],
        {
          cwd: sourceDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env,
        },
      );
    } catch (error) {
      output = `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`;
      crashed = error;
    }
    const failed = new Set([
      ...[...output.matchAll(/Test Case '-\[[^\s]+\s+([^\]]+)\]' failed/g)].map(
        (match) => match[1],
      ),
      ...[...output.matchAll(/Test Case '([^']+)' failed/g)].map(
        (match) => match[1],
      ),
    ]);
    assertKnownTestFailures(targetDir, failed, KNOWN_TEST_FAILURES[targetDir], {
      crashed,
      output,
      crashMessage: `Generated ${label} package tests failed to build or run`,
    });
  } finally {
    if (existsSync(inheritedPropertyTest)) {
      unlinkSync(inheritedPropertyTest);
    }
    if (existsSync(buildDir)) {
      rmSync(buildDir, { recursive: true, force: true });
    }
  }
}

export function runSwiftCodableTests() {
  runSwiftTests("swift-codable", "Swift Codable");
}

/**
 * Swift was the only conformance-matrix target with no executable conformance run: its sources
 * compiled and its generated package tests ran, but nothing ever checked that the Swift backend
 * produces the same canonical output as the other six. Conformance evidence was asserted for a
 * backend whose behaviour was never compared.
 *
 * The canonical payload is emitted from inside an XCTest rather than a separate executable target
 * so that the generated `Package.swift` is not rewritten, reusing the same toolchain plumbing as
 * `runSwiftTests`. `swift test` interleaves its own progress output, so the payload is tagged with
 * a sentinel and extracted rather than read off the last line.
 */
export function runSwiftExecutableConformance(
  targetDir = "swift",
  useCodable = false,
) {
  const sourceDir = path.join(generatedRoot, targetDir);
  const sourceFiles = walkFiles(sourceDir, (file) => file.endsWith(".swift"));
  if (sourceFiles.length === 0) {
    fail(`No generated ${targetDir} files found for executable conformance.`);
    return;
  }

  if (!commandExists("swift")) {
    fail(
      `Generated ${targetDir} executable conformance cannot run because swift is not available.`,
    );
    return;
  }

  const runnerPath = path.join(
    sourceDir,
    "Tests",
    "TypraFixturesTests",
    "ConformanceValidateTests.swift",
  );
  const buildDir = mkdtempSync(path.join(tmpdir(), "typra-swift-conformance-"));

  writeFileSync(
    runnerPath,
    `import XCTest
import Foundation
@testable import TypraFixtures

final class ConformanceValidateTests: XCTestCase {
  private func loadFixtureRootFromJson(_ json: String) throws -> FixtureRoot {
    ${useCodable ? "return try JSONDecoder().decode(FixtureRoot.self, from: Data(json.utf8))" : ""}
    ${useCodable ? "" : "let data = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]"}
    ${useCodable ? "" : "return try FixtureRoot.load(data)"}
  }

  ${
    useCodable
      ? `private func assertCodableMatchesTypra<T: TypraModel & Codable>(_ value: T, _ message: String) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let codableObject = try JSONSerialization.jsonObject(with: encoder.encode(value))
    let typraObject = try value.save(SaveContext())
    let codableJson = try TypraRuntime.jsonString(from: codableObject)
    let typraJson = try TypraRuntime.jsonString(from: typraObject)
    XCTAssertEqual(codableJson, typraJson, message)
  }`
      : `private func assertCodableMatchesTypra(_ value: Any, _ message: String) throws {
    _ = value
    _ = message
  }`
  }

  func testEmitsCanonicalConformancePayload() throws {
    let propertyCases = try JSONSerialization.jsonObject(with: Data(${propertyCorpusJsonLiteral}.utf8)) as! [[String: Any]]
    let propertyOutputs = try propertyCases.map { entry -> [String: Any] in
      let inputData = try JSONSerialization.data(withJSONObject: entry["input"] as! [String: Any])
      let propertyRoot = try loadFixtureRootFromJson(String(data: inputData, encoding: .utf8)!)
      try assertCodableMatchesTypra(propertyRoot, "property corpus Codable encode must match Typra save")
      return [
        "id": entry["id"]!,
        "seed": entry["seed"]!,
        "caseId": entry["caseId"]!,
        "root": try propertyRoot.save(),
      ]
    }
    let root = try loadFixtureRootFromJson(${fixtureRootSampleJsonLiteral})
    try assertCodableMatchesTypra(root, "root Codable encode must match Typra save")
    var unknownRecordData = try JSONSerialization.jsonObject(with: Data(${fixtureRootSampleJsonLiteral}.utf8)) as! [String: Any]
    unknownRecordData["metadata"] = [
      "zero": 0,
      "one": 1,
      "decimal": 0.125,
      "highPrecision": 1234567890.1234567,
      "flag": true,
    ]
    let unknownRecordRoot = try FixtureRoot.load(unknownRecordData)
    try assertCodableMatchesTypra(unknownRecordRoot, "Record<unknown> NSNumber payloads must not bridge 0/1 into booleans")
    let imageContent = try FixtureContent.load(["kind": "image", "url": "https://example.com/fixture.png"])
    try assertCodableMatchesTypra(imageContent, "polymorphic Codable encode must match Typra save")
    let rawConnectionData = try JSONSerialization.jsonObject(with: Data("""
    {"kind":"future-auth","name":"future","zero":0,"one":1,"decimal":0.125,"highPrecision":1234567890.1234567,"flag":true}
    """.utf8)) as! [String: Any]
    let rawConnection = try FixtureConnection.load(rawConnectionData)
    try assertCodableMatchesTypra(rawConnection, "raw unknown discriminator NSNumber payloads must not bridge 0/1 into booleans")
    let wire = try WireOptions.load(["maxOutputTokens": 256, "temperature": 0.7])
    let reference = try FixtureReference.fromYAML("\\"ref-coerced\\"")

    let payload: [String: Any] = [
      "root": try root.save(),
      "propertyCases": propertyOutputs,
      "imageContent": try imageContent.save(),
      "openai": try wire.toWire("openai"),
      "anthropic": try wire.toWire("anthropic"),
      "unmapped": try wire.toWire("unmapped-provider"),
      "emptyProvider": try wire.toWire(""),
      "reference": try reference.save(),
    ]

    let encoded = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    let outputPath = ProcessInfo.processInfo.environment["TYPRA_CONFORMANCE_OUTPUT"]!
    try encoded.write(to: URL(fileURLWithPath: outputPath))
  }

  // An open discriminator must absorb a value that no subtype claims, carry the
  // whole payload verbatim, and replay it on save. Every other backend runner
  // asserts this; swift did not, which is the same "asserted somewhere, but not
  // everywhere" gap that let the toWire defect reach a release.
  func testUnknownDiscriminatorCarrierRoundTrips() throws {
    let input: [String: Any] = [
      "kind": "future-auth",
      "name": "future",
      "config": ["nested": [1, NSNull(), ["enabled": true]]],
      "nullable": NSNull(),
    ]
    let saved = try FixtureConnection.load(input).save()
    XCTAssertEqual(saved["kind"] as? String, "future-auth", "unknown carrier lost its discriminator")
    XCTAssertEqual(saved["name"] as? String, "future", "unknown carrier lost a modeled field")
    XCTAssertTrue(saved["nullable"] is NSNull, "unknown carrier dropped an explicit null")
    XCTAssertNotNil(saved["config"], "unknown carrier dropped an unmodeled nested field")

    let reloaded = try FixtureConnection.load(saved).save()
    let first = try JSONSerialization.data(withJSONObject: saved, options: [.sortedKeys])
    let second = try JSONSerialization.data(withJSONObject: reloaded, options: [.sortedKeys])
    XCTAssertEqual(first, second, "unknown carrier payload did not survive a reload")
  }

  func testInvalidDiscriminatorStatesDoNotUseUnknownFallback() throws {
    let invalidInputs: [[String: Any]] = [
      [:],
      ["kind": ""],
      ["kind": NSNull()],
      ["kind": 42],
    ]

    for input in invalidInputs {
      XCTAssertThrowsError(try FixtureConnection.load(input), "invalid FixtureConnection discriminator was accepted") { error in
        let message = String(describing: error)
        XCTAssertTrue(
          message.contains("kind") || message.contains("discriminator"),
          "invalid FixtureConnection discriminator diagnostic lost field context: \\(message)"
        )
      }

      func testClosedUnionUnclaimedDiscriminatorLoadsBase() throws {
        let unclaimedInput: [String: Any] = ["kind": "plain", "label": "leftover"]
        let unclaimed = try FixtureUnclaimedBase.load(unclaimedInput)
        guard case .unknown(let saved) = unclaimed else {
          XCTFail("unclaimed closed discriminator value did not load as the base type")
          return
        }
        XCTAssertEqual(saved["kind"] as? String, "plain")
        XCTAssertEqual(saved["label"] as? String, "leftover")

        let claimed = try FixtureUnclaimedBase.load(["kind": "managed", "label": "known", "resourceId": "res-1"])
        guard case .fixtureClaimedVariant(let value) = claimed else {
          XCTFail("claimed discriminator value stopped dispatching to its subtype")
          return
        }
        XCTAssertEqual(value.resourceId, "res-1")
      }
    }
  }

  // Both declared named-collection forms load equivalently, while an array-valued
  // entry in the name-keyed object form is rejected. Locking both halves together
  // keeps a fix for one from silently breaking the other.
  func testNamedCollectionHonoursBothDeclaredForms() throws {
    let listForm = try FixtureNamedPayloadCollection.load(["items": [["name": "alpha", "payload": "one"]]])
    let objectForm = try FixtureNamedPayloadCollection.load(["items": ["alpha": ["payload": "one"]]])
    XCTAssertEqual(listForm.items.count, 1, "list form did not load a single entry")
    XCTAssertEqual(objectForm.items.count, 1, "name-keyed object form did not load a single entry")
    XCTAssertEqual(listForm.items.first?.name, "alpha", "list form lost the entry name")
    XCTAssertEqual(objectForm.items.first?.name, "alpha", "name-keyed object form did not adopt the key as the name")

    XCTAssertThrowsError(try FixtureNamedPayloadCollection.load(["items": ["alpha": ["one", "two"]]])) { error in
      XCTAssertTrue(
        String(describing: error).contains("category array"),
        "array-valued entry in name-keyed object form was not rejected as a category array"
      )
    }
  }

  // Issue #47: a failure inside an array element must carry the element index, so a
  // diagnostic cannot silently degrade to naming only the field.
  func testArrayElementDiagnosticCarriesTheIndex() throws {
    let input: [String: Any] = [
      "entries": [
        ["label": "first", "detail": ["code": "ok"]],
        ["label": "second"],
      ]
    ]
    XCTAssertThrowsError(try FixtureIndexedList.load(input)) { error in
      XCTAssertTrue(
        String(describing: error).contains("entries[1].detail"),
        "array element diagnostic lost the element index"
      )
    }
  }
}
`,
  );
  const payloadPath = path.join(buildDir, "conformance.json");

  try {
    execFileSync(
      "swift",
      [
        "test",
        "--package-path",
        sourceDir,
        "--scratch-path",
        buildDir,
        "-Xswiftc",
        "-warnings-as-errors",
        "--filter",
        "ConformanceValidateTests",
      ],
      {
        cwd: sourceDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...swiftToolchainEnv(), TYPRA_CONFORMANCE_OUTPUT: payloadPath },
      },
    );
    assertConformanceResult(targetDir, readFileSync(payloadPath, "utf8"));
  } catch (error) {
    const output =
      `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
    fail(
      `Generated ${targetDir} executable conformance failed:\n${output || error.message}`,
    );
  } finally {
    if (existsSync(runnerPath)) {
      unlinkSync(runnerPath);
    }
    rmSync(buildDir, { recursive: true, force: true });
  }
}

export function runSwiftCodableExecutableConformance() {
  runSwiftExecutableConformance("swift-codable", true);
}
