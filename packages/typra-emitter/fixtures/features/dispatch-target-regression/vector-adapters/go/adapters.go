package vectoradapters

import fixtures "typrafixturesfeaturesdispatchtargetregression"

type renderer string

func (r renderer) Render(fixtures.Agent, string, map[string]interface{}) (string, error) {
	return string(r), nil
}

type processor string

func (p processor) Process(fixtures.Agent, interface{}) (interface{}, error) {
	return map[string]interface{}{"route": string(p)}, nil
}

type directRenderer string

func (r directRenderer) Render(fixtures.FormatConfig, string) (string, error) {
	return string(r), nil
}

type optionalRenderer string

func (r optionalRenderer) Render(*fixtures.Agent, string) (string, error) {
	return string(r), nil
}

func RendererProvider() fixtures.RendererProvider {
	provider, err := fixtures.NewRendererProvider(map[string]fixtures.Renderer{
		"jinja2":   renderer("renderer:jinja2"),
		"mustache": renderer("renderer:mustache"),
		"custom":   renderer("renderer:custom"),
	})
	if err != nil {
		panic(err)
	}
	return provider
}

func ProcessorProvider() fixtures.ProcessorProvider {
	provider, err := fixtures.NewProcessorProvider(map[string]fixtures.Processor{
		"azure":  processor("processor:azure"),
		"openai": processor("processor:openai"),
		"custom": processor("processor:custom"),
	})
	if err != nil {
		panic(err)
	}
	return provider
}

func DirectRendererProvider() fixtures.DirectRendererProvider {
	provider, err := fixtures.NewDirectRendererProvider(map[string]fixtures.DirectRenderer{
		"jinja2":   directRenderer("direct:jinja2"),
		"mustache": directRenderer("direct:mustache"),
		"custom":   directRenderer("direct:custom"),
	})
	if err != nil {
		panic(err)
	}
	return provider
}

func OptionalRendererProvider() fixtures.OptionalRendererProvider {
	provider, err := fixtures.NewOptionalRendererProvider(map[string]fixtures.OptionalRenderer{
		"jinja2":   optionalRenderer("optional:jinja2"),
		"mustache": optionalRenderer("optional:mustache"),
		"custom":   optionalRenderer("optional:custom"),
	})
	if err != nil {
		panic(err)
	}
	return provider
}
