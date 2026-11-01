import React, { useContext, useDeferredValue, useEffect, useMemo, useState } from "react";
import { POS_COLOR, POS_NAME, POSITIONS, fairShareOwnership } from "../lib.js";
import {
  HIT_COST, chipValues, horizon, model, moveVerdict, planCase, planGain as gainOf, planOptions, positionStats, rollCheck,
  sigmaGain, squadGain, transferPlan, upgradeTargets,
} from "../transfers.js";
import { CHIP_NAMES, chipsLeft } from "../rules.js";
import { TIMED_CHIPS, chooseChip } from "../strategy.js";
import { Beta, More, NextFixtures, Segmented, Shirt, TeamsContext } from "./ui.jsx";
import PlayerList from "./PlayerList.jsx";
import { TeamLoader } from "./Header.jsx";

const Side = ({ p, price, kind }) => (
  <div className={`mv-side ${kind}`}>
    <Shirt teamId={p.team_id} gk={p.position === "GK"} size={34} />
    <div><b>{p.player_name}</b><small>£{price.toFixed(1)} · {p.team}</small></div>
  </div>
);

// The case for a move side by side: what's for it, what's against it.
export function MoveCase({ pros = [], cons = [] }) {
  if (!pros.length && !cons.length) return null;
  const col = (list, cls, head) => (
    <div className={`mc-col ${cls}`}>
      <h5>{head}</h5>
      {list.length ? (
        <ul>{list.map((r, k) => (
          <li key={k} title={r.title}>{r.text}{r.detail && <small>{r.detail}</small>}</li>
        ))}</ul>
      ) : <p className="mc-none">Nothing notable</p>}
    </div>
  );
  return <div className="mv-case">{col(pros, "pro", "For")}{col(cons, "con", "Against")}</div>;
}

const Line = ({ m, priceOf }) => (
  <div className="mv-line">
    <Side p={m.out} price={priceOf(m.out)} kind="out" />
    <span className="mv-arrow" aria-hidden>→</span>
    <Side p={m.in} price={m.in.price} kind="in" />
  </div>
);

// A plan's case: one For / Against for a single move; with more, one per move
// and what goes with the plan as a whole (a hit, the margin of error).
export function PlanCase({ items, stats, fairShare, ctx }) {
  const c = useMemo(() => planCase(items, stats, fairShare, ctx), [items, stats, fairShare, ctx]);
  const moves = items.flatMap((it) => it.moves);
  return (
    <>
      {moves.length === 1 ? <MoveCase pros={c.moves[0].pros} cons={[...c.moves[0].cons, ...c.cons]} /> : <>
        {moves.map((m, k) => (
          <div key={m.out.player_id} className="mv-part">
            <h4>{m.out.player_name} → {m.in.player_name}</h4>
            <MoveCase {...c.moves[k]} />
          </div>
        ))}
        {c.cons.length > 0 && <ul className="mv-warn">{c.cons.map((r, k) => <li key={k}>{r.text}{r.detail && <small>{r.detail}</small>}</li>)}</ul>}
      </>}
      {c.notes.map((n) => <p key={n} className="mv-note">{n}</p>)}
    </>
  );
}

const sizeName = (n) => (n <= 4 ? `${["Double", "Triple", "Quadruple"][n - 2]} move` : `${n} moves`);

// A plan as one card: every move in it, the gain net of hits, and its case.
function PlanCard({ items, priceOf, stats, fairShare, ctx }) {
  const moves = items.flatMap((it) => it.moves);
  const hits = items.reduce((t, it) => t + it.hits, 0);
  return (
    <div className={`move ${moves.length > 1 ? "combo" : ""}`} style={{ "--pos": POS_COLOR[moves[0].in.position] }}>
      <div className="mv-top">
        <div className="mv-lines">
          {moves.length > 1 && (
            <span className="mv-combo">{sizeName(moves.length)}{items.some((it) => it.linked) ? " · one sale funds another" : ""}</span>
          )}
          {moves.map((m) => <Line key={m.out.player_id} m={m} priceOf={priceOf} />)}
        </div>
        <div className="mv-gain" title={`Expected points per gameweek over the next ${horizon()}, after hits`}>
          <b>{signed(gainOf(items))}</b><small>pts/GW</small>
          <em className={hits ? "hit" : "free"}>{tagFor(hits)}</em>
        </div>
      </div>
      <PlanCase items={items} stats={stats} fairShare={fairShare} ctx={ctx} />
      <div className="mv-fx">
        {moves.map((m) => (
          <span key={m.in.player_id}><b>{m.in.player_name}</b> <NextFixtures teamId={m.in.team_id} n={4} /></span>
        ))}
      </div>
    </div>
  );
}

export const tagFor = (hits) => (hits ? `−${hits * HIT_COST}` : "FREE");
const signed = (x) => `${Math.round(x * 10) >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;

// The moves you've made here (your squad now vs the one on FPL), judged from
// this deadline on like any suggestion: what they add per gameweek over the
// horizon after hits, against the best plan for the same free transfers, each
// move on its own with its reasons.
function YourMoves({ team, squad, players, priceOf, recency, freeTransfers, stats, fairShare }) {
  const result = useMemo(() => {
    const byId = Object.fromEntries(players.map((p) => [p.player_id, p]));
    const original = team.picks.map((p) => byId[p.id]).filter(Boolean);
    const now = new Set(squad.map((p) => p.player_id)), was = new Set(original.map((p) => p.player_id));
    const outs = original.filter((p) => !now.has(p.player_id)), ins = squad.filter((p) => !was.has(p.player_id));
    if (!outs.length || original.length !== 15 || squad.length !== 15) return null;
    const moves = POSITIONS.flatMap((pos) => {
      const o = outs.filter((p) => p.position === pos), n = ins.filter((p) => p.position === pos);
      return o.map((out, k) => ({ out, in: n[k], cost: n[k].price - priceOf(out) }));
    });
    const swapOne = (m) => original.map((p) => (p === m.out ? m.in : p));
    const hits = Math.max(0, moves.length - freeTransfers);
    const gain = squadGain(original, squad, recency, hits);
    const plan = transferPlan({ squad: original, players, bank: team.bank, priceOf, recency, freeTransfers });
    const best = gainOf(plan);
    return {
      moves: moves.map((m) => ({ ...m, gain: squadGain(original, swapOne(m), recency) })),
      hits, gain, best, plan, verdict: moveVerdict(gain, best),
      ctx: { squad: original, players, recency, bank: team.bank },
    };
  }, [team, squad, players, priceOf, recency, freeTransfers]);
  if (!result) return null;
  const { moves, hits, gain, best, plan, verdict, ctx } = result;
  const theirs = plan.flatMap((it) => it.moves);
  const same = theirs.length === moves.length && theirs.every((m) => moves.some((x) => x.out.player_id === m.out.player_id && x.in.player_id === m.in.player_id));
  return (
    <section className="card your-moves">
      <div className="card-head">
        <h2>Your planned moves</h2>
        <span className={`hx-verdict ${verdict.cls}`} title={verdict.why}>{verdict.label}</span>
      </div>
      <p className="ym-sum">
        <b>{signed(gain)} pts/GW</b>{hits ? ` after the −${hits * HIT_COST} hit` : ""} · best plan {signed(best)}
      </p>
      {moves.map((m) => (
        <PlanCard key={m.out.player_id} items={[{ moves: [m], gain: m.gain, hits: 0 }]} priceOf={priceOf}
          stats={stats} fairShare={fairShare} ctx={ctx} />
      ))}
      {!same && (
        <p className="ym-alt">Model's pick: {theirs.length ? `${theirs.map((m) => `${m.out.player_name} → ${m.in.player_name}`).join(", ")} (${signed(best)})` : "roll the transfer"}</p>
      )}
    </section>
  );
}


// Play a chip this week or hold it, by the timing rule the chip backtest
// chose (chips.json): its value now, the bar, and the best later week in view.
export function chipCall(name, squad, used, nextGw) {
  const policy = model().chipPolicy;
  if (!policy || squad.length !== 15 || !TIMED_CHIPS[name]) return null;
  const { chip, outlook } = chooseChip({ squad, gw: nextGw, used, policy, chips: [name] });
  const { key, sign } = TIMED_CHIPS[name];
  const later = outlook.slice(1).reduce((a, b) => (b && (!a || sign * b[key] > sign * a[key]) ? b : a), null);
  return { chip, key, sign, now: outlook[0]?.[key], bar: policy.bar?.[name], later };
}

// Chips left this half-season and, for the two whose worth is a points
// number under FPL's rules, what they'd add in each of the next gameweeks.
function ChipCall({ name, squad, used, nextGw }) {
  const call = chipCall(name, squad, used, nextGw);
  if (!call) return null;
  const { chip, key, sign, now, bar, later } = call;
  const fh = name === "freehit";
  const fmt = (v) => (fh ? v.toFixed(1) : `+${v.toFixed(1)}`);
  const parts = [`${fh ? "your XI projects" : "worth"} ${fmt(now)} now`];
  if (bar != null && model().chipPolicy.kind !== "first") parts.push(`the bar is ${fmt(bar)}`);
  if (later && sign * later[key] > sign * now) parts.push(`GW${later.gw} is a better week (${fmt(later[key])})`);
  return <p className={`chip-call ${chip ? "play" : "hold"}`}><b>{chip ? "Play it this week" : "Hold"}:</b> {parts.join(" · ")}</p>;
}

// Remaining gameweeks where your players have no match or two (FPL schedules
// blanks and doubles as cup dates are set): where the chips pay most.
function useBlanksAndDoubles(squad) {
  const teams = useContext(TeamsContext);
  return useMemo(() => {
    const gws = [...new Set(squad.flatMap((p) => Object.keys(teams[p.team_id]?.matches ?? {}).map(Number)))].sort((a, b) => a - b);
    return gws.map((gw) => {
      const n = (p) => teams[p.team_id]?.matches?.[gw] ?? 1;
      return { gw, blank: squad.filter((p) => n(p) === 0), double: squad.filter((p) => n(p) >= 2) };
    }).filter((w) => w.blank.length || w.double.length);
  }, [squad, teams]);
}

// What a Wildcard would add now: the best rebuild (every transfer free) over
// the horizon, against the best plan with the free transfers you have. When
// the chip backtest found a timing rule that held up (chips.json wildcard),
// the call is that rule's: play once the gap clears its bar.
function WildcardCheck({ squad, players, bank, priceOf, recency, freeTransfers, stop, nextGw }) {
  const [result, setResult] = useState(null);
  const check = () => {
    const ctx = { squad, players, bank, priceOf, recency };
    const rebuild = transferPlan({ ...ctx, freeTransfers: squad.length, keep: null });
    const normal = transferPlan({ ...ctx, freeTransfers });
    setResult({ rebuild: gainOf(rebuild), changes: rebuild.flatMap((it) => it.moves).length, normal: gainOf(normal) });
  };
  if (!result) return <button className="btn sm" onClick={check}>What would a Wildcard add now?</button>;
  const gap = result.rebuild - result.normal;
  const bar = model().chipBacktest?.wildcard?.chosen?.bar;
  const last = nextGw >= stop;
  const ruled = model().chipBacktest?.wildcard?.chosen;
  const play = last || (ruled ? bar != null && gap >= bar : gap > sigmaGain());
  const why = last ? "last week to use it" : !ruled ? (play ? "a real gap" : "inside the margin of error")
    : bar == null ? "the rule plays it at the end of its window" : `the rule plays it from a +${bar.toFixed(1)} gap`;
  return (
    <p className={`chip-call ${play ? "play" : "hold"}`}>
      <b>{play ? "Worth playing" : "Hold"}:</b> a rebuild adds {signed(result.rebuild)} pts/GW ({result.changes} changes)
      vs {signed(result.normal)} with your free transfers · {why}
    </p>
  );
}

function Chips({ squad, used, nextGw, players, bank, priceOf, recency, freeTransfers }) {
  const left = chipsLeft(used, nextGw);
  const weeks = useBlanksAndDoubles(squad);
  const values = useMemo(() => (squad.length === 15 ? chipValues(squad) : []), [squad]);
  if (!left.length) return null;
  const valueOf = { "3xc": (v) => v.tc, bboost: (v) => v.bb };
  return (
    <section className="card chips-card">
      <h2>Chips <Beta /></h2>
      <ul className="chip-list">
        {left.map((c) => {
          const open = nextGw >= c.start;
          const get = valueOf[c.name];
          const best = get && values.length ? values.reduce((a, b) => (get(b) > get(a) ? b : a)) : null;
          return (
            <li key={`${c.name}-${c.start}`} className={open ? "" : "later"}>
              <div className="chip-name">
                <b>{CHIP_NAMES[c.name] ?? c.name}</b>
                <small>{open ? `use by GW${c.stop} · ${c.stop - nextGw + 1} GWs left, then it's lost` : `from GW${c.start}`}</small>
              </div>
              {open && get && values.length > 0 && (
                <div className="chip-values">
                  {values.map((v) => (
                    <span key={v.gw} className={v === best ? "best" : ""}>GW{v.gw} <b>+{get(v).toFixed(1)}</b></span>
                  ))}
                </div>
              )}
              {open && <ChipCall name={c.name} squad={squad} used={used} nextGw={nextGw} />}
              {open && c.name === "wildcard" && squad.length === 15 && (
                <WildcardCheck squad={squad} players={players} bank={bank} priceOf={priceOf} recency={recency}
                  freeTransfers={freeTransfers} stop={c.stop} nextGw={nextGw} />
              )}
            </li>
          );
        })}
      </ul>
      <div className="chip-weeks">
        <b>Blanks and doubles for your squad</b>
        {weeks.length ? (
          <ul>{weeks.map((w) => (
            <li key={w.gw}>GW{w.gw}: {w.blank.length > 0 && `${w.blank.length} without a match (${w.blank.map((p) => p.player_name).join(", ")})`}
              {w.blank.length > 0 && w.double.length > 0 && "; "}
              {w.double.length > 0 && `${w.double.length} with two (${w.double.map((p) => p.player_name).join(", ")})`}
              {" "}→ {w.blank.length >= w.double.length ? "a Free Hit week" : "a Bench Boost / Triple Captain week"}</li>
          ))}</ul>
        ) : <small> None scheduled yet.</small>}
      </div>
      <More to="chips">How chips are called</More>
    </section>
  );
}

const POS_TABS = [{ value: "ALL", label: "All" }, ...POSITIONS.map((p) => ({ value: p, label: p, color: POS_COLOR[p] }))];

// One upgrade target: who comes in, who he replaces, the money it uses or
// frees, the gain, and Apply (affordable now) or the money still needed.
function Target({ t, i, priceOf, onApply }) {
  const { in: c, out: o, cost } = t.moves[0];
  const money = Math.abs(cost) < 0.05 ? "same price" : cost > 0 ? `uses £${cost.toFixed(1)}m` : `frees £${(-cost).toFixed(1)}m`;
  return (
    <div className="target" style={{ "--pos": POS_COLOR[c.position], "--i": i }}>
      <Shirt teamId={c.team_id} gk={c.position === "GK"} size={34} />
      <div className="tg-main">
        <b>{c.player_name}</b>
        <small>£{c.price.toFixed(1)}m · {c.team} <NextFixtures teamId={c.team_id} n={3} /></small>
        <small>
          for <b className="tg-out">{o.player_name}</b> (sells £{priceOf(o).toFixed(1)}m) ·{" "}
          <span className={cost > 0 ? "spend" : "save"}>{money}</span>
          {t.alt && <> · or for {t.alt.moves[0].out.player_name} (+{t.alt.gain.toFixed(1)})</>}
        </small>
      </div>
      <div className="tg-side">
        <b className="tg-gain">+{t.gain.toFixed(1)}</b>
        {t.need <= 1e-9
          ? <button className="btn sm" onClick={() => onApply(t.moves)}>Apply</button>
          : <span className="tg-need">£{t.need.toFixed(1)}m short</span>}
      </div>
    </div>
  );
}

// Upgrade targets by position, from the *current* squad and bank, so the list
// re-plans as soon as a move is applied.
function UpgradeTargets({ targets, bank, priceOf, onApply }) {
  const [pos, setPos] = useState("ALL");
  const all = POSITIONS.flatMap((p) => targets[p]);
  const top = (list) => list.reduce((a, b) => (!a || b.gain > a.gain ? b : a), null);
  const bestNow = top(all.filter((t) => t.need <= 1e-9));
  const upside = top(all.filter((t) => t.need > 1e-9 && t.gain > (bestNow?.gain ?? 0)));
  const label = (t) => `${t.moves[0].out.player_name} → ${t.moves[0].in.player_name}`;
  // "All": top 3 per position, positions with the biggest upside first.
  const ranked = [...POSITIONS].sort((a, b) => (targets[b][0]?.gain ?? 0) - (targets[a][0]?.gain ?? 0));
  const visible = (p) => targets[p].filter((t) => Math.round(t.gain * 10) > 0); // shows as at least +0.1
  const groups = pos === "ALL" ? ranked.map((p) => [p, visible(p).slice(0, 3)]) : [[pos, visible(pos).slice(0, 8)]];
  return (
    <section className="card">
      <div className="card-head"><h2>Upgrade targets</h2></div>
      <p className="up-summary">
        <b>£{bank.toFixed(1)}m</b> in the bank.{" "}
        {bestNow ? <>Best you can afford now: <b>{label(bestNow)}</b> (+{bestNow.gain.toFixed(1)}).</>
          : "Nothing affordable improves your team right now."}
        {upside && <> Biggest upside: <b>{label(upside)}</b> (+{upside.gain.toFixed(1)}), £{upside.need.toFixed(1)}m short.</>}
      </p>
      <Segmented value={pos} onChange={setPos} options={POS_TABS} className="full" />
      {groups.map(([p, list]) => (
        <div key={p} className="tg-group">
          {pos === "ALL" && <h3 className="tg-pos" style={{ "--pos": POS_COLOR[p] }}>{POS_NAME[p]}</h3>}
          {list.length
            ? list.map((t, i) => <Target key={t.moves[0].in.player_id} t={t} i={i} priceOf={priceOf} onApply={onApply} />)
            : <p className="empty">No {POS_NAME[p].toLowerCase()} within £5m of your budget would improve your team.</p>}
        </div>
      ))}
    </section>
  );
}

// Use the free transfer(s) or bank them, by the bar the strategy backtest set.
function RollCheck({ roll, moves }) {
  const g = `+${roll.gain.toFixed(1)} pts/GW`;
  const [cls, label, why] = roll.close ? ["roll", "Toss-up", `rolling banks a free transfer worth about +${roll.keep.toFixed(1)} pts`]
    : !roll.use ? ["roll", "Consider rolling", `${g} per transfer is under the +${roll.minGain.toFixed(2)} bar`]
    : roll.atCap && roll.gain < roll.minGain ? ["use", "Make the move", `you're at the cap of ${model().max_free_transfers} free transfers`]
    : roll.worth < moves ? ["use", "Make the move", `only the first ${roll.worth} clear the +${roll.minGain.toFixed(2)} bar: bank the rest`]
    : ["use", "Make the move", roll.minGain ? `${g} per transfer clears the +${roll.minGain.toFixed(2)} bar` : "any gain is worth a free transfer"];
  return <p className={`roll-check ${cls}`}><b>{label}:</b> {why}. <a href="#/about/transfers">Why?</a></p>;
}

export default function TransfersPanel({
  team, loading, onLoad, savedTeamId, recent, onUndoPending, onCommit,
  squad, players, bank, priceOf, recency, freeTransfers, setFreeTransfers, made, onApply,
  placedIds, onPick, listPos, setListPos,
}) {
  const [tab, setTab] = useState("plan");
  const nameOf = useMemo(() => Object.fromEntries(players.map((p) => [p.player_id, p.player_name])), [players]);
  const r = useDeferredValue(recency); // keep the slider smooth while plans recompute

  const ready = squad.length === 15;
  const ftLeft = Math.max(0, freeTransfers - made);
  const hits = Math.max(0, made - freeTransfers) * HIT_COST;
  const plan = useMemo(
    () => (ready && tab === "plan" ? transferPlan({ squad, players, bank, priceOf, recency: r, freeTransfers: ftLeft }) : []),
    [ready, tab, squad, players, bank, priceOf, r, ftLeft]);
  const targets = useMemo(
    () => (ready && tab === "upgrades" ? upgradeTargets({ squad, players, bank, priceOf, recency: r }) : null),
    [ready, tab, squad, players, bank, priceOf, r]);
  const roll = useMemo(
    () => rollCheck({ plan, freeTransfers: ftLeft, squad }), [plan, ftLeft, squad]);
  // Side by side with the model's pick: the best plan for each number of
  // moves, up to one past the free transfers (a −4 hit), in case you want it.
  const options = useMemo(
    () => (ready && tab === "plan" ? planOptions({ squad, players, bank, priceOf, recency: r, freeTransfers: ftLeft, upTo: ftLeft + 1 }) : []),
    [ready, tab, squad, players, bank, priceOf, r, ftLeft]);
  const [size, setSize] = useState(null); // moves in the plan shown; null: the model's pick
  useEffect(() => setSize(null), [ftLeft]);
  const count = (items) => items.reduce((t, it) => t + it.moves.length, 0);
  const pick = count(plan);
  const view = size ?? pick;
  const shown = view === pick ? plan : options[view - 1] ?? [];
  const stats = useMemo(() => positionStats(players), [players]);
  const fairShare = fairShareOwnership(players);
  const ctx = useMemo(() => ({ squad, players, recency: r, bank }), [squad, players, r, bank]);
  const bankAfter = bank - shown.reduce((t, it) => t + it.moves.reduce((s, m) => s + m.cost, 0), 0);

  return (
    <div className="tpanel">
      <section className="card tstatus">
        {team ? (
          <>
            <div className="tstatus-grid">
              <div className="stat">
                <span className="w-label">Free transfers</span>
                <div className="stepper">
                  <button aria-label="Fewer free transfers" onClick={() => setFreeTransfers(Math.max(0, freeTransfers - 1))}>−</button>
                  <b>{freeTransfers}</b>
                  <button aria-label="More free transfers" onClick={() => setFreeTransfers(Math.min(model().max_free_transfers ?? 5, freeTransfers + 1))}>+</button>
                </div>
              </div>
              <div className="stat"><span className="w-label">Bank</span><b>£{bank.toFixed(1)}m</b></div>
              <div className="stat">
                <span className="w-label">Planned</span>
                <b>{made}{hits > 0 && <em className="hit">−{hits}</em>}</b>
              </div>
            </div>
            {team.pending.length > 0 && (
              <p className="saved-moves">
                ✓ Saved GW{team.gw + 1} moves: {team.pending.map((t) => `${nameOf[t.out] ?? t.out} → ${nameOf[t.in] ?? t.in}`).join(", ")}
                {" "}<button className="link" onClick={onUndoPending} title="Clears every saved move for this gameweek">Undo all</button>
              </p>
            )}
            {made > 0 && (
              <button className="btn primary block" onClick={onCommit}
                title="Record these moves as done on the FPL site so every reload includes them">
                ✓ Save {made} move{made > 1 ? "s" : ""} as made on FPL
              </button>
            )}
            <p className="hint">
              {team.pending.length ? "Free transfers are saved with your moves." : "Free transfers are estimated from your history."}
              {" "}Adjust them if they're off.
            </p>
          </>
        ) : (
          <>
            <h2>Plan transfers for your real team</h2>
            <p className="hint">Load your FPL team to use its real bank, selling prices and free transfers.
              Without it, suggestions use the squad you've built here.</p>
            <TeamLoader initialId={savedTeamId} loading={loading} onLoad={onLoad} recent={recent} />
          </>
        )}
      </section>

      {team && <Chips squad={squad} used={team.chipsUsed} nextGw={team.gw + 1} players={players} bank={bank}
        priceOf={priceOf} recency={r} freeTransfers={ftLeft} />}

      <Segmented value={tab} onChange={setTab} className="full"
        options={[{ value: "plan", label: "Plan" }, { value: "upgrades", label: "Upgrades" }, { value: "players", label: "Players" }]} />

      {tab === "players" ? (
        <section className="card side-card">
          <PlayerList players={players} placedIds={placedIds} recency={recency} onPick={onPick}
            pos={listPos} setPos={setListPos} title="Buy players" />
        </section>
      ) : !ready ? (
        <section className="card empty-card">
          <p>Complete a 15-player squad, or load your team, to get suggestions.</p>
        </section>
      ) : tab === "upgrades" ? (
        <UpgradeTargets targets={targets} bank={bank} priceOf={priceOf} onApply={onApply} />
      ) : (
        <>
        {team && made > 0 && (
          <YourMoves team={team} squad={squad} players={players} priceOf={priceOf} recency={r}
            freeTransfers={freeTransfers} stats={stats} fairShare={fairShare} />
        )}
        <section className="card">
          <div className="card-head">
            <h2>Transfer plans</h2>
            {shown.length > 0 && (
              <button className="btn sm primary" onClick={() => onApply(shown.flatMap((it) => it.moves))}>Apply all</button>
            )}
          </div>
          <div className="plan-sizes">
            {pick === 0 && (
              <button className={view === 0 ? "on" : ""} onClick={() => setSize(0)}><b>Roll</b><small>model's pick</small></button>
            )}
            {options.map((o, k) => {
              const items = k + 1 === pick ? plan : o;
              const hit = items && items.reduce((t, it) => t + it.hits, 0) * HIT_COST;
              return items && (
                <button key={k} className={view === k + 1 ? "on" : ""} onClick={() => setSize(k + 1)}>
                  <b>{k + 1} move{k ? "s" : ""}{hit > 0 && <em className="hit">−{hit}</em>}</b>
                  <small>{signed(gainOf(items))} pts/GW{k + 1 === pick ? " · model's pick" : ""}</small>
                </button>
              );
            })}
          </div>
          {shown.length ? <PlanCard items={shown} priceOf={priceOf} stats={stats} fairShare={fairShare} ctx={ctx} />
            : <p className="empty">No move improves your team enough right now, so roll the transfer.</p>}
          {shown.length > 0 && (
            <p className="plan-foot">≈ {signed(gainOf(shown))} pts/GW{shown.some((it) => it.hits) ? " after hits" : ""} · £{bankAfter.toFixed(1)}m left</p>
          )}
          {roll && view === pick && <RollCheck roll={roll} moves={plan.flatMap((it) => it.moves).length} />}
        </section>
        </>
      )}
    </div>
  );
}
