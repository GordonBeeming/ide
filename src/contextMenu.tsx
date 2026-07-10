import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { LucideIcon } from "lucide-react";

export interface MenuItem {
  type?: "item";
  id: string;
  label: string;
  icon?: LucideIcon;
  shortcutHint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuSeparator {
  type: "separator";
}

export type MenuEntry = MenuItem | MenuSeparator;

// Sentinel shared by every menu builder — a single stable reference avoids
// each surface re-declaring `{ type: "separator" }` inline.
export const menuSeparator: MenuSeparator = { type: "separator" };

function isSelectableEntry(entry: MenuEntry): entry is MenuItem {
  return entry.type !== "separator" && !entry.disabled;
}

// Clamps a menu's top-left corner so the whole menu stays inside the
// viewport, sliding it back from whichever edge(s) it would otherwise
// overflow rather than flipping to a different anchor corner.
export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 4,
): { x: number; y: number } {
  const maxX = Math.max(margin, viewportWidth - margin - menuWidth);
  const maxY = Math.max(margin, viewportHeight - margin - menuHeight);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
  };
}

export function firstMenuIndex(entries: MenuEntry[]): number {
  return entries.findIndex(isSelectableEntry);
}

export function lastMenuIndex(entries: MenuEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isSelectableEntry(entries[index])) return index;
  }
  return -1;
}

// Steps to the next selectable (non-separator, non-disabled) entry, wrapping
// at either end. Returns -1 when nothing in the menu is selectable.
export function moveMenuSelection(
  entries: MenuEntry[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const total = entries.length;
  if (total === 0) return -1;
  let index = currentIndex;
  for (let steps = 0; steps < total; steps += 1) {
    index = (index + direction + total) % total;
    if (isSelectableEntry(entries[index])) return index;
  }
  return -1;
}

export interface ContextMenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
}

// Only one menu exists at a time app-wide, so index-based DOM ids are unique.
// Real ids (not just React keys) are required for aria-activedescendant —
// screen readers can't follow the arrow-key "active" row without them.
function menuItemDomId(index: number) {
  return `context-menu-item-${index}`;
}

interface MinimalMouseEvent {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

// One menu open at a time app-wide. `openMenu` remembers whatever had focus
// so `closeMenu` can restore it — right-click shouldn't strand focus in the
// menu's now-unmounted DOM.
export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState>();
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const openMenu = useCallback((event: MinimalMouseEvent, entries: MenuEntry[]) => {
    event.preventDefault();
    event.stopPropagation();
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenu({ x: event.clientX, y: event.clientY, entries });
  }, []);

  const closeMenu = useCallback(() => {
    setMenu(undefined);
    previouslyFocused.current?.focus();
    previouslyFocused.current = null;
  }, []);

  return { menu, openMenu, closeMenu };
}

export function ContextMenu({
  menu,
  onClose,
}: {
  menu: ContextMenuState | undefined;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const [activeIndex, setActiveIndex] = useState(-1);

  // Measure the menu once it's in the DOM (its size depends on its content),
  // then clamp — this runs before paint so there's no visible jump.
  useLayoutEffect(() => {
    if (!menu) {
      setPosition(undefined);
      return;
    }
    const node = containerRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPosition(
      clampMenuPosition(menu.x, menu.y, rect.width, rect.height, window.innerWidth, window.innerHeight),
    );
    setActiveIndex(firstMenuIndex(menu.entries));
  }, [menu]);

  useEffect(() => {
    if (menu && position) {
      containerRef.current?.focus();
    }
  }, [menu, position]);

  useEffect(() => {
    if (!menu) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleDismiss = () => onClose();

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("blur", handleDismiss);
    window.addEventListener("resize", handleDismiss);
    window.addEventListener("scroll", handleDismiss, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("blur", handleDismiss);
      window.removeEventListener("resize", handleDismiss);
      window.removeEventListener("scroll", handleDismiss, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const activate = (entry: MenuEntry) => {
    if (!isSelectableEntry(entry)) return;
    onClose();
    entry.onSelect();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => moveMenuSelection(menu.entries, current, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => moveMenuSelection(menu.entries, current, -1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(firstMenuIndex(menu.entries));
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(lastMenuIndex(menu.entries));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = menu.entries[activeIndex];
      if (entry) activate(entry);
    }
  };

  return (
    <div
      ref={containerRef}
      className="context-menu"
      role="menu"
      aria-activedescendant={activeIndex >= 0 ? menuItemDomId(activeIndex) : undefined}
      tabIndex={-1}
      style={
        position
          ? { left: position.x, top: position.y, visibility: "visible" }
          : { left: menu.x, top: menu.y, visibility: "hidden" }
      }
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.entries.map((entry, index) => {
        if (entry.type === "separator") {
          return <div key={`separator-${index}`} className="context-menu__separator" role="separator" />;
        }

        const Icon = entry.icon;
        return (
          <button
            key={entry.id}
            id={menuItemDomId(index)}
            type="button"
            role="menuitem"
            className={[
              "context-menu__item",
              entry.danger ? "context-menu__item--danger" : "",
              index === activeIndex ? "context-menu__item--active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-disabled={entry.disabled || undefined}
            disabled={entry.disabled}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => activate(entry)}
          >
            {Icon ? <Icon size={14} aria-hidden="true" /> : <span className="context-menu__item-icon-spacer" />}
            <span className="context-menu__item-label">{entry.label}</span>
            {entry.shortcutHint ? <span className="context-menu__item-hint">{entry.shortcutHint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
