namespace Typra.Fixtures.Features.Vectors;

const FileBackedRenderVectors = #[
  #{
    name: "file-backed-success",
    stage: "callable",
    input: #{ request: #{ prompt: "hello from file", context: #{ locale: "en-US" } } },
    expected: #{ text: "hello from file", tokens: 3 }
  },
  #{
    name: "file-backed-error",
    stage: "callable",
    input: #{ request: #{ prompt: "", context: #{ locale: "en-US" } } },
    expectedError: #{ code: "empty-prompt" }
  }
];
