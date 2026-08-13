import "@typra/emitter";
using TypeSpec.Reflection;

namespace Typra.Fixtures.Features.Coercions;

model Named<T> {
  name: string;
  ...T;
}

model Root {
  reference: Reference;
  stringProperty: Property;
  booleanProperty: Property;
  integerProperty: Property;
  numberProperty: Property;
  bag: PropertyBag;
}

@@coerce(Reference, string, #{ id: "{value}", label: "coerced reference" }, "reference", "Load a reference from an id string.", "ref-1");
@@factory(Reference, "named", #{ id: "{id}", label: "{label}" }, #{ id: "string", label: "string" });
@@method(Reference, "display", "string", "Render the reference label.", #{ prefix: "string" }, true, true);
model Reference {
  id: string;
  label?: string;
}

@@coerce(Property, string, #{ kind: "string", defaultValue: "{value}" }, "property", "Load a string property from its default value.", "hello");
@@coerce(Property, boolean, #{ kind: "boolean", defaultValue: "{value}" }, "property", "Load a boolean property from its default value.", true);
@@coerce(Property, int32, #{ kind: "integer", defaultValue: "{value}" }, "property", "Load an integer property from its default value.", 7);
@@coerce(Property, float32, #{ kind: "number", defaultValue: "{value}" }, "property", "Load a number property from its default value.", 3.5);
@entryShorthand("defaultValue")
@discriminator("kind")
model Property {
  kind: string;
  defaultValue?: unknown;
}

model PropertyBag {
  entries: Record<Property> | Named<Property>[];
}
