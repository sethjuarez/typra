package typrafixturesfeaturesdispatchtargetregression

import "testing"

func TestPolymorphicCollectionScalarShorthand(t *testing.T) {
	agent, err := LoadAgent(map[string]interface{}{
		"name":   "coercible",
		"models": []interface{}{"gpt-4"},
	}, NewLoadContext())
	if err != nil {
		t.Fatalf("coercible scalar shorthand failed: %v", err)
	}
	if len(agent.Models) != 1 {
		t.Fatalf("coercible scalar shorthand produced %d models, want 1", len(agent.Models))
	}
}

func TestPolymorphicCollectionRejectsNonCoercibleScalar(t *testing.T) {
	_, err := LoadAgent(map[string]interface{}{
		"name":   "invalid",
		"models": []interface{}{42},
	}, NewLoadContext())
	if err == nil {
		t.Fatal("non-coercible scalar collection element must return an error")
	}
}

func TestOpenDispatchProviderRequiresWildcard(t *testing.T) {
	_, err := NewRendererProvider(map[string]Renderer{
		"jinja2":   nil,
		"mustache": nil,
	})
	if err == nil {
		t.Fatal("open provider without wildcard must fail collection")
	}

	_, err = NewRendererProvider(map[string]Renderer{
		"jinja2":   nil,
		"mustache": nil,
		"wildcard": nil,
	})
	if err == nil {
		t.Fatal("open provider with nil wildcard must fail collection")
	}
}

func TestOpenDispatchZeroProviderRejectsUnknown(t *testing.T) {
	_, err := ResolveRenderer("third-party", RendererProvider{})
	if err == nil {
		t.Fatal("zero-value open provider must reject unknown discriminator when wildcard is nil")
	}
}
