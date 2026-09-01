// Committed typed conformance double for the `typed-seam-conformance` fixture
// (prompty#511 Cat 1 / typra#306, Track A).
//
// This is the CONSUMER's ENTIRE authored surface under the typed entrypoint: a
// real seam impl (`TransformerImpl`) plus a one-line call into the emitted
// `vectorconformance.RunTransformerConformance`. There is NO `vectoradapters`
// registry, NO string keys, and NO per-op marshalling double — the emitted
// entrypoint decodes vector input, calls the seam method directly, and asserts.
// Passing `TransformerImpl{}` where `fixtures.Transformer` is required makes the
// compiler prove every op is implemented, so this file failing to compile is the
// red-first signal that the entrypoint was not emitted.
//
// The gate drops this file in as its own package alongside the generated model
// and `vectorconformance` packages, then `go test ./...`.
package conformancetest

import (
	"errors"
	"strings"
	"testing"

	fixtures "fixtures"
	"fixtures/vectorconformance"
)

// TransformerImpl is a minimal real seam: it trims, and rejects the literal
// "boom" so the `expectedError` vector has something to assert against.
type TransformerImpl struct{}

func (TransformerImpl) Transform(text string) (string, error) {
	if strings.TrimSpace(text) == "boom" {
		return "", errors.New("boom not allowed")
	}
	return strings.TrimSpace(text), nil
}

// Compile-time proof the impl satisfies the whole seam (the same guarantee the
// entrypoint's `fixtures.Transformer` parameter enforces at the call site).
var _ fixtures.Transformer = TransformerImpl{}

func TestTransformerTypedVectors(t *testing.T) {
	vectorconformance.RunTransformerConformance(t, TransformerImpl{})
}

// ReviserImpl is a minimal real MODEL-in / MODEL-out seam: it upper-cases the
// note title and passes the body through. The emitted entrypoint decodes the
// `note` param via `json.Unmarshal` into `fixtures.Note` and compares the
// returned `Note` via `json.Marshal` + `reflect.DeepEqual` — the same code path
// as a scalar seam, because every generated model carries `json:` struct tags.
type ReviserImpl struct{}

func (ReviserImpl) Revise(note fixtures.Note) (fixtures.Note, error) {
	note.Title = strings.ToUpper(note.Title)
	return note, nil
}

var _ fixtures.Reviser = ReviserImpl{}

func TestReviserTypedVectors(t *testing.T) {
	vectorconformance.RunReviserConformance(t, ReviserImpl{})
}
