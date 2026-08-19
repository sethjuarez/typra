import { fail, generatedRoot, path, readFileSync } from "./harness.mjs";
import {
  buildPropertyCorpus,
  formatPropertyCaseFailure,
  parsePropertySeed,
} from "../property-corpus.mjs";

export const fixtureRootSample = {
  name: "fixture-root",
  description: "A generated fixture with broad emitter coverage.",
  tags: ["typespec", "emitter", "validation"],
  metadata: {
    source: "fixture",
    version: 1,
  },
  typedRecords: {
    counts: {
      alpha: 1,
      beta: 2,
    },
    owners: {
      primary: {
        id: "owner-typed-1",
        displayName: "Typed Owner",
      },
    },
  },
  owner: {
    id: "owner-1",
    displayName: "Fixture Owner",
  },
  content: {
    kind: "text",
    value: "hello from a polymorphic sample",
  },
  contentItems: [
    {
      kind: "text",
      value: "hello from a polymorphic collection",
    },
  ],
  status: "complete",
  mode: "bulk",
  zeroValues: {
    emptyText: "",
    zeroCount: 0,
    zeroRatio: 0,
    falseFlag: false,
    emptyItems: [],
  },
  // absentText is deliberately omitted: an absent optional must stay off the wire, while the
  // explicitly-zero optionals below must stay on it. See FixtureOptionalStates in main.tsp.
  optionalStates: {
    presentText: "present",
    emptyText: "",
    zeroCount: 0,
    falseFlag: false,
    emptyItems: [],
  },
  // int32 extremes plus an integral and a negative float. A mismatch that survives the 6dp
  // rounding in normalizeConformanceValue is genuine; a divergence below 5e-7 is not visible to
  // it, and narrowing to float32 is not covered. See FixtureNumericBounds in main.tsp.
  numericBounds: {
    int32Min: -2147483648,
    int32Max: 2147483647,
    negativeCount: -42,
    wholeRatio: 2,
    preciseRatio: -0.125,
  },
  // Characters a serializer must escape or encode rather than copy. TAB is the sharpest: RFC 8259
  // forbids an unescaped character below U+0020, so a writer that copies it emits a document that
  // is not JSON. See FixtureAdversarialText in main.tsp for what this case does and does not cover.
  adversarialText: {
    tabbed: "column\tseparated",
    multiline: "first line\nsecond line",
    quoted: 'she said "hello" once',
    backslashed: 'back\\slash and \\"escaped\\" text',
    unicodeText: "café — naïve ✓",
    astralText: "emoji 🙂 tail",
    paddedText: "  padded  ",
  },
  // Discriminator values no subtype claims outright. wildcardSelected is the shape behind the
  // original missing-required-field defect: connection is a required complex field on a subtype
  // whose discriminator is a wildcard. See FixtureDiscriminatorEdges in main.tsp.
  discriminatorEdges: {
    wildcardSelected: {
      kind: "vendor-extension",
      name: "wildcard-selected tool",
      connection: { kind: "custom", endpoint: "https://example.test" },
      config: { enabled: true },
    },
    openUnknown: {
      kind: "vendor-unrecognized",
      label: "absorbed by the open base",
    },
    unclaimedClosed: { kind: "plain", label: "permitted but unclaimed" },
    namedOpenUnknown: {
      kind: "vendor-specific",
      label: "unrecognized named open kind",
    },
  },
  // Collections at zero, one and many. The keyed dual-form fields accept either a list of named
  // items or a map keyed by name; given unique, non-empty names both forms canonicalize to the
  // same map-shaped saved output. Array order is compared; key order within the saved keyed map
  // is not, because the normalizer sorts object keys. See FixtureCollectionCardinality in main.tsp.
  collectionCardinality: {
    repeatedTags: ["alpha", "beta", "alpha"],
    singleTag: ["only"],
    mixedContent: [
      { kind: "image", url: "https://example.test/first.png" },
      { kind: "text", value: "second element" },
      { kind: "text", value: "third element" },
    ],
    listForm: [
      { name: "alpha", first: "alpha first", second: "alpha second" },
      { name: "beta", first: "beta first", second: "beta second" },
    ],
    mapForm: {
      epsilon: { first: "epsilon first", second: "epsilon second" },
      delta: { first: "delta first", second: "delta second" },
    },
    singleListForm: [
      { name: "solo", first: "solo first", second: "solo second" },
    ],
    singleMapForm: {
      lone: { first: "lone first", second: "lone second" },
    },
    emptyForm: [],
  },
  // Polymorphic dispatch chained several levels deep. propertyTree nests
  // object -> array -> union -> object -> integer, so five dispatch decisions are chained with a
  // collection in the middle; branchTrees varies recursion depth between elements of one
  // collection. Every value is written as a full kind-tagged object so that scalar coercion into
  // FixtureProperty stays out of this class. See FixtureDeepNesting in main.tsp.
  deepNesting: {
    propertyTree: {
      kind: "object",
      name: "tree-root",
      description: "root of the nested tree",
      additionalProperties: {
        kind: "array",
        name: "level-one-array",
        items: {
          kind: "union",
          name: "level-two-union",
          anyOf: [
            { kind: "string", name: "level-three-string", required: true },
            {
              kind: "object",
              name: "level-three-object",
              additionalProperties: {
                kind: "integer",
                name: "level-four-integer",
                nullable: true,
              },
            },
          ],
        },
      },
    },
    branchTrees: [
      { kind: "string", name: "shallow-leaf" },
      {
        kind: "array",
        name: "one-deep",
        items: { kind: "boolean", name: "nested-boolean" },
      },
      {
        kind: "union",
        name: "two-deep",
        anyOf: [
          { kind: "number", name: "union-number" },
          {
            kind: "array",
            name: "union-array",
            items: { kind: "string", name: "deepest-string" },
          },
        ],
      },
    ],
  },
};

// One canonical conformance input, embedded into every target program.
//
// The seven conformance runners each used to hand-write this payload in their own target
// syntax. Nothing asserted those copies agreed, and they had already drifted -- the C# copy
// carried a `metadata.nullable` key no other target was given. Divergent inputs compared
// against a single shared expectation quietly weakens the oracle, because a target can pass
// on a payload its peers never saw. Every runner now parses this one document through its
// standard JSON entry point, so widening the corpus is a single edit to fixtureRootSample.
export const fixtureRootSampleJsonLiteral = JSON.stringify(
  JSON.stringify(fixtureRootSample),
);

// The C# runner previously smuggled an extra `metadata.nullable` key into its private copy of
// the payload to prove Record<unknown> preserves explicit nulls. That assertion is worth
// keeping, so it now runs against its own explicit variant rather than silently changing the
// shared input out from under the cross-language comparison.
export const fixtureRootNullMetadataJsonLiteral = JSON.stringify(
  JSON.stringify({
    ...fixtureRootSample,
    metadata: { ...fixtureRootSample.metadata, nullable: null },
  }),
);

export const wireOptionsSample = {
  maxOutputTokens: 256,
  temperature: 0.7,
};

export const imageContentSample = {
  kind: "image",
  url: "https://example.com/fixture.png",
};

export const fixtureRootExpected = {
  ...fixtureRootSample,
  status: "ready",
  mode: "batch",
  // A keyed collection is written in its map form regardless of which form it was read from, so
  // the list-form inputs converge on the shape the map-form inputs were given in, and the entry
  // name moves from the body to the key. That canonicalization holds because these names are
  // unique and non-empty; a duplicated or empty name would fall back to list form instead.
  collectionCardinality: {
    ...fixtureRootSample.collectionCardinality,
    listForm: {
      alpha: { first: "alpha first", second: "alpha second" },
      beta: { first: "beta first", second: "beta second" },
    },
    singleListForm: {
      solo: { first: "solo first", second: "solo second" },
    },
    emptyForm: {},
  },
};

export const PROPERTY_CORPUS_SEED = parsePropertySeed(
  process.env.TYPRA_PROPERTY_SEED,
);

export const PROPERTY_CORPUS_CASE_COUNT = Number.parseInt(
  process.env.TYPRA_PROPERTY_CASE_COUNT ?? "8",
  10,
);

export const propertyCorpus = buildFixtureRootPropertyCorpus();

export const propertyCorpusJsonLiteral = JSON.stringify(
  JSON.stringify(propertyCorpus),
);

export const conformancePropertyCases = propertyCorpus.map((entry) => ({
  id: entry.id,
  seed: entry.seed,
  caseId: entry.caseId,
  root: entry.input,
}));

export const conformanceCanonical = {
  root: fixtureRootExpected,
  propertyCases: conformancePropertyCases,
  imageContent: imageContentSample,
  openai: {
    max_completion_tokens: 256,
    temperature: 0.7,
  },
  anthropic: {
    max_tokens: 256,
  },
  // A provider with no @knownAs mapping at all must produce an empty payload, as must an empty
  // provider string. Emitting fields under their schema names for an unmapped or empty provider
  // is a defect (swift emitted for any unmapped provider; java emitted for the empty provider).
  unmapped: {},
  emptyProvider: {},
  reference: {
    id: "ref-coerced",
    label: "coerced reference",
  },
};

export const conformanceExpected =
  normalizeConformanceValue(conformanceCanonical);

// Known cross-language divergences: real, open defects that this corpus catches today.
//
// These are NOT accepted behaviour, and this is not a mute switch. Each entry pins the exact
// wrong output a target currently produces, which keeps the gate green on a tracked defect
// without going blind to it:
//   - if the target's output changes in any *other* way, the gate still fails;
//   - if the target starts matching canonical output, the gate fails and demands the entry be
//     deleted, so the suppression cannot outlive the bug it documents.
export const conformanceKnownDivergences = {};

export const executableConformanceTargets = [
  "typescript",
  "python",
  "python_pydantic",
  "csharp",
  "go",
  "java",
  "rust",
  "rust-serde",
  "swift",
  "swift-codable",
];

export const conformanceObservedOutputs = new Map();

export const conformanceSkippedTargets = new Map();

export function normalizeConformanceValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeConformanceValue(item));
  }
  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort((left, right) =>
      left.localeCompare(right),
    )) {
      normalized[key] = normalizeConformanceValue(value[key]);
    }
    return normalized;
  }
  if (typeof value === "number") {
    return Math.round(value * 1_000_000) / 1_000_000;
  }
  return value;
}

export function buildFixtureRootPropertyCorpus() {
  if (
    !Number.isSafeInteger(PROPERTY_CORPUS_CASE_COUNT) ||
    PROPERTY_CORPUS_CASE_COUNT < 1
  ) {
    throw new Error(
      `Invalid TYPRA_PROPERTY_CASE_COUNT: ${process.env.TYPRA_PROPERTY_CASE_COUNT}`,
    );
  }
  const modelPath = path.join(generatedRoot, "json-ast", "model.json");
  const model = JSON.parse(readFileSync(modelPath, "utf8"));
  const corpus = buildPropertyCorpus(model, {
    rootType: "FixtureRoot",
    seed: PROPERTY_CORPUS_SEED,
    caseCount: PROPERTY_CORPUS_CASE_COUNT,
    maxDepth: 5,
    onlyCase: process.env.TYPRA_PROPERTY_CASE,
  });
  if (corpus.length === 0) {
    throw new Error(
      `TYPRA_PROPERTY_CASE did not match any generated property corpus case: ${process.env.TYPRA_PROPERTY_CASE}`,
    );
  }
  return corpus;
}

export function assertConformanceResult(target, rawOutput) {
  let actual;
  try {
    actual = normalizeConformanceValue(JSON.parse(rawOutput));
  } catch (error) {
    const lastLine = rawOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    try {
      actual = normalizeConformanceValue(JSON.parse(lastLine ?? ""));
    } catch {
      fail(
        `Executable conformance for ${target} did not emit valid JSON: ${error.message}\n${rawOutput}`,
      );
      return;
    }
  }

  const actualJson = JSON.stringify(actual);
  const divergence = conformanceKnownDivergences[target];
  conformanceObservedOutputs.set(target, actual);

  if (actualJson === JSON.stringify(conformanceExpected)) {
    if (divergence) {
      fail(
        `Executable conformance for ${target} now matches canonical output, but a known divergence ` +
          `is still recorded for ${divergence.issue}. The defect appears fixed -- delete the ` +
          `conformanceKnownDivergences entry so the gate holds the corrected behaviour from now on.`,
      );
    }
    return;
  }

  if (divergence && actualJson === JSON.stringify(divergence.expected)) {
    console.warn(
      `[known divergence] ${target} conformance differs from canonical output as recorded in ` +
        `${divergence.issue}: ${divergence.summary}`,
    );
    return;
  }

  const propertyFailure = formatPropertyCaseFailure(
    conformanceExpected,
    actual,
  );
  fail(
    `Executable conformance for ${target} did not match canonical output.\nExpected: ${JSON.stringify(conformanceExpected)}\nActual: ${actualJson}` +
      (propertyFailure ? `\n${propertyFailure}` : ""),
  );
}

export function recordConformanceSkip(target, reason) {
  conformanceSkippedTargets.set(target, reason);
}

export function assertExecutableConformanceCoverage() {
  for (const target of executableConformanceTargets) {
    if (
      !conformanceObservedOutputs.has(target) &&
      !conformanceSkippedTargets.has(target)
    ) {
      fail(
        `Executable conformance did not run or record an explicit skip for ${target}.`,
      );
    }
  }
  for (const target of conformanceObservedOutputs.keys()) {
    if (!executableConformanceTargets.includes(target)) {
      fail(`Executable conformance recorded undeclared target: ${target}.`);
    }
  }
}

export function assertExecutableConformanceAgreement() {
  const expectedJson = JSON.stringify(conformanceExpected);
  for (const [target, output] of conformanceObservedOutputs) {
    if (conformanceKnownDivergences[target]) continue;
    const actualJson = JSON.stringify(output);
    if (actualJson !== expectedJson) {
      fail(
        `Executable conformance save-side oracle for ${target} no longer agrees with the canonical target output.`,
      );
    }
  }
}
