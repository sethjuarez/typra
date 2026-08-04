import "@typra/emitter";
import "./model/events/session.tsp";
import "./model/pipeline/harness.tsp";
import "./model/pipeline/canonical-ports.tsp";

namespace Typra.Fixtures;

model FixtureRoot {
  @sample(#{ name: "fixture-root" })
  @doc("Required scalar field")
  name: string;

  @sample(#{ description: "A generated fixture with broad emitter coverage." })
  @doc("Optional scalar field")
  description?: string;

  @sample(#{ tags: #["typespec", "emitter", "validation"] })
  @doc("Array of scalar tags")
  tags: string[];

  @sample(#{ metadata: #{ source: "fixture", version: 1 } })
  @doc("Dictionary-shaped metadata")
  metadata?: Record<unknown>;

  @sample(#{ owner: #{ id: "owner-1", displayName: "Fixture Owner" } })
  @doc("Nested object field")
  owner: FixtureOwner;

  @sample(#{ content: #{ kind: "text", text: "hello from a polymorphic sample" } })
  @doc("Discriminated union field")
  content: FixtureContent;

  @sample(#{ contentItems: #[#{ kind: "text", text: "hello from a polymorphic collection" }] })
  @doc("Array of discriminated union values")
  contentItems: FixtureContent[];

  @sample(#{ status: "ready" })
  @doc("Closed string union field")
  status: FixtureStatus;

  @sample(#{ mode: "batch" })
  @doc("Open string union field")
  mode?: FixtureMode;

  @doc("Ordered complex collection with non-unique names")
  checkpoint?: FixtureCheckpoint;
}

model FixtureOwner {
  @sample(#{ id: "owner-1" })
  id: string;

  @sample(#{ displayName: "Fixture Owner" })
  displayName?: string;
}

model FixtureToolRequest {
  @sample(#{ id: "call-a" })
  id: string;

  @sample(#{ name: "echo" })
  name: string;
}

model FixtureCheckpoint {
  @sample(#{ pendingToolRequests: #[#{ id: "call-a", name: "echo" }, #{ id: "call-b", name: "echo" }] })
  pendingToolRequests: FixtureToolRequest[];
}

@discriminator("kind")
model FixtureContent {
  kind: string;
}

model TextContent extends FixtureContent {
  kind: "text";

  @sample(#{ text: "hello from text content" })
  text: string;
}

model ImageContent extends FixtureContent {
  kind: "image";

  @sample(#{ url: "https://example.test/image.png" })
  url: string;
}

@abstract
@discriminator("kind")
model FixtureAbstractContent {
  kind: string;
}

model FixtureAbstractTextContent extends FixtureAbstractContent {
  kind: "text";
  text: string;
}

@parseAlias("ready", #["complete"])
union FixtureStatus {
  draft: "draft";
  ready: "ready";
  archived: "archived";
}

@parseAlias("batch", #["bulk"])
union FixtureMode {
  interactive: "interactive";
  batch: "batch";
  custom: string;
}

@@coerce(FixtureReference, string, #{ id: "{value}", label: "coerced reference" }, "reference", "Load a reference from an id string.", "ref-coerced");
@@factory(FixtureReference, "named", #{ id: "{id}", label: "{label}" }, #{ id: "string", label: "string" });
@@method(FixtureReference, "display", "string", "Render the reference label.", #{ prefix: "string" }, true, true);
model FixtureReference {
  @sample(#{ id: "ref-1" })
  id: string;

  @sample(#{ label: "Primary Reference" })
  label?: string;
}

@discriminator("kind")
model FixtureTool {
  kind: string;

  @sample(#{ name: "search" })
  name: string;

  description?: string;

  bindings?: Record<FixtureBinding> | Named<FixtureBinding>[];

}

model FixtureBinding {
  name?: string;
  source: string;
}

@@coerce(FixtureBinding, string, #{ source: "{value}" }, "binding", "Load a binding from shorthand.", "input");

model FixtureBindingTool {
  kind: "function";

  name: string;

  description?: string;

  @sample(#{ command: "search --query" })
  command: string;

  bindings?: Record<FixtureBinding> | Named<FixtureBinding>[];
}

model FixtureFunctionTool extends FixtureTool {
  kind: "function";

  @sample(#{ command: "search --query" })
  command: string;
}

model FixturePromptTool extends FixtureTool {
  kind: "prompt";
  prompt: string;
}

model FixtureMcpTool extends FixtureTool {
  kind: "mcp";
  server: string;
}

model FixtureHttpTool extends FixtureTool {
  kind: "http";
  endpoint: string;
}

model FixtureCustomTool extends FixtureTool {
  kind: "custom";
  config?: Record<unknown>;
}

model FixtureToolbox {
  @sample(#{ tools: #[#{ kind: "function", name: "search", command: "search --query" }] })
  tools: Record<FixtureTool> | Named<FixtureTool>[];

  @sample(#{ bindingTools: #[#{ name: "binding-tool", kind: "function", command: "run", bindings: #[#{ name: "input", source: "customer.name" }] }] })
  bindingTools: FixtureBindingTool[];

  @sample(#{
    inheritedMapBindingTool: #{
      name: "map-binding-tool",
      kind: "function",
      command: "run",
      bindings: #{ zebra: "customer.id", alpha: "customer.name" }
    }
  })
  inheritedMapBindingTool: FixtureTool;

  @sample(#{
    inheritedListBindingTool: #{
      name: "list-binding-tool",
      kind: "function",
      command: "run",
      bindings: #[
        #{ name: "alpha", source: "customer.name" },
        #{ name: "zebra", source: "customer.id" }
      ]
    }
  })
  inheritedListBindingTool: FixtureTool;
}

model FixtureShortcut {
  @sample(#{ reference: "ref-shortcut" })
  reference: FixtureReference;
}

model FixtureInput {
  @sample(#{ name: "input" })
  name: string;

  @sample(#{ defaultValue: "fallback" })
  defaultValue?: unknown;
}

model FixtureInputSet {
  @sample(#{ inputs: #[#{ name: "input", defaultValue: "fallback" }] })
  inputs: FixtureInput[];
}

model FixtureStopOptions {
  @sample(#{ stopSequences: #["\n"] })
  stopSequences: string[];
}

model FixtureMultilineWhitespace {
  @sample(#{ value: "first line with trailing space \nsecond line\n" })
  @sample(#{ value: "first line with two spaces  \n\n  \nlast line with three spaces   \n" })
  value: string;
}

model FixturePromptyWhitespace {
  @sample(#{ value: "system:\nYou are helpful.\n\nKeep this space \nPreserve ordinary lines.\nKeep this too \nuser:{{question}}" })
  value: string;
}

// Keyed property-bag regression (prompty's `inputs`/`outputs`/`parameters` shape): a field
// typed as the union `Record<T> | Named<T>[]` whose CANONICAL wire form is a MAP keyed by
// the element `name`. This exercises the `Record<T> | Named<T>[]` union-alias lowering
// (previously untested) and generates the dual-form (map|array) load + name-keyed save.
// The Rust serde roundtrip test additionally synthesizes the MAP-form input and asserts it
// deserializes — the exact case that fails under a plain `#[derive(serde::Deserialize)]` on
// a `Vec<FixtureBagItem>` field with "invalid type: map, expected a sequence".
model Named<T> {
  ...T;
}

model FixtureBagItem {
  @sample(#{ name: "alpha" })
  name: string;

  @sample(#{ note: "first" })
  note?: string;
}

@@coerce(FixtureBagItem, string, #{ note: "{value}" }, "item", "Load a named bag item from shorthand.", "first");

// Two same-element keyed collections in ONE model — the exact prompty `inputs`/`outputs`
// shape (both typed `Record<Property>|Named<Property>[]`). Because resolveModel visits each
// element type once, the SECOND same-element collection's `prop.type` (the injected-`name`
// wrapper) is left unresolved, so keyed-collection codegen must be tracked structurally or
// the 2nd field silently degrades to array-only save/load (map-form input → empty, DATA
// LOSS). `secondItems` proves both fields emit identical name-keyed MAP save + dual-form load.
model FixtureBag {
  @sample(#{ items: #[#{ name: "alpha", note: "first" }] })
  items: Record<FixtureBagItem> | Named<FixtureBagItem>[];

  @sample(#{ secondItems: #[#{ name: "beta", note: "second" }] })
  secondItems: Record<FixtureBagItem> | Named<FixtureBagItem>[];
}

// Empty-omission regression: a FLAT struct whose optional fields are intentionally
// left UNSET in the sample. Its canonical to_value/load_from_value wire OMITS unset
// optionals, so `{ "label": "present" }` round-trips byte-identically. A plain
// `#[derive(serde::Serialize)]` would instead emit `"note": null` / `"extras": null`
// (Option::None → null, empty Vec → []), diverging from canonical — which is exactly
// why every data struct must route serde through to_value/load_from_value, not a derive.
model FixtureOmit {
  @sample(#{ label: "present" })
  @doc("Required scalar; the optional fields below are deliberately unset in the sample.")
  label: string;

  @doc("Optional scalar left unset → canonical wire omits it (a plain derive would emit null).")
  note?: string;

  @doc("Optional scalar collection left unset → canonical wire omits it (a plain derive would emit []).")
  extras?: string[];

  @doc("Optional model collection left unset → generated constructors and loaders preserve undefined.")
  owners?: FixtureOwner[];
}

model FixtureOptionalDefaults {
  mode?: string = "auto";
}

@error
model FixtureInvokerError {
  message: string;
  component: string;
  key: string;
}

// Prompty-like Swift generated-test regressions:
// - optional collections must be unwrapped before assertions,
// - polymorphic roots must be pattern-matched before payload access,
// - compound coercion fields must validate their typed nested value.
model ModelInfo {
  @sample(#{ inputModalities: #["text"] })
  inputModalities?: string[];

  @sample(#{ outputModalities: #[] })
  outputModalities?: string[] = #[];

  @sample(#{ owner: #{ id: "owner-1", displayName: "Fixture Owner" } })
  owner?: FixtureOwner;

  owners?: FixtureOwner[];

  defaultOwners?: FixtureOwner[] = #[];
}

@discriminator("kind")
model FixtureConnection {
  @sample(#{ kind: "custom", endpoint: "https://example.test" })
  kind: string;
}

model FixtureCustomConnection extends FixtureConnection {
  kind: "custom";
  endpoint: string;
}

@@coerce(McpApprovalConfig, string, #{ kind: "{value}" }, "config", "Load an approval config from its kind.", "always");
model McpApprovalConfig {
  kind: string;
}

model McpApprovalMode {
  @sample(#{ config: "always" })
  config: McpApprovalConfig;
}

@@coerce(FixtureProperty, string, #{ kind: "string", default: "{value}" }, "property", "Load a string property from its default value.", "hello");
@@coerce(FixtureProperty, boolean, #{ kind: "boolean", default: "{value}" }, "property", "Load a boolean property from its default value.", true);
@@coerce(FixtureProperty, int32, #{ kind: "integer", default: "{value}" }, "property", "Load an integer property from its default value.", 7);
@@coerce(FixtureProperty, float32, #{ kind: "number", default: "{value}" }, "property", "Load a number property from its default value.", 3.5);
@discriminator("kind")
model FixtureProperty {
  kind: string;

  name?: string;

  description?: string;

  required?: boolean;

  nullable?: boolean;

  default?: unknown;

  example?: unknown;

  enumValues?: unknown[];
}

model FixtureStringProperty extends FixtureProperty {
  kind: "string";
}

model FixtureBooleanProperty extends FixtureProperty {
  kind: "boolean";
}

model FixtureIntegerProperty extends FixtureProperty {
  kind: "integer";
}

model FixtureNumberProperty extends FixtureProperty {
  kind: "number";
}

model FixtureArrayProperty extends FixtureProperty {
  kind: "array";

  @sample(#{ items: #{ kind: "string", name: "item", required: true } })
  items: FixtureProperty;
}

model FixtureObjectProperty extends FixtureProperty {
  kind: "object";

  @sample(#{ additionalProperties: #{ kind: "string", description: "Object value" } })
  additionalProperties: FixtureProperty;
}

model FixtureUnionProperty extends FixtureProperty {
  kind: "union";

  @sample(#{ anyOf: #[#{ kind: "string", name: "value", nullable: true }, #{ kind: "boolean", enumValues: #[true, false] }] })
  anyOf: FixtureProperty[];
}

@@knownAs(WireOptions.maxOutputTokens, "openai", "max_completion_tokens");
@@knownAs(WireOptions.maxOutputTokens, "anthropic", "max_tokens");
@@knownAs(WireOptions.temperature, "openai", "temperature");
@@defaultFor(WireOptions.temperature, "openai", 0.2);
model WireOptions {
  @sample(#{ maxOutputTokens: 256 })
  maxOutputTokens?: int32;

  @sample(#{ temperature: 0.7 })
  temperature?: float32;
}
