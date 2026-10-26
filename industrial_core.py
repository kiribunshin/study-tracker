#!/usr/bin/env python3
"""Cultivar — Industrial Production & Stock Market core logic.

Pure-Python module: no Flask imports here. Everything that CAN be a pure
function of (state, elapsed, catalogs) IS a pure function, so the whole
simulation is testable without the HTTP layer.

Design philosophy mirrors server.py's: state is replayable from event logs
wherever it matters (research, trades, purchases); only genuinely physical
things (grid layout, card buffers, warehouse stock) are mutable state.

The authoritative game data is tech_tree.yaml (see the Cultivar work plan,
§5.5 schema reference). It ships next to server.py; a copy also lives in
the planning folder. Structure (node ids, prerequisites, branches, effects)
is deliberate design — balance numbers below are DRAFT values meant to be
retuned freely.
"""

import json
import math
import random
import re
from pathlib import Path

# ═══════════════════════════════════════════════════════════════════
# ── Balance constants (DRAFT — retune freely) ──
# ═══════════════════════════════════════════════════════════════════

ECON_COST_MULT = 3.0                      # global price multiplier for everything Nerds are spent on
MAX_TICK_CATCHUP_SECONDS = 14 * 24 * 3600  # offline catch-up ceiling per tick (14 days)
TICK_MIN_INTERVAL_S = 1                  # don't micro-tick faster than this

# Mining extraction rates (items/sec) per tool-family index (0-based within
# its era ladder), BEFORE level/buff/weekly multipliers.
HAND_TOOL_BASE_RATE = 0.05               # hands, wooden, stone...
HAND_TOOL_LEVEL_MULT = [1.0, 1.8, 3.0]   # in-family levels 1..3
POWERED_TOOL_BASE_RATE = 0.30            # machine-era floor (Electric Drill)
POWERED_TOOL_RATE_STEP = 0.45            # added per step up the powered ladder
FOCUS_MODE_MULT = 3.0                    # focus-one-item yield multiplier (§3)

# Energy: one shared supply/demand pool across every placed card (no wire
# graph) - see _tick_power in the Simulation tick section below.
# Power draw scales with how advanced a machine is. A processor only draws
# while it is actually working a Production Request; an idle machine, a
# finished request, or one starved of inputs draws nothing.
ENERGY_DRAW_BY_ERA = {"starter": 2.0, "primitive": 3.0, "early_metallurgy": 5.0,
                      "industrial": 10.0, "advanced": 22.0, "precious": 40.0}
ENERGY_DRAW_POWERED_MINER_BASE = 3.0     # Electric Drill; +1.5 per step up the powered ladder
ENERGY_DRAW_POWERED_MINER_STEP = 1.5
# Even hand-tool-era miners/foresters (Bare Hands through Carbide) draw a
# small amount of power now - a lit workspace, sharpening equipment, etc.
# Modest on purpose so the free starter generator (4.0 E/s) comfortably
# powers a couple of them; scales gently up the hand-tool ladder.
ENERGY_DRAW_HAND_TOOL_BASE = 0.5
ENERGY_DRAW_HAND_TOOL_STEP = 0.2
DEFICIT_SLOWDOWN_FLOOR = 0.15            # even starved machines crawl, never hard-stop

# Research / study hours (§5.1: lifetime weighted hours fund research)
WEEKLY_MULT_LOWER_HOURS = 5.0            # industrial curve starts rewarding past 5h/week
WEEKLY_MULT_RATE = 0.02                  # +2%/hour beyond the floor…
WEEKLY_MULT_MAX = 1.6                    # …capped at 1.6x (separate from Botanarium's curve)
LUCK_BONUS_MAX = 0.25                    # §7: high weekly hours improve rare-tier odds

# Caps (§3): strict mining/wood caps, lenient-but-capped processing blocks.
CAPS_BASE = {"mining": 1, "wood": 1, "processing": 8}
CAP_COST_GROWTH = 2.1
CAP_COST_BASE = {k: int(v * ECON_COST_MULT) for k, v in {"mining": 400, "wood": 400, "processing": 250}.items()}
CAP_MAX_PURCHASES = {"mining": 12, "wood": 12, "processing": 30}
CAP_GRANT_NODES = {                      # researched tech that grants +1 cap
    "blast_furnace_design": "processing",
    "machining_basics": "processing",
    "semiconductor_fabrication": "processing",
    "electric_drill": "mining",
    "mining_rig": "mining",
    "harvester": "wood",
}

# Money-skip (§3): Nerds-per-remaining-hour rate; resources still consumed.
SKIP_NERDS_PER_HOUR = int(14 * ECON_COST_MULT)
TOOL_LEVEL_HOURS = [0, 6, 14]            # study-hours to reach in-family levels 1..3

# Junk button salvage refund fraction (§4)
JUNK_SALVAGE_RATE = 0.08

# Market (§6)
MARKET_PASS_THROUGH = 0.75               # upstream shock pass-through per chain link
MARKET_SUBSTITUTE_INVERSE = 0.40         # substitute moves against its pair
MARKET_USER_IMPACT_MAX = 0.20            # mass-selling depresses price up to −20%
MARKET_USER_IMPACT_WINDOW_DAYS = 7       # trailing window for impact
MARKET_FLOOR = 0.15                      # × base price
MARKET_CEILING = 6.0                     # × base price
MARKET_EVENT_CAP = 0.55                  # |combined event effect| clamp on live price
MARKET_MAX_STACKING = 4                  # strongest N events may stack on one commodity
# §6 events run on a REAL-WORLD daily cadence (player feedback): every real
# morning brings a fresh batch, so production choices made today can actually
# be acted on while the event is live. Durations below are REAL days.
DAILY_PICK_TITLE = "Exchange Spotlight"
DAILY_PICK_COUNT = 5                     # featured commodities buffed for the day
DAILY_PICK_PCT_MIN = 22                  # sale-price buff range for the daily five
DAILY_PICK_PCT_MAX = 46
SIM_DAYS_PER_REAL_DAY = 12               # one real month replays a full simulated year
SEASONAL_AMPLITUDE = 0.18                # ±18% seasonal band
NOISE_AMPLITUDE = 0.16                   # smooth pseudo-random walk band

# ═══════════════════════════════════════════════════════════════════
# ── Mini-YAML loader ──
# Supports exactly the subset build_tree.py emits (verified against the
# shipped file): block mappings/sequences by indentation, inline [a, b]
# lists, single-quoted strings (with '' escapes) possibly wrapped across
# lines, plain scalars wrapped across lines, ints/floats/bools/null.
# If PyYAML happens to be installed we prefer it and only fall back to
# this parser when it isn't.
# ═══════════════════════════════════════════════════════════════════


def _yaml_scalar(tok):
    tok = tok.strip()
    if tok == "" or tok == "~" or tok == "null":
        return None
    if tok.startswith("'") and tok.endswith("'") and len(tok) >= 2:
        return tok[1:-1].replace("''", "'")
    if tok.startswith('"') and tok.endswith('"') and len(tok) >= 2:
        return tok[1:-1].replace('\\"', '"')
    low = tok.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    try:
        return int(tok)
    except ValueError:
        pass
    try:
        return float(tok)
    except ValueError:
        pass
    return tok


def _split_flow_list(body):
    """Split '[a, b, c]' body on top-level commas."""
    parts, depth, cur, quote = [], 0, [], None
    for ch in body:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
            cur.append(ch)
        elif ch in "[{":
            depth += 1
            cur.append(ch)
        elif ch in "]}":
            depth -= 1
            cur.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip():
        parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


class _Line:
    __slots__ = ("indent", "text")

    def __init__(self, indent, text):
        self.indent = indent
        self.text = text


def _prep_lines(src):
    out = []
    for raw in src.split("\n"):
        # Strip comments outside quotes.
        line, quote, cut = raw, None, None
        for i, ch in enumerate(line):
            if quote:
                if ch == quote:
                    quote = None
            elif ch in "'\"":
                quote = ch
            elif ch == "#" and (i == 0 or line[i - 1] == " "):
                cut = i
                break
        if cut is not None:
            line = line[:cut]
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        out.append(_Line(indent, line.strip()))
    return out


def _looks_like_key(text):
    return re.match(r"^[A-Za-z_][\w -]*:(\s|$)", text) is not None


def _parse_block(lines, i, indent):
    """Parse a block at exactly `indent`; returns (value, next_i)."""
    if i < len(lines) and lines[i].text.startswith("- ") and lines[i].indent == indent:
        seq = []
        while i < len(lines) and lines[i].indent == indent and lines[i].text.startswith("- "):
            item_text = lines[i].text[2:].strip()
            if _looks_like_key(item_text) or ":" in item_text.split("`")[0]:
                # Inline first key of a mapping item: re-inject as a virtual line.
                virtual = _Line(indent + 2, item_text)
                sub, i2 = _parse_mapping(lines, i, indent + 2, first_line=virtual)
                seq.append(sub)
                i = i2
            else:
                seq.append(_yaml_scalar(item_text))
                i += 1
            # Continuation / nested lines belonging to this item are consumed
            # by _parse_mapping above (for mappings) or skipped (scalars with
            # deeper indent are plain-scalar continuations — rare; ignored).
        return seq, i
    return _parse_mapping(lines, i, indent)


def _parse_mapping(lines, i, indent, first_line=None):
    out = {}
    line_iter_first = first_line
    while True:
        if line_iter_first is not None:
            ln = line_iter_first
            line_iter_first = None
            if ln.indent != indent:
                break
        else:
            if i >= len(lines) or lines[i].indent != indent:
                break
            ln = lines[i]
            i += 1
        m = re.match(r"^([A-Za-z_][\w -]*):\s?(.*)$", ln.text)
        if not m:
            continue  # tolerate stray lines rather than exploding
        key, rest = m.group(1).strip(), m.group(2).strip()
        if rest == "":
            # Block value: nested mapping/sequence at a deeper indent.
            if i < len(lines) and lines[i].indent > indent:
                val, i = _parse_block(lines, i, lines[i].indent)
            elif i < len(lines) and lines[i].indent == indent and lines[i].text.startswith("- "):
                val, i = _parse_block(lines, i, indent)
            else:
                val = None
            out[key] = val
        elif rest.startswith("[") :
            depth, endpos = 0, -1
            quote = None
            for pos, ch in enumerate(rest):
                if quote:
                    if ch == quote:
                        quote = None
                    continue
                if ch in "'\"":
                    quote = ch
                elif ch == "[":
                    depth += 1
                elif ch == "]":
                    depth -= 1
                    if depth == 0:
                        endpos = pos
                        break
            body = rest[1:endpos] if endpos != -1 else rest[1:]
            out[key] = [_yaml_scalar(x) for x in _split_flow_list(body)]
        else:
            # Scalar, possibly a quoted multi-line string or wrapped plain text.
            if rest.startswith("'"):
                buf = rest
                while not _quote_closed(buf) and i < len(lines) and lines[i].indent > indent:
                    buf += "\n" + lines[i].text
                    i += 1
                out[key] = _yaml_scalar(buf)
            else:
                buf = rest
                while (
                    i < len(lines)
                    and lines[i].indent > indent
                    and not lines[i].text.startswith("- ")
                    and not (_looks_like_key(lines[i].text))
                ):
                    buf += " " + lines[i].text
                    i += 1
                out[key] = _yaml_scalar(buf)
    return out, i


def _quote_closed(s):
    body = s[s.index("'") + 1:]
    k = 0
    while k < len(body):
        if body[k] == "'":
            if k + 1 < len(body) and body[k + 1] == "'":
                k += 2
                continue
            return True
        k += 1
    return False


def mini_yaml_load(src):
    lines = _prep_lines(src)
    if not lines:
        return {}
    val, _ = _parse_block(lines, 0, lines[0].indent)
    return val if isinstance(val, dict) else {}


# ═══════════════════════════════════════════════════════════════════
# ── Tech tree loading + derived catalogs ──
# ═══════════════════════════════════════════════════════════════════

_TREE_PATHS = [
    Path(__file__).parent / "tech_tree.yaml",
    Path("/home/kiri/Desktop/Cultivar work/tech_tree.yaml"),
]


def load_tree():
    try:
        import yaml  # PyYAML if available
        for p in _TREE_PATHS:
            if p.exists():
                return yaml.safe_load(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    for p in _TREE_PATHS:
        if p.exists():
            try:
                return mini_yaml_load(p.read_text(encoding="utf-8"))
            except Exception:
                pass
    return {"meta": {"node_count": 0}, "nodes": []}


TREE = load_tree()

# The pipe / wire / storage-bag fixtures belong to the old grid system and no
# longer exist in the card-list model; "Bulk Material Handling" only ever buffed
# pipes. They are dropped from the tree entirely so they can't be placed,
# researched, or shown anywhere (palette, tech tree, wiki).
REMOVED_NODE_IDS = {"starter_wire", "starter_pipe", "starter_storage", "eff_bulk_material_handling"}

# The tree writes a few raw inputs under their bare names; the mineable raw
# items are named "Raw Sand" / "Raw Gravel". Normalising here is what makes
# Brickworks, Concrete etc. actually obtainable.
_RESOURCE_ALIASES = {"Sand": "Raw Sand", "Gravel": "Raw Gravel"}

NODES = [n for n in (TREE.get("nodes") or []) if n.get("id") not in REMOVED_NODE_IDS]
for _n in NODES:
    for _r in (_n.get("resource_requirements") or []):
        _r["item"] = _RESOURCE_ALIASES.get(_r.get("item"), _r.get("item"))
    if _n.get("category") in ("mining_tools", "wood_tools"):
        # Miner/forester tools are NEVER crafted or placed on their own: a
        # card starts as Bare Hands and is upgraded up its ladder in place.
        _n["produces"] = []
NODES_BY_ID = {n["id"]: n for n in NODES}

# Node categories that mark machine-era (module-upgraded) tools.
POWERED_TOOL_IDS = {
    "electric_drill", "pneumatic_drill", "jackhammer", "industrial_rock_drill",
    "small_mechanical_drill", "mining_rig", "drill_vehicle", "tunnel_boring_machine",
    "industrial_mining_excavator", "deep_earth_drilling_platform", "geothermal_drill",
    "planetary_mining_system", "chainsaw", "heavy_chainsaw", "felling_saw",
    "harvester", "feller_buncher", "logging_harvester", "industrial_forestry_machine",
    "mega_harvester", "autonomous_forestry_fleet",
}

# Ordered tool ladders per domain (hand-tool era first, then machine era).
def _ladder(category):
    fams = [n for n in NODES if n.get("category") == category and n.get("branch") == "unlock"]
    # Topological-ish ordering by prerequisite chain length.
    def depth(nid, seen=None):
        seen = seen or set()
        if nid in seen:
            return 0
        seen.add(nid)
        n = NODES_BY_ID.get(nid)
        if not n or not n.get("prerequisites"):
            return 0
        return 1 + max(depth(p, set(seen)) for p in n["prerequisites"])
    fams.sort(key=lambda n: (depth(n["id"]), n["study_hours"]))
    return [n["id"] for n in fams]

MINING_LADDER = _ladder("mining_tools")
WOOD_LADDER = _ladder("wood_tools")

# Rarity tiers (§3.1): material → tier. Drives what a tool family can reach.
RARITY_T1 = ["Raw Dirt", "Raw Sand", "Clay", "Raw Gravel", "Limestone", "Raw Shale",
             "Soft Sandstone", "Raw Coal", "Raw Salt", "Raw Gypsum"]
RARITY_T2 = ["Raw Copper", "Raw Tin", "Raw Zinc", "Raw Iron", "Raw Lead", "Raw Sulfur", "Raw Quartz"]
RARITY_T3 = ["Raw Silver", "Raw Nickel", "Raw Cobalt", "Raw Chromium", "Raw Manganese",
             "Raw Aluminum (Bauxite)", "Raw Graphite", "Raw Fluorite", "Raw Barite",
             "Raw Lithium", "Raw Gemstone"]
RARITY_T4 = ["Raw Gold", "Raw Platinum", "Raw Palladium", "Raw Rhodium", "Raw Iridium",
             "Raw Ruthenium", "Raw Osmium", "Raw Tungsten", "Raw Titanium"]
WOOD_ITEMS = ["Wood"]

# Family reach: how far up the rarity ladder each rung of the tool ladders goes.
def _family_reach(ladder):
    reach = {}
    hand_ids = [fid for fid in ladder if fid not in POWERED_TOOL_IDS]
    pow_ids = [fid for fid in ladder if fid in POWERED_TOOL_IDS]
    for idx, fid in enumerate(hand_ids):
        if idx <= 2:
            reach[fid] = 1        # hands/wooden/stone → Tier 1
        elif idx <= 4:
            reach[fid] = 2        # copper/bronze(+iron where present) → Tier 2
        else:
            reach[fid] = 3
    for idx, fid in enumerate(pow_ids):
        reach[fid] = min(4, 3 + (1 if len(pow_ids) > 2 and idx >= len(pow_ids) // 2 else 0)) if idx >= len(pow_ids) - 3 else 4
        # Powered tools reach everything up to Tier 4; earliest powered stay at 3–4.
    for fid in pow_ids:
        reach[fid] = 4
    return reach

MINING_REACH = _family_reach(MINING_LADDER)
WOOD_REACH = _family_reach(WOOD_LADDER)

# The bare hands are the implicit first rung of both ladders (§3) — not a
# tree node, always available.
HANDS_FAMILY = "hands"
HANDS_REACH_TIER = 1

RAW_POOL = {
    1: RARITY_T1, 2: RARITY_T1 + RARITY_T2,
    3: RARITY_T1 + RARITY_T2 + RARITY_T3,
    4: RARITY_T1 + RARITY_T2 + RARITY_T3 + RARITY_T4,
}

# Rarity weights inside mixed-mode harvest (common stuff dominates).
RARITY_WEIGHT = {1: 100, 2: 42, 3: 15, 4: 4}


def rarity_of_raw(item):
    for t, pool in ((1, RARITY_T1), (2, RARITY_T2), (3, RARITY_T3), (4, RARITY_T4)):
        if item in pool:
            return t
    return 1


# ── Item / machine catalog derived from the tree ──
# items[name] = {node, category, era, is_machine, crafted_at, machine_node}
ITEMS = {}
MACHINES = {}          # name → item record where is_machine

for _n in NODES:
    for _p in _n.get("produces") or []:
        name = _p.get("item")
        if not name:
            continue
        rec = {
            "name": name,
            "node": _n["id"],
            "category": _n.get("category"),
            "era": _n.get("era"),
            "is_machine": bool(_p.get("is_machine")),
            "crafted_at": _p.get("crafted_at"),
        }
        ITEMS[name] = rec
        if rec["is_machine"]:
            MACHINES[name] = rec

STARTER_MACHINES = {n["id"] for n in NODES if n.get("era") == "starter"}
STARTER_MACHINE_NAMES = {
    p["item"] for n in NODES if n.get("era") == "starter"
    for p in (n.get("produces") or []) if p.get("is_machine")
}

# Which machine node introduces each machine name (for gating placement).
_MACHINE_INTRO = {}
for _n in NODES:
    for _p in _n.get("produces") or []:
        if _p.get("is_machine"):
            _MACHINE_INTRO[_p["item"]] = _n["id"]


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s


CATEGORY_COLORS = {}


def _cat_color(cat):
    h = 0
    for ch in str(cat):
        h = (h * 31 + ord(ch)) & 0xFFFFFF
    return "#%06x" % (0x202020 + (h % 0xBFBFBF))


# ── Recipes ──
# Curated core chains first (machine, inputs, outputs, seconds, energy flag);
# then automatic generation guarantees EVERY produced item has a real recipe
# at its validated crafted_at location (plan §0 validator contract).

RECIPES = {}   # output_item → {machine, inputs{}, outputs{}, secs, build}

# One-off ASSEMBLED goods (a car, a tank, a piece of furniture...) are
# fundamentally different from a flowing production line (smelting ore,
# rolling wire): you don't want a Vehicle Assembly Plant quietly spitting
# out an Automobile every few seconds forever. Any recipe auto-derived by
# _ensure_assembly_recipes() below (i.e. nothing hand-tuned it) is marked
# `build: True` and gets a duration that scales with how much the item
# actually requires, instead of a flat few seconds — see the Production
# Request system in industrial_routes.py, which is what "build 1 Tank"
# actually drives. DRAFT constants, retune freely.
BUILD_BASE_SECONDS = 65           # every assembled item takes at least this long (raised - crafting should feel real)
BUILD_SECONDS_PER_UNIT = 34       # per direct input unit, before the multipliers below
BUILD_DEPTH_STEP = 0.16           # +16% per level of intermediate parts (a Tank is deep, a Stool isn't)
# Flowing-line recipes (ingots, plates, chemicals - anything with an
# explicit `secs` passed to _add_recipe rather than computed by
# _finalize_build_times) are scaled up by this factor at registration
# time, so every recipe added anywhere in this file - now or in the
# future - inherits the same "production takes real time" philosophy
# without needing to hand-tune each one individually.
FLOW_RECIPE_TIME_MULT = 2.4
ERA_TIME_MULT = {"starter": 1.0, "primitive": 1.0, "early_metallurgy": 1.4,
                 "industrial": 2.2, "advanced": 3.5, "precious": 5.0}


def _add_recipe(out_item, machine, inputs, outputs, secs, build=False):
    # Flowing (non-build) recipes are scaled up by FLOW_RECIPE_TIME_MULT
    # uniformly here - the ONE place every recipe in the game passes
    # through - so any recipe added later automatically gets the same
    # "production takes real time" treatment with zero extra work.
    secs = float(secs) if build else float(secs) * FLOW_RECIPE_TIME_MULT
    RECIPES[out_item] = {
        "machine": machine, "inputs": dict(inputs),
        "outputs": dict(outputs), "secs": secs, "build": bool(build),
    }


# Ore pipelines: "<material>" smelt/refine/electrolyze nodes produce ingots.
_ORE_MATERIALS = []
for _n in NODES:
    cat = _n.get("category") or ""
    if cat.startswith("ore_"):
        mat = cat[len("ore_"):]
        outs = [p["item"] for p in (_n.get("produces") or []) if not p.get("is_machine")]
        if not outs:
            continue
        raw = f"Raw {_n['name'].split(' ')[0]}" if False else None
        # Raw item name follows requirement conventions: "Raw Copper", "Raw Aluminum (Bauxite)".
        req_items = [r["item"] for r in (_n.get("resource_requirements") or []) if str(r.get("item", "")).startswith("Raw")]
        if not req_items:
            continue
        raw_name = req_items[0]
        machine = None
        for p in (_n.get("produces") or []):
            if not p.get("is_machine") and p.get("crafted_at"):
                machine = p["crafted_at"]
                break
        if machine is None:
            continue
        tier_hours = max(3.0, float(_n.get("study_hours", 8)))
        _add_recipe(outs[0], machine, {raw_name: 2},
                    {o: 1 for o in outs}, min(12.0, max(4.0, tier_hours * 0.45)))

# Wood chain
_add_recipe("Planks", "Sawmill I", {"Wood": 2}, {"Planks": 3}, 5.0)
if "Plywood" in ITEMS:
    _add_recipe("Plywood", "Sawmill II", {"Wood": 3}, {"Plywood": 2}, 7.0)
if "Engineered Lumber" in ITEMS:
    _add_recipe("Engineered Lumber", "Sawmill III", {"Wood": 4}, {"Engineered Lumber": 3}, 9.0)

# Classic mechanical chain drafts
_MECH_DRAFTS = [
    ("Copper Wire", {"Copper Ingot": 1}, 1, 6.0),
    ("Iron Plate", {"Iron Ingot": 1}, 2, 6.0),
    ("Steel Plate", {"Steel Ingot": 1}, 2, 8.0),
    ("Gear", {"Iron Ingot": 2}, 1, 7.0),
]
for out, ins, oq, secs in _MECH_DRAFTS:
    if out in ITEMS and out not in RECIPES:
        _add_recipe(out, ITEMS[out]["crafted_at"] or "Basic Rolling Mill", ins, {out: oq}, secs)


# ── Curated recipes ──
# (item, {inputs}, output_qty, seconds or None). seconds=None marks a one-off
# ASSEMBLED good: it is flagged `build` and its duration is computed from its
# real complexity by _finalize_build_times() below. An explicit seconds value
# is a flowing line (ingots, plates, chemicals) and stays quick.
_CURATED = [
    ("Cordage", {"Wood": 2}, 3, 6),
    ("Cloth Bolt", {"Cordage": 4}, 1, None),
    ("Rope", {"Cordage": 3}, 1, None),
    ("Cloth Bolt (Industrial)", {"Cordage": 6}, 4, 14),
    ("Synthetic Fabric", {"Polymer Resin": 2}, 2, 14),
    ("Synthetic Rope", {"Polymer Resin": 2}, 2, 14),
    ("Vehicle Seat", {"Cloth Bolt": 3, "Planks": 2}, 1, None),
    ("Brick", {"Clay": 2, "Raw Sand": 1}, 4, 10),
    ("Cement", {"Limestone": 3, "Clay": 1}, 2, 10),
    ("Concrete", {"Cement": 2, "Raw Gravel": 4}, 3, 12),
    ("Ceramic Crucible", {"Clay": 4}, 1, None),
    ("Ceramic Mold", {"Clay": 3}, 1, None),
    ("Glass", {"Quartz (Purified)": 2}, 2, 10),
    ("Tempered Glass Window", {"Glass": 3}, 1, None),
    ("Paper", {"Planks": 2}, 4, 8),
    ("Blank Book", {"Paper": 6}, 1, None),
    ("Bound Journal", {"Paper": 10, "Cordage": 2}, 1, None),
    ("Stool", {"Planks": 3}, 1, None),
    ("Table", {"Planks": 6}, 1, None),
    ("Prefab Wood Wall Panel", {"Planks": 8}, 1, None),
    ("Cabinet", {"Planks": 10, "Screw": 4}, 1, None),
    ("Bed Frame", {"Planks": 12, "Screw": 6}, 1, None),
    ("Prefab Wood Flooring", {"Planks": 10, "Screw": 4}, 1, None),
    ("Premium Furniture Set", {"Engineered Lumber": 8, "Screw": 8, "Cloth Bolt": 4}, 1, None),
    ("Prefab Wood Building Kit", {"Engineered Lumber": 16, "Bolt": 12, "Screw": 12}, 1, None),
    ("Prefab Brick Wall Panel", {"Brick": 12}, 1, None),
    ("Garden Statue", {"Brick": 10, "Limestone": 6}, 1, None),
    ("Reinforced Concrete Panel", {"Concrete": 8, "Metal Rod": 4}, 1, None),
    ("Ornamental Facade", {"Brick": 10, "Concrete": 6}, 1, None),
    ("Rebar-Reinforced Concrete Panel", {"Concrete": 10, "Steel Rod": 6}, 1, None),
    ("Steel-Framed Prefab Building Kit", {"Concrete": 16, "Steel Rod": 10, "Steel Plate": 8}, 1, None),
    ("Bronze Ingot", {"Copper Ingot": 3, "Tin Ingot": 1}, 4, 12),
    ("Brass Ingot", {"Copper Ingot": 3, "Zinc Ingot": 1}, 4, 12),
    ("Steel Ingot", {"Iron Ingot": 2, "Coal (Processed)": 1}, 2, 14),
    ("Stainless Steel Ingot", {"Steel Ingot": 4, "Chromium Ingot": 1, "Nickel Ingot": 1}, 4, 18),
    ("Tungsten Carbide", {"Tungsten Ingot": 2, "Steel Ingot": 3}, 2, 20),
    ("Metal Plate", {"Copper Ingot": 1}, 1, 6),
    ("Metal Rod", {"Copper Ingot": 1}, 1, 6),
    ("Wire Stock", {"Copper Ingot": 1}, 2, 6),
    ("Steel Rod", {"Steel Ingot": 1}, 2, 8),
    ("Titanium Plate", {"Titanium Ingot": 1}, 1, 12),
    ("Titanium Rod", {"Titanium Ingot": 1}, 1, 12),
    ("Tungsten Plate", {"Tungsten Ingot": 1}, 1, 12),
    ("Tungsten Rod", {"Tungsten Ingot": 1}, 1, 12),
    ("Nut", {"Metal Rod": 1}, 4, 6),
    ("Bolt", {"Metal Rod": 1}, 4, 6),
    ("Screw", {"Metal Rod": 1}, 4, 6),
    ("Sulfuric Acid", {"Refined Sulfur": 2}, 2, 8),
    ("Crude Oil", {}, 4, 20),
    ("Kerosene", {"Crude Oil": 2}, 2, 12),
    ("Diesel", {"Crude Oil": 2}, 2, 12),
    ("Gas (Refined)", {"Crude Oil": 2}, 2, 12),
    ("Ethylene", {"Gas (Refined)": 2}, 2, 14),
    ("Propylene", {"Gas (Refined)": 2}, 2, 14),
    ("Polymer Resin", {"Ethylene": 2}, 2, 14),
    ("Plastic Casing", {"Polymer Resin": 1}, 2, 10),
    ("Synthetic Rubber", {"Polymer Resin": 2}, 2, 14),
    ("Propellant Charge", {"Ethylene": 1, "Black Powder": 1}, 2, 16),
    ("High Explosive Compound", {"Ethylene": 2, "Sulfuric Acid": 1}, 2, 18),
    ("Advanced Catalyst", {"Platinum Ingot": 1, "Sulfuric Acid": 2}, 1, 24),
    ("High-Purity Electrolyte", {"Refined Salt": 2, "Sulfuric Acid": 1}, 2, 18),
    ("Black Powder", {"Coal (Processed)": 2, "Refined Sulfur": 1, "Refined Salt": 1}, 3, 14),
    ("Blasting Charge", {"Black Powder": 2, "Cordage": 1}, 1, None),
    ("Refined Palladium", {"Platinum Ingot": 2}, 1, 24),
    ("Refined Rhodium", {"Platinum Ingot": 2}, 1, 24),
    ("Refined Iridium", {"Platinum Ingot": 2}, 1, 24),
    ("Refined Ruthenium", {"Platinum Ingot": 2}, 1, 24),
    ("Refined Osmium", {"Platinum Ingot": 2}, 1, 24),
    ("Shaft", {"Steel Rod": 2}, 1, None),
    ("Gearbox", {"Gear": 2, "Shaft": 1, "Steel Plate": 1}, 1, None),
    ("Bearing Assembly", {"Metal Rod": 2, "Steel Plate": 1}, 2, None),
    ("Drivetrain Assembly", {"Gearbox": 1, "Shaft": 2, "Bearing Assembly": 1}, 1, None),
    ("Tank Track Assembly", {"Steel Plate": 6, "Gearbox": 1, "Steel Rod": 4}, 1, None),
    ("Suspension System", {"Steel Plate": 4, "Gearbox": 1, "Bearing Assembly": 2}, 1, None),
    ("Heavy Vehicle Frame", {"Steel Plate": 8, "Steel Rod": 4}, 1, None),
    ("Hydraulic Cylinder", {"Steel Plate": 3, "Steel Rod": 2}, 1, None),
    ("Composite Armor Plate", {"Stainless Steel Ingot": 3, "Tungsten Carbide": 1}, 1, None),
    ("Basic Motor", {"Steel Plate": 2, "Gear": 2, "Copper Wire": 6}, 1, None),
    ("Heavy Diesel Engine", {"Steel Plate": 8, "Gear": 4, "Shaft": 3, "Diesel": 2}, 1, None),
    ("Resistor", {"Graphite": 1, "Clay": 1}, 4, 8),
    ("Capacitor", {"Aluminum Ingot": 1, "Sulfuric Acid": 1}, 4, 10),
    ("Circuit Board", {"Resistor": 4, "Copper Wire": 6}, 1, None),
    ("Printed Circuit Board (PCB)", {"Metal Plate": 2, "Sulfuric Acid": 2}, 2, None),
    ("Semiconductor-Grade Silicon Wafer", {"Quartz (Purified)": 4}, 2, 24),
    ("Microchip (Basic Logic)", {"Semiconductor-Grade Silicon Wafer": 1, "Copper Wire": 1, "Sulfuric Acid": 1}, 2, 26),
    ("CPU", {"Microchip (Basic Logic)": 4, "Printed Circuit Board (PCB)": 1, "Copper Wire": 4}, 1, None),
    ("RAM Module", {"Microchip (Basic Logic)": 3, "Capacitor": 6, "Printed Circuit Board (PCB)": 1}, 1, None),
    ("Radio", {"Printed Circuit Board (PCB)": 1, "Resistor": 2, "Plastic Casing": 1}, 1, None),
    ("Pocket Calculator", {"Printed Circuit Board (PCB)": 1, "Resistor": 2, "Plastic Casing": 1, "Glass": 1}, 1, None),
    ("Radio Transceiver", {"Circuit Board": 2, "Copper Wire": 4, "Capacitor": 2}, 1, None),
    ("Radar Unit", {"Microchip (Basic Logic)": 2, "Radio Transceiver": 1, "Steel Plate": 4, "Copper Wire": 8}, 1, None),
    ("Portable Music Player", {"CPU": 1, "RAM Module": 1, "Plastic Casing": 1, "Glass": 1}, 1, None),
    ("Basic Computer", {"CPU": 1, "RAM Module": 2, "Printed Circuit Board (PCB)": 1, "Plastic Casing": 2, "Glass": 1}, 1, None),
    ("Electric Tool Housing", {"Steel Ingot": 2, "Plastic Casing": 2}, 1, None),
    ("Cordless Drill (Consumer)", {"Electric Tool Housing": 1, "Printed Circuit Board (PCB)": 1, "Basic Motor": 1, "Lithium-Ion Battery Cell": 1}, 1, None),
    ("Digital Multimeter", {"Electric Tool Housing": 1, "Printed Circuit Board (PCB)": 1, "Resistor": 4, "Glass": 1}, 1, None),
    ("Precision Caliper Set", {"Stainless Steel Ingot": 2, "Steel Rod": 2}, 1, None),
    ("Lead-Acid Battery Cell", {"Lead Ingot": 2, "Sulfuric Acid": 2}, 1, None),
    ("Nickel-Iron Battery Cell", {"Nickel Ingot": 3, "Iron Ingot": 4, "Steel Plate": 1}, 1, None),
    ("Lithium-Ion Battery Cell", {"Lithium (Battery-Grade)": 3, "Copper Wire": 2, "Aluminum Ingot": 1}, 1, None),
    ("Solid-State Battery Cell", {"Lithium (Battery-Grade)": 4, "Advanced Catalyst": 1, "High-Purity Electrolyte": 1}, 1, None),
    ("Hammer", {"Iron Ingot": 2, "Planks": 2}, 1, None),
    ("Wrench", {"Iron Ingot": 3}, 1, None),
    ("Screwdriver Set", {"Iron Ingot": 2, "Planks": 1, "Plastic Casing": 1}, 1, None),
    ("Toolbox Set", {"Steel Plate": 3, "Hammer": 1, "Wrench": 1, "Screwdriver Set": 1}, 1, None),
    ("Cookware Set", {"Steel Plate": 4, "Planks": 1}, 1, None),
    ("Silver Ring", {"Silver Ingot": 1}, 1, None),
    ("Silver Necklace", {"Silver Ingot": 2}, 1, None),
    ("Gold Ring", {"Gold Ingot": 1, "Cut Gemstone": 1}, 1, None),
    ("Gold Necklace", {"Gold Ingot": 2, "Cut Gemstone": 2}, 1, None),
    ("Gold Watch", {"Gold Ingot": 2, "Gear": 2, "Glass": 1}, 1, None),
    ("Platinum Ring", {"Platinum Ingot": 1, "Cut Gemstone": 1}, 1, None),
    ("Platinum Necklace (Gem-Set)", {"Platinum Ingot": 2, "Cut Gemstone": 4}, 1, None),
    ("Wooden Cart Wheel", {"Metal Rod": 2, "Planks": 2}, 1, None),
    ("Handcart", {"Wooden Cart Wheel": 2, "Plywood": 4, "Metal Rod": 2}, 1, None),
    ("Wagon", {"Wooden Cart Wheel": 4, "Plywood": 4, "Metal Rod": 4}, 1, None),
    ("Vulcanized Tire", {"Synthetic Rubber": 4, "Refined Sulfur": 2, "Metal Rod": 1}, 1, None),
    ("Wiring Harness", {"Copper Wire": 6, "Plastic Casing": 1}, 1, None),
    ("Motor Cart", {"Basic Motor": 1, "Vulcanized Tire": 4, "Wiring Harness": 1, "Steel Plate": 2, "Plywood": 2}, 1, None),
    ("Delivery Truck", {"Basic Motor": 1, "Vulcanized Tire": 4, "Wiring Harness": 1, "Steel Plate": 6, "Vehicle Seat": 1}, 1, None),
    ("Automobile", {"CPU": 1, "Tempered Glass Window": 4, "Vehicle Seat": 2, "Drivetrain Assembly": 1,
                    "Basic Motor": 1, "Vulcanized Tire": 4, "Wiring Harness": 1, "Steel Plate": 8}, 1, None),
    ("Armored Transport Chassis", {"Heavy Vehicle Frame": 1, "Composite Armor Plate": 4, "Drivetrain Assembly": 1,
                                   "Vulcanized Tire": 4, "Basic Motor": 1}, 1, None),
    ("Artillery Shell", {"Brass Ingot": 2, "Steel Rod": 1, "Propellant Charge": 2, "High Explosive Compound": 1}, 1, None),
    ("Rifle Ammunition", {"Brass Ingot": 1, "Propellant Charge": 1, "Lead Ingot": 1}, 10, None),
    ("Tank", {"Heavy Vehicle Frame": 1, "Composite Armor Plate": 4, "Tank Track Assembly": 2, "Heavy Diesel Engine": 1,
              "Artillery Shell": 10, "Hydraulic Cylinder": 2, "Suspension System": 1, "Radio Transceiver": 1}, 1, None),
    ("Radar-Guided Tank", {"Radar Unit": 1, "Tank": 1}, 1, None),
]

# Cordage was the one tree item with no place to make it (crafted_at: null),
# which left Hand Loom research impossible. It is now spun at Fabricator I.
if "Cordage" in ITEMS and not ITEMS["Cordage"].get("crafted_at"):
    ITEMS["Cordage"]["crafted_at"] = "Fabricator I"

for _name, _ins, _oq, _secs in _CURATED:
    _rec = ITEMS.get(_name)
    if not _rec or _rec["is_machine"] or not _rec.get("crafted_at"):
        continue
    _add_recipe(_name, _rec["crafted_at"], _ins, {_name: _oq}, _secs or 0, build=_secs is None)


# Assembly fallback for anything still without a recipe: half of the node's
# research bill (min 1), or - if the node lists nothing - an era-appropriate
# bill of real materials (never a token single Wood).
_FALLBACK_BILL = {
    "starter": {"Wood": 4}, "primitive": {"Planks": 4, "Cordage": 2},
    "early_metallurgy": {"Iron Ingot": 3, "Planks": 2},
    "industrial": {"Steel Plate": 3, "Copper Wire": 4},
    "advanced": {"Steel Plate": 4, "Circuit Board": 2}, "precious": {"Steel Plate": 4, "Circuit Board": 2},
}


def _ensure_assembly_recipes():
    for name, rec in ITEMS.items():
        if rec["is_machine"] or name in RECIPES:
            continue
        if not rec["crafted_at"] or rec["crafted_at"] == "BY_HAND":
            continue
        node = NODES_BY_ID.get(rec["node"])
        reqs = (node.get("resource_requirements") or []) if node else []
        inputs = {}
        for r in reqs:
            q = max(1, round((r.get("quantity") or 1) / 2.0))
            inputs[r["item"]] = inputs.get(r["item"], 0) + q
        if not inputs:
            inputs = dict(_FALLBACK_BILL.get(rec.get("era"), {"Wood": 4}))
        _add_recipe(name, rec["crafted_at"], inputs, {name: 1}, 0, build=True)

_ensure_assembly_recipes()


def _finalize_build_times():
    """Assembled goods (build=True) take as long as they are complicated:
    direct input count, era, and how many layers of intermediate parts sit
    beneath them. Runs after every recipe (incl. the expansion pack) exists."""
    memo = {}

    def depth(item, stack=()):
        if item in memo:
            return memo[item]
        r = RECIPES.get(item)
        if not r or item in stack:
            return 0
        d = 1 + max([depth(k, stack + (item,)) for k in r["inputs"]] or [0])
        memo[item] = d
        return d

    for out, r in RECIPES.items():
        if not r.get("build"):
            continue
        units = sum(r["inputs"].values())
        era_mult = ERA_TIME_MULT.get((ITEMS.get(out) or {}).get("era"), 1.0)
        layers = max(0, depth(out) - 1)
        r["secs"] = float(round((BUILD_BASE_SECONDS + BUILD_SECONDS_PER_UNIT * units)
                                * era_mult * (1 + BUILD_DEPTH_STEP * layers)))


# ── Production expansion pack ──
# Secondary goods crafted at EXISTING machines from existing inputs — richer
# mid-game recipes and more market variety without touching the tree's
# structure (the plan explicitly invites intermediate-process additions).
# Every entry is validated at import; invalid ones are skipped with a
# warning instead of crashing the app.
# (name, category, era, crafted_at, inputs{item:qty}, out_qty, secs)
EXPANSION_ITEMS = [
    ("Steel Beam", "mechanical", "industrial", "Advanced Press", {"Steel Ingot": 3}, 2, 14),
    ("Steel Wire", "mechanical", "industrial", "Basic Rolling Mill", {"Steel Ingot": 1}, 2, 8),
    ("Aluminum Wire", "electrical", "industrial", "Basic Rolling Mill", {"Aluminum Ingot": 1}, 2, 8),
    ("Brass Fittings", "mechanical", "early_metallurgy", "Basic Rolling Mill", {"Brass Ingot": 2}, 3, 10),
    ("Rivet Set", "mechanical", "early_metallurgy", "Gear Cutting Station", {"Iron Ingot": 1}, 4, 6),
    ("Spring Assembly", "mechanical", "industrial", "Mechanical Assembly Workshop",
     {"Steel Wire": 2, "Gear": 1}, 1, 12),
    ("Bearing Roller Set", "mechanical", "industrial", "Mechanical Assembly Workshop",
     {"Metal Rod": 2}, 2, 10),
    ("Wood Pulp", "paper_goods", "primitive", "Sawmill II", {"Wood": 3}, 2, 9),
    ("Cardboard", "paper_goods", "industrial", "Paper Press", {"Wood Pulp": 2}, 3, 8),
    ("Cardboard Box", "consumer_goods", "industrial", "Fabricator I", {"Cardboard": 2}, 2, 6),
    ("Fertilizer", "chemistry", "industrial", "Basic Chemical Reactor",
     {"Sulfuric Acid": 1, "Raw Salt": 2}, 3, 12),
    ("Bleach", "chemistry", "industrial", "Basic Chemical Reactor",
     {"Sulfuric Acid": 1, "Raw Salt": 1}, 2, 9),
    ("Detergent", "chemistry", "advanced", "Advanced Chemical Reactor",
     {"Bleach": 1, "Polymer Resin": 1}, 3, 10),
    ("Insulation Foam", "chemistry", "advanced", "Petrochemical Reactor",
     {"Polymer Resin": 2, "Ethylene": 1}, 2, 12),
    ("Asphalt Mix", "construction", "industrial", "Basic Chemical Reactor",
     {"Polymer Resin": 1, "Raw Gravel": 3}, 2, 12),
    ("Lab Glassware", "glassmaking", "industrial", "Glass Furnace", {"Glass": 2}, 2, 10),
    ("Fiber Optic Cable", "electronics", "advanced", "Semiconductor Fab Plant",
     {"Glass": 2, "Copper Wire": 1}, 2, 16),
    ("Microcontroller", "electronics", "advanced", "Semiconductor Fab Plant",
     {"Microchip (Basic Logic)": 1, "Plastic Casing": 1}, 1, 18),
    ("Power Supply Unit", "electronics", "advanced", "Fabricator III",
     {"Copper Wire": 3, "Metal Plate": 2}, 1, 15),
    ("Motherboard", "electronics", "advanced", "Semiconductor Fab Plant",
     {"Printed Circuit Board (PCB)": 1, "Copper Wire": 2, "Tin Ingot": 1}, 1, 16),
    ("Smartphone", "electronics", "advanced", "Semiconductor Fab Plant",
     {"CPU": 1, "RAM Module": 1, "Glass": 1, "Plastic Casing": 2}, 1, 30),
    ("Laptop Computer", "electronics", "advanced", "Semiconductor Fab Plant",
     {"CPU": 1, "RAM Module": 2, "Motherboard": 1, "Plastic Casing": 2}, 1, 34),
    ("Server", "electronics", "advanced", "Semiconductor Fab Plant",
     {"CPU": 2, "RAM Module": 4, "Motherboard": 1, "Power Supply Unit": 1}, 1, 40),
    ("LED Panel", "electronics", "advanced", "Fabricator III",
     {"Glass": 1, "Copper Wire": 2, "Microcontroller": 1}, 2, 18),
    ("Smartwatch", "electronics", "precious", "Semiconductor Fab Plant",
     {"Microcontroller": 1, "RAM Module": 1, "Glass": 1, "Plastic Casing": 1}, 1, 24),
    ("Bicycle", "vehicles", "industrial", "Mechanical Assembly Workshop",
     {"Metal Rod": 4, "Synthetic Rubber": 2, "Gear": 2}, 1, 20),
    ("Cargo Trailer", "vehicles", "industrial", "Vehicle Assembly Plant I",
     {"Steel Beam": 2, "Metal Rod": 2, "Synthetic Rubber": 2}, 1, 24),
    ("Electric Scooter", "vehicles", "advanced", "Vehicle Assembly Plant II",
     {"Basic Motor": 1, "Lithium-Ion Battery Cell": 1, "Metal Rod": 3,
      "Synthetic Rubber": 2}, 1, 26),
    ("Solar Cell", "energy", "advanced", "Semiconductor Fab Plant",
     {"Semiconductor-Grade Silicon Wafer": 1, "Copper Wire": 1}, 2, 14),
    ("Voltage Regulator", "electrical", "industrial", "Fabricator II",
     {"Copper Wire": 2, "Metal Plate": 1}, 1, 12),
    ("UPS Module", "energy_storage", "advanced", "Fabricator III",
     {"Lithium-Ion Battery Cell": 2, "Voltage Regulator": 1, "Plastic Casing": 1}, 1, 18),
    ("Ceramic Tile", "construction", "early_metallurgy", "Pottery Kiln", {"Clay": 2}, 4, 8),
    ("Carpet", "textiles", "industrial", "Textile Mill",
     {"Cloth Bolt (Industrial)": 2, "Polymer Resin": 1}, 1, 14),
    ("Industrial Filter Cloth", "textiles", "industrial", "Textile Mill",
     {"Synthetic Fabric": 2}, 2, 12),
    ("Silver Cutlery Set", "luxury_goods", "precious", "Jeweler's Bench",
     {"Silver Ingot": 3}, 1, 16),
    ("Gemstone Bracelet", "luxury_goods", "precious", "Jeweler's Bench",
     {"Cut Gemstone": 2, "Gold Ingot": 1}, 1, 18),
    ("Gold Pocket Watch", "luxury_goods", "precious", "Jeweler's Bench",
     {"Gold Ingot": 2, "Gear": 1, "Glass": 1}, 1, 22),
    ("Kitchen Knife Set", "consumer_goods", "industrial", "Fabricator II",
     {"Steel Ingot": 2, "Plastic Casing": 1}, 1, 10),
    ("Vacuum Flask", "consumer_goods", "industrial", "Fabricator I",
     {"Stainless Steel Ingot": 1, "Plastic Casing": 1}, 2, 9),
    ("Camping Stove", "consumer_goods", "industrial", "Fabricator II",
     {"Metal Plate": 1, "Copper Wire": 1, "Plastic Casing": 1}, 1, 11),
]

_EXPANSION_BASE_PRICE = {
    "Smartphone": 720, "Laptop Computer": 1250, "Server": 2100, "Smartwatch": 480,
    "Microcontroller": 95, "Motherboard": 180, "Power Supply Unit": 120,
    "Fiber Optic Cable": 60, "LED Panel": 160, "Solar Cell": 85,
    "Bicycle": 190, "Electric Scooter": 540, "Cargo Trailer": 620,
    "UPS Module": 240, "Voltage Regulator": 70, "Gemstone Bracelet": 640,
    "Gold Pocket Watch": 980, "Silver Cutlery Set": 320, "Kitchen Knife Set": 65,
}

for _e in EXPANSION_ITEMS:
    _name, _cat, _era, _mach, _ins, _oq, _secs = _e
    _raws = set(RARITY_T1 + RARITY_T2 + RARITY_T3 + RARITY_T4 +
                ["Wood", "Clay", "Sand", "Raw Gravel", "Limestone"])
    _bad = [k for k in _ins if k not in ITEMS and k not in _raws and k not in {x[0] for x in EXPANSION_ITEMS}]
    if _bad or _mach not in MACHINES:
        print(f"[expansion] skipping '{_name}': "
              f"{'unknown inputs ' + str(_bad) if _bad else ''}"
              f"{'unknown machine ' + _mach if _mach not in MACHINES else ''}")
        continue
    ITEMS[_name] = {"name": _name, "node": "expansion_pack", "category": _cat,
                    "era": _era, "is_machine": False, "crafted_at": _mach}
    _add_recipe(_name, _mach, dict(_ins), {_name: _oq}, float(_secs))
_finalize_build_times()

# Machine bills. Every non-starter machine costs REAL materials plus Nerds to
# place: the node's own research bill in full, plus an era bill scaled by how
# advanced the machine is (its research hours). The era bill deliberately only
# uses items that exist BEFORE that era's machines (raws, ingots, wire), so no
# machine ever needs something only itself can make.
_FAB_BY_ERA = {"starter": "Fabricator I", "primitive": "Fabricator I",
               "early_metallurgy": "Fabricator II", "industrial": "Fabricator II",
               "advanced": "Fabricator III", "precious": "Fabricator III"}
MACHINE_ERA_BILL = {
    "primitive": {"Wood": 10, "Clay": 8},
    "early_metallurgy": {"Wood": 8, "Clay": 8, "Copper Ingot": 5},
    "industrial": {"Steel Ingot": 10, "Planks": 10, "Copper Wire": 6},
    "advanced": {"Steel Ingot": 16, "Stainless Steel Ingot": 4, "Circuit Board": 3, "Copper Wire": 10},
    "precious": {"Steel Ingot": 20, "Stainless Steel Ingot": 8, "Circuit Board": 6, "Copper Wire": 16},
}
MACHINE_ERA_NERDS = {"starter": 150, "primitive": 450, "early_metallurgy": 1300,
                     "industrial": 3800, "advanced": 10000, "precious": 22000}
MACHINE_ERA_NERDS = {k: int(v * ECON_COST_MULT) for k, v in MACHINE_ERA_NERDS.items()}
HANDS_PLACE_NERDS = int(120 * ECON_COST_MULT)                 # extra Bare Hands miners/foresters (the first of each is free)

MACHINE_BUILD_RECIPES = {}
MACHINE_PLACE_NERDS = {}
for mname, mrec in MACHINES.items():
    if mname in STARTER_MACHINE_NAMES:
        continue
    node = NODES_BY_ID.get(mrec["node"])
    hours = float((node or {}).get("study_hours", 0) or 0)
    scale = 1.0 + min(1.5, hours / 40.0)
    inputs = {}
    for k, v in (MACHINE_ERA_BILL.get(mrec.get("era")) or MACHINE_ERA_BILL["industrial"]).items():
        inputs[k] = max(1, round(v * scale))
    for r in ((node or {}).get("resource_requirements") or []):
        inputs[r["item"]] = inputs.get(r["item"], 0) + max(1, int(r.get("quantity") or 1))
    fab = _FAB_BY_ERA.get(mrec.get("era"), "Fabricator III")
    MACHINE_BUILD_RECIPES[mname] = {"machine": fab if fab in MACHINES else "Fabricator I",
                                    "inputs": inputs, "secs": 0.0}
    MACHINE_PLACE_NERDS[mname] = round(MACHINE_ERA_NERDS.get(mrec.get("era"), 400) * (1.0 + hours / 30.0)
                                       * (1.0 + 0.004 * sum(inputs.values())))
for _sn in STARTER_MACHINE_NAMES:
    MACHINE_PLACE_NERDS[_sn] = MACHINE_ERA_NERDS["starter"]

BY_HAND_RECIPES = {}
for name, rec in ITEMS.items():
    if rec["crafted_at"] == "BY_HAND" or (not rec["is_machine"] and not rec["crafted_at"]):
        BY_HAND_RECIPES[name] = {"inputs": {}, "secs": 3.0}


# ═══════════════════════════════════════════════════════════════════
# ── Buffs (efficiency branch, §5.2) ──
# ═══════════════════════════════════════════════════════════════════

EFFICIENCY_NODES = [n for n in NODES if n.get("branch") == "efficiency" and n.get("effect")]

_SPECIAL_TARGET_ITEMS = {
    "pipes_and_filters": "__transport__",
    "fabricator_recipes": "__fabricators__",
    "moving_part_processors": "__moving_parts__",
    "fossil_generators": "__fossil_generators__",
    "mining_tools": "__mining__",
    "wood_tools": "__wood__",
    "heavy_machinery": "__heavy_machinery__",
    "ore_precious_group": "__precious_refining__",
    "circuit_components": "__circuits__",
}

FOSSIL_GENERATOR_NAMES = {"Coal Power Station", "Gas Power Station", "Coal Power Plant",
                          "Gas Power Plant", "Diesel Generator", "Oil Power Plant"}


def buffs_for_state(researched_set):
    """Aggregate active buff effects → resolver functions.

    Returns dict of callables: speed(item_ctx), yield_(item_ctx),
    cost_reduction(item_ctx), buffer_tiers(item_ctx), plus system flags.
    item_ctx is a dict describing the affected thing:
      {"kind": "machine"|"item"|"transport"|"mining"|"wood",
       "name": ..., "node": ..., "category": ...}
    """
    acc = {"speed": [], "yield": [], "resource_cost_reduction": [],
           "buffer_capacity": [], "leak_rate_reduction": [], "fuel_consumption_reduction": []}

    def _matches(target_type, target, ctx):
        if target_type == "single_node":
            return ctx.get("node") == target
        if target_type == "category":
            spec = _SPECIAL_TARGET_ITEMS.get(target, target)
            if spec == "__transport__":
                return ctx.get("kind") == "transport"
            if spec == "__fabricators__":
                return ctx.get("category") == "fabricator"
            if spec == "__moving_parts__":
                return ctx.get("kind") == "machine" and ctx.get("name") not in FOSSIL_GENERATOR_NAMES \
                    and "Furnace" not in (ctx.get("name") or "") and "Kiln" not in (ctx.get("name") or "")
            if spec == "__fossil_generators__":
                return ctx.get("name") in FOSSIL_GENERATOR_NAMES
            if spec == "__mining__":
                return ctx.get("kind") == "mining"
            if spec == "__wood__":
                return ctx.get("kind") == "wood"
            if spec == "__heavy_machinery__":
                return (ctx.get("kind") in ("mining", "wood")) and ctx.get("node") in POWERED_TOOL_IDS
            if spec == "__precious_refining__":
                return ctx.get("category") in ("ore_precious_group", "luxury_goods")
            if spec == "__circuits__":
                return ctx.get("category") in ("electronics",)
            return ctx.get("category") == target
        return False  # system_wide handled separately

    for n in EFFICIENCY_NODES:
        if n["id"] not in researched_set:
            continue
        eff = n["effect"] or {}
        etype = eff.get("type")
        mag = float(eff.get("magnitude") or 0)
        tt, tg = eff.get("target_type"), eff.get("target")
        if tt == "system_wide":
            acc.setdefault(etype, []).append(("__all__", mag))
        else:
            acc.setdefault(etype, []).append(((tt, tg), mag))

    def _sum_for(etype, ctx):
        total = 0.0
        for sel, mag in acc.get(etype, []):
            if sel == "__all__":
                total += mag
            elif _matches(sel[0], sel[1], ctx):
                total += mag
        return total

    return {
        "speed": lambda ctx: _sum_for("speed", ctx),
        "yield": lambda ctx: _sum_for("yield", ctx),
        "cost_reduction": lambda ctx: min(0.6, _sum_for("resource_cost_reduction", ctx)),
        "buffer_tiers": lambda ctx: _sum_for("buffer_capacity", ctx),
        "leak_reduction": lambda ctx: _sum_for("leak_rate_reduction", ctx),
        "fuel_reduction": lambda ctx: min(0.75, _sum_for("fuel_consumption_reduction", ctx)),
    }


def default_industrial_state():
    return {
        "v": 2,
        "cards": [],
        "research_log": [],
        "researched": [],
        "warehouses": [],                # [{id, name, level, inv:{item:qty}}]
        "caps_bought": {"mining": 0, "wood": 0, "processing": 0},
        "trades": [],
        "last_tick": None,
        "next_id": 1,
        "power": {"supply": 0.0, "demand": 0.0, "ratio": 1.0},
    }


def _new_warehouse(wid, name, level=0):
    return {"id": wid, "name": name, "level": level, "inv": {}}


# Card `type` names that only ever existed as physical grid fittings in
# the old pipe/wire/filter/valve/storage-node/market-depot system - none
# of these are real tech-tree items or machines, so they can't be routed
# through the warehouse-only production model at all. An old save that
# still has some of these placed gets them cleanly removed on next load
# (see ensure_state below) rather than sitting around inert.
_LEGACY_GRID_FIXTURE_TYPES = {
    "Crude Hollow Pipe", "Clay Pipe", "Bronze Pipe", "Steel Pipe", "Composite Pipe",
    "Crude Conductive Wire", "Insulated Copper Line", "Grid Cable", "Industrial Bus Line",
    "Item Filter", "Precision Sorter", "Fluid Valve",
    "Storage Node", "Market Depot", "Basic Storage Bag",
}


def ensure_state(d):
    """Always call this before touching industrial state. Besides filling
    in missing top-level keys, it's what makes an OLD save (from before
    this warehouse/card rework - the spatial grid, pipes, wires,
    rotation era, and even the single-warehouse era right after that)
    load cleanly on a new version: obsolete structure is stripped, but
    no actual progress - researched nodes, owned machines, banked
    resources - is ever lost. Idempotent and cheap, safe on every
    request rather than needing a one-time "migrate my save" step."""
    ind = d.get("industrial")
    if not isinstance(ind, dict) or not ind:
        ind = default_industrial_state()
        ind["warehouses"] = [_new_warehouse("w1", "Main Warehouse")]
        d["industrial"] = ind
    base = default_industrial_state()
    for k, v in base.items():
        ind.setdefault(k, v)

    # ── Migration: old single-warehouse model (a flat `inv` dict +
    # `bag_level`, no `warehouses` list at all) → a real warehouses list.
    # Every item that had been mined/produced is kept, just folded into a
    # first "Main Warehouse" at the old capacity tier. ──
    if not ind["warehouses"]:
        legacy_inv = ind.pop("inv", None) or {}
        legacy_level = int(ind.pop("bag_level", 0) or 0)
        ind["warehouses"] = [_new_warehouse("w1", "Main Warehouse", legacy_level)]
        ind["warehouses"][0]["inv"] = legacy_inv
    ind.pop("inv", None)
    ind.pop("bag_level", None)
    main_wh = ind["warehouses"][0]
    main_inv = main_wh.setdefault("inv", {})

    # ── Migration: the grid/pipe/wire era. `links` no longer means
    # anything and is dropped. Any card that was purely a pipe/wire/
    # filter/valve/storage-node/market-depot fixture is removed too -
    # but first, anything sitting in its old buf_in/buf_out is salvaged
    # into the Main Warehouse rather than discarded, so nobody loses
    # real resources purely because the transport system they were
    # sitting in doesn't exist anymore. ──
    ind.pop("links", None)
    kept_cards = []
    for c in ind.get("cards", []):
        if c.get("type") in _LEGACY_GRID_FIXTURE_TYPES:
            for buf_key in ("buf_in", "buf_out"):
                for item, qty in (c.get(buf_key) or {}).items():
                    if float(qty) > 0:
                        main_inv[item] = float(main_inv.get(item, 0)) + float(qty)
            continue
        for buf_key in ("buf_in", "buf_out"):
            for item, qty in (c.get(buf_key) or {}).items():
                if float(qty) > 0:
                    main_inv[item] = float(main_inv.get(item, 0)) + float(qty)
        for stale_field in ("x", "y", "rot", "cfg", "branch_rules", "buf_in", "buf_out"):
            c.pop(stale_field, None)
        # ── Migration: input_warehouse (singular, from the first
        # warehouse-based cut of this rework) → input_warehouses (a
        # list) - a card can now be told to pull from several
        # warehouses at once. ──
        if "input_warehouse" in c:
            old_single = c.pop("input_warehouse")
            if old_single and "input_warehouses" not in c:
                c["input_warehouses"] = [old_single]
        c.setdefault("active", True)
        kept_cards.append(c)
    ind["cards"] = kept_cards

    # Backfill warehouse routing for every surviving miner/forester/
    # processor/fueled-generator card - an old save (or a card placed
    # before a second warehouse existed) simply points at whichever
    # warehouse is first, until the person deliberately re-routes it.
    default_wh_id = main_wh["id"]
    for c in ind["cards"]:
        dom = card_domain(c)
        gspec = generator_spec(c.get("type"))
        if dom in ("mining", "wood") or is_processor(c):
            c.setdefault("output_warehouse", default_wh_id)
        if is_processor(c):
            if not c.get("input_warehouses"):
                c["input_warehouses"] = [default_wh_id]
        if gspec and gspec.get("fuel"):
            if not c.get("input_warehouses"):
                c["input_warehouses"] = [default_wh_id]
        elif gspec and not gspec.get("fuel"):
            # A fuel-less generator (Solar Panel, Wind Turbine, the
            # starter hand-crank) needs no warehouse at all - strip any
            # stale field so its card never shows an input selector.
            c.pop("input_warehouses", None)

    # Free starter placements already used by an older save: whatever starter
    # items / bare-hands cards it owns count as its one free copy.
    if "free_placed" not in ind:
        used = []
        for c in ind["cards"]:
            if c.get("type") in STARTER_MACHINE_NAMES and c["type"] not in used:
                used.append(c["type"])
            dom = card_domain(c)
            if c.get("family") and dom in ("mining", "wood") and f"hands:{dom}" not in used:
                used.append(f"hands:{dom}")
        ind["free_placed"] = used
    # Upgraded miner cards must carry their CURRENT family's name as type.
    for c in ind["cards"]:
        fam = c.get("family")
        if fam and fam != HANDS_FAMILY and NODES_BY_ID.get(fam):
            c["type"] = NODES_BY_ID[fam]["name"]
    ind["v"] = 2
    return ind


def _new_id(ind):
    nid = ind.get("next_id", 1)
    ind["next_id"] = nid + 1
    return f"c{nid}"


# ── Per-warehouse storage capacity tiers - a person can dedicate a
# small one to a fussy fuel stockpile and a huge one to bulk ore without
# paying to upgrade both together. ──
WAREHOUSE_CAPACITY_LEVELS = [
    {"name": "Small Bag", "capacity": 500},
    {"name": "Medium Bag", "capacity": 1500},
    {"name": "Big Bag", "capacity": 5000},
    {"name": "Crate", "capacity": 20000},
    {"name": "Warehouse", "capacity": 100000},
    {"name": "Grand Warehouse", "capacity": 500000},
]
WAREHOUSE_UPGRADE_NERDS = [int(x * ECON_COST_MULT) for x in [0, 300, 900, 2500, 7000, 18000]]
WAREHOUSE_NEW_BASE_COST = int(1200 * ECON_COST_MULT)
WAREHOUSE_NEW_COST_GROWTH = 1.9
WAREHOUSE_MAX_COUNT = 8

BAG_LEVELS = WAREHOUSE_CAPACITY_LEVELS               # legacy alias
BAG_UPGRADE_NERDS = WAREHOUSE_UPGRADE_NERDS           # legacy alias


def get_warehouse(ind, warehouse_id):
    for w in ind.get("warehouses", []):
        if w["id"] == warehouse_id:
            return w
    whs = ind.get("warehouses") or []
    return whs[0] if whs else None


def get_warehouses(ind, warehouse_ids):
    """Resolves a LIST of warehouse ids (a card's configured input
    sources) to the actual warehouse dicts, silently dropping any id
    that no longer exists. Falls back to [the first warehouse] if the
    list is empty/entirely invalid, so a card is never left pointing at
    nothing."""
    all_wh = ind.get("warehouses") or []
    by_id = {w["id"]: w for w in all_wh}
    resolved = [by_id[wid] for wid in (warehouse_ids or []) if wid in by_id]
    if resolved:
        return resolved
    return [all_wh[0]] if all_wh else []


def default_warehouse_id(ind):
    whs = ind.get("warehouses") or []
    return whs[0]["id"] if whs else None


def warehouse_capacity(w):
    lvl = max(0, min(int(w.get("level", 0)), len(WAREHOUSE_CAPACITY_LEVELS) - 1))
    return WAREHOUSE_CAPACITY_LEVELS[lvl]["capacity"]


def warehouse_used(w):
    return sum(float(q) for q in (w.get("inv") or {}).values())


def next_warehouse_upgrade_cost(w):
    lvl = int(w.get("level", 0))
    if lvl >= len(WAREHOUSE_UPGRADE_NERDS) - 1:
        return None
    return WAREHOUSE_UPGRADE_NERDS[lvl + 1]


def next_new_warehouse_cost(ind):
    n = len(ind.get("warehouses") or [])
    if n >= WAREHOUSE_MAX_COUNT:
        return None
    return round(WAREHOUSE_NEW_BASE_COST * (WAREHOUSE_NEW_COST_GROWTH ** (n - 1)))


def combined_available(warehouses, item):
    """How much of `item` exists across a SET of warehouses combined -
    what a multi-warehouse-sourced card actually checks against."""
    return sum(float((w.get("inv") or {}).get(item, 0)) for w in warehouses)


def consume_across(warehouses, needs):
    """Deducts `needs` ({item: qty}) spread across the given warehouses
    in order, draining each one before moving to the next. Caller must
    already have confirmed combined_available() covers every need."""
    for item, qty in needs.items():
        remaining = float(qty)
        for w in warehouses:
            if remaining <= 1e-9:
                break
            inv = w.setdefault("inv", {})
            have = float(inv.get(item, 0))
            take = min(have, remaining)
            if take > 0:
                inv[item] = have - take
                if inv[item] <= 1e-9:
                    del inv[item]
                remaining -= take


def combined_room(warehouses):
    """How much free space is available RIGHT NOW summed across a set of
    warehouses - used to decide if a produced batch has anywhere to go.
    (Only ever meaningful for a single-warehouse OUTPUT target in
    practice, since output always targets exactly one warehouse, but
    written generally in case that ever changes.)"""
    return sum(max(0.0, warehouse_capacity(w) - warehouse_used(w)) for w in warehouses)


def card_domain(card):
    # Miner cards carry an explicit domain (the bare-hands family has no tree
    # item to derive one from); everything else derives from its item record.
    if card.get("domain") in ("mining", "wood"):
        return card["domain"]
    rec = ITEMS.get(card["type"])
    if not rec:
        return None
    node = NODES_BY_ID.get(rec["node"])
    cat = (node or {}).get("category")
    if cat == "mining_tools":
        return "mining"
    if cat == "wood_tools":
        return "wood"
    return None


def is_processor(card):
    rec = ITEMS.get(card["type"])
    if not rec or not rec["is_machine"]:
        return False
    if generator_spec(card["type"]):
        return False   # generators supply power; they are not processing blocks
    if card_domain(card) in ("mining", "wood"):
        return False
    return True


GENERATOR_OUTPUTS = {
    "Crude Hand-Crank Generator": {"power": 4.0, "fuel": None},
    "Coal Power Plant": {"power": 60.0, "fuel": {"Coal (Processed)": 0.05}},
    "Gas Power Plant": {"power": 85.0, "fuel": {"Natural Gas": 0.04}},
    "Wind Turbine": {"power": 40.0, "fuel": None},
    "Solar Panel": {"power": 30.0, "fuel": None},
    "Diesel Generator": {"power": 50.0, "fuel": {"Diesel": 0.05}},
}
_GENERATOR_ALIASES = {
    "coal power station": {"power": 60.0, "fuel": {"Coal (Processed)": 0.05}},
    "gas power station": {"power": 85.0, "fuel": {"Natural Gas": 0.04}},
}


def generator_spec(name):
    spec = GENERATOR_OUTPUTS.get(name)
    if spec:
        return spec
    return _GENERATOR_ALIASES.get((name or "").lower().strip())


# Higher-tier machines run every job faster (= less total time per item).
# Applies to ALL processor cards automatically via machine_tier(), so any
# production card added in future inherits it with no extra work.
MACHINE_TIER_SPEED_BONUS = {0: 0.0, 1: 0.05, 2: 0.12, 3: 0.22, 4: 0.35, 5: 0.5}


def machine_tier(card):
    rec = ITEMS.get(card["type"]) or {}
    era = rec.get("era") or "starter"
    return {"starter": 0, "primitive": 1, "early_metallurgy": 2,
            "industrial": 3, "advanced": 4, "precious": 5}.get(era, 2)


def _buff_ctx(card):
    rec = ITEMS.get(card["type"]) or {}
    dom = card_domain(card)
    kind = "mining" if dom == "mining" else ("wood" if dom == "wood" else "machine")
    if card.get("family"):
        fam_node = NODES_BY_ID.get(card["family"]) or {}
        return {"kind": kind, "name": card["type"], "node": card["family"],
                "category": fam_node.get("category")}
    return {"kind": kind, "name": card["type"], "node": rec.get("node"),
            "category": rec.get("category")}


# ═══════════════════════════════════════════════════════════════════
# ── Study-hours accounting ──
# ═══════════════════════════════════════════════════════════════════

_STATUS_MULT = {"Done": 1.0, "Partial": 0.5, "Skipped": 0.0}


def compute_lifetime_study_hours(d):
    mins = 0.0
    for r in d.get("self_study", []):
        mins += r.get("minutes", 0) * _STATUS_MULT.get(r.get("status", "Done"), 1.0)
    return mins / 60.0


def research_hours_spent(ind):
    return sum(float(r.get("hours", 0)) for r in ind.get("research_log", []))


def available_study_hours(d, ind):
    return compute_lifetime_study_hours(d) - research_hours_spent(ind)


def week_key_of(date_str):
    try:
        from datetime import datetime as _dt
        date = _dt.strptime(date_str[:10], "%Y-%m-%d")
    except Exception:
        return None
    iso = date.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def compute_weekly_study_hours(d, week=None):
    week = week or week_key_of(now_iso())
    mins = 0.0
    for r in d.get("self_study", []):
        if week_key_of(r.get("date", "")) != week:
            continue
        mins += r.get("minutes", 0) * _STATUS_MULT.get(r.get("status", "Done"), 1.0)
    return mins / 60.0


def industrial_weekly_multiplier(weekly_hours):
    if weekly_hours <= WEEKLY_MULT_LOWER_HOURS:
        return 1.0
    bonus = min(WEEKLY_MULT_MAX - 1.0, (weekly_hours - WEEKLY_MULT_LOWER_HOURS) * WEEKLY_MULT_RATE)
    return round(1.0 + bonus, 4)


def rare_luck_bonus(weekly_hours):
    if weekly_hours <= WEEKLY_MULT_LOWER_HOURS:
        return 0.0
    return min(LUCK_BONUS_MAX, (weekly_hours - WEEKLY_MULT_LOWER_HOURS) * 0.008)


def now_iso():
    import time
    return time.strftime("%Y-%m-%dT%H:%M:%S")


# ═══════════════════════════════════════════════════════════════════
# ── Caps (how many miner/forester/processing CARDS you may run at
# once - a count limit, unrelated to any physical space) ──
# ═══════════════════════════════════════════════════════════════════


def cap_limit(ind, domain, researched_set):
    base = CAPS_BASE.get(domain, 0)
    bought = int((ind.get("caps_bought") or {}).get(domain, 0))
    granted = sum(1 for nid, dom in CAP_GRANT_NODES.items() if dom == domain and nid in researched_set)
    return base + bought + granted


def next_cap_cost(ind, domain):
    bought = int((ind.get("caps_bought") or {}).get(domain, 0))
    mx = CAP_MAX_PURCHASES.get(domain, 0)
    if bought >= mx:
        return None
    return round(CAP_COST_BASE.get(domain, 200) * (CAP_COST_GROWTH ** bought))


# ═══════════════════════════════════════════════════════════════════
# ── Cross-warehouse helpers for things that don't care WHICH warehouse
# (research costs, tool-level costs) - as opposed to a card's own
# configured input_warehouses, which DOES care. ──
# ═══════════════════════════════════════════════════════════════════


def total_inventory(ind):
    total = {}
    for w in ind.get("warehouses", []):
        for item, qty in (w.get("inv") or {}).items():
            total[item] = total.get(item, 0) + float(qty)
    return total


def consume_from_warehouses(ind, needs):
    consume_across(ind.get("warehouses", []), needs)


# ═══════════════════════════════════════════════════════════════════
# ── Simulation tick ──
# No grid, no pipes, no wires. Every miner/forester writes straight into
# whichever ONE warehouse it's pointed at (card["output_warehouse"]).
# Every processor reads its inputs from a SET of warehouses the person
# has explicitly chosen (card["input_warehouses"], can be more than
# one - it drains them in the order listed) and writes outputs to ONE
# chosen warehouse. Power is one shared pool: every active generator
# contributes to a single supply number, every active power-hungry card
# draws from a single demand number, and a shortfall uniformly slows
# every consumer down - this is the "switch any of them off to
# load-balance" model.
# ═══════════════════════════════════════════════════════════════════


def _parse_ts(s):
    from datetime import datetime
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S")
    except Exception:
        return None


def run_tick(d, ind, now_ts=None):
    now_str = now_iso()
    last = ind.get("last_tick")
    if not last:
        ind["last_tick"] = now_str
        return 0.0
    last_dt = _parse_ts(last)
    now_dt = _parse_ts(now_str)
    if not last_dt or not now_dt:
        ind["last_tick"] = now_str
        return 0.0
    dt = (now_dt - last_dt).total_seconds()
    if dt < TICK_MIN_INTERVAL_S:
        return 0.0
    dt = min(dt, MAX_TICK_CATCHUP_SECONDS)

    cards = ind.get("cards", [])
    if cards:
        weekly_h = compute_weekly_study_hours(d)
        mult = industrial_weekly_multiplier(weekly_h)
        luck = rare_luck_bonus(weekly_h)
        buffs = buffs_for_state(set(ind.get("researched", [])))
        power = _tick_power(ind, cards, dt, mult, buffs)
        ind["power"] = {"supply": round(power["supply"], 2), "demand": round(power["demand"], 2),
                        "ratio": round(power["ratio"], 3)}
        # Phase 1: every miner/forester computes what it WOULD produce over dt.
        # Output is then applied per warehouse, scaled FAIRLY if the warehouse
        # lacks room - previously the first card/first item in the pool filled
        # all remaining space, starving every other resource after a long gap.
        pending = {}
        for card in cards:
            if card.get("active") is False:
                continue
            if card_domain(card) in ("mining", "wood"):
                family = card.get("family")
                ratio = power["ratio"] if family in POWERED_TOOL_IDS else 1.0
                res = _miner_output(ind, card, dt, mult, luck, buffs, ratio)
                if res:
                    w, produced = res
                    pending.setdefault(w["id"], (w, []))[1].append(produced)
        _apply_miner_outputs(pending)
        # Phase 2: processors.
        for card in cards:
            if card.get("active") is False:
                continue
            if card_domain(card) not in ("mining", "wood") and is_processor(card):
                _tick_processor(ind, card, dt, mult, buffs, power["ratio"])

    ind["last_tick"] = now_str
    return dt


def miner_energy_draw(card):
    fam = card.get("family")
    if not fam:
        return 0.0
    ladder = MINING_LADDER if card_domain(card) == "mining" else WOOD_LADDER
    if fam in POWERED_TOOL_IDS:
        powered = [f for f in ladder if f in POWERED_TOOL_IDS]
        pidx = powered.index(fam) if fam in powered else 0
        return ENERGY_DRAW_POWERED_MINER_BASE + ENERGY_DRAW_POWERED_MINER_STEP * pidx
    # Hand-tool era (Bare Hands through Carbide) - small, gently scaling draw.
    hand_ladder = [HANDS_FAMILY] + [f for f in ladder if f not in POWERED_TOOL_IDS]
    hidx = hand_ladder.index(fam) if fam in hand_ladder else 0
    return round(ENERGY_DRAW_HAND_TOOL_BASE + ENERGY_DRAW_HAND_TOOL_STEP * hidx, 2)


def processor_energy_draw(card):
    era = (ITEMS.get(card["type"]) or {}).get("era") or "starter"
    return ENERGY_DRAW_BY_ERA.get(era, 5.0)


def processor_has_request(card):
    rq = card.get("request_qty")
    return rq is not None and int(card.get("request_done", 0)) < int(rq)


def processor_is_working(ind, card):
    """True only while the card is on, has an unfinished Production
    Request, has the inputs for it, and has somewhere to put the output."""
    if card.get("active") is False or not processor_has_request(card):
        return False
    jobs = _jobs_for_machine(card["type"])
    if card.get("request_item"):
        jobs = [j for j in jobs if card["request_item"] in j["outputs"]] or jobs
    in_ws = get_warehouses(ind, card.get("input_warehouses"))
    out_w = get_warehouse(ind, card.get("output_warehouse"))
    if not in_ws or not out_w or not jobs:
        return False
    if warehouse_capacity(out_w) - warehouse_used(out_w) <= 0:
        return False
    return any(all(combined_available(in_ws, k) >= v for k, v in j["inputs"].items()) for j in jobs)


def card_energy_demand(ind, card):
    if card.get("active") is False:
        return 0.0
    if is_processor(card):
        return processor_energy_draw(card) if processor_is_working(ind, card) else 0.0
    if card_domain(card) in ("mining", "wood"):
        return miner_energy_draw(card)
    return 0.0


def power_snapshot(d, ind):
    """Instantaneous supply/demand for display and for the tick - computed
    fresh from the cards as they are RIGHT NOW (toggling a card, or a
    fuel stock running out, is reflected immediately, not on the next
    five-second tick). Never consumes fuel."""
    cards = ind.get("cards", [])
    mult = industrial_weekly_multiplier(compute_weekly_study_hours(d))
    demand = sum(card_energy_demand(ind, c) for c in cards)
    supply = 0.0
    for card in cards:
        if card.get("active") is False:
            continue
        gspec = generator_spec(card["type"])
        if not gspec:
            continue
        fuel = gspec.get("fuel")
        if fuel:
            ws = get_warehouses(ind, card.get("input_warehouses"))
            if not ws or not all(combined_available(ws, f) > 0 for f in fuel):
                continue
        supply += gspec["power"] * mult
    ratio = 1.0 if demand <= 0 else max(DEFICIT_SLOWDOWN_FLOOR, min(1.0, supply / demand))
    return {"supply": round(supply, 2), "demand": round(demand, 2), "ratio": round(ratio, 3)}


def _tick_power(ind, cards, dt, mult, buffs):
    """One shared power pool for the whole workspace. Demand is every
    ACTIVE, actually-working card's draw; supply is every ACTIVE
    generator's rated output, scaled down if a FUELED one can't fully
    feed its own need from its own configured input_warehouses. The
    supply/demand ratio then uniformly throttles every consumer."""
    demand = sum(card_energy_demand(ind, c) for c in cards)

    rated_total = 0.0
    gens = []
    for card in cards:
        if card.get("active") is False:
            continue
        gspec = generator_spec(card["type"])
        if gspec:
            gens.append((card, gspec))
            rated_total += gspec["power"] * mult

    used_frac = 0.0 if rated_total <= 0 else min(1.0, demand / rated_total)
    supply = 0.0
    for card, gspec in gens:
        fuel_map = gspec.get("fuel")
        if not fuel_map:
            supply += gspec["power"] * mult
            continue
        warehouses = get_warehouses(ind, card.get("input_warehouses"))
        if not warehouses:
            continue
        fr = 1.0 - buffs["fuel_reduction"](_buff_ctx(card))
        needs = {}
        for fname, rate in fuel_map.items():
            need = rate * dt * used_frac * fr
            if need > 0:
                needs[fname] = need
        burn_ratio = 1.0
        for fname, need in needs.items():
            have = combined_available(warehouses, fname)
            burn_ratio = min(burn_ratio, (have / need) if need > 0 else 1.0)
        burn_ratio = max(0.0, min(1.0, burn_ratio))
        if burn_ratio > 0:
            consume_across(warehouses, {k: v * burn_ratio for k, v in needs.items()})
        supply += gspec["power"] * mult * burn_ratio

    ratio = 1.0 if demand <= 0 else max(DEFICIT_SLOWDOWN_FLOOR, min(1.0, supply / max(0.001, demand)))
    return {"supply": supply, "demand": demand, "ratio": ratio}


def _miner_base_rate(family, domain_ladder, level):
    if family == HANDS_FAMILY:
        return HAND_TOOL_BASE_RATE * HAND_TOOL_LEVEL_MULT[0]
    if family in POWERED_TOOL_IDS:
        powered = [f for f in domain_ladder if f in POWERED_TOOL_IDS]
        pidx = powered.index(family) if family in powered else 0
        return POWERED_TOOL_BASE_RATE + POWERED_TOOL_RATE_STEP * pidx
    idx = domain_ladder.index(family) if family in domain_ladder else 0
    lvl = min(3, max(1, int(level)))
    return HAND_TOOL_BASE_RATE * HAND_TOOL_LEVEL_MULT[lvl - 1] * (1 + 0.6 * idx)


def _reachable_raws(family, domain):
    if domain == "wood":
        return list(WOOD_ITEMS)
    if family == HANDS_FAMILY:
        tier = HANDS_REACH_TIER
    else:
        tier = MINING_REACH.get(family, 1)
    return RAW_POOL.get(tier, RAW_POOL[1])


def _miner_output(ind, card, dt, mult, luck, buffs, powered_ratio):
    """Returns (warehouse, {item: qty}) this miner/forester produces over dt
    seconds, or None. Does not touch the warehouse (see _apply_miner_outputs)."""
    dom = card_domain(card)
    ladder = MINING_LADDER if dom == "mining" else WOOD_LADDER
    family = card.get("family")
    if not family:
        return None
    w = get_warehouse(ind, card.get("output_warehouse")) or get_warehouse(ind, None)
    if not w:
        return None
    ctx = _buff_ctx(card)
    speed = (1.0 + buffs["speed"](ctx)) * powered_ratio
    base = _miner_base_rate(family, ladder, int(card.get("level", 1)))
    rate = base * speed * mult
    pool = _reachable_raws(family, dom)
    if not pool:
        return None
    produced = {}
    if card.get("mode", "mixed") == "focus" and card.get("focus") in pool:
        produced[card["focus"]] = rate * FOCUS_MODE_MULT * dt
    else:
        luck_w = 1.0 + luck * 6.0
        weights = []
        for it in pool:
            r = rarity_of_raw(it)
            weights.append(RARITY_WEIGHT.get(r, 10) * (luck_w if r >= 3 else 1.0))
        total_w = sum(weights) or 1.0
        for it, wgt in zip(pool, weights):
            produced[it] = rate * dt * (wgt / total_w)
    return w, produced


def _apply_miner_outputs(pending):
    """Per warehouse: sum everything its miners produced; if it exceeds free
    room, scale ALL of it down by the same factor so every resource (and
    every miner) gets its proportional share."""
    for w, lst in pending.values():
        totals = {}
        for produced in lst:
            for it, q in produced.items():
                if q > 0:
                    totals[it] = totals.get(it, 0.0) + q
        total = sum(totals.values())
        if total <= 0:
            continue
        room = max(0.0, warehouse_capacity(w) - warehouse_used(w))
        factor = min(1.0, room / total)
        if factor <= 0:
            continue
        inv = w.setdefault("inv", {})
        for it, q in totals.items():
            inv[it] = float(inv.get(it, 0)) + q * factor


_JOBS_CACHE = {}


def _jobs_for_machine(machine_name):
    if machine_name in _JOBS_CACHE:
        return _JOBS_CACHE[machine_name]
    jobs = []
    for out, r in RECIPES.items():
        if r["machine"] == machine_name:
            jobs.append({"inputs": r["inputs"], "outputs": r["outputs"], "secs": r["secs"], "build": r.get("build", False)})
    _JOBS_CACHE[machine_name] = jobs
    return jobs


def _tick_processor(ind, card, dt, mult, buffs, powered_ratio):
    """Reads inputs from card['input_warehouses'] (a LIST - drained in
    the order given), writes outputs to the single card['output_warehouse'].

    A processor with NO unfinished Production Request produces NOTHING and
    draws no power. A request commits to ONE specific output (a machine can
    have many recipes) and counts ITEMS, not batches: it stops as soon as
    that many of the item exist, then the card sits idle until the next
    request."""
    if not processor_has_request(card):
        card["prog"] = 0.0
        return
    jobs = _jobs_for_machine(card["type"])
    if not jobs:
        return
    req_item = card.get("request_item")
    req_qty = int(card["request_qty"])
    if req_item:
        jobs = [j for j in jobs if req_item in j["outputs"]] or jobs
    in_ws = get_warehouses(ind, card.get("input_warehouses"))
    out_w = get_warehouse(ind, card.get("output_warehouse")) or get_warehouse(ind, None)
    if not in_ws or not out_w:
        return
    ctx = _buff_ctx(card)
    tier_bonus = MACHINE_TIER_SPEED_BONUS.get(machine_tier(card), 0.0)
    speed = (1.0 + buffs["speed"](ctx)) * (1.0 + tier_bonus) * mult * powered_ratio
    yld = 1.0 + buffs["yield"](ctx)
    cr = buffs["cost_reduction"](ctx)
    prog = float(card.get("prog", 0.0))
    out_inv = out_w.setdefault("inv", {})

    for job in jobs:
        inputs = {k: v * (1.0 - cr) for k, v in job["inputs"].items()}
        if not all(combined_available(in_ws, k) >= v for k, v in inputs.items()):
            continue
        room = max(0.0, warehouse_capacity(out_w) - warehouse_used(out_w))
        if room <= 0:
            continue
        per_batch = max(1.0, job.get("secs", 8.0))
        prog += dt * speed
        while prog >= per_batch:
            if not all(combined_available(in_ws, k) >= v for k, v in inputs.items()):
                prog = 0.0
                break
            if max(0.0, warehouse_capacity(out_w) - warehouse_used(out_w)) <= 0:
                break
            consume_across(in_ws, inputs)
            for k, v in job["outputs"].items():
                out_inv[k] = float(out_inv.get(k, 0)) + v + (yld - 1.0) * v
            prog -= per_batch
            made = job["outputs"].get(req_item, 1) if req_item else 1
            card["request_done"] = int(card.get("request_done", 0)) + int(made)
            if int(card["request_done"]) >= req_qty:
                prog = 0.0
                break
        card["prog"] = prog
        return
    card["prog"] = prog


# ═══════════════════════════════════════════════════════════════════
# ── Research validation ──
# ═══════════════════════════════════════════════════════════════════


def research_check(d, ind, node_id):
    node = NODES_BY_ID.get(node_id)
    if not node:
        return False, "Unknown research node"
    if node_id in set(ind.get("researched", [])):
        return False, "Already researched"
    have = set(ind.get("researched", []))
    missing_pre = [p for p in (node.get("prerequisites") or []) if p not in have]
    if missing_pre:
        return False, "Prerequisites missing: " + ", ".join(
            NODES_BY_ID[p]["name"] for p in missing_pre if p in NODES_BY_ID)
    avail = available_study_hours(d, ind)
    cost = float(node.get("study_hours", 0))
    if avail < cost:
        return False, f"Not enough study hours (need {cost:g}h, have {avail:.1f}h)"
    inv = total_inventory(ind)
    short = []
    for r in (node.get("resource_requirements") or []):
        if float(inv.get(r["item"], 0)) < float(r.get("quantity", 0)):
            short.append(f"{r['item']} ×{r.get('quantity')}")
    if short:
        return False, "Missing resources (from any warehouse): " + ", ".join(short)
    return True, None


def apply_research(d, ind, node_id):
    ok, err = research_check(d, ind, node_id)
    if not ok:
        return False, err
    node = NODES_BY_ID[node_id]
    consumed = {}
    for r in (node.get("resource_requirements") or []):
        consumed[r["item"]] = float(r.get("quantity", 0))
    consume_from_warehouses(ind, consumed)
    ind["research_log"].append({
        "id": node_id, "hours": float(node.get("study_hours", 0)),
        "date": now_iso(), "consumed": consumed,
    })
    ind["researched"] = sorted(set(ind.get("researched", [])) | {node_id})
    return True, None


# ═══════════════════════════════════════════════════════════════════
# ── Stock market ──
# ═══════════════════════════════════════════════════════════════════

# Base prices (Nerds per unit) — DRAFT heuristics by category/era/rarity with
# hand overrides for signature goods.
_BASE_PRICE_CATEGORY = {
    "starter_kit": 3, "primitive_tools": 4, "mining_tools": 18, "wood_tools": 14,
    "metallurgy_foundations": 6, "ore_coal": 2, "ore_salt": 2, "ore_gypsum": 3,
    "ore_copper": 6, "ore_tin": 7, "ore_zinc": 6, "ore_iron": 6, "ore_lead": 5,
    "ore_sulfur": 6, "ore_quartz": 8, "ore_silver": 14, "ore_nickel": 13,
    "ore_cobalt": 16, "ore_chromium": 15, "ore_manganese": 12, "ore_aluminum": 15,
    "ore_lithium": 22, "ore_graphite": 11, "ore_fluorite": 12, "ore_barite": 10,
    "ore_gold": 40, "ore_platinum": 55, "ore_palladium": 60, "ore_rhodium": 70,
    "ore_iridium": 66, "ore_ruthenium": 58, "ore_osmium": 62, "ore_tungsten": 34,
    "ore_titanium": 38, "ore_gemstone": 48,
    "alloys": 14, "mechanical": 12, "electrical": 16, "energy": 30,
    "energy_storage": 26, "chemistry": 14, "construction": 9, "wood_processing": 8,
    "textiles": 10, "paper_goods": 4, "luxury_goods": 90, "electronics": 45,
    "consumer_goods": 28, "vehicles": 130, "military": 190, "fabricator": 40,
    "engineering": 24, "efficiency": 0, "glassmaking": 10,
}
_ERA_MULT = {"starter": 0.6, "primitive": 0.8, "early_metallurgy": 1.0,
             "industrial": 1.5, "advanced": 2.6, "precious": 3.4}

BASE_PRICE_OVERRIDES = {
    "CPU": 900, "RAM Module": 420, "Microchip (Basic Logic)": 140,
    "Tank": 5200, "Automobile": 2400, "Motorcycle": 1100, "Truck": 1900,
    "Heavy Diesel Engine": 950, "Electric Motor": 320,
    "Diamond Ring": 1500, "Gold Ring": 480, "Platinum Necklace": 1150,
    "Lithium-Ion Battery Pack": 260, "Solid-State Battery": 520,
    "Computer": 1600, "Radio": 180, "Calculator": 90, "Music Player": 340,
    "Digital Multimeter": 210, "Precision Instrument Set": 480,
}


# Expansion-pack price overrides (defined earlier in the file, applied here
# once the base table exists).
BASE_PRICE_OVERRIDES.update({k: v for k, v in _EXPANSION_BASE_PRICE.items()})

def base_price(item_name):
    if item_name in BASE_PRICE_OVERRIDES:
        return float(BASE_PRICE_OVERRIDES[item_name])
    rec = ITEMS.get(item_name)
    if not rec:
        # Raw/mined commodities (Wood, Clay, Raw Copper, ...) priced by rarity
        # tier — these are the economy's baseline goods.
        if item_name in _RAW_COMMODITY_SET:
            tier = rarity_of_raw(item_name) if item_name.startswith("Raw ") else 1
            return {1: 2.0, 2: 6.0, 3: 14.0, 4: 40.0}.get(tier, 2.0)
        return 5.0
    cat_p = _BASE_PRICE_CATEGORY.get(rec.get("category"), 8)
    mult = _ERA_MULT.get(rec.get("era"), 1.0)
    return max(0.5, round(cat_p * mult * (0.9 if rec.get("is_machine") else 1.0), 1))


# Volatility classes: how wildly a commodity swings (per-commodity override
# possible; default derives from tier of goods).
VOLATILITY_OVERRIDES = {"CPU": 0.30, "RAM Module": 0.28, "Tank": 0.22,
                        "Diamond Ring": 0.34, "Gold Ring": 0.26}


def volatility(item_name):
    if item_name in VOLATILITY_OVERRIDES:
        return VOLATILITY_OVERRIDES[item_name]
    p = base_price(item_name)
    if p >= 800:
        return 0.26
    if p >= 200:
        return 0.22
    if p >= 50:
        return 0.19
    return 0.16


def seasonality(month_idx):
    """Shared annual wave; month_idx 0..11 (sim January..December)."""
    return math.sin((month_idx / 12.0) * 2 * math.pi - math.pi / 2)  # −1..1


# ── Deterministic noise walk ──

def _hash32(s):
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _noise_points(item, cycle, points=13, seed_extra=""):
    rng = random.Random(_hash32(f"{item}|{cycle}|{seed_extra}"))
    return [rng.uniform(-1.0, 1.0) for _ in range(points)]


def _cos_interp(vals, t):
    n = len(vals) - 1
    x = max(0.0, min(1.0, t)) * n
    i = int(x)
    f = x - i
    a = vals[i]
    b = vals[min(i + 1, n)]
    f2 = (1 - math.cos(f * math.pi)) / 2
    return a * (1 - f2) + b * f2


# ── World events ──
# Event template catalog (§6 Internet app). Selector kinds:
#   {"kind":"items","items":[...]} exact commodities
#   {"kind":"category","match":"electronics"} item category contains
#   {"kind":"raw_tier","tier":2} all raw materials of a rarity tier
EVENT_TEMPLATES = []


def _evt(title, sel, pct, days, decay="linear", tag="economy", blurb=""):
    # NOTE: `days` is legacy from the old compressed-time schedule; the
    # weekly scheduler (_week_events) assigns every pick its own 1-3
    # REAL-day duration. Kept in signatures so the authored table stays
    # easy to read/extend.
    EVENT_TEMPLATES.append({
        "title": title, "sel": sel, "pct": pct, "days": days,
        "decay": decay, "tag": tag, "blurb": blurb,
    })


def _raw_tier(tier):
    return {"kind": "raw_tier", "tier": tier}


def _cat(match):
    return {"kind": "category", "match": match}


def _items(*names):
    return {"kind": "items", "items": list(names)}


# War & geopolitical
_evt("Border Conflict Disrupts Ore Shipments", _raw_tier(2), 22, 40, "exp", "war",
     "Armed skirmishes close two major freight corridors.")
_evt("Ceasefire Signed; Shipping Lanes Reopen", _raw_tier(2), -14, 25, "linear", "war",
     "Markets calm as blocked routes clear their backlog.")
_evt("Naval Blockade Chokes Petroleum Trade", _cat("chemistry"), 30, 2, "exp", "war")
_evt("Defense Contracts Announced", _cat("military"), 26, 50, "linear", "war")
_evt("Demilitarization Deal Slumps Ordnance Demand", _cat("military"), -24, 40, "linear", "war")
_evt("Strait Mine Fields Delay Tanker Traffic", _cat("chemistry"), 27, 2, "exp", "war")
_evt("Peace Summit Boosts Consumer Confidence", _cat("consumer_goods"), 12, 30, "linear", "war")
_evt("Sanctions Package Targets Alloy Exports", _cat("alloys"), 19, 42, "exp", "war")
_evt("Reconstruction Boom After Ceasefire", _cat("construction"), 21, 55, "linear", "war")
_evt("Mercenary Surge Drains Ammo Stockpiles", _items("Artillery Shell", "Propellant Charge", "Black Powder"), 33, 1, "exp", "war")

# Shortage & supply
_evt("Copper Strike Enters Third Week", _items("Raw Copper", "Copper Ingot", "Copper Wire"), 25, 36, "exp", "shortage")
_evt("Bauxite Refinery Fire Halts Output", _items("Raw Aluminum (Bauxite)", "Aluminum Ingot"), 28, 30, "exp", "shortage")
_evt("Container Ship Blocks Key Canal", _raw_tier(2), 15, 18, "linear", "shortage")
_evt("Lithium Brine Wells Underproduce", _items("Raw Lithium", "Lithium-Ion Battery Cell"), 31, 3, "exp", "shortage")
_evt("Sawmill Labor Walkout Spreads", _items("Planks", "Plywood", "Wood"), 17, 22, "linear", "shortage")
_evt("Silicon Wafer Shortage Bites Chipmakers", _items("Semiconductor-Grade Silicon Wafer", "CPU", "RAM Module", "Microchip (Basic Logic)"), 29, 3, "exp", "shortage")
_evt("Rare Earth Export Quotas Tightened", _raw_tier(4), 24, 50, "exp", "shortage")
_evt("Cement Kilns Idle for Emissions Repair", _items("Cement", "Concrete"), 14, 20, "linear", "shortage")
_evt("Paper Mill Water Restrictions", _items("Paper", "Blank Book", "Bound Journal"), 12, 2, "linear", "shortage")
_evt("Gemstone Mines Flooded After Storms", _items("Raw Gemstone", "Cut Gemstone"), 30, 34, "exp", "shortage")
_evt("Glass Furnace Collapse Cuts Output", _items("Glass", "Tempered Glass Window"), 20, 2, "exp", "shortage")
_evt("Harbor Crane Failure Backlogs Exports", _raw_tier(3), 13, 15, "linear", "shortage")
_evt("Coal Seam Gas Incident Shuts Pit", _items("Raw Coal", "Coal (Processed)"), 22, 24, "exp", "shortage")
_evt("Textile Mill Cotton Backlog", _cat("textiles"), 15, 22, "linear", "shortage")

# Tech breakthroughs
_evt("Photolithography Leap Shrinks Die Sizes", _cat("electronics"), 24, 55, "linear", "tech")
_evt("New Solid-State Electrolyte Announced", _items("Solid-State Battery Cell"), 35, 3, "exp", "tech")
_evt("Open-Source CPU Design Goes Viral", _items("CPU"), -12, 30, "linear", "tech",
     "Hobbyist fabs undercut proprietary pricing.")
_evt("Cheap Polymer Catalyst Patented", _cat("chemistry"), 16, 40, "linear", "tech")
_evt("Autonomous Forestry AI Certified", _cat("wood_processing"), 18, 42, "linear", "tech")
_evt("Room-Temp Superconductor Claim Debunked", _items("Copper Wire"), -9, 1, "linear", "tech")
_evt("Robotic Assembly Line Breakthrough", _cat("vehicles"), 20, 50, "linear", "tech")
_evt("Lab-Grown Gemstones Indistinguishable", _items("Cut Gemstone", "Gold Ring", "Gold Necklace"), -22, 3, "exp", "tech")
_evt("Desalination Membrane Innovation", _cat("chemistry"), 11, 30, "linear", "tech")
_evt("Quantum Sensor Miniaturized", _cat("electronics"), 14, 35, "linear", "tech")

# Weather & nature
_evt("Monsoon Floods Rice and Cotton Belts", _cat("textiles"), 18, 26, "exp", "weather")
_evt("Record Cold Snap Spikes Heating Demand", _items("Coal (Processed)", "Wood"), 26, 2, "exp", "weather")
_evt("Mild Winter Softens Fuel Orders", _items("Coal (Processed)",), -15, 2, "linear", "weather")
_evt("Hurricane Season Forces Rig Evacuations", _cat("chemistry"), 28, 2, "exp", "weather")
_evt("Drought Cuts Hydro Reservoirs", _cat("energy"), 14, 30, "linear", "weather")
_evt("Perfect Harvest Weather Calms Food Prices", _cat("botanarium"), -12, 20, "linear", "weather")
_evt("Wildfires Threaten Timber Country", _items("Wood", "Planks"), 19, 26, "exp", "weather")
_evt("Earthquake Damages Smelter Row", _cat("alloys"), 23, 32, "exp", "weather")
_evt("Volcanic Ash Grounds Air Freight", _raw_tier(3), 16, 18, "linear", "weather")
_evt("Blizzard Locks Mountain Passes", _raw_tier(1), 12, 14, "linear", "weather")

# Regulation & policy
_evt("Carbon Tax Expands to Cement and Steel", _items("Cement", "Concrete", "Steel Ingot"), 17, 60, "linear", "regulation")
_evt("Mining Safety Mandate Adds Costs", _raw_tier(2), 12, 55, "linear", "regulation")
_evt("Jewelry Hallmark Law tightens", _cat("luxury_goods"), 9, 40, "linear", "regulation")
_evt("Export Subsidies for Green Tech", _items("Solar Panel", "Wind Turbine", "Lithium-Ion Battery Cell"), 20, 3, "linear", "regulation")
_evt("Import Tariffs on Finished Electronics", _cat("electronics"), 15, 50, "linear", "regulation")
_evt("Logging Concessions Suspended", _items("Wood", "Planks"), 21, 36, "exp", "regulation")
_evt("Interest Rate Cut Fuels Building Boom", _cat("construction"), 18, 45, "linear", "regulation")
_evt("Ammo Serialization Rules Confuse Buyers", _cat("military"), -13, 30, "linear", "regulation")
_evt("Recycling Rebate Damps Virgin Metal Demand", _raw_tier(3), -10, 35, "linear", "regulation")
_evt("Data Center Zoning Approved", _items("CPU", "RAM Module"), 17, 2, "linear", "regulation")

# Markets & sentiment
_evt("Speculators Pile Into Precious Metals", _raw_tier(4), 21, 28, "exp", "market")
_evt("Precious Metals Bubble Bursts", _raw_tier(4), -24, 26, "exp", "market")
_evt("Tech Sector Earnings Beat Expectations", _cat("electronics"), 15, 30, "linear", "market")
_evt("Auto Loan Rates Climb", _cat("vehicles"), -14, 40, "linear", "market")
_evt("Home Renovation Craze Sweeps Nation", _cat("construction"), 16, 36, "linear", "market")
_evt("Luxury Spending Slows Globally", _cat("luxury_goods"), -17, 34, "linear", "market")
_evt("Study Culture Drives Notebook Sales", _items("Bound Journal", "Blank Book", "Paper"), 22, 1, "linear", "market")
_evt("Fitness Trend Lifts Synthetic Textiles", _items("Synthetic Fabric"), 18, 24, "linear", "market")
_evt("Investors Flee to Hard Assets", _raw_tier(4), 15, 22, "linear", "market")
_evt("Venture Capital Freezes Hardware Startups", _cat("electronics"), -12, 28, "linear", "market")

# Celebrations & culture
_evt("World's Fair Showcases Industry", _cat("consumer_goods"), 13, 30, "linear", "culture")
_evt("Wedding Season Peaks", _cat("luxury_goods"), 19, 20, "linear", "culture")
_evt("Film Prop Demands Retro Radios", _items("Radio"), 26, 14, "exp", "culture")
_evt("Grand Prix Season Revs Parts Demand", _cat("vehicles"), 14, 24, "linear", "culture")
_evt("Holiday Gift Rush Begins", _cat("consumer_goods"), 22, 18, "linear", "culture")
_evt("Museum Buys Historic Tank Collection", _cat("military"), 12, 16, "linear", "culture")
_evt("Chess Olympiad Boosts Book Printing", _items("Blank Book", "Bound Journal"), 15, 1, "linear", "culture")
_evt("Cosplay Con Drives Fabric Sales", _cat("textiles"), 13, 14, "linear", "culture")

# Accidents & oddities
_evt("Freak Hailstorm Ruins Glass Roofs", _items("Glass"), 24, 1, "exp", "accident")
_evt("Rail Derailment Snarls Inland Freight", _raw_tier(2), 14, 1, "linear", "accident")
_evt("Cyberattack Hits Port Logistics", _raw_tier(3), 17, 1, "exp", "accident")
_evt("Whale Blocks Shipping Channel (Again)", _raw_tier(1), 8, 1, "linear", "accident")
_evt("Factory Robot Goes Rogue, Delights Internet", _cat("electronics"), 9, 1, "linear", "accident")
_evt("Counterfeit Tool Ring Busted", _cat("consumer_goods"), 11, 1, "linear", "accident")
_evt("Sinkhole Swallows Parking Lot", _items("Concrete", "Cement"), 15, 1, "linear", "accident")
_evt("Heatwave Overloads Grids", _cat("energy"), 18, 1, "exp", "accident")
_evt("Locust Swarms Threaten Plantations", _cat("botanarium"), 16, 1, "exp", "accident")
_evt("Sunken Treasure Hoard Hits Market", _cat("luxury_goods"), -14, 1, "linear", "accident")

# Energy markets
_evt("OPEC-Equivalent Announces Output Cuts", _cat("chemistry"), 26, 2, "exp", "energy")
_evt("Fracking Boom Floods Fuel Market", _items("Coal (Processed)",), -19, 2, "linear", "energy")
_evt("Nuclear Refueling Outages Spread", _cat("energy"), 13, 2, "linear", "energy")
_evt("Record Solar Farm Comes Online", _items("Solar Panel"), -11, 3, "linear", "energy")
_evt("Grid Battery Mandate Passes", _cat("energy_storage"), 21, 3, "linear", "energy")
_evt("Coal Plant Retirements Accelerate", _items("Coal (Processed)", "Raw Coal"), -12, 3, "linear", "energy")
_evt("Wind Year Beats Forecasts", _items("Wind Turbine"), 12, 2, "linear", "energy")
_evt("Uranium Shortage Scares Utilities", _cat("energy"), 16, 2, "exp", "energy")

# Agriculture & Botanarium life
_evt("Bumper Grain Harvest Presses Prices", _cat("botanarium"), -13, 2, "linear", "agriculture")
_evt("Greenhouse Subsidy Program Launches", _cat("botanarium"), 17, 3, "linear", "agriculture")
_evt("Heirloom Seed Craze Among Collectors", _cat("botanarium"), 20, 1, "linear", "agriculture")
_evt("Frost Warning Sweeps Orchard Country", _cat("botanarium"), 22, 1, "exp", "agriculture")
_evt("Farm-To-Table Dining Trend Peaks", _cat("botanarium"), 15, 2, "linear", "agriculture")
_evt("Irrigation Canal Repairs Finish Early", _cat("botanarium"), -9, 2, "linear", "agriculture")

# Labor & industry
_evt("Dockworkers Strike Freezes Exports", _raw_tier(2), 18, 2, "exp", "labor")
_evt("Welders' Overtime Deal Speeds Shipyards", _cat("vehicles"), 12, 2, "linear", "labor")
_evt("Apprenticeship Drive Eases Skills Gap", _cat("mechanical"), 10, 3, "linear", "labor")
_evt("Sawmill Safety Walkout Ends", _cat("wood_processing"), 9, 1, "linear", "labor")

# Discovery & culture
_evt("Museum Unveils Restored Ancient Tank", _cat("military"), 10, 1, "linear", "culture")
_evt("Space Telescope Images Go Viral", _cat("electronics"), 12, 2, "linear", "culture")
_evt("Renaissance Fair Season Begins", _cat("luxury_goods"), 13, 2, "linear", "culture")
_evt("Documentary Glamorizes Deep Mining", _raw_tier(3), 8, 2, "linear", "culture")

# Health & society
_evt("Flu Season Strains Supply Chains", _raw_tier(2), 11, 2, "exp", "health")
_evt("Wellness Trend Boosts Herbal Produce", _cat("botanarium"), 14, 2, "linear", "health")
_evt("Ergonomics Rules Reshape Tool Design", _cat("consumer_goods"), 9, 2, "linear", "health")

# Fashion & trends
_evt("Raw-Hem Steel Furniture Trend Explodes", _items("Steel Plate", "Metal Plate"), 16, 2, "exp", "fashion")
_evt("Copper Accent Decor All the Rage", _items("Copper Ingot", "Copper Wire"), 15, 2, "linear", "fashion")
_evt("Minimalism Cuts Ornament Demand", _cat("luxury_goods"), -11, 2, "linear", "fashion")
_evt("Neon Sign Revival in Nightlife Districts", _cat("electronics"), 12, 2, "linear", "fashion")

# Infrastructure & government spending
_evt("High-Speed Rail Bill Signed", _cat("construction"), 19, 3, "linear", "infrastructure")
_evt("Bridge Retrofit Program Announced", _items("Steel Ingot", "Concrete"), 16, 3, "linear", "infrastructure")
_evt("Rural Broadband Trenching Spree", _items("Copper Wire", "Plastic Casing"), 13, 2, "linear", "infrastructure")
_evt("Water Treatment Upgrades Funded", _items("Metal Rod", "Plastic Casing"), 14, 2, "linear", "infrastructure")
_evt("Port Dredging Contract Awarded", _cat("construction"), 11, 2, "linear", "infrastructure")

# Space & aviation
_evt("Satellite Launch Contract Awarded", _cat("electronics"), 15, 2, "linear", "space")
_evt("Rocket Test Failure Grounds Fleets", _cat("electronics"), -10, 1, "linear", "space")
_evt("Astronaut Program Recruits Engineers", _items("CPU", "RAM Module"), 13, 2, "linear", "space")
_evt("Airline Fleet Renewal Order Placed", _items("Basic Motor", "Metal Rod"), 14, 2, "linear", "aviation")
_evt("Volcanic Ash Cloud Halts Flights", _cat("electronics"), 8, 1, "exp", "aviation")

# Gaming & esports
_evt("Esports Finals Break Viewership Records", _items("CPU", "RAM Module", "LED Panel"), 18, 2, "exp", "gaming")
_evt("Retro Console Nostalgia Wave", _items("Copper Wire", "Plastic Casing"), 12, 2, "linear", "gaming")
_evt("Chip Supply Squeezed by GPU Demand", _items("CPU", "Semiconductor-Grade Silicon Wafer"), 21, 2, "exp", "gaming")
_evt("Gaming Cafe Franchise Expands", _items("Server", "LED Panel"), 16, 2, "linear", "gaming")

# Film & media
_evt("Blockbuster Shoots Practical Effects", _items("Steel Plate", "Synthetic Rubber"), 11, 1, "linear", "media")
_evt("Streaming Wars Drive Server Farms", _items("Server", "Fiber Optic Cable"), 19, 3, "linear", "media")
_evt("Award Season Glamour Demands Jewels", _items("Gold Necklace", "Cut Gemstone"), 17, 1, "exp", "media")
_evt("Documentary Exposes Sweatshop Suppliers", _cat("textiles"), -12, 2, "linear", "media")

# Sports
_evt("Marathon Season Boosts Bike Sales", _items("Bicycle"), 20, 2, "exp", "sports")
_evt("Stadium Construction Boom", _cat("construction"), 15, 3, "linear", "sports")
_evt("Team Jersey Sponsorship Gold Rush", _cat("textiles"), 10, 2, "linear", "sports")
_evt("Scandal Sours Merchandise Demand", _cat("consumer_goods"), -9, 1, "linear", "sports")

# Tourism & hospitality
_evt("Coastal Resort Expansion Approved", _items("Glass", "Concrete"), 13, 3, "linear", "tourism")
_evt("Backpacking Trend Revives Camping Gear", _items("Vacuum Flask", "Camping Stove"), 18, 2, "exp", "tourism")
_evt("Cruise Line Orders New Liners", _cat("vehicles"), 14, 2, "linear", "tourism")
_evt("Travel Advisory Dents Hotel Renovations", _cat("construction"), -10, 2, "linear", "tourism")

# Rail & logistics
_evt("Freight Rail Electrification Program", _items("Copper Wire", "Voltage Regulator"), 17, 3, "linear", "rail")
_evt("High-Speed Train Prototype Unveiled", _items("Gearbox", "Drivetrain Assembly"), 16, 2, "linear", "rail")
_evt("Postal Service Buys Electric Vans", _items("Delivery Truck", "Lithium-Ion Battery Cell"), 15, 2, "linear", "rail")
_evt("Last-Mile Delivery Robot Pilots Expand", _items("Microcontroller", "Basic Motor"), 18, 2, "exp", "rail")

# Art & literature
_evt("Sculptor Sparks Bronze Renaissance", _items("Bronze Ingot", "Brass Ingot"), 15, 2, "linear", "art")
_evt("Indie Author Boom Lifts Bookbinding", _items("Blank Book", "Bound Journal"), 14, 2, "linear", "literature")
_evt("Public Library Modernization Fund", _items("Paper", "LED Panel"), 11, 2, "linear", "literature")
_evt("Street Art Festival Repels Investors", _cat("luxury_goods"), -8, 1, "linear", "art")

# Finance & insurance
_evt("Insurers Mandate Smart Sprinklers", _items("Microcontroller", "Copper Wire"), 12, 2, "linear", "finance")
_evt("Commodity Index Fund Launches", _raw_tier(3), 9, 2, "linear", "finance")
_evt("Credit Crunch Freezes Factory Upgrades", _cat("mechanical"), -13, 2, "linear", "finance")
_evt("Vault Builders Report Record Orders", _cat("military"), 9, 1, "linear", "finance")

# Crypto & datacenters
_evt("Mining Rig Ban Rumors Whipsaw Chips", _items("CPU", "Power Supply Unit"), 22, 1, "exp", "crypto")
_evt("Cold Storage Vaults Go Mainstream", _items("Cardboard Box", "Wooden Crate"), 10, 2, "linear", "crypto")

# Seasonal & weather extras
_evt("Typhoon Season Batters Refineries", _cat("chemistry"), 20, 2, "exp", "weather")
_evt("Perfect Growing Season Forecast", _cat("botanarium"), -11, 2, "linear", "weather")
_evt("First Snow Spurs Sled and Cart Rush", _items("Handcart", "Wooden Crate"), 16, 1, "exp", "weather")
_evt("Heat Dome Strains Air Conditioning", _items("Aluminum Ingot", "Copper Wire", "Microcontroller"), 19, 2, "exp", "weather")

# Policy extras
_evt("Right-To-Repair Law Passed", _items("Printed Circuit Board (PCB)", "Bolt"), 12, 2, "linear", "regulation")
_evt("Tariff Quota on Imported Steel", _items("Steel Ingot", "Steel Beam"), 18, 3, "linear", "regulation")
_evt("Green Certification Subsidies End", _items("Solar Panel"), -13, 2, "linear", "regulation")
_evt("National Broadband Map Embarrasses ISPs", _items("Fiber Optic Cable"), 11, 2, "linear", "regulation")

# Oddities extra round
_evt("Cat Becomes Factory Foreman, Output Soars", _cat("mechanical"), 7, 1, "linear", "accident")
_evt("Time Capsule Yields Antique Tools", _cat("mining_tools"), 11, 1, "linear", "accident")
_evt("Celebrity Chef Endorses Kitchen Knives", _items("Kitchen Knife Set"), 24, 1, "exp", "culture")
_evt("Viral Video Features Handcart Racing", _items("Handcart"), 21, 1, "exp", "culture")

# Substitute pairs (§6): when one side shocks, the other drifts opposite.
SUBSTITUTE_PAIRS = [
    ("Aluminum Ingot", "Copper Ingot"),
    ("Steel Ingot", "Aluminum Ingot"),
    ("Polymer Resin", "Metal Plate"),
    ("Synthetic Fabric", "Cloth Bolt"),
    ("Solid-State Battery Cell", "Lithium-Ion Battery Cell"),
    ("Nickel-Iron Battery Cell", "Lead-Acid Battery Cell"),
]


# ── Cycle/event schedule ──

# ── Commodity universe ──
# Every tradable good: tree-produced items + raw mined/foraged materials
# (Wood, Clay, Sand, Gravel, Limestone + every "Raw X" ore) — §6 says EVERY
# movable item is tracked with a fluctuating price.
RAW_COMMODITIES = (
    RARITY_T1 + RARITY_T2 + RARITY_T3 + RARITY_T4 +
    ["Wood", "Clay", "Sand", "Raw Gravel", "Limestone"]
)
# de-dup while keeping order
_RAW_COMMODITY_SET = set(RAW_COMMODITIES)
COMMODITY_UNIVERSE = sorted({n for n, r in ITEMS.items() if not r.get("is_machine")} | _RAW_COMMODITY_SET)


def is_known_commodity(name):
    return name in _RAW_COMMODITY_SET or (name in ITEMS and not ITEMS[name].get("is_machine"))


def commodity_category(name):
    rec = ITEMS.get(name)
    if rec:
        return rec.get("category") or "misc"
    if name == "Wood":
        return "raw_wood"
    if name.startswith("Raw ") or name in ("Clay", "Sand", "Limestone"):
        return "raw_materials"
    return "misc"


def sim_clock(ts_epoch_days):
    """Map real epoch-days → (cycle_index, sim_day 0..360).

    Cycle 0 begins 2026-08-01 (the app's launch month): each real month
    replays one full simulated year (§6), so cycle N is 'Year N+1'.
    """
    anchor = _CYCLE_ANCHOR_EPOCH_DAYS
    shifted = ts_epoch_days - anchor
    cycle = math.floor(shifted / 30)
    day_in_cycle = shifted - cycle * 30        # 0..30 float
    sim_day = min(359.999, max(0.0, day_in_cycle * SIM_DAYS_PER_REAL_DAY))
    return cycle, sim_day


import datetime as _dt_mod
CYCLE_ANCHOR = _dt_mod.datetime(2026, 8, 1)
_CYCLE_ANCHOR_EPOCH_DAYS = (CYCLE_ANCHOR - _dt_mod.datetime(1970, 1, 1)).total_seconds() / 86400.0


def epoch_days_now():
    import time
    return time.time() / 86400.0


# ── World events: refreshed every real-world day (player request) ──
# Each real morning generates a fresh batch of events for THAT day, so a
# player can actually reorganize production around what's happening while
# it's live. Schedules are generated per ISO week from a deterministic seed,
# which keeps multi-day stories ("strike enters its second day") stable and
# identical across restarts.

EXTRA_COMMODITIES = set()   # e.g. Botanarium fruits — registered by routes


def register_extra_commodities(names):
    EXTRA_COMMODITIES.update(names)


def all_commodity_names():
    return sorted(set(COMMODITY_UNIVERSE) | EXTRA_COMMODITIES)


def _date_str_of_epoch_days(epoch_days):
    import time as _t
    return _t.strftime("%Y-%m-%d", _t.localtime(epoch_days * 86400.0))


def today_date_str():
    import time as _t
    return _t.strftime("%Y-%m-%d")


def _shift_date(date_str, days):
    import datetime as _dt
    d = _dt.datetime.strptime(date_str, "%Y-%m-%d") + _dt.timedelta(days=days)
    return d.strftime("%Y-%m-%d")


def _week_anchor(date_str):
    """The Monday of date_str's ISO week — the schedule seed."""
    import datetime as _dt
    d = _dt.datetime.strptime(date_str, "%Y-%m-%d")
    d -= _dt.timedelta(days=d.weekday())
    return d.strftime("%Y-%m-%d")


_WEEK_EVENTS_CACHE = {}


def _week_events(week_anchor):
    """All events running sometime during `week_anchor`'s week. Deliberately
    SPARSE (player request): only ~4 starts per day, mostly single-day runs,
    so a typical day has ~5 active events — enough to plan around without
    drowning the news feed. Durations are REAL days."""
    if week_anchor in _WEEK_EVENTS_CACHE:
        return _WEEK_EVENTS_CACHE[week_anchor]
    rng = random.Random(_hash32("weekevents|" + week_anchor))
    evs = []
    per_day = 4
    for day_offset in range(7):
        picks = rng.sample(range(len(EVENT_TEMPLATES)), min(per_day, len(EVENT_TEMPLATES)))
        for idx in picks:
            tpl = EVENT_TEMPLATES[idx]
            dur = rng.choice([1, 1, 1, 1, 1, 2, 2, 3])   # real days
            jitter = rng.uniform(0.75, 1.35)          # run-to-run magnitude variety
            evs.append({
                "tpl_index": idx,
                "title": tpl["title"], "blurb": tpl.get("blurb", ""),
                "tag": tpl["tag"], "sel": tpl["sel"],
                "pct": round(float(tpl["pct"]) * jitter, 1),
                "start_date": _shift_date(week_anchor, day_offset),
                "days": dur,
                "decay": tpl["decay"],
            })
    evs.sort(key=lambda e: (e["start_date"], e["title"]))
    if len(_WEEK_EVENTS_CACHE) > 12:
        _WEEK_EVENTS_CACHE.clear()
    _WEEK_EVENTS_CACHE[week_anchor] = evs
    return evs


def get_day_events(date_str=None):
    """Events ACTIVE on the given real-world date."""
    date_str = date_str or today_date_str()
    anchor = _week_anchor(date_str)
    out = []
    for ev in _week_events(anchor):
        if ev["start_date"] <= date_str < _shift_date(ev["start_date"], ev["days"]):
            out.append(ev)
    # A week-spanning query near Sunday may reference next week's Monday events.
    if date_str == _shift_date(anchor, 6):
        for ev in _week_events(_shift_date(anchor, 7)):
            if ev["start_date"] == _shift_date(anchor, 7):
                out.append(ev)
    return out


_DAILY_PICKS_CACHE = {}


def daily_picks(date_str=None):
    """§6 'Exchange Spotlight': every real day exactly five commodities get
    a sale-price buff until midnight — concrete production targets."""
    date_str = date_str or today_date_str()
    if date_str in _DAILY_PICKS_CACHE:
        return _DAILY_PICKS_CACHE[date_str]
    pool = all_commodity_names()
    rng = random.Random(_hash32("picks|" + date_str))
    k = min(DAILY_PICK_COUNT, len(pool))
    chosen = rng.sample(pool, k)
    picks = [{"item": c, "pct": round(rng.uniform(DAILY_PICK_PCT_MIN, DAILY_PICK_PCT_MAX), 0)}
             for c in chosen]
    if len(_DAILY_PICKS_CACHE) > 30:
        _DAILY_PICKS_CACHE.clear()
    _DAILY_PICKS_CACHE[date_str] = picks
    return picks


def get_schedule(cycle=None):   # legacy alias — returns TODAY's active events
    return get_day_events()


def _select_matches(sel, item_name):
    kind = sel.get("kind")
    if kind == "items":
        return item_name in sel["items"]
    rec = ITEMS.get(item_name) or {}
    cat = rec.get("category") or ""
    if kind == "category":
        if sel["match"] == "botanarium":
            return item_name in EXTRA_COMMODITIES
        return sel["match"] in cat
    if kind == "raw_tier":
        return rarity_of_raw(item_name) == sel["tier"] and item_name.startswith("Raw ")
    if kind == "chain_from":
        return _in_chain(sel["root"], item_name)
    return False


_CHAIN_DOWN = None


def chain_graph():
    """input item → set of downstream outputs (one production link)."""
    global _CHAIN_DOWN
    if _CHAIN_DOWN is None:
        down = {}
        for out, r in RECIPES.items():
            for inp in r["inputs"]:
                down.setdefault(inp, set()).add(out)
        _CHAIN_DOWN = down
    return _CHAIN_DOWN


def _in_chain(root, item, depth=8):
    if root == item:
        return True
    if depth <= 0:
        return False
    for nxt in chain_graph().get(root, ()): 
        if _in_chain(nxt, item, depth - 1):
            return True
    return False


_EFFECT_CACHE = {}


def event_effect_for_date(item_name, date_str=None, _visited=None):
    """Combined multiplicative event effect on item for a real-world date:
    the day's active news events (strongest MARKET_MAX_STACKING may stack)
    plus the Exchange Spotlight buff if item is one of today's five picks.
    Substitute pairs drift against each other (§6); _visited guards the
    mutual recursion."""
    date_str = date_str or today_date_str()
    _top = _visited is None
    if _top:
        _hit = _EFFECT_CACHE.get((item_name, date_str))
        if _hit is not None:
            return _hit
        _visited = {item_name}
    contribs = []
    for ev in get_day_events(date_str):
        root_hit = _select_matches(ev["sel"], item_name)
        pct = ev["pct"]
        if not root_hit and ev["sel"].get("kind") in ("items", "raw_tier", "category"):
            # pass-through propagation for chained goods (§6 pass-through rate)
            for rt in _event_roots(ev):
                if _in_chain(rt, item_name):
                    pct *= MARKET_PASS_THROUGH
                    root_hit = True
                    break
        if not root_hit:
            continue
        # Same-day decay flavor: exp-decay events fade a little by evening.
        if ev["decay"] == "exp":
            pct *= 0.85
        contribs.append((pct, ev["title"]))
    # Exchange Spotlight buff (the daily five)
    for p in daily_picks(date_str):
        if p["item"] == item_name:
            contribs.append((float(p["pct"]), f"{DAILY_PICK_TITLE}: {p['pct']:+.0f}%"))
    contribs.sort(key=lambda x: -abs(x[0]))
    eff = sum(c for c, _ in contribs[:MARKET_MAX_STACKING])
    detail = [{"title": t, "contrib_pct": round(c, 1)} for c, t in contribs[:MARKET_MAX_STACKING]]
    # Substitutes: opposing drift
    for a, b in SUBSTITUTE_PAIRS:
        if item_name == b:
            other = a
        elif item_name == a:
            other = b
        else:
            continue
        if other in _visited:
            continue
        _visited.add(other)
        sub_eff, sub_detail = event_effect_for_date(other, date_str, _visited)
        if abs(sub_eff) > 1e-9:
            eff -= MARKET_SUBSTITUTE_INVERSE * sub_eff
            detail.append({"title": f"Substitute shift vs {other}",
                           "contrib_pct": round(-MARKET_SUBSTITUTE_INVERSE * sub_eff, 1)})
    eff = max(-MARKET_EVENT_CAP, min(MARKET_EVENT_CAP, eff))
    if _top:
        if len(_EFFECT_CACHE) > 20000:
            _EFFECT_CACHE.clear()
        _EFFECT_CACHE[(item_name, date_str)] = (eff, detail)
    return eff, detail


_EVENT_ROOTS_CACHE = {}


def _event_roots(ev):
    key = ev["tpl_index"]
    if key in _EVENT_ROOTS_CACHE:
        return _EVENT_ROOTS_CACHE[key]
    sel = ev["sel"]
    if sel.get("kind") == "items":
        out = [i for i in sel["items"] if i in ITEMS or i in EXTRA_COMMODITIES]
    elif sel.get("kind") == "raw_tier":
        out = list(RAW_POOL.get(sel["tier"], []))
    elif sel.get("kind") == "category":
        m = sel["match"]
        if m == "botanarium":
            out = sorted(EXTRA_COMMODITIES)
        else:
            out = [name for name, rec in ITEMS.items() if m in (rec.get("category") or "") and not rec.get("is_machine")]
    else:
        out = []
    _EVENT_ROOTS_CACHE[key] = out
    return out


def commodity_price(item_name, epoch_days=None, user_impact=0.0):
    """Live price (Nerds/unit). Deterministic given (item, time):
    seasonal baseline + smooth noise + THAT REAL DAY's events & spotlight."""
    epoch_days = epoch_days if epoch_days is not None else epoch_days_now()
    cycle, sim_day = sim_clock(epoch_days)
    bp = base_price(item_name)
    vol = volatility(item_name)
    month_idx = int(sim_day // 30) % 12
    seasonal = 1.0 + SEASONAL_AMPLITUDE * seasonality(month_idx)
    pts = _noise_points(item_name, cycle)
    noise = 1.0 + NOISE_AMPLITUDE * vol / 0.2 * _cos_interp(pts, (sim_day % 360) / 360.0)
    ev_eff, _ = event_effect_for_date(item_name, _date_str_of_epoch_days(epoch_days))
    ev_mult = 1.0 + ev_eff
    impact = 1.0 - user_impact
    price = bp * seasonal * noise * ev_mult * impact
    price = max(bp * MARKET_FLOOR, min(bp * MARKET_CEILING, price))
    return round(price, 2)


def price_series(item_name, days=360, step_days=1.0, epoch_days=None):
    epoch_days = epoch_days if epoch_days is not None else epoch_days_now()
    start = epoch_days - days / SIM_DAYS_PER_REAL_DAY
    xs, ys = [], []
    t = start
    while t <= epoch_days + 1e-9:
        xs.append(round(t, 3))
        ys.append(commodity_price(item_name, epoch_days=t))
        t += step_days / SIM_DAYS_PER_REAL_DAY
    return xs, ys


def daily_volume_cap(item_name):
    """Realistic per-day trade limits by price bucket (§6)."""
    p = base_price(item_name)
    if p >= 800:
        return 40
    if p >= 200:
        return 120
    if p >= 50:
        return 400
    if p >= 10:
        return 1500
    return 6000


def user_market_impact(ind, item_name, epoch_days=None):
    """Trailing-window net sold volume → depression (buys lift slightly)."""
    import time as _t
    now = epoch_days if epoch_days is not None else _t.time() / 86400.0
    cutoff = now - MARKET_USER_IMPACT_WINDOW_DAYS
    net = 0.0
    cap = daily_volume_cap(item_name) * MARKET_USER_IMPACT_WINDOW_DAYS
    for tr in ind.get("trades", []):
        try:
            ts = tr.get("epoch", 0)
        except Exception:
            continue
        if tr.get("item") != item_name or ts < cutoff:
            continue
        if tr.get("side") == "sell":
            net += float(tr.get("qty", 0))
        else:
            net -= 0.5 * float(tr.get("qty", 0))
    frac = net / max(1.0, float(cap))
    return min(MARKET_USER_IMPACT_MAX, max(-0.10, MARKET_USER_IMPACT_MAX * frac))


def execute_trade_price(ind, item_name, side, qty, epoch_days=None):
    """Fill price with slippage: big orders push price against the trader."""
    impact = user_market_impact(ind, item_name, epoch_days)
    px = commodity_price(item_name, epoch_days, user_impact=impact if side == "sell" else 0.0)
    cap = daily_volume_cap(item_name)
    slip = min(0.15, (qty / max(1, cap)) * 0.15)
    if side == "sell":
        px *= (1.0 - slip)
    else:
        px *= (1.0 + slip)
    return round(px, 2)


def holdings_of(d, ind, item_name):
    """Everything sellable: every industrial warehouse's stock + the
    Botanarium bag stacks."""
    total = 0.0
    for w in ind.get("warehouses", []):
        total += float((w.get("inv") or {}).get(item_name, 0))
    for it in d.get("inventory", []):
        if it.get("item_type") == item_name:
            total += float(it.get("qty", 0))
    return total


def remove_holdings(d, ind, item_name, qty):
    """Take from warehouses in order (first to last), then the
    Botanarium bag. Returns the quantity actually taken."""
    remaining = float(qty)
    for w in ind.get("warehouses", []):
        if remaining <= 1e-9:
            break
        inv = w.setdefault("inv", {})
        have = float(inv.get(item_name, 0))
        take = min(have, remaining)
        if take > 0:
            inv[item_name] = have - take
            if inv[item_name] <= 1e-9:
                del inv[item_name]
            remaining -= take
    if remaining > 1e-9:
        empty = []
        for it in d.get("inventory", []):
            if it.get("item_type") == item_name and remaining > 0:
                cur = float(it.get("qty", 0))
                take2 = min(cur, remaining)
                it["qty"] = int(round(cur - take2))
                remaining -= take2
                if it["qty"] <= 0:
                    empty.append(it)
        for it in empty:
            try:
                d.get("inventory", []).remove(it)
            except ValueError:
                pass
    return float(qty) - max(0.0, remaining)


# ═══════════════════════════════════════════════════════════════════
# ── Snapshot builders for the API ──
# ═══════════════════════════════════════════════════════════════════


def tree_snapshot(d, ind):
    researched = set(ind.get("researched", []))
    avail = available_study_hours(d, ind)
    inv = total_inventory(ind)
    nodes_out = []
    for n in NODES:
        reqs = [{"item": r["item"], "quantity": r.get("quantity", 0),
                 "have": float(inv.get(r["item"], 0))}
                for r in (n.get("resource_requirements") or [])]
        nodes_out.append({
            "id": n["id"], "name": n["name"], "branch": n.get("branch"),
            "category": n.get("category"), "era": n.get("era"),
            "study_hours": n.get("study_hours", 0),
            "prerequisites": n.get("prerequisites") or [],
            "unlocks": n.get("unlocks"), "description": n.get("description"),
            "produces": [{"item": p.get("item"), "is_machine": bool(p.get("is_machine")),
                          "crafted_at": p.get("crafted_at")} for p in (n.get("produces") or [])],
            "effect": n.get("effect"),
            "requirements": reqs,
            "researched": n["id"] in researched,
            "affordable_hours": avail >= float(n.get("study_hours", 0)),
            "affordable_res": all(float(inv.get(r["item"], 0)) >= float(r.get("quantity", 0))
                                  for r in (n.get("resource_requirements") or [])),
        })
    return {
        "meta": TREE.get("meta", {}),
        "nodes": nodes_out,
        "hours": {
            "lifetime": round(compute_lifetime_study_hours(d), 2),
            "spent": round(research_hours_spent(ind), 2),
            "available": round(avail, 2),
            "weekly": round(compute_weekly_study_hours(d), 2),
            "weekly_multiplier": industrial_weekly_multiplier(compute_weekly_study_hours(d)),
            "luck_bonus": round(rare_luck_bonus(compute_weekly_study_hours(d)), 3),
        },
    }


def wiki_snapshot():
    cats = {}
    for name, rec in sorted(ITEMS.items()):
        entry = {
            "name": name, "category": rec["category"], "era": rec["era"],
            "is_machine": rec["is_machine"], "crafted_at": rec["crafted_at"],
            "node": rec["node"], "node_name": (NODES_BY_ID.get(rec["node"]) or {}).get("name"),
            "base_price": base_price(name), "slug": slugify(name),
        }
        r = RECIPES.get(name)
        if r:
            entry["recipe"] = {"machine": r["machine"], "inputs": r["inputs"],
                               "outputs": r["outputs"], "seconds": r["secs"]}
        mb = MACHINE_BUILD_RECIPES.get(name)
        if mb:
            entry["build_recipe"] = {"machine": mb["machine"], "inputs": mb["inputs"]}
        cats.setdefault(rec["category"] or "misc", []).append(entry)
    machines = []
    for mname, mrec in sorted(MACHINES.items()):
        jobs = _jobs_for_machine(mname)
        spec = generator_spec(mname)
        machines.append({
            "name": mname, "category": mrec["category"], "era": mrec["era"],
            "introduced_by": (NODES_BY_ID.get(mrec["node"]) or {}).get("name"),
            "recipes_run": [{"outputs": j["outputs"], "inputs": j["inputs"], "secs": j["secs"]} for j in jobs],
            "place_nerds": MACHINE_PLACE_NERDS.get(mname, 0),
            "build_inputs": (MACHINE_BUILD_RECIPES.get(mname) or {}).get("inputs", {}),
            "generator": spec,
            "slug": slugify(mname),
        })
    return {"categories": cats, "machines": machines,
            "substitutes": SUBSTITUTE_PAIRS}


def market_overview(d, ind, extra_commodities=None):
    names = list(COMMODITY_UNIVERSE)
    if extra_commodities:
        for nm in extra_commodities:
            if nm not in names:
                names.append(nm)
    now = epoch_days_now()
    rows = []
    for nm in names:
        px = commodity_price(nm, now)
        # 24h change — with events refreshed daily this is exactly the
        # "did today's news move this" number the player reasons about.
        prev = commodity_price(nm, now - 1.0)
        change = (px - prev) / prev * 100 if prev else 0
        rows.append({
            "item": nm, "price": px, "change_pct": round(change, 2),
            "base": base_price(nm), "vol": volatility(nm),
            "daily_cap": daily_volume_cap(nm),
            "holdings": holdings_of(d, ind, nm),
            "category": commodity_category(nm),
            "impact": round(user_market_impact(ind, nm) * 100, 1),
        })
    return {"now_epoch_days": round(now, 4), "rows": rows,
            "cycle_info": _cycle_payload(now)}


def _cycle_payload(epoch_days):
    cycle, sim_day = sim_clock(epoch_days)
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    m = int(sim_day // 30) % 12
    d_of_m = int(sim_day % 30) + 1
    return {"cycle": cycle, "sim_day": round(sim_day, 1),
            "label": f"{months[m]} {d_of_m} · Year {cycle + 1}",
            "month": months[m], "year": cycle + 1}


def news_feed(ind=None, limit=140):
    """Internet app payload for TODAY: the Exchange Spotlight five first,
    then every active event. Fresh batch each real morning."""
    now = epoch_days_now()
    today = today_date_str()
    picks = daily_picks(today)
    labels = {}
    out = []
    for ev in get_day_events(today):
        roots = _event_roots(ev)
        out.append({
            "title": ev["title"], "blurb": ev.get("blurb", ""), "tag": ev["tag"],
            "pct": ev["pct"],
            "start_sim": ev["start_date"], "end_sim": f"+{ev['days']}d",
            "status": "active", "decay": ev["decay"],
            "affected_sample": roots[:6], "affected_count": len(roots),
        })
    rank = {"active": 0, "upcoming": 1, "past": 2}
    out.sort(key=lambda e: (rank.get(e["status"], 3), -abs(e["pct"])))
    return {"feed": out[:limit], "picks": picks, "cycle_info": _cycle_payload(now),
            "refresh_note": "A fresh batch of events and new Spotlight picks every real-world morning."}


def item_detail(d, ind, item_name):
    now = epoch_days_now()
    today = today_date_str()
    eff, detail = event_effect_for_date(item_name, today)
    xs, ys = price_series(item_name, days=360, step_days=0.75)
    pick = next((p for p in daily_picks(today) if p["item"] == item_name), None)
    return {
        "item": item_name,
        "base": base_price(item_name), "volatility": volatility(item_name),
        "price": commodity_price(item_name, now),
        "series": {"x": xs, "y": ys},
        "events": detail,
        "event_effect_pct": round(eff, 1),
        "daily_pick": pick,
        "daily_cap": daily_volume_cap(item_name),
        "holdings": holdings_of(d, ind, item_name),
        "cycle_info": _cycle_payload(now),
        "recipe": RECIPES.get(item_name),
        "produced_by": (NODES_BY_ID.get((ITEMS.get(item_name) or {}).get("node")) or {}).get("name"),
        "crafted_at": (ITEMS.get(item_name) or {}).get("crafted_at"),
    }


# ═══════════════════════════════════════════════════════════════════
# ── Tool upgrades & placement costs ──
# A miner/forester card is ALWAYS placed as Bare Hands and then upgraded up
# its own ladder in place (never placed as, or crafted into, a Wooden Pickaxe
# ... Planetary Mining System). Everything placed costs Nerds; the first copy
# of each starter-kit item is free.
# ═══════════════════════════════════════════════════════════════════

TOOL_UPGRADE_NERDS_BASE = int(30 * ECON_COST_MULT)
TOOL_UPGRADE_NERDS_GROWTH = 1.32
_TOOL_MATERIAL = {"wooden": None, "stone": "Limestone", "copper": "Copper Ingot",
                  "bronze": "Bronze Ingot", "iron": "Iron Ingot", "steel": "Steel Ingot",
                  "reinforced": "Stainless Steel Ingot", "carbide": "Tungsten Carbide"}


def tool_ladder(domain):
    return [HANDS_FAMILY] + (MINING_LADDER if domain == "mining" else WOOD_LADDER)


def next_family(family, domain):
    lad = tool_ladder(domain)
    try:
        i = lad.index(family)
    except ValueError:
        return None
    return lad[i + 1] if i + 1 < len(lad) else None


def tool_upgrade_bill(target, domain):
    """(nerds, {item: qty}) to upgrade a card INTO family `target`."""
    lad = tool_ladder(domain)
    idx = max(1, lad.index(target)) if target in lad else 1
    nerds = round(TOOL_UPGRADE_NERDS_BASE * (TOOL_UPGRADE_NERDS_GROWTH ** (idx - 1)))
    items = {}
    if target in POWERED_TOOL_IDS:
        powered = [f for f in lad if f in POWERED_TOOL_IDS]
        p = powered.index(target)
        items = {"Steel Plate": 4 + 2 * p, "Basic Motor": 1 + p // 3, "Circuit Board": 1 + p // 2}
    else:
        mat = _TOOL_MATERIAL.get(target.split("_")[0])
        items["Wood"] = 5 + idx
        if mat:
            items[mat] = 2 + idx
    return nerds, items


def free_placements(ind):
    return set(ind.get("free_placed") or [])


def place_price(ind, key):
    """Nerds to place `key` right now. key is 'hands:mining' / 'hands:wood' or a
    machine name. The first placement of each starter-kit item is free."""
    is_starter = key in ("hands:mining", "hands:wood") or key in STARTER_MACHINE_NAMES
    if is_starter and key not in free_placements(ind):
        return 0
    if key in ("hands:mining", "hands:wood"):
        return HANDS_PLACE_NERDS
    return int(MACHINE_PLACE_NERDS.get(key, MACHINE_ERA_NERDS["industrial"]))
