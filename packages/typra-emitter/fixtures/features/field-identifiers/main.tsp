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
}
