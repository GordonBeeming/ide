import mermaid from "mermaid";

let diagramId = 0;

export async function renderMermaidDiagrams(
  diagrams: HTMLElement[],
  dark: boolean,
): Promise<void> {
  mermaid.initialize({
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: dark ? "dark" : "neutral",
  });

  for (const diagram of diagrams) {
    const source = diagram.dataset.mermaidSource
      ? decodeURIComponent(diagram.dataset.mermaidSource)
      : diagram.textContent ?? "";
    diagram.dataset.mermaidSource = encodeURIComponent(source);

    try {
      diagramId += 1;
      const { svg, bindFunctions } = await mermaid.render(
        `markdown-mermaid-${diagramId}`,
        source,
      );
      if (!diagram.isConnected) continue;
      diagram.removeAttribute("data-mermaid-error");
      diagram.removeAttribute("aria-label");
      diagram.innerHTML = svg;
      bindFunctions?.(diagram);
    } catch (error) {
      console.error("Failed to render Mermaid diagram:", error);
      if (!diagram.isConnected) continue;
      diagram.dataset.mermaidError = "true";
      diagram.setAttribute("aria-label", "Mermaid diagram could not be rendered");
    }
  }
}
