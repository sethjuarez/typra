import "@typra/emitter";

namespace Typra.Fixtures.Features.ModelShapes;

model Root {
  required: RequiredAndOptional;
  records: RecordShapes;
  named: NamedReference;
}

model RequiredAndOptional {
  requiredText: string;
  optionalText?: string;
  defaultedText: string = "default";
  defaultedCount: int32 = 1;
}

model RecordShapes {
  unknownValues: Record<unknown>;
  typedValues: Record<NamedReference>;
}

model NamedReference {
  name: string;
  label?: string;
}
