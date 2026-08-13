import "@typra/emitter";

namespace Typra.Fixtures.Features.Enums;

model Root {
  status: Status;
  mode: Mode;
}

@parseAlias("ready", #["complete", "done"])
union Status {
  draft: "draft";
  ready: "ready";
  archived: "archived";
}

union Mode {
  automatic: "automatic";
  manual: "manual";
  string;
}
