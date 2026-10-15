import "@typra/emitter";

namespace Typra.Test.DelegateInvalid;

@discriminator("kind")
model ClosedBase { kind: "a" | "b"; }
model ClosedA extends ClosedBase { kind: "a"; }
model ClosedB extends ClosedBase { kind: "b"; }

@discriminator("kind")
model OpenBase { kind: "a" | string = "*"; }
model OpenA extends OpenBase { kind: "a"; }
model OpenCustom extends OpenBase { kind: "*"; }

@discriminator("kind")
model ReservedBase { kind: "wildcard" | "other" | string = "*"; }
model ReservedWildcard extends ReservedBase { kind: "wildcard"; }
model ReservedOther extends ReservedBase { kind: "other"; }
model ReservedCustom extends ReservedBase { kind: "*"; }

@discriminator("kind")
model CollidingSlotsBase { kind: "fooBar" | "foo_bar"; }
model CollidingSlotsCamel extends CollidingSlotsBase { kind: "fooBar"; }
model CollidingSlotsSnake extends CollidingSlotsBase { kind: "foo_bar"; }

@discriminator("kind")
model AcronymSlotsBase { kind: "URLValue" | "url_value"; }
model AcronymSlotsUpper extends AcronymSlotsBase { kind: "URLValue"; }
model AcronymSlotsSnake extends AcronymSlotsBase { kind: "url_value"; }

@discriminator("kind")
model DigitSlotsBase { kind: "v1Kind" | "v1_kind"; }
model DigitSlotsLeading extends DigitSlotsBase { kind: "v1Kind"; }
model DigitSlotsPrefixed extends DigitSlotsBase { kind: "v1_kind"; }

@discriminator("kind")
model KeywordSlotsBase { kind: "class" | "class_"; }
model KeywordSlotsKeyword extends KeywordSlotsBase { kind: "class"; }
model KeywordSlotsEscaped extends KeywordSlotsBase { kind: "class_"; }

model Request {
  closed: ClosedBase;
  open: OpenBase;
  reserved: ReservedBase;
  colliding: CollidingSlotsBase;
  acronym: AcronymSlotsBase;
  digit: DigitSlotsBase;
  keyword: KeywordSlotsBase;
}

@delegate(#{ a: "ImplA", b: "ImplB" })
interface WithoutDispatch {
  call(request: Request): string;
}

@dispatch(ClosedBase.kind)
@delegate(#{ a: "ImplA" })
interface Missing {
  call(request: Request): string;
}

@dispatch(ClosedBase.kind)
@delegate(#{ a: "ImplA", b: "ImplB", extra: "ExtraImpl" })
interface Unknown {
  call(request: Request): string;
}

@dispatch(ClosedBase.kind)
@delegate(#{ a: "consumer.ImplA", b: "ImplB" })
interface Unsafe {
  call(request: Request): string;
}

@dispatch(ClosedBase.kind)
@delegate(#{ a: "SharedImpl", b: "SharedImpl" })
interface Collision {
  call(request: Request): string;
}

@dispatch(ClosedBase.kind)
@delegate(#{ a: "ImplA", b: "ImplB", wildcard: "WildcardImpl" })
interface WildcardMisuse {
  call(request: Request): string;
}

@dispatch(OpenBase.kind)
@delegate(#{ a: "ImplA" })
interface MissingWildcard {
  call(request: Request): string;
}

@dispatch(ReservedBase.kind)
@delegate(#{ wildcard: "WildcardImpl", other: "OtherImpl" })
interface ReservedWildcardSlot {
  call(request: Request): string;
}

namespace Nested {
  @dispatch(ClosedBase.kind)
  @delegate(#{ a: "Request", b: "ImplB" })
  interface ParentSymbolCollision {
    call(request: Request): string;
  }
}

@dispatch(ClosedBase.kind)
@delegate(#{ a: "class", b: "ImplB" })
interface ReservedConsumerSymbol {
  call(request: Request): string;
}

@dispatch(ClosedBase.kind)
@delegate(#{ a: "ClosedA", b: "ImplB" })
interface SchemaSymbolCollision {
  call(request: Request): string;
}

@dispatch(CollidingSlotsBase.kind)
@delegate(#{ fooBar: "CamelImpl", foo_bar: "SnakeImpl" })
interface SlotIdentifierCollision {
  call(request: Request): string;
}

@dispatch(AcronymSlotsBase.kind)
@delegate(#{ URLValue: "UpperImpl", url_value: "SnakeImpl" })
interface AcronymSlotIdentifierCollision {
  call(acronym: AcronymSlotsBase): string;
}

@dispatch(DigitSlotsBase.kind)
@delegate(#{ v1Kind: "LeadingImpl", v1_kind: "PrefixedImpl" })
interface DigitSlotIdentifierCollision {
  call(digit: DigitSlotsBase): string;
}

@dispatch(KeywordSlotsBase.kind)
@delegate(#{ `class`: "KeywordImpl", class_: "EscapedImpl" })
interface KeywordSlotIdentifierCollision {
  call(keyword: KeywordSlotsBase): string;
}

@dispatch(ClosedBase.kind)
@delegate(#{ a: "DelegateProvider", b: "ImplB" })
interface DelegateProviderSymbolCollision {
  call(request: Request): string;
}

@dispatch(ClosedBase.kind)
@delegate(#{ a: "TypraGeneratedGeneratedNamesProvider", b: "GeneratedNamesResolver" })
interface GeneratedNames {
  call(request: Request): string;
}

@serializable
model Root {
  request: Request;
}
