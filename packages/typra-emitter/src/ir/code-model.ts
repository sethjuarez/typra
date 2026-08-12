import type {
  CallableVectorSnapshot,
  CallableVectorSnapshotEntry,
} from "./vector.js";
import { scalarRuntimeKind } from "./scalar-kinds.js";
import type { TypeNode } from "./ast.js";

export interface CodeModelJsonConstant {
  name: string;
  value: unknown;
}

export interface VectorModelRoundTrip {
  paramName: string;
  typeName: string;
}

export interface VectorConformanceCase {
  index: number;
  contract: string;
  operation: string;
  vectorName?: string;
  paramRoundTrips: VectorModelRoundTrip[];
  expectedRoundTrip?: string;
}

export interface VectorConformanceCodeModel {
  fileName: string;
  vectors: CallableVectorSnapshotEntry[];
  constants: CodeModelJsonConstant[];
  modelImports: string[];
  cases: VectorConformanceCase[];
}

export interface VectorConformanceCodeModelOptions {
  loadSaveTypes?: ReadonlySet<string> | readonly string[];
  typeNodes?: readonly TypeNode[];
}

export function buildVectorConformanceCodeModel(
  snapshot: CallableVectorSnapshot,
  options: VectorConformanceCodeModelOptions = {},
): VectorConformanceCodeModel {
  const loadSaveTypes = options.loadSaveTypes
    ? new Set(options.loadSaveTypes)
    : undefined;
  const imports = new Set<string>();
  const cases = snapshot.vectors.map((entry, index) => {
    const paramRoundTrips = Object.entries(entry.params)
      .filter(([, typeName]) => isCodeModelType(typeName, loadSaveTypes))
      .map(([paramName, typeName]) => {
        imports.add(typeName);
        return { paramName, typeName };
      });
    const expectedRoundTrip = expectedRoundTripType(entry, loadSaveTypes, options.typeNodes);
    if (expectedRoundTrip) imports.add(expectedRoundTrip);

    return {
      index,
      contract: entry.contract,
      operation: entry.operation,
      vectorName: entry.vector.name,
      paramRoundTrips,
      expectedRoundTrip,
    };
  });

  return {
    fileName: "vector-conformance",
    vectors: snapshot.vectors,
    constants: [{ name: "vectors", value: snapshot.vectors }],
    modelImports: Array.from(imports).sort(),
    cases,
  };
}

function expectedRoundTripType(
  entry: CallableVectorSnapshotEntry,
  loadSaveTypes: ReadonlySet<string> | undefined,
  typeNodes: readonly TypeNode[] | undefined,
): string | undefined {
  if (!("expected" in entry.vector) || !isCodeModelType(entry.returns, loadSaveTypes)) {
    return undefined;
  }
  if (entry.vector.stage !== "transport") return entry.returns;

  const envelopeBodyType = findBodyEnvelopeType(entry.returns, typeNodes);
  if (!envelopeBodyType) return entry.returns;
  return isCodeModelType(envelopeBodyType, loadSaveTypes) ? envelopeBodyType : undefined;
}

function findBodyEnvelopeType(
  typeName: string,
  typeNodes: readonly TypeNode[] | undefined,
): string | undefined {
  const node = typeNodes?.find((candidate) => candidate.typeName.name === typeName);
  if (!node || node.properties.length !== 1) return undefined;
  const [property] = node.properties;
  if (property.name !== "body") return undefined;
  return property.typeName.name;
}

function isCodeModelType(
  typeName: string,
  loadSaveTypes: ReadonlySet<string> | undefined,
): boolean {
  if (loadSaveTypes) {
    return loadSaveTypes.has(typeName);
  }
  if (
    typeName === "void" ||
    typeName === "unknown" ||
    typeName === "any" ||
    typeName === "dictionary" ||
    typeName.startsWith("Record<") ||
    typeName.endsWith("[]")
  ) {
    return false;
  }
  return scalarRuntimeKind(typeName) === null;
}
