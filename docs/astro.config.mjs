import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://typra.dev",
  integrations: [
    starlight({
      title: "Typra",
      description: "TypeSpec models to runtime model surfaces.",
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
            { label: "Markdown", link: "/targets/markdown/" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Overview", link: "/reference/" },
            { label: "Configuration", link: "/reference/configuration/" },
            { label: "CLI and verification", link: "/reference/cli-verification/" },
            { label: "Compatibility", link: "/reference/compatibility/" },
            { label: "Roadmap", link: "/roadmap/" },
          ],
        },
      ],
    }),
  ],
});
