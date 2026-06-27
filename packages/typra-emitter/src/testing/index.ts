import { resolvePath } from "@typespec/compiler";
import { createTestLibrary, TypeSpecTestLibrary } from "@typespec/compiler/testing";
import { fileURLToPath } from "url";

export const TypraEmitTestLibrary: TypeSpecTestLibrary = createTestLibrary({
  name: "typra-emitter",
  packageRoot: resolvePath(fileURLToPath(import.meta.url), "../../../../"),
});
