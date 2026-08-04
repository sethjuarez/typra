import { TypeDecl, WireDecl } from "./declarations.js";

function mergeInheritedByKey<T>(groups: T[][], key: (item: T) => string): T[] {
  const order: string[] = [];
  const chosen = new Map<string, T>();
  for (const group of groups) {
    for (const item of group) {
      const itemKey = key(item);
      if (!chosen.has(itemKey)) order.push(itemKey);
      chosen.set(itemKey, item);
    }
  }
  return order.map(itemKey => chosen.get(itemKey)!);
}

/**
 * Flatten transitive base members into targets that represent derived models by value.
 * Derived declarations override inherited members with the same name while retaining
 * the ancestor-defined field order.
 */
export function flattenInheritance(types: TypeDecl[]): TypeDecl[] {
  const byName = new Map(types.map(type => [type.typeName.name, type]));

  function ancestorChain(type: TypeDecl): TypeDecl[] {
    const chain: TypeDecl[] = [];
    const visited = new Set<string>([type.typeName.name]);
    let current = type.base ? byName.get(type.base.name) : undefined;
    while (current && !visited.has(current.typeName.name)) {
      visited.add(current.typeName.name);
      chain.unshift(current);
      current = current.base ? byName.get(current.base.name) : undefined;
    }
    return chain;
  }

  return types.map(type => {
    if (!type.base) return type;
    const ancestors = ancestorChain(type);
    if (ancestors.length === 0) return type;

    const fields = mergeInheritedByKey(
      [...ancestors.map(ancestor => ancestor.fields), type.fields],
      field => field.name,
    );
    const loadAssignments = mergeInheritedByKey(
      [...ancestors.map(ancestor => ancestor.load.assignments), type.load.assignments],
      assignment => assignment.fieldName,
    );
    const saveAssignments = mergeInheritedByKey(
      [...ancestors.map(ancestor => ancestor.save.assignments), type.save.assignments],
      assignment => assignment.fieldName,
    );
    const wireSources = [...ancestors.map(ancestor => ancestor.wire), type.wire]
      .filter((wire): wire is WireDecl => wire !== null);
    const wire = wireSources.length === 0
      ? null
      : {
        providers: Array.from(new Set(wireSources.flatMap(source => source.providers))),
        mappings: mergeInheritedByKey(
          wireSources.map(source => source.mappings),
          mapping => mapping.fieldName,
        ),
      };

    return {
      ...type,
      fields,
      load: { ...type.load, assignments: loadAssignments },
      save: { ...type.save, assignments: saveAssignments },
      wire,
    };
  });
}
