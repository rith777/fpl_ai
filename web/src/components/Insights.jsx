import React, { useContext, useMemo } from "react";
import { POS_COLOR, isNailed, fairShareOwnership } from "../lib.js";
import { expectedPoints, horizon } from "../transfers.js";
import { Badge, NextFixtures, Shirt, TeamsContext } from "./ui.jsx";

const attacker = (p) => p.position === "MID" || p.position === "FWD";
const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
const k = (n) => `${(Math.abs(n) / 1000).toFixed(0)}k`;
const top = (list, key, n = 5) => [...list].sort((a, b) => key(b) - key(a)).slice(0, n);

// Percentile rank (0-1) of each player's value of `get` within `pool`.
function ranks(pool, get) {
  const sorted = pool.map(get).sort((a, b) => a - b);
  return (p) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < get(p)) lo = mid + 1; else hi = mid; }
    return sorted.length ? lo / sorted.length : 0;
  };
}

// Each insight: a title, one line on why it matters, and up to five players
// with a reason. Lists are rankings over the players the filters leave in
// view, not cutoffs, so they always show the strongest examples there are.
function buildInsights(players, recency, teams) {
  const xp = (p) => expectedPoints(p, recency);
  const regulars = players.filter((p) => (p.start_prob ?? 0) >= 0.5);
  const fairShare = fairShareOwnership(players);
  const out = [];
  const add = (title, blurb, items) => items.length && out.push({ title, blurb, items });

  add("Best value for money", `Nailed players returning the most expected points per £m over the next ${horizon()} gameweeks.`,
    top(players.filter(isNailed), (p) => xp(p) / p.price).map((p) => ({
      p, why: `${(xp(p) / p.price).toFixed(2)} pts per £m at £${p.price.toFixed(1)}m, plays ${pct(p.start_prob)}.`,
    })));

  add("Differentials worth a look",
    `Owned by fewer managers than an even share (${fairShare.toFixed(1)}%) but projecting well: their points move you up the ranks.`,
    top(regulars.filter((p) => p.selected_by_percent < fairShare), xp).map((p) => ({
      p, why: `Only ${p.selected_by_percent.toFixed(1)}% own him; ${xp(p).toFixed(1)} expected pts a week.`,
    })));

  // Chances vs points: the biggest gaps between how much an attacker creates
  // (xGI rank) and how he's scoring lately (form rank), in either direction.
  const att = regulars.filter(attacker);
  const xgiRank = ranks(att, (p) => p.xgi_per_90 ?? 0);
  const formRank = ranks(att, (p) => p.form ?? 0);
  const gap = (p) => xgiRank(p) - formRank(p);
  add("Due a haul", "Creating more than their recent points show. Underlying numbers tend to win out.",
    top(att, gap).filter((p) => gap(p) > 0).map((p) => ({
      p, why: `xGI ${(p.xgi_per_90 ?? 0).toFixed(2)}/90 (top ${Math.ceil((1 - xgiRank(p)) * 100)}%) but form ${(p.form ?? 0).toFixed(1)}.`,
    })));
  add("Running hot", "Scoring above the chances they create. Enjoy it, but expect them to cool.",
    top(att, (p) => -gap(p)).filter((p) => gap(p) < 0).map((p) => ({
      p, why: `Form ${(p.form ?? 0).toFixed(1)} from ${(p.xgi_per_90 ?? 0).toFixed(2)} xGI/90.`,
    })));

  const byPrice = [...regulars].sort((a, b) => b.price - a.price);
  const premiums = byPrice.slice(0, Math.max(5, Math.ceil(byPrice.length / 10))); // priciest tenth
  add("Premium check", "The priciest tenth of regular starters, ranked by expected points: who's earning his price.",
    top(premiums, xp).map((p) => ({
      p, why: `${xp(p).toFixed(1)} expected pts a week at £${p.price.toFixed(1)}m (${(xp(p) / p.price).toFixed(2)} per £m).`,
    })));

  const net = (p) => p.net_transfers ?? 0;
  add("Price movers", "Most transferred in and out this gameweek: buy risers before they go up, sell fallers before they drop.",
    [...top(players.filter((p) => net(p) > 0), net, 3), ...top(players.filter((p) => net(p) < 0), (p) => -net(p), 2)].map((p) => ({
      p, why: net(p) > 0 ? `▲ ${k(net(p))} net transfers in: rise likely.` : `▼ ${k(net(p))} net transfers out: drop likely.`,
    })));

  // Ownership that won't be on the pitch: owned % x chance he doesn't play.
  const idle = (p) => (p.selected_by_percent ?? 0) * (1 - (p.start_prob ?? 0));
  add("Popular picks to worry about", "Where the most ownership meets the lowest chance of playing next week.",
    top(players, idle).filter((p) => idle(p) > 0).map((p) => ({
      p, why: `${p.selected_by_percent.toFixed(1)}% own him, but he plays only ${pct(p.start_prob)}${p.status !== "a" && p.news ? ` (${p.news})` : ""}.`,
    })));

  // Clubs whose players' fixtures help most over the horizon (the model's
  // fixture effect, averaged over their regulars), plus their best regular.
  const clubs = Object.values(teams)
    .map((t) => {
      const mine = regulars.filter((p) => p.team_id === t.id);
      const effect = mine.length ? mine.reduce((s, p) => s + (p.fixture_effect ?? 0), 0) / mine.length : -Infinity;
      return { t, effect, best: top(mine, xp, 1)[0] };
    })
    .filter((c) => c.best)
    .sort((a, b) => b.effect - a.effect)
    .slice(0, 4);
  if (clubs.length) out.push({
    title: "Fixture swings to target", blurb: `Clubs whose next ${horizon()} fixtures lift their players most, and their best regular.`,
    items: clubs.map(({ t, effect, best }) => ({
      p: best, club: t, why: `${t.name}'s fixtures are worth ${effect >= 0 ? "+" : "−"}${Math.abs(Math.round(effect * 100))}% to their regulars.`,
    })),
  });

  return out;
}

export default function Insights({ players, recency, placedIds }) {
  const teams = useContext(TeamsContext);
  const insights = useMemo(() => buildInsights(players, recency, teams), [players, recency, teams]);
  if (!insights.length) return null;
  return (
    <section className="card insights">
      <div className="card-head">
        <div>
          <h2>Assets to consider</h2>
          <p className="hint">Written from the numbers, for the players your filters leave in view.</p>
        </div>
      </div>
      <div className="insight-grid">
        {insights.map((ins, i) => (
          <article key={ins.title} className="insight" style={{ "--i": i }}>
            <h3>{ins.title}</h3>
            <p className="insight-blurb">{ins.blurb}</p>
            <ul>
              {ins.items.map(({ p, why, club }) => (
                <li key={p.player_id} style={{ "--pos": POS_COLOR[p.position] }}>
                  {club ? <Badge teamId={club.id} size={26} /> : <Shirt teamId={p.team_id} gk={p.position === "GK"} size={28} />}
                  <div>
                    <b>{p.player_name}{placedIds.has(p.player_id) && <span className="owned-tag">in squad</span>}</b>
                    <small>{p.team} · {p.position} · £{p.price.toFixed(1)}m</small>
                    <span className="why">{why}</span>
                    {club && <NextFixtures teamId={club.id} n={5} />}
                  </div>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
