import React, { useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { METRICS, AXIS_KEYS, POSITIONS, POS_COLOR, POS_NAME, adjPoints, fairShareOwnership, isNailed, NAILED_MINUTES } from "../lib.js";
import { model } from "../transfers.js";
import { Badge, Beta, Dropdown, More, NextFixtures, Segmented, Shirt, TeamsContext } from "./ui.jsx";
import Insights from "./Insights.jsx";
import CurveCheck from "./CurveCheck.jsx";
import { valueCurve } from "../valuecurve.js";

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

// Every player's projection and price at each past deadline (history.json, the
// History page's data), fetched once, the first time a dot is tapped.
let historyLoad = null;
function useSeasonHistory(want) {
  const [h, setH] = useState(null);
  useEffect(() => {
    if (!want) return undefined;
    historyLoad ??= fetch("history.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    let live = true;
    historyLoad.then((d) => live && setH(d));
    return () => { live = false; };
  }, [want]);
  return h;
}
// The axes a season path can show, read from each deadline's saved projection
// (the model's, before any form weighting).
const PATH_METRICS = {
  price: (r, f) => r[f.price],
  points: (r, f) => r[f.xp_gw][0],
  horizon: (r, f) => r[f.xp_gw].slice(0, 3).reduce((t, v) => t + v, 0) / 3,
  start_prob: (r, f) => r[f.start_prob] * 100,
  if_play: (r, f) => r[f.pts_if_play],
};
// One player's saved rows, deadline by deadline: [{gw, row, f}].
function seasonRows(hist, p) {
  if (!hist?.gws) return [];
  const f = Object.fromEntries(hist.fields.map((k, i) => [k, i]));
  return Object.keys(hist.gws).map(Number).sort((a, b) => a - b).flatMap((gw) => {
    const row = hist.gws[gw].find((r) => r[f.player_id] === p.player_id);
    return row ? [{ gw, row, f }] : [];
  });
}

// Zoom / pan: the view is the visible data window ({x0, x1, y0, y1}); null fits
// every player. The chart is drawn in screen pixels at its real width, so dots,
// names and axis numbers keep one size on any screen. Mouse: drag a box to zoom
// in (or pan, with the pan tool), Ctrl/⌘ + scroll zooms, double-click resets.
// Touch: one finger boxes or pans, two fingers pinch to zoom and move. A tap or
// click on (or near) a dot opens that player's overview.
const DRAG_MIN = { mouse: 4, pen: 6, touch: 10 }; // px of movement before a press counts as a drag, not a tap
const TAP_REACH = 22;  // px: a tap picks the nearest dot this close
const MAX_ZOOM = 40;   // deepest zoom: 1/40 of the full range on each axis
const ZOOM_STEP = 1.6; // the − / + buttons
const GLIDE_MS = 240;  // button, box and reset zooms glide this long
const LABEL_PX = 11;   // name size (matches .vlabel)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const KEYS = ["x0", "x1", "y0", "y1"];

// Tick labels in the metric's own format, with more decimals once ticks are
// closer together than it shows (so zoomed-in ticks don't all read "5.0").
const decimals = (s) => (String(s).match(/\d+(?:\.(\d+))?/)?.[1] ?? "").length;
function tickLabel(m, v, step) {
  const s = m.fmt(v), dec = decimals(Number(step.toPrecision(3)));
  return dec > decimals(s) ? s.replace(/\d+(?:\.\d+)?/, Math.abs(v).toFixed(dec)) : s;
}

function Scatter({ shown, xk, yk, recency, placedIds, onPick, curves }) {
  const [hover, setHover] = useState(null);
  const [sel, setSel] = useState(null); // the tapped player, shown in the overview card
  const [showPath, setShowPath] = useState(false); // his route through the season, on the chart
  const [names, setNames] = useState(true);
  const [tool, setTool] = useState("box");
  const [W, setW] = useState(760);
  const wrapRef = useRef(null), svgRef = useRef(null);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    setW(el.clientWidth || 760);
    const ro = new ResizeObserver(() => setW(el.clientWidth || 760));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const small = W < 520;
  const H = Math.round(clamp(W * 0.5, 300, 600));
  const M = small ? { top: 12, right: 10, bottom: 40, left: 42 } : { top: 16, right: 16, bottom: 46, left: 56 };
  const IW = W - M.left - M.right, IH = H - M.top - M.bottom;
  const coarse = useMemo(() => window.matchMedia?.("(pointer: coarse)").matches, []);

  const xm = METRICS[xk], ym = METRICS[yk];
  const pts = useMemo(() => shown.map((p) => ({ p, x: xm.get(p, recency), y: ym.get(p, recency) })), [shown, xm, ym, recency]);
  // Prices start at £3.5m+, so that axis starts at the cheapest player's half-million.
  // Every edge gets a little room so the extreme dots aren't cut in half.
  const fit = useMemo(() => {
    const xs = pts.map((r) => r.x), ys = pts.map((r) => r.y);
    const x0 = xk === "price" && xs.length ? Math.floor(Math.min(...xs) * 2) / 2 : Math.min(0, ...xs);
    const x1 = Math.max(1, ...xs), y0 = Math.min(0, ...ys), y1 = Math.max(1, ...ys);
    const padX = (x1 - x0) * 0.03, padY = (y1 - y0) * 0.05;
    return { x0: x0 - padX, x1: x1 + padX, y0: y0 - padY, y1: y1 + padY };
  }, [pts, xk]);

  // The window lives in a ref so fast gestures build on the latest one, not
  // the last render's; the screen catches up once per animation frame.
  const viewRef = useRef(null), boxRef = useRef(null), gesture = useRef(null), pointers = useRef(new Map());
  const moving = useRef(false); // while a gesture or glide runs, the names stay put
  const frame = useRef(0), glideFrame = useRef(0), settleTimer = useRef(0);
  const [, repaint] = useReducer((n) => n + 1, 0);
  const paint = () => { if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; repaint(); }); };
  const setView = (v) => { viewRef.current = v; paint(); };
  const settle = () => { moving.current = false; paint(); };
  useEffect(() => () => { cancelAnimationFrame(frame.current); cancelAnimationFrame(glideFrame.current); clearTimeout(settleTimer.current); }, []);
  useEffect(() => { cancelAnimationFrame(glideFrame.current); setView(null); }, [xk, yk]);

  const cur = () => viewRef.current ?? fit;
  // Keep a window inside the data and between full view and MAX_ZOOM; all the way out is "fit" (null).
  const limit = (v) => {
    if (!v) return null;
    const fx = fit.x1 - fit.x0, fy = fit.y1 - fit.y0;
    const sx = clamp(v.x1 - v.x0, fx / MAX_ZOOM, fx), sy = clamp(v.y1 - v.y0, fy / MAX_ZOOM, fy);
    if (sx > fx * 0.999 && sy > fy * 0.999) return null;
    const cx = clamp((v.x0 + v.x1) / 2, fit.x0 + sx / 2, fit.x1 - sx / 2), cy = clamp((v.y0 + v.y1) / 2, fit.y0 + sy / 2, fit.y1 - sy / 2);
    return { x0: cx - sx / 2, x1: cx + sx / 2, y0: cy - sy / 2, y1: cy + sy / 2 };
  };
  const dataAt = (v, sx, sy) => ({ x: v.x0 + ((sx - M.left) / IW) * (v.x1 - v.x0), y: v.y0 + ((M.top + IH - sy) / IH) * (v.y1 - v.y0) });
  const zoomAt = (sx, sy, f, v = cur()) => {
    const c = dataAt(v, sx, sy);
    return limit({ x0: c.x - (c.x - v.x0) * f, x1: c.x + (v.x1 - c.x) * f, y0: c.y - (c.y - v.y0) * f, y1: c.y + (v.y1 - c.y) * f });
  };
  // Ease from the current window to `target` (null = fit).
  const glide = (target) => {
    cancelAnimationFrame(glideFrame.current);
    const from = cur(), to = target ?? fit, t0 = performance.now();
    moving.current = true;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / GLIDE_MS), e = 1 - (1 - k) ** 3;
      viewRef.current = k < 1 ? Object.fromEntries(KEYS.map((q) => [q, from[q] + (to[q] - from[q]) * e])) : target;
      if (k < 1) glideFrame.current = requestAnimationFrame(step); else moving.current = false;
      repaint();
    };
    glideFrame.current = requestAnimationFrame(step);
  };

  const local = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  };
  const d = cur();
  const px = (v) => M.left + ((v - d.x0) / (d.x1 - d.x0)) * IW;
  const py = (v) => M.top + IH - ((v - d.y0) / (d.y1 - d.y0)) * IH;
  const inView = pts.filter((r) => r.x >= d.x0 && r.x <= d.x1 && r.y >= d.y0 && r.y <= d.y1);
  // The dot nearest a screen point, if one is within reach (null if none).
  const nearest = (pt) => {
    let best = null, dist = TAP_REACH;
    for (const r of inView) {
      const g = Math.hypot(px(r.x) - pt.x, py(r.y) - pt.y);
      if (g < dist) { best = r.p; dist = g; }
    }
    return best;
  };

  // Ctrl/⌘ + scroll (and trackpad pinch, which arrives as Ctrl + wheel) zooms at
  // the cursor; plain scrolling still scrolls the page.
  useEffect(() => {
    const el = svgRef.current;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      cancelAnimationFrame(glideFrame.current);
      const pt = local(e);
      moving.current = true;
      setView(zoomAt(pt.x, pt.y, Math.exp(clamp(e.deltaY, -50, 50) * 0.01)));
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(settle, 160);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    cancelAnimationFrame(glideFrame.current);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const pt = local(e);
    pointers.current.set(e.pointerId, pt);
    if (pointers.current.size === 1) {
      gesture.current = { kind: "press", type: e.pointerType, start: pt, view: cur() };
    } else if (pointers.current.size === 2) { // pinch: the point under the fingers stays under them
      const [a, b] = [...pointers.current.values()], v = cur();
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gesture.current = { kind: "pinch", view: v, at: dataAt(v, mid.x, mid.y), dist: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1) };
      boxRef.current = null;
      moving.current = true;
      paint();
    }
  };
  const onMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    const pt = local(e);
    pointers.current.set(e.pointerId, pt);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, f = g.dist / Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
      const sx = (g.view.x1 - g.view.x0) * f, sy = (g.view.y1 - g.view.y0) * f;
      const x0 = g.at.x - ((mid.x - M.left) / IW) * sx, y0 = g.at.y - ((M.top + IH - mid.y) / IH) * sy;
      setView(limit({ x0, x1: x0 + sx, y0, y1: y0 + sy }));
      return;
    }
    if (g.kind === "press" && Math.hypot(pt.x - g.start.x, pt.y - g.start.y) > (DRAG_MIN[g.type] ?? 6)) {
      g.kind = tool;
      moving.current = true;
    }
    if (g.kind === "pan") {
      const v = g.view, dx = ((pt.x - g.start.x) / IW) * (v.x1 - v.x0), dy = ((pt.y - g.start.y) / IH) * (v.y1 - v.y0);
      setView(limit({ x0: v.x0 - dx, x1: v.x1 - dx, y0: v.y0 + dy, y1: v.y1 + dy }));
    } else if (g.kind === "box") {
      boxRef.current = { a: g.start, b: { x: clamp(pt.x, M.left, M.left + IW), y: clamp(pt.y, M.top, M.top + IH) } };
      paint();
    }
  };
  const onUp = (e) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current, box = boxRef.current;
    boxRef.current = null;
    if (g?.kind === "press" && e.type === "pointerup") setSel(nearest(local(e)));
    if (g?.kind === "box" && box && Math.abs(box.a.x - box.b.x) > 8 && Math.abs(box.a.y - box.b.y) > 8) {
      const v = cur(), lo = dataAt(v, Math.min(box.a.x, box.b.x), Math.max(box.a.y, box.b.y));
      const hi = dataAt(v, Math.max(box.a.x, box.b.x), Math.min(box.a.y, box.b.y));
      glide(limit({ x0: lo.x, x1: hi.x, y0: lo.y, y1: hi.y }));
    } else if (!pointers.current.size) settle();
    // A finger still down after a pinch waits to lift: no tap, no pan.
    gesture.current = pointers.current.size ? { kind: "done" } : null;
    paint();
  };

  // With a curve on, that position's players far below it fade; those on it are named.
  const curveOf = Object.fromEntries(curves.map((c) => [c.pos, c]));
  const nearSet = new Set(curves.flatMap((c) => c.near.map((r) => r.p)));
  const faded = (p) => curveOf[p.position] && !nearSet.has(p);
  const named = new Set(curves.flatMap((c) => c.hull.map((q) => q.p)));

  // Names that fit without overlapping: curve players always, then the tapped
  // player, your squad and the highest on the y axis. Zooming in spreads the
  // dots, so more fit. While the chart moves, the same names ride along with
  // their dots and are re-placed once it stops (no flicker mid-gesture).
  const labelled = useRef(new Set());
  const gapX = 6, font = LABEL_PX;
  const place = (r) => {
    const cx = px(r.x), cy = py(r.y), w = r.p.player_name.length * font * 0.56;
    const left = cx + gapX + w > M.left + IW; // runs off the right edge: name on the left
    const x0 = left ? cx - gapX - w : cx + gapX;
    return { r, x: left ? cx - gapX : cx + gapX, y: cy + font * 0.35, left, box: { x0, x1: x0 + w, y0: cy - font * 0.6, y1: cy + font * 0.6 } };
  };
  let labels;
  if (moving.current) {
    labels = inView.filter((r) => named.has(r.p) || (names && labelled.current.has(r.p))).map(place);
  } else {
    const rank = (p) => (p === sel ? 2 : placedIds.has(p.player_id) ? 1 : 0);
    const order = [...inView.filter((r) => named.has(r.p)), ...(names ? inView.filter((r) => !named.has(r.p) && !faded(r.p))
      .sort((a, b) => rank(b.p) - rank(a.p) || b.y - a.y) : [])];
    labels = [];
    for (const r of order) {
      const l = place(r), b = l.box;
      if (!named.has(r.p) && labels.some(({ box: o }) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue;
      labels.push(l);
    }
    labelled.current = new Set(labels.map((l) => l.r.p));
  }

  // The tapped player's season: deadline by deadline on these axes, ending at his dot today.
  const hist = useSeasonHistory(!!sel);
  const rows = useMemo(() => (sel ? seasonRows(hist, sel) : []), [hist, sel]);
  const canPath = !!(PATH_METRICS[xk] && PATH_METRICS[yk]);
  const path = showPath && canPath && rows.length ? [
    ...rows.map(({ gw, row, f }) => ({ gw, x: PATH_METRICS[xk](row, f), y: PATH_METRICS[yk](row, f) })),
    { gw: null, x: xm.get(sel, recency), y: ym.get(sel, recency) },
  ] : null;

  // Showing a path (or tapping someone else with paths on) glides to frame his whole route.
  const pathKey = path && `${sel.player_id}-${xk}-${yk}`;
  useEffect(() => {
    if (!path) return;
    const xs = path.map((q) => q.x), ys = path.map((q) => q.y);
    const padX = Math.max((Math.max(...xs) - Math.min(...xs)) * 0.3, (fit.x1 - fit.x0) * 0.04);
    const padY = Math.max((Math.max(...ys) - Math.min(...ys)) * 0.3, (fit.y1 - fit.y0) * 0.04);
    glide(limit({ x0: Math.min(...xs) - padX, x1: Math.max(...xs) + padX, y0: Math.min(...ys) - padY, y1: Math.max(...ys) + padY }));
  }, [pathKey]); // only when the route itself changes, not on every frame

  const r0 = small ? 4 : 5;
  const xt = ticks(d.x0, d.x1, small ? 4 : 7), yt = ticks(d.y0, d.y1, small ? 5 : 6);
  const box = boxRef.current;
  const help = coarse
    ? `Tap a dot for details · ${tool === "box" ? "drag to zoom into an area" : "drag to move"} · pinch to zoom`
    : `Click a dot for details · ${tool === "box" ? "drag a box to zoom in" : "drag to move"} · Ctrl/⌘ + scroll to zoom · double-click to reset`;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div className="chart-tools">
        <Segmented value={tool} onChange={setTool}
          options={[{ value: "box", label: "⬚ Zoom to area" }, { value: "pan", label: "✥ Pan" }]} />
        <div className="ct-zoom" role="group" aria-label="Zoom">
          <button type="button" className="btn sm" onClick={() => glide(zoomAt(M.left + IW / 2, M.top + IH / 2, ZOOM_STEP))}
            disabled={!viewRef.current} aria-label="Zoom out">−</button>
          <button type="button" className="btn sm" onClick={() => glide(zoomAt(M.left + IW / 2, M.top + IH / 2, 1 / ZOOM_STEP))} aria-label="Zoom in">+</button>
          <button type="button" className="btn sm ghost" onClick={() => glide(null)} disabled={!viewRef.current}>Reset</button>
        </div>
        <button type="button" className={`chip ct-names ${names ? "on" : ""}`} aria-pressed={names} onClick={() => setNames((v) => !v)}>Names</button>
      </div>
      <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
        className={`chart tool-${tool} ${gesture.current?.kind === "pan" ? "panning" : ""} ${path ? "tracing" : ""}`}
        role="img" aria-label={`${ym.label} against ${xm.label}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={(e) => { if (!nearest(local(e))) glide(null); }}>
        <defs><clipPath id="plot-area"><rect x={M.left} y={M.top} width={IW} height={IH} /></clipPath></defs>
        {yt.map((t) => (
          <g key={`y${t}`}>
            <line x1={M.left} x2={W - M.right} y1={py(t)} y2={py(t)} className="grid" />
            <text x={M.left - 8} y={py(t)} className="tick" textAnchor="end" dominantBaseline="middle">{tickLabel(ym, t, yt[1] - yt[0] || 1)}</text>
          </g>
        ))}
        {xt.map((t) => (
          <g key={`x${t}`}>
            <line x1={px(t)} x2={px(t)} y1={M.top} y2={H - M.bottom} className="grid" />
            <text x={px(t)} y={H - M.bottom + 18} className="tick" textAnchor="middle">{tickLabel(xm, t, xt[1] - xt[0] || 1)}</text>
          </g>
        ))}
        <text x={M.left + IW / 2} y={H - 6} className="axis-title" textAnchor="middle">{xm.label}</text>
        <text x={-(M.top + IH / 2)} y={13} className="axis-title" textAnchor="middle" transform="rotate(-90)">{ym.label}</text>
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
        {inView.map(({ p, x, y }) => (
          <circle key={p.player_id} cx={px(x)} cy={py(y)}
            r={placedIds.has(p.player_id) ? r0 + 2 : r0} fill={POS_COLOR[p.position]}
            className={`dot ${placedIds.has(p.player_id) ? "picked" : ""} ${hover?.p === p || sel === p ? "hot" : ""} ${faded(p) ? "faded" : ""}`}
            onPointerMove={(e) => e.pointerType === "mouse" && !gesture.current?.kind?.match(/pan|box/) && setHover({ p, x: e.clientX, y: e.clientY })}
            onPointerLeave={() => setHover(null)} />
        ))}
        {path && (
          <g className="spath" style={{ "--pos": POS_COLOR[sel.position] }}>
            <polyline points={path.map((q) => `${px(q.x)},${py(q.y)}`).join(" ")} />
            {path.slice(0, -1).map((q, i) => (
              <g key={q.gw}>
                <circle cx={px(q.x)} cy={py(q.y)} r={i ? 3 : 4.5} />
                <text x={px(q.x)} y={py(q.y) - 9} textAnchor="middle">{i ? q.gw : `GW${q.gw}`}</text>
              </g>
            ))}
          </g>
        )}
        {labels.map(({ r, x, y, left }) => (
          <text key={r.p.player_id} x={x} y={y} textAnchor={left ? "end" : "start"}
            className={`vlabel ${named.has(r.p) ? "" : "small"}`}>{r.p.player_name}</text>
        ))}
        </g>
        {box && <rect className="zoom-box" x={Math.min(box.a.x, box.b.x)} y={Math.min(box.a.y, box.b.y)}
          width={Math.abs(box.a.x - box.b.x)} height={Math.abs(box.a.y - box.b.y)} />}
      </svg>
      <div className="legend">
        {POSITIONS.map((p) => <span key={p}><i style={{ background: POS_COLOR[p] }} />{p}</span>)}
        <span className="legend-note">{inView.length} of {pts.length} in view</span>
      </div>
      <small className="chart-help">{help}</small>
      {sel && <DotCard p={sel} recency={recency} picked={placedIds.has(sel.player_id)} onPick={onPick}
        gap={curveOf[sel.position]?.gap({ x: sel.price, y: ym.get(sel, recency) })} rows={rows}
        path={{ on: showPath, ok: canPath, toggle: () => setShowPath((v) => !v) }}
        onClose={() => setSel(null)} />}
      {hover && hover.p !== sel && (
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

// A tapped dot's player at a glance: projection, minutes, fixtures, and the
// button to add or drop him. It floats over the page (bottom corner; a sheet on
// phones), rendered on <body> because the animated cards would pin it inside them.
function DotCard({ p, recency, picked, onPick, gap, rows, path, onClose }) {
  const stats = [
    ["Next GW", `${adjPoints(p, recency).toFixed(1)} pts`],
    ["Per GW, next 3", `${adjPoints(p, recency, true).toFixed(1)} pts`],
    ["Plays next", `${Math.round((p.start_prob ?? 0) * 100)}%`],
    ["Owned by", `${(p.selected_by_percent ?? 0).toFixed(1)}%`],
  ];
  return createPortal(
    <div className="dot-card card" style={{ "--pos": POS_COLOR[p.position] }} role="dialog" aria-label={p.player_name}>
      <div className="dc-head">
        <Shirt teamId={p.team_id} gk={p.position === "GK"} size={40} />
        <div><b>{p.player_name}</b><small>{p.team} · {POS_NAME[p.position]} · £{p.price.toFixed(1)}m</small></div>
        <button type="button" className="dc-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {p.status !== "a" && p.news && <div className={`pd-news ${p.status === "d" ? "doubt" : "out"}`}>{p.news}</div>}
      <dl className="dc-stats">{stats.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <div className="dc-fx"><span>Next 5</span><NextFixtures teamId={p.team_id} n={5} /></div>
      <Season p={p} rows={rows} path={path} />
      <div className="dc-foot">
        {gap != null && <small className={gap < 0.05 ? "on" : ""}>{gap < 0.05 ? "On the value curve" : `${gap.toFixed(1)} pts below the value curve`}</small>}
        <button type="button" className={`btn sm ${picked ? "ghost" : "primary"}`} onClick={() => onPick(p)}>
          {picked ? "Remove from squad" : "Add to squad"}</button>
      </div>
    </div>,
    document.body,
  );
}

// How the player has moved since the season began: price since GW1, and the
// model's expected points from the first saved deadline to now, plus the
// toggle that draws that route on the chart.
function Season({ p, rows, path }) {
  const start = Math.round((p.price - (p.cost_change_start ?? 0)) * 10) / 10, rise = p.price - start;
  const r1 = (v) => Math.round(v * 10) / 10; // changes from the rounded figures, so they add up on screen
  const first = rows[0], xpThen = first && r1(PATH_METRICS.points(first.row, first.f)), xpNow = r1(adjPoints(p, 0));
  const move = (d, unit) => (Math.abs(d) < 0.05 ? <em>no change</em>
    : <em className={d > 0 ? "up" : "down"}>{d > 0 ? "+" : "−"}{unit}{Math.abs(d).toFixed(1)}</em>);
  return (
    <div className="dc-season">
      <div><span>Price</span><b>£{start.toFixed(1)}m → £{p.price.toFixed(1)}m</b>{move(rise, "£")}<small>since GW1</small></div>
      {first && <div><span>Expected pts</span><b>{xpThen.toFixed(1)} → {xpNow.toFixed(1)}</b>{move(xpNow - xpThen, "")}<small>since GW{first.gw}</small></div>}
      <button type="button" className={`chip ${path.on && path.ok ? "on" : ""}`} aria-pressed={path.on} disabled={!path.ok || !rows.length}
        title={path.ok ? "Draw his route through the season on the chart" : "Set the axes to price, expected points or chance of playing"}
        onClick={path.toggle}>Season path</button>
      {!path.ok && <small className="dc-note">Season path works with price, expected points and chance of playing on the axes.</small>}
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

export default function Stats({ players, recency, placedIds, onPick, squad, bank, priceOf }) {
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
  const [limit, setLimit] = useState(25);
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
        {squad?.length === 15 && <CurveCheck squad={squad} players={players} bank={bank} priceOf={priceOf} recency={recency} />}
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
          <button className="btn ghost block" onClick={() => setLimit((l) => l + 25)}>
            Show more ({table.length - limit} left)
          </button>
        )}
      </section>

      <Insights players={shown} recency={recency} placedIds={placedIds} />
    </div>
  );
}
