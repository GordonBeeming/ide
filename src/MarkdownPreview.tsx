import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const defaultSplitRatio = 50;
const minSplitRatio = 25;
const maxSplitRatio = 75;
const splitRatioStep = 5;

interface MarkdownPreviewProps {
  children: ReactNode;
  contents: string;
  dark?: boolean;
  path: string;
  visible?: boolean;
}

const previewDelayMs = 100;

function clampSplitRatio(value: number) {
  return Math.min(maxSplitRatio, Math.max(minSplitRatio, value));
}

export default function MarkdownPreview({
  children,
  contents,
  dark = false,
  path,
  visible = true,
}: MarkdownPreviewProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const preview = useRef<HTMLElement | null>(null);
  const previewScrollTop = useRef(0);
  const resize = useRef<
    { startX: number; startRatio: number; hostWidth: number } | undefined
  >(undefined);
  const [splitRatio, setSplitRatioState] = useState(defaultSplitRatio);
  const setSplitRatio = useCallback(
    (value: number) => setSplitRatioState(clampSplitRatio(value)),
    [],
  );
  const [html, setHtml] = useState("");

  useEffect(() => {
    if (!visible) {
      setHtml("");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void import("./markdownRenderer")
        .then(({ renderMarkdown }) => {
          if (!cancelled) setHtml(renderMarkdown(contents));
        })
        .catch((error: unknown) => {
          console.error("Failed to load Markdown renderer:", error);
          if (!cancelled) setHtml("<p>Markdown preview unavailable.</p>");
        });
    }, previewDelayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [contents, visible]);

  useLayoutEffect(() => {
    if (preview.current) preview.current.scrollTop = previewScrollTop.current;
  }, [html, visible]);

  useEffect(() => {
    if (!visible || !preview.current) return;
    const diagrams = Array.from(
      preview.current.querySelectorAll<HTMLElement>("[data-mermaid-diagram]"),
    );
    if (diagrams.length === 0) return;

    let cancelled = false;
    void import("./mermaidRenderer")
      .then(async ({ renderMermaidDiagrams }) => {
        if (!cancelled) await renderMermaidDiagrams(diagrams, dark);
      })
      .catch((error: unknown) => {
        console.error("Failed to load Mermaid renderer:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [dark, html, visible]);

  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!host.current) return;
      event.preventDefault();
      resize.current = {
        startX: event.clientX,
        startRatio: splitRatio,
        hostWidth: host.current.getBoundingClientRect().width,
      };
    },
    [splitRatio],
  );

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      setSplitRatio(splitRatio + (event.key === "ArrowRight" ? 1 : -1) * splitRatioStep);
    },
    [setSplitRatio, splitRatio],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const current = resize.current;
      if (!current || current.hostWidth <= 0) return;
      setSplitRatio(
        current.startRatio + ((event.clientX - current.startX) / current.hostWidth) * 100,
      );
    };
    const handlePointerUp = () => {
      resize.current = undefined;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [setSplitRatio]);

  const handlePreviewClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!anchor) return;

    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (href && /^https?:\/\//i.test(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  }, []);

  return (
    <div
      className="markdown-preview-split"
      ref={host}
      style={{
        display: "grid",
        gridRow: 2,
        gridTemplateColumns: visible
          ? `minmax(0, ${splitRatio}%) 7px minmax(0, 1fr)`
          : "minmax(0, 1fr)",
        minHeight: 0,
        overflow: "hidden",
      } as CSSProperties}
    >
      <div
        className="markdown-preview-split__editor"
        style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}
      >
        {children}
      </div>
      {visible ? (
        <>
          <div
            className="markdown-preview-split__handle"
            role="separator"
            tabIndex={0}
            aria-label="Resize Markdown editor and preview"
            aria-orientation="vertical"
            aria-valuemin={minSplitRatio}
            aria-valuemax={maxSplitRatio}
            aria-valuenow={splitRatio}
            onKeyDown={handleResizeKeyDown}
            onPointerDown={beginResize}
            style={{
              border: 0,
              borderInline: "1px solid var(--border)",
              background: "var(--surface)",
              cursor: "col-resize",
            }}
          />
          <section
            className="markdown-preview"
            ref={preview}
            role="region"
            tabIndex={0}
            aria-label={`Preview ${path}`}
            onAuxClick={handlePreviewClick}
            onClick={handlePreviewClick}
            onScroll={(event) => {
              previewScrollTop.current = event.currentTarget.scrollTop;
            }}
            style={{
              minWidth: 0,
              minHeight: 0,
              overflow: "auto",
              padding: "24px clamp(18px, 4vw, 42px) 48px",
              background: "var(--editor-bg)",
              color: "var(--text)",
              fontFamily: "var(--font-sans)",
              fontSize: 15,
              lineHeight: 1.65,
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </>
      ) : null}
    </div>
  );
}
