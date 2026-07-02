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
          label: "Start here",
          items: [
            { label: "Overview", link: "/" },
            { label: "Quickstart", link: "/quickstart/" },
            { label: "Concepts", link: "/concepts/" },
            { label: "Targets", link: "/targets/" },
          ],
        },
        {
          label: "Project",
          items: [{ label: "Roadmap", link: "/roadmap/" }],
        },
      ],
    }),
  ],
});
