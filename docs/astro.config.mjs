import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://typra.dev",
  integrations: [
    starlight({
      title: "Typra",
      description: "TypeSpec models to runtime model surfaces.",
      plugins: [
        starlightLlmsTxt({
          projectName: "Typra",
          description:
            "Typra is an emitter that turns TypeSpec model contracts into runtime model surfaces, generated tests, generated documentation, and reviewable metadata for TypeScript, Python, C#, Go, Java, Rust, and Swift.",
          details: [
            "Typra is emitter-only: it generates model and protocol surfaces, while product-specific TypeSpec contracts, service behavior, and hand-authored adapters stay in the consuming product.",
            "Runtime targets: TypeScript, Python, C#, Go, Java, Rust, and Swift. Reference targets: Markdown and an always-emitted JSON AST.",
            "Generated model helpers vary by language but center on load/save plus JSON and YAML round-trip helpers, provider wire-name mapping, scalar coercion, and discriminated polymorphism.",
            "CLIs: typra-generate (standalone generation), typra-verify (metadata drift verification), typra-consumer-smoke (config-driven consumer harness).",
            "Compatibility: @typespec/compiler and @typespec/json-schema 1.10.0.",
          ].join("\n"),
        }),
      ],
      favicon: "/favicon.svg?v=typra",
      logo: {
        light: "./src/assets/typra-logo-light.svg",
        dark: "./src/assets/typra-logo-dark.svg",
        alt: "Typra",
      },
      customCss: ["./src/styles/custom.css"],
      head: [
        {
          tag: "script",
          content: `(() => {
  const param = new URLSearchParams(window.location.search).get("clawpilotTheme");
  const theme =
    param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();`,
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/sethjuarez/typra",
        },
      ],
      sidebar: [
        {
          label: "Concepts",
          items: [
            { label: "Overview", link: "/" },
            { label: "Quickstart", link: "/quickstart/" },
            { label: "Mental model", link: "/concepts/" },
            { label: "Typra contracts", link: "/concepts/contracts/" },
            { label: "Simple example", link: "/concepts/simple-example/" },
            { label: "End-to-end usage", link: "/concepts/end-to-end/" },
            { label: "Generated output", link: "/concepts/generated-output/" },
          ],
        },
        {
          label: "TypeSpec Mappings",
          items: [
            { label: "Overview", link: "/mappings/" },
            { label: "Models and properties", link: "/mappings/models/" },
            { label: "Collections and records", link: "/mappings/collections/" },
            { label: "Unions and polymorphism", link: "/mappings/unions-polymorphism/" },
            { label: "Interfaces, operations, and transport", link: "/mappings/operations/" },
            { label: "Decorators and wire names", link: "/mappings/decorators/" },
          ],
        },
        {
          label: "Targets",
          items: [
            { label: "Overview", link: "/targets/" },
            { label: "TypeScript", link: "/targets/typescript/" },
            { label: "Python", link: "/targets/python/" },
            { label: "C#", link: "/targets/csharp/" },
            { label: "Go", link: "/targets/go/" },
            { label: "Java", link: "/targets/java/" },
            { label: "Rust", link: "/targets/rust/" },
            { label: "Swift", link: "/targets/swift/" },
            { label: "Markdown", link: "/targets/markdown/" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Overview", link: "/reference/" },
            { label: "Configuration", link: "/reference/configuration/" },
            { label: "CLI and verification", link: "/reference/cli-verification/" },
            { label: "Vector conformance adapters", link: "/reference/vector-conformance/" },
            { label: "Runtime semantics", link: "/reference/runtime-semantics/" },
            { label: "Compatibility", link: "/reference/compatibility/" },
            { label: "Roadmap", link: "/roadmap/" },
          ],
        },
      ],
    }),
  ],
});
