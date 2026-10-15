import pytest

from typra._direct_renderer_resolver import new_direct_renderer_provider
from typra._optional_renderer_resolver import new_optional_renderer_provider
from typra._processor_resolver import new_processor_provider
from typra._renderer_resolver import new_renderer_provider


class _Renderer:
    def __init__(self, route):
        self.route = route

    def render(self, agent, template, inputs):
        return self.route


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
            "custom": _Renderer("renderer:custom"),
        }
    )


@pytest.fixture
def processor_provider():
    return new_processor_provider(
        {
            "azure": _Processor("processor:azure"),
            "openai": _Processor("processor:openai"),
            "custom": _Processor("processor:custom"),
        }
    )


@pytest.fixture
def direct_renderer_provider():
    return new_direct_renderer_provider(
        {
            "jinja2": _DirectRenderer("direct:jinja2"),
            "mustache": _DirectRenderer("direct:mustache"),
            "custom": _DirectRenderer("direct:custom"),
        }
    )


@pytest.fixture
def optional_renderer_provider():
    return new_optional_renderer_provider(
        {
            "jinja2": _OptionalRenderer("optional:jinja2"),
            "mustache": _OptionalRenderer("optional:mustache"),
            "custom": _OptionalRenderer("optional:custom"),
        }
    )
