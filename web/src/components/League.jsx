import React, { useEffect, useMemo, useState } from "react";
import { adjPoints } from "../lib.js";
import { fetchLeague } from "../fpl.js";

// Your mini-league: where you stand, and (where FPL serves rivals' squads) who
// the nearest rivals own and captain. A player most rivals own and you don't
// costs you ground every time he scores; one you own and few of them do gains
// it. Rival squads are as of the last deadline: new ones go public at the next.
export default function League({ team, squad, players, captain, recency }) {
  const [leagueId, setLeagueId] = useState(team.leagues[0]?.id);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!leagueId) return undefined;
    let live = true;
    setData(null); setError(null);
    fetchLeague(leagueId, team.id, team.gw)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(`Couldn't load the league: ${e.message}.`));
    return () => { live = false; };
  }, [leagueId, team.id, team.gw]);

  const view = useMemo(() => {
    if (!data) return null;
    const seen = data.rivals.filter((r) => r.picks);
    const owned = {}, armband = {};
    for (const r of seen) for (const pk of r.picks) {
      owned[pk.element] = (owned[pk.element] ?? 0) + 1;
      if (pk.is_captain) armband[pk.element] = (armband[pk.element] ?? 0) + 1;
    }
    const mine = new Set(squad.map((p) => p.player_id));
    const xp = (p) => adjPoints(p, recency);
    // Ground at stake next week: expected points x the share of rivals on the other side.
    const missing = players.filter((p) => !mine.has(p.player_id) && owned[p.player_id])
      .map((p) => ({ p, n: owned[p.player_id], stake: xp(p) * owned[p.player_id] / seen.length }))
      .sort((a, b) => b.stake - a.stake).slice(0, 3);
    const yours = squad.map((p) => ({ p, n: owned[p.player_id] ?? 0, stake: xp(p) * (1 - (owned[p.player_id] ?? 0) / seen.length) }))
      .sort((a, b) => b.stake - a.stake).slice(0, 3);
    return { seen: seen.length, missing, yours, captained: captain ? armband[captain.player_id] ?? 0 : null };
  }, [data, squad, players, captain, recency]);

  if (!team.leagues.length) return null;
  const me = data?.standings.find((r) => r.entry === team.id);
  const above = me && data.standings.find((r) => r.rank === me.rank - 1);
  const below = me && data.standings.find((r) => r.rank === me.rank + 1);
  return (
    <section className="card tw-card">
      <div className="card-head">
        <h2>Mini-league</h2>
        {team.leagues.length > 1 && (
          <select className="lg-select" value={leagueId} onChange={(e) => setLeagueId(Number(e.target.value))}>
            {team.leagues.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>
      {error ? <p className="tw-line">{error}</p> : !data ? <p className="tw-line faint">Loading the league…</p> : (
        <>
          <p className="tw-line">
            {me ? <><b>{ordinal(me.rank)}</b> of {data.standings.length}{data.standings.length >= 50 ? "+" : ""} in {team.leagues.find((l) => l.id === leagueId)?.name}
              {above ? `, ${above.total - me.total} pts behind ${above.entry_name}` : below ? `, ${me.total - below.total} pts clear of ${below.entry_name}` : ""}.</>
              : "You're outside this league's top 50."}
          </p>
          {view.seen === 0 ? (
            <p className="tw-line faint">FPL doesn't share rivals' squads with this hosted site. Run the app yourself to
              see who your rivals own and captain.</p>
          ) : (
            <>
              <p className="tw-line">Of {view.seen === 1 ? "your nearest rival's squad" : `your ${view.seen} nearest rivals' squads`} (GW{team.gw}):
                {captain && <> {view.captained} captained {captain.player_name}.</>}</p>
              <ul className="lg-list">
                {view.missing.map(({ p, n }) => (
                  <li key={p.player_id} className="down"><span>{p.player_name}</span><small>{n} of {view.seen} own him, you don't · {adjPoints(p, recency).toFixed(1)} xP</small></li>
                ))}
                {view.yours.map(({ p, n }) => (
                  <li key={p.player_id} className="up"><span>{p.player_name}</span><small>yours, {n} of {view.seen} own him · {adjPoints(p, recency).toFixed(1)} xP</small></li>
                ))}
              </ul>
              <small className="hint">Pink: they own, you don't. Green: your differentials.</small>
            </>
          )}
        </>
      )}
    </section>
  );
}

const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th"}`;
