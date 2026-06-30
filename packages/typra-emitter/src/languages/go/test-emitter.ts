/**
 * Go test emitter — BaseTestContext → Go test source code.
 *
 * Replaces `test.go.njk` and `_macros.njk` Nunjucks templates with
 * typed TypeScript functions that produce identical Go test output.
 *
 * Each test file covers one type and contains:
 *   - Per-example: LoadJSON, LoadYAML, Roundtrip, ToJSON, ToYAML tests
 *   - Per-coercion: From<Title> tests for scalar-to-object expansion
 */

import {
  BaseTestContext,
  TestExample,
  CoercionTest,
  PropertyValidation,
  TypeNode,
  PropertyNode,
} from "../../ir/ast.js";

// ============================================================================
// Helpers
// ============================================================================

/** Nunjucks `capitalize` filter: upper-case first char, lower-case rest. */
function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Emit a validation assertion for a property.
 *
 * @param varName  - "instance" or "reloaded"
 * @param v        - property validation descriptor
 */
function emitValidation(lines: string[], varName: string, v: PropertyValidation): void {
  // Determine the display value for the error message — includes quotes if delimiter is "
  const displayQuote = v.delimiter === '"' ? '"' : '';
  const display = `${displayQuote}${v.value}${displayQuote}`;

  if (v.isOptional) {
    lines.push(`if ${varName}.${v.key} == nil || *${varName}.${v.key} != ${v.delimiter}${v.value}${v.delimiter} {`);
    lines.push(`t.Errorf(\`Expected ${v.key} to be ${display}, got %v\`, ${varName}.${v.key})`);
    lines.push(`}`);
  } else {
    lines.push(`if ${varName}.${v.key} != ${v.delimiter}${v.value}${v.delimiter} {`);
    lines.push(`t.Errorf(\`Expected ${v.key} to be ${display}, got %v\`, ${varName}.${v.key})`);
    lines.push(`}`);
  }
}

function goFieldName(name: string): string {
  const pascal = name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return pascal.charAt(0).toUpperCase() + pascal.slice(1);
}

function goStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function reflectiveHelperName(typeName: string): string {
  return `assert${typeName}StringField`;
}

function isPolymorphicProperty(prop: PropertyNode): boolean {
  return !prop.isScalar && !prop.isCollection && !prop.isDict && (prop.type?.childTypes.length ?? 0) > 0;
}

function findSampleChildType(prop: PropertyNode, sample: Record<string, any>): TypeNode | undefined {
  const discriminator = prop.type?.discriminator;
  const discriminatorValue = discriminator ? sample[discriminator] : undefined;
  if (discriminator && discriminatorValue !== undefined) {
    return prop.type?.childTypes.find(child =>
      child.properties.some(childProp => childProp.name === discriminator && childProp.defaultValue === discriminatorValue)
    );
  }

  return prop.type?.childTypes.find(child =>
    child.properties.some(childProp => childProp.defaultValue !== null && sample[childProp.name] === childProp.defaultValue)
  );
}

function emitExampleValidations(
  lines: string[],
  varName: string,
  sample: TestExample,
  node: TypeNode,
  pkg: string,
): void {
  emitConcreteExampleValidations(lines, varName, sample.validations);
  emitStructuredValidations(lines, varName, sample.sample, node, pkg);
}

function emitStructuredValidations(
  lines: string[],
  varName: string,
  sample: Record<string, any>,
  node: TypeNode,
  pkg: string,
  includeScalars = false,
  reflectiveHelper = reflectiveHelperName(node.typeName.name),
): void {
  for (const prop of node.properties) {
    if (!(prop.name in sample)) continue;
    const value = sample[prop.name];
    const fieldName = goFieldName(prop.name);
    const expr = `${varName}.${fieldName}`;

    if (includeScalars && prop.isScalar) {
      emitScalarSampleValidation(lines, expr, fieldName, value, prop.isOptional);
      continue;
    }

    if (!prop.isScalar && prop.type && typeof value === "string") {
      emitShorthandObjectValidation(lines, expr, fieldName, value, prop.type);
      continue;
    }

    if (prop.isCollection && Array.isArray(value)) {
      emitCollectionValidation(lines, expr, fieldName, value, prop, pkg, reflectiveHelper);
      continue;
    }

    if (prop.isDict && value && typeof value === "object" && !Array.isArray(value)) {
      emitDictValidation(lines, expr, fieldName, value);
      continue;
    }

    if (isPolymorphicProperty(prop) && value && typeof value === "object" && !Array.isArray(value)) {
      emitPolymorphicValidation(lines, expr, fieldName, value, prop, pkg, reflectiveHelper);
      continue;
    }

    if (!prop.isScalar && prop.type && value && typeof value === "object" && !Array.isArray(value)) {
      emitNestedObjectValidation(lines, expr, fieldName, value, prop.type);
    }
  }
}

function emitShorthandObjectValidation(
  lines: string[],
  expr: string,
  fieldName: string,
  expected: string,
  node: TypeNode,
): void {
  const shorthandField = findStringCoercionField(node);
  if (!shorthandField) return;

  const targetProp = node.properties.find(candidate => candidate.name === shorthandField);
  emitScalarSampleValidation(lines, `${expr}.${goFieldName(shorthandField)}`, `${fieldName}.${goFieldName(shorthandField)}`, expected, targetProp?.isOptional ?? false);
}

function emitCollectionValidation(
  lines: string[],
  expr: string,
  fieldName: string,
  values: any[],
  prop: PropertyNode,
  pkg: string,
  reflectiveHelper: string,
): void {
  lines.push(`if len(${expr}) != ${values.length} {`);
  lines.push(`t.Fatalf("Expected ${fieldName} length to be ${values.length}, got %d", len(${expr}))`);
  lines.push("}");

  if (prop.isScalar) {
    values.forEach((item, index) => {
      if (typeof item === "string") {
        lines.push(`if ${expr}[${index}] != ${goStringLiteral(item)} {`);
        lines.push(`t.Errorf(\`Expected ${fieldName}[${index}] to be ${goStringLiteral(item)}, got %v\`, ${expr}[${index}])`);
        lines.push("}");
      }
    });
    return;
  }

  if (prop.type) {
    values.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const itemExpr = `${expr}[${index}]`;
        const childType = findSampleChildType(prop, item);
        if (childType) {
          const localName = `${fieldName.charAt(0).toLowerCase()}${fieldName.slice(1)}${index}Value`;
          lines.push(`${localName}, ok := ${itemExpr}.(${pkg}.${childType.typeName.name})`);
          lines.push("if !ok {");
          lines.push(`t.Fatalf("Expected ${fieldName}[${index}] to be ${pkg}.${childType.typeName.name}, got %T", ${itemExpr})`);
          lines.push("}");
          emitStructuredValidations(lines, localName, item, childType, pkg, true, reflectiveHelper);
          return;
        }

        emitReflectiveObjectValidation(lines, itemExpr, `${fieldName}[${index}]`, item, reflectiveHelper);
      }
    });
  }
}

function emitReflectiveObjectValidation(
  lines: string[],
  expr: string,
  displayName: string,
  sample: Record<string, any>,
  reflectiveHelper: string,
): void {
  for (const [key, expected] of Object.entries(sample)) {
    if (typeof expected === "string") {
      lines.push(`${reflectiveHelper}(t, ${expr}, ${goStringLiteral(goFieldName(key))}, ${goStringLiteral(expected)}, ${goStringLiteral(`${displayName}.${goFieldName(key)}`)})`);
    }
  }
}

function emitScalarSampleValidation(
  lines: string[],
  expr: string,
  fieldName: string,
  expected: any,
  isOptional: boolean,
): void {
  if (typeof expected === "string") {
    if (isOptional) {
      lines.push(`if ${expr} == nil || *${expr} != ${goStringLiteral(expected)} {`);
      lines.push(`t.Errorf(\`Expected ${fieldName} to be ${goStringLiteral(expected)}, got %v\`, ${expr})`);
      lines.push("}");
    } else {
      lines.push(`if ${expr} != ${goStringLiteral(expected)} {`);
      lines.push(`t.Errorf(\`Expected ${fieldName} to be ${goStringLiteral(expected)}, got %v\`, ${expr})`);
      lines.push("}");
    }
  }
}

function emitDictValidation(
  lines: string[],
  expr: string,
  fieldName: string,
  value: Record<string, any>,
): void {
  lines.push(`if ${expr} == nil {`);
  lines.push(`t.Fatalf("Expected ${fieldName} to be populated")`);
  lines.push("}");

  for (const [key, expected] of Object.entries(value)) {
    if (typeof expected === "string") {
      lines.push(`if got := ${expr}[${goStringLiteral(key)}]; got != ${goStringLiteral(expected)} {`);
      lines.push(`t.Errorf(\`Expected ${fieldName}[${goStringLiteral(key)}] to be ${goStringLiteral(expected)}, got %v\`, got)`);
      lines.push("}");
    }
  }
}

function emitPolymorphicValidation(
  lines: string[],
  expr: string,
  fieldName: string,
  value: Record<string, any>,
  prop: PropertyNode,
  pkg: string,
  reflectiveHelper: string,
): void {
  const childType = findSampleChildType(prop, value);
  if (!childType) return;

  const localName = `${fieldName.charAt(0).toLowerCase()}${fieldName.slice(1)}Value`;
  lines.push(`${localName}, ok := ${expr}.(${pkg}.${childType.typeName.name})`);
  lines.push("if !ok {");
  lines.push(`t.Fatalf("Expected ${fieldName} to be ${pkg}.${childType.typeName.name}, got %T", ${expr})`);
  lines.push("}");
  emitStructuredValidations(lines, localName, value, childType, pkg, true, reflectiveHelper);
}

function emitNestedObjectValidation(
  lines: string[],
  expr: string,
  fieldName: string,
  value: Record<string, any>,
  node: TypeNode,
): void {
  for (const prop of node.properties) {
    if (!(prop.name in value)) continue;
    const expected = value[prop.name];
    const nestedField = goFieldName(prop.name);
    const nestedExpr = `${expr}.${nestedField}`;

    if (typeof expected === "string") {
      if (!prop.isScalar && prop.type) {
        const shorthandField = findStringCoercionField(prop.type);
        if (shorthandField) {
          const targetProp = prop.type.properties.find(candidate => candidate.name === shorthandField);
          emitScalarSampleValidation(lines, `${nestedExpr}.${goFieldName(shorthandField)}`, `${fieldName}.${nestedField}.${goFieldName(shorthandField)}`, expected, targetProp?.isOptional ?? false);
        }
        continue;
      }

      if (prop.isOptional) {
        lines.push(`if ${nestedExpr} == nil || *${nestedExpr} != ${goStringLiteral(expected)} {`);
        lines.push(`t.Errorf(\`Expected ${fieldName}.${nestedField} to be ${goStringLiteral(expected)}, got %v\`, ${nestedExpr})`);
        lines.push("}");
      } else {
        lines.push(`if ${nestedExpr} != ${goStringLiteral(expected)} {`);
        lines.push(`t.Errorf(\`Expected ${fieldName}.${nestedField} to be ${goStringLiteral(expected)}, got %v\`, ${nestedExpr})`);
        lines.push("}");
      }
    }
  }

}

function findStringCoercionField(node: TypeNode): string | undefined {
  const coercion = node.coercions.find(entry => entry.scalar === "string");
  if (!coercion) return undefined;

  for (const [key, value] of Object.entries(coercion.expansion)) {
    if (value === "{value}") return key;
  }

  return node.properties.find(prop => prop.name === "kind")?.name;
}

function emitWireValidationTest(
  lines: string[],
  typeName: string,
  pkg: string,
  sample: TestExample,
  node: TypeNode,
): void {
  const mappings = node.properties.flatMap(prop =>
    prop.knownAs.map(mapping => ({
      fieldName: prop.name,
      provider: mapping.provider,
      wireName: mapping.name,
    }))
  );
  if (mappings.length === 0) return;

  const providers = [...new Set(mappings.map(mapping => mapping.provider))];

  lines.push(`// Test${typeName}ToWire tests provider-specific wire field names`);
  lines.push(`func Test${typeName}ToWire(t *testing.T) {`);
  emitJsonDataBlock(lines, sample);
  emitJsonUnmarshal(lines);
  lines.push("");
  emitLoadCall(lines, typeName, pkg, "ctx", "data", "instance");

  for (const provider of providers) {
    lines.push("");
    lines.push(`${provider}Wire := instance.ToWire(${goStringLiteral(provider)})`);
    for (const mapping of mappings.filter(entry => entry.provider === provider)) {
      lines.push(`if _, ok := ${provider}Wire[${goStringLiteral(mapping.wireName)}]; !ok {`);
      lines.push(`t.Errorf("Expected ${provider} wire output to include ${mapping.wireName}")`);
      lines.push("}");
      if (mapping.fieldName !== mapping.wireName) {
        lines.push(`if _, ok := ${provider}Wire[${goStringLiteral(mapping.fieldName)}]; ok {`);
        lines.push(`t.Errorf("Expected ${provider} wire output to omit source field ${mapping.fieldName}")`);
        lines.push("}");
      }
    }
  }

  lines.push("}");
}

function needsReflectiveCollectionValidation(node: TypeNode, examples: TestExample[]): boolean {
  return examples.some(example => node.properties.some(prop => {
    const value = example.sample[prop.name];
    if (!prop.isCollection || prop.isScalar || !prop.type || !Array.isArray(value)) return false;
    return value.some(item =>
      item && typeof item === "object" && !Array.isArray(item) && !findSampleChildType(prop, item)
    );
  }));
}

function emitReflectiveFieldHelpers(lines: string[], helperName: string): void {
  lines.push("");
  lines.push(`func ${helperName}(t *testing.T, value interface{}, fieldName string, expected string, displayName string) {`);
  lines.push("t.Helper()");
  lines.push("field := reflect.ValueOf(value)");
  lines.push("if field.Kind() == reflect.Pointer {");
  lines.push("if field.IsNil() {");
  lines.push("t.Fatalf(\"Expected %s to be populated\", displayName)");
  lines.push("}");
  lines.push("field = field.Elem()");
  lines.push("}");
  lines.push("if field.Kind() != reflect.Struct {");
  lines.push("t.Fatalf(\"Expected %s receiver to be a struct, got %T\", displayName, value)");
  lines.push("}");
  lines.push("member := field.FieldByName(fieldName)");
  lines.push("if !member.IsValid() {");
  lines.push("t.Fatalf(\"Expected %s to have field %s, got %T\", displayName, fieldName, value)");
  lines.push("}");
  lines.push("if member.Kind() == reflect.Pointer {");
  lines.push("if member.IsNil() {");
  lines.push("t.Fatalf(\"Expected %s to be populated\", displayName)");
  lines.push("}");
  lines.push("member = member.Elem()");
  lines.push("}");
  lines.push("if member.Kind() == reflect.Interface {");
  lines.push("if member.IsNil() {");
  lines.push("t.Fatalf(\"Expected %s to be populated\", displayName)");
  lines.push("}");
  lines.push("member = member.Elem()");
  lines.push("}");
  lines.push("if member.Kind() != reflect.String {");
  lines.push("t.Fatalf(\"Expected %s to be a string field, got %s\", displayName, member.Kind())");
  lines.push("}");
  lines.push("if got := member.String(); got != expected {");
  lines.push("t.Errorf(\"Expected %s to be %q, got %q\", displayName, expected, got)");
  lines.push("}");
  lines.push("}");
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Emit a complete Go test file for a single type.
 *
 * @param ctx - test context built by `buildBaseTestContext()`
 * @returns Complete Go test source file as a string
 */
export function emitGoTest(ctx: BaseTestContext & { importPath: string }): string {
  const lines: string[] = [];
  const typeName = ctx.node.typeName.name;
  const pkg = ctx.package ?? "";
  const isAbstract = ctx.isAbstract;
  const needsReflect = needsReflectiveCollectionValidation(ctx.node, ctx.examples);

  // File header (template lines 14-16)
  lines.push("// Code generated by Typra emitter; DO NOT EDIT.");
  lines.push("");
  lines.push(`package ${pkg}_test`);

  // Import block (template lines 17-26)
  if (ctx.examples.length > 0 || ctx.coercions.length > 0) {
    lines.push(""); // {% if true %}\n — blank line between package and import
    lines.push(`import (`);
    lines.push(`"encoding/json"`);
    if (needsReflect) {
      lines.push(`"reflect"`);
    }
    lines.push(`"testing"`);
    lines.push(``);
    lines.push(`"gopkg.in/yaml.v3"`);
    lines.push(``);
    lines.push(`"${ctx.importPath}"`);
    lines.push(`)`);
  }
  lines.push(""); // {% endif %}\n (line 26)
  lines.push(""); // blank line 27

  // Per-example test functions (template lines 28-234)
  for (let i = 0; i < ctx.examples.length; i++) {
    const sample = ctx.examples[i];
    const isFirst = i === 0;
    const suffix = isFirst ? "" : String(i);

    lines.push(""); // {% for %}\n — loop body starts with \n
    emitLoadJSONTest(lines, typeName, pkg, suffix, sample, ctx.node, isAbstract);
    lines.push("");
    emitLoadYAMLTest(lines, typeName, pkg, suffix, sample, ctx.node, isAbstract);
    lines.push("");
    emitFromJSONTest(lines, typeName, pkg, suffix, sample, ctx.node, isAbstract);
    lines.push("");
    emitFromYAMLTest(lines, typeName, pkg, suffix, sample, ctx.node, isAbstract);
    lines.push("");
    emitRoundtripTest(lines, typeName, pkg, suffix, sample, ctx.node, isAbstract);
    lines.push("");
    emitToJSONTest(lines, typeName, pkg, suffix, sample, ctx.node, isAbstract);
    lines.push("");
    emitToYAMLTest(lines, typeName, pkg, suffix, sample, ctx.node, isAbstract);
    lines.push(""); // blank line 233
  }
  lines.push(""); // {% endfor %}\n (line 234)
  if (ctx.examples.length > 0) {
    emitInvalidFromJSONTest(lines, typeName, pkg);
    lines.push("");
  }

  if (!isAbstract && ctx.examples.length > 0) {
    emitWireValidationTest(lines, typeName, pkg, ctx.examples[0], ctx.node);
    lines.push("");
  }

  // Coercion test functions (template lines 235-271)
  if (ctx.coercions.length > 0) {
    lines.push(""); // {% if true %}\n — if body starts with \n
    for (let i = 0; i < ctx.coercions.length; i++) {
      const alt = ctx.coercions[i];
      const isFirst = i === 0;
      const suffix = isFirst ? "" : String(i + 1);

      lines.push(""); // {% for %}\n — loop body starts with \n
      emitCoercionTest(lines, typeName, pkg, suffix, alt, isAbstract);
      lines.push(""); // blank line 269
    }
    lines.push(""); // {% endfor %}\n (line 270)
    lines.push(""); // {% endif %}\n (line 271)
  } else {
    lines.push(""); // {% if false %}...{% endif %}\n — 1 \n
  }

  if (needsReflect) {
    emitReflectiveFieldHelpers(lines, reflectiveHelperName(typeName));
  }

  return emitCleanGoLines(lines, "\n");
}

function emitCleanGoLines(lines: string[], suffix = ""): string {
  return lines.map(line => line.trimEnd()).join("\n") + suffix;
}

// ============================================================================
// Per-example test emitters
// ============================================================================

function emitJsonDataBlock(lines: string[], sample: TestExample): void {
  lines.push("jsonData := `");
  for (const line of sample.json) {
    lines.push(line);
  }
  lines.push("`");
}

function emitYamlDataBlock(lines: string[], sample: TestExample): void {
  lines.push("yamlData := `");
  for (const line of sample.yaml) {
    lines.push(line);
  }
  lines.push("`");
}

function emitJsonUnmarshal(lines: string[], varName: string = "data"): void {
  lines.push(`var ${varName} map[string]interface{}`);
  lines.push(`if err := json.Unmarshal([]byte(jsonData), &${varName}); err != nil {`);
  lines.push(`t.Fatalf("Failed to parse JSON: %v", err)`);
  lines.push(`}`);
}

function emitInvalidFromJSONTest(lines: string[], typeName: string, pkg: string): void {
  lines.push(`// Test${typeName}FromJSONInvalid rejects malformed JSON instead of silently defaulting`);
  lines.push(`func Test${typeName}FromJSONInvalid(t *testing.T) {`);
  lines.push(`if _, err := ${pkg}.${typeName}FromJSON("{"); err == nil {`);
  lines.push(`t.Fatalf("Expected malformed JSON to fail")`);
  lines.push("}");
  lines.push("}");
}

function emitYamlUnmarshal(lines: string[], varName: string = "data"): void {
  lines.push(`var ${varName} map[string]interface{}`);
  lines.push(`if err := yaml.Unmarshal([]byte(yamlData), &${varName}); err != nil {`);
  lines.push(`t.Fatalf("Failed to parse YAML: %v", err)`);
  lines.push(`}`);
}

function emitLoadCall(
  lines: string[],
  typeName: string,
  pkg: string,
  ctxVar: string,
  dataVar: string,
  instanceVar: string,
): void {
  lines.push(`${ctxVar} := ${pkg}.NewLoadContext()`);
  lines.push(`${instanceVar}, err := ${pkg}.Load${typeName}(${dataVar}, ${ctxVar})`);
  lines.push(`if err != nil {`);
  lines.push(`t.Fatalf("Failed to load ${typeName}: %v", err)`);
  lines.push(`}`);
}

function emitAbstractExampleValidations(
  lines: string[],
  hasValidations: boolean,
): void {
  lines.push("// Polymorphic types return interface{}, extract common fields via reflection or type-specific access");
  lines.push("_ = instance // Load succeeded, exact type depends on discriminator");
  if (hasValidations) {
    lines.push("// Note: Validation skipped for polymorphic base types - test child types directly");
  }
}

function emitConcreteExampleValidations(
  lines: string[],
  varName: string,
  validations: PropertyValidation[],
): void {
  if (validations.length > 0) {
    for (const v of validations) {
      emitValidation(lines, varName, v);
    }
  } else {
    lines.push(`_ = ${varName} // No scalar properties to validate`);
  }
}

// ---- LoadJSON ----

function emitLoadJSONTest(
  lines: string[],
  typeName: string,
  pkg: string,
  suffix: string,
  sample: TestExample,
  node: TypeNode,
  isAbstract: boolean,
): void {
  lines.push(`// Test${typeName}LoadJSON${suffix} tests loading ${typeName} from JSON`);
  lines.push(`func Test${typeName}LoadJSON${suffix}(t *testing.T) {`);
  emitJsonDataBlock(lines, sample);
  emitJsonUnmarshal(lines);
  lines.push("");
  emitLoadCall(lines, typeName, pkg, "ctx", "data", "instance");
  if (isAbstract) {
    emitAbstractExampleValidations(lines, sample.validations.length > 0);
  } else {
    emitExampleValidations(lines, "instance", sample, node, pkg);
  }
  lines.push("}");
}

// ---- LoadYAML ----

function emitLoadYAMLTest(
  lines: string[],
  typeName: string,
  pkg: string,
  suffix: string,
  sample: TestExample,
  node: TypeNode,
  isAbstract: boolean,
): void {
  lines.push(`// Test${typeName}LoadYAML${suffix} tests loading ${typeName} from YAML`);
  lines.push(`func Test${typeName}LoadYAML${suffix}(t *testing.T) {`);
  emitYamlDataBlock(lines, sample);
  emitYamlUnmarshal(lines);
  lines.push("");
  emitLoadCall(lines, typeName, pkg, "ctx", "data", "instance");
  if (isAbstract) {
    emitAbstractExampleValidations(lines, sample.validations.length > 0);
  } else {
    emitExampleValidations(lines, "instance", sample, node, pkg);
  }
  lines.push("}");
}

// ---- FromJSON ----

function emitFromJSONTest(
  lines: string[],
  typeName: string,
  pkg: string,
  suffix: string,
  sample: TestExample,
  node: TypeNode,
  isAbstract: boolean,
): void {
  lines.push(`// Test${typeName}FromJSON${suffix} tests loading ${typeName} through the generated JSON helper`);
  lines.push(`func Test${typeName}FromJSON${suffix}(t *testing.T) {`);
  emitJsonDataBlock(lines, sample);
  lines.push("");
  lines.push(`instance, err := ${pkg}.${typeName}FromJSON(jsonData)`);
  lines.push(`if err != nil {`);
  lines.push(`t.Fatalf("Failed to load ${typeName} from JSON helper: %v", err)`);
  lines.push(`}`);
  if (isAbstract) {
    emitAbstractExampleValidations(lines, sample.validations.length > 0);
  } else {
    emitExampleValidations(lines, "instance", sample, node, pkg);
  }
  lines.push("}");
}

// ---- FromYAML ----

function emitFromYAMLTest(
  lines: string[],
  typeName: string,
  pkg: string,
  suffix: string,
  sample: TestExample,
  node: TypeNode,
  isAbstract: boolean,
): void {
  lines.push(`// Test${typeName}FromYAML${suffix} tests loading ${typeName} through the generated YAML helper`);
  lines.push(`func Test${typeName}FromYAML${suffix}(t *testing.T) {`);
  emitYamlDataBlock(lines, sample);
  lines.push("");
  lines.push(`instance, err := ${pkg}.${typeName}FromYAML(yamlData)`);
  lines.push(`if err != nil {`);
  lines.push(`t.Fatalf("Failed to load ${typeName} from YAML helper: %v", err)`);
  lines.push(`}`);
  if (isAbstract) {
    emitAbstractExampleValidations(lines, sample.validations.length > 0);
  } else {
    emitExampleValidations(lines, "instance", sample, node, pkg);
  }
  lines.push("}");
}

// ---- Roundtrip ----

function emitRoundtripTest(
  lines: string[],
  typeName: string,
  pkg: string,
  suffix: string,
  sample: TestExample,
  node: TypeNode,
  isAbstract: boolean,
): void {
  lines.push(`// Test${typeName}Roundtrip${suffix} tests load -> save -> load produces equivalent data`);
  lines.push(`func Test${typeName}Roundtrip${suffix}(t *testing.T) {`);
  emitJsonDataBlock(lines, sample);
  emitJsonUnmarshal(lines);
  lines.push("");

  lines.push(`loadCtx := ${pkg}.NewLoadContext()`);
  lines.push(`instance, err := ${pkg}.Load${typeName}(data, loadCtx)`);
  lines.push(`if err != nil {`);
  lines.push(`t.Fatalf("Failed to load ${typeName}: %v", err)`);
  lines.push(`}`);
  if (isAbstract) {
    lines.push("// Polymorphic roundtrip testing requires type-specific handling");
    lines.push("_ = instance // Load succeeded, exact type depends on discriminator");
    lines.push("// Note: Roundtrip test skipped for polymorphic base types - test child types directly");
  } else {
    lines.push(`saveCtx := ${pkg}.NewSaveContext()`);
    lines.push(`savedData := instance.Save(saveCtx)`);
    lines.push("");
    lines.push(`reloaded, err := ${pkg}.Load${typeName}(savedData, loadCtx)`);
    lines.push(`if err != nil {`);
    lines.push(`t.Fatalf("Failed to reload ${typeName}: %v", err)`);
    lines.push(`}`);
    emitExampleValidations(lines, "reloaded", sample, node, pkg);
  }
  lines.push("}");
}

// ---- ToJSON ----

function emitToJSONTest(
  lines: string[],
  typeName: string,
  pkg: string,
  suffix: string,
  sample: TestExample,
  node: TypeNode,
  isAbstract: boolean,
): void {
  lines.push(`// Test${typeName}ToJSON${suffix} tests that ToJSON produces valid JSON`);
  lines.push(`func Test${typeName}ToJSON${suffix}(t *testing.T) {`);
  emitJsonDataBlock(lines, sample);
  emitJsonUnmarshal(lines);
  lines.push("");
  emitLoadCall(lines, typeName, pkg, "ctx", "data", "instance");
  if (isAbstract) {
    lines.push("// Polymorphic ToJSON requires type-specific handling");
    lines.push("_ = instance // Load succeeded, exact type depends on discriminator");
    lines.push("// Note: ToJSON test skipped for polymorphic base types - test child types directly");
  } else {
    lines.push("jsonOutput, err := instance.ToJSON()");
    lines.push("if err != nil {");
    lines.push(`t.Fatalf("Failed to convert to JSON: %v", err)`);
    lines.push("}");
    lines.push("");
    lines.push("var parsed map[string]interface{}");
    lines.push("if err := json.Unmarshal([]byte(jsonOutput), &parsed); err != nil {");
    lines.push(`t.Fatalf("Failed to parse generated JSON: %v", err)`);
    lines.push("}");
    lines.push("");
    lines.push(`reloaded, err := ${pkg}.Load${typeName}(parsed, ctx)`);
    lines.push(`if err != nil {`);
    lines.push(`t.Fatalf("Failed to reload generated JSON: %v", err)`);
    lines.push(`}`);
    emitExampleValidations(lines, "reloaded", sample, node, pkg);
  }

  lines.push("}");
}

// ---- ToYAML ----

function emitToYAMLTest(
  lines: string[],
  typeName: string,
  pkg: string,
  suffix: string,
  sample: TestExample,
  node: TypeNode,
  isAbstract: boolean,
): void {
  lines.push(`// Test${typeName}ToYAML${suffix} tests that ToYAML produces valid YAML`);
  lines.push(`func Test${typeName}ToYAML${suffix}(t *testing.T) {`);
  emitJsonDataBlock(lines, sample);
  emitJsonUnmarshal(lines);
  lines.push("");
  emitLoadCall(lines, typeName, pkg, "ctx", "data", "instance");
  if (isAbstract) {
    lines.push("// Polymorphic ToYAML requires type-specific handling");
    lines.push("_ = instance // Load succeeded, exact type depends on discriminator");
    lines.push("// Note: ToYAML test skipped for polymorphic base types - test child types directly");
  } else {
    lines.push("yamlOutput, err := instance.ToYAML()");
    lines.push("if err != nil {");
    lines.push(`t.Fatalf("Failed to convert to YAML: %v", err)`);
    lines.push("}");
    lines.push("");
    lines.push("var parsed map[string]interface{}");
    lines.push("if err := yaml.Unmarshal([]byte(yamlOutput), &parsed); err != nil {");
    lines.push(`t.Fatalf("Failed to parse generated YAML: %v", err)`);
    lines.push("}");
    lines.push("");
    lines.push(`reloaded, err := ${pkg}.Load${typeName}(parsed, ctx)`);
    lines.push(`if err != nil {`);
    lines.push(`t.Fatalf("Failed to reload generated YAML: %v", err)`);
    lines.push(`}`);
    emitExampleValidations(lines, "reloaded", sample, node, pkg);
  }

  lines.push("}");
}

// ============================================================================
// Coercion test emitter
// ============================================================================

function emitCoercionTest(
  lines: string[],
  typeName: string,
  pkg: string,
  suffix: string,
  alt: CoercionTest,
  isAbstract: boolean,
): void {
  const title = capitalize(alt.title);

  lines.push(`// Test${typeName}From${title}${suffix} tests loading ${typeName} from ${alt.scalarType}`);
  lines.push(`func Test${typeName}From${title}${suffix}(t *testing.T) {`);
  lines.push(`ctx := ${pkg}.NewLoadContext()`);
  lines.push(`instance, err := ${pkg}.Load${typeName}(${alt.value}, ctx)`);
  lines.push(`if err != nil {`);
  lines.push(`t.Fatalf("Failed to load ${typeName} from ${alt.scalarType}: %v", err)`);
  lines.push(`}`);
  if (isAbstract) {
    lines.push("// Polymorphic alternate loading requires type-specific handling");
    lines.push("_ = instance // Load succeeded, exact type depends on discriminator");
    if (alt.validations.length > 0) {
      lines.push("// Note: Validation skipped for polymorphic base types - test child types directly");
    }
  } else {
    emitConcreteExampleValidations(lines, "instance", alt.validations);
  }

  lines.push("}");
}
