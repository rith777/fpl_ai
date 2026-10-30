"""Generate a self-contained, interactive HTML dashboard of all players.

Uses DataTables (via CDN) for client-side sorting, searching and paging. The
player data is embedded directly in the page as JSON, so the file works when
opened straight from disk (file://) or served over http.

Note: the page is a *snapshot* of the data at the moment it was generated (see
the timestamp in the header). Re-run ``python main.py dashboard`` to refresh it.
"""
import json
from datetime import datetime

# Columns shown in the dashboard: (data key, header label, numeric?).
# ``adj_proj``/``adj_value`` are computed in the browser from the recency
# slider; every other key comes straight from the scored dataframe.
COLUMNS = [
    ("player_name", "Player", False),
    ("team", "Team", False),
    ("position", "Pos", False),
    ("price", "£", True),
    ("adj_proj", "Proj", True),
    ("adj_value", "Value", True),
    ("defcon_xp", "DefCon xP", True),
    ("defcon_per_90", "DefCon/90", True),
    ("cs_prob", "CS prob", True),
    ("start_prob", "Plays", True),
    ("fixture_difficulty", "FDR5", True),
    ("on_pens", "Pen", True),
    ("price_change", "dPrice", True),
    ("net_transfers", "NetT", True),
    ("form", "Form", True),
    ("ep_next", "ep_next", True),
    ("total_points", "Pts", True),
    ("points_per_game", "PPG", True),
    ("minutes", "Mins", True),
    ("xgi_per_90", "xGI/90", True),
    ("selected_by_percent", "Own%", True),
    ("status", "Status", False),
    ("news", "News", False),
]

# Columns that are computed client-side (not present in the dataframe).
COMPUTED = {"adj_proj", "adj_value"}
# Extra dataframe columns embedded for the recency slider to interpolate.
ANCHOR_KEYS = ["proj_form", "proj_season"]

_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FPL AI - Player Dashboard</title>
<link rel="stylesheet" href="https://cdn.datatables.net/1.13.8/css/jquery.dataTables.min.css">
<style>
  body {{ font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; color: #1a1a1a; }}
  h1 {{ margin: 0 0 4px; font-size: 20px; }}
  .meta {{ color: #666; font-size: 13px; margin-bottom: 16px; }}
  .filters {{ margin-bottom: 12px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 18px; }}
  .filters label {{ font-size: 13px; margin-right: 6px; }}
  select {{ padding: 4px 8px; font-size: 13px; }}
  input[type=range] {{ vertical-align: middle; width: 180px; }}
  .hint {{ color: #888; font-size: 12px; }}
  table.dataTable td, table.dataTable th {{ font-size: 13px; padding: 5px 8px; }}
  td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  tbody tr:hover {{ background: #f5f8ff; }}
</style>
</head>
<body>
<h1>FPL AI - Player Dashboard</h1>
<div class="meta">{count} players &middot; 2026-27 season &middot; generated {generated}.
Proj = projected points, Value = Proj per &pound;m. DefCon xP = expected defensive-contribution
points, CS prob = clean-sheet probability, FDR5 = avg difficulty of the next 5 fixtures (lower is easier).</div>
<div class="filters">
  <span><label>Position</label><select id="posFilter"><option value="">All</option>{pos_options}</select></span>
  <span><label>Team</label><select id="teamFilter"><option value="">All</option>{team_options}</select></span>
  <span><label>Recency <b id="recVal">0.50</b></label>
    <input type="range" id="recency" min="0" max="1" step="0.05" value="0.5">
    <span class="hint">season &larr;&rarr; recent form</span></span>
</div>
<table id="players" class="display" style="width:100%"><thead><tr>{headers}</tr></thead></table>

<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<script src="https://cdn.datatables.net/1.13.8/js/jquery.dataTables.min.js"></script>
<script>
const DATA = {data};
const COLUMNS = {columns};

// Recency slider: interpolate between the season-long and recent-form
// projection anchors, then recompute value (= proj per price).
function applyRecency(w) {{
  DATA.forEach(function (r) {{
    r.adj_proj = +(w * r.proj_form + (1 - w) * r.proj_season).toFixed(2);
    r.adj_value = r.price > 0 ? +(r.adj_proj / r.price).toFixed(2) : 0;
  }});
}}

function fmt(key) {{
  const dp = key === 'minutes' ? 0 : 2;
  return function (d, type) {{
    if (d === null || d === '' || (typeof d === 'number' && isNaN(d))) return '';
    if (type !== 'display') return d;
    return Number(d).toLocaleString('en', {{minimumFractionDigits: dp, maximumFractionDigits: dp}});
  }};
}}

$(function () {{
  applyRecency(0.5);
  const table = $('#players').DataTable({{
    data: DATA,
    columns: COLUMNS.map(function (c) {{
      return {{ data: c.key, className: c.num ? 'num' : '', render: c.num ? fmt(c.key) : null }};
    }}),
    order: [[{value_col}, 'desc']],
    pageLength: 25,
    lengthMenu: [25, 50, 100, 250]
  }});
  $('#posFilter').on('change', function () {{ table.column({pos_col}).search(this.value).draw(); }});
  $('#teamFilter').on('change', function () {{ table.column({team_col}).search(this.value).draw(); }});
  $('#recency').on('input', function () {{
    const w = parseFloat(this.value);
    $('#recVal').text(w.toFixed(2));
    applyRecency(w);
    table.clear().rows.add(DATA).draw(false);
  }});
}});
</script>
</body>
</html>"""


def build_html(players) -> str:
    real_keys = [k for k, _, _ in COLUMNS if k not in COMPUTED] + ANCHOR_KEYS
    real_keys = [k for k in real_keys if k in players.columns]
    records = players[real_keys].to_dict(orient="records")
    headers = "".join(f"<th>{label}</th>" for _, label, _ in COLUMNS)
    columns_js = json.dumps([{"key": k, "num": num} for k, _, num in COLUMNS])
    positions = ["GK", "DEF", "MID", "FWD"]
    teams = sorted(players["team"].unique())
    pos_options = "".join(f'<option value="{p}">{p}</option>' for p in positions)
    team_options = "".join(f'<option value="{t}">{t}</option>' for t in teams)
    key_index = {k: i for i, (k, _, _) in enumerate(COLUMNS)}
    return _TEMPLATE.format(
        count=len(records),
        generated=datetime.now().strftime("%Y-%m-%d %H:%M"),
        headers=headers,
        pos_options=pos_options,
        team_options=team_options,
        data=json.dumps(records),
        columns=columns_js,
        value_col=key_index["adj_value"],
        pos_col=key_index["position"],
        team_col=key_index["team"],
    )
