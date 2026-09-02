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

// CollatorImpl is a minimal real ARRAY-in / ARRAY-out MODEL seam: it reverses the
// order of the notes, each note passing through unchanged. The emitted entrypoint
// decodes the `notes` param via `json.Unmarshal` into `[]fixtures.Note` and
// compares the returned `[]Note` via `json.Marshal` + `reflect.DeepEqual` — the
// same generic json codec that handles a bare model, lifted over the slice.
type CollatorImpl struct{}

func (CollatorImpl) Collate(notes []fixtures.Note) ([]fixtures.Note, error) {
	reversed := make([]fixtures.Note, 0, len(notes))
	for i := len(notes) - 1; i >= 0; i-- {
		reversed = append(reversed, notes[i])
	}
	return reversed, nil
}

var _ fixtures.Collator = CollatorImpl{}

func TestCollatorTypedVectors(t *testing.T) {
	vectorconformance.RunCollatorConformance(t, CollatorImpl{})
}

// AssemblerImpl is a minimal real CARRIER-in / ARRAY-out seam: it wraps the note
// in a one-element slice, ignoring the untyped `options` carrier. The emitted
// entrypoint decodes the `options` param via `json.Unmarshal` into
// `map[string]interface{}` (or `*map[string]interface{}` for the optional
// carrier) — the same generic json codec as any other param — and threads the
// parsed bag straight through to the call. The RETURN keeps its own
// array-of-model rule, so the carrier param never loosens the result check.
// `Reassemble`'s optional carrier proves an absent carrier decodes to a nil map.
type AssemblerImpl struct{}

func (AssemblerImpl) Assemble(note fixtures.Note, options map[string]interface{}) ([]fixtures.Note, error) {
	return []fixtures.Note{note}, nil
}

func (AssemblerImpl) Reassemble(note fixtures.Note, options *map[string]interface{}) ([]fixtures.Note, error) {
	return []fixtures.Note{note}, nil
}

var _ fixtures.Assembler = AssemblerImpl{}

func TestAssemblerTypedVectors(t *testing.T) {
	vectorconformance.RunAssemblerConformance(t, AssemblerImpl{})
}
