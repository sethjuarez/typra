# Typra

Typra owns the generic TypeSpec emitter used to generate multi-runtime model,
protocol, test, JSON AST, and documentation surfaces from TypeSpec.

## Ownership boundary

Typra is emitter-only for this first slice. It owns generic emitter behavior:

- TypeSpec decorators such as `@sample`, `@abstract`, `@coerce`,
  `@@factory`, `@@method`, `@@knownAs`, `@@defaultFor`, and `@@protocol`
- Type graph resolution, lowering, expression expansion, and per-language
  emitters
- Synthetic fixtures that exercise generic emitter shapes
- Generated-file marker and manifest recording infrastructure

Prompty keeps its domain TypeSpec and runtime implementation code. Do not copy
Prompty `schema\model` files wholesale into Typra, and do not let Typra cleanup
own or delete hand-authored runtime adapters.

## First fixture slice

The initial fixture emits TypeScript and JSON AST only from
`packages\typra-emitter\fixtures\shapes\main.tsp`. It covers scalars,
optional fields, arrays, dictionaries, nested models, and discriminated unions.
