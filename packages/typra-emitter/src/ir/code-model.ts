import type {
  CallableVectorSnapshot,
  CallableVectorSnapshotEntry,
} from "./vector.js";
import { scalarRuntimeKind } from "./scalar-kinds.js";

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
    const expectedRoundTrip =
      "expected" in entry.vector && isCodeModelType(entry.returns, loadSaveTypes)
        ? entry.returns
        : undefined;
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
