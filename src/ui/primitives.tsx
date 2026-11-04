// Kerf design system primitives. Every control in the app is built from
// these, so states (hover, active, focus, disabled) look identical everywhere.

import {
  createContext,
  forwardRef,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// --- Button ----------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-signal text-signal-ink hover:bg-signal-hover font-semibold",
  secondary: "bg-field text-fg hover:bg-hover border border-line-strong",
  ghost: "text-fg-2 hover:text-fg hover:bg-hover",
  danger: "bg-danger/90 text-white hover:bg-danger font-semibold",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }>(
  function Button({ variant = "secondary", size = "md", className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        {...rest}
        className={cx(
          "inline-flex items-center justify-center gap-1.5 rounded-sm transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap",
          size === "md" ? "h-7 px-3 text-sm" : "h-6 px-2 text-xs",
          BUTTON[variant],
          className,
        )}
      />
    );
  },
);

export function IconButton({
  icon,
  label,
  active,
  className,
  size = 28,
  shortcut,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: ReactNode; label: string; active?: boolean; size?: number; shortcut?: string }) {
  return (
    <Tooltip text={label} shortcut={shortcut}>
      <button
        aria-label={label}
        aria-pressed={active}
        {...rest}
        style={{ width: size, height: size }}
        className={cx(
          "inline-flex items-center justify-center rounded-sm transition-colors duration-100 disabled:opacity-35 disabled:pointer-events-none",
          active ? "bg-signal-soft text-signal" : "text-fg-2 hover:text-fg hover:bg-hover",
          className,
        )}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

// --- Tooltip ---------------------------------------------------------------------

export function Tooltip({ text, shortcut, children, side = "bottom" }: { text: string; shortcut?: string; children: ReactNode; side?: "bottom" | "top" | "right" }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number>(0);
  const show = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (side === "top") setPos({ x: r.left + r.width / 2, y: r.top - 6 });
      else if (side === "right") setPos({ x: r.right + 6, y: r.top + r.height / 2 });
      else setPos({ x: r.left + r.width / 2, y: r.bottom + 6 });
    }, 450);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setPos(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span className="inline-flex" onPointerEnter={show} onPointerLeave={hide} onPointerDown={hide}>
      {children}
      {pos &&
        createPortal(
          <div
            className="anim-fade pointer-events-none fixed z-[1000] flex items-center gap-2 rounded-sm bg-raised px-2 py-1 text-xs text-fg shadow-pop"
            style={{
              left: pos.x,
              top: pos.y,
              transform: side === "top" ? "translate(-50%, -100%)" : side === "right" ? "translateY(-50%)" : "translateX(-50%)",
            }}
          >
            {text}
            {shortcut && <Kbd>{shortcut}</Kbd>}
          </div>,
          document.body,
        )}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="tc rounded-xs border border-line-strong bg-field px-1 text-[10px] leading-4 text-fg-3">{children}</kbd>;
}

// --- Menu / context menu -----------------------------------------------------------

export interface MenuItem {
  label?: string;
  shortcut?: string;
  onSelect?: () => void;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  separator?: boolean;
  /** Non-interactive group title. */
  heading?: boolean;
  submenu?: MenuItem[];
}

export function MenuList({ items, onClose, x, y, minWidth = 220 }: { items: MenuItem[]; onClose: () => void; x: number; y: number; minWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  const [focus, setFocus] = useState(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAt({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);

  const selectable = items.map((it, i) => (!it.separator && !it.heading && !it.disabled ? i : -1)).filter((i) => i >= 0);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (sub) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const cur = selectable.indexOf(focus);
        const next = e.key === "ArrowDown" ? (cur + 1) % selectable.length : (cur - 1 + selectable.length) % selectable.length;
        setFocus(selectable[next] ?? -1);
      } else if (e.key === "Enter" && focus >= 0) {
        e.preventDefault();
        e.stopPropagation();
        const it = items[focus];
        if (it.onSelect) {
          onClose();
          it.onSelect();
        }
      }
    };
    window.addEventListener("keydown", key, { capture: true });
    return () => window.removeEventListener("keydown", key, { capture: true });
  });

  return (
    <div
      ref={ref}
      role="menu"
      className="anim-pop fixed z-[900] rounded-md bg-raised p-1 shadow-pop"
      style={{ left: at.x, top: at.y, minWidth }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="mx-1 my-1 h-px bg-line-strong" />
        ) : it.heading ? (
          <div key={i} className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-4">
            {it.label}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onPointerEnter={(e) => {
              setFocus(i);
              if (it.submenu) {
                const r = e.currentTarget.getBoundingClientRect();
                setSub({ index: i, x: r.right + 2, y: r.top - 4 });
              } else setSub(null);
            }}
            onClick={() => {
              if (it.submenu || !it.onSelect) return;
              onClose();
              it.onSelect();
            }}
            className={cx(
              "flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-sm disabled:opacity-35",
              focus === i && !it.disabled && (it.danger ? "bg-danger/15 text-danger" : "bg-hover text-fg"),
              focus !== i && (it.danger ? "text-danger" : "text-fg-2"),
            )}
          >
            <span className="flex w-3.5 justify-center text-signal">{it.checked ? "●" : ""}</span>
            <span className="flex-1 truncate">{it.label}</span>
            {it.shortcut && <span className="tc text-[10.5px] text-fg-3">{it.shortcut}</span>}
            {it.submenu && <span className="text-fg-3">›</span>}
          </button>
        ),
      )}
      {sub && items[sub.index]?.submenu && (
        <MenuList items={items[sub.index].submenu!} x={sub.x} y={sub.y} onClose={onClose} minWidth={180} />
      )}
    </div>
  );
}

/** Global context menu host. */
let openMenuImpl: ((items: MenuItem[], x: number, y: number) => void) | null = null;

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  openMenuImpl?.(items, e.clientX, e.clientY);
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number } | null>(null);
  useEffect(() => {
    openMenuImpl = (items, x, y) => setMenu({ items, x, y });
    return () => {
      openMenuImpl = null;
    };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);
  if (!menu) return null;
  return createPortal(<MenuList items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />, document.body);
}

// --- Dropdown (select) -------------------------------------------------------------

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className,
  width,
  label,
}: {
  value: T;
  /** Options with a `group` are listed under group titles. */
  options: { value: T; label: string; group?: string }[];
  onChange: (v: T) => void;
  className?: string;
  width?: number;
  label?: string;
}) {
  const [open, setOpen] = useState<{ x: number; y: number; w: number } | null>(null);
  const current = options.find((o) => o.value === value);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <>
      <button
        aria-label={label}
        className={cx(
          "flex h-6 items-center justify-between gap-2 rounded-sm border border-line-strong bg-field px-2 text-xs text-fg hover:bg-hover",
          className,
        )}
        style={{ width }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.left, y: r.bottom + 3, w: r.width });
        }}
      >
        <span className="truncate">{current?.label ?? "–"}</span>
        <span className="text-[9px] text-fg-3">▼</span>
      </button>
      {open &&
        createPortal(
          <MenuList
            x={open.x}
            y={open.y}
            minWidth={Math.max(open.w, 120)}
            onClose={() => setOpen(null)}
            items={options.flatMap((o, i): MenuItem[] => {
              const item = { label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) };
              if (!o.group || options[i - 1]?.group === o.group) return [item];
              return [...(i > 0 ? [{ separator: true }] : []), { label: o.group, heading: true }, item];
            })}
          />,
          document.body,
        )}
    </>
  );
}

// --- Segmented control -------------------------------------------------------------

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div className={cx("inline-flex rounded-sm bg-ground p-0.5", size === "sm" ? "h-6" : "h-7")}>
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "flex items-center rounded-xs px-2 text-xs transition-colors duration-100",
            o.value === value ? "bg-hover text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "text-fg-3 hover:text-fg-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// --- Toggle ------------------------------------------------------------------------

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("relative block h-4 w-7 shrink-0 rounded-full transition-colors duration-150", checked ? "bg-signal" : "bg-press")}
    >
      {/* Pinned to the left edge: a button centres absolutely positioned children otherwise. */}
      <span
        className={cx(
          "absolute left-0 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-transform duration-150",
          checked ? "translate-x-3.5 bg-signal-ink" : "translate-x-0.5 bg-fg-2",
        )}
      />
    </button>
  );
}

// --- Scrubbable number field ---------------------------------------------------------

/**
 * Numeric value editable by dragging horizontally (Shift = fine, Ctrl = coarse)
 * or by typing. `onPreview` fires during drags, `onCommit` once at the end.
 */
export function NumberField({
  value,
  onCommit,
  onPreview,
  step = 1,
  min = -Infinity,
  max = Infinity,
  precision = 0,
  unit,
  width = 64,
  format,
  parse,
  label,
  disabled,
}: {
  value: number;
  onCommit: (v: number) => void;
  onPreview?: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  unit?: string;
  width?: number;
  format?: (v: number) => string;
  parse?: (s: string) => number | null;
  label?: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, v)), [min, max]);
  const show = live ?? value;
  const fmt = (v: number) => (format ? format(v) : v.toFixed(precision).replace(".", ","));

  if (editing) {
    return (
      <input
        autoFocus
        aria-label={label}
        className="tc h-6 rounded-sm border border-signal bg-ground px-1.5 text-xs text-fg outline-none"
        style={{ width }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = parse ? parse(text) : Number(text.replace(",", "."));
            if (v !== null && isFinite(v)) onCommit(clamp(v));
            setEditing(false);
          } else if (e.key === "Escape") setEditing(false);
          e.stopPropagation();
        }}
      />
    );
  }
  return (
    <button
      aria-label={label}
      disabled={disabled}
      className="tc flex h-6 cursor-ew-resize items-center justify-end gap-0.5 rounded-sm bg-field px-1.5 text-xs text-fg hover:bg-hover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-field"
      style={{ width }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, v: value, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 3) return;
        d.moved = true;
        const mult = e.shiftKey ? 0.1 : e.ctrlKey ? 10 : 1;
        const v = clamp(Number((d.v + dx * step * mult).toFixed(Math.max(precision, 4))));
        setLive(v);
        onPreview?.(v);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved && live !== null) onCommit(live);
        else {
          setText(fmt(value));
          setEditing(true);
        }
        setLive(null);
      }}
      onDoubleClick={() => {
        setText(fmt(value));
        setEditing(true);
      }}
    >
      {fmt(show)}
      {unit && <span className="text-fg-3">{unit}</span>}
    </button>
  );
}

// --- Slider --------------------------------------------------------------------------

export function Slider({
  value,
  min,
  max,
  onPreview,
  onCommit,
  center,
  label,
  onReset,
}: {
  value: number;
  min: number;
  max: number;
  onPreview?: (v: number) => void;
  onCommit: (v: number) => void;
  center?: number;
  label?: string;
  onReset?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<number | null>(null);
  const v = live ?? value;
  const pct = (x: number) => ((x - min) / (max - min)) * 100;
  const from = center !== undefined ? pct(Math.min(center, v)) : 0;
  const to = center !== undefined ? pct(Math.max(center, v)) : pct(v);
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return min + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (max - min);
  };
  return (
    <div
      ref={ref}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={v}
      className="group relative h-5 flex-1 cursor-pointer"
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const x = at(e.clientX);
        setLive(x);
        onPreview?.(x);
      }}
      onPointerMove={(e) => {
        if (live === null) return;
        const x = at(e.clientX);
        setLive(x);
        onPreview?.(x);
      }}
      onPointerUp={() => {
        if (live !== null) onCommit(live);
        setLive(null);
      }}
    >
      <div className="absolute top-1/2 h-[3px] w-full -translate-y-1/2 rounded-full bg-press" />
      <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-fg-3 group-hover:bg-fg-2" style={{ left: `${from}%`, width: `${to - from}%` }} />
      <div
        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-fg shadow transition-transform group-active:scale-110"
        style={{ left: `${pct(v)}%` }}
      />
    </div>
  );
}

// --- Progress ------------------------------------------------------------------------

export function Progress({ value, indeterminate, tone = "signal" }: { value?: number; indeterminate?: boolean; tone?: "signal" | "danger" | "neutral" }) {
  const color = tone === "danger" ? "bg-danger" : tone === "neutral" ? "bg-fg-3" : "bg-signal";
  return (
    <div className="relative h-1 w-full overflow-hidden rounded-full bg-press">
      {indeterminate ? (
        <div className={cx("absolute inset-y-0 w-1/3 rounded-full", color)} style={{ animation: "kerf-indeterminate 1.1s ease-in-out infinite" }} />
      ) : (
        <div className={cx("h-full rounded-full transition-[width] duration-200", color)} style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
      )}
    </div>
  );
}

// --- Panel chrome --------------------------------------------------------------------

/** Tab strip of the panel group a panel sits in; it takes the place of the panel title. */
export const PanelGroupTabs = createContext<ReactNode>(null);
/** Starts dragging the panel to another place in the layout (from its header). */
export const PanelDock = createContext<((e: React.PointerEvent) => void) | null>(null);
/** True when the panel shares its area with others (its title is the tab). */
export const useInPanelGroup = () => useContext(PanelGroupTabs) !== null;

export function PanelHeader({ title, children, tabs }: { title?: ReactNode; children?: ReactNode; tabs?: ReactNode }) {
  const group = useContext(PanelGroupTabs);
  const dock = useContext(PanelDock);
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2.5"
      // The empty header and the title move the panel; its controls stay controls.
      onPointerDown={(e) => {
        const t = e.target as HTMLElement;
        if (dock && (t === e.currentTarget || t.matches("span.panel-title"))) dock(e);
      }}
    >
      {group}
      {tabs ?? (!group && <span className="panel-title min-w-0 truncate">{title}</span>)}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">{children}</div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <span className="w-[92px] shrink-0 truncate text-xs text-fg-3">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-line">
      <div className="flex h-8 items-center px-3">
        <button className="flex flex-1 items-center gap-1.5 text-left" onClick={() => setOpen(!open)}>
          <span className={cx("text-[9px] text-fg-3 transition-transform duration-150", open && "rotate-90")}>▶</span>
          <span className="text-xs font-semibold text-fg-2">{title}</span>
        </button>
        {right}
      </div>
      {open && <div className="space-y-1 px-3 pb-3">{children}</div>}
    </section>
  );
}

// --- Modal -----------------------------------------------------------------------------

export function Modal({ title, children, footer, onClose, width = 440 }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: number }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, { capture: true });
    return () => window.removeEventListener("keydown", key, { capture: true });
  }, [onClose]);
  return createPortal(
    <div className="anim-fade fixed inset-0 z-[800] flex items-center justify-center bg-black/55" onPointerDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="anim-pop flex max-h-[85vh] flex-col rounded-lg bg-panel shadow-pop"
        style={{ width }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 shrink-0 items-center border-b border-line px-4 text-base font-semibold">{title}</div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function TextInput({ value, onChange, placeholder, autoFocus, selectOnFocus, onEnter, className }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; selectOnFocus?: boolean; onEnter?: () => void; className?: string }) {
  return (
    <input
      autoFocus={autoFocus}
      onFocus={selectOnFocus ? (e) => e.target.select() : undefined}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onEnter?.();
        e.stopPropagation();
      }}
      className={cx(
        "h-7 w-full rounded-sm border border-line-strong bg-ground px-2 text-sm text-fg outline-none placeholder:text-fg-4 focus:border-signal",
        className,
      )}
    />
  );
}
