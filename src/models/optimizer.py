"""Pick the squad that maximises expected points under FPL's rules.

A small integer program (via PuLP) chooses the 15, the starting XI and the
captain together, maximising what the team is expected to score:
* every starter's expected points, plus the captain's again (he scores double);
* each substitute's points weighted by how often a substitute in his position
  actually gets on (``bench_weight``, measured from players' chances of
  playing), instead of counting the bench as if it played every week;
subject to the budget, the squad quota per position, the XI shape and the
max-per-club rule (all FPL rules, passed in from the API where available).
"""
import pulp

from utils.config import MAX_PER_CLUB, SQUAD_BUDGET, SQUAD_SIZE


def pick_squad(players, xi_bounds: dict, bench_weight: dict, budget: float = SQUAD_BUDGET):
    """Select an optimal 15 with its XI and captain.

    ``players``: DataFrame with player_id, player_name, team, position, price,
    score. ``xi_bounds``: {position: (min, max)} starters. ``bench_weight``:
    {position: share of a substitute's points expected to count}. Returns the
    15 with ``role`` (start/bench), ``bench_order`` and ``captain`` (C/V/"").
    """
    players = players.reset_index(drop=True)
    idx = players.index
    score = players["score"]
    prob = pulp.LpProblem("fpl_squad", pulp.LpMaximize)
    pick = {i: pulp.LpVariable(f"p{i}", cat="Binary") for i in idx}
    start = {i: pulp.LpVariable(f"s{i}", cat="Binary") for i in idx}
    cap = {i: pulp.LpVariable(f"c{i}", cat="Binary") for i in idx}

    bench_w = players["position"].map(bench_weight).fillna(0)
    prob += pulp.lpSum(score[i] * (start[i] + cap[i] + bench_w[i] * (pick[i] - start[i])) for i in idx)
    prob += pulp.lpSum(players.loc[i, "price"] * pick[i] for i in idx) <= budget
    prob += pulp.lpSum(start.values()) == 11
    prob += pulp.lpSum(cap.values()) == 1
    for i in idx:
        prob += start[i] <= pick[i]
        prob += cap[i] <= start[i]
    for pos, count in SQUAD_SIZE.items():
        in_pos = players.index[players["position"] == pos]
        prob += pulp.lpSum(pick[i] for i in in_pos) == count
        lo, hi = xi_bounds[pos]
        prob += pulp.lpSum(start[i] for i in in_pos) >= lo
        prob += pulp.lpSum(start[i] for i in in_pos) <= hi
    for team in players["team"].unique():
        prob += pulp.lpSum(pick[i] for i in players.index[players["team"] == team]) <= MAX_PER_CLUB

    prob.solve(pulp.PULP_CBC_CMD(msg=False))
    if pulp.LpStatus[prob.status] != "Optimal":
        raise RuntimeError(f"optimizer failed: {pulp.LpStatus[prob.status]}")

    squad = players.loc[[i for i in idx if pick[i].value() == 1]].copy()
    squad["role"] = ["start" if start[i].value() == 1 else "bench" for i in squad.index]
    squad["captain"] = ["C" if cap[i].value() == 1 else "" for i in squad.index]
    starters = squad[(squad["role"] == "start") & (squad["captain"] == "")]
    squad.loc[starters["score"].idxmax(), "captain"] = "V"  # vice: best other starter
    bench = squad[squad["role"] == "bench"].sort_values("score", ascending=False)
    squad["bench_order"] = 0
    squad.loc[bench.index, "bench_order"] = range(1, len(bench) + 1)
    order = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3}
    return (squad.assign(_o=squad["position"].map(order))
            .sort_values(["_o", "score"], ascending=[True, False]).drop(columns="_o").reset_index(drop=True))
