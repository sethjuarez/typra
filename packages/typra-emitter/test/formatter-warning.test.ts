import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatFormatterWarning,
  warnFormatterUnavailable,
} from "../src/languages/formatter-warning.js";

describe("formatter-warning", () => {
  it("reports a missing formatter (ENOENT) as not found with an install hint", () => {
    const error = Object.assign(new Error("spawn swift-format ENOENT"), {
      code: "ENOENT",
    });
    const message = formatFormatterWarning(
      "swift-format",
      "/out/swift",
      error,
    );
    assert.match(message, /^Warning: swift-format not found;/);
    assert.match(message, /emitted deterministic fallback formatting/);
    assert.match(message, /Install swift-format/);
    assert.match(message, /\/out\/swift/);
  });

  it("reports a formatter that ran but errored as failed (no false 'not found')", () => {
    const error = Object.assign(new Error("exited with code 70"), {
      code: 70,
    });
    const message = formatFormatterWarning(
      "google-java-format",
      "/out/java",
      error,
    );
    assert.match(message, /^Warning: google-java-format failed for \/out\/java;/);
    assert.match(message, /emitted deterministic fallback formatting/);
    assert.doesNotMatch(message, /not found/);
  });

  it("names the requested tool so drift is attributable per language", () => {
    const enoent = { code: "ENOENT" };
    assert.match(
      formatFormatterWarning("swift-format", "/o", enoent),
      /swift-format/,
    );
    assert.match(
      formatFormatterWarning("google-java-format", "/o", enoent),
      /google-java-format/,
    );
  });

  it("logs the warning via console.warn (loud, not swallowed)", () => {
    const original = console.warn;
    const logged: string[] = [];
    console.warn = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      warnFormatterUnavailable("swift-format", "/out/swift", {
        code: "ENOENT",
      });
    } finally {
      console.warn = original;
    }
    assert.equal(logged.length, 1);
    assert.match(logged[0], /Warning: swift-format not found;/);
  });
});
