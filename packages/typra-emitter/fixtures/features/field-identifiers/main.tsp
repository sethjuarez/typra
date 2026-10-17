import "@typra/emitter";

namespace Typra.Fixtures.Features.FieldIdentifiers;

@serializable
model Root {
  @encodedName("application/json", "class") className?: string;
  @encodedName("application/json", "import") importName?: string;
  self?: string;
  super?: string;
  crate?: string;
  @encodedName("application/json", "x-trace-id") traceId?: string;
  @encodedName("application/json", "2fa") twoFa?: string;

  // Keywords (strict, reserved, or contextual) in at least one target language.
  `def`?: string;
  `lambda`?: string;
  `yield`?: string;
  `pass`?: string;
  `from`?: string;
  `async`?: string;
  `await`?: string;
  `func`?: string;
  `range`?: string;
  `chan`?: string;
  `go`?: string;
  `select`?: string;
  `default`?: string;
  `where`?: string;
  `protocol`?: string;
  `struct`?: string;
  `match`?: string;
  `loop`?: string;
  `mut`?: string;
  `ref`?: string;
  `move`?: string;
  `fn`?: string;
  `event`?: string;
  `object`?: string;
  `string`?: string;
  `delete`?: string;
  `new`?: string;
  `this`?: string;
  `let`?: string;
  `in`?: string;
  `type`?: string;
  `var`?: string;
  `static`?: string;
  `return`?: string;
  `true`?: string;
  `false`?: string;
  `nil`?: string;
  `null`?: string;
  `None`?: string;
}
