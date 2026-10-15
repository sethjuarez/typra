import "@typra/emitter";

namespace Typra.Fixtures.Features.DispatchWildcardCollision;

union Kind {
  known: "wild-card",
  string,
}

@discriminator("kind")
model Config {
  kind: Kind = "*";
}

model KnownConfig extends Config {
  kind: "wild-card";
}

model WildcardConfig extends Config {
  kind: "*";
}

@dispatch(Config.kind)
interface Router {
  route(config: Config): string;
}

@serializable
model Root {
  config: Config;
}
