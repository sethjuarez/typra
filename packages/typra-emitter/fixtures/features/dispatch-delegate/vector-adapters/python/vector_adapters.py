class Jinja2Renderer:
    async def render(self, request):
        return f"jinja2:{request.text}"

class MustacheRenderer:
    async def render(self, request):
        return f"mustache:{request.text}"

class CustomRenderer:
    async def render(self, request):
        return f"custom:{request.text}"

class NoVectorJinja2Renderer:
    async def render(self, request):
        return f"no-vector-jinja2:{request.text}"

class NoVectorMustacheRenderer:
    async def render(self, request):
        return f"no-vector-mustache:{request.text}"

class NoVectorCustomRenderer:
    async def render(self, request):
        return f"no-vector-custom:{request.text}"

class TypeRenderer:
    async def render(self, _request):
        return "type"

class KindRenderer:
    async def render(self, _request):
        return "kind"
