# Changelog

All notable changes to `@typra/emitter` are recorded here.

Versions `0.4.3` through `0.4.18` were published from the unmerged branch of PR #36
rather than from `main`, so `main` declared `0.4.2` while npm `latest` was `0.4.18`.
PR #36 has since been merged and `main` is once again the source of truth for releases.

## [2.1.5](https://github.com/sethjuarez/typra/compare/v2.1.4...v2.1.5) (2026-09-03)


### Bug Fixes

* **emitter:** gate Rust collection-field save/load helpers on serializable closure ([#320](https://github.com/sethjuarez/typra/issues/320)) ([3cfef18](https://github.com/sethjuarez/typra/commit/3cfef1854756f0d9cc2059360686eef83a76b7c0))

## [2.1.4](https://github.com/sethjuarez/typra/compare/v2.1.3...v2.1.4) (2026-09-03)


### Bug Fixes

* **emitter:** escape C# reserved-word seam params in vector conformance ([#318](https://github.com/sethjuarez/typra/issues/318)) ([1bad415](https://github.com/sethjuarez/typra/commit/1bad41521b30bf380fd6534f7a463d8e71d4a774))

## [2.1.3](https://github.com/sethjuarez/typra/compare/v2.1.2...v2.1.3) (2026-09-03)


### Bug Fixes

* **emitter:** gate Go ToWire/FromWire on the serializable closure ([#316](https://github.com/sethjuarez/typra/issues/316)) ([7322d97](https://github.com/sethjuarez/typra/commit/7322d973f1d95caf18633fd6a7bacd4f1e824cbc))

## [2.1.2](https://github.com/sethjuarez/typra/compare/v2.1.1...v2.1.2) (2026-09-03)


### Bug Fixes

* **emitter:** skip [@sensitive](https://github.com/sensitive)("save") fields in round-trip test assertions ([#313](https://github.com/sethjuarez/typra/issues/313)) ([92888de](https://github.com/sethjuarez/typra/commit/92888de764822bda9a4dbe612e0890f2928fdffe))

## [2.1.1](https://github.com/sethjuarez/typra/compare/v2.1.0...v2.1.1) (2026-09-02)


### Bug Fixes

* **emitter:** gate round-trip test emission on serializability across all targets ([#311](https://github.com/sethjuarez/typra/issues/311)) ([6b530dd](https://github.com/sethjuarez/typra/commit/6b530dd01bd34c49155a753c29d9a5031a1bd05f))

## [2.1.0](https://github.com/sethjuarez/typra/compare/v2.0.2...v2.1.0) (2026-09-02)


### Features

* **emitter:** emit typed [@vector](https://github.com/vector) conformance rail with opt-in [@serializable](https://github.com/serializable) across 7 runtimes ([#309](https://github.com/sethjuarez/typra/issues/309)) ([3adadea](https://github.com/sethjuarez/typra/commit/3adadeac332a72aa19ad53c7dbcacb8f353ec31a))

## [2.0.2](https://github.com/sethjuarez/typra/compare/v2.0.1...v2.0.2) (2026-08-27)


### Bug Fixes

* **emitter:** coerce value-backed unions on load and fix optional discriminator reads ([#295](https://github.com/sethjuarez/typra/issues/295)) ([294c5f7](https://github.com/sethjuarez/typra/commit/294c5f74c1821671f4f79261414579f98b5b602c))

## [2.0.1](https://github.com/sethjuarez/typra/compare/v2.0.0...v2.0.1) (2026-08-27)


### Bug Fixes

* **emitter:** correct optional and coerce-union discriminator reads in conformance ([#293](https://github.com/sethjuarez/typra/issues/293)) ([cfda53b](https://github.com/sethjuarez/typra/commit/cfda53b422c884aa2a56b63bb3da7e5b481541ec))

## [2.0.0](https://github.com/sethjuarez/typra/compare/v1.2.2...v2.0.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* retire @protocol and @method decorators + language-target emitter fixes (2.0.0)

### Features

* retire [@protocol](https://github.com/protocol) and [@method](https://github.com/method) decorators + language-target emitter fixes (2.0.0) ([1ea0df1](https://github.com/sethjuarez/typra/commit/1ea0df16aac9ab1226253a96d82b3f07c54115a7))

## [1.2.2](https://github.com/sethjuarez/typra/compare/v1.2.1...v1.2.2) (2026-08-27)


### Bug Fixes

* **emitter:** resolver provider-discriminator collision and open-union defaultVariant slot ([#289](https://github.com/sethjuarez/typra/issues/289)) ([df5ae3d](https://github.com/sethjuarez/typra/commit/df5ae3d0b4167296492b6b7acfd2f8b77a7e928a))

## [1.2.1](https://github.com/sethjuarez/typra/compare/v1.2.0...v1.2.1) (2026-08-27)


### Bug Fixes

* **emitter:** non-model [@vector](https://github.com/vector) conformance param mapping + open-union loader fallback ([#287](https://github.com/sethjuarez/typra/issues/287)) ([5b3ca3e](https://github.com/sethjuarez/typra/commit/5b3ca3ec242cb00b31520fa87d9c5e94dcce5a37))

## [1.2.0](https://github.com/sethjuarez/typra/compare/v1.1.0...v1.2.0) (2026-08-27)


### Features

* **emitter:** resolve [@dispatch](https://github.com/dispatch) discriminator through coerce-canonical union arms ([#286](https://github.com/sethjuarez/typra/issues/286)) ([cd8e58d](https://github.com/sethjuarez/typra/commit/cd8e58de7c5a9e3ed3764ffec83347e3fa3a680b))


### Bug Fixes

* **emitter:** parse YAML without a CommonJS require so the TypeScript library loads on the web ([#284](https://github.com/sethjuarez/typra/issues/284)) ([052c3cb](https://github.com/sethjuarez/typra/commit/052c3cbd57e196cd8352a7af1fd51e647ca55266))

## [1.1.0](https://github.com/sethjuarez/typra/compare/v1.0.1...v1.1.0) (2026-08-26)


### Features

* **emitter:** emit symmetric fromWire(provider) for [@known](https://github.com/known)As wire mappings ([#276](https://github.com/sethjuarez/typra/issues/276)) ([f7ecba8](https://github.com/sethjuarez/typra/commit/f7ecba82d7984dfdca2a695bba5dcf5131abeebe))
* **emitter:** generate requirement guard for [@vector](https://github.com/vector) conformance harnesses ([#275](https://github.com/sethjuarez/typra/issues/275)) ([7cfba88](https://github.com/sethjuarez/typra/commit/7cfba88294bc2819cf8742f5ef06fac5ec780755))
* **emitter:** resolve [@dispatch](https://github.com/dispatch) discriminator access path in callable IR (Part II-A) ([#280](https://github.com/sethjuarez/typra/issues/280)) ([45fdf05](https://github.com/sethjuarez/typra/commit/45fdf05d5983e0dffe46bfd7fd15c49a021aac7f))
* **emitter:** route [@dispatch](https://github.com/dispatch) by discriminator in emitted vector harness ([#281](https://github.com/sethjuarez/typra/issues/281)) ([bdd4ef9](https://github.com/sethjuarez/typra/commit/bdd4ef9e23d7a8b1875dd38172ff820fbac9a626))
* **emitter:** typed [@dispatch](https://github.com/dispatch) resolver reusing the polymorphic-dispatch rail ([#283](https://github.com/sethjuarez/typra/issues/283)) ([c126d1f](https://github.com/sethjuarez/typra/commit/c126d1fcbe3abe96fb3fcf9af0bd0181cd652354))

## [1.0.1](https://github.com/sethjuarez/typra/compare/v1.0.0...v1.0.1) (2026-08-21)


### Bug Fixes

* **emitter:** disambiguate colliding leaf modules in Rust glob re-exports ([#269](https://github.com/sethjuarez/typra/issues/269)) ([1ab72e3](https://github.com/sethjuarez/typra/commit/1ab72e3a1a95b2299f2a6102f84aef3889fecf14))

## [1.0.0](https://github.com/sethjuarez/typra/compare/v0.13.0...v1.0.0) (2026-08-21)


### ⚠ BREAKING CHANGES

* **emitter:** An emit target other than Swift that sets test-resources or harness-test-dir now fails emission with the typra-emitter-target-option-scope diagnostic instead of silently ignoring the option. Configs relying on the previous silent no-op must remove those options from non-Swift targets. Swift targets and inert values (empty array / blank string) are unaffected.

### Features

* **emitter:** downstream drift fixes, per-vector waiver proofs, and fail-closed option scoping ([#267](https://github.com/sethjuarez/typra/issues/267)) ([df218c9](https://github.com/sethjuarez/typra/commit/df218c957f4b6afbcaac033b1347bdbc7902a08e))


### Bug Fixes

* **emitter:** lock formatter idempotency for Python/TypeScript/Go/C# and document deferrals ([#238](https://github.com/sethjuarez/typra/issues/238)) ([#263](https://github.com/sethjuarez/typra/issues/263)) ([705a447](https://github.com/sethjuarez/typra/commit/705a4477fbcf9f875e425400c3b26455b351dc2e))

## [0.13.0](https://github.com/sethjuarez/typra/compare/v0.12.0...v0.13.0) (2026-08-20)


### Features

* **emitter:** let consumers declare a custom formatter command ([#256](https://github.com/sethjuarez/typra/issues/256)) ([379a643](https://github.com/sethjuarez/typra/commit/379a64397d58bac6b219973027a9d4a3965cfd3c))
* **emitter:** make [@vector](https://github.com/vector) conformance harnesses async-capable across targets ([#257](https://github.com/sethjuarez/typra/issues/257)) ([235bd6e](https://github.com/sethjuarez/typra/commit/235bd6e18a3615839aeeca365160a655196cd3a2))


### Bug Fixes

* **emitter:** indent Python root __init__ child-type imports with 4 spaces ([#253](https://github.com/sethjuarez/typra/issues/253)) ([cc7ab69](https://github.com/sethjuarez/typra/commit/cc7ab69d95eb4852e82097bf8cd0976a4b9c5787))

## [0.12.0](https://github.com/sethjuarez/typra/compare/v0.11.0...v0.12.0) (2026-08-20)


### Features

* **fixtures:** enforce [@vector](https://github.com/vector) behavioral conformance across the full target matrix ([#248](https://github.com/sethjuarez/typra/issues/248)) ([a85a99b](https://github.com/sethjuarez/typra/commit/a85a99b1abb501ef354fff5e68c80e5eaf1f45d9))

## [0.11.0](https://github.com/sethjuarez/typra/compare/v0.10.0...v0.11.0) (2026-08-19)


### Features

* **emitter:** add fallible try_load_from_value for Rust value loading ([#210](https://github.com/sethjuarez/typra/issues/210)) ([#242](https://github.com/sethjuarez/typra/issues/242)) ([d8a51fb](https://github.com/sethjuarez/typra/commit/d8a51fb1d547b81789e3f2b8cf99092d52b9002d))

## [0.10.0](https://github.com/sethjuarez/typra/compare/v0.9.4...v0.10.0) (2026-08-19)


### Features

* **emitter:** add formatter-idempotency guard for native output ([#240](https://github.com/sethjuarez/typra/issues/240)) ([2696775](https://github.com/sethjuarez/typra/commit/26967751dc3aa19a1269873d64d6adf4127df8b5))

## [0.9.4](https://github.com/sethjuarez/typra/compare/v0.9.3...v0.9.4) (2026-08-19)


### Bug Fixes

* **emitter:** warn instead of silently swallowing missing formatters ([#237](https://github.com/sethjuarez/typra/issues/237)) ([faf6dbd](https://github.com/sethjuarez/typra/commit/faf6dbdd927f2d259c317d3814cccf3d30749380))

## [0.9.3](https://github.com/sethjuarez/typra/compare/v0.9.2...v0.9.3) (2026-08-18)


### Bug Fixes

* **emitter:** scale relative Python cancellation-token import by file group depth ([#235](https://github.com/sethjuarez/typra/issues/235)) ([333fb0f](https://github.com/sethjuarez/typra/commit/333fb0fb224cf39dfaa504607ff2475065cf911e))

## [0.9.2](https://github.com/sethjuarez/typra/compare/v0.9.1...v0.9.2) (2026-08-18)


### Bug Fixes

* **java:** render enum values as typed literals in scalar-coercion load tests ([6d4bde8](https://github.com/sethjuarez/typra/commit/6d4bde80a7875f1058ffde9fb4c3862e3318842c))

## [0.9.1](https://github.com/sethjuarez/typra/compare/v0.9.0...v0.9.1) (2026-08-18)


### Bug Fixes

* **swift:** default absent required scalar/dict on union subtypes ([2f0e5f8](https://github.com/sethjuarez/typra/commit/2f0e5f8dc62178d732551227c24b10442c1a3dad))

## [0.9.0](https://github.com/sethjuarez/typra/compare/v0.8.7...v0.9.0) (2026-08-18)


### Features

* **deps:** support [@typespec](https://github.com/typespec) 1.15.x via peer range widening ([#228](https://github.com/sethjuarez/typra/issues/228)) ([69f5ddf](https://github.com/sethjuarez/typra/commit/69f5ddff9a5142aebbd1dddf878649d5979a1350))

## [0.8.7](https://github.com/sethjuarez/typra/compare/v0.8.6...v0.8.7) (2026-08-17)


### Bug Fixes

* **deps:** patch tar/fast-uri transitives and add grouped Dependabot config ([#222](https://github.com/sethjuarez/typra/issues/222)) ([b93378f](https://github.com/sethjuarez/typra/commit/b93378f61c9f118ec3b63983cd67c466594b795b))

## [0.8.6](https://github.com/sethjuarez/typra/compare/v0.8.5...v0.8.6) (2026-08-17)


### Bug Fixes

* **emitter:** elide dead LoadContext guard for leaf Go loaders ([#220](https://github.com/sethjuarez/typra/issues/220)) ([21e4155](https://github.com/sethjuarez/typra/commit/21e4155c3970ffcb16aed967e44358ea551cfeda))

## [0.8.5](https://github.com/sethjuarez/typra/compare/v0.8.4...v0.8.5) (2026-08-14)


### Bug Fixes

* **cleanup:** preserve files re-emitted under a different case on case-insensitive filesystems ([#217](https://github.com/sethjuarez/typra/issues/217)) ([c80d46d](https://github.com/sethjuarez/typra/commit/c80d46d2dced492729aab41bae48d8320d525ebd))
* **csharp:** emit PascalCase subfolders for lowercase TSP source groups ([#216](https://github.com/sethjuarez/typra/issues/216)) ([30d02eb](https://github.com/sethjuarez/typra/commit/30d02eb268a04ecbab4bc672a8b07f0840ee2a85))

## [0.8.4](https://github.com/sethjuarez/typra/compare/v0.8.3...v0.8.4) (2026-08-14)


### Bug Fixes

* make nested TypeSpec namespaces authoritative for per-target module paths ([#213](https://github.com/sethjuarez/typra/issues/213)) ([866d4bf](https://github.com/sethjuarez/typra/commit/866d4bfd0ad7a12a5cbf5419d891928bf52f5c08))

## [0.8.3](https://github.com/sethjuarez/typra/compare/v0.8.2...v0.8.3) (2026-08-14)


### Bug Fixes

* scope stale-file pruning to output roots the current run emitted ([#211](https://github.com/sethjuarez/typra/issues/211)) ([4592ee0](https://github.com/sethjuarez/typra/commit/4592ee07a1d8a019b8383bed0070b4078934e407))

## [0.8.2](https://github.com/sethjuarez/typra/compare/v0.8.1...v0.8.2) (2026-08-13)


### Bug Fixes

* drop model-typed load/save round-trip from vector conformance ([#208](https://github.com/sethjuarez/typra/issues/208)) ([13df485](https://github.com/sethjuarez/typra/commit/13df4857f086f6603f7738809ff08c1977f9a8b7))

## [0.8.1](https://github.com/sethjuarez/typra/compare/v0.8.0...v0.8.1) (2026-08-13)


### Bug Fixes

* scope Go ToWire test assertions to populated wire fields ([e521726](https://github.com/sethjuarez/typra/commit/e521726cbd85d1e83519957a16415a04c88d2466))

## [0.8.0](https://github.com/sethjuarez/typra/compare/v0.7.0...v0.8.0) (2026-08-13)


### Features

* accept JSON-string [@vector](https://github.com/vector) sets for keyword-named and opaque wire inputs ([#204](https://github.com/sethjuarez/typra/issues/204)) ([74bea30](https://github.com/sethjuarez/typra/commit/74bea3008ae32bc7c7080a2ddd4c095e6061c2b3))

## [0.7.0](https://github.com/sethjuarez/typra/compare/v0.6.2...v0.7.0) (2026-08-13)


### Features

* add typescript fetch consumer projection ([8344c29](https://github.com/sethjuarez/typra/commit/8344c29279eef6985086dccf8173e92e31945801))
* add typra v2 contract projection foundations ([6765980](https://github.com/sethjuarez/typra/commit/6765980e1bba85a4e8d216a9af59f870a3fcff59))
* complete transport fixture roadmap ([c7f3f46](https://github.com/sethjuarez/typra/commit/c7f3f46c5be104eeba305f702ec4a0ff48d0df8c))
* complete transport roadmap slice ([#196](https://github.com/sethjuarez/typra/issues/196)) ([01c279f](https://github.com/sethjuarez/typra/commit/01c279fb10b1d03520ad4394377ed6bab4e49327))
* **emitter:** 0.4.2 - Go extends flattening, Rust first-class serde, keyed-collection 2nd-sibling fix ([24321e9](https://github.com/sethjuarez/typra/commit/24321e9a80a6595d339b5c06c2da04218a7b9240))
* **emitter:** add method effect metadata ([6d3a850](https://github.com/sethjuarez/typra/commit/6d3a850fd67e894df80c7fcb5e38dee36ea50b4f))
* **emitter:** gate Rust serde serialization option ([512c67d](https://github.com/sethjuarez/typra/commit/512c67d7ba266ae8ed48cf7b18488564b4213a93))
* **java:** add editable method extension seams ([a969b27](https://github.com/sethjuarez/typra/commit/a969b27ed33d9d68fe8d298c9c3cca96ec23c7b6))
* **java:** add opt-in Jackson serialization ([#152](https://github.com/sethjuarez/typra/issues/152)) ([d7c4155](https://github.com/sethjuarez/typra/commit/d7c4155f89ed719a3df592741328d95de351dba2))
* **python:** add pydantic native serialization option ([655440b](https://github.com/sethjuarez/typra/commit/655440be95b5438379d3a65256b41d72ffa77eda))
* **rust:** complete serde native serialization validation ([1221448](https://github.com/sethjuarez/typra/commit/122144896b541019f474b7281b91cc568a948f0d))
* **swift:** add codable native serialization option ([#162](https://github.com/sethjuarez/typra/issues/162)) ([51f9f40](https://github.com/sethjuarez/typra/commit/51f9f40803f1be9134110f949064f5dedab0140e))
* **typescript:** add zod native serialization option ([#155](https://github.com/sethjuarez/typra/issues/155)) ([d796512](https://github.com/sethjuarez/typra/commit/d796512e7021e6c000c17c7b3226e98692982deb))


### Bug Fixes

* **csharp,go:** load inherited named collections ([34078ab](https://github.com/sethjuarez/typra/commit/34078ab5ff0bcf985ff9638a16263a84a3c0558c))
* **csharp,python:** preserve unknown connections ([56106a7](https://github.com/sethjuarez/typra/commit/56106a72643d2780332fcd0c0948431f2be1529f))
* **csharp:** align generated consumer expectations ([365ca09](https://github.com/sethjuarez/typra/commit/365ca093f24e5c0878f52b615ba3119be9b71fc5))
* **csharp:** align generated consumer expectations ([5c15621](https://github.com/sethjuarez/typra/commit/5c15621dece5546f8ce52e3286261ec6ad835a42))
* **csharp:** align unknown record nullability ([333d8f3](https://github.com/sethjuarez/typra/commit/333d8f390456f05990a3f57b14fd5f7abeab5b06))
* **csharp:** complete generated test fixtures with required complex fields ([#81](https://github.com/sethjuarez/typra/issues/81)) ([c919a99](https://github.com/sethjuarez/typra/commit/c919a99f8620335e19e56e59208d5bb3f87a0e97))
* **csharp:** emit nullable unknown record values ([0952496](https://github.com/sethjuarez/typra/commit/095249633bf44875f03d9ff7e4e732f35ed4f4f2))
* **csharp:** limit YAML whitespace folding ([2f982d3](https://github.com/sethjuarez/typra/commit/2f982d345ef6028e8fd54e6a2bdcda89784cad45))
* **csharp:** limit YAML whitespace folding ([e872b12](https://github.com/sethjuarez/typra/commit/e872b12b9ad13c96ef64a7988098e399f65d95a0))
* **csharp:** normalize YAML named collections ([fc1ea4f](https://github.com/sethjuarez/typra/commit/fc1ea4f1b72cc872c8f7c430d9ed0b100b36119d))
* **csharp:** numeric width parity and uncompilable generated tests (0.4.30) ([#95](https://github.com/sethjuarez/typra/issues/95)) ([dd0625c](https://github.com/sethjuarez/typra/commit/dd0625c076230d7ffec703f232e23093886edda4))
* **csharp:** preserve unknown record nullability ([a265989](https://github.com/sethjuarez/typra/commit/a265989ad8f83b81487a8aec679ec58b1d175e19))
* **csharp:** preserve whitespace in generated assertions ([2ad94ff](https://github.com/sethjuarez/typra/commit/2ad94fface861bbd3af766b60df1bf593f7a857f))
* **csharp:** simplify guarded scalar loads ([fd20d26](https://github.com/sethjuarez/typra/commit/fd20d26258e2c42e4aa83ec30fec981c379f39e5))
* **csharp:** stop folding multiline YAML fixtures and run every generated C# test ([625098b](https://github.com/sethjuarez/typra/commit/625098b1e3c832c6a263eebcf3846a478a0e47bf))
* **csharp:** stop folding multiline YAML fixtures and run every generated C# test ([de356d8](https://github.com/sethjuarez/typra/commit/de356d8428cb73c4cb765bb78a1bd45169cbb79d)), closes [#93](https://github.com/sethjuarez/typra/issues/93) [#94](https://github.com/sethjuarez/typra/issues/94)
* **diagnostics:** report array element indices in load paths ([4f5ff4c](https://github.com/sethjuarez/typra/commit/4f5ff4c7dea60d97bb338085dc40c89b68407bd7))
* **diagnostics:** report array element indices in load paths ([d9f089d](https://github.com/sethjuarez/typra/commit/d9f089d9e68c898690af1131b8d505016764768e))
* **emitter:** align canonical method fixture ([b182fe3](https://github.com/sethjuarez/typra/commit/b182fe366d83c4587425baf23b105cb4380ddf44))
* **emitter:** always fail load on a missing required complex field ([2572b95](https://github.com/sethjuarez/typra/commit/2572b9581223ebc729cb9fa8893604a7fe8ddc1a))
* **emitter:** always fail load on a missing required complex field ([a27615c](https://github.com/sethjuarez/typra/commit/a27615ce4fc2bff2c128fc74db0c4af54f256b66)), closes [#104](https://github.com/sethjuarez/typra/issues/104) [#105](https://github.com/sethjuarez/typra/issues/105)
* **emitter:** carry open discriminator fallbacks ([5a6ecdb](https://github.com/sethjuarez/typra/commit/5a6ecdb95847225bcb4eae6106e33559156e4c0a))
* **emitter:** carry optional/nullable through the native operation seam ([#203](https://github.com/sethjuarez/typra/issues/203)) ([edd7e66](https://github.com/sethjuarez/typra/commit/edd7e6652de08a241021c645371d72fc4a2d464c))
* **emitter:** complete Java generated test parity ([d6344b9](https://github.com/sethjuarez/typra/commit/d6344b95a55275976bc115333c9777505f95692c))
* **emitter:** complete Swift consumer parity ([21d4279](https://github.com/sethjuarez/typra/commit/21d4279e999dbe44195ff157ad80cd1fb9f82600))
* **emitter:** encode trim-sensitive YAML portably ([7595113](https://github.com/sethjuarez/typra/commit/75951135dfe04d22f002c40a815eed5cc7377e18))
* **emitter:** enforce discriminator runtime contract ([#158](https://github.com/sethjuarez/typra/issues/158)) ([e38b97f](https://github.com/sethjuarez/typra/commit/e38b97f77194d9ea4851292db0e9350caa71d762))
* **emitter:** finalize cross-runtime parity ([2678593](https://github.com/sethjuarez/typra/commit/2678593460b13619019744c893f65ee94fd720f5))
* **emitter:** harden Swift unknown fallbacks ([#149](https://github.com/sethjuarez/typra/issues/149)) ([090edcc](https://github.com/sethjuarez/typra/commit/090edcc2e4c25ad2f5b89edc5f5c856219a2721a))
* **emitter:** integrate residual runtime parity ([79af6f7](https://github.com/sethjuarez/typra/commit/79af6f7bc6b676e21e7478e7b74993c3fc9e6411))
* **emitter:** preserve explicit collection defaults ([74df347](https://github.com/sethjuarez/typra/commit/74df347385cc7df868dff4bb32244b1b278f211d))
* **emitter:** preserve named collections losslessly ([628e4ae](https://github.com/sethjuarez/typra/commit/628e4ae7d20cd7dafe2964d4d48e68af3058e066))
* **emitter:** preserve typed record values ([4763f75](https://github.com/sethjuarez/typra/commit/4763f7555e2c2e657466b63224fbb1aa7d55fc0d))
* **emitter:** reject closed discriminator fallbacks ([3d526eb](https://github.com/sethjuarez/typra/commit/3d526ebfc2bb106fb3f32d7c5a03c3c155b1c7d7))
* **emitter:** reject invalid discriminator states ([#157](https://github.com/sethjuarez/typra/issues/157)) ([8476b95](https://github.com/sethjuarez/typra/commit/8476b9525f9f5235bcfffcc8a1ef1921d3f52b40))
* **emitter:** reject missing required wildcard fields ([5a3a7f8](https://github.com/sethjuarez/typra/commit/5a3a7f890cee1af51326808754633d62044bcd15))
* **fixtures:** deduplicate Rust YAML option ([14283f0](https://github.com/sethjuarez/typra/commit/14283f06baaa92d3ca84b1b8c0961f41212628cf))
* **go:** bridge decoder-native numeric types in scalar coercions ([97103e6](https://github.com/sethjuarez/typra/commit/97103e65e6b43c7cfbd6abb8e2835bccf655f383))
* **go:** bridge decoder-native numeric types in scalar coercions ([9efe71c](https://github.com/sethjuarez/typra/commit/9efe71c4b73e819c500950cd65e0cf7924cbed07))
* **go:** export normalized wire fields ([57403bc](https://github.com/sethjuarez/typra/commit/57403bc1d3e5aa0356a37255012ade92bbc71116))
* **go:** export safe fields and terminal loaders ([4b4761f](https://github.com/sethjuarez/typra/commit/4b4761fe4d8e32446baf2446b3e672d1552d65e3))
* **go:** export safe fields and terminal loaders ([0780150](https://github.com/sethjuarez/typra/commit/07801506c14ca0316681310706fd3df761c2292b))
* **go:** guard math import to named collection shorthand ([#137](https://github.com/sethjuarez/typra/issues/137)) ([2ade20d](https://github.com/sethjuarez/typra/commit/2ade20d1fc1c8991ff1c21dd6673c099c26fa060))
* **go:** load self-referential discriminator defaults ([258482f](https://github.com/sethjuarez/typra/commit/258482f2bf277f13a48c19d51a6599fd9435051b))
* **go:** normalize generated YAML expectations ([635eed3](https://github.com/sethjuarez/typra/commit/635eed3552d3a1bb58d4b7a301124c2ec03635ec))
* **go:** preserve exact YAML expectations ([c816b25](https://github.com/sethjuarez/typra/commit/c816b25e43f4da971f5be20e67f718e836829b8b))
* **go:** preserve trim-sensitive YAML fixtures ([97a0e46](https://github.com/sethjuarez/typra/commit/97a0e464199ac85e37f29f8056a1ea0eab387a07))
* **go:** preserve trim-sensitive YAML samples ([ed2d34c](https://github.com/sethjuarez/typra/commit/ed2d34c61911dc72d48ccb1f0a4aecdc74050723))
* **go:** preserve unknown connection payloads ([026e53a](https://github.com/sethjuarez/typra/commit/026e53a67bf991243892fef3b58cad9f3b631995))
* **go:** quote unsafe multiline YAML samples ([8b0fd6c](https://github.com/sethjuarez/typra/commit/8b0fd6cf2ee4b931ac235c3202a218e81656c9d9))
* **go:** quote whitespace-only YAML lines ([f95fb8e](https://github.com/sethjuarez/typra/commit/f95fb8efadb6b693ca1b93ffa8c5d81bb07e8b84))
* **go:** retain collision-safe field prefixes ([dffae44](https://github.com/sethjuarez/typra/commit/dffae445d45f94adfa467db1904ac5f71dafd6b1))
* **go:** retain collision-safe field prefixes ([19e507b](https://github.com/sethjuarez/typra/commit/19e507b0442ac16af215a8a834a68ce77ba3c6ce))
* **go:** stop conflating abstract with closed in polymorphic dispatch ([a8ffd68](https://github.com/sethjuarez/typra/commit/a8ffd6858fa5838b011531ae18f4f90f7c07ded4))
* **go:** stop conflating abstract with closed in polymorphic dispatch ([e6b2194](https://github.com/sethjuarez/typra/commit/e6b219463d906c055e4e939e39af4b38321b45dc))
* **harness:** detect fixture validation under-execution ([266e33c](https://github.com/sethjuarez/typra/commit/266e33cb0ef0d2557febddac3611d794ce543af1))
* **ir:** enforce closed discriminator schemas ([8adf917](https://github.com/sethjuarez/typra/commit/8adf917a0077433b8e768594bbe4c5442f16972b))
* **ir:** let a declared wildcard subtype own the open discriminator decision ([7c864da](https://github.com/sethjuarez/typra/commit/7c864da0779c3107e6a3f4b241d6020a4ab2352e))
* **ir:** let a non-abstract base absorb unclaimed discriminator values ([0a5aa85](https://github.com/sethjuarez/typra/commit/0a5aa850da001c3b466c7707cb9ed5859f142cf2))
* **ir:** let a non-abstract base absorb unclaimed discriminator values ([e06e9f1](https://github.com/sethjuarez/typra/commit/e06e9f16e74dd4ce31615a5ae492d94418871551))
* **java,go:** close consumer contract gaps ([3a896d2](https://github.com/sethjuarez/typra/commit/3a896d2e5716f8c1be955b877d929077f4d80481))
* **java:** absorb unrecognized discriminators on abstract open bases ([#131](https://github.com/sethjuarez/typra/issues/131)) ([fa6cc6a](https://github.com/sethjuarez/typra/commit/fa6cc6a431dbe23b0ee6e77692d405a8f6a90416))
* **java:** assert collection shorthand correctly ([70da06c](https://github.com/sethjuarez/typra/commit/70da06caf7e6a9bf738cbe33e9f9954a9b846cd0))
* **java:** assert named collection shapes ([18253a9](https://github.com/sethjuarez/typra/commit/18253a9d54dd9f0817f8ce4f664d9154f166f5e9))
* **java:** complete residual collection semantics ([2ef1ec9](https://github.com/sethjuarez/typra/commit/2ef1ec9fed8ad9a2539c6d649dfcc93f3568217f))
* **java:** complete runtime parity emission ([910b730](https://github.com/sethjuarez/typra/commit/910b730f1092cbe837b6bd29519e119e9bca3c84))
* **java:** distinguish integral coercions ([7b0ba57](https://github.com/sethjuarez/typra/commit/7b0ba57615486c19c4ee5babcb1e7ed584b9821b))
* **java:** emit safe public model names ([855b39b](https://github.com/sethjuarez/typra/commit/855b39b4ffed1647fc317604862860e603889cf1))
* **java:** escape control characters in generated JSON output ([#128](https://github.com/sethjuarez/typra/issues/128)) ([754b072](https://github.com/sethjuarez/typra/commit/754b072e032620632a3bbcf793dfc47400338481)), closes [#113](https://github.com/sethjuarez/typra/issues/113)
* **java:** harden loading and factory literals ([77d1aec](https://github.com/sethjuarez/typra/commit/77d1aec7998a03c96cefeb9503aaa47fa8b0e657))
* **java:** keep enum collection defaults typed ([ca6c263](https://github.com/sethjuarez/typra/commit/ca6c26333d6b8a4fb7ac4eb243890d96cee882cc))
* **java:** make the editable-seam marker reachable and cleaner-aware ([ab36629](https://github.com/sethjuarez/typra/commit/ab36629ea2c81bb679688e428fda957d2376d624))
* **java:** mark editable method seams ([a642ead](https://github.com/sethjuarez/typra/commit/a642ead7aa3c00a2319fceb41459c21420f21439))
* **java:** mark editable method seams ([8226f97](https://github.com/sethjuarez/typra/commit/8226f97ad332953b7f8565fdd871a6db98058e93))
* **java:** preserve duplicate named entries ([332bdb9](https://github.com/sethjuarez/typra/commit/332bdb989c8acc3a523b3e286557bf1c51355ee7))
* **java:** recognize numeric coercion families ([cdf3be1](https://github.com/sethjuarez/typra/commit/cdf3be15b023aec5d6989357dbfbc9e2ef8d1aab))
* **java:** reject ambiguous numeric guards ([0087443](https://github.com/sethjuarez/typra/commit/0087443bccb49d975e950b64c4238e5f0f250ae8))
* **java:** route integral coercions first ([edf4cd7](https://github.com/sethjuarez/typra/commit/edf4cd716806f767931241f38930de3ae6feb6da))
* **java:** sanitize union test temporaries ([5a9240f](https://github.com/sethjuarez/typra/commit/5a9240f6d272b4a2a1323f2a661bb1a85d5d0961))
* omit wire fields for providers that declare no mapping ([#85](https://github.com/sethjuarez/typra/issues/85)) ([c01f3c0](https://github.com/sethjuarez/typra/commit/c01f3c0540327726749ed51f55e2fe57a969c4e4))
* prune generated files a run no longer produces ([#82](https://github.com/sethjuarez/typra/issues/82)) ([#83](https://github.com/sethjuarez/typra/issues/83)) ([d33d73f](https://github.com/sethjuarez/typra/commit/d33d73fb10a13aeb101c7a392da90b67aff152c1))
* **python:** emit valid Python literals and substituted factory assertions in generated tests ([b842515](https://github.com/sethjuarez/typra/commit/b8425156cf316484af42f13eed40e14e422ecea6))
* **python:** emit valid Python literals and substituted factory assertions in generated tests ([0f29dca](https://github.com/sethjuarez/typra/commit/0f29dca3cf4284cc18929701f1fd179d2f81438e)), closes [#107](https://github.com/sethjuarez/typra/issues/107)
* **python:** keep cancellable helpers callable ([0b8ebc1](https://github.com/sethjuarez/typra/commit/0b8ebc1494be991364c76c2004cbf3f5ca0986aa))
* **python:** preserve multiline fixture whitespace ([cfc8d6d](https://github.com/sethjuarez/typra/commit/cfc8d6d42b0b40b718647cfc8d0edf93053c8ce9))
* **python:** preserve multiline test expectations ([4cbc4f0](https://github.com/sethjuarez/typra/commit/4cbc4f02a823a8a6faf99b32229c2c0a62dcb3ef))
* **python:** preserve optional collection absence ([3c35a89](https://github.com/sethjuarez/typra/commit/3c35a89ccbcf463a756888f1d918e48e4bfb6f62))
* **python:** preserve ordered model collections ([f07b1c2](https://github.com/sethjuarez/typra/commit/f07b1c254b64c70acb1f6bf866f76f94b1617fab))
* **python:** route pydantic validation entry points through typra ([5e9eab6](https://github.com/sethjuarez/typra/commit/5e9eab6e9ba6f972d33927cd9f4506e2f938eb07))
* route named-collection entry shorthand to a declared field across all backends ([#76](https://github.com/sethjuarez/typra/issues/76)) ([#77](https://github.com/sethjuarez/typra/issues/77)) ([a331fee](https://github.com/sethjuarez/typra/commit/a331fee4cfd3822d3ac137b22c2e4a4d75348370))
* **rust,csharp,swift:** carry the element index in array diagnostics ([#88](https://github.com/sethjuarez/typra/issues/88)) ([c52881c](https://github.com/sethjuarez/typra/commit/c52881c960abae31b19ff3b549d4d54567ad48d8))
* **rust:** borrow direct optional fields ([34c0270](https://github.com/sethjuarez/typra/commit/34c0270005f708e86ae2c1128457a217c9390c03))
* **rust:** collapse entry shorthand when saving name-keyed collections ([#90](https://github.com/sethjuarez/typra/issues/90)) ([039f448](https://github.com/sethjuarez/typra/commit/039f44866e6344f4fd9ab3a0dcbfdd6997c6144b))
* **rust:** emit float32 coercions ([374af45](https://github.com/sethjuarez/typra/commit/374af45ccc5a2331695933ea2e7c54022fc2a726))
* **rust:** emit required zero values ([#124](https://github.com/sethjuarez/typra/issues/124)) ([838cb89](https://github.com/sethjuarez/typra/commit/838cb89194df42ef0f861a5278ee72f30360e50f)), closes [#97](https://github.com/sethjuarez/typra/issues/97)
* **rust:** materialize defaulted collections ([db7bcd6](https://github.com/sethjuarez/typra/commit/db7bcd650c965368f318eccae34b3eb24caf5480))
* **rust:** materialize explicit collection defaults ([a71a573](https://github.com/sethjuarez/typra/commit/a71a573ad72a8e08cf1412645b79da3a5b2ef192))
* **rust:** preserve function tool parameters ([e2d184d](https://github.com/sethjuarez/typra/commit/e2d184d931afc20953ced8f6725d9b1af43fdcfc))
* **rust:** preserve primitive kind and f64 precision on immediate scalars ([#74](https://github.com/sethjuarez/typra/issues/74)) ([d5c3198](https://github.com/sethjuarez/typra/commit/d5c3198c12cc735080e8bd438387e92ba90d442c)), closes [#73](https://github.com/sethjuarez/typra/issues/73)
* **rust:** preserve unknown abstract variants ([be24112](https://github.com/sethjuarez/typra/commit/be241122617745590c80a708a637c7f15e1720c1))
* **rust:** preserve unknown connection payloads ([e94afc0](https://github.com/sethjuarez/typra/commit/e94afc0e6bb2bca8d2fe7a8640570846ff78bc30))
* **rust:** stop pre-validating open discriminators against their declared union ([92779d7](https://github.com/sethjuarez/typra/commit/92779d76c42b179846a233db46fe8d45f8f9d18a))
* **rust:** stop pre-validating open discriminators against their declared union ([031312f](https://github.com/sethjuarez/typra/commit/031312f83e14688e1bdf9440a959c21e08f819fd)), closes [#38](https://github.com/sethjuarez/typra/issues/38)
* **rust:** support 2024 variant borrowing ([6c8f1c2](https://github.com/sethjuarez/typra/commit/6c8f1c28d5de37b90b8fbb9064c954ad0f299409))
* **scripts:** raise child-process maxBuffer in fixture validation ([8ddb500](https://github.com/sethjuarez/typra/commit/8ddb50085f82113a7ac21de8120c7dbb355071b0))
* **swift:** compile generated model tests ([a6481b8](https://github.com/sethjuarez/typra/commit/a6481b8624144602f589d88217e8e17bacf9b8ab))
* **swift:** compile named unions without shims ([df6b291](https://github.com/sethjuarez/typra/commit/df6b29164717226d59a4ea67373914eb111754c9))
* **swift:** complete named collection fallbacks ([07b7df7](https://github.com/sethjuarez/typra/commit/07b7df79e1c3a92bd07562b4aabf6366cb71ce9b))
* **swift:** complete named collection parity ([bf2d54d](https://github.com/sethjuarez/typra/commit/bf2d54deef56595406892ca24e81d54102af084b))
* **swift:** inject named keys before loading ([7c3810b](https://github.com/sethjuarez/typra/commit/7c3810bd3b9866d9012252d12a5c5c63ddc02dc3))
* **swift:** preserve inherited model fields ([1abab8a](https://github.com/sethjuarez/typra/commit/1abab8a1e810f9529e230a0323efa602e6c0e6ec))
* **swift:** preserve keyed binding semantics ([babf30b](https://github.com/sethjuarez/typra/commit/babf30b5aaf1df8b70ee75d4f697e790f40a8688))
* **swift:** preserve named collection shapes ([50a98c6](https://github.com/sethjuarez/typra/commit/50a98c6060304b549af2658640ee3085ceba0e17))
* **swift:** preserve polymorphic model contracts ([b653b7d](https://github.com/sethjuarez/typra/commit/b653b7d6a4fd12398dc42531ceeb91e23a594860))
* **swift:** preserve Tool wildcard ownership ([da6160e](https://github.com/sethjuarez/typra/commit/da6160eb3625b24b660dacc1e5f00fcf088106f2))
* **swift:** restore Prompty compile parity ([d477de7](https://github.com/sethjuarez/typra/commit/d477de7268aa0efd432a5c2ed9bb3dc1a9b38890))
* **swift:** round-trip named tool bindings ([9550fc4](https://github.com/sethjuarez/typra/commit/9550fc4d35ab30b4b06b8aea6cbdd556e9c0fb5a))
* **swift:** sort named dictionary collections ([99b747b](https://github.com/sethjuarez/typra/commit/99b747be96d2eb14c132d7e2f8717ec3443dea12))
* **swift:** support named polymorphic collections ([d4f02f2](https://github.com/sethjuarez/typra/commit/d4f02f23d22b4c081ac167048af56d4fa3e2cae5))
* **swift:** validate generated consumer suites ([012271f](https://github.com/sethjuarez/typra/commit/012271fc9741b47c0562bf022a2d09afb33d5b53))
* **testing:** name a concrete variant when the fixture root is a discriminated base ([75a1007](https://github.com/sethjuarez/typra/commit/75a1007aa43cb286cd21d640089a1894f3dfc38f))
* **testing:** name a concrete variant when the fixture root is a discriminated base ([b5a15fc](https://github.com/sethjuarez/typra/commit/b5a15fcf0445b243e4978eaf0bf8f81ad1dbb7a6)), closes [#92](https://github.com/sethjuarez/typra/issues/92)
* **testing:** synthesize payloads for required complex fields without [@sample](https://github.com/sample) ([3dd9b8d](https://github.com/sethjuarez/typra/commit/3dd9b8d59ac6387f7ca68083028c0313aaabde1d))
* **testing:** synthesize payloads for required complex fields without [@sample](https://github.com/sample) ([d73061a](https://github.com/sethjuarez/typra/commit/d73061a6511faee4f97093e1f20f2ca8a66f5803)), closes [#53](https://github.com/sethjuarez/typra/issues/53)
* **tests:** encode trim-sensitive YAML scalars ([2b3e271](https://github.com/sethjuarez/typra/commit/2b3e271975bc3a54496f66f31754b7c4ee3fc819))
* **tests:** preserve trim-sensitive multiline samples ([857f82a](https://github.com/sethjuarez/typra/commit/857f82ae3877263a1e6b71004cb140cd38cf5f41))
* **typescript,csharp,python:** absorb unknown discriminators on abstract open bases ([#59](https://github.com/sethjuarez/typra/issues/59)) ([#67](https://github.com/sethjuarez/typra/issues/67)) ([01acd27](https://github.com/sethjuarez/typra/commit/01acd27aabe0c0c16fbbbf3b48aac3a999654d4c))
* **typescript:** load the built example in the generated dictionary test ([9a6f952](https://github.com/sethjuarez/typra/commit/9a6f952bfdc6110137cc16db94470d94855917a7))
* **typescript:** load the built example in the generated dictionary test ([f020fe0](https://github.com/sethjuarez/typra/commit/f020fe01cead1d088c05b1345e8e339575eeb3a1)), closes [#56](https://github.com/sethjuarez/typra/issues/56)
* **typescript:** never emit a generated test file with no test cases ([ac63a85](https://github.com/sethjuarez/typra/commit/ac63a85b127b9599aab07a15411e907c91b6b841))
* **typescript:** never emit a generated test file with no test cases ([4d0c034](https://github.com/sethjuarez/typra/commit/4d0c034643a49e9425e3b93dea0331f02dcf4051))
* **typescript:** preserve omitted optional collections ([700f2ec](https://github.com/sethjuarez/typra/commit/700f2ec35a5f9b98d8248f7d8dae25a0971687a5))
* **typescript:** preserve unknown connection payloads ([afec3d9](https://github.com/sethjuarez/typra/commit/afec3d97c9aedf8f5cc53ee745449f38d6524f49))
* validate namespaced rust unknown fixtures ([e494fe8](https://github.com/sethjuarez/typra/commit/e494fe8de1f903e772de4dc196b99ab2dd09ca1f))
* **validation:** stabilize cross-runtime checks ([2174fc1](https://github.com/sethjuarez/typra/commit/2174fc1aa452429653d71a347414694474fb4138))
* **verify-cli:** flush stdout before exit to avoid truncated --json ([e093cd8](https://github.com/sethjuarez/typra/commit/e093cd8f49e02169033b078106ba999442cef910))
* **verify:** classify additive modules as minor ([1164436](https://github.com/sethjuarez/typra/commit/1164436dcced36e8e536cfd1167086f99332bdda))
* **verify:** classify additive modules as minor ([d6aed8c](https://github.com/sethjuarez/typra/commit/d6aed8cfb8883faa06af572034bc546e1a47946e))

## [0.6.2](https://github.com/sethjuarez/typra/compare/v0.6.1...v0.6.2) (2026-08-13)

### Features

- **emitter:** add TypeSpec-native operation decorators for callable runtime effects.
- **fixtures:** replace legacy shape fixtures with feature, integration, and runtime fixture catalogs.
- **docs:** document native callable seams, operation effects, and fixture evidence layout.

## [0.6.1](https://github.com/sethjuarez/typra/compare/v0.6.0...v0.6.1) (2026-08-13)


### Bug Fixes

* validate namespaced rust unknown fixtures ([e494fe8](https://github.com/sethjuarez/typra/commit/e494fe8de1f903e772de4dc196b99ab2dd09ca1f))

## [0.6.0](https://github.com/sethjuarez/typra/compare/v0.5.0...v0.6.0) (2026-08-12)


### Features

* add typescript fetch consumer projection ([8344c29](https://github.com/sethjuarez/typra/commit/8344c29279eef6985086dccf8173e92e31945801))
* add typra v2 contract projection foundations ([6765980](https://github.com/sethjuarez/typra/commit/6765980e1bba85a4e8d216a9af59f870a3fcff59))
* complete transport roadmap slice ([#196](https://github.com/sethjuarez/typra/issues/196)) ([01c279f](https://github.com/sethjuarez/typra/commit/01c279fb10b1d03520ad4394377ed6bab4e49327))

## [0.5.0](https://github.com/sethjuarez/typra/compare/v0.4.31...v0.5.0) (2026-08-09)

### Features

- **emitter:** gate Rust serde serialization option ([512c67d](https://github.com/sethjuarez/typra/commit/512c67d7ba266ae8ed48cf7b18488564b4213a93))
- **java:** add opt-in Jackson serialization ([#152](https://github.com/sethjuarez/typra/issues/152)) ([d7c4155](https://github.com/sethjuarez/typra/commit/d7c4155f89ed719a3df592741328d95de351dba2))
- **python:** add pydantic native serialization option ([655440b](https://github.com/sethjuarez/typra/commit/655440be95b5438379d3a65256b41d72ffa77eda))
- **rust:** complete serde native serialization validation ([1221448](https://github.com/sethjuarez/typra/commit/122144896b541019f474b7281b91cc568a948f0d))
- **swift:** add codable native serialization option ([#162](https://github.com/sethjuarez/typra/issues/162)) ([51f9f40](https://github.com/sethjuarez/typra/commit/51f9f40803f1be9134110f949064f5dedab0140e))
- **typescript:** add zod native serialization option ([#155](https://github.com/sethjuarez/typra/issues/155)) ([d796512](https://github.com/sethjuarez/typra/commit/d796512e7021e6c000c17c7b3226e98692982deb))

### Bug Fixes

- **emitter:** carry open discriminator fallbacks ([5a6ecdb](https://github.com/sethjuarez/typra/commit/5a6ecdb95847225bcb4eae6106e33559156e4c0a))
- **emitter:** enforce discriminator runtime contract ([#158](https://github.com/sethjuarez/typra/issues/158)) ([e38b97f](https://github.com/sethjuarez/typra/commit/e38b97f77194d9ea4851292db0e9350caa71d762))
- **emitter:** harden Swift unknown fallbacks ([#149](https://github.com/sethjuarez/typra/issues/149)) ([090edcc](https://github.com/sethjuarez/typra/commit/090edcc2e4c25ad2f5b89edc5f5c856219a2721a))
- **emitter:** reject invalid discriminator states ([#157](https://github.com/sethjuarez/typra/issues/157)) ([8476b95](https://github.com/sethjuarez/typra/commit/8476b9525f9f5235bcfffcc8a1ef1921d3f52b40))
- **harness:** detect fixture validation under-execution ([266e33c](https://github.com/sethjuarez/typra/commit/266e33cb0ef0d2557febddac3611d794ce543af1))
- **python:** route pydantic validation entry points through typra ([5e9eab6](https://github.com/sethjuarez/typra/commit/5e9eab6e9ba6f972d33927cd9f4506e2f938eb07))

## [0.4.31](https://github.com/sethjuarez/typra/compare/v0.4.30...v0.4.31) (2026-08-09)

### Bug Fixes

- **csharp:** stop folding multiline YAML fixtures and run every generated C# test ([625098b](https://github.com/sethjuarez/typra/commit/625098b1e3c832c6a263eebcf3846a478a0e47bf))
- **csharp:** stop folding multiline YAML fixtures and run every generated C# test ([de356d8](https://github.com/sethjuarez/typra/commit/de356d8428cb73c4cb765bb78a1bd45169cbb79d)), closes [#93](https://github.com/sethjuarez/typra/issues/93) [#94](https://github.com/sethjuarez/typra/issues/94)
- **emitter:** always fail load on a missing required complex field ([2572b95](https://github.com/sethjuarez/typra/commit/2572b9581223ebc729cb9fa8893604a7fe8ddc1a))
- **emitter:** always fail load on a missing required complex field ([a27615c](https://github.com/sethjuarez/typra/commit/a27615ce4fc2bff2c128fc74db0c4af54f256b66)), closes [#104](https://github.com/sethjuarez/typra/issues/104) [#105](https://github.com/sethjuarez/typra/issues/105)
- **emitter:** preserve typed record values ([4763f75](https://github.com/sethjuarez/typra/commit/4763f7555e2c2e657466b63224fbb1aa7d55fc0d))
- **go:** guard math import to named collection shorthand ([#137](https://github.com/sethjuarez/typra/issues/137)) ([2ade20d](https://github.com/sethjuarez/typra/commit/2ade20d1fc1c8991ff1c21dd6673c099c26fa060))
- **java:** absorb unrecognized discriminators on abstract open bases ([#131](https://github.com/sethjuarez/typra/issues/131)) ([fa6cc6a](https://github.com/sethjuarez/typra/commit/fa6cc6a431dbe23b0ee6e77692d405a8f6a90416))
- **java:** escape control characters in generated JSON output ([#128](https://github.com/sethjuarez/typra/issues/128)) ([754b072](https://github.com/sethjuarez/typra/commit/754b072e032620632a3bbcf793dfc47400338481)), closes [#113](https://github.com/sethjuarez/typra/issues/113)
- **python:** emit valid Python literals and substituted factory assertions in generated tests ([b842515](https://github.com/sethjuarez/typra/commit/b8425156cf316484af42f13eed40e14e422ecea6))
- **python:** emit valid Python literals and substituted factory assertions in generated tests ([0f29dca](https://github.com/sethjuarez/typra/commit/0f29dca3cf4284cc18929701f1fd179d2f81438e)), closes [#107](https://github.com/sethjuarez/typra/issues/107)
- **rust:** emit required zero values ([#124](https://github.com/sethjuarez/typra/issues/124)) ([838cb89](https://github.com/sethjuarez/typra/commit/838cb89194df42ef0f861a5278ee72f30360e50f)), closes [#97](https://github.com/sethjuarez/typra/issues/97)
- **testing:** name a concrete variant when the fixture root is a discriminated base ([75a1007](https://github.com/sethjuarez/typra/commit/75a1007aa43cb286cd21d640089a1894f3dfc38f))
- **testing:** name a concrete variant when the fixture root is a discriminated base ([b5a15fc](https://github.com/sethjuarez/typra/commit/b5a15fcf0445b243e4978eaf0bf8f81ad1dbb7a6)), closes [#92](https://github.com/sethjuarez/typra/issues/92)

## 0.4.30

### Fixed

- **The C# backend generated conversion tests that did not compile against its own generated
  models** (#91). `src/languages/csharp/driver.ts` builds its test validations by hand rather
  than through the shared `buildValidations()` in `src/testing/test-context.ts`, and its filter
  consulted only the sample payload — never the node's properties. Any non-object `@sample` key
  became an assertion, including keys that are not members of the emitted class: a polymorphic
  base whose `@sample` carries a subtype payload asserted `instance.Endpoint` on a base that has
  no such property (CS1061), and a complex property populated through a scalar coercion compared
  a string to the complex type, binding the wrong `Assert.Equal` overload (CS1503). The shared
  predicate is now applied, so only genuine scalar and enum properties are asserted. The field
  remains in the generated payload, so the coercion is still exercised — matching Go, Rust,
  Java, TypeScript and Python, which all include the field but skip the assertion.
- **Generated C# factory tests asserted unsubstituted `{param}` templates** (#91). `@factory`
  `sets` values may embed placeholders resolved from the call arguments, but the emitted test
  compared against the raw template, so `FixtureReference.Named("test", "test")` asserted
  `"{id}"` and could never pass. The call arguments are now substituted before the assertion is
  emitted.
- **The C# type map had no entry for `float` or `numeric`, and mapped `number` to 32-bit
  `float`.** C# was the only backend of seven missing these: TypeScript, Python, Go, Rust, Java
  and Swift all resolve `float`, `numeric` and `number` to a 64-bit double, while C# fell
  through to `object` for the first two and silently narrowed the third. All three now map to
  `double`. Generated test literals track the declared width — a fractional literal is suffixed
  `f` only for genuine 32-bit fields, since `0.9f` widens to `0.8999999761581421` and would fail
  its own generated assertion against a `double?`.

### Added

- `fixtures/shapes/main.tsp` now exercises plain `float` and `numeric` scalars, which no fixture
  previously covered — the gap that let the C# numeric defect survive.

## 0.4.29

### Fixed

- **The Rust backend ignored entry shorthand when saving name-keyed collections** (#89).
  A collection entry whose only field was the scalar-coercion target was written back as an
  expanded object — `{"alpha": {"note": "first"}}` — while TypeScript, Python, Go, C#, Java and
  Swift all collapsed it to the bare scalar `{"alpha": "first"}`. Rust honoured `@entryShorthand`
  on load but never on save, so the two halves of the same generated file disagreed and a
  name-keyed collection did not round-trip byte-identically across languages.
  `emitCollectionSaveHelper()` now mirrors the shared save-side contract: when `use_shorthand`
  is set and the only surviving field is the coercion target, the entry collapses back to the
  scalar. Types with no scalar coercion target are unaffected.

### Testing

- The `entry-shorthand` executable-conformance probe, previously asserted only by the Java
  runner, is now asserted by all seven. That was the last remaining gap in per-runner contract
  coverage, and porting it is what surfaced #89 — the third defect in a row found by
  cross-runner parity rather than by consumer feedback.

## 0.4.28

### Fixed

- **Array-element diagnostics lost the element index in the Rust, C# and Swift backends** (#87).
  Loading a list whose second element omitted a required field reported `entries.detail: missing
required field` in those three backends, while TypeScript, Go, Python and Java correctly reported
  `entries[1].detail`. With many entries every failure produced an identical path, so a diagnostic
  could not identify which element was at fault. TypeScript, Go, Python and Java thread a per-element
  context (`atIndex` / `AtIndex` / `at_index`); Rust reused the collection path for every element,
  and C# and Swift passed the parent context unchanged. Their load contexts never defined an index
  helper at all. Rust now formats an indexed path in both the plain-array and named-collection array
  forms, and the C# and Swift load contexts gained the index helper their call sites now use.

### Changed

- The generated executable-conformance runners now assert the element-index contract in all seven
  backends. It was previously asserted only in TypeScript and Go, which is why the Rust, C# and
  Swift regressions went unnoticed — no consuming runtime reads these diagnostic strings, so the
  degradation was invisible downstream in every language.

## 0.4.27

### Fixed

- **`toWire` emitted fields for providers that declare no mapping** (#84). The Swift backend fell
  back to the schema field name for any provider absent from a field's `@knownAs` map, so a payload
  requested for one provider carried fields declared only for another — in the fixture schema an
  `anthropic` payload carried the openai-only `temperature`. A provider with no mappings at all
  received the entire model instead of an empty payload. The Java backend was correct for a
  non-empty unmapped provider but seeded its `include` flag from `target.isEmpty()`, so an empty or
  null provider received every field under its schema name. Both backends now key emission on the
  requested provider actually having a mapping, matching TypeScript, Python, Go, Rust and C#.

### Changed

- Swift gained an executable-conformance runner. It was previously the only conformance-matrix
  target whose static snippet evidence was asserted but whose behaviour was never compared against
  the canonical cross-backend output — which is why the defect above survived. All seven targets are
  now behaviourally verified.
- The `provider-wire-mapping` conformance case previously asserted only the mapped case, leaving the
  omission rule unlocked in every backend. It now asserts the provider-presence check for all seven
  targets, and every executable-conformance runner probes an unmapped provider and an empty provider
  string, both of which must produce an empty payload.

## 0.4.26

### Fixed

- **Generated output was never pruned, so removed types left orphaned files behind** (#82). When a
  type stopped being emitted, its generated source and generated test stayed on disk, kept
  compiling, and kept running — a generated test for a deleted type becomes a phantom failure in
  the consumer that reads as an emitter regression. A run only knows what it emitted, so the
  previous run's manifest is the only record of what used to exist. `pruneStaleGeneratedFiles` now
  reads that manifest before the new one replaces it and removes what the current run no longer
  produces.

  Deletion is ownership-based and mirrors the ladder already used by `removeSkippedGeneratedFile`:
  a file is removed only when the previous manifest recorded it as marker-owned, it is absent from
  this run, and it still carries the generated marker on disk. Editable seams are preserved,
  consumer-replaced files (marker gone) are preserved with a warning, and anything still emitted is
  untouched. An unreadable manifest deletes nothing.

### Changed

- Retired the stubbed `cleanupFlatTypeFiles` no-ops in the csharp, python, rust and typescript
  drivers. They were placeholders waiting on exactly this manifest cleanup, and guessed ownership
  from file names. Pruning is language-agnostic, so the single central pass covers every backend —
  including java and swift, which never had a stub at all.

## 0.4.25

### Fixed

- **C# generated conversion tests omitted required fields and failed against their own generated
  loaders** (#80). `csharp/driver.ts` built test payloads locally from `@sample` decorators alone
  instead of going through `buildBaseTestContext`, so it never ran the `withRequiredComplexSamples`
  completion step the other six backends get. A required complex property carrying no `@sample` was
  silently dropped from the fixture, and the generated validation then rejected the very payload the
  generator produced. In prompty this failed 48 tests across 8 auto-generated test classes.
  `withRequiredComplexSamples` is now exported and C# calls it, threading in the `TypeRegistry` it
  already had — the same resolver every other backend passes.

### Testing

- `test/test-context.test.ts` gained a `csharp driver — generated fixtures satisfy generated loaders`
  block driving the real `renderTests` from `csharp/driver.ts`: one test asserting a required complex
  property reaches the emitted fixture, and a counterpart guard asserting an optional one stays out.
  Covering the driver rather than the shared helper is deliberate — the helper was already correct
  and already tested; the defect was a backend not calling it.

## 0.4.24

### Fixed

- **Rust: an optional union-typed field inside a discriminated variant generated
  uncompilable code** (#78). A variant field whose declared type has no generated
  Rust counterpart — a polymorphic base, a union containing one (`Property |
Named<Property>`), or `unknown` — is carried as `serde_json::Value`. The variant
  _declaration_ ignored `?` while the variant _load_ and _save_ paths both honoured
  it, so the generated crate failed with `error[E0308]: expected Value, found
Option<Value>`. An optional variant field is now declared
  `Option<serde_json::Value>`, matching the loader and saver.

  Struct fields are deliberately unchanged: there, `Value::Null` remains the
  "absent" sentinel and the declaration, loader, and saver already agreed.

  Rust-only. It is the only backend that erases these types to a _non-nullable_
  type — Go uses `interface{}`, and C#/TypeScript/Python/Java keep the declared
  class, all of which are already nullable.

### Testing

- `fixtures/shapes/main.tsp` gains an optional union-typed field inside a
  discriminated variant (`FixtureArrayProperty.fallbackItems`), so the fixture gate
  — which compiles the generated Rust — now covers the shape that regressed. Only
  a _required_ field of this shape was previously declared, which is why the gate
  never failed. Reverting the fix makes the gate reproduce the original `E0308`.
- Two Rust emitter tests lock the declaration, load, and save sites against each
  other for both the optional and required cases.

## 0.4.23

### Added

- **`@entryShorthand(field)`** — declares which field an immediate scalar entry of a
  name-keyed collection is assigned to. `spec/vectors/model/named_collection_vectors.json`
  requires that "Immediate primitive Property values infer kind and **default** without
  leaking direct-coercion **example** semantics." Previously the target was chosen
  _positionally_ — the element's first declared field — which is unsound for a discriminated
  element type, because its first declared field is the discriminator. `inputs: { city:
"Seattle" }` therefore loaded as `kind: "Seattle"`, a value the element's own validator
  rejects (#76).

  The declaration is required rather than inferred because a bare scalar reaching a type
  _directly_ and the same scalar reaching it _as a named-collection entry_ are genuinely
  different contexts that may populate different fields — the vector requires `default` set
  **and** `example` absent, which one `@coerce` table cannot express. The constant
  assignments are still inferred from the type's own `@coerce` table.

  Undeclared schemas keep their previous shape.

### Fixed

- **Entry shorthand is emitted by every backend**, not just Rust. Go, TypeScript, Python,
  C# and Java now expand an immediate scalar entry identically. Swift is unaffected: it
  emits no load-side named-collection shorthand.

- **Coercion constants keep their declared type.** Constants were stringified during
  lowering and re-quoted by each emitter, so a schema expanding into a boolean or numeric
  constant emitted the string `"true"`. Each backend now renders the literal in its own
  native syntax (`True`/`None` in Python, `nil` in Go, and so on).

- **Scalar classification covers the whole TypeSpec numeric tower.** The integral and
  fractional sets were duplicated per backend and covered only `integer`/`int32`/`int64`
  and the float family, so a schema declaring `int16`, `uint32`, `safeint`, `decimal` or a
  string-encoded scalar such as `utcDateTime` produced no runtime arm at all — a silent
  degradation rather than an error. The sets now live in one place
  (`src/ir/scalar-kinds.ts`) shared by every backend, which also removes the per-backend
  drift that let the coercion family diverge in the first place. This additionally widens
  the numeric bridging introduced in 0.4.19.

- **`@entryShorthand` that cannot emit an arm now warns** instead of silently falling back
  to positional assignment — either because the type declares no `@coerce` table, or
  because every declared scalar lacks a distinguishable JSON form.

## 0.4.22

### Fixed

- **Rust no longer loses the primitive kind or the precision of an immediate `Property` scalar**
  (#73). `spec/vectors/model/property_scalar_coercion_vectors.json` requires that direct
  generated-model JSON loading infer "the exact primitive kind" and store "the unmodified
  scalar", but the Rust backend reported `4` as `kind: "float"` and stored `3.14` as
  `3.140000104904175`. Two independent defects in one emitted block:

  1. **Kind collapse.** `serde_json::Value::as_f64()` returns `Some` for whole numbers too, and
     the fractional coercion branch was emitted before the integral one, so every integer
     matched float first and the integer branch was unreachable. Which branch won was decided
     by declaration order in the schema, which is not a contract.
  2. **Precision loss.** The fractional branch narrowed through `as f32`;
     `3.140000104904175` is exactly `3.14f32` widened back to `f64`. The destination field is a
     `serde_json::Value`, which holds an `f64` exactly, so the narrowing was gratuitous.

  Numeric coercions are now emitted as one ordered block with the `as_i64()` guard first, and
  the `f32` cast is applied only when the _destination field_ is genuinely `f32` rather than
  whenever the declared coercion scalar is `float32`.

  This is the Rust counterpart of #39 / PR #52, which fixed the same contract in Go. The two
  backends diverge deliberately: Go must reconstruct integrality with `math.Trunc` because
  `encoding/json` decodes every JSON number as `float64`, whereas `serde_json` preserves the
  token's own int/float distinction — a literal `as_f64()` + `trunc()` port stores `4.0` where
  the vector requires `4`.

  For the record, the general Rust numeric mapping was never at fault: `float`, `float64`,
  `number` and `numeric` all map to `f64`, and only an explicitly declared `float32` maps to
  `f32`. The narrowing came from the coercion path alone.

  `scripts/validate-fixtures.mjs` had asserted the lossy
  `as_f64().map(|value| value as f32)` line as _expected content_, so the defect was pinned in
  place by its own gate. That assertion is now inverted into an `assertExcludes`.

  Measured against prompty: `cargo test --no-fail-fast --test property_scalar_coercion_vectors`
  `0 passed / 1 failed` → `1 passed / 0 failed`; the full Rust suite `869 passed / 39 failed` →
  `870 passed / 38 failed`, a single flip in the intended direction. Regeneration touched five
  lines in one file, `model/core/property.rs`.

### Testing

- **Locked the named-collection entry-form contract with an executable test.** A defect report
  claimed the emitted validator rejected the legal collection-level list form of a named
  collection, citing every one of prompty's 28 `agent_vectors` Rust tests failing with
  `tools.parameters.properties: invalid named collection entry category array`. The defect does
  not exist: rewriting _only_ the vector data from `parameters: {"properties": [...]}` to the
  declared list form `parameters: [...]` took that suite from `0 passed / 28 failed` to
  `28 passed / 0 failed` with no emitter change. `FunctionTool.parameters` is declared
  `Properties` (a named collection), so `{"properties": [...]}` is name-keyed _object_ form
  whose single entry holds an array — exactly what
  `spec/vectors/model/named_collection_vectors.json` requires be rejected:

  > Array-valued entries in name-keyed object form are rejected recursively, while arrays in
  > declared entry fields remain valid.

  No test asserted the _accepting_ half of that contract, so nothing contradicted the report.
  `test/typescript-emitter.test.ts` now transpiles and executes an emitted collection loader and
  asserts all four cases together: collection-level array form, name-keyed object form, scalar
  shorthand, and the rejected array-under-a-key. Both halves were verified by mutation —
  injecting the claimed defect reproduces the reported wording verbatim.

## 0.4.21

### Fixed

- **C#, Python, and TypeScript no longer conflate `@abstract` with closed** (#59, PR #67).
  An abstract base over an _open_ discriminator threw
  `Unknown Connection discriminator field 'kind' value: future-auth` instead of absorbing
  the unrecognized kind. This completes the reject-before-the-open-fallback family — #37,
  #38, #54, #59 — four instances across four backends, which is what motivated the
  cross-backend audit in `0.4.19`.

  Each backend now emits a concrete `UnknownX` carrier for abstract bases whose
  discriminator is open, sharing the predicate Go already used: TypeScript
  `export class UnknownX extends X`, C# `public sealed partial class UnknownX : X`,
  Python `@dataclass class UnknownX(X)`.

  A subclass was chosen over dropping `abstract` from the base. Rust and Swift model
  polymorphism as enums, where an `Unknown` variant is natural; these three model it as
  class inheritance, so the faithful analogue is a concrete subclass. Dropping `@abstract`
  would silently discard the schema author's intent.

  The carrier needs no `kind` field and no `save()` override, because all three backends
  emit `load()` as _dispatch first, then apply base assignments_ — so the base assigns the
  unrecognized discriminator after dispatch, and the base's `save()` re-emits the preserved
  payload from `raw`. This ordering was verified against generated fixture output for each
  backend rather than assumed from TypeScript.

  Authority is `spec/vectors/model/connection_roundtrip_vectors.json` in `microsoft/prompty`,
  which requires preserving the exact kind and the complete payload — including explicit
  nulls, and without case-folding `"Reference"` to `"reference"`.

### Changed

- `raw`/`_raw` and the raw-clone helpers are now `protected` rather than `private` in the
  TypeScript and C# emitters, so the carrier subclass can reach them.

## 0.4.20

### Fixed

- **TypeScript no longer emits a generated test file with no test cases** (PR #64).
  An abstract type carrying no `@sample` on any property skipped every emitted block:
  the construction and save tests are gated on `!node.isAbstract`, and the JSON, YAML,
  alternate-representation and dictionary-load tests are gated on `examples.length > 0`.
  What reached disk was a bare `describe("X", () => {});`, which vitest **fails**
  outright. Confirmed in `microsoft/prompty` as suite-level collection failures in
  `tests/model/conversation/content-part.test.ts` and
  `tests/model/events/stream-chunk.test.ts` after regenerating against `0.4.19`.

  Such a type now emits a `should be defined` case, asserting the only property still
  meaningful for a type that can be neither constructed nor loaded — that it is
  exported and reachable. Emitting no file was rejected because consumers track these
  paths in git and regeneration does not prune stale output.

  This defect predates `0.4.19`; it became visible only when prompty's regeneration
  moved several types to `@abstract`.

## 0.4.19

First release cut from `main` since `0.4.2`. Contains every fix that had accumulated
behind the stack of unmerged pull requests.

### Fixed

- **Non-abstract polymorphic bases now absorb unclaimed discriminator values** (#37, PR #50).
  A closed discriminator union is not the same thing as an exhaustive dispatch. When a
  non-abstract base's union permits a value that no subtype claims, that value now loads
  as the base type instead of failing. Previously Go returned a zero-valued instance and
  Rust panicked.

- **Open discriminators no longer pre-validate the discriminator field** (Rust, #38, PR #51).
  `emitInputValidation` now excludes the discriminator's own assignment from the base field
  validation that runs ahead of the dispatch match. See the note under _Known limitations_
  about the reachability of this defect.

- **Go numeric coercions now match what decoders actually produce** (#39, PR #52).
  `encoding/json` yields `float64` for _every_ JSON number and `gopkg.in/yaml.v3` yields
  `int` for integral YAML scalars, so emitted `case int:` / `case float32:` arms matched no
  decoded number at all and fell through to a zero-valued instance. Emitted coercion
  switches now carry decoder-native `case float64:` and `case int:` arms. When a type
  coerces from both an integral and a fractional scalar, the `float64` arm discriminates
  with `v == math.Trunc(v)` — chosen over `v == float64(int64(v))`, which is undefined for
  `|v| >= 2^63`.

- **Generated tests no longer omit required complex fields** (#53, PR #55).
  `buildExamples()` built sample payloads from only those properties carrying `@sample`, so
  a required _complex_ property without one was silently dropped — and the emitters' own
  `needsRequiredComplexValidation` then rejected the payload. A generated test could not
  pass its own generated validation. Required complex values are now synthesized
  recursively from the target type's own `@sample`s. This is shared code, so the fix
  reaches Go, Rust, Swift, Java, Python, and TypeScript.

- **TypeScript dictionary tests no longer discard the built example** (#56, PR #57).
  `test-emitter.ts` hardcoded an empty `Record<string, unknown>`. When there is no example
  to build, no dictionary test is emitted at all.

- **Go no longer conflates `@abstract` with closed** (#54, PR #58).
  An abstract base over an _open_ discriminator must absorb an unrecognized kind
  losslessly, the way Rust's `Unknown { kind_name, raw }` variant does. Go emitted
  `fmt.Errorf("unknown ... discriminator")` instead, and its struct had no `raw` field to
  round-trip the payload with. Both halves are fixed. C#, Python, and TypeScript
  followed in `0.4.21` (#59).

- **Diagnostics now carry array element indices** (#47, PR #60).
  A failure in `messages[3]` was reported as just `messages`. Array elements now thread an
  indexed context. Rendering uses bracket notation (`entries[1].detail`) rather than
  dot-joining, because `entries.1` is genuinely ambiguous with a map key named `1` — these
  runtimes accept both the array and the object form for the same field. Adds
  `atIndex` / `at_index` / `AtIndex` to the TypeScript, Python, Java, and Go `LoadContext`
  scaffoldings.

### Changed

- `validate:fixtures` now regenerates before validating (`prevalidate:fixtures`), and
  `npm test` now rebuilds first (`pretest`).

  These are not conveniences. `generated/fixtures` is gitignored, so it never shows up in
  `git status`, and the validation script did not regenerate — it validated whatever was
  last written to disk. Reverting an emitter fix and re-running reported **success**.
  Likewise `npm test` runs the compiled `dist/test/*.test.js`, so editing a test without
  rebuilding silently ran the stale one. Both gates could report green against code that no
  longer existed.

### Added

- Fixture coverage for the defect classes that shipped green (PR #61, PR #62). typra was
  272/0 with `validate:fixtures` clean at `0.4.18` while that version actively broke three
  consumer runtimes; none of the defects above were visible to either gate. New fixtures
  and harness assertions cover: numeric coercions decoded through both `encoding/json` and
  `gopkg.in/yaml.v3`; a closed discriminator union with an unclaimed value; an abstract base
  over an open discriminator; an unrecognized kind on a named open-enum discriminator;
  array-element diagnostic indices; required-complex-field payloads; and all four
  named-collection wire shapes (array, name-keyed, duplicate names, unnamed entries).

## 0.4.15 — breaking change, documented retroactively (#48)

`0.4.15` changed how optional collections are represented, without a note. Recorded here
because it silently broke hand-written code at the generated-model seam in every consuming
runtime, and because the change is conditional in a way that was not obvious.

An optional collection **without** a declared default became optional in the target
language. An optional collection **with** a declared default did not:

```tsp
owners?: FixtureOwner[];              // no default
defaultOwners?: FixtureOwner[] = #[]; // explicit empty default
```

```rust
pub owners: Option<Vec<FixtureOwner>>,   // 0.4.2: Vec<FixtureOwner>
pub default_owners: Vec<FixtureOwner>,   // unchanged
```

### Intended semantics

`None` **is** distinct from `Some(vec![])`, and the wire form preserves the distinction:

| declaration                 | input absent | input `[]`     | saves as                                                    |
| --------------------------- | ------------ | -------------- | ----------------------------------------------------------- |
| `owners?: T[]`              | `None`       | `Some(vec![])` | key omitted when `None`; `"owners": []` when `Some(vec![])` |
| `defaultOwners?: T[] = #[]` | `vec![]`     | `vec![]`       | always emitted as `"defaultOwners": []`                     |

So: declaring a default is a statement that absence and emptiness are the same thing for
that field, and the emitter takes you at your word. Omitting a default is a statement that
they differ, and the emitter preserves the difference through a full round trip. If you
want "empty reads as absent" for a field with no default, that is a consumer-side choice —
in Rust, `self.owners.as_ref().filter(|items| !items.is_empty())`.

### Migration

Every hand-written site touching a defaultless optional collection needs to unwrap. In
prompty's Rust runtime this was `src/model_ext.rs` (`as_inputs()`, `as_outputs()`) and two
assertions in `tests/named_collection_vectors.rs`. The equivalent seams in the Go, C#,
Python, TypeScript, Java, and Swift runtimes have not been built against `0.4.15`+ and are
expected to need the same treatment.

### Process note

A representation change of this kind warrants a minor bump, not a patch bump. Shipping it
as `0.4.14 -> 0.4.15` mid-effort across seven runtimes with no recorded baseline meant the
resulting failures were initially misattributed to pre-existing problems.

## Known limitations

- **#38's reachability.** `resolveUnionProperty` (`src/ir/ast.ts:645-681`) classifies a union
  of string literals plus a bare `string` as `scalar` — never `complex` — and the
  pre-validation branch that #38 describes only fires for `complex`. #51's regression test
  builds the IR by hand with `isScalar` left at its `false` default, a shape the front-end
  does not appear to produce from TypeSpec source. The fix is retained as defensive, but
  the live defect may not have been reachable.

- **#43, #44, #45 remain open and unmeasurable from this side.** They need prompty-side work
  first: prompty's Python package does not build, and prompty has no Swift or Java runtime
  committed.
