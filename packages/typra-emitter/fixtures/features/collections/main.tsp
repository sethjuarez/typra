import "@typra/emitter";
using TypeSpec.Reflection;

namespace Typra.Fixtures.Features.Collections;

model Named<T> {
  name: string;
  ...T;
}

model Root {
  scalarList: string[];
  objectList: CollectionItem[];
  unknownMap: Record<unknown>;
  objectMap: Record<CollectionItem>;
  dualForm: Record<NamedCollectionItem> | Named<NamedCollectionItem>[];
}

model CollectionItem {
  name: string;
  value: string;
}

model NamedCollectionItem {
  value: string;
}
