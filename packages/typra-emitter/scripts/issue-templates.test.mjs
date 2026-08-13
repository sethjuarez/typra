import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const templateDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".github",
  "ISSUE_TEMPLATE",
);

// GitHub issue-form element types (config.yml is the chooser config, not a form).
const FORM_ELEMENT_TYPES = new Set([
  "markdown",
  "input",
  "textarea",
  "dropdown",
  "checkboxes",
]);

function ymlFiles() {
  return readdirSync(templateDir).filter((name) => name.endsWith(".yml"));
}

describe("issue templates", () => {
  it("has at least the emitter-drift form and the chooser config", () => {
    const files = ymlFiles();
    assert.ok(files.includes("emitter-drift.yml"), "emitter-drift.yml is missing");
    assert.ok(files.includes("config.yml"), "config.yml is missing");
  });

  it("parses every template as valid YAML", () => {
    for (const file of ymlFiles()) {
      const raw = readFileSync(path.join(templateDir, file), "utf8");
      assert.doesNotThrow(() => parse(raw), `${file} is not valid YAML`);
    }
  });

  it("validates the structure of every issue FORM (files with a body)", () => {
    for (const file of ymlFiles()) {
      const doc = parse(readFileSync(path.join(templateDir, file), "utf8"));
      if (!doc || !Array.isArray(doc.body)) continue; // config.yml has no body

      assert.equal(typeof doc.name, "string", `${file}: name must be a string`);
      assert.equal(
        typeof doc.description,
        "string",
        `${file}: description must be a string`,
      );

      const seenIds = new Set();
      for (const [index, element] of doc.body.entries()) {
        const where = `${file} body[${index}]`;
        assert.ok(
          FORM_ELEMENT_TYPES.has(element.type),
          `${where}: unknown element type "${element.type}"`,
        );
        if (element.id !== undefined) {
          assert.ok(
            !seenIds.has(element.id),
            `${where}: duplicate id "${element.id}"`,
          );
          seenIds.add(element.id);
        }
        if (element.type === "markdown") {
          assert.equal(
            typeof element.attributes?.value,
            "string",
            `${where}: markdown requires attributes.value`,
          );
        } else {
          assert.equal(
            typeof element.attributes?.label,
            "string",
            `${where}: ${element.type} requires attributes.label`,
          );
        }
        if (element.type === "dropdown" || element.type === "checkboxes") {
          assert.ok(
            Array.isArray(element.attributes?.options) &&
              element.attributes.options.length > 0,
            `${where}: ${element.type} requires a non-empty options list`,
          );
        }
      }
    }
  });

  it("enshrines the reproduction-first structure in emitter-drift.yml", () => {
    const doc = parse(
      readFileSync(path.join(templateDir, "emitter-drift.yml"), "utf8"),
    );
    const ids = new Set(doc.body.map((element) => element.id).filter(Boolean));

    // The three pieces every codegen bug report must carry: the TypeSpec shape,
    // the test that breaks (expected vs. actual), and the optional generated
    // code. These map onto how the emitter is tested (fixtures + vectors).
    assert.ok(ids.has("tsp-shape"), "must ask for the minimal TypeSpec shape");
    assert.ok(
      ids.has("expected-vs-actual"),
      "must ask for the expected-vs-actual test",
    );
    assert.ok(
      ids.has("generated-code"),
      "must ask for the generated code snippet",
    );

    const byId = new Map(doc.body.map((element) => [element.id, element]));
    // Shape and the breaking test are mandatory; generated code is encouraged
    // but optional (you may not have run codegen yet when filing).
    assert.equal(byId.get("tsp-shape").validations?.required, true);
    assert.equal(byId.get("expected-vs-actual").validations?.required, true);
    assert.notEqual(byId.get("generated-code").validations?.required, true);
  });
});
