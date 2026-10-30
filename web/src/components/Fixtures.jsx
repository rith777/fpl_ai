import React, { useContext, useMemo, useState } from "react";
import { Badge, Dropdown, FdrChip, Segmented, TeamsContext } from "./ui.jsx";

const SPANS = [3, 5, 6, 8].map((n) => ({ value: n, label: `Next ${n} GWs` }));
const SORTS = [
  { value: "easy", label: "Easiest run first" },
  { value: "hard", label: "Hardest run first" },
  { value: "name", label: "Club name" },
];

// Fixture difficulty grid (rows = clubs, columns = gameweeks), coloured like
// the FPL site. Double gameweeks stack two chips; blanks show a dash.
export default function Fixtures({ currentGw, squad }) {
  const teams = useContext(TeamsContext);
  const [span, setSpan] = useState(5);
  const [sort, setSort] = useState("easy");
  const [scope, setScope] = useState("all");

  const owned = useMemo(() => {
    const c = {};
    for (const p of squad) c[p.team_id] = (c[p.team_id] || 0) + 1;
    return c;
  }, [squad]);

  const firstGw = useMemo(() => {
    const gws = Object.values(teams).flatMap((t) => t.fixtures.map((f) => f.gw));
    return gws.length ? Math.min(...gws) : (currentGw ?? 0) + 1;
  }, [teams, currentGw]);
  const gws = Array.from({ length: span }, (_, i) => firstGw + i);

  const rows = useMemo(() => {
    const list = Object.values(teams)
      .filter((t) => scope === "all" || owned[t.id])
      .map((t) => {
        const inSpan = t.fixtures.filter((f) => f.gw < firstGw + span);
        const avg = inSpan.length ? inSpan.reduce((s, f) => s + f.fdr, 0) / inSpan.length : null;
        return { team: t, avg, byGw: Object.fromEntries(gws.map((g) => [g, t.fixtures.filter((f) => f.gw === g)])) };
      });
    const cmp = {
      easy: (a, b) => (a.avg ?? 9) - (b.avg ?? 9),
      hard: (a, b) => (b.avg ?? 0) - (a.avg ?? 0),
      name: (a, b) => a.team.name.localeCompare(b.team.name),
    }[sort];
    return list.sort(cmp);
  }, [teams, scope, owned, firstGw, span, sort]);

  return (
    <div className="fixtures-page">
      <section className="card">
        <div className="card-head wrap">
          <div>
            <h2>Fixture difficulty</h2>
            <p className="hint">Ratings use opponents' FPL strength at the venue, plus a small away penalty.</p>
          </div>
          <div className="fx-controls">
            <Segmented value={scope} onChange={setScope}
              options={[{ value: "all", label: "All clubs" }, { value: "mine", label: "My clubs" }]} />
            <Dropdown value={span} options={SPANS} onChange={setSpan} align="right" />
            <Dropdown value={sort} options={SORTS} onChange={setSort} align="right" />
          </div>
        </div>

        <div className="fdr-legend" aria-label="Difficulty key">
          <span>Easier</span>
          {[1, 2, 3, 4, 5].map((n) => <i key={n} className={`fdr fdr-${n}`}>{n}</i>)}
          <span>Harder</span>
        </div>

        <div className="table-scroll">
          <table className="fx-table">
            <thead>
              <tr>
                <th className="left">Club</th>
                {gws.map((g) => <th key={g}>GW{g}</th>)}
                <th>Avg</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ team, avg, byGw }, i) => (
                <tr key={team.id} className={owned[team.id] ? "mine" : ""} style={{ "--i": Math.min(i, 20) }}>
                  <td className="left">
                    <span className="fx-club">
                      <Badge teamId={team.id} size={22} />
                      <span>{team.name}</span>
                      {owned[team.id] && <em title={`${owned[team.id]} of your players`}>{owned[team.id]}</em>}
                    </span>
                  </td>
                  {gws.map((g) => (
                    <td key={g}>
                      <span className="fx-cell">
                        {byGw[g].length ? byGw[g].map((f, k) => <FdrChip key={k} fx={f} />) : <span className="blank">–</span>}
                      </span>
                    </td>
                  ))}
                  <td className="avg">{avg != null ? avg.toFixed(2) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {scope === "mine" && !rows.length && <p className="empty">Pick or load a squad to see your clubs' fixtures.</p>}
      </section>
    </div>
  );
}
