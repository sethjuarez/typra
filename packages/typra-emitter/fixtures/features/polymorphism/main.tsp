import "@typra/emitter";

namespace Typra.Fixtures.Features.Polymorphism;

model Root {
  closed: ClosedContent;
  open: OpenConnection;
  custom: NamedOpenConnection;
}

@discriminator("kind")
model ClosedContent {
  kind: ClosedContentKind;
}

union ClosedContentKind {
  text: "text";
  image: "image";
}

model TextContent extends ClosedContent {
  kind: "text";
  value: string;
}

model ImageContent extends ClosedContent {
  kind: "image";
  url: string;
}

@abstract
@discriminator("kind")
model OpenConnection {
  kind: string;
  label?: string;
}

model ManagedConnection extends OpenConnection {
  kind: "managed";
  resourceId: string;
}

@abstract
@discriminator("kind")
model NamedOpenConnection {
  kind: string;
  name: string;
}

model NamedManagedConnection extends NamedOpenConnection {
  kind: "managed";
  resourceId: string;
}
