import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FileDecl, TypeDecl } from "../src/ir/declarations.js";
import { TypeRegistry } from "../src/ir/expansion.js";
import { emitCSharpClass } from "../src/languages/csharp/emitter.js";
import { CSharpExprVisitor } from "../src/languages/csharp/visitor.js";
import { emitGoFileContent } from "../src/languages/go/emitter.js";
import { GoExprVisitor } from "../src/languages/go/visitor.js";
import { emitJavaFileContent } from "../src/languages/java/emitter.js";
import { JavaExprVisitor } from "../src/languages/java/visitor.js";
import { emitJavaContext } from "../src/languages/java/scaffolding.js";
import { emitPythonFile } from "../src/languages/python/emitter.js";
import { PythonExprVisitor } from "../src/languages/python/visitor.js";
import { emitRustFile } from "../src/languages/rust/emitter.js";
import { RustExprVisitor } from "../src/languages/rust/visitor.js";
import { emitSwiftFile } from "../src/languages/swift/emitter.js";
import { emitSwiftRuntime } from "../src/languages/swift/scaffolding.js";
import { SwiftExprVisitor } from "../src/languages/swift/visitor.js";
import { emitTypeScriptFile } from "../src/languages/typescript/emitter.js";
import { TypeScriptExprVisitor } from "../src/languages/typescript/visitor.js";

// Issue #342: sized and unsigned TypeSpec integers must map to native types in every
// runtime instead of leaking the TypeSpec name (`uint64`) or falling back to `Any`.
const SIZED: Array<[name: string, scalarType: string, optional: boolean]> = [
  ["tiny", "int8", false],
  ["small", "int16", false],
  ["octet", "uint8", false],
  ["port", "uint16", false],
  ["durationMs", "uint32", true],
  ["byteSize", "uint64", false],
  ["safeCount", "safeint", true],
];

function sizedType(): TypeDecl {
  const type = {
    typeName: { namespace: "Test", name: "Narration" },
    serialized: true,
    base: null,
    isAbstract: false,
    isProtocol: false,
    description: "",
    fields: [],
    coercionProperty: null,
    load: {
      coercions: [],
      assignments: [],
      hasPolymorphicDispatch: false,
      hasContextHooks: false,
    },
    save: { assignments: [], hasBase: false, hasContextHooks: false },
    factories: [],
    collectionHelpers: [],
    polymorphicDispatch: null,
    methods: [],
    wire: null,
  } as unknown as TypeDecl;
  for (const [name, scalarType, isOptional] of SIZED) {
    const category = { kind: "scalar" as const, scalarType };
    const common = {
      category,
      isOptional,
      parentTypeName: "Narration",
      enumName: null,
      isOpenEnum: false,
    };
    type.fields.push({
      name,
      typeName: { namespace: "", name: scalarType },
      category,
      isOptional,
      defaultValue: null,
      hasExplicitDefault: false,
      allowedValues: [],
      parseAliases: {},
      enumName: null,
      isOpenEnum: false,
      description: "",
      knownAs: {},
    } as unknown as TypeDecl["fields"][number]);
    type.load.assignments.push({
      ...common,
      sourceName: name,
      fieldName: name,
      allowedValues: [],
      parseAliases: {},
      defaultValue: null,
      hasExplicitDefault: false,
    } as unknown as TypeDecl["load"]["assignments"][number]);
    type.save.assignments.push({
      ...common,
      targetName: name,
      fieldName: name,
    } as unknown as TypeDecl["save"]["assignments"][number]);
  }
  return type;
}

function fileDecl(type: TypeDecl): FileDecl {
  return {
    typeName: type.typeName,
    types: [type],
    imports: [],
    containsAbstract: false,
    enums: [],
    group: "",
  } as unknown as FileDecl;
}

describe("sized and unsigned integer scalars (#342)", () => {
  it("Rust emits native integer types and range-checked loads", () => {
    const source = emitRustFile(
      fileDecl(sizedType()),
      new RustExprVisitor(TypeRegistry.fromTypeGraph([])),
      new Set<string>(),
    );
    assert.match(source, /pub tiny: i8,/);
    assert.match(source, /pub small: i16,/);
    assert.match(source, /pub octet: u8,/);
    assert.match(source, /pub port: u16,/);
    assert.match(source, /pub duration_ms: Option<u32>,/);
    assert.match(source, /pub byte_size: u64,/);
    assert.match(source, /pub safe_count: Option<i64>,/);
    assert.match(source, /as_u64\(\)\.and_then\(\|n\| u8::try_from\(n\)\.ok\(\)\)/);
    assert.match(source, /as_i64\(\)\.and_then\(\|n\| i8::try_from\(n\)\.ok\(\)\)/);
    assert.match(source, /value\.get\("byteSize"\)\.and_then\(\|v\| v\.as_u64\(\)\)/);
    assert.doesNotMatch(source, /uint64|Uint64|safeint/);
  });

  it("Swift emits native integer types and runtime loaders", () => {
    const source = emitSwiftFile(
      fileDecl(sizedType()),
      new SwiftExprVisitor(),
      new Set(),
    );
    assert.match(source, /public var tiny: Int8 = 0/);
    assert.match(source, /public var small: Int16 = 0/);
    assert.match(source, /public var octet: UInt8 = 0/);
    assert.match(source, /public var port: UInt16 = 0/);
    assert.match(source, /public var durationMs: UInt32\? = nil/);
    assert.match(source, /public var byteSize: UInt64 = 0/);
    assert.match(source, /public var safeCount: Int64\? = nil/);
    assert.match(source, /TypraRuntime\.uint64\(value, field: "byteSize"\)/);
    assert.match(source, /TypraRuntime\.uint8\(value, field: "octet"\)/);
    assert.match(source, /TypraRuntime\.int64\(value, field: "safeCount"\)/);
    assert.doesNotMatch(source, /Uint64|Uint32|Safeint|NSNull/);
  });

  it("Go emits native integer types", () => {
    const source = emitGoFileContent(
      [sizedType()],
      "model",
      new GoExprVisitor(),
      new Set<string>(),
    );
    assert.match(source, /Tiny\s+int8\s/);
    assert.match(source, /Small\s+int16\s/);
    assert.match(source, /Octet\s+uint8\s/);
    assert.match(source, /Port\s+uint16\s/);
    assert.match(source, /DurationMs\s+\*uint32\s/);
    assert.match(source, /ByteSize\s+uint64\s/);
    assert.match(source, /SafeCount\s+\*int64\s/);
    assert.doesNotMatch(source, /\s+interface\{\}\s+`json/);
  });

  it("C# emits native integer types with checked conversions", () => {
    const type = sizedType();
    const source = emitCSharpClass(
      type,
      "Test",
      new CSharpExprVisitor(),
      [type],
      () => undefined,
    );
    assert.match(source, /public sbyte Tiny \{/);
    assert.match(source, /public short Small \{/);
    assert.match(source, /public byte Octet \{/);
    assert.match(source, /public ushort Port \{/);
    assert.match(source, /public uint\? DurationMs \{/);
    assert.match(source, /public ulong ByteSize \{/);
    assert.match(source, /public long\? SafeCount \{/);
    assert.match(source, /Convert\.ToUInt64\(/);
    assert.match(source, /Convert\.ToByte\(/);
    assert.doesNotMatch(source, /public object\??/);
  });

  it("Java widens to Integer/Long since it has no unsigned primitives", () => {
    const source = emitJavaFileContent(
      [sizedType()],
      "test",
      new JavaExprVisitor(),
      new Set(),
    );
    assert.match(source, /public Integer tiny = 0;/);
    assert.match(source, /public Integer small = 0;/);
    assert.match(source, /public Integer octet = 0;/);
    assert.match(source, /public Integer port = 0;/);
    assert.match(source, /public Long durationMs = null;/);
    assert.match(source, /public Long byteSize = 0L;/);
    assert.match(source, /public Long safeCount = null;/);
    assert.match(
      source,
      /result\.tiny = \(int\) LoadContext\.exactInteger\(map\.get\("tiny"\), -128L, 127L, "int8"\);/,
    );
    assert.match(
      source,
      /result\.octet = \(int\) LoadContext\.exactInteger\(map\.get\("octet"\), 0L, 255L, "uint8"\);/,
    );
    assert.match(
      source,
      /result\.durationMs = LoadContext\.exactInteger\(map\.get\("durationMs"\), 0L, 4294967295L, "uint32"\);/,
    );
    assert.match(
      source,
      /result\.byteSize = LoadContext\.exactInteger\(map\.get\("byteSize"\), 0L, Long\.MAX_VALUE, "uint64"\);/,
    );
    assert.doesNotMatch(source, /n\.(int|long)Value\(\)/);
    assert.doesNotMatch(source, /Uint64|Uint8|Safeint/);
  });

  it("Java LoadContext.exactInteger rejects fractional, boolean and out-of-range input", () => {
    const source = emitJavaContext("test");
    assert.match(
      source,
      /public static long exactInteger\(Object value, long min, long max, String kind\)/,
    );
    assert.match(source, /value instanceof Boolean/);
    assert.match(source, /value instanceof java\.math\.BigInteger b/);
    assert.match(source, /decimal\.toBigIntegerExact\(\)\.longValueExact\(\)/);
    assert.match(source, /if \(result < min \|\| result > max\)/);
    assert.match(source, /throw new IllegalArgumentException\(/);
  });

  it("Swift runtime matches native integer types before NSNumber bool detection", () => {
    const runtime = emitSwiftRuntime("TestModule");
    const int64Body = runtime.slice(
      runtime.indexOf("public static func int64("),
      runtime.indexOf("private static func exactInt64("),
    );
    const nativeIdx = int64Body.indexOf("nativeSigned(data)");
    const nsNumberIdx = int64Body.indexOf("data as? NSNumber");
    assert.ok(nativeIdx > 0 && nsNumberIdx > nativeIdx, int64Body);
    assert.ok(
      int64Body.indexOf("isNativeBool(data)") < nativeIdx,
      "native Bool must be rejected before native integers",
    );
    const uint64Body = runtime.slice(
      runtime.indexOf("public static func uint64("),
      runtime.indexOf("public static func int64("),
    );
    assert.ok(
      uint64Body.indexOf("nativeUnsigned(data)") <
        uint64Body.indexOf("data as? NSNumber"),
    );
    assert.match(runtime, /if dynamicType == Int8\.self \{ return Int64\(data as! Int8\) \}/);
    assert.match(runtime, /if dynamicType == UInt8\.self \{ return UInt64\(data as! UInt8\) \}/);
    assert.match(runtime, /return type\(of: data\) == Bool\.self/);
    assert.match(
      runtime,
      /#if canImport\(Darwin\)\n\s+return CFGetTypeID\(number as CFTypeRef\) == CFBooleanGetTypeID\(\)\n\s+#else/,
    );

    const codable = emitSwiftRuntime("TestModule", "codable");
    const encodeBody = codable.slice(
      codable.indexOf("var container = encoder.singleValueContainer()"),
    );
    assert.ok(
      encodeBody.indexOf("TypraRuntime.nativeSigned(value)") <
        encodeBody.indexOf("case let value as NSNumber:"),
      "native integers must be encoded before the NSNumber/bool branch",
    );
  });

  it("Python emits int", () => {
    const source = emitPythonFile(
      fileDecl(sizedType()),
      new PythonExprVisitor(),
    );
    assert.match(source, /tiny: int = field\(default=0\)/);
    assert.match(source, /byte_size: int = field\(default=0\)/);
    assert.match(source, /duration_ms: int \| None = None/);
    assert.doesNotMatch(source, /^\s+\w+: Any/m);
  });

  it("TypeScript emits number", () => {
    const source = emitTypeScriptFile(
      fileDecl(sizedType()),
      new TypeScriptExprVisitor(),
    );
    assert.match(source, /tiny: number = 0;/);
    assert.match(source, /byteSize: number = 0;/);
    assert.match(source, /durationMs\?: number/);
    assert.doesNotMatch(source, /: unknown/);
  });
});
