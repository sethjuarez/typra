import "@typra/emitter";

namespace Typra.Fixtures.Features.Namespaces;

model Root {
  core: Core.Shared;
  nested: Domain.Nested.Value;
}

namespace Core {
  model Shared {
    id: string;
  }
}

namespace Domain.Nested {
  model Value {
    name: string;
    shared: Core.Shared;
  }
}
