import "@typra/emitter";

namespace Typra.Fixtures.Features.Defaults;

model Root {
  defaults: DefaultsModel;
  requiredReference: RequiredReferenceContainer;
}

model DefaultsModel {
  requiredText: string;
  optionalText?: string;
  optionalItems?: string[];
  enabled: boolean = true;
  retries: int32 = 2;
  ratio: float64 = 0.5;
}

model RequiredReferenceContainer {
  @sample(#{ label: "container" })
  label: string;
  detail: RequiredDetail;
}

model RequiredDetail {
  @sample(#{ code: "detail-code" })
  code: string;
}
