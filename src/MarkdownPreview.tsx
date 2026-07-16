import DOMPurify from "dompurify";
import { marked } from "marked";
import "./MarkdownPreview.css";
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
  path: string;
  visible?: boolean;
}

const previewDelayMs = 100;

function renderMarkdown(contents: string) {
  return DOMPurify.sanitize(marked.parse(contents, { async: false }));
}

function clampSplitRatio(value: number) {
  return Math.min(maxSplitRatio, Math.max(minSplitRatio, value));
}

export default function MarkdownPreview({
  children,
  contents,
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
  const [html, setHtml] = useState(() => (visible ? renderMarkdown(contents) : ""));

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => setHtml(renderMarkdown(contents)), previewDelayMs);
    return () => window.clearTimeout(timer);
  }, [contents, visible]);

  useLayoutEffect(() => {
    if (preview.current) preview.current.scrollTop = previewScrollTop.current;
  }, [html]);

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
      className={[
        "markdown-preview-split",
        visible ? "" : "markdown-preview-split--hidden",
      ].join(" ")}
      ref={host}
      style={{ "--markdown-editor-width": `${visible ? splitRatio : 100}%` } as CSSProperties}
    >
      <div className="markdown-preview-split__editor">{children}</div>
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
          />
          <section
            className="markdown-preview"
            ref={preview}
            role="region"
            tabIndex={0}
            aria-label={`Preview ${path}`}
            onClick={handlePreviewClick}
            onScroll={(event) => {
              previewScrollTop.current = event.currentTarget.scrollTop;
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </>
      ) : null}
    </div>
  );
}
