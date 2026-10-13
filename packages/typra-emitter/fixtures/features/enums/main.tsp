import "@typra/emitter";

namespace Typra.Fixtures.Features.Enums;

model Root {
  plan: MotionPlan;
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

union MotionPlanKind {
  subtlePush: "subtle_push";
  wideHoldThenPush: "wide_hold_then_push";
}

@serializable
model MotionPlan {
  kind: MotionPlanKind = MotionPlanKind.subtlePush;
}

