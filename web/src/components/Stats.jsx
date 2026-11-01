import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { METRICS, AXIS_KEYS, POSITIONS, POS_COLOR, POS_NAME, fairShareOwnership, isNailed, NAILED_MINUTES } from "../lib.js";
import { model } from "../transfers.js";
import { Badge, Beta, Dropdown, More, NextFixtures, Segmented, Shirt, TeamsContext } from "./ui.jsx";
import Insights from "./Insights.jsx";

const W = 760, H = 420, M = { top: 18, right: 18, bottom: 46, left: 56 };
const IW = W - M.left - M.right, IH = H - M.top - M.bottom;
// Round tick values (1, 2, 2.5 or 5 × a power of ten apart), about n across the range.
function ticks(min, max, n = 6) {
  const raw = (max - min || 1) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Number(v.toFixed(6)));
  return out;
}
const AXIS_OPTIONS = AXIS_KEYS.map((k) => ({ value: k, label: METRICS[k].label }));
const POINTS_KEYS = ["points", "horizon"]; // the value curve's Y: expected points
const VALUE_LIST = 8; // rows shown per position before "show all"

// The value curve for one position: the most points anyone gives for the money.
// It's the upper edge (concave hull) of price against points, from the player
// with the most points per £m on (cheaper ones on the edge give fewer points
// *and* fewer per £m); below his price the edge is the line from £0 through
// him. It bends like a log curve because the data does. `gap`: how many points
// a player sits below it.
function valueCurve(rows) {
  const s = [...rows].sort((a, b) => a.x - b.x || b.y - a.y);
  let hull = [];
  for (const q of s) {
    if (hull.length && hull.at(-1).x === q.x) continue; // same price, fewer points
    while (hull.length >= 2) {
      const [a, b] = hull.slice(-2);
      if ((b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x) >= 0) hull.pop(); else break;
    }
    hull.push(q);
  }
  if (!hull.length) return null;
  const top = hull.reduce((m, q, i) => (q.y > hull[m].y ? i : m), 0);
  const start = hull.reduce((m, q, i) => (i <= top && q.y / q.x > hull[m].y / hull[m].x ? i : m), 0);
  hull = hull.slice(start, top + 1);
  const at = (x) => {
    if (x <= hull[0].x) return (hull[0].y / hull[0].x) * x;
    const i = hull.findIndex((q) => q.x >= x);
    if (i < 0) return hull.at(-1).y;
    const a = hull[i - 1], b = hull[i];
    return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  };
  return { hull, at, gap: (r) => Math.max(0, at(r.x) - r.y) };
}

// Each toggled position's curve and its players, closest first. "Near" is
// within the model's margin of error on a projection (sigma_mean): a player
// that close can't be told apart from the curve.
function useValueCurves(shown, curvePos, yk, recency) {
  return useMemo(() => {
    const margin = model().sigma_mean ?? 0;
    return [...curvePos].map((pos) => {
      const rows = shown.filter((p) => p.position === pos)
        .map((p) => ({ p, x: p.price, y: METRICS[yk].get(p, recency) }));
      const curve = valueCurve(rows);
      if (!curve) return null;
      const ranked = rows.map((r) => ({ ...r, gap: curve.gap(r) })).sort((a, b) => a.gap - b.gap || a.x - b.x);
      return { pos, ...curve, margin, near: ranked.filter((r) => r.gap <= margin), onCurve: new Set(curve.hull.map((q) => q.p)) };
    }).filter(Boolean);
  }, [shown, curvePos, yk, recency]);
}

// Table columns: metric key + short header. Sorting reuses the metric getters.
const COLUMNS = [
  ["price", "£"], ["points", "Pts"], ["horizon", "xP/GW"], ["value", "Value"], ["form", "Form"], ["selected", "Own"],
  ["start_prob", "Plays"], ["avg_mins", "Mins"], ["xgi", "xGI/90"], ["cs", "CS xP"], ["defcon", "DC xP"], ["total", "Total"],
];

// Zoom / pan: `view` is the visible data window ({x0, x1, y0, y1}); null fits
// every player. Pinch (or Ctrl/⌘ + scroll) zooms at the cursor, dragging draws
// a box to zoom into (or pans, with the pan tool), double-click resets.
const ZOOM_STEP = 1.5;     // the − / + buttons
const DRAG_MIN = 5;        // px of movement before a press counts as a drag, not a click
const LABEL_ALL = 30;      // name every dot once this few are in view

function Scatter({ shown, xk, yk, recency, placedIds, onPick, curves }) {
  const [hover, setHover] = useState(null);
  const [view, setView] = useState(null);
  const [tool, setTool] = useState("box");
  const [drag, setDrag] = useState(null); // {sx, sy, ex, ey, start: view at press}
  const svgRef = useRef(null);
  const touches = useRef(new Map()); // pointerId -> [sx, sy], for two-finger pinch
  useEffect(() => setView(null), [xk, yk]);

  const xm = METRICS[xk], ym = METRICS[yk];
  const xs = shown.map((p) => xm.get(p, recency)), ys = shown.map((p) => ym.get(p, recency));
  // Prices start at £3.5m+, so that axis starts at the cheapest player's half-million.
  // The top and right edges get a little room so the extreme dots aren't cut in half.
  const x0 = xk === "price" && xs.length ? Math.floor(Math.min(...xs) * 2) / 2 : Math.min(0, ...xs);
  const x1 = Math.max(1, ...xs), y0 = Math.min(0, ...ys), y1 = Math.max(1, ...ys);
  const fit = { x0, x1: x1 + (x1 - x0) * 0.03, y0, y1: y1 + (y1 - y0) * 0.05 };
  const d = view ?? fit;
  const px = (v) => M.left + ((v - d.x0) / (d.x1 - d.x0 || 1)) * IW;
  const py = (v) => M.top + IH - ((v - d.y0) / (d.y1 - d.y0 || 1)) * IH;
  const ix = (sx) => d.x0 + ((sx - M.left) / IW) * (d.x1 - d.x0);
  const iy = (sy) => d.y0 + ((M.top + IH - sy) / IH) * (d.y1 - d.y0);
  const toSvg = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height];
  };
  // Scale the window by f (< 1 zooms in) around the point under (sx, sy).
  const zoomAt = (sx, sy, f) => {
    const cx = ix(sx), cy = iy(sy);
    setView({ x0: cx - (cx - d.x0) * f, x1: cx + (d.x1 - cx) * f, y0: cy - (cy - d.y0) * f, y1: cy + (d.y1 - cy) * f });
  };
  const zoomCentre = (f) => zoomAt(M.left + IW / 2, M.top + IH / 2, f);

  // Pinch on a trackpad arrives as Ctrl + wheel; plain scrolling still scrolls the page.
  useEffect(() => {
    const el = svgRef.current;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const [sx, sy] = toSvg(e);
      zoomAt(sx, sy, Math.exp(e.deltaY * 0.01));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onDown = (e) => {
    if (e.button !== 0) return;
    const p = toSvg(e);
    touches.current.set(e.pointerId, p);
    if (touches.current.size === 1) setDrag({ sx: p[0], sy: p[1], ex: p[0], ey: p[1], start: d });
    else setDrag(null);
  };
  const onMove = (e) => {
    const p = toSvg(e);
    const pts = touches.current;
    if (pts.size === 2 && pts.has(e.pointerId)) { // two fingers: zoom by the change in their distance
      const [a, b] = [...pts.values()], before = Math.hypot(a[0] - b[0], a[1] - b[1]);
      pts.set(e.pointerId, p);
      const [c, g] = [...pts.values()], after = Math.hypot(c[0] - g[0], c[1] - g[1]);
      if (before > 0 && after > 0) zoomAt((c[0] + g[0]) / 2, (c[1] + g[1]) / 2, before / after);
      return;
    }
    if (!drag) return;
    if (Math.hypot(p[0] - drag.sx, p[1] - drag.sy) > DRAG_MIN && !e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ ...drag, ex: p[0], ey: p[1] });
    if (tool === "pan") {
      const s = drag.start, dx = ((p[0] - drag.sx) / IW) * (s.x1 - s.x0), dy = ((p[1] - drag.sy) / IH) * (s.y1 - s.y0);
      setView({ x0: s.x0 - dx, x1: s.x1 - dx, y0: s.y0 + dy, y1: s.y1 + dy });
    }
  };
  const onUp = (e) => {
    touches.current.delete(e.pointerId);
    if (drag && tool === "box" && Math.abs(drag.ex - drag.sx) > DRAG_MIN && Math.abs(drag.ey - drag.sy) > DRAG_MIN) {
      const [a, b] = [ix(drag.sx), ix(drag.ex)].sort((u, v) => u - v), [c, g] = [iy(drag.sy), iy(drag.ey)].sort((u, v) => u - v);
      setView({ x0: a, x1: b, y0: c, y1: g });
    }
    setDrag(null);
  };
  const boxing = drag && tool === "box" && Math.hypot(drag.ex - drag.sx, drag.ey - drag.sy) > DRAG_MIN;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // With a curve on, that position's players far below it fade; those on it are named.
  const curveOf = Object.fromEntries(curves.map((c) => [c.pos, c]));
  const nearSet = new Set(curves.flatMap((c) => c.near.map((r) => r.p)));
  const faded = (p) => curveOf[p.position] && !nearSet.has(p);
  const inView = shown.filter((p) => {
    const x = xm.get(p, recency), y = ym.get(p, recency);
    return x >= d.x0 && x <= d.x1 && y >= d.y0 && y <= d.y1;
  });
  const named = new Set(curves.flatMap((c) => c.hull.map((q) => q.p)));
  const labelled = inView.length <= LABEL_ALL ? inView.filter((p) => !named.has(p)) : [];

  return (
    <div className="chart-wrap">
      <div className="chart-tools">
        <Segmented value={tool} onChange={setTool}
          options={[{ value: "box", label: "⬚ Zoom to area" }, { value: "pan", label: "✥ Pan" }]} />
        <div className="chart-zoom">
          <button type="button" className="btn sm" onClick={() => zoomCentre(ZOOM_STEP)} aria-label="Zoom out">−</button>
          <button type="button" className="btn sm" onClick={() => zoomCentre(1 / ZOOM_STEP)} aria-label="Zoom in">+</button>
          <button type="button" className="btn sm ghost" onClick={() => setView(null)} disabled={!view}>Reset</button>
        </div>
        <small className="chart-help">{tool === "box" ? "Drag a box around players to zoom in" : "Drag to move around"} · pinch or
          {" "}Ctrl/⌘ + scroll to zoom · double-click to reset · {inView.length} in view</small>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className={`chart tool-${tool} ${drag && tool === "pan" ? "panning" : ""}`}
        role="img" aria-label={`${ym.label} against ${xm.label}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={(e) => { if (!e.target.classList.contains("dot")) setView(null); }}>
        <defs><clipPath id="plot-area"><rect x={M.left} y={M.top} width={IW} height={IH} /></clipPath></defs>
        {ticks(d.y0, d.y1).map((t) => (
          <g key={`y${t}`}>
            <line x1={M.left} x2={W - M.right} y1={py(t)} y2={py(t)} className="grid" />
            <text x={M.left - 8} y={py(t)} className="tick" textAnchor="end" dominantBaseline="middle">{ym.fmt(t)}</text>
          </g>
        ))}
        {ticks(d.x0, d.x1).map((t) => (
          <g key={`x${t}`}>
            <line x1={px(t)} x2={px(t)} y1={M.top} y2={H - M.bottom} className="grid" />
            <text x={px(t)} y={H - M.bottom + 18} className="tick" textAnchor="middle">{xm.fmt(t)}</text>
          </g>
        ))}
        <text x={M.left + IW / 2} y={H - 6} className="axis-title" textAnchor="middle">{xm.label}</text>
        <text x={-(M.top + IH / 2)} y={15} className="axis-title" textAnchor="middle" transform="rotate(-90)">{ym.label}</text>
        <g clipPath="url(#plot-area)">
        {curves.map((c) => {
          const first = c.hull[0], cheapest = Math.max(fit.x0, Math.min(...c.near.map((r) => r.x), first.x));
          const band = c.hull.map((q) => `${px(q.x)},${py(q.y - c.margin)}`).reverse().join(" ");
          return (
            <g key={c.pos} className="vcurve" style={{ "--pos": POS_COLOR[c.pos] }}>
              <polygon className="band" points={`${px(cheapest)},${py(c.at(cheapest))} ${c.hull.map((q) => `${px(q.x)},${py(q.y)}`).join(" ")} ${band} ${px(cheapest)},${py(c.at(cheapest) - c.margin)}`} />
              {cheapest < first.x && <line className="ray" x1={px(cheapest)} y1={py(c.at(cheapest))} x2={px(first.x)} y2={py(first.y)} />}
              <polyline className="edge" points={c.hull.map((q) => `${px(q.x)},${py(q.y)}`).join(" ")} />
            </g>
          );
        })}
        {shown.map((p) => (
          <circle key={p.player_id} cx={px(xm.get(p, recency))} cy={py(ym.get(p, recency))}
            r={placedIds.has(p.player_id) ? 6.5 : 4.5} fill={POS_COLOR[p.position]}
            className={`dot ${placedIds.has(p.player_id) ? "picked" : ""} ${hover?.p === p ? "hot" : ""} ${faded(p) ? "faded" : ""}`}
            onMouseEnter={(e) => setHover({ p, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setHover({ p, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setHover(null)}
            onClick={() => onPick(p)} />
        ))}
        {curves.flatMap((c) => c.hull.map((q) => (
          <text key={q.p.player_id} x={px(q.x) + 7} y={py(q.y) - 7} className="vlabel">{q.p.player_name}</text>
        )))}
        {labelled.map((p) => (
          <text key={p.player_id} x={px(xm.get(p, recency)) + 7} y={py(ym.get(p, recency)) + 4} className="vlabel small">{p.player_name}</text>
        ))}
        </g>
        {boxing && (() => {
          const x0 = clamp(Math.min(drag.sx, drag.ex), M.left, M.left + IW), x1 = clamp(Math.max(drag.sx, drag.ex), M.left, M.left + IW);
          const y0 = clamp(Math.min(drag.sy, drag.ey), M.top, M.top + IH), y1 = clamp(Math.max(drag.sy, drag.ey), M.top, M.top + IH);
          return <rect className="zoom-box" x={x0} y={y0} width={x1 - x0} height={y1 - y0} />;
        })()}
      </svg>
      <div className="legend">
        {POSITIONS.map((p) => <span key={p}><i style={{ background: POS_COLOR[p] }} />{p}</span>)}
        <span className="legend-note">Click a dot to add or remove from your squad</span>
      </div>
      {hover && (
        <div className="scatter-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <Shirt teamId={hover.p.team_id} gk={hover.p.position === "GK"} size={30} />
          <div>
            <b>{hover.p.player_name}</b>
            <small>{hover.p.position} · {hover.p.team} · £{hover.p.price.toFixed(1)}</small>
            <span>{xm.label}: {xm.fmt(xm.get(hover.p, recency))}</span>
            <span>{ym.label}: {ym.fmt(ym.get(hover.p, recency))}</span>
            {curveOf[hover.p.position] && (() => {
              const g = curveOf[hover.p.position].gap({ x: hover.p.price, y: ym.get(hover.p, recency) });
              return <span className="tip-gap">{g < 0.05 ? "On the value curve" : `${g.toFixed(1)} pts below the value curve`}</span>;
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// The players on or near each toggled curve, closest first, with what else
// makes them worth a look: minutes, set pieces, and how few managers own them.
function ValuePicks({ curves, ym, placedIds, onPick, fairShare }) {
  const [open, setOpen] = useState(new Set());
  if (!curves.length) return null;
  return (
    <div className="value-picks">
      <p className="hint">On the curve: the most points for the price. Shaded: within the margin of error (±{curves[0].margin.toFixed(1)} pts). <More to="value">More</More></p>
      {curves.map((c) => {
        const rows = open.has(c.pos) ? c.near : c.near.slice(0, VALUE_LIST);
        return (
          <div key={c.pos} className="vp-group" style={{ "--pos": POS_COLOR[c.pos] }}>
            <h3>{POS_NAME[c.pos]} <small>{c.near.length} within the margin, {c.hull.length} on the curve</small></h3>
            {rows.map(({ p, y, gap }) => {
              const picked = placedIds.has(p.player_id);
              const tags = [
                `plays ${Math.round((p.start_prob ?? 0) * 100)}%`,
                p.on_pens && "pens", p.on_fks && "free kicks", p.on_corners && "corners",
                (p.selected_by_percent ?? 100) < fairShare && `${p.selected_by_percent.toFixed(1)}% owned: differential`,
              ].filter(Boolean);
              return (
                <div key={p.player_id} className={`vp-row ${picked ? "picked" : ""}`}>
                  <Shirt teamId={p.team_id} gk={p.position === "GK"} size={30} />
                  <div className="vp-main">
                    <b>{p.player_name}</b>
                    <small>£{p.price.toFixed(1)}m · {p.team} · {tags.join(" · ")}</small>
                  </div>
                  <NextFixtures teamId={p.team_id} n={3} />
                  <span className="vp-pts">{ym.fmt(y)}</span>
                  <span className={`vp-gap ${c.onCurve.has(p) ? "on" : ""}`}>{c.onCurve.has(p) ? "on curve" : `−${gap.toFixed(1)}`}</span>
                  <button type="button" className={`add-btn ${picked ? "on" : ""}`} onClick={() => onPick(p)}
                    aria-label={picked ? `Remove ${p.player_name}` : `Add ${p.player_name}`}>{picked ? "✓" : "+"}</button>
                </div>
              );
            })}
            {c.near.length > VALUE_LIST && (
              <button type="button" className="link" onClick={() => setOpen((s) => { const n = new Set(s); n.has(c.pos) ? n.delete(c.pos) : n.add(c.pos); return n; })}>
                {open.has(c.pos) ? "Show fewer" : `Show all ${c.near.length}`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Stats({ players, recency, placedIds, onPick }) {
  const teams = useContext(TeamsContext);
  const [xk, setXk] = useState("price");
  const [yk, setYk] = useState("points");
  const [posSel, setPosSel] = useState(new Set(POSITIONS));
  const [team, setTeam] = useState("ALL");
  // Price cap tops out at the dearest player (rounded up to £0.5m); null = no cap.
  const topPrice = useMemo(() => Math.ceil(Math.max(4, ...players.map((p) => p.price)) * 2) / 2, [players]);
  const [priceCap, setPriceCap] = useState(null);
  const priceMax = priceCap ?? topPrice;
  const [minStart, setMinStart] = useState(0);
  const [nailed, setNailed] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "points", dir: -1 });
  const [limit, setLimit] = useState(50);
  const [curvePos, setCurvePos] = useState(new Set());

  const teamOptions = useMemo(() => [
    { value: "ALL", label: "All clubs" },
    ...Object.values(teams).sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ value: String(t.id), label: t.name, icon: <Badge teamId={t.id} size={18} /> })),
  ], [teams]);

  const shown = useMemo(() => players.filter((p) =>
    posSel.has(p.position) &&
    (team === "ALL" || String(p.team_id) === team) &&
    p.price <= priceMax &&
    (p.start_prob ?? 0) >= minStart &&
    (!nailed || isNailed(p)) &&
    (!q || p.player_name.toLowerCase().includes(q.toLowerCase()))
  ), [players, posSel, team, priceMax, minStart, nailed, q]);

  const table = useMemo(() => {
    const m = METRICS[sort.key];
    return [...shown].sort((a, b) => sort.dir * (m.get(a, recency) - m.get(b, recency)));
  }, [shown, sort, recency]);

  const togglePos = (p) => setPosSel((s) => {
    const n = new Set(s);
    n.has(p) ? n.delete(p) : n.add(p);
    return n.size ? n : s;
  });
  const sortBy = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }));

  // Value curves are price against expected points: turning one on sets the axes.
  const curvesOn = xk === "price" && POINTS_KEYS.includes(yk);
  const curves = useValueCurves(shown, curvesOn ? curvePos : new Set(), yk, recency);
  const toggleCurve = (p) => {
    setCurvePos((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
    setXk("price");
    if (!POINTS_KEYS.includes(yk)) setYk("points");
  };
  const fairShare = useMemo(() => fairShareOwnership(players), [players]);

  return (
    <div className="stats-page">
      <section className="card filters">
        <div className="filter-group">
          <span className="w-label">Positions</span>
          <div className="chips">
            {POSITIONS.map((p) => (
              <button key={p} type="button" className={`chip pos ${posSel.has(p) ? "on" : ""}`} style={{ "--pos": POS_COLOR[p] }}
                aria-pressed={posSel.has(p)} onClick={() => togglePos(p)}>{p}</button>
            ))}
          </div>
        </div>
        <div className="filter-group">
          <span className="w-label">Club</span>
          <Dropdown value={team} options={teamOptions} onChange={setTeam} className="wide-menu" />
        </div>
        <label className="filter-group range">
          <span className="w-label">Max price <b>£{priceMax.toFixed(1)}m</b></span>
          <input type="range" min="4" max={topPrice} step="0.5" value={priceMax}
            onChange={(e) => { const v = parseFloat(e.target.value); setPriceCap(v >= topPrice ? null : v); }} />
        </label>
        <label className="filter-group range">
          <span className="w-label">Min chance of playing <b>{Math.round(minStart * 100)}%</b></span>
          <input type="range" min="0" max="1" step="0.05" value={minStart} onChange={(e) => setMinStart(parseFloat(e.target.value))} />
        </label>
        <div className="filter-group">
          <span className="w-label">Reliability</span>
          <button type="button" className={`chip nailed ${nailed ? "on" : ""}`} aria-pressed={nailed} onClick={() => setNailed((v) => !v)}>
            ● Nailed ≥{NAILED_MINUTES}′
          </button>
        </div>
        <label className="filter-group search-group">
          <span className="w-label">Search</span>
          <span className="search"><span aria-hidden>⌕</span><input placeholder="Player name" value={q} onChange={(e) => setQ(e.target.value)} /></span>
        </label>
        <span className="count">{shown.length} players</span>
      </section>

      <section className="card">
        <div className="card-head wrap">
          <h2>Compare players</h2>
          <div className="axis-pickers">
            <Dropdown value={xk} options={AXIS_OPTIONS} onChange={setXk} label="X" align="right" />
            <Dropdown value={yk} options={AXIS_OPTIONS} onChange={setYk} label="Y" align="right" />
          </div>
        </div>
        <div className="value-toggle">
          <span className="w-label">Value curve</span> <Beta />
          <div className="chips">
            {POSITIONS.map((p) => {
              const on = curvesOn && curvePos.has(p);
              return (
                <button key={p} type="button" className={`chip pos ${on ? "on" : ""}`} style={{ "--pos": POS_COLOR[p] }}
                  aria-pressed={on} onClick={() => toggleCurve(p)}>{p}</button>
              );
            })}
          </div>
          {curvePos.size > 0 && !curvesOn && <small className="hint">Set X to Price and Y to expected points to see the curves.</small>}
        </div>
        <Scatter shown={curves.length ? shown.filter((p) => curvePos.has(p.position)) : shown} xk={xk} yk={yk} recency={recency} placedIds={placedIds} onPick={onPick} curves={curves} />
        <ValuePicks curves={curves} ym={METRICS[yk]} placedIds={placedIds} onPick={onPick} fairShare={fairShare} />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Player stats</h2>
          <span className="hint">Click a column to sort · ✓ = in your squad</span>
        </div>
        <div className="table-scroll">
          <table className="stats-table">
            <thead>
              <tr>
                <th className="left">Player</th>
                {COLUMNS.map(([key, label]) => (
                  <th key={key} className={sort.key === key ? "sorted" : ""} aria-sort={sort.key === key ? (sort.dir < 0 ? "descending" : "ascending") : "none"}>
                    <button type="button" onClick={() => sortBy(key)} title={METRICS[key].label}>
                      {label}{sort.key === key && <span aria-hidden>{sort.dir < 0 ? " ↓" : " ↑"}</span>}
                    </button>
                  </th>
                ))}
                <th className="left">Next 3</th>
                <th aria-label="Add" />
              </tr>
            </thead>
            <tbody>
              {table.slice(0, limit).map((p) => {
                const picked = placedIds.has(p.player_id);
                return (
                  <tr key={p.player_id} className={picked ? "picked" : ""}>
                    <td className="left">
                      <span className="t-player" style={{ "--pos": POS_COLOR[p.position] }}>
                        <Shirt teamId={p.team_id} gk={p.position === "GK"} size={28} />
                        <span><b>{p.player_name}</b><small>{p.team} · {p.position}</small></span>
                      </span>
                    </td>
                    {COLUMNS.map(([key]) => (
                      <td key={key} className={sort.key === key ? "sorted" : ""}>{METRICS[key].fmt(METRICS[key].get(p, recency))}</td>
                    ))}
                    <td className="left"><NextFixtures teamId={p.team_id} n={3} /></td>
                    <td>
                      <button type="button" className={`add-btn ${picked ? "on" : ""}`} onClick={() => onPick(p)}
                        aria-label={picked ? `Remove ${p.player_name}` : `Add ${p.player_name}`}>{picked ? "✓" : "+"}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {table.length > limit && (
          <button className="btn ghost block" onClick={() => setLimit((l) => l + 50)}>
            Show more ({table.length - limit} left)
          </button>
        )}
      </section>

      <Insights players={shown} recency={recency} placedIds={placedIds} />
    </div>
  );
}
