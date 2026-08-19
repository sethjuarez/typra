// Reference adapters for the integration fixture's @vector suite. Copied into
// each TypeScript target's tests/ dir by validate-fixtures before the generated
// conformance suite runs. See fixtures/integration/vector-adapters.
type ReferenceAdapter = {
  invoke: (input: unknown) => unknown;
};

export const vectorAdapters: Record<string, ReferenceAdapter> = {
  "CanonicalEnginePort.authorize": {
    invoke: () => ({ approved: true }),
  },
  "CanonicalEnginePort.format": {
    invoke: (input) => (input as { messages: unknown }).messages,
  },
};

export const vectorWaivers: Record<string, string> = {};
export const vectorDoubles: Record<string, unknown> = {};
