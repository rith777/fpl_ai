import React, { useContext, useDeferredValue, useMemo, useState } from "react";
import { POS_COLOR, POS_NAME, POSITIONS, fairShareOwnership } from "../lib.js";
import {
  HIT_COST, chipValues, contextReason, horizon, model, moveVerdict, planGain as gainOf, positionStats, rollCheck,
  sigmaGain, squadGain, transferPlan, transferReason, upgradeTargets,
} from "../transfers.js";
import { CHIP_NAMES, chipsLeft, rulesReason } from "../rules.js";
import { TIMED_CHIPS, chooseChip } from "../strategy.js";
import { Beta, NextFixtures, Segmented, Shirt, TeamsContext } from "./ui.jsx";
import PlayerList from "./PlayerList.jsx";
import { TeamLoader } from "./Header.jsx";

const Side = ({ p, price, kind }) => (
  <div className={`mv-side ${kind}`}>
    <Shirt teamId={p.team_id} gk={p.position === "GK"} size={34} />
    <div><b>{p.player_name}</b><small>£{price.toFixed(1)} · {p.team}</small></div>
  </div>
);

// One suggestion: a single move or a linked double move, with the reasoning.
function Suggestion({ item, i, priceOf, tag, onApply, stats, fairShare }) {
  const reasons = useMemo(() => [...transferReason(item, stats), ...rulesReason(item), ...contextReason(item)], [item, stats]);
  const diffs = item.moves.filter((m) => (m.in.selected_by_percent ?? 100) < fairShare);
  return (
    <div className={`move ${item.moves.length > 1 ? "combo" : ""}`}
      style={{ "--pos": POS_COLOR[item.moves[0].in.position], "--i": i }}>
      <div className="mv-top">
        <div className="mv-lines">
          {item.moves.length > 1 && (
            <span className="mv-combo">{item.linked ? "Double move · one sale funds the other" : "Double move"}</span>
          )}
          {item.moves.map((m) => (
            <div className="mv-line" key={m.out.player_id}>
              <Side p={m.out} price={priceOf(m.out)} kind="out" />
              <span className="mv-arrow" aria-hidden>→</span>
              <Side p={m.in} price={m.in.price} kind="in" />
            </div>
          ))}
        </div>
        <div className="mv-gain">
          <b>+{item.gain.toFixed(1)}</b><small>pts/GW</small>
          {tag && <em className={tag === "FREE" ? "free" : "hit"}>{tag}</em>}
        </div>
      </div>
      <ul className="mv-why">{reasons.map((r, k) => <li key={k}>{r}</li>)}</ul>
      <div className="mv-fx">
        {item.moves.map((m) => (
          <span key={m.in.player_id}><b>{m.in.player_name}</b> <NextFixtures teamId={m.in.team_id} n={4} /></span>
        ))}
      </div>
      {diffs.map((m) => (
        <div className="mv-diff" key={m.in.player_id}>
          ◆ Differential: only {m.in.selected_by_percent.toFixed(1)}% own {m.in.player_name} (an even share would be
          {" "}{fairShare.toFixed(1)}%), so his points gain you ground on most managers.
        </div>
      ))}
      {onApply && <button className="btn sm mv-apply" onClick={() => onApply(item.moves)}>Apply</button>}
    </div>
  );
}

export const tagFor = (hits) => (hits ? `−${hits * HIT_COST}` : "FREE");
const signed = (x) => `${Math.round(x * 10) >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;

// The moves you've made here (your squad now vs the one on FPL), judged from
// this deadline on like any suggestion: what they add per gameweek over the
// horizon after hits, against the best plan for the same free transfers, each
// move on its own with its reasons.
function YourMoves({ team, squad, players, priceOf, recency, freeTransfers, stats }) {
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
    };
  }, [team, squad, players, priceOf, recency, freeTransfers]);
  if (!result) return null;
  const { moves, hits, gain, best, plan, verdict } = result;
  const theirs = plan.flatMap((it) => it.moves);
  const same = theirs.length === moves.length && theirs.every((m) => moves.some((x) => x.out.player_id === m.out.player_id && x.in.player_id === m.in.player_id));
  return (
    <section className="card your-moves">
      <div className="card-head">
        <h2>Your planned moves</h2>
        <span className={`hx-verdict ${verdict.cls}`}>{verdict.label}</span>
      </div>
      <p className="ym-sum">
        <b>{signed(gain)} pts/GW</b> over the next {horizon()} GWs{hits ? ` after the −${hits * HIT_COST} hit` : ""}; the best
        plan with your {freeTransfers} free transfer{freeTransfers === 1 ? "" : "s"} adds {signed(best)}. {verdict.why.charAt(0).toUpperCase() + verdict.why.slice(1)}.
      </p>
      {moves.map((m) => (
        <div className="move" key={m.out.player_id} style={{ "--pos": POS_COLOR[m.in.position] }}>
          <div className="mv-top">
            <div className="mv-lines"><div className="mv-line">
              <Side p={m.out} price={priceOf(m.out)} kind="out" />
              <span className="mv-arrow" aria-hidden>→</span>
              <Side p={m.in} price={m.in.price} kind="in" />
            </div></div>
            <div className="mv-gain"><b>{signed(m.gain)}</b><small>pts/GW</small></div>
          </div>
          <ul className="mv-why">
            {[...transferReason({ moves: [m], gain: m.gain }, stats), ...rulesReason({ moves: [m] }), ...contextReason({ moves: [m] })]
              .map((r, k) => <li key={k}>{r}</li>)}
          </ul>
        </div>
      ))}
      {!same && theirs.length > 0 && (
        <p className="hint">Instead, the model would make: {theirs.map((m) => `${m.out.player_name} → ${m.in.player_name}`).join(", ")}
          {" "}({signed(best)} pts/GW; see Recommended plan after undoing yours).</p>
      )}
      {!theirs.length && <p className="hint">The model wouldn't make a move this week: rolling the transfer adds as much.</p>}
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
  const fmt = (v) => (name === "freehit" ? v.toFixed(1) : `+${v.toFixed(1)}`);
  const what = name === "freehit" ? "your XI projects" : "it's worth";
  const target = bar == null ? "the best week in view" : name === "freehit"
    ? `a week your XI projects ${fmt(bar)} or less (the bar from past seasons, e.g. a blank)`
    : `a week it's worth ${fmt(bar)} or more (the bar from past seasons)`;
  const best = later && sign * later[key] > sign * now
    ? ` In view, GW${later.gw} is the better week (${name === "freehit" ? `your XI projects ${fmt(later[key])}` : fmt(later[key])}).` : "";
  let why;
  if (model().chipPolicy.kind === "first") why = `this week ${what} ${fmt(now)}. The chip backtest found no waiting rule that
    beat playing each chip at the first chance in every past season, so the app falls back to that.${best}`;
  else if (chip) why = `this week ${what} ${fmt(now)}${bar != null ? `, ${name === "freehit" ? "at or below" : "at least"} ${fmt(bar)}` : ""}, and no week in view is better.`;
  else why = `this week ${what} ${fmt(now)}; the rule waits for ${target}.${best}`;
  return <p className={`chip-call ${chip ? "play" : "hold"}`}><b>{chip ? "Play it this week" : "Hold"}:</b> {why}</p>;
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
// the horizon, against the best plan with the free transfers you have.
function WildcardCheck({ squad, players, bank, priceOf, recency, freeTransfers }) {
  const [result, setResult] = useState(null);
  const check = () => {
    const ctx = { squad, players, bank, priceOf, recency };
    const rebuild = transferPlan({ ...ctx, freeTransfers: squad.length });
    const normal = transferPlan({ ...ctx, freeTransfers });
    setResult({ rebuild: gainOf(rebuild), changes: rebuild.flatMap((it) => it.moves).length, normal: gainOf(normal) });
  };
  if (!result) return <button className="btn sm" onClick={check}>What would a Wildcard add now?</button>;
  return (
    <p className="chip-call">
      A Wildcard now: <b>{signed(result.rebuild)} pts/GW</b> over the next {horizon()} GWs ({result.changes} changes),
      against {signed(result.normal)} from your best plan with {freeTransfers} free transfer{freeTransfers === 1 ? "" : "s"}.
      {" "}{result.rebuild - result.normal > sigmaGain() ? "That's a real gap: worth considering."
        : "Inside the model's margin of error: keep it for later."}
    </p>
  );
}

function Chips({ squad, used, nextGw, players, bank, priceOf, recency, freeTransfers }) {
  const left = chipsLeft(used, nextGw);
  const weeks = useBlanksAndDoubles(squad);
  const values = useMemo(() => (squad.length === 15 ? chipValues(squad) : []), [squad]);
  if (!left.length) return null;
  const valueOf = { "3xc": (v) => v.tc, bboost: (v) => v.bb };
  const bt = model().chipBacktest;
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
              {open && c.name === "freehit" && <small className="chip-note">A one-week squad that reverts after: worth most in a blank or double gameweek.</small>}
              {open && c.name === "wildcard" && <small className="chip-note">Unlimited free transfers for a week, kept afterwards: best just before a run of blanks or doubles, or when your squad needs many changes.</small>}
              {open && c.name === "wildcard" && squad.length === 15 && (
                <WildcardCheck squad={squad} players={players} bank={bank} priceOf={priceOf} recency={recency} freeTransfers={freeTransfers} />
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
        ) : <small> None scheduled yet. FPL moves matches into blank and double gameweeks once cup dates are set, usually a few
          weeks ahead; they'll show here. Free Hit pays most in a blank, Bench Boost and Triple Captain in a double.</small>}
      </div>
      {values.length > 0 && <p className="hint">Triple Captain adds your captain's points once more (the vice's if he
        doesn't play); Bench Boost adds your bench's points beyond what autosubs would bring anyway. Expected points
        for your current squad.{bt?.validation?.adopted && <> The play / hold calls follow the timing rule that won when
        chips were played through {bt.seasons.length} past seasons: {bt.validation.gain >= 0 ? "+" : "−"}
        {Math.abs(bt.validation.gain).toFixed(0)} ± {bt.validation.se.toFixed(0)} pts a season over playing each chip at
        the first chance, tested on seasons it wasn't picked on. Most of that is not wasting the Free Hit; for Triple
        Captain and Bench Boost, timing changed little.</>}</p>}
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
      <p className="hint top">Ranked by points per gameweek gained over the next {horizon()} gameweeks;
        players showing the same gain are listed cheapest first. Each target is
        paired with the player of yours best sold for him. His selling price plus the bank pays.</p>
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
  const bar = model().strategy;
  const g = `+${roll.gain.toFixed(1)} pts/GW`;
  const ord = (k) => `${k}${["th", "st", "nd", "rd"][k] ?? "th"}`;
  if (roll.close) return (
    <p className="roll-check roll">
      <b>Toss-up, rolling is fine:</b> the move adds about +{(roll.gain * horizon()).toFixed(1)} pts over the next {horizon()} GWs.
      Rolling makes this next week's {ord(roll.k)} free transfer, and in past seasons that has been worth about
      +{roll.keep.toFixed(1)} pts over the weeks that follow (a two-move week, cover for an injury). Played through
      {" "}{bar.seasons.length} past seasons, holding transfers back like this neither gained nor lost
      ({bar.bank.gain >= 0 ? "+" : "−"}{Math.abs(bar.bank.gain).toFixed(0)} ± {bar.bank.se.toFixed(0)} pts a season), so either is a sound choice.
    </p>
  );
  // With no bar to clear, quote what holding out for a bigger gain did.
  const patience = bar && !roll.minGain && bar.strategies
    .filter((s) => s.horizon === bar.app.horizon && s.minGain > 0).sort((a, b) => a.minGain - b.minGain)[0];
  if (roll.use && patience) return (
    <p className="roll-check use">
      <b>Make the move:</b> {g} per transfer. When strategies were played through {bar.seasons.length} past seasons,
      rolling gains under +{patience.minGain}/GW instead of using the transfer scored {patience.vsBaseline >= 0 ? "+" : "−"}
      {Math.abs(patience.vsBaseline).toFixed(0)} ± {patience.se.toFixed(0)} pts a season{patience.vsBaseline > 0
        ? ", but a bar picked that way didn't hold up on seasons it wasn't picked on, so any gain is still worth a free transfer"
        : ", so small gains were worth taking"} (see Strategy).
    </p>
  );
  return (
    <p className={`roll-check ${roll.use ? "use" : "roll"}`}>
      {!roll.use ? <><b>Consider rolling:</b> the best move adds {g} per transfer, under the +{roll.minGain.toFixed(2)} a
        transfer needed to add to pay off when strategies were played through past seasons (see Strategy). Banked, it's
        there for next week, when there's new information.</>
        : roll.atCap && roll.gain < roll.minGain ? <><b>Make the move:</b> it's only {g}, but you're at FPL's cap of
        {" "}{model().max_free_transfers} free transfers, so a rolled one would be lost.</>
        : bar ? <><b>Make the move:</b> {g} per transfer clears the +{roll.minGain.toFixed(2)} bar set by playing strategies
          through past seasons (see Strategy){roll.worth < moves ? `; only the first ${roll.worth} clear it, so bank the rest` : ""}.</>
        : <><b>Make the move:</b> any gain that shows is worth a free transfer. (Run <code>python main.py backtest</code> to
          test whether a higher bar pays.)</>}
    </p>
  );
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
    () => rollCheck({ plan, freeTransfers: ftLeft }), [plan, ftLeft]);
  const planGain = plan.reduce((t, it) => t + it.gain - (it.hits * HIT_COST) / horizon(), 0);
  const stats = useMemo(() => positionStats(players), [players]);
  const fairShare = fairShareOwnership(players);
  const bankAfter = bank - plan.reduce((t, it) => t + it.moves.reduce((s, m) => s + m.cost, 0), 0);

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
            freeTransfers={freeTransfers} stats={stats} />
        )}
        <section className="card">
          <div className="card-head">
            <h2>Recommended plan</h2>
            {plan.length > 0 && (
              <button className="btn sm primary" onClick={() => onApply(plan.flatMap((it) => it.moves))}>Apply all</button>
            )}
          </div>
          <p className="hint top">Gains are expected points per gameweek over the next {horizon()} gameweeks for your
            best XI, captain and bench included. They already account for each player's chance of playing and
            his opponents.</p>
          {plan.length ? plan.map((it, i) => (
            <Suggestion key={it.moves.map((m) => m.out.player_id).join("-")} item={it} i={i} priceOf={priceOf}
              tag={tagFor(it.hits)} stats={stats} fairShare={fairShare} />
          )) : <p className="empty">No move improves your team enough right now, so roll the transfer.</p>}
          {plan.length > 0 && (
            <p className="hint">≈ +{planGain.toFixed(1)} projected pts/GW for your XI
              {plan.some((it) => it.hits) ? ` (after hits, spread over ${horizon()} GWs)` : ""},
              leaving £{bankAfter.toFixed(1)}m in the bank. Plans maximise expected points; when two options
              show the same gain, the cheaper one wins and the difference stays in the bank.</p>
          )}
          {roll && <RollCheck roll={roll} moves={plan.flatMap((it) => it.moves).length} />}
        </section>
        </>
      )}
    </div>
  );
}
