import React, { useEffect, useRef, useState } from "react";
import { CHIP_NAMES } from "../rules.js";
import { Beta, useOutside } from "./ui.jsx";

// Nav tabs; `also` lists the routes a tab covers (My Team's Pick / Transfers
// modes); `beta` marks pages still in development; `guide` pages (reading,
// not tools) sit apart at the end.
export const PAGES = [
  { id: "home", label: "This week" },
  { id: "team", label: "My Team", also: ["transfers"] },
  { id: "stats", label: "Statistics" },
  { id: "fixtures", label: "Fixtures" },
  { id: "plan", label: "Squad plan", beta: true },
  { id: "history", label: "History", beta: true },
  { id: "strategy", label: "Strategy", beta: true },
  { id: "start", label: "New to FPL", guide: true },
  { id: "about", label: "About", guide: true },
];

export const recencyLabel = (r) => (r === 0 ? "Season" : r === 1 ? "Form" : `${Math.round(r * 100)}% form`);

// Team ID form, used by the header menu and the Transfers page. Focusing the
// box (or its ▾) opens a dropdown of recently loaded teams; typing digits
// filters it. `exclude` hides the team that's already loaded.
export function TeamLoader({ initialId = "", loading, onLoad, recent, exclude }) {
  const [id, setId] = useState(initialId);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const options = (recent?.teams ?? []).filter((t) => t.id !== exclude && (!id || String(t.id).includes(id)));
  const load = (value) => { setOpen(false); if (value) onLoad(value); };
  return (
    <form className="team-loader" ref={ref} onSubmit={(e) => { e.preventDefault(); load(id); }}>
      <div className="tl-field">
        <input inputMode="numeric" placeholder="Your FPL team ID" aria-label="FPL team ID" value={id}
          autoComplete="off" onFocus={() => setOpen(true)}
          onChange={(e) => { setId(e.target.value.replace(/\D/g, "")); setOpen(true); }} />
        {recent?.teams.length > 0 && (
          <button type="button" className="tl-toggle" aria-label="Recent teams" aria-expanded={open}
            onClick={() => setOpen((o) => !o)}>▾</button>
        )}
        {open && options.length > 0 && (
          <ul className="dd-menu tl-menu" role="listbox" aria-label="Recent teams">
            <li className="tl-head">Recent teams</li>
            {options.map((t) => (
              <li key={t.id} className="tl-item">
                <button type="button" role="option" onClick={() => { setId(String(t.id)); load(String(t.id)); }}>
                  <span className="tl-name"><b>{t.name}</b><small>{t.manager} · #{t.id}</small></span>
                </button>
                <button type="button" className="tl-forget" aria-label={`Forget ${t.name}`} title="Remove from recent"
                  onClick={() => recent.forget(t.id)}>×</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button className="btn primary" type="submit" disabled={!id || loading}>
        {loading ? "Loading…" : "Load"}
      </button>
    </form>
  );
}

export default function Header({ page, recency, setRecency, team, teamLoading, savedTeamId, onLoad, onUnload, recent }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  // Phones: pages and the projection blend live behind a menu button.
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const close = () => setMenu(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);

  return (
    <header className={`topbar ${menu ? "open" : ""}`}>
      <div className="topbar-inner">
        <a className="brand" href="#/home" aria-label="FPL AI home">
          <span className="brand-mark" aria-hidden>◆</span>
          <span>FPL <b>AI</b></span>
        </a>

        <nav className="nav" aria-label="Pages">
          {PAGES.map((p) => {
            const on = page === p.id || p.also?.includes(page);
            return <a key={p.id} href={`#/${p.id}`} className={[on && "active", p.guide && "guide"].filter(Boolean).join(" ")} aria-current={on ? "page" : undefined}>{p.label}{p.beta && <Beta />}</a>;
          })}
        </nav>

        <div className="topbar-right">
          <label className="projection" title="How much projections lean on recent form vs. the season-long model">
            <span className="projection-head">Projection <b>{recencyLabel(recency)}</b></span>
            <input type="range" min="0" max="1" step="0.05" value={recency}
              onChange={(e) => setRecency(parseFloat(e.target.value))} />
          </label>

          <div className="team-menu" ref={ref}>
            <button type="button" className={`team-chip ${team ? "loaded" : ""}`} onClick={() => setOpen((o) => !o)}
              aria-expanded={open}>
              {team ? (
                <>
                  <span className="team-dot" aria-hidden />
                  <span className="team-chip-text"><b>{team.name}</b><small>OR {team.rank?.toLocaleString()}</small></span>
                </>
              ) : <b>Load my team</b>}
              <span className="caret" aria-hidden>▾</span>
            </button>

            {open && (
              <div className="popover right">
                {team ? (
                  <>
                    <div className="popover-title">{team.name}</div>
                    <div className="popover-sub">{team.manager} · GW{team.gw}</div>
                    <dl className="kv">
                      <div><dt>Overall rank</dt><dd>{team.rank?.toLocaleString()}</dd></div>
                      <div><dt>Bank</dt><dd>£{team.bank.toFixed(1)}m</dd></div>
                      <div><dt>Free transfers</dt><dd>{team.ft}</dd></div>
                      <div><dt>Chips used</dt><dd>{team.chipsUsed.length ? team.chipsUsed.map((c) => `${CHIP_NAMES[c.name] ?? c.name} (GW${c.event})`).join(", ") : "None"}</dd></div>
                    </dl>
                    <div className="popover-actions">
                      <button className="btn sm" onClick={() => onLoad(team.id)} disabled={teamLoading}>
                        {teamLoading ? "Loading…" : "Reload"}
                      </button>
                      <button className="btn sm ghost" onClick={() => { onUnload(); setOpen(false); }}>Unload</button>
                    </div>
                    <div className="popover-sub switch">Load a different team</div>
                    <TeamLoader loading={teamLoading} recent={recent} exclude={team.id}
                      onLoad={async (id) => { await onLoad(id); setOpen(false); }} />
                  </>
                ) : (
                  <>
                    <div className="popover-title">Load your FPL team</div>
                    <div className="popover-sub">Your team ID is the number after <code>/entry/</code> in your FPL URL.</div>
                    <TeamLoader initialId={savedTeamId} loading={teamLoading} recent={recent}
                      onLoad={async (id) => { await onLoad(id); setOpen(false); }} />
                  </>
                )}
              </div>
            )}
          </div>
          <button type="button" className="menu-btn" aria-label={menu ? "Close menu" : "Menu"} aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}>{menu ? "✕" : "☰"}</button>
        </div>
      </div>
    </header>
  );
}
