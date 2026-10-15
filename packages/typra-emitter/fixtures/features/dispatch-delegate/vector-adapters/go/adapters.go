package vectoradapters

import fixtures "typrafixturesfeaturesdispatchdelegate"

type Jinja2Renderer struct{}
func (Jinja2Renderer) Render(request fixtures.Request) (string, error) { return "jinja2:" + request.Text, nil }

type MustacheRenderer struct{}
func (MustacheRenderer) Render(request fixtures.Request) (string, error) { return "mustache:" + request.Text, nil }

type CustomRenderer struct{}
func (CustomRenderer) Render(request fixtures.Request) (string, error) { return "custom:" + request.Text, nil }

type NoVectorJinja2Renderer struct{}
func (NoVectorJinja2Renderer) Render(request fixtures.Request) (string, error) { return "no-vector-jinja2:" + request.Text, nil }

type NoVectorMustacheRenderer struct{}
func (NoVectorMustacheRenderer) Render(request fixtures.Request) (string, error) { return "no-vector-mustache:" + request.Text, nil }

type NoVectorCustomRenderer struct{}
func (NoVectorCustomRenderer) Render(request fixtures.Request) (string, error) { return "no-vector-custom:" + request.Text, nil }

type TypeRenderer struct{}
func (TypeRenderer) Render(fixtures.MetaRequest) (string, error) { return "type", nil }

type KindRenderer struct{}
func (KindRenderer) Render(fixtures.MetaRequest) (string, error) { return "kind", nil }
