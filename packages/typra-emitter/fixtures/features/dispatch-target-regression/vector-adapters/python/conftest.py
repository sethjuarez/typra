import pytest

from typra._closed_router_resolver import new_closed_router_provider
from typra._direct_renderer_resolver import new_direct_renderer_provider
from typra._optional_renderer_resolver import new_optional_renderer_provider
from typra._processor_resolver import new_processor_provider
from typra._renderer_resolver import new_renderer_provider


class _Renderer:
    def __init__(self, route):
        self.route = route

    def render(self, agent, template, inputs):
        return self.route


class _ClosedRouter:
    def __init__(self, route):
        self.route_value = route

    def route(self, config):
        return self.route_value


@pytest.fixture
def closed_router_provider():
    return new_closed_router_provider(
        {
            "alpha": _ClosedRouter("closed:alpha"),
            "beta": _ClosedRouter("closed:beta"),
        }
    )


class _WildcardRenderer:
    def render(self, agent, template, inputs):
        wire = agent.template.format.save()
        return (
            f"renderer:wildcard:{wire['format_kind']}:"
            f"{wire['plugin']['tag']}"
        )


class _Processor:
    def __init__(self, route):
        self.route = route

    def process(self, agent, response):
        return {"route": self.route}


class _DirectRenderer:
    def __init__(self, route):
        self.route = route

    def render(self, format, template):
        return self.route


class _WildcardDirectRenderer:
    def render(self, format, template):
        wire = format.save()
        return (
            f"direct:wildcard:{wire['format_kind']}:"
            f"{wire['plugin']['tag']}"
        )


class _OptionalRenderer:
    def __init__(self, route):
        self.route = route

    def render(self, agent, template):
        return self.route


@pytest.fixture
def renderer_provider():
    return new_renderer_provider(
        {
            "jinja2": _Renderer("renderer:jinja2"),
            "mustache": _Renderer("renderer:mustache"),
            "wildcard": _WildcardRenderer(),
        }
    )


@pytest.fixture
def processor_provider():
    return new_processor_provider(
        {
            "azure": _Processor("processor:azure"),
            "openai": _Processor("processor:openai"),
            "wildcard": _Processor("processor:wildcard"),
        }
    )


@pytest.fixture
def direct_renderer_provider():
    return new_direct_renderer_provider(
        {
            "jinja2": _DirectRenderer("direct:jinja2"),
            "mustache": _DirectRenderer("direct:mustache"),
            "wildcard": _WildcardDirectRenderer(),
        }
    )


@pytest.fixture
def optional_renderer_provider():
    return new_optional_renderer_provider(
        {
            "jinja2": _OptionalRenderer("optional:jinja2"),
            "mustache": _OptionalRenderer("optional:mustache"),
            "wildcard": _OptionalRenderer("optional:wildcard"),
        }
    )
