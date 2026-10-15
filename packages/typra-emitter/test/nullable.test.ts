// Issue #339: `x: T | null` is a REQUIRED key whose value may be null — load rejects an
// absent key but accepts `null`, and save always writes the key (as `null` when unset) —
// distinct from `x?: T` / `x?: T | null`, which are omitted when unset.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const TARGETS: Array<[type: string, dir: string, native?: string]> = [
  ["TypeScript", "typescript"],
  ["TypeScript", "typescript-zod", "zod"],
  ["Python", "python"],
  ["Python", "python-pydantic", "pydantic"],
  ["Go", "go"],
  ["Java", "java"],
  ["Java", "java-jackson", "jackson"],
  ["CSharp", "csharp"],
  ["Rust", "rust"],
  ["Rust", "rust-serde", "serde"],
  ["Swift", "swift"],
  ["Swift", "swift-codable", "codable"],
];

function tspCli(): string {
  const compilerEntry = require.resolve("@typespec/compiler");
  const compilerRoot = path.resolve(path.dirname(compilerEntry), "../..");
  return path.join(compilerRoot, "cmd", "tsp.js");
}

function compile(
  root: string,
  source: string,
  rootObject: string,
  targets: typeof TARGETS,
): string {
  const config = path.join(root, "tspconfig.yaml");
  const lines = [
    "emit:",
    '  - "@typra/emitter"',
    "options:",
    '  "@typra/emitter":',
    `    emitter-output-dir: ${JSON.stringify(path.join(root, "generated"))}`,
    `    root-object: ${JSON.stringify(rootObject)}`,
    "    deterministic-output: true",
    "    emit-targets:",
  ];
  for (const [type, dir, native] of targets) {
    lines.push(`      - type: ${type}`);
    lines.push(
      `        output-dir: ${JSON.stringify(path.join(root, "generated", dir))}`,
    );
    lines.push(
      `        test-dir: ${JSON.stringify(path.join(root, "generated", dir, "tests"))}`,
    );
    lines.push("        format: false");
    if (native) lines.push(`        native-serialization: ${native}`);
  }
  writeFileSync(config, [...lines, ""].join("\n"));
  const result = spawnSync(
    process.execPath,
    [tspCli(), "compile", source, "--config", config],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return `${result.stdout}${result.stderr}`;
}

function readTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else
        files.set(
          path.relative(dir, full).split(path.sep).join("/"),
          readFileSync(full, "utf8"),
        );
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

function pick(files: Map<string, string>, pattern: RegExp): string {
  const matches = [...files.entries()].filter(([name]) => pattern.test(name));
  assert.ok(
    matches.length > 0,
    `no generated file matches ${pattern}: ${[...files.keys()].join(", ")}`,
  );
  return matches.map(([, content]) => content).join("\n");
}

describe("required nullable fields `x: T | null` (#339)", () => {
  const fixture = path.resolve(
    process.cwd(),
    "fixtures",
    "features",
    "nullable",
    "main.tsp",
  );
  let root = "";
  let output = "";
  const generated = new Map<string, Map<string, string>>();

  before(() => {
    root = mkdtempSync(path.join(process.cwd(), "tmp-nullable-"));
    output = compile(
      root,
      fixture,
      "Typra.Fixtures.Features.Nullable.Root",
      TARGETS,
    );
    for (const [, dir] of TARGETS) {
      generated.set(dir, readTree(path.join(root, "generated", dir)));
    }
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const model = (dir: string, pattern: RegExp) =>
    pick(generated.get(dir)!, pattern);

  // Every shape the issue calls out: scalar, enum, model, arrays, and records.
  const NULLABLE = [
    "caption",
    "count",
    "mood",
    "detail",
    "tags",
    "details",
    "labels",
  ];
  const pascal = (key: string) => key[0].toUpperCase() + key.slice(1);

  it("compiles every nullable shape without diagnostics", () => {
    assert.match(output, /Compilation completed successfully/, output);
    assert.doesNotMatch(output, /unsupported-union-types|error/i, output);
  });

  it("TypeScript requires the key, accepts null, and always writes it", () => {
    for (const dir of ["typescript", "typescript-zod"]) {
      const source = model(dir, /^row\.ts$/);
      assert.match(source, /caption: string \| null = null;/);
      assert.match(source, /hint\?: string \| undefined;/);
      for (const key of NULLABLE) {
        assert.match(
          source,
          new RegExp(
            `if \\(data\\["${key}"\\] === undefined\\) \\{\\s*throw new Error\\(\`\\$\\{context\\.at\\("${key}"\\)\\.path\\}: missing required field\`\\)`,
          ),
          `${dir} ${key} load guard`,
        );
        assert.match(source, new RegExp(`result\\["${key}"\\] = null;`));
      }
      assert.doesNotMatch(source, /data\["hint"\] === undefined\) \{/);
      assert.doesNotMatch(source, /result\["hint"\] = null/);
    }
    const zod = model("typescript-zod", /^row\.ts$/);
    assert.match(zod, /caption: z\.string\(\)\.nullable\(\),/);
    assert.match(zod, /labels: z\.record\(z\.string\(\)\)\.nullable\(\),/);
    assert.match(zod, /hint: z\.string\(\)\.nullable\(\)\.optional\(\),/);
  });

  it("Python requires the key, accepts None, and always writes it", () => {
    for (const dir of ["python", "python-pydantic"]) {
      const source = model(dir, /_Row\.py$/);
      assert.match(source, /caption: str \| None = /);
      for (const key of NULLABLE) {
        assert.match(
          source,
          new RegExp(
            `if "${key}" not in data:\\s*raise ValueError\\(context\\.at\\("${key}"\\)\\.path \\+ ": missing required field"\\)`,
          ),
          `${dir} ${key} load guard`,
        );
        assert.match(source, new RegExp(`result\\["${key}"\\] = None`));
      }
      assert.match(source, /data\.get\("caption"\) is not None/);
      assert.doesNotMatch(source, /"hint" not in data/);
      assert.doesNotMatch(source, /result\["hint"\] = None/);
    }
  });

  it("Go uses pointers without omitempty and always writes the key", () => {
    const source = model("go", /^row\.go$/);
    assert.match(source, /Caption \*string\s+`json:"caption" yaml:"caption"`/);
    assert.match(source, /`json:"hint,omitempty" yaml:"hint,omitempty"`/);
    for (const key of NULLABLE) {
      assert.match(source, new RegExp(`json:"${key}" yaml:"${key}"`));
      assert.match(
        source,
        new RegExp(
          `if _, exists := m\\["${key}"\\]; !exists \\{\\s*return result, fmt\\.Errorf\\("%s: missing required field", ctx\\.At\\("${key}"\\)\\.Path\\)`,
        ),
        `go ${key} load guard`,
      );
      assert.match(
        source,
        new RegExp(
          `if obj\\.${pascal(key)} == nil \\{\\s*result\\["${key}"\\] = nil`,
        ),
      );
    }
    assert.match(source, /if val, ok := m\["caption"\]; ok && val != nil \{/);
  });

  it("C# uses nullable types, requires the key, and always writes it", () => {
    const source = model("csharp", /^Row\.cs$/);
    assert.match(source, /public string\? Caption \{ get; set; \}/);
    for (const key of NULLABLE) {
      assert.match(
        source,
        new RegExp(
          `if \\(!data\\.ContainsKey\\("${key}"\\)\\)\\s*\\{\\s*throw new ArgumentException\\(context!\\.At\\("${key}"\\)\\.Path \\+ ": missing required field"\\)`,
        ),
        `csharp ${key} load guard`,
      );
      assert.match(source, new RegExp(`result\\["${key}"\\] = null;`));
    }
    assert.doesNotMatch(source, /ContainsKey\("hint"\)/);
    assert.doesNotMatch(source, /result\["hint"\] = null/);
  });

  it("Java requires the key, accepts null, and always writes it", () => {
    for (const dir of ["java", "java-jackson"]) {
      const source = model(dir, /\/Row\.java$|^Row\.java$/);
      for (const key of NULLABLE) {
        assert.match(
          source,
          new RegExp(
            `if \\(!map\\.containsKey\\("${key}"\\)\\) \\{\\s*throw new IllegalArgumentException\\(ctx\\.at\\("${key}"\\)\\.path \\+ ": missing required field"\\)`,
          ),
          `${dir} ${key} load guard`,
        );
        assert.match(
          source,
          new RegExp(
            `if \\(obj\\.${key} == null\\) result\\.put\\("${key}", null\\);`,
          ),
        );
      }
      assert.doesNotMatch(source, /containsKey\("hint"\)\) \{\s*throw/);
      assert.doesNotMatch(source, /result\.put\("hint", null\)/);
    }
    const jackson = model("java-jackson", /\/Row\.java$|^Row\.java$/);
    assert.match(
      jackson,
      /@JsonProperty\("caption"\)\s*@JsonInclude\(JsonInclude\.Include\.ALWAYS\)/,
    );
    assert.match(
      jackson,
      /@JsonProperty\("hint"\)\s*@JsonInclude\(JsonInclude\.Include\.NON_NULL\)/,
    );
  });

  it("Rust uses Option without skipping the key on save", () => {
    for (const dir of ["rust", "rust-serde"]) {
      const source = model(dir, /\/row\.rs$|^row\.rs$/);
      assert.match(source, /pub caption: Option<String>/);
      for (const key of NULLABLE) {
        assert.match(
          source,
          new RegExp(
            `if value\\.as_object\\(\\)\\.map_or\\(false, \\|object\\| !object\\.contains_key\\("${key}"\\)\\) \\{`,
          ),
          `${dir} ${key} load guard`,
        );
        assert.match(
          source,
          new RegExp(
            `result\\.insert\\("${key}"\\.to_string\\(\\), serde_json::Value::Null\\);`,
          ),
        );
      }
      assert.doesNotMatch(source, /contains_key\("hint"\)/);
      assert.doesNotMatch(
        source,
        /insert\("hint"\.to_string\(\), serde_json::Value::Null\)/,
      );
      assert.doesNotMatch(source, /skip_serializing_if[^\n]*\n\s*pub caption/);
    }
  });

  it("Swift requires the key, accepts NSNull, and always writes it", () => {
    for (const dir of ["swift", "swift-codable"]) {
      const source = model(dir, /^Sources\/.*\/row\.swift$/);
      assert.match(source, /public var caption: String\?/);
      for (const key of NULLABLE) {
        assert.match(
          source,
          new RegExp(
            `if object\\["${key}"\\] == nil \\{\\s*throw TypraRuntimeError\\.unsupported\\(context\\.at\\("${key}"\\)\\.path \\+ ": missing required field"\\)`,
          ),
          `${dir} ${key} load guard`,
        );
        assert.match(
          source,
          new RegExp(
            `if let value = object\\["${key}"\\], !\\(value is NSNull\\) \\{`,
          ),
        );
        assert.match(source, new RegExp(`result\\["${key}"\\] = NSNull\\(\\)`));
      }
      // `x?: T | null` stays optional: an explicit null loads as unset, never written.
      assert.match(
        source,
        /if let value = object\["hint"\], !\(value is NSNull\) \{/,
      );
      assert.doesNotMatch(source, /object\["hint"\] == nil \{/);
      assert.doesNotMatch(source, /result\["hint"\] = NSNull\(\)/);
      // Plain optionals are unchanged.
      assert.match(source, /if let value = object\["note"\] \{/);
    }
  });

  // `Shape.label` is a required nullable field on a discriminated base; `Circle.center`
  // is the variant's own. Both must keep the contract through polymorphic dispatch, on
  // the derived loaders/savers, and on the unknown-discriminator carrier.
  describe("inherited required nullable fields", () => {
    const section = (source: string, start: string, end?: string): string => {
      const from = source.indexOf(start);
      assert.ok(from >= 0, `missing section ${start}`);
      const to = end ? source.indexOf(end, from + start.length) : -1;
      return source.slice(from, to > from ? to : undefined);
    };

    it("TypeScript derived loaders require the inherited key", () => {
      for (const dir of ["typescript", "typescript-zod"]) {
        const source = model(dir, /^shape\.ts$/);
        const guard = (key: string) =>
          new RegExp(
            `if \\(data\\["${key}"\\] === undefined\\) \\{\\s*throw new Error\\(\`\\$\\{context\\.at\\("${key}"\\)\\.path\\}: missing required field\`\\)`,
          );
        const shape = section(source, "export class Shape", "export class");
        const circle = section(source, "export class Circle", "export class");
        const square = section(source, "export class Square", "export class");
        assert.match(shape, guard("label"), `${dir} Shape label guard`);
        assert.match(circle, guard("label"), `${dir} Circle label guard`);
        assert.match(circle, guard("center"), `${dir} Circle center guard`);
        assert.match(square, guard("label"), `${dir} Square label guard`);
        assert.match(shape, /result\["label"\] = null;/);
        assert.match(circle, /result\["center"\] = null;/);
        assert.match(circle, /const result = super\.save\(context\);/);
        assert.match(square, /const result = super\.save\(context\);/);
      }
      const zod = model("typescript-zod", /^shape\.ts$/);
      assert.match(zod, /label: z\.string\(\)\.nullable\(\),/);
      assert.match(zod, /center: z\.number\(\)\.nullable\(\),/);
    });

    it("Python derived loaders require the inherited key", () => {
      for (const dir of ["python", "python-pydantic"]) {
        const source = model(dir, /_Shape\.py$/);
        const guard = (key: string) =>
          new RegExp(
            `if "${key}" not in data:\\s*raise ValueError\\(context\\.at\\("${key}"\\)\\.path \\+ ": missing required field"\\)`,
          );
        const shape = section(source, "class Shape", "\nclass ");
        const circle = section(source, "class Circle(Shape)", "\nclass ");
        const square = section(source, "class Square(Shape)");
        assert.match(shape, guard("label"), `${dir} Shape label guard`);
        assert.match(circle, guard("label"), `${dir} Circle label guard`);
        assert.match(circle, guard("center"), `${dir} Circle center guard`);
        assert.match(square, guard("label"), `${dir} Square label guard`);
        assert.match(shape, /result\["label"\] = None/);
        assert.match(circle, /result\["center"\] = None/);
        assert.match(circle, /result = super\(\)\.save\(context\)/);
        assert.match(square, /result = super\(\)\.save\(context\)/);
      }
    });

    it("Go flattened variants require and always write the inherited key", () => {
      const source = model("go", /^shape\.go$/);
      const guard = (key: string) =>
        new RegExp(
          `if _, exists := m\\["${key}"\\]; !exists \\{\\s*return result, fmt\\.Errorf\\("%s: missing required field", ctx\\.At\\("${key}"\\)\\.Path\\)`,
        );
      for (const name of ["Shape", "Circle", "Square"]) {
        const load = section(source, `func Load${name}(`, "\nfunc ");
        const save = section(source, `func (obj ${name}) Save(`, "\nfunc ");
        assert.match(load, guard("label"), `go ${name} label guard`);
        assert.match(save, /if obj\.Label == nil \{\s*result\["label"\] = nil/);
      }
      assert.match(
        section(source, "func LoadCircle(", "\nfunc "),
        guard("center"),
      );
      assert.match(
        section(source, "func (obj Circle) Save(", "\nfunc "),
        /if obj\.Center == nil \{\s*result\["center"\] = nil/,
      );
    });

    it("C# derived loaders require the inherited key", () => {
      const guard = (key: string) =>
        new RegExp(
          `if \\(!data\\.ContainsKey\\("${key}"\\)\\)\\s*\\{\\s*throw new ArgumentException\\(context!\\.At\\("${key}"\\)\\.Path \\+ ": missing required field"\\)`,
        );
      for (const name of ["Shape", "Circle", "Square"]) {
        assert.match(
          model("csharp", new RegExp(`^${name}\\.cs$`)),
          guard("label"),
          `csharp ${name} label guard`,
        );
      }
      const circle = model("csharp", /^Circle\.cs$/);
      assert.match(circle, guard("center"));
      assert.match(circle, /var result = base\.Save\(context\);/);
      assert.match(circle, /result\["center"\] = null;/);
      assert.match(
        model("csharp", /^Shape\.cs$/),
        /result\["label"\] = null;/,
      );
    });

    it("Java derived loaders delegate the inherited guard and save", () => {
      for (const dir of ["java", "java-jackson"]) {
        const shape = model(dir, /(^|\/)Shape\.java$/);
        const circle = model(dir, /(^|\/)Circle\.java$/);
        const square = model(dir, /(^|\/)Square\.java$/);
        assert.match(
          shape,
          /if \(!map\.containsKey\("label"\)\) \{\s*throw new IllegalArgumentException\(ctx\.at\("label"\)\.path \+ ": missing required field"\)/,
        );
        assert.match(
          shape,
          /if \(obj\.label == null\) result\.put\("label", null\);/,
        );
        for (const derived of [circle, square]) {
          assert.match(derived, /Shape\.loadBaseInto\(result, map, ctx\);/);
          assert.match(derived, /super\.saveFields\(result, ctx\);/);
        }
        assert.match(
          circle,
          /if \(!map\.containsKey\("center"\)\) \{\s*throw new IllegalArgumentException/,
        );
        assert.match(
          circle,
          /if \(obj\.center == null\) result\.put\("center", null\);/,
        );
      }
    });

    it("Java Jackson serializer keeps null keys under a NON_NULL mapper", () => {
      for (const name of ["Shape", "Circle", "Row"]) {
        const source = model(
          "java-jackson",
          new RegExp(`(^|/)${name}\\.java$`),
        );
        // Handing the save() map to `generator.writeObject` lets a mapper-level
        // `setSerializationInclusion(NON_NULL)` drop required nullable keys.
        assert.doesNotMatch(source, /generator\.writeObject\(/, name);
        assert.match(
          source,
          /writeTypraValue\(generator, serializers, value == null \? null : value\.save\(new SaveContext\(\)\)\);/,
          name,
        );
        assert.match(
          source,
          /if \(value == null\) \{\s*generator\.writeNull\(\);/,
        );
        assert.match(
          source,
          /generator\.writeFieldName\(String\.valueOf\(entry\.getKey\(\)\)\);\s*writeTypraValue\(generator, serializers, entry\.getValue\(\)\);/,
        );
      }
      assert.match(
        model("java-jackson", /tests?\/.*\.java$/),
        /setSerializationInclusion\(com\.fasterxml\.jackson\.annotation\.JsonInclude\.Include\.NON_NULL\)/,
      );
    });

    it("Rust validates the base key before discriminator dispatch", () => {
      for (const dir of ["rust", "rust-serde"]) {
        const source = model(dir, /(^|\/)shape\.rs$/);
        const validate = section(
          source,
          "fn validate_input_at(",
          "\n    }\n",
        );
        assert.match(
          validate,
          /!object\.contains_key\("label"\)\) \{[\s\S]*?missing required field[\s\S]*?let discriminator = value\.get\("kind"\)/,
          `${dir} label guard precedes dispatch (covers the Custom variant)`,
        );
        assert.match(
          validate,
          /"circle" => \{\s*if value\.as_object\(\)\.map_or\(false, \|object\| !object\.contains_key\("center"\)\)/,
        );
        assert.match(
          source,
          /result\.insert\("label"\.to_string\(\), serde_json::Value::Null\);/,
        );
        assert.match(
          source,
          /result\.insert\("center"\.to_string\(\), serde_json::Value::Null\);/,
        );
      }
    });

    it("Swift variants and the unknown carrier require the inherited key", () => {
      const guard = (key: string) =>
        new RegExp(
          `if object\\["${key}"\\] == nil \\{\\s*throw TypraRuntimeError\\.unsupported\\(context\\.at\\("${key}"\\)\\.path \\+ ": missing required field"\\)`,
        );
      for (const dir of ["swift", "swift-codable"]) {
        const source = model(dir, /^Sources\/.*\/shape\.swift$/);
        const shape = section(source, "public enum Shape", "\npublic ");
        const circle = section(source, "public struct Circle", "\npublic ");
        const square = section(source, "public struct Square", "\npublic ");
        // An unrecognized `kind` is carried raw, but the base key is still required.
        assert.match(
          shape,
          new RegExp(`default:\\s*${guard("label").source}[\\s\\S]*?return \\.unknown\\(object\\)`),
          `${dir} unknown carrier label guard`,
        );
        assert.doesNotMatch(shape, /default: return \.unknown\(object\)/);
        assert.match(circle, guard("label"), `${dir} Circle label guard`);
        assert.match(circle, guard("center"), `${dir} Circle center guard`);
        assert.match(square, guard("label"), `${dir} Square label guard`);
        for (const variant of [circle, square]) {
          assert.match(variant, /result\["label"\] = NSNull\(\)/);
        }
        assert.match(circle, /result\["center"\] = NSNull\(\)/);
      }
    });
  });

  it("generated round-trip tests assert the null key is saved", () => {
    assert.match(
      model("typescript", /tests\/row\.test\.ts$/),
      /hasOwnProperty\.call\(saved, "count"\)\)\.toBe\(true\);\s*expect\(saved\["count"\]\)\.toBe\(null\)/,
    );
    assert.match(
      model("python", /tests\/test_row\.py$/),
      /assert "caption" in saved_data/,
    );
    assert.match(
      model("go", /tests\/row_test\.go$/),
      /savedData\["caption"\]; !exists \|\| value != nil/,
    );
    assert.match(
      model("rust", /tests\/row_test\.rs$/),
      /\.get\("caption"\)\.map_or\(false, \|value\| value\.is_null\(\)\)/,
    );
  });

  it("generated variant samples carry the inherited required nullable key", () => {
    // Derived loaders require `label` even though Circle/Square never declare it, so every
    // generated round-trip payload for a variant must supply it (as null when unsampled).
    const variants: [string, RegExp][] = [
      ["typescript", /tests\/(circle|square)\.test\.ts$/],
      ["python", /tests\/test_(circle|square)\.py$/],
      ["go", /tests\/(circle|square)_test\.go$/],
      ["csharp", /tests\/(Circle|Square)ConversionTests\.cs$/],
      ["java", /tests\/(Circle|Square)GeneratedTest\.java$/],
    ];
    for (const [dir, pattern] of variants) {
      const files = [...generated.get(dir)!].filter(([name]) =>
        pattern.test(name),
      );
      assert.equal(files.length, 2, `${dir} variant tests`);
      for (const [name, source] of files) {
        assert.match(source, /\\?"label\\?": null/, `${dir} ${name}`);
      }
    }
  });
});
