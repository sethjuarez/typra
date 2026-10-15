package vectoradapters

import fixtures "typrafixturesfeaturesdispatchtargetregression"

type renderer string

func (r renderer) Render(fixtures.Agent, string, map[string]interface{}) (string, error) {
	return string(r), nil
}

type closedRouter string

func (r closedRouter) Route(fixtures.ClosedConfig) (string, error) {
	return string(r), nil
}

func ClosedRouterProvider() fixtures.ClosedRouterProvider {
	provider, err := fixtures.NewClosedRouterProvider(map[string]fixtures.ClosedRouter{
		"alpha": closedRouter("closed:alpha"),
		"beta":  closedRouter("closed:beta"),
	})
	if err != nil {
		panic(err)
	}
	return provider
}

type wildcardRenderer struct{}

func (wildcardRenderer) Render(agent fixtures.Agent, _ string, _ map[string]interface{}) (string, error) {
	return wildcardRoute("renderer", agent.Template.Format), nil
}

type processor string

func (p processor) Process(fixtures.Agent, interface{}) (interface{}, error) {
	return map[string]interface{}{"route": string(p)}, nil
}

type directRenderer string

func (r directRenderer) Render(fixtures.FormatConfig, string) (string, error) {
	return string(r), nil
}

type wildcardDirectRenderer struct{}

func (wildcardDirectRenderer) Render(format fixtures.FormatConfig, _ string) (string, error) {
	return wildcardRoute("direct", format), nil
}

func wildcardRoute(prefix string, format interface{}) string {
	serializable := format.(interface {
		Save(*fixtures.SaveContext) map[string]interface{}
	})
	wire := serializable.Save(nil)
	plugin := wire["plugin"].(map[string]interface{})
	return prefix + ":wildcard:" + wire["format_kind"].(string) + ":" + plugin["tag"].(string)
}

type optionalRenderer string

func (r optionalRenderer) Render(*fixtures.Agent, string) (string, error) {
	return string(r), nil
}

func RendererProvider() fixtures.RendererProvider {
	provider, err := fixtures.NewRendererProvider(map[string]fixtures.Renderer{
		"jinja2":   renderer("renderer:jinja2"),
		"mustache": renderer("renderer:mustache"),
		"wildcard": wildcardRenderer{},
	})
	if err != nil {
		panic(err)
	}
	return provider
}

func ProcessorProvider() fixtures.ProcessorProvider {
	provider, err := fixtures.NewProcessorProvider(map[string]fixtures.Processor{
		"azure":    processor("processor:azure"),
		"openai":   processor("processor:openai"),
		"wildcard": processor("processor:wildcard"),
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
		"wildcard": wildcardDirectRenderer{},
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
		"wildcard": optionalRenderer("optional:wildcard"),
	})
	if err != nil {
		panic(err)
	}
	return provider
}
