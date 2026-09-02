import "@typra/emitter";

namespace Typra.Fixtures.RustUnknown;

@serializable
model Root {
  connection: Connection;
}

@abstract
@discriminator("kind")
model Connection {
  kind: string;
  name?: string;
}

model ReferenceConnection extends Connection {
  kind: "reference";
  id: string;
}
