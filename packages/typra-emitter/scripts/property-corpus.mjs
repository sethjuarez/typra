const DEFAULT_SEED = 0x117;
const DEFAULT_CASE_COUNT = 8;
const DEFAULT_MAX_DEPTH = 5;

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function asHex(seed) {
  return `0x${(seed >>> 0).toString(16)}`;
}

export function parsePropertySeed(value, fallback = DEFAULT_SEED) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 0);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid property corpus seed: ${value}`);
  }
  return parsed >>> 0;
}

function walkTypes(node, byName, visited = new Set()) {
  if (!node || typeof node !== "object") return;
  const name = node.typeName?.name;
  const namespace = node.typeName?.namespace ?? "";
  const key = `${namespace}.${name}`;
  if (name) {
    if (visited.has(key)) return;
    visited.add(key);
    const existing = byName.get(name);
    const nodeScore =
      (node.childTypes?.length ?? 0) * 100 + (node.properties?.length ?? 0);
    const existingScore = existing
      ? (existing.childTypes?.length ?? 0) * 100 +
        (existing.properties?.length ?? 0)
      : -1;
    if (!existing || nodeScore > existingScore) byName.set(name, node);
  }
  for (const prop of node.properties ?? []) {
    walkTypes(prop.type, byName, visited);
  }
  for (const child of node.childTypes ?? []) {
    walkTypes(child, byName, visited);
  }
}

function buildTypeRegistry(modelJson) {
  const byName = new Map();
  const candidates = Array.isArray(modelJson)
    ? modelJson
    : Array.isArray(modelJson?.types)
      ? modelJson.types
      : Array.isArray(modelJson?.nodes)
        ? modelJson.nodes
        : [modelJson];
  for (const candidate of candidates) {
    walkTypes(candidate, byName);
  }
  return byName;
}

function choose(state, values, salt) {
  if (values.length === 0) return undefined;
  const index =
    Math.floor(state.random() * values.length + stableHash(salt)) %
    values.length;
  return values[index];
}

function discriminatorLiteral(type, discriminator) {
  const prop = type.properties?.find(
    (candidate) => candidate.name === discriminator,
  );
  return typeof prop?.defaultValue === "string" && prop.defaultValue !== "null"
    ? prop.defaultValue
    : undefined;
}

function propertyDefault(prop) {
  return prop.defaultValue !== undefined &&
    prop.defaultValue !== null &&
    prop.defaultValue !== "null"
    ? prop.defaultValue
    : undefined;
}

function scalarValue(typeName, state, path) {
  const salt = stableHash(`${state.seed}:${state.caseIndex}:${path}`);
  switch (typeName) {
    case "bytes":
      return `Y2FzZS0${state.caseIndex}`;
    case "plainDate":
      return `2026-08-${String((salt % 20) + 1).padStart(2, "0")}`;
    case "plainTime":
      return `${String(salt % 24).padStart(2, "0")}:00:00`;
    case "utcDateTime":
      return `2026-08-${String((salt % 20) + 1).padStart(2, "0")}T00:00:00Z`;
    case "offsetDateTime":
      return `2026-08-${String((salt % 20) + 1).padStart(2, "0")}T00:00:00+00:00`;
    case "duration":
      return `P${(salt % 5) + 1}D`;
    case "url":
      return `https://example.test/property/${state.caseIndex}/${salt % 997}`;
    case "uuid":
      return `00000000-0000-4000-8000-${String(salt % 1000000000000).padStart(12, "0")}`;
    case "boolean":
      return salt % 2 === 0;
    case "int8":
    case "int16":
    case "int32":
    case "int64":
    case "integer":
    case "safeint":
    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
      return (salt % 17) + 1;
    case "float":
    case "float32":
    case "float64":
    case "number":
    case "numeric":
    case "decimal":
    case "decimal128":
      return (salt % 17) + 1 + 0.25;
    case "string":
    default:
      return `property-${state.caseIndex}-${path.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  }
}

function unknownValue(state, path) {
  switch (stableHash(`${state.seed}:${state.caseIndex}:${path}`) % 5) {
    case 0:
      return `unknown-${state.caseIndex}`;
    case 1:
      return state.caseIndex + 1;
    case 2:
      return state.caseIndex % 2 === 0;
    case 3:
      return [`entry-${state.caseIndex}`, null];
    default:
      return { nested: `value-${state.caseIndex}` };
  }
}

function generateDictValue(prop, state, path) {
  const valueType = prop.dictValueType;
  if (!valueType || valueType === "unknown") return unknownValue(state, path);
  const target = state.types.get(valueType);
  if (target) return generateType(target, state, path);
  return scalarValue(valueType, state, path);
}

function richerType(left, right) {
  if (!left) return right;
  if (!right) return left;
  const leftScore =
    (left.childTypes?.length ?? 0) * 100 + (left.properties?.length ?? 0);
  const rightScore =
    (right.childTypes?.length ?? 0) * 100 + (right.properties?.length ?? 0);
  return rightScore > leftScore ? right : left;
}

function resolveTargetType(prop, state) {
  return richerType(prop.type, state.types.get(prop.typeName?.name));
}

function generatePropertyValue(prop, state, path) {
  const explicit = propertyDefault(prop);
  if (explicit !== undefined) return explicit;
  if ((prop.allowedValues ?? []).length > 0) {
    if (prop.isOpenEnum && state.random() < 0.25) {
      return `custom-${state.caseIndex}-${stableHash(path) % 997}`;
    }
    return choose(state, prop.allowedValues, path);
  }
  if (prop.isAny)
    return prop.isCollection
      ? [unknownValue(state, `${path}[0]`)]
      : unknownValue(state, path);
  if (prop.isDict) {
    const entryCount = prop.isCollection ? 1 : 2;
    const value = {};
    for (let index = 0; index < entryCount; index += 1) {
      value[`key${index}_${state.caseIndex}`] = generateDictValue(
        prop,
        state,
        `${path}.${index}`,
      );
    }
    return prop.isCollection ? [value] : value;
  }
  if (prop.isScalar) {
    const value = scalarValue(prop.typeName?.name, state, path);
    if (!prop.isCollection) return value;
    return [value, scalarValue(prop.typeName?.name, state, `${path}[1]`)];
  }

  const target = resolveTargetType(prop, state);
  if (!target) return undefined;
  if (!prop.isCollection) return generateType(target, state, path);

  if (state.depth >= state.maxDepth) return [];
  if (prop.isNamedCollection) {
    const first = generateType(target, state, `${path}.entry0`);
    const second = generateType(target, state, `${path}.entry1`);
    if (first === undefined || second === undefined) return {};
    if (first && typeof first === "object" && !Array.isArray(first))
      delete first.name;
    if (second && typeof second === "object" && !Array.isArray(second))
      delete second.name;
    return {
      [`entry${state.caseIndex}`]: first,
      [`entry${state.caseIndex + 1}`]: second,
    };
  }
  const value = generateType(target, state, `${path}[0]`);
  return value === undefined ? [] : [value];
}

function shouldIncludeOptional(prop, state, path) {
  if (!prop.isOptional) return true;
  if (prop.isNamedCollection) return false;
  if (state.depth >= state.maxDepth) return false;
  return (
    stableHash(`${state.seed}:${state.caseIndex}:${path}:${prop.name}`) % 3 !==
    0
  );
}

function generateType(type, parentState, path) {
  if (!type?.typeName?.name) return undefined;
  const state = {
    ...parentState,
    depth: parentState.depth + 1,
  };
  const key = `${type.typeName.namespace ?? ""}.${type.typeName.name}`;
  const seenCount = parentState.seen.get(key) ?? 0;
  if (seenCount > 0 || state.depth > state.maxDepth) {
    return undefined;
  }
  state.seen = new Map(parentState.seen).set(key, seenCount + 1);

  const children = type.childTypes ?? [];
  if (type.discriminator && children.length > 0) {
    const first = children.indexOf(
      choose(state, children, `${path}:${type.discriminator}`) ?? children[0],
    );
    const ordered = [...children.slice(first), ...children.slice(0, first)];
    for (const concrete of ordered) {
      const literal = discriminatorLiteral(concrete, type.discriminator);
      const wildcardDiscriminator =
        literal === "*"
          ? `vendor-${state.caseIndex}-${stableHash(path) % 997}`
          : undefined;
      const payload = generateConcretePayload(
        type,
        concrete,
        state,
        path,
        wildcardDiscriminator,
      );
      if (payload !== undefined) return payload;
    }
    return undefined;
  }

  return generateConcretePayload(type, type, state, path);
}

function generateConcretePayload(
  type,
  concrete,
  state,
  path,
  wildcardDiscriminator,
) {
  const payload = {};
  const properties = new Map();
  for (const prop of type.properties ?? []) properties.set(prop.name, prop);
  for (const prop of concrete.properties ?? []) properties.set(prop.name, prop);
  for (const prop of properties.values()) {
    if (!shouldIncludeOptional(prop, state, path)) continue;
    const value = generatePropertyValue(prop, state, `${path}.${prop.name}`);
    if (value !== undefined) {
      payload[prop.name] = value;
    } else if (!prop.isOptional) {
      return undefined;
    }
  }

  if (type.discriminator && wildcardDiscriminator) {
    payload[type.discriminator] = wildcardDiscriminator;
  }
  return payload;
}

function filterCases(cases, onlyCase) {
  if (!onlyCase) return cases;
  return cases.filter(
    (entry) =>
      entry.id === onlyCase ||
      entry.caseId === onlyCase ||
      String(entry.caseIndex) === String(onlyCase) ||
      String(entry.caseIndex).padStart(3, "0") ===
        String(onlyCase).replace(/^case-/, ""),
  );
}

export function buildPropertyCorpus(modelJson, options = {}) {
  const rootType = options.rootType ?? "FixtureRoot";
  const seed = parsePropertySeed(options.seed, DEFAULT_SEED);
  const caseCount = options.caseCount ?? DEFAULT_CASE_COUNT;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const types = buildTypeRegistry(modelJson);
  const root = types.get(rootType);
  if (!root) {
    throw new Error(`Property corpus root type not found in IR: ${rootType}`);
  }

  const cases = [];
  for (let caseIndex = 0; caseIndex < caseCount; caseIndex += 1) {
    const caseId = `case-${String(caseIndex).padStart(3, "0")}`;
    const random = mulberry32((seed ^ stableHash(caseId)) >>> 0);
    const input = generateType(
      root,
      {
        seed,
        caseIndex,
        random,
        maxDepth,
        depth: 0,
        seen: new Map(),
        types,
      },
      rootType,
    );
    cases.push({
      id: `${rootType.toLowerCase()}-${asHex(seed)}-${caseId}`,
      seed: asHex(seed),
      caseId,
      caseIndex,
      input,
    });
  }

  return filterCases(cases, options.onlyCase);
}

function firstDifference(left, right, path = "$") {
  if (Object.is(left, right)) return undefined;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right))
      return { path, left, right };
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= left.length || index >= right.length)
        return {
          path: `${path}[${index}]`,
          left: left[index],
          right: right[index],
        };
      const nested = firstDifference(
        left[index],
        right[index],
        `${path}[${index}]`,
      );
      if (nested) return nested;
    }
    return undefined;
  }
  if (left && typeof left === "object" && right && typeof right === "object") {
    const keys = [
      ...new Set([...Object.keys(left), ...Object.keys(right)]),
    ].sort();
    for (const key of keys) {
      if (
        !Object.prototype.hasOwnProperty.call(left, key) ||
        !Object.prototype.hasOwnProperty.call(right, key)
      ) {
        return { path: `${path}.${key}`, left: left[key], right: right[key] };
      }
      const nested = firstDifference(left[key], right[key], `${path}.${key}`);
      if (nested) return nested;
    }
    return undefined;
  }
  return { path, left, right };
}

export function shrinkPropertyDifference(expected, actual) {
  const expectedCases = new Map(
    (expected?.propertyCases ?? []).map((entry) => [entry.id, entry]),
  );
  for (const actualCase of actual?.propertyCases ?? []) {
    const expectedCase = expectedCases.get(actualCase.id);
    if (!expectedCase) {
      return {
        id: actualCase.id,
        seed: actualCase.seed,
        caseId: actualCase.caseId,
        path: "$.propertyCases",
        expected: undefined,
        actual: actualCase,
      };
    }
    const difference = firstDifference(expectedCase.root, actualCase.root);
    if (difference) {
      return {
        id: expectedCase.id,
        seed: expectedCase.seed,
        caseId: expectedCase.caseId,
        path: difference.path,
        expected: difference.left,
        actual: difference.right,
      };
    }
  }
  for (const expectedCase of expectedCases.values()) {
    if (
      !(actual?.propertyCases ?? []).some(
        (entry) => entry.id === expectedCase.id,
      )
    ) {
      return {
        id: expectedCase.id,
        seed: expectedCase.seed,
        caseId: expectedCase.caseId,
        path: "$.propertyCases",
        expected: expectedCase,
        actual: undefined,
      };
    }
  }
  return undefined;
}

export function formatPropertyCaseFailure(expected, actual) {
  const shrunk = shrinkPropertyDifference(expected, actual);
  if (!shrunk) return "";
  const caseIndex = Number.parseInt(
    String(shrunk.caseId).replace(/^case-/, ""),
    10,
  );
  const caseCount = Math.max(
    expected?.propertyCases?.length ?? 0,
    Number.isSafeInteger(caseIndex) ? caseIndex + 1 : 0,
  );
  return [
    "Property differential reproduction:",
    `  id: ${shrunk.id}`,
    `  seed: ${shrunk.seed}`,
    `  case: ${shrunk.caseId}`,
    `  path: ${shrunk.path}`,
    `  expected: ${JSON.stringify(shrunk.expected)}`,
    `  actual: ${JSON.stringify(shrunk.actual)}`,
    `  replay: TYPRA_PROPERTY_SEED=${shrunk.seed} TYPRA_PROPERTY_CASE_COUNT=${caseCount} TYPRA_PROPERTY_CASE=${shrunk.caseId} npm run validate:fixtures`,
  ].join("\n");
}
