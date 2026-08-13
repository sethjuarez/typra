import "@typra/emitter";
import "@typespec/http";

using TypeSpec.Http;

namespace Typra.Fixtures.Features.Transport;

model Root {
  sample: Pet;
}

model Pet {
  name: string;
}

model PetPatch {
  name: string;
}

model ErrorBody {
  message: string;
}

model CreatedPet {
  @statusCode statusCode: 201;
  @body body: Pet;
}

model PetNotFound {
  @statusCode statusCode: 404;
  @body body: ErrorBody;
}

model DefaultError {
  @statusCode statusCode: int32;
  @body body: ErrorBody;
}

@route("/pets")
interface Pets {
  @get
  @route("/{petId}")
  read(@path petId: string, @query includeDetails?: boolean, @header traceId: string, @cookie sessionId: string): Pet | PetNotFound;

  @post
  @route("/")
  create(@body request: PetPatch): CreatedPet | DefaultError;
}
