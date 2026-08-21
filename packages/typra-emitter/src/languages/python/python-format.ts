/**
 * Deterministic Python source reflow — makes native (`format:false`) emitter output already
 * conformant to `ruff format` (Black-style) so running the external formatter is a byte-level
 * no-op. This closes the "optional external formatter post-pass" reproducibility hole (issue #238)
 * for Python: `format:true` and `format:false` then produce identical bytes.
 *
 * Scope is deliberately narrow — it only reproduces the two style rules the emitter actually
 * diverges on:
 *   1. 88-column line wrapping (Black's right-hand-split, with optional-parentheses omission and
 *      the magic trailing comma on exploded bracket bodies).
 *   2. Blank-line normalization (Black's empty-line rules around defs/classes and inside blocks).
 *
 * It is intentionally conservative: any physical line it does not fully understand (unbalanced
 * brackets, a trailing comment, string content) is passed through unchanged. The formatter-
 * idempotency guard (scripts/idempotency-guard.mjs) is the backstop — any residual drift fails
 * validate:fixtures loudly, so an approximate transform can never silently ship.
 */

const LINE_LIMIT = 88;
const INDENT = "    ";

/** Apply the full reflow (quotes, wrapping, then blank-line normalization) to an emitted file. */
export function formatPythonSource(src: string): string {
  return normalizeBlankLines(wrapLongLines(normalizeQuotes(src)));
}

// ---------------------------------------------------------------------------
// String / comment awareness
// ---------------------------------------------------------------------------

/**
 * Mark every character that is inside a string literal (including its quotes) or a trailing `#`
 * comment. Used so bracket/comma/operator scanning ignores punctuation that lives inside strings.
 * Assumes the line's own string literals are balanced (true for the emitter's single-statement
 * lines); multi-line triple-quoted docstrings are handled separately by the line walker.
 */
function stringMask(s: string): boolean[] {
  const mask = new Array<boolean>(s.length).fill(false);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const triple = s.slice(i, i + 3) === c + c + c;
      const delim = triple ? c + c + c : c;
      const start = i;
      i += delim.length;
      while (i < s.length) {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s.slice(i, i + delim.length) === delim) {
          i += delim.length;
          break;
        }
        i++;
      }
      for (let j = start; j < Math.min(i, s.length); j++) mask[j] = true;
    } else if (c === "#") {
      for (let j = i; j < s.length; j++) mask[j] = true;
      break;
    } else {
      i++;
    }
  }
  return mask;
}

/** True when the line has a top-level `#` comment (outside any string). */
function hasTopLevelComment(s: string, mask: boolean[]): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (mask[i]) {
      // A masked `#` at depth 0 that is not preceded by string content is a comment.
      if (s[i] === "#" && depth === 0) {
        const before = s.slice(0, i);
        const beforeMask = mask.slice(0, i);
        // If nothing unmasked-quote opened before it, it is a pure comment position.
        if (!before.split("").some((ch, j) => !beforeMask[j] && (ch === '"' || ch === "'")))
          return true;
        return true;
      }
      continue;
    }
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  return false;
}

/** Top-level (depth-0) bracket pairs, in source order, ignoring masked characters. */
function topBracketPairs(s: string, mask: boolean[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const stack: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (mask[i]) continue;
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") stack.push(i);
    else if (c === ")" || c === "]" || c === "}") {
      const open = stack.pop();
      if (open === undefined) return []; // unbalanced — bail
      if (stack.length === 0) pairs.push([open, i]);
    }
  }
  if (stack.length !== 0) return []; // unbalanced — bail
  return pairs;
}

/** Split a bracket body on its top-level commas (string/nesting aware). */
function splitTopCommas(inner: string): string[] {
  const mask = stringMask(inner);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (mask[i]) continue;
    const c = inner[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

/** A trailing top-level comma (Black's "magic comma") forces the bracket to always explode. */
function hasMagicTrailingComma(inner: string): boolean {
  return inner.trimEnd().endsWith(",");
}

// ---------------------------------------------------------------------------
// Line wrapping (Black right-hand-split)
// ---------------------------------------------------------------------------

function leadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : "";
}

/** Find the top-level assignment operator index (` = `) outside strings/brackets, or -1. */
function topLevelAssignIndex(s: string, mask: boolean[]): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    if (mask[i]) continue;
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (
      c === "=" &&
      depth === 0 &&
      s[i - 1] === " " &&
      s[i + 1] === " " &&
      !"=!<>+-*/%&|^:".includes(s[i - 2]) &&
      s[i + 1] !== "="
    ) {
      // A chained assignment (`a = b = value`) wraps only its final right-hand side, so keep the
      // last top-level `=` as the split point; for a single assignment this is the only one.
      last = i;
    }
  }
  return last;
}

const OPTIONAL_PAREN_KEYWORDS = ["return ", "if ", "elif ", "while ", "assert "];

// Comparison operators Black may break before, longest first so `<=`/`>=`/`==`/`!=` win over `<`/`>`.
const COMPARISON_OPERATORS = ["==", "!=", "<=", ">=", "<", ">"];

/**
 * Split an expression at its highest-priority top-level delimiter, the way Black does: boolean
 * `and`/`or` first, then comparison operators. The operator leads each continuation segment. Returns
 * null when there is no top-level delimiter to break on.
 */
function splitAtOperators(value: string): string[] | null {
  const mask = stringMask(value);

  const collect = (test: (i: number) => number): number[] => {
    const boundaries: number[] = [];
    let depth = 0;
    for (let i = 0; i < value.length; i++) {
      if (mask[i]) continue;
      const c = value[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0) {
        const len = test(i);
        if (len > 0) {
          boundaries.push(i + 1);
          i += len;
        }
      }
    }
    return boundaries;
  };

  // Highest split priority: boolean operators.
  let boundaries = collect((i) => {
    if (value.slice(i, i + 5) === " and ") return 4;
    if (value.slice(i, i + 4) === " or ") return 3;
    return 0;
  });

  // Next: comparison operators (only when no boolean split exists).
  if (boundaries.length === 0) {
    boundaries = collect((i) => {
      if (value[i] !== " ") return 0;
      for (const op of COMPARISON_OPERATORS) {
        if (value.slice(i + 1, i + 1 + op.length) === op && value[i + 1 + op.length] === " ") {
          return op.length + 1;
        }
      }
      return 0;
    });
  }

  if (boundaries.length === 0) return null;
  const segments: string[] = [];
  let start = 0;
  for (const b of boundaries) {
    segments.push(value.slice(start, b).trim());
    start = b;
  }
  segments.push(value.slice(start).trim());
  return segments;
}

/** Render a sequence of operator-split segments at `indent`, recursing on any that still overflow. */
function renderSegments(indent: string, segments: string[]): string[] {
  const rendered: string[] = [];
  for (const seg of segments) {
    const line = indent + seg;
    if (line.length <= LINE_LIMIT) rendered.push(line);
    else rendered.push(...wrapStatement(indent, seg, true));
  }
  return rendered;
}

/** Render the value that sits inside Black's optional parentheses. */
function renderOptionalParenValue(indent: string, value: string): string[] {
  // At the deeper indent the value may now fit on a single line; Black only breaks it further when
  // it still overflows.
  if ((indent + value).length <= LINE_LIMIT) return [indent + value];
  const segments = splitAtOperators(value);
  if (segments) return renderSegments(indent, segments);
  return wrapStatement(indent, value, true);
}

/** Wrap an over-long `from X import a, b, c` into Black's parenthesized, one-name-per-line form. */
function wrapFromImport(indent: string, content: string): string[] | null {
  const m = /^from\s+(\S+)\s+import\s+(.+)$/.exec(content);
  if (!m) return null;
  const names = m[2].trim();
  if (names.startsWith("(") || names === "*") return null;
  const parts = names
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return [
    indent + `from ${m[1]} import (`,
    ...parts.map((p) => indent + INDENT + p + ","),
    indent + ")",
  ];
}

/**
 * Wrap a single over-long code line the way Black would. `indent` is the physical indentation and
 * `content` is the trimmed statement. Returns one or more indented physical lines. Any construct it
 * does not recognize is returned unchanged so the transform can never corrupt code.
 */
function wrapStatement(indent: string, content: string, parenthesized = false): string[] {
  const full = indent + content;
  if (full.length <= LINE_LIMIT) return [full];

  const mask = stringMask(content);
  if (hasTopLevelComment(content, mask)) return [full];

  // A long `from X import a, b, c` is wrapped in parentheses and exploded one name per line.
  const importWrapped = wrapFromImport(indent, content);
  if (importWrapped) return importWrapped;

  // Black breaks at the lowest-priority top-level delimiter (boolean, then comparison operators)
  // before descending into any inner call's brackets. A continuation line already inside a bracket
  // is split in place; a top-level statement gets Black's optional parentheses first.
  const segments = splitAtOperators(content);
  if (segments) {
    if (parenthesized) return renderSegments(indent, segments);
    const wrapped = wrapWithOptionalParens(indent, content, mask);
    if (wrapped) return wrapped;
  }

  const pairs = topBracketPairs(content, mask);
  if (pairs.length === 0) {
    if (!parenthesized) return wrapWithOptionalParens(indent, content, mask) ?? [full];
    return [full];
  }

  const isDef = /^(async\s+)?def\s/.test(content);
  // A `def` always splits on its parameter parentheses (the first top-level pair), never on a
  // bracket in the return annotation. Everything else splits on the last top-level bracket.
  const [openIdx, closeIdx] = isDef ? pairs[0] : pairs[pairs.length - 1];
  const head = content.slice(0, openIdx + 1);
  const inner = content.slice(openIdx + 1, closeIdx);
  const tail = content.slice(closeIdx);
  const headLine = indent + head;

  // Optional-parentheses: for an assignment / return / if-test whose right-hand-split head would
  // still overflow, Black wraps the value in parens and splits inside them instead.
  if (!isDef && headLine.length > LINE_LIMIT) {
    const wrapped = wrapWithOptionalParens(indent, content, mask);
    if (wrapped) return wrapped;
  }

  if (inner.trim() === "") return [full];

  const openChar = content[openIdx];
  return [
    headLine,
    ...renderBracketBody(indent + INDENT, inner, head, openChar),
    indent + tail,
  ];
}

/** Classify a bracket as a collection literal (always explodes when split) vs a call/subscript. */
function bracketKind(head: string, openChar: string): "collection" | "call" {
  const before = head.slice(0, -1).trimEnd();
  const prev = before.slice(-1);
  const isTrailer = /[A-Za-z0-9_)\]]/.test(prev);
  if (openChar === "{") return "collection";
  if (openChar === "[") return isTrailer ? "call" : "collection";
  // `(` — a call/def when it trails a name, otherwise a grouping/tuple.
  return "call";
}

/**
 * Render the contents of a bracket. Collection literals (dict/list/tuple) explode one element per
 * line with a trailing comma once they must be split; call/def argument lists keep the body on a
 * single line when it fits. A magic trailing comma always forces the exploded form.
 */
function renderBracketBody(
  indent: string,
  inner: string,
  head: string,
  openChar: string,
): string[] {
  const kind = bracketKind(head, openChar);
  const trimmed = inner.trim();
  const oneLine = indent + trimmed;
  const compr = isComprehension(inner);
  const fitsOneLine = oneLine.length <= LINE_LIMIT && !hasMagicTrailingComma(inner);
  if (fitsOneLine && (kind === "call" || compr)) {
    return [oneLine];
  }
  if (compr) {
    return splitComprehensionClauses(inner).map((clause) => indent + clause);
  }
  const parts = splitTopCommas(inner)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // Black adds a trailing "magic" comma only when the exploded body has more than one element (or
  // the source already carried one). A single unsplittable argument gets no trailing comma.
  const addComma = parts.length > 1 || hasMagicTrailingComma(inner);
  const rendered: string[] = [];
  for (let p = 0; p < parts.length; p++) {
    const suffix = addComma ? "," : "";
    const line = indent + parts[p] + suffix;
    if (line.length <= LINE_LIMIT) rendered.push(line);
    else rendered.push(...wrapStatement(indent, parts[p] + suffix, true));
  }
  return rendered;
}

/** Index of a top-level ` <keyword> ` token (depth 0, outside strings), or -1. */
function findTopLevelKeyword(inner: string, mask: boolean[], keyword: string): number {
  const needle = ` ${keyword} `;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (mask[i]) continue;
    const c = inner[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && inner.slice(i, i + needle.length) === needle) return i;
  }
  return -1;
}

/** A bracket body is a comprehension when it has a top-level `for` clause. */
function isComprehension(inner: string): boolean {
  return findTopLevelKeyword(inner, stringMask(inner), "for") >= 0;
}

/**
 * Split a comprehension into its expression and clauses (`for ... in ...`, comprehension `if`),
 * the way Black breaks a comprehension that overflows — at the clause keywords, not at commas.
 * A leading ternary `if`/`else` in the expression is left intact (only `if` after the first `for`
 * is treated as a comprehension clause).
 */
function splitComprehensionClauses(inner: string): string[] {
  const mask = stringMask(inner);
  const firstFor = findTopLevelKeyword(inner, mask, "for");
  const boundaries: number[] = [];
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (mask[i]) continue;
    const c = inner[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0) {
      if (inner.slice(i, i + 5) === " for ") boundaries.push(i);
      else if (inner.slice(i, i + 4) === " if " && i > firstFor) boundaries.push(i);
    }
  }
  const clauses: string[] = [];
  let start = 0;
  for (const b of boundaries) {
    clauses.push(inner.slice(start, b).trim());
    start = b + 1;
  }
  clauses.push(inner.slice(start).trim());
  return clauses;
}

/**
 * Wrap the value of an assignment / return / if / while / assert in Black's "optional parentheses"
 * and recurse. Returns null when the line is not such a construct.
 */
function wrapWithOptionalParens(
  indent: string,
  content: string,
  mask: boolean[],
): string[] | null {
  const assignIdx = topLevelAssignIndex(content, mask);
  if (assignIdx >= 0) {
    const prefix = content.slice(0, assignIdx + 1); // includes '='
    const value = content.slice(assignIdx + 1).trim();
    if (value.startsWith("(")) return null; // already parenthesized
    return [
      indent + prefix + " (",
      ...renderOptionalParenValue(indent + INDENT, value),
      indent + ")",
    ];
  }

  for (const kw of OPTIONAL_PAREN_KEYWORDS) {
    if (!content.startsWith(kw)) continue;
    const isColon = kw !== "return "; // if/elif/while end with ':'; assert/return do not
    let value = content.slice(kw.length).trim();
    let suffix = ")";
    if (isColon && kw !== "assert ") {
      if (!value.endsWith(":")) return null;
      value = value.slice(0, -1).trim();
      suffix = "):";
    }
    if (value.startsWith("(")) return null;
    // `assert cond, "message"` has a top-level comma; wrapping the whole thing in parentheses would
    // turn it into a single (always-truthy) tuple. Leave such an assert unchanged rather than change
    // its meaning.
    if (kw === "assert " && splitTopCommas(value).length > 1) return null;
    return [
      indent + kw.trimEnd() + " (",
      ...renderOptionalParenValue(indent + INDENT, value),
      indent + suffix,
    ];
  }
  return null;
}

/** Reflow every over-long code line, leaving docstring/string content untouched. */
export function wrapLongLines(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let tripleDelim: string | null = null;
  let bracketDepth = 0;

  for (const line of lines) {
    if (tripleDelim) {
      out.push(line);
      if (closesTriple(line, tripleDelim)) tripleDelim = null;
      continue;
    }
    const opened = opensUnterminatedTriple(line);
    if (opened) {
      out.push(line);
      tripleDelim = opened;
      continue;
    }
    if (line.length <= LINE_LIMIT || line.trim().startsWith("#")) {
      out.push(line);
      bracketDepth += netBracketDelta(line);
      continue;
    }
    // A line that starts inside an open bracket is a continuation Black may break at operators
    // directly, without adding another layer of parentheses.
    out.push(...wrapStatement(leadingWhitespace(line), line.trim(), bracketDepth > 0));
    bracketDepth += netBracketDelta(line);
  }
  return out.join("\n");
}

/** Detect a triple-quote that opens on this line and is not closed on the same line. */
function opensUnterminatedTriple(line: string): string | null {
  let i = 0;
  let open: string | null = null;
  while (i < line.length) {
    if (open) {
      // Inside a triple-quoted string: only its own closing delimiter ends it. Inner single/double
      // quotes (e.g. an apostrophe in a docstring) must not be treated as nested strings.
      if (line.slice(i, i + 3) === open) {
        open = null;
        i += 3;
        continue;
      }
      if (line[i] === "\\") i += 2;
      else i++;
      continue;
    }
    const three = line.slice(i, i + 3);
    if (three === '"""' || three === "'''") {
      open = three;
      i += 3;
      continue;
    }
    const c = line[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < line.length && line[i] !== c) {
        if (line[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "#") break;
    i++;
  }
  return open;
}

function closesTriple(line: string, delim: string): boolean {
  return line.includes(delim);
}

// ---------------------------------------------------------------------------
// Quote normalization (Black prefers double quotes)
// ---------------------------------------------------------------------------

const STRING_PREFIX = /^[rRbBfFuU]{1,3}$/;

/** Read a string literal starting at `start` (a quote char). Returns its extent and parts. */
function readStringLiteral(
  src: string,
  start: number,
): { quote: string; triple: boolean; body: string; end: number } {
  const q = src[start];
  const triple = src.slice(start, start + 3) === q + q + q;
  const delim = triple ? q + q + q : q;
  let i = start + delim.length;
  const bodyStart = i;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src.slice(i, i + delim.length) === delim) {
      const body = src.slice(bodyStart, i);
      return { quote: delim, triple, body, end: i + delim.length };
    }
    i++;
  }
  return { quote: delim, triple, body: src.slice(bodyStart), end: src.length };
}

/**
 * Normalize string-literal quotes to Black's preference (double quotes), but only for the safe
 * subset where the swap cannot change escaping: single-quoted bodies containing no double quote and
 * no backslash. Anything else is left byte-for-byte unchanged. `f`/`r`/`b` prefixes are preserved.
 */
function normalizeQuotes(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const lit = readStringLiteral(src, i);
      out += rewriteQuote("", lit);
      i = lit.end;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      const word = m[0];
      const next = src[i + word.length];
      if ((next === '"' || next === "'") && STRING_PREFIX.test(word)) {
        const lit = readStringLiteral(src, i + word.length);
        out += rewriteQuote(word, lit);
        i = lit.end;
      } else {
        out += word;
        i += word.length;
      }
    } else if (c === "#") {
      const eol = src.indexOf("\n", i);
      const end = eol === -1 ? src.length : eol;
      out += src.slice(i, end);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function rewriteQuote(
  prefix: string,
  lit: { quote: string; triple: boolean; body: string },
): string {
  if (lit.triple) {
    if (lit.quote[0] === "'") {
      const eligible =
        !lit.body.includes('"""') &&
        !lit.body.startsWith('"') &&
        !lit.body.endsWith('"');
      const quote = eligible ? '"""' : lit.quote;
      return prefix + quote + lit.body + quote;
    }
    return prefix + lit.quote + lit.body + lit.quote;
  }
  const [quote, body] = normalizeStringToken(prefix, lit.quote, lit.body);
  return prefix + quote + body + quote;
}

/** Count `\ch` (escaped) occurrences of `ch` in a Python string body. */
function countEscaped(body: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {
      if (body[i + 1] === ch) count++;
      i++;
    }
  }
  return count;
}

/** Count unescaped occurrences of `ch` in a Python string body. */
function countUnescaped(body: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {
      i++;
      continue;
    }
    if (body[i] === ch) count++;
  }
  return count;
}

/** Re-escape a string body when switching its delimiter from `oldQ` to `newQ`. */
function rewriteBody(body: string, oldQ: string, newQ: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] === "\\") {
      const next = body[i + 1] ?? "";
      if (next === oldQ) out += oldQ; // the old delimiter no longer needs escaping
      else out += "\\" + next; // keep every other escape (\\, \n, \t, …) intact
      i += 2;
      continue;
    }
    if (body[i] === newQ) out += "\\" + newQ; // the new delimiter must be escaped
    else out += body[i];
    i++;
  }
  return out;
}

/** Remove backslash escapes of `ch`, which never needs escaping (e.g. `\'` inside a `"…"` literal). */
function stripRedundantEscapes(body: string, ch: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {
      const next = body[i + 1] ?? "";
      if (next === ch) out += ch;
      else out += "\\" + next;
      i++;
      continue;
    }
    out += body[i];
  }
  return out;
}

/**
 * Normalize a single-line string literal's quotes to Black's rule: prefer double quotes, but switch
 * to whichever delimiter needs *fewer* backslash escapes (double wins ties). Handles both
 * `'x'`→`"x"` and `"a\"b"`→`'a"b'`. Raw strings cannot change escaping, so they only flip when the
 * target delimiter does not appear in the body.
 */
function normalizeStringToken(
  prefix: string,
  quote: string,
  body: string,
): [string, string] {
  const preferred = '"';
  const other = "'";
  const isRaw = /[rR]/.test(prefix);
  if (isRaw) {
    if (quote !== preferred && !body.includes(preferred)) return [preferred, body];
    return [quote, body];
  }
  const q = quote;
  const p = q === '"' ? other : preferred;
  const escapedQ = countEscaped(body, q);
  const unescapedP = countUnescaped(body, p);
  let newQuote = q;
  if (unescapedP < escapedQ) newQuote = p;
  else if (unescapedP === escapedQ && q !== preferred) newQuote = preferred;
  if (newQuote === q) return [q, stripRedundantEscapes(body, p)];
  return [newQuote, rewriteBody(body, q, newQuote)];
}

// ---------------------------------------------------------------------------
// Blank-line normalization (Black EmptyLineTracker)
// ---------------------------------------------------------------------------

interface LogicalLine {
  depth: number;
  isDecorator: boolean;
  isDef: boolean;
  isClass: boolean;
  isImport: boolean;
  isComment: boolean;
  opensBlock: boolean;
}

function classifyLine(text: string, depth: number): LogicalLine {
  const t = text.trim();
  const mask = stringMask(t);
  const codeEnd = (() => {
    for (let i = t.length - 1; i >= 0; i--) {
      if (!mask[i] && t[i] !== " ") return t[i];
    }
    return "";
  })();
  return {
    depth,
    isDecorator: t.startsWith("@"),
    isDef: /^(async\s+)?def\b/.test(t),
    isClass: /^class\b/.test(t),
    isImport: /^(import|from)\b/.test(t),
    isComment: t.startsWith("#"),
    opensBlock: codeEnd === ":",
  };
}

/** Count how many blank lines Black would emit before `current`, mirroring EmptyLineTracker. */
function blankLinesBefore(
  current: LogicalLine,
  previous: LogicalLine | null,
  pending: number,
  previousDefs: number[],
): number {
  const depth = current.depth;
  const maxAllowed = depth === 0 ? 2 : 1;
  let before = Math.min(pending, maxAllowed);

  while (previousDefs.length > 0 && previousDefs[previousDefs.length - 1] >= depth) {
    before = depth > 0 ? 1 : 2;
    previousDefs.pop();
  }

  if (current.isDef || current.isClass) previousDefs.push(depth);

  if (previous === null) return 0;

  if (previous.opensBlock && depth > previous.depth) return 0;

  if (current.isDecorator || current.isDef || current.isClass) {
    if (previous.isDecorator) return 0;
    if (previous.depth < depth && (previous.isClass || previous.isDef)) return 0;
    if (previous.isComment && previous.depth === depth && Math.min(pending, maxAllowed) === 0)
      return 0;
    return depth > 0 ? 1 : 2;
  }

  if (previous.isImport && !current.isImport && depth === previous.depth) {
    return before || 1;
  }

  return before;
}

/**
 * Apply Black's empty-line rules. Blank lines inside triple-quoted strings are preserved verbatim;
 * continuation lines of a wrapped statement (inside open brackets) are never treated as logical
 * starts. Only genuine logical-line boundaries have their preceding blank count rewritten.
 */
function normalizeBlankLines(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let previous: LogicalLine | null = null;
  const previousDefs: number[] = [];
  let pending = 0;
  let bracketDepth = 0;
  let tripleDelim: string | null = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (tripleDelim) {
      out.push(line);
      if (closesTriple(line, tripleDelim)) tripleDelim = null;
      continue;
    }

    const isBlank = line.trim() === "";
    const isContinuation = bracketDepth > 0;

    if (isBlank && !isContinuation) {
      pending++;
      continue;
    }

    if (isContinuation) {
      out.push(line);
    } else {
      const depth = leadingWhitespace(line).length >> 2;
      const current = classifyLine(line, depth);
      const blanks = blankLinesBefore(current, previous, pending, previousDefs);
      for (let b = 0; b < blanks; b++) out.push("");
      out.push(line);
      previous = current;
    }
    pending = 0;

    // Update bracket depth / triple-string state for the physical line just emitted.
    const opened = opensUnterminatedTriple(line);
    if (opened) {
      tripleDelim = opened;
    } else {
      bracketDepth += netBracketDelta(line);
      if (bracketDepth < 0) bracketDepth = 0;
    }
  }

  // Black ends a file with exactly one trailing newline (no trailing blank lines).
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  out.push("");
  return out.join("\n");
}

/** Net change in top-level bracket depth contributed by a physical line (string/comment aware). */
function netBracketDelta(line: string): number {
  const mask = stringMask(line);
  let delta = 0;
  for (let i = 0; i < line.length; i++) {
    if (mask[i]) continue;
    const c = line[i];
    if (c === "(" || c === "[" || c === "{") delta++;
    else if (c === ")" || c === "]" || c === "}") delta--;
  }
  return delta;
}
