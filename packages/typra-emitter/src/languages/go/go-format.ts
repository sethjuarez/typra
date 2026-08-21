/**
 * Deterministic native (`format:false`) reflow that reproduces the subset of `gofmt`'s layout the
 * Typra Go emitter would otherwise depend on the external `gofmt`/`goimports` pipeline to apply.
 *
 * Issue #238: the guard proves each target's native output is a byte-level no-op under its default
 * formatter, so `format:true` and `format:false` agree. An audit of the emitted Go tree found the
 * drift is three transformations `gofmt` applies:
 *   1. Block indentation. Some emitters (notably the test emitter) emit flush-left Go and rely on
 *      `gofmt` to add every level of indentation; others already indent. Reproducing `gofmt`'s
 *      brace/paren/bracket-depth indentation (with the `switch`/`select` `case` dedent and raw-string
 *      preservation) normalises both, and is a byte-level no-op on already-indented source.
 *   2. Columnar (tabwriter) alignment — struct field blocks, `const`/`var` spec blocks, and keyed
 *      composite-literal elements — where non-terminal cells are space-padded to `maxCellWidth + 1`.
 *   3. Collapsing runs of blank lines to a single blank, and tightening the interior spaces of a
 *      single-line composite literal (`T{ a: b }` → `T{a: b}`).
 *
 * `goimports` grouping is already reproduced by the emitter (imports are emitted pre-grouped), so
 * only its indentation needs applying — which falls out of the indentation pass.
 */

type Context = "struct" | "constvar" | "composite" | "block" | "paren";

/** A tokenized alignable row: its literal indentation plus the ordered cells to align. */
interface Row {
  index: number;
  indent: string;
  cells: string[];
}

/**
 * Format Go source so it matches `gofmt` (+ `goimports`) output without invoking either tool.
 * Applies brace-depth reindentation and blank-line collapsing, single-line composite-literal brace
 * tightening, then columnar alignment of the three `gofmt`-aligned constructs (struct fields,
 * const/var specs, keyed composite elements). Raw string literals are preserved byte-for-byte.
 */
export function formatGoSource(source: string): string {
  const { lines, raw } = reindent(source);
  tightenCompositeBraces(lines, raw);
  alignOneLineDecls(lines, raw);
  return alignColumns(lines, raw);
}

// ---------------------------------------------------------------------------
// Pass 1: brace-depth reindentation + blank-line collapse
// ---------------------------------------------------------------------------

interface Bracket {
  ch: "{" | "(" | "[";
  /** A `{` that opens a `switch`/`select` body, whose `case`/`default` labels dedent one level. */
  isSwitch: boolean;
  /** Indent level (in tabs) at which the line that opened this bracket was rendered. */
  openerIndent: number;
  /** Indent level for this bracket's direct children (`openerIndent + 1`). */
  bodyIndent: number;
}

interface ScanState {
  inRaw: boolean;
  inBlockComment: boolean;
}

/**
 * Reindent each line to its `gofmt` nesting level and collapse runs of consecutive blank lines to a
 * single blank. Indentation is relative to the rendered position of the line that opened each
 * enclosing bracket (not raw bracket depth), which is how `gofmt` indents constructs opened on an
 * already-dedented line — e.g. a multi-line `interface { ... }` type in a `case` label. Lines inside
 * a raw string literal (or block comment) are emitted verbatim and flagged so later passes never
 * touch them. Returns the post-collapse lines alongside a parallel `raw` flag marking those lines.
 */
function reindent(source: string): { lines: string[]; raw: boolean[] } {
  const src = source.split("\n");
  const stack: Bracket[] = [];
  const state: ScanState = { inRaw: false, inBlockComment: false };
  const built: { text: string; raw: boolean }[] = [];

  for (const rawLine of src) {
    const protectedLine = state.inRaw || state.inBlockComment;

    let text: string;
    let renderedIndent = 0;
    if (protectedLine) {
      text = rawLine;
    } else {
      const trimmed = rawLine.replace(/^[\t ]+/, "");
      if (trimmed.length === 0) {
        text = "";
      } else {
        renderedIndent = computeIndent(trimmed, stack);
        text = "\t".repeat(renderedIndent) + trimmed;
      }
    }
    built.push({ text, raw: protectedLine });
    scanLineForState(rawLine, stack, state, renderedIndent);
  }

  // Collapse consecutive non-protected blank lines to a single blank.
  const lines: string[] = [];
  const raw: boolean[] = [];
  let prevBlank = false;
  for (const b of built) {
    const blank = !b.raw && b.text.trim() === "";
    if (blank && prevBlank) continue;
    lines.push(b.text);
    raw.push(b.raw);
    prevBlank = blank;
  }
  return { lines, raw };
}

/**
 * The indent level (in tabs) for a line, relative to its enclosing bracket's rendered position: a
 * line whose first token is a closer (`}`/`)`/`]`) aligns with the opener line of the bracket it
 * closes; a `case`/`default` label inside a `switch`/`select` body sits one level out from the body
 * statements; everything else uses the enclosing bracket's body indent.
 */
function computeIndent(trimmed: string, stack: Bracket[]): number {
  const top = stack[stack.length - 1];
  const base = top ? top.bodyIndent : 0;
  const first = trimmed[0];
  if (first === "}" || first === ")" || first === "]") {
    return top ? top.openerIndent : 0;
  }
  if (/^(case|default)\b/.test(trimmed)) {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].ch === "{") return stack[k].isSwitch ? Math.max(0, base - 1) : base;
    }
  }
  return base;
}

/**
 * Advance the bracket stack and raw-string/comment state across one physical line, ignoring
 * brackets that fall inside string literals, rune literals, and comments. A `{` opened on a line
 * mentioning `switch`/`select` is flagged so its `case` labels dedent. Each pushed bracket records
 * `renderedIndent` (the indent of the opening line) so its children indent one level deeper.
 */
function scanLineForState(
  line: string,
  stack: Bracket[],
  state: ScanState,
  renderedIndent: number,
): void {
  let i = 0;
  while (i < line.length) {
    if (state.inRaw) {
      const close = line.indexOf("`", i);
      if (close === -1) return;
      state.inRaw = false;
      i = close + 1;
      continue;
    }
    if (state.inBlockComment) {
      const close = line.indexOf("*/", i);
      if (close === -1) return;
      state.inBlockComment = false;
      i = close + 2;
      continue;
    }
    const ch = line[i];
    const two = line.substr(i, 2);
    if (two === "//") return;
    if (two === "/*") {
      state.inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "`") {
      state.inRaw = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(line, i, ch);
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      const isSwitch = ch === "{" && /\b(switch|select)\b/.test(line.slice(0, i));
      stack.push({
        ch,
        isSwitch,
        openerIndent: renderedIndent,
        bodyIndent: renderedIndent + 1,
      });
      i += 1;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      stack.pop();
      i += 1;
      continue;
    }
    i += 1;
  }
}

/** Skip a `"`-delimited string or `'`-delimited rune literal, honouring backslash escapes. */
function skipQuoted(line: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Pass 2: single-line composite-literal brace tightening
// ---------------------------------------------------------------------------

/**
 * Collapse the interior padding of a single-line composite literal: `Ident{ a: b }` becomes
 * `Ident{a: b}`. `gofmt` never pads the inside of a braced literal that fits on one line. The
 * opening brace must hug its type (no space before `{`) to distinguish a composite literal from a
 * block (`if x {`, `func () {`), and the braces must balance on the line so multi-line block
 * openers are left untouched.
 *
 * The rewrite is a non-lexical regex, so it is applied only to lines with no string, rune, or
 * comment token (alongside the protected raw-string / comment lines, which are skipped): a `{ … }`
 * inside a `"…"`/`` `…` `` literal or a `//` comment must never be touched. Declining to tighten such
 * a line at worst leaves a padded literal that `gofmt` would tighten — surfaced as measurable guard
 * drift — rather than silently corrupting string data. Mutates `lines`.
 */
function tightenCompositeBraces(lines: string[], raw: boolean[]): void {
  for (let i = 0; i < lines.length; i++) {
    if (raw[i]) continue;
    const line = lines[i];
    if (/["'`]|\/\/|\/\*/.test(line)) continue;
    let open = 0;
    for (const ch of line) {
      if (ch === "{") open++;
      else if (ch === "}") open--;
    }
    if (open !== 0) continue;
    lines[i] = line.replace(/([^\s{])\{ (.*?) \}/g, "$1{$2}");
  }
}

// ---------------------------------------------------------------------------
// Pass 2b: align adjacent one-line function declarations
// ---------------------------------------------------------------------------

/** A one-line function declaration: indent, signature (through the last `)`), and `{ body }`. */
const ONE_LINE_FUNC = /^(\t*)(func\b.*?)\s+(\{.*\})$/;

/**
 * Align the opening brace of a run of adjacent one-line function declarations, the way `gofmt`'s
 * tabwriter does (the signature is one cell, the `{ body }` the next): the signatures are padded to a
 * common column so the bodies line up. A blank line, a non-matching line, or a change of indent ends
 * the run; runs shorter than two lines and protected (raw string / comment) lines are left alone.
 */
function alignOneLineDecls(lines: string[], raw: boolean[]): void {
  let i = 0;
  while (i < lines.length) {
    const first = raw[i] ? null : lines[i].match(ONE_LINE_FUNC);
    if (!first) {
      i++;
      continue;
    }
    const indent = first[1];
    const rows: Row[] = [];
    let j = i;
    while (j < lines.length && !raw[j]) {
      const match = lines[j].match(ONE_LINE_FUNC);
      if (!match || match[1] !== indent) break;
      rows.push({ index: j, indent, cells: [match[2], match[3]] });
      j++;
    }
    if (rows.length >= 2) {
      for (const [k, rendered] of renderGroup(rows).entries()) {
        lines[rows[k].index] = rendered;
      }
    }
    i = Math.max(j, i + 1);
  }
}

// ---------------------------------------------------------------------------
// Pass 3: columnar (tabwriter) alignment
// ---------------------------------------------------------------------------

/** Whether a trimmed line is a standalone comment (breaks an alignment section). */
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

/**
 * Walk the file tracking a lightweight brace/paren context stack (openers sit at end of line,
 * closers at start of line in emitter output), grouping contiguous alignable rows within an
 * alignment-bearing context and rewriting each group with `gofmt` column padding. Protected (raw
 * string / comment) lines neither align nor perturb the context stack.
 */
function alignColumns(lines: string[], raw: boolean[]): string {
  const out = lines.slice();
  const stack: Context[] = [];
  let group: Row[] = [];

  const flush = () => {
    if (group.length > 0) {
      for (const [i, rendered] of renderGroup(group).entries()) {
        out[group[i].index] = rendered;
      }
    }
    group = [];
  };

  for (let i = 0; i < lines.length; i++) {
    if (raw[i]) {
      flush();
      continue;
    }
    const line = lines[i];
    const trimmed = line.trim();
    const context = stack[stack.length - 1];

    // Update the context stack: pop for each leading closer, then push if the line opens a block.
    const popped = applyClosers(stack, trimmed);
    const pushed = applyOpener(stack, trimmed);

    const alignable =
      !popped &&
      !pushed &&
      trimmed.length > 0 &&
      !isCommentLine(trimmed) &&
      (context === "struct" || context === "constvar" || context === "composite");

    if (alignable) {
      const cells = tokenize(context, trimmed);
      if (cells.length >= 2) {
        group.push({ index: i, indent: leadingIndent(line), cells });
        continue;
      }
    }
    // Any non-alignable line (blank, comment, closer, opener, single-cell) ends the section.
    flush();
  }
  flush();
  return out.join("\n");
}

/** Return the literal leading whitespace (tabs) of a line. */
function leadingIndent(line: string): string {
  const match = line.match(/^[\t ]*/);
  return match ? match[0] : "";
}

/**
 * Pop the context stack once per leading closer (`}` / `)`, optionally followed by `,`/`)`). Returns
 * whether any pop occurred (a closer line is never itself an alignable row).
 */
function applyClosers(stack: Context[], trimmed: string): boolean {
  let popped = false;
  let rest = trimmed;
  while (rest.length > 0 && (rest[0] === "}" || rest[0] === ")")) {
    stack.pop();
    popped = true;
    rest = rest.slice(1).replace(/^[,)\s]+/, "");
    if (rest.startsWith("else")) break;
  }
  return popped;
}

/**
 * Push a context if the line ends with a block/paren opener. `struct {` / `interface {` and the
 * `const (` / `var (` spec blocks carry alignment; a composite literal opener (`Type{`, no space
 * before the brace) aligns keyed elements; every other `{`/`(` opener is a non-aligning scope.
 * Returns whether a push occurred (an opener line is never itself an alignable row).
 */
function applyOpener(stack: Context[], trimmed: string): boolean {
  if (trimmed.endsWith("{")) {
    if (/\bstruct\s*\{$/.test(trimmed)) stack.push("struct");
    else if (isCompositeOpener(trimmed)) stack.push("composite");
    else stack.push("block");
    return true;
  }
  if (trimmed.endsWith("(")) {
    if (/^(const|var)\s*\($/.test(trimmed)) stack.push("constvar");
    else stack.push("paren");
    return true;
  }
  return false;
}

/**
 * A composite-literal opener hugs its type: the character before the trailing `{` is not a space
 * (e.g. `T{`, `[]T{`, `map[string]T{`, `interface{}{`), unlike block openers `func () {` / `if x {`
 * which always have a space before the brace. `struct {` is handled by the caller first.
 */
function isCompositeOpener(trimmed: string): boolean {
  const before = trimmed[trimmed.length - 2];
  return before !== undefined && before !== " " && before !== "\t";
}

/** Split an alignable row into its `gofmt` cells for the given context. */
function tokenize(context: Context, trimmed: string): string[] {
  if (context === "struct") return tokenizeStructField(trimmed);
  if (context === "constvar") return tokenizeSpec(trimmed);
  return tokenizeComposite(trimmed);
}

/**
 * `Name Type` (+ optional `` `tag` `` and/or trailing `// comment`). Name and Type are whitespace-
 * free tokens; everything after the type (the tag and any comment) is the trailing cell and is
 * never padded, so it can be captured verbatim.
 */
function tokenizeStructField(trimmed: string): string[] {
  const nameMatch = trimmed.match(/^(\S+)\s+(.*)$/);
  if (!nameMatch) return [trimmed];
  const name = nameMatch[1];
  const rest = nameMatch[2];
  const typeMatch = rest.match(/^(\S+)(?:\s+(.*))?$/);
  if (!typeMatch) return [name, rest];
  const type = typeMatch[1];
  const tail = typeMatch[2];
  return tail && tail.length > 0 ? [name, type, tail] : [name, type];
}

/**
 * `Name Type = value` / `Name = value` / `Name Type`. The `= value` (with everything after the
 * equals, including a trailing comment) is a single trailing cell; the name and optional type are
 * the aligned leading cells.
 */
function tokenizeSpec(trimmed: string): string[] {
  const eq = trimmed.match(/^(.*?)\s+(=\s.*)$/);
  const head = eq ? eq[1] : trimmed;
  const value = eq ? eq[2] : undefined;
  const headTokens = head.split(/\s+/).filter((t) => t.length > 0);
  const cells = headTokens.slice();
  if (value !== undefined) cells.push(value);
  return cells;
}

/**
 * A keyed composite element `Key: value,` splits into the `Key:` cell and the value cell (the value
 * is the trailing cell and is not padded). The key may be an identifier, an integer, or a string
 * literal (`"temperature": ...` in a `map[string]T`). Positional elements have no leading `key:` and
 * collapse to a single cell (no alignment), matching `gofmt`.
 */
function tokenizeComposite(trimmed: string): string[] {
  const keyed = trimmed.match(/^("(?:[^"\\]|\\.)*"|[A-Za-z_]\w*|\d+):\s+(.*)$/);
  if (!keyed) return [trimmed];
  return [`${keyed[1]}:`, keyed[2]];
}

/**
 * Render a contiguous group of rows with `gofmt` tabwriter padding: each non-terminal cell is
 * left-aligned and space-padded to `maxCellWidth + 1` computed over the rows in which that cell is
 * tab-terminated (has a following cell). A row's final cell is emitted verbatim.
 */
function renderGroup(rows: Row[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (let j = 0; j < row.cells.length - 1; j++) {
      const w = cellWidth(row.cells[j]) + 1;
      if (widths[j] === undefined || w > widths[j]) widths[j] = w;
    }
  }
  return rows.map((row) => {
    let line = row.indent;
    for (let j = 0; j < row.cells.length; j++) {
      const cell = row.cells[j];
      if (j < row.cells.length - 1) {
        line += cell + " ".repeat(widths[j] - cellWidth(cell));
      } else {
        line += cell;
      }
    }
    return line;
  });
}

/** Cell width in Unicode code points, matching `gofmt`'s rune-count column measurement. */
function cellWidth(cell: string): number {
  return [...cell].length;
}