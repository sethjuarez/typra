/**
 * Deterministic TypeScript source reflow — makes native (`format:false`) emitter output already
 * conformant to `prettier` (default config, printWidth 80) so running the external formatter is a
 * byte-level no-op. This closes the "optional external formatter post-pass" reproducibility hole
 * (issue #238) for TypeScript: `format:true` and `format:false` then produce identical bytes.
 *
 * Scope is deliberately narrow — it reproduces only the style rules the emitter actually diverges
 * on, all validated against prettier as an oracle:
 *   1. Blank-line normalization (collapse runs; drop blanks hugging `{`/`}`; single trailing NL).
 *   2. `arrowParens: "always"` — a bare single-identifier arrow param gets parentheses.
 *   3. 80-column line wrapping (call/param/import explosion, `if` body demotion, binary-operator
 *      condition breaking, last-argument arrow expansion) matching prettier's right-hand split.
 *
 * It is intentionally conservative: any physical line it does not fully understand (unbalanced
 * brackets, string content) is passed through unchanged. The formatter-idempotency guard
 * (scripts/idempotency-guard.mjs) is the backstop — any residual drift fails validate:fixtures
 * loudly, so an approximate transform can never silently ship.
 */

const PRINT_WIDTH = 80;
const INDENT_UNIT = "  ";

/** Apply the full reflow to an emitted TypeScript file. */
export function formatTypeScriptSource(src: string): string {
  return normalizeBlankLines(
    wrapLongLines(unquoteObjectKeys(requoteStrings(addArrowParens(src)))),
  );
}

// ---------------------------------------------------------------------------
// String quote normalization (prettier default `quoteProps`/double-quote rule)
// ---------------------------------------------------------------------------

/**
 * Re-quote string literals to match prettier's default preference: double quotes, switching to
 * single quotes only when the value contains more double quotes than single quotes (fewer escapes).
 * Operates per physical line; template literals and comments are passed through untouched.
 */
function requoteStrings(src: string): string {
  return src.split("\n").map(requoteLine).join("\n");
}

function requoteLine(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    // Line comment — copy the remainder verbatim.
    if (c === "/" && line[i + 1] === "/") {
      out += line.slice(i);
      break;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let raw = "";
      let terminated = false;
      while (j < line.length) {
        if (line[j] === "\\") {
          raw += line[j] + (line[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          terminated = true;
          break;
        }
        raw += line[j];
        j++;
      }
      if (!terminated) {
        out += line.slice(i);
        break;
      }
      out += requoteLiteral(raw);
      i = j + 1;
    } else if (c === "`") {
      out += c;
      let j = i + 1;
      while (j < line.length && line[j] !== "`") {
        if (line[j] === "\\") {
          out += line[j] + (line[j + 1] ?? "");
          j += 2;
          continue;
        }
        out += line[j];
        j++;
      }
      if (j < line.length) {
        out += "`";
        j++;
      }
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Re-quote a single string literal body (escapes relative to the original quote preserved). */
function requoteLiteral(raw: string): string {
  const units: { ch: string | null; text: string }[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "\\") {
      const nx = raw[i + 1];
      let ch: string | null = null;
      if (nx === '"') ch = '"';
      else if (nx === "'") ch = "'";
      units.push({ ch, text: raw.slice(i, i + 2) });
      i += 2;
    } else {
      units.push({ ch: raw[i], text: raw[i] });
      i++;
    }
  }
  const numDouble = units.filter((u) => u.ch === '"').length;
  const numSingle = units.filter((u) => u.ch === "'").length;
  const target = numDouble > numSingle ? "'" : '"';
  let body = "";
  for (const u of units) {
    if (u.ch === '"') body += target === '"' ? '\\"' : '"';
    else if (u.ch === "'") body += target === "'" ? "\\'" : "'";
    else body += u.text;
  }
  return target + body + target;
}

// ---------------------------------------------------------------------------
// Object-key quote normalization (prettier `quoteProps: "as-needed"`)
// ---------------------------------------------------------------------------

/**
 * Remove quotes from object-literal property keys that are valid identifiers, matching prettier's
 * default `quoteProps: "as-needed"`. Only touches a `"key":` that sits in key position (the previous
 * non-space token is `{` or `,`), so index accesses like `data["key"]` and `case "x":` are left
 * alone. Reserved words are legal as unquoted property names, so `"default"` → `default`.
 */
function unquoteObjectKeys(src: string): string {
  const lines = src.split("\n");
  let prevTail = ""; // last non-space char of the previous emitted line
  const out = lines.map((line) => {
    const result = unquoteObjectKeysLine(line, prevTail);
    const trimmed = result.replace(/\s+$/, "");
    if (trimmed.length > 0) prevTail = trimmed[trimmed.length - 1];
    return result;
  });
  return out.join("\n");
}

/**
 * Unquote object-literal keys on a single physical line. `prevTail` is the last non-space character
 * of the previous line, used when a key sits at the start of a continuation line (its `{`/`,`
 * separator is on the line above).
 */
function unquoteObjectKeysLine(line: string, prevTail: string): string {
  const mask = stringMask(line);
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (mask[i]) {
      let j = i;
      while (j < line.length && mask[j]) j++;
      const runEnd = j - 1;
      if (line[i] === '"' && line[runEnd] === '"' && runEnd > i) {
        const inner = line.slice(i + 1, runEnd);
        let p = out.length - 1;
        while (p >= 0 && /\s/.test(out[p])) p--;
        const before = p >= 0 ? out[p] : prevTail;
        let n = j;
        while (n < line.length && /[ \t]/.test(line[n])) n++;
        const afterIsColon = line[n] === ":" && line[n + 1] !== ":";
        if (
          (before === "{" || before === ",") &&
          afterIsColon &&
          /^[A-Za-z_$][\w$]*$/.test(inner)
        ) {
          out += inner;
          i = j;
          continue;
        }
      }
      out += line.slice(i, j);
      i = j;
      continue;
    }
    out += line[i];
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// String / comment awareness
// ---------------------------------------------------------------------------

/**
 * Mark every character that is inside a string/template literal (including its quotes) or a `//`
 * or `/* *\/` comment. Used so bracket/comma/operator scanning ignores punctuation that lives
 * inside strings. Assumes the line's own literals are balanced (true for the emitter's single
 * statements). Template `${...}` substitutions are treated as string content (masked) — the
 * emitter never breaks a line inside a template placeholder.
 */
function stringMask(s: string): boolean[] {
  const mask = new Array<boolean>(s.length).fill(false);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const delim = c;
      const start = i;
      i += 1;
      while (i < s.length) {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === delim) {
          i += 1;
          break;
        }
        i++;
      }
      for (let j = start; j < Math.min(i, s.length); j++) mask[j] = true;
    } else if (c === "/" && s[i + 1] === "/") {
      for (let j = i; j < s.length; j++) mask[j] = true;
      break;
    } else if (c === "/" && s[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i = Math.min(i + 2, s.length);
      for (let j = start; j < i; j++) mask[j] = true;
    } else {
      i++;
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------
// arrowParens: "always"
// ---------------------------------------------------------------------------

/**
 * Wrap a bare single-identifier arrow parameter in parentheses: `item => …` → `(item) => …`.
 * Operates outside strings/comments. A param already parenthesized (`(item) =>`), destructured
 * (`{a} =>`, `[a] =>`), or typed is left untouched.
 */
function addArrowParens(src: string): string {
  return src
    .split("\n")
    .map((line) => addArrowParensLine(line))
    .join("\n");
}

function addArrowParensLine(line: string): string {
  const mask = stringMask(line);
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (!mask[i] && line[i] === "=" && line[i + 1] === ">") {
      // Look back over whitespace to the token preceding `=>`.
      let j = out.length - 1;
      while (j >= 0 && (out[j] === " " || out[j] === "\t")) j--;
      // Collect a trailing identifier.
      let k = j;
      while (k >= 0 && /[\w$]/.test(out[k])) k--;
      const ident = out.slice(k + 1, j + 1);
      const before = k >= 0 ? out[k] : "";
      const isBareIdent =
        ident.length > 0 &&
        /^[a-zA-Z_$][\w$]*$/.test(ident) &&
        before !== ")" &&
        before !== "." &&
        // not a keyword that can precede `=>` without being a param
        ident !== "return";
      if (isBareIdent) {
        const head = out.slice(0, k + 1);
        const ws = out.slice(j + 1);
        out = `${head}(${ident})${ws}`;
      }
      out += "=>";
      i += 2;
      continue;
    }
    out += line[i];
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line wrapping (prettier right-hand split at printWidth 80)
// ---------------------------------------------------------------------------

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
]);

/** Leading whitespace of a line. */
function leadingWhitespace(line: string): string {
  const m = /^\s*/.exec(line);
  return m ? m[0] : "";
}

/**
 * Split a bracket-body string on top-level commas (depth 0, outside strings). Returns trimmed
 * segments; a trailing empty segment (from a magic trailing comma) is dropped.
 */
function splitTopCommas(body: string): string[] {
  const mask = stringMask(body);
  const parts: string[] = [];
  let depth = 0;
  let generic = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (mask[i]) continue;
    const c = body[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "<" && /[\w$]/.test(body[i - 1] ?? "")) generic++;
    else if (c === ">" && generic > 0 && body[i - 1] !== "=") generic--;
    else if (c === "," && depth === 0 && generic === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  const trimmed = parts.map((p) => p.trim());
  if (trimmed.length > 1 && trimmed[trimmed.length - 1] === "") trimmed.pop();
  return trimmed;
}

/** Index of the matching close bracket for the opener at `open`, or -1. */
function matchClose(s: string, open: number, mask: boolean[]): number {
  const openCh = s[open];
  const closeCh = openCh === "(" ? ")" : openCh === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (mask[i]) continue;
    if (s[i] === openCh) depth++;
    else if (s[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Find the outermost *call* argument group — the `(` at the shallowest bracket depth that is an
 * invocation (preceded by an identifier, `)`, `]`, or `>`), skipping control-flow headers like
 * `for (`/`if (`. Returns the opener/closer indices, or null when there is no call to break.
 */
function findCallGroup(
  content: string,
  mask: boolean[],
): { open: number; close: number } | null {
  let depth = 0;
  let best: { open: number; close: number; depth: number } | null = null;
  for (let i = 0; i < content.length; i++) {
    if (mask[i]) continue;
    const c = content[i];
    if (c === "(" || c === "[" || c === "{") {
      if (c === "(") {
        let j = i - 1;
        while (j >= 0 && /\s/.test(content[j])) j--;
        const prev = j >= 0 ? content[j] : "";
        // Identify the word immediately before `(`.
        let k = j;
        while (k >= 0 && /[\w$]/.test(content[k])) k--;
        const word = content.slice(k + 1, j + 1);
        const isCall =
          (/[\w$)\]>]/.test(prev) || false) && !CONTROL_KEYWORDS.has(word);
        if (isCall) {
          const close = matchClose(content, i, mask);
          if (close !== -1 && (best === null || depth < best.depth)) {
            best = { open: i, close, depth };
          }
        }
      }
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
    }
  }
  return best ? { open: best.open, close: best.close } : null;
}

/**
 * All call groups at the shallowest call depth, in source order. Used to reproduce prettier's
 * member-chain layout: for `head(a).tail(b)` prettier explodes the *last* call whose head line
 * still fits, keeping the chain prefix on the first line.
 */
function findCallGroups(
  content: string,
  mask: boolean[],
): { open: number; close: number; depth: number }[] {
  let depth = 0;
  const groups: { open: number; close: number; depth: number }[] = [];
  for (let i = 0; i < content.length; i++) {
    if (mask[i]) continue;
    const c = content[i];
    if (c === "(" || c === "[" || c === "{") {
      if (c === "(") {
        let j = i - 1;
        while (j >= 0 && /\s/.test(content[j])) j--;
        const prev = j >= 0 ? content[j] : "";
        let k = j;
        while (k >= 0 && /[\w$]/.test(content[k])) k--;
        const word = content.slice(k + 1, j + 1);
        const isCall = /[\w$)\]>]/.test(prev) && !CONTROL_KEYWORDS.has(word);
        if (isCall) {
          const close = matchClose(content, i, mask);
          if (close !== -1) groups.push({ open: i, close, depth });
        }
      }
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
    }
  }
  if (groups.length === 0) return [];
  const minDepth = Math.min(...groups.map((g) => g.depth));
  return groups.filter((g) => g.depth === minDepth);
}

/**
 * Pick the call group prettier would explode for a member chain: the last shallowest-depth call
 * whose head line (everything up to and including its `(`) fits within printWidth. Falls back to the
 * first such call when none of the later heads fit.
 */
function selectChainCall(
  indent: string,
  content: string,
  mask: boolean[],
): { open: number; close: number } | null {
  const groups = findCallGroups(content, mask);
  if (groups.length === 0) return null;
  for (let i = groups.length - 1; i >= 0; i--) {
    const head = indent + content.slice(0, groups[i].open + 1);
    if (head.length <= PRINT_WIDTH) {
      return { open: groups[i].open, close: groups[i].close };
    }
  }
  return { open: groups[0].open, close: groups[0].close };
}

/** Reproduce prettier's `({ … } as T)` → `({ … }) as T` normalization inside an arrow body. */
function reparenthesizeAsCast(s: string): string {
  const t = s.trim();
  const m = /^\(\s*(\{.*\})\s+as\s+(.+)\)$/.exec(t);
  if (!m) return s;
  // Ensure the inner object brackets are balanced (the regex is greedy but simple shapes only).
  const inner = m[1];
  const mask = stringMask(inner);
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (mask[i]) continue;
    if (inner[i] === "{") depth++;
    else if (inner[i] === "}") depth--;
    if (depth < 0) return s;
  }
  if (depth !== 0) return s;
  return `(${inner}) as ${m[2]}`;
}

/**
 * Wrap a single logical statement to printWidth 80, returning one or more physical lines. Applies
 * prettier's right-hand split: demote `if`/`while` bodies, break binary conditions/expressions, and
 * explode the outermost call's arguments (with last-argument arrow expansion). Falls back to the
 * unchanged line when no confident break exists (prettier leaves unbreakable long lines alone).
 */
function wrapStatement(
  indent: string,
  content: string,
  reserve = 0,
): string[] {
  const line = indent + content;
  if (line.length + reserve <= PRINT_WIDTH) return [line];

  const mask = stringMask(content);

  // Control header with a single-statement body: `if (cond) body;` / `for (…) body;`.
  const ctl = /^(if|while|else if|\} else if|for|for await)\s*\(/.exec(content);
  if (ctl) {
    const parenOpen = content.indexOf("(");
    const parenClose = matchClose(content, parenOpen, mask);
    if (parenClose !== -1) {
      const after = content.slice(parenClose + 1).trim();
      const header = content.slice(0, parenClose + 1);
      if (after !== "" && after !== "{") {
        // Non-block body: demote it to the next line if the header fits.
        if ((indent + header).length <= PRINT_WIDTH) {
          return [
            indent + header,
            ...wrapStatement(indent + INDENT_UNIT, after),
          ];
        }
      }
      // `for (…)` conditions are not operator-broken (the `;`/`of`/`in` structure is not a boolean).
      if (
        !/^for\b/.test(content) &&
        ((indent + header).length > PRINT_WIDTH || after === "{")
      ) {
        // Break the condition on its lowest-precedence operator (uniform inner indent).
        const cond = content.slice(parenOpen + 1, parenClose);
        const broken = breakConditionUniform(indent + INDENT_UNIT, cond);
        if (broken) {
          const head = content.slice(0, parenOpen + 1); // up to `(`
          const tail = content.slice(parenClose); // `)` + suffix
          return [indent + head, ...broken, indent + tail];
        }
      }
    }
  }

  // Import / export specifier list: explode the `{ … }`.
  if (/^(import|export)\b/.test(content) && content.includes("{")) {
    const braceOpen = content.indexOf("{");
    const braceClose = matchClose(content, braceOpen, mask);
    if (braceClose !== -1) {
      const names = splitTopCommas(content.slice(braceOpen + 1, braceClose));
      if (names.length >= 2) {
        const head = content.slice(0, braceOpen + 1);
        const tail = content.slice(braceClose);
        return [
          indent + head,
          ...names.map((n) => `${indent}${INDENT_UNIT}${n},`),
          indent + tail,
        ];
      }
    }
  }

  // Trailing generic cast `… as Type<argA, argB>` — prettier explodes the type argument list.
  const genericAs = tryGenericAsExplode(indent, content);
  if (genericAs) return genericAs;

  // Generic instantiation right-hand side `lhs = Name<argA, argB>;` — prettier explodes the type
  // argument list rather than breaking after `=` (e.g. `type X = z.infer<typeof …>`).
  const genericAssign = tryGenericAssignExplode(indent, content, mask);
  if (genericAssign) return genericAssign;

  // Member-access tail `(…).member` — break before the final `.member` (prettier member chain).
  const member = tryMemberBreak(indent, content, mask);
  if (member) return member;

  // Function-type / arrow parameter list `(a, b) => ret` whose return type is atomic — explode the
  // parameters (prettier's only break point, e.g. an interface method-signature member).
  const arrowParams = tryArrowParamsExplode(indent, content, mask);
  if (arrowParams) return arrowParams;

  // Assignment with a plain right-hand side that fits one indent deeper — break after `=`.
  const assign = tryAssignmentBreak(indent, content, mask);
  if (assign) return assign;

  // Property/assignment whose value is a conditional (ternary) — prettier demotes the whole value to
  // the next line rather than breaking the ternary's condition operator.
  const condValue = tryConditionalValueBreak(indent, content, mask);
  if (condValue) return condValue;

  // Top-level binary expression (string concatenation, comparison chain) — break at the operator
  // before diving into any call, matching prettier. Skipped for assignments (their RHS call breaks).
  if (!hasTopLevelAssignment(content, mask)) {
    const bin = breakBinaryExpr(indent, content);
    if (bin) return bin;
  }

  // A bare top-level object/array literal (its opener at depth 0) explodes before any nested call —
  // prettier breaks the outermost collection first.
  if (content[0] === "[" || content[0] === "{") {
    const bareLiteral = tryLiteralExplode(indent, content, mask);
    if (bareLiteral) return bareLiteral;
  }

  // A bare arrow whose body is an object/array literal — render `params => [` and explode the body
  // (prettier's arrow expansion when the arrow sits on its own exploded-argument line).
  const bareArrow = matchArrow(content);
  if (bareArrow) {
    const bt = bareArrow.body.trim();
    const stripped = stripOuterParens(bt);
    if ((bt[0] === "[" || bt[0] === "{") && isHuggableBody(stripped)) {
      const exploded = wrapStatement(indent, bareArrow.body, PRINT_WIDTH);
      if (exploded.length > 1) {
        return [
          `${indent}${bareArrow.params} => ${exploded[0].trim()}`,
          ...exploded.slice(1),
        ];
      }
    }
  }

  // Outermost call argument list (member-chain aware: explode the last call whose head fits).
  const call = selectChainCall(indent, content, mask);
  if (call) {
    const head = content.slice(0, call.open + 1); // up to and including `(`
    const suffix = content.slice(call.close); // `)` + trailing (`;`, `) {`, `));`, …)
    const argsBody = content.slice(call.open + 1, call.close);
    const args = splitTopCommas(argsBody);
    if (args.length > 0 && args[0] !== "") {
      const inner = indent + INDENT_UNIT;
      const last = args[args.length - 1];
      const arrow = matchArrow(last);

      if (arrow) {
        const lead = args
          .slice(0, args.length - 1)
          .map((a) => a + ", ")
          .join("");
        const headLine = `${indent}${head}${lead}${arrow.params} =>`;
        // Hug the arrow when its body is a single breakable group (call/object/array/…): prettier
        // keeps `callee(…params =>` on the first line. A binary/logical or `as`-cast body is
        // exploded onto its own line instead. Strip one wrapping paren layer so `(x as T)` casts
        // are recognised.
        const stripped = stripOuterParens(arrow.body);
        const huggable =
          isHuggableBody(stripped) &&
          findBinarySplits(arrow.body, stringMask(arrow.body)) === null &&
          !hasTopLevelAs(stripped, stringMask(stripped));
        if (huggable && headLine.length <= PRINT_WIDTH) {
          const bodyTrim = arrow.body.trim();
          // A bare object/array-literal body hugs its opening bracket onto the `=>` line and
          // explodes at the call indent (prettier's last-arg array/object expansion).
          if (bodyTrim[0] === "[" || bodyTrim[0] === "{") {
            const exploded = wrapStatement(indent, arrow.body, PRINT_WIDTH);
            if (exploded.length > 1) {
              return [
                `${headLine} ${exploded[0].trim()}`,
                ...exploded.slice(1, -1),
                `${indent}${exploded[exploded.length - 1].trim()}${suffix}`,
              ];
            }
          }
          const bodyLines = wrapStatement(inner, arrow.body, 1);
          return [
            headLine,
            ...bodyLines.slice(0, -1),
            appendComma(bodyLines[bodyLines.length - 1]),
            indent + suffix,
          ];
        }
        // Standard explode: render the arrow flat on its own line when it fits.
        const flat = `${inner}${renderArrowFlat(last)},`;
        if (flat.length <= PRINT_WIDTH) {
          const out = [indent + head];
          for (let i = 0; i < args.length - 1; i++) {
            pushExplodedArg(out, inner, args[i]);
          }
          out.push(flat);
          out.push(indent + suffix);
          return out;
        }
        // Body too long to sit flat — break it under a hugged head when the head still fits.
        if (headLine.length <= PRINT_WIDTH) {
          const bodyLines = wrapStatement(inner, arrow.body, 1);
          return [
            headLine,
            ...bodyLines.slice(0, -1),
            appendComma(bodyLines[bodyLines.length - 1]),
            indent + suffix,
          ];
        }
        // Head overflows — fall through to standard explosion (arrow on its own exploded line).
      }

      // Standard explode: every argument on its own line with a trailing comma.
      const out = [indent + head];
      for (const a of args) pushExplodedArg(out, inner, a);
      out.push(indent + suffix);
      return out;
    }
  }

  // Bare object/array literal (no enclosing call) — explode its members, e.g. a long
  // `key: { a: 1, b: 2 }` property value.
  const literal = tryLiteralExplode(indent, content, mask);
  if (literal) return literal;

  return [line];
}

/**
 * Explode a top-level arrow/function-type parameter list `(a, b) => ret` when the return type is
 * atomic (no further breakable group), matching prettier's parameter expansion for long function-type
 * signatures. Null when the statement is not such a form or its head does not fit.
 */
function tryArrowParamsExplode(
  indent: string,
  content: string,
  mask: boolean[],
): string[] | null {
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    if (mask[i]) continue;
    const c = content[i];
    if (c === "(") {
      if (depth === 0) {
        const close = matchClose(content, i, mask);
        if (close === -1) return null;
        const after = content.slice(close + 1).replace(/^\s*/, "");
        if (after.startsWith("=>")) {
          // Only when the return type is atomic (no breakable group to explode instead).
          const ret = after.slice(2).replace(/;$/, "");
          if (/[([{]/.test(ret)) return null;
          const params = splitTopCommas(content.slice(i + 1, close));
          if (params.length === 0 || params[0].trim() === "") return null;
          const headLine = indent + content.slice(0, i + 1);
          if (headLine.length > PRINT_WIDTH) return null;
          const inner = indent + INDENT_UNIT;
          const out = [headLine];
          for (const p of params) out.push(`${inner}${p.trim()},`);
          out.push(indent + content.slice(close));
          return out;
        }
        return null;
      }
      depth++;
    } else if (c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
    }
  }
  return null;
}

/**
 * Break a `key: <cond ? a : b>` property or `lhs = <cond ? a : b>` assignment whose value is a
 * conditional (ternary) by demoting the entire value onto the next line at one deeper indent —
 * prettier prefers this over breaking the ternary's condition. Null when there is no property colon /
 * assignment split, the value is not a top-level ternary, or the head does not fit.
 */
function tryConditionalValueBreak(
  indent: string,
  content: string,
  mask: boolean[],
): string[] | null {
  let depth = 0;
  let split = -1;
  let splitLen = 1;
  for (let i = 0; i < content.length; i++) {
    if (mask[i]) continue;
    const c = content[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?") break; // ternary reached before any split point
    else if (depth === 0 && c === ":") {
      split = i;
      splitLen = 1;
      break;
    } else if (
      depth === 0 &&
      c === "=" &&
      content[i + 1] !== "=" &&
      content[i - 1] !== "=" &&
      content[i - 1] !== "!" &&
      content[i - 1] !== "<" &&
      content[i - 1] !== ">" &&
      content[i + 1] !== ">"
    ) {
      split = i;
      splitLen = 1;
      break;
    }
  }
  if (split === -1) return null;
  const value = content.slice(split + splitLen).trim();
  if (!hasTopLevelTernary(value)) return null;
  const head = indent + content.slice(0, split + splitLen).trimEnd();
  if (head.length > PRINT_WIDTH) return null;
  return [head, ...wrapStatement(indent + INDENT_UNIT, value)];
}

/** True when `text` contains a top-level ternary conditional (a ` ? ` not nested in a group). */
function hasTopLevelTernary(text: string): boolean {
  const mask = stringMask(text);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) continue;
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (
      depth === 0 &&
      c === "?" &&
      text[i + 1] === " " &&
      text[i - 1] === " "
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Explode a top-level object/array literal that has no enclosing call, one member per line with a
 * trailing comma (prettier's collection layout). Object literals are only exploded in value position
 * (preceded by `:`/`(`/`[`/`,`/`=`/`return`) so statement blocks are left to the caller. Null when
 * there is no such literal or its head line would not fit.
 */
function tryLiteralExplode(
  indent: string,
  content: string,
  mask: boolean[],
): string[] | null {
  let depth = 0;
  let openIdx = -1;
  for (let i = 0; i < content.length && openIdx === -1; i++) {
    if (mask[i]) continue;
    const c = content[i];
    if (c === "{" || c === "[" || c === "(") {
      if (depth === 0 && (c === "{" || c === "[")) {
        if (c === "[") {
          openIdx = i;
        } else {
          let j = i - 1;
          while (j >= 0 && /\s/.test(content[j])) j--;
          const prev = j >= 0 ? content[j] : "";
          let k = j;
          while (k >= 0 && /[\w$]/.test(content[k])) k--;
          const word = content.slice(k + 1, j + 1);
          if (
            prev === ":" ||
            prev === "(" ||
            prev === "[" ||
            prev === "," ||
            prev === "=" ||
            prev === "" ||
            word === "return"
          ) {
            openIdx = i;
          }
        }
      }
      depth++;
    } else if (c === "}" || c === "]" || c === ")") {
      depth--;
    }
  }
  if (openIdx === -1) return null;
  const close = matchClose(content, openIdx, mask);
  if (close === -1) return null;
  const head = content.slice(0, openIdx + 1);
  const suffix = content.slice(close);
  const members = splitTopCommas(content.slice(openIdx + 1, close));
  if (members.length === 0 || members[0].trim() === "") return null;
  const headLine = indent + head;
  if (headLine.length > PRINT_WIDTH) return null;
  const inner = indent + INDENT_UNIT;
  const out = [headLine];
  for (const m of members) pushExplodedArg(out, inner, m.trim());
  out.push(indent + suffix);
  return out;
}

/**
 * Break a trailing `… as Type<a, b>` cast by exploding the generic type arguments (prettier keeps
 * the left side flat and puts each type argument on its own line, no trailing comma). Null when the
 * statement is not such a cast or the left side does not fit.
 */
function tryGenericAsExplode(indent: string, content: string): string[] | null {
  const m = /^(.*) as ([A-Za-z_$][\w$.]*)<(.+)>(;?)$/.exec(content);
  if (!m) return null;
  const [, head, type, inner, semi] = m;
  // The captured inner must have balanced angle brackets (greedy `.+` grabs to the final `>`).
  const innerMask = stringMask(inner);
  let angle = 0;
  for (let i = 0; i < inner.length; i++) {
    if (innerMask[i]) continue;
    if (inner[i] === "<") angle++;
    else if (inner[i] === ">") angle--;
    if (angle < 0) return null;
  }
  if (angle !== 0) return null;
  const openLine = `${indent}${head} as ${type}<`;
  if (openLine.length > PRINT_WIDTH) return null;
  const args = splitTopCommas(inner);
  if (args.length === 0 || args[0] === "") return null;
  const out = [openLine];
  args.forEach((a, i) => {
    out.push(`${indent}${INDENT_UNIT}${a}${i < args.length - 1 ? "," : ""}`);
  });
  out.push(`${indent}>${semi}`);
  return out;
}

/**
 * Break a generic instantiation right-hand side `lhs = Name<a, b>;` by exploding the type argument
 * list (prettier keeps `lhs = Name<` on the first line, one argument per line, no trailing comma).
 * Used for `type XWire = z.infer<typeof …>` aliases. Null when the statement is not such a form.
 */
function tryGenericAssignExplode(
  indent: string,
  content: string,
  mask: boolean[],
): string[] | null {
  // Require a top-level `=` (assignment or type alias) with no `(` call on the right side.
  let depth = 0;
  let eq = -1;
  for (let i = 0; i < content.length && eq === -1; i++) {
    if (mask[i]) continue;
    const c = content[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    else if (depth === 0 && c === "=") {
      const prev = content[i - 1];
      const next = content[i + 1];
      if (next !== "=" && prev !== "=" && prev !== "!" && prev !== "<") eq = i;
    }
  }
  if (eq === -1) return null;
  const rhs = content.slice(eq + 1).trim();
  const m = /^([A-Za-z_$][\w$.]*)<(.+)>(;?)$/.exec(rhs);
  if (!m) return null;
  const [, type, inner, semi] = m;
  const innerMask = stringMask(inner);
  let angle = 0;
  for (let i = 0; i < inner.length; i++) {
    if (innerMask[i]) continue;
    if (inner[i] === "<") angle++;
    else if (inner[i] === ">") angle--;
    if (angle < 0) return null;
  }
  if (angle !== 0) return null;
  const lhs = content.slice(0, eq).trimEnd();
  const openLine = `${indent}${lhs} = ${type}<`;
  if (openLine.length > PRINT_WIDTH) return null;
  const args = splitTopCommas(inner);
  if (args.length === 0 || args[0] === "") return null;
  const out = [openLine];
  args.forEach((a, i) => {
    out.push(`${indent}${INDENT_UNIT}${a}${i < args.length - 1 ? "," : ""}`);
  });
  out.push(`${indent}>${semi}`);
  return out;
}

/**
 * Break before a trailing simple property access on a parenthesized receiver — `(…).prop` becomes
 * `(…)` then `.prop` at one indent deeper (prettier's member-chain break). Restricted to a bare
 * `.identifier` tail (no call/args) so the call-group rule keeps ownership of method invocations.
 */
function tryMemberBreak(
  indent: string,
  content: string,
  mask: boolean[],
): string[] | null {
  let depth = 0;
  let dot = -1;
  for (let i = 0; i < content.length; i++) {
    if (mask[i]) continue;
    const c = content[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "." && content[i - 1] === ")") dot = i;
  }
  if (dot === -1) return null;
  const tail = content.slice(dot);
  if (!/^\.[A-Za-z_$][\w$]*;?$/.test(tail)) return null;
  const head = content.slice(0, dot);
  const headLine = indent + head;
  const tailLine = indent + INDENT_UNIT + tail;
  if (headLine.length > PRINT_WIDTH || tailLine.length > PRINT_WIDTH) return null;
  return [headLine, tailLine];
}

/**
 * Break an assignment after `=` (prettier's broken-after-operator layout). Prettier keeps
 * `lhs = callee(` on the first line and explodes the call when that head fits within 80; it only
 * breaks after `=` when even the call head overflows (or the right side has no call to explode). In
 * the break case the right side is recursively wrapped one indent deeper. Null when there is no
 * top-level assignment or breaking after `=` would not help.
 */
function tryAssignmentBreak(
  indent: string,
  content: string,
  mask: boolean[],
): string[] | null {
  let depth = 0;
  let eq = -1;
  for (let i = 0; i < content.length && eq === -1; i++) {
    if (mask[i]) continue;
    const c = content[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "=") {
      const prev = content[i - 1];
      const next = content[i + 1];
      if (
        next !== "=" &&
        next !== ">" &&
        prev !== "=" &&
        prev !== "!" &&
        prev !== "<" &&
        prev !== ">"
      ) {
        eq = i;
      }
    }
  }
  if (eq === -1) return null;
  const lhs = content.slice(0, eq).trimEnd();
  const rhs = content.slice(eq + 1).trim();
  const inner = indent + INDENT_UNIT;

  // Prettier never breaks after `=` onto an unbreakable literal (template/string): it keeps the
  // assignment on one line even past printWidth.
  if (rhs[0] === "`" || rhs[0] === '"' || rhs[0] === "'") return null;

  const call = findCallGroup(content, mask);
  if (call) {
    const args = splitTopCommas(content.slice(call.open + 1, call.close));
    const singleNonArrow =
      args.length === 1 && args[0].trim() !== "" && !matchArrow(args[0]);
    const rhsLine = `${inner}${rhs}`;
    // A single (non-arrow) argument call is kept whole after `=` rather than exploded, provided it
    // fits one indent deeper.
    if (singleNonArrow && rhsLine.length <= PRINT_WIDTH) {
      return [`${indent}${lhs} =`, rhsLine];
    }
    // The call head `lhs = …callee(` — if it fits, keep it on line 1 and let the call explode.
    const headLine = indent + content.slice(0, call.open + 1);
    if (headLine.length <= PRINT_WIDTH) return null;
    // Head overflows: break after `=` and wrap the right side one indent deeper.
    return [`${indent}${lhs} =`, ...wrapStatement(inner, rhs)];
  }

  // No call to explode — move the whole right side onto the next line if it then fits.
  const rhsLine = `${inner}${rhs}`;
  if (rhsLine.length > PRINT_WIDTH || (indent + lhs + " =").length > PRINT_WIDTH) {
    return null;
  }
  return [`${indent}${lhs} =`, rhsLine];
}

/** Push argument lines onto `out`, appending a trailing comma to the last line only. */
function pushArg(out: string[], lines: string[]): void {
  for (let i = 0; i < lines.length; i++) {
    out.push(i === lines.length - 1 ? appendComma(lines[i]) : lines[i]);
  }
}

/**
 * Render one exploded call/array argument at `inner` with its trailing comma. The comma is included
 * in the width budget: an argument that fits flat only without its comma is still broken, matching
 * prettier (which counts the comma when deciding whether the element fits).
 */
function pushExplodedArg(out: string[], inner: string, arg: string): void {
  pushArg(out, wrapStatement(inner, arg, 1));
}

/** Strip one layer of wrapping parentheses when they enclose the whole expression. */
function stripOuterParens(expr: string): string {
  const t = expr.trim();
  if (t[0] !== "(") return t;
  const mask = stringMask(t);
  const close = matchClose(t, 0, mask);
  if (close === t.length - 1) return t.slice(1, close).trim();
  return t;
}

/**
 * Whether prettier would hug an arrow body onto the `=>` line. Only object/array/template literals
 * and call expressions hug; a bare identifier or member access (e.g. `X.wireObjectSchema`) is
 * exploded onto its own line instead.
 */
function isHuggableBody(stripped: string): boolean {
  const t = stripped.trim();
  if (t === "") return false;
  if (t[0] === "{" || t[0] === "[" || t[0] === "`") return true;
  // Call expression: ends with a `)` that closes a top-level call.
  if (t.endsWith(")")) {
    const mask = stringMask(t);
    const call = findCallGroup(t, mask);
    if (call && call.close === t.length - 1) return true;
  }
  return false;
}

/** Whether the expression has a top-level ` as ` type cast (outside brackets/strings). */
function hasTopLevelAs(expr: string, mask: boolean[]): boolean {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (mask[i]) continue;
    const c = expr[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (
      depth === 0 &&
      expr[i - 1] === " " &&
      expr.slice(i, i + 3) === "as " &&
      (i === 0 || /[\w$)\]}"'`]/.test(expr[i - 2]))
    ) {
      return true;
    }
  }
  return false;
}

/** Append a trailing comma to a rendered line. */
function appendComma(line: string): string {
  return line + ",";
}

interface Arrow {
  params: string;
  body: string;
}

/** Parse `params => body`, returning the (possibly parenthesized) params and body. */
function matchArrow(arg: string): Arrow | null {
  const m = /^(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(.*)$/.exec(arg.trim());
  return m ? { params: m[1], body: m[2] } : null;
}

/** Render an arrow argument that fits on one line (with `as`-cast reparenthesization). */
function renderArrowFlat(arg: string): string {
  const a = matchArrow(arg);
  if (!a) return arg.trim();
  return `${a.params} => ${reparenthesizeAsCast(a.body)}`;
}

// --- Binary-operator breaking -----------------------------------------------

// Lowest-precedence operators first: prettier breaks at the loosest binding operator.
const BINARY_OPERATOR_TIERS = [
  ["||", "??"],
  ["&&"],
  ["===", "!==", "==", "!="],
  ["<=", ">=", "<", ">"],
  ["+"],
];

/** Whether the content has a top-level `=` assignment (not `==`/`===`/`=>`/`<=`/`>=`/`!=`). */
function hasTopLevelAssignment(content: string, mask: boolean[]): boolean {
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    if (mask[i]) continue;
    const c = content[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "=") {
      const prev = content[i - 1];
      const next = content[i + 1];
      if (
        next !== "=" &&
        next !== ">" &&
        prev !== "=" &&
        prev !== "!" &&
        prev !== "<" &&
        prev !== ">"
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Find the split positions for the lowest-precedence space-delimited top-level operator. */
function findBinarySplits(
  expr: string,
  mask: boolean[],
): { op: string; positions: number[] } | null {
  for (const tier of BINARY_OPERATOR_TIERS) {
    let depth = 0;
    const positions: number[] = [];
    let op = "";
    for (let i = 0; i < expr.length; i++) {
      if (mask[i]) continue;
      const c = expr[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0 && expr[i - 1] === " ") {
        for (const candidate of tier) {
          if (
            expr.slice(i, i + candidate.length) === candidate &&
            expr[i + candidate.length] === " "
          ) {
            positions.push(i);
            op = candidate;
            i += candidate.length - 1;
            break;
          }
        }
      }
    }
    if (positions.length > 0) return { op, positions };
  }
  return null;
}

/** Split an expression into operand segments at the given operator positions. */
function splitAtPositions(
  expr: string,
  positions: number[],
  opLen: number,
): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const idx of positions) {
    parts.push(expr.slice(start, idx).trim());
    start = idx + opLen;
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

/**
 * Break a parenthesized condition so every operand sits at the same inner indent, operator at the
 * end of each line (prettier's broken `if (\n  a &&\n  b\n)` shape). Null when no top-level operator.
 */
function breakConditionUniform(indent: string, cond: string): string[] | null {
  const mask = stringMask(cond);
  const found = findBinarySplits(cond, mask);
  if (!found) return null;
  const parts = splitAtPositions(cond, found.positions, found.op.length);
  return parts.map(
    (p, i) => indent + p + (i < parts.length - 1 ? ` ${found.op}` : ""),
  );
}

/**
 * Break a bare binary expression: first operand at `indent`, continuations at `indent + 2`, operator
 * trailing each line (prettier's `a +\n  b` shape). Null when there is no top-level operator.
 */
function breakBinaryExpr(indent: string, content: string): string[] | null {
  const mask = stringMask(content);
  const found = findBinarySplits(content, mask);
  if (!found) return null;
  const parts = splitAtPositions(content, found.positions, found.op.length);
  const cont = indent + INDENT_UNIT;
  return parts.map((p, i) => {
    const pad = i === 0 ? indent : cont;
    return pad + p + (i < parts.length - 1 ? ` ${found.op}` : "");
  });
}

/** Wrap every physical line of a file to printWidth 80. */
function wrapLongLines(src: string): string {
  return src
    .split("\n")
    .flatMap((line) => {
      if (line.length <= PRINT_WIDTH) return [line];
      const indent = leadingWhitespace(line);
      return wrapStatement(indent, line.slice(indent.length));
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Blank-line normalization
// ---------------------------------------------------------------------------

/**
 * Reproduce prettier's blank-line rules for the shapes the emitter produces:
 *   - collapse any run of blank lines to a single blank line;
 *   - drop a blank line immediately after a line that opens a block/bracket (`{`, `(`, `[` at end);
 *   - drop a blank line immediately before a line that closes one (`}`/`)`/`]`, optionally with a
 *     trailing `;`/`,`);
 *   - strip leading blank lines at the top of the file;
 *   - end the file with exactly one newline.
 */
function normalizeBlankLines(src: string): string {
  const raw = src.replace(/\r\n/g, "\n").split("\n");
  // Drop a single trailing empty element from a final newline so we control EOF ourselves.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  const out: string[] = [];
  const isBlank = (l: string) => l.trim() === "";
  const opensBlock = (l: string) => /[{([]\s*$/.test(stripTrailingComment(l));
  const closesBlock = (l: string) => /^[)\]}][;,)\]]*\s*$/.test(l.trim());

  for (let idx = 0; idx < raw.length; idx++) {
    const line = raw[idx];
    if (isBlank(line)) {
      // Skip leading blanks.
      if (out.length === 0) continue;
      // Collapse consecutive blanks.
      if (out[out.length - 1] === "") continue;
      // Drop blank right after an opening line.
      if (opensBlock(out[out.length - 1])) continue;
      // Drop blank right before a closing line (look ahead past further blanks).
      let look = idx + 1;
      while (look < raw.length && isBlank(raw[look])) look++;
      if (look < raw.length && closesBlock(raw[look])) continue;
      out.push("");
      continue;
    }
    out.push(line);
  }
  // Trim a trailing blank.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

/** Remove a trailing `//` comment (outside strings) so `opensBlock` sees the real last char. */
function stripTrailingComment(line: string): string {
  const mask = stringMask(line);
  for (let i = 0; i < line.length - 1; i++) {
    if (!mask[i] && line[i] === "/" && line[i + 1] === "/") {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

export const __test = {
  stringMask,
  addArrowParens,
  normalizeBlankLines,
  PRINT_WIDTH,
  INDENT_UNIT,
};
