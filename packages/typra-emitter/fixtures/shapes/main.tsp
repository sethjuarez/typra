import "@typra/emitter";

namespace Typra.Fixtures;

model FixtureRoot {
  @doc("Required scalar field")
  name: string;

  @doc("Optional scalar field")
  description?: string;

  @doc("Array of scalar tags")
  tags: string[];

  @doc("Dictionary-shaped metadata")
  metadata?: Record<unknown>;

  @doc("Nested object field")
  owner: FixtureOwner;

  @doc("Discriminated union field")
  content: FixtureContent;
}

model FixtureOwner {
  id: string;
  displayName?: string;
}

@discriminator("kind")
model FixtureContent {
  kind: string;
}

model TextContent extends FixtureContent {
  kind: "text";
  text: string;
}

model ImageContent extends FixtureContent {
  kind: "image";
  url: string;
}
