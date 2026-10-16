import "@typra/emitter";

namespace Typra.Fixtures.Features.Defaults;

model Root {
  defaults: DefaultsModel;
  requiredReference: RequiredReferenceContainer;
}

@factory("literals", #{ requiredText: "lit", largeExponent: 1e300, wideSingle: 1e30, halfSingle: 0.25, tinySingle: 1e-50, singles: #[0.5, 2] })
model DefaultsModel {
  requiredText: string;
  optionalText?: string;
  optionalItems?: string[];
  enabled: boolean = true;
  retries: int32 = 2;
  ratio: float64 = 0.5;
  largeExponent: float64 = 1e300;
  tinyExponent: float64 = 1e-300;
  negativeExponent: float64 = -1e300;
  hugeWhole: float64 = 123456789012345680000;
  wideSingle: float32 = 1e30;
  halfSingle: float32 = 0.5;
  tinySingle: float32 = 1e-50;
  singles?: float32[];
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
