import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fdrBand } from "../lib.js";

// Club data keyed by team id ({name, short_name, code, fixtures}) from teams.json.
export const TeamsContext = createContext({});
export const useTeam = (teamId) => useContext(TeamsContext)[teamId];

// Kits and badges come straight from the FPL / Premier League CDNs, keyed by
// the club's FPL `code`. Goalkeepers get the "_1" keeper kit.
const shirtUrl = (code, gk) =>
  `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${code}${gk ? "_1" : ""}-110.webp`;
const badgeUrl = (code) => `https://resources.premierleague.com/premierleague/badges/70/t${code}.png`;

// Remote image that falls back to a text tile if it can't load.
function ClubImage({ src, alt, size, fallback, className }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <span className={`${className}-fallback`} style={{ width: size, height: size }}>{fallback}</span>;
  }
  return (
    <img className={className} src={src} alt={alt} width={size} height={size}
      loading="lazy" draggable={false} onError={() => setFailed(true)} />
  );
}

export function Shirt({ teamId, gk = false, size = 48 }) {
  const team = useTeam(teamId);
  return <ClubImage className="shirt" size={size} alt={team ? `${team.name} shirt` : ""}
    src={team && shirtUrl(team.code, gk)} fallback={team?.short_name ?? "?"} />;
}

export function Badge({ teamId, size = 20 }) {
  const team = useTeam(teamId);
  return <ClubImage className="badge" size={size} alt={team ? `${team.name} badge` : ""}
    src={team && badgeUrl(team.code)} fallback={team?.short_name?.[0] ?? "?"} />;
}

// One fixture, coloured by difficulty like the FPL site. Compact form writes
// home opponents in capitals and away opponents in lower case.
export function FdrChip({ fx, compact = false }) {
  const where = fx.home ? "H" : "A";
  return (
    <span className={`fdr fdr-${fdrBand(fx.fdr)}`}
      title={`GW${fx.gw}: ${fx.opp} (${fx.home ? "home" : "away"}) · difficulty ${fx.fdr.toFixed(1)}`}>
      {compact ? (fx.home ? fx.opp : fx.opp.toLowerCase()) : `${fx.opp} (${where})`}
    </span>
  );
}

export function NextFixtures({ teamId, n = 3, compact = true }) {
  const team = useTeam(teamId);
  const fixtures = team?.fixtures?.slice(0, n) ?? [];
  if (!fixtures.length) return null;
  return <span className="fx-row">{fixtures.map((f, i) => <FdrChip key={i} fx={f} compact={compact} />)}</span>;
}

// Close something on a click outside `ref` or on Escape.
export function useOutside(ref, onClose, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const click = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [ref, onClose, active]);
}

// Panel anchored to an element but rendered in <body>, so the pitch can't clip
// it. Opens below (or above when there's no room) and stays on screen. With
// `onClose` it's interactive: outside clicks (other than on the anchor),
// Escape and page scroll close it.
export function Floating({ anchorRef, onClose, className = "", children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    const el = ref.current;
    if (!a || !el) return;
    const m = 8, w = el.offsetWidth, h = el.offsetHeight;
    let top = a.bottom + 8;
    if (top + h > window.innerHeight - m && a.top - h - 8 > m) top = a.top - h - 8;
    top = Math.max(m, Math.min(top, window.innerHeight - h - m));
    const left = Math.min(Math.max(a.left + a.width / 2 - w / 2, m), window.innerWidth - w - m);
    setPos({ top, left });
  }, [anchorRef]);
  useEffect(() => {
    if (!onClose) return undefined;
    const inside = (t) => ref.current?.contains(t) || anchorRef.current?.contains(t);
    const click = (e) => { if (!inside(e.target)) onClose(); };
    const key = (e) => { if (e.key === "Escape") onClose(); };
    const scroll = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [anchorRef, onClose]);
  return createPortal(
    <div ref={ref} className={`floating ${className}`} style={pos ?? { top: 0, left: 0, visibility: "hidden" }}
      onClick={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

// Animated dropdown. options: [{ value, label, icon? }].
export function Dropdown({ value, options, onChange, label, align = "left", className = "" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <div className={`dd ${open ? "open" : ""} ${className}`} ref={ref}>
      <button type="button" className="dd-btn" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        {label && <span className="dd-label">{label}</span>}
        {current?.icon}
        <span className="dd-value">{current?.label}</span>
        <span className="caret" aria-hidden>▾</span>
      </button>
      {open && (
        <ul className={`dd-menu ${align}`} role="listbox">
          {options.map((o) => (
            <li key={o.value}>
              <button type="button" role="option" aria-selected={o.value === value}
                className={o.value === value ? "active" : ""}
                onClick={() => { onChange(o.value); setOpen(false); }}>
                {o.icon}<span>{o.label}</span>{o.value === value && <span className="tick">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Pill-style toggle group. options: [{ value, label }].
export function Segmented({ value, options, onChange, className = "" }) {
  return (
    <div className={`seg ${className}`} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value}
          className={o.value === value ? "active" : ""} style={o.color ? { "--seg": o.color } : undefined}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

// Eases a number toward its new value (skipped when the user prefers reduced motion).
export function useAnimatedNumber(value, ms = 450) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const start = from.current;
    if (reduce || start === value) { from.current = value; setShown(value); return undefined; }
    const t0 = performance.now();
    let raf;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      const v = start + (value - start) * (1 - (1 - k) ** 3);
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}
