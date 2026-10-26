#!/usr/bin/env python3
"""Cultivar — Industrial Production & Stock Market HTTP layer.

Thin Flask Blueprint over industrial_core.py. All persistence and currency
helpers are injected once by server.py via init_deps() — this module never
imports server.py (which runs as __main__ and must stay import-cycle-free).

No grid, no pipes, no wires, no rotation. Every owned miner/forester/
processor/generator is just a CARD in a list. A card only ever exposes
the fields it actually uses (a fuel-less generator carries no warehouse
routing at all; a single-recipe machine never asks you to pick a recipe;
a hand-tool miner shows nothing about power) - see _card_public.

Miners write straight into whichever ONE warehouse they're pointed at.
Processors read inputs from a SET of warehouses the person has chosen
(can be more than one - drained in the order listed) and write outputs
to ONE chosen warehouse. Power is a single shared supply/demand pool,
and any card can be switched on/off to load-balance it. Multiple
warehouses are separate, independently-upgradeable storage silos. A
"Production Request" lets a processor build an exact quantity of ONE
specific thing it can make (e.g. "1x Automobile") and then stop, rather
than running forever - and if the machine can make more than one thing,
the request must say which one, so it can never silently build the
wrong item.

Endpoints:
  GET  /api/<name>/industrial/state             full workspace snapshot (ticks first)
  POST /api/<name>/industrial/place              acquire a miner/forester/machine card
  POST /api/<name>/industrial/remove              scrap a card
  POST /api/<name>/industrial/config              on/off, mode/focus, warehouse routing, requests
  POST /api/<name>/industrial/research            research a tech-tree node
  POST /api/<name>/industrial/tool_level          level up a miner/forester family
  POST /api/<name>/industrial/tool_skip           money-skip a miner/forester to the next tier
  POST /api/<name>/industrial/buy_cap             +1 mining/wood/processing card-count slot
  POST /api/<name>/industrial/warehouse/add       build a brand new warehouse
  POST /api/<name>/industrial/warehouse/upgrade   raise one warehouse's capacity tier
  POST /api/<name>/industrial/warehouse/rename    rename a warehouse
  GET  /api/<name>/industrial/tree                tech tree snapshot + affordability
  GET  /api/<name>/industrial/wiki                full production-system documentation
  GET  /api/<name>/market/overview                commodity table
  GET  /api/<name>/market/item/<item>             chart + events + chain detail
  GET  /api/<name>/market/news                    Internet app feed
  POST /api/<name>/market/trade                   buy/sell at simulated prices
  GET  /api/<name>/market/info                    static Info-app pages
"""

import functools

from flask import Blueprint, jsonify, request

import industrial_core as ic

bp = Blueprint("industrial", __name__)

_DEPS = {}


def init_deps(deps):
    """Called once by server.py after all helpers are defined."""
    _DEPS.clear()
    _DEPS.update(deps)


def _need(key):
    if key not in _DEPS:
        raise RuntimeError(f"industrial_routes: missing dep '{key}' (init_deps not called?)")
    return _DEPS[key]


def _profile_data(name):
    ensure_profile = _need("ensure_profile")
    load_data = _need("load_data")
    save_data = _need("save_data")
    ensure_profile(name)
    d = load_data(name)
    return d, lambda: save_data(name, d)


def _err(msg, code=400):
    return jsonify({"error": msg}), code


def _locked(fn):
    """Runs the whole request under the profile's lock. Every industrial
    request is a load -> modify -> save cycle on the same data.json, and the
    page fires several of them at once (place + state refresh + wiki/tree
    lookups); unlocked, a reader could hold the file open while another
    request replaced it, which on Windows fails with a 500 ("Request failed")
    even though the first action had already succeeded."""
    @functools.wraps(fn)
    def wrapper(name, *a, **kw):
        lock_for = _DEPS.get("lock_for")
        if lock_for is None:
            return fn(name, *a, **kw)
        with lock_for(name):
            return fn(name, *a, **kw)
    return wrapper


def _find_card(ind, card_id):
    return next((c for c in ind.get("cards", []) if c["id"] == card_id), None)


# ═══════════════════════════════════════════════════════════════════
# ── State assembly ──
# ═══════════════════════════════════════════════════════════════════


def _skip_cost(nxt_node):
    hours_equivalent = float(nxt_node.get("study_hours", 10)) + sum(ic.TOOL_LEVEL_HOURS)
    return round(hours_equivalent * ic.SKIP_NERDS_PER_HOUR)


def _card_public(card, buffs, ind):
    """Every field here is either universal (id/type/active) or gated
    behind an actual capability check, so a card the frontend renders
    never shows UI for something it can't do (no power fields on a
    hand-tool miner, no warehouse routing on a fuel-less generator, no
    recipe-choice UI implied for a single-recipe machine)."""
    rec = ic.ITEMS.get(card["type"]) or {}
    dom = ic.card_domain(card) if card.get("family") or rec else None
    jobs_raw = ic._jobs_for_machine(card["type"]) if rec.get("is_machine") else []
    jobs = [{"inputs": j["inputs"], "outputs": j["outputs"], "secs": j["secs"],
             "build": bool(j.get("build"))} for j in jobs_raw]
    gspec = ic.generator_spec(card["type"])
    is_proc = ic.is_processor(card)
    powered_tool = card.get("family") in ic.POWERED_TOOL_IDS if card.get("family") else False
    researched = set(ind.get("researched", []))

    out = {
        "id": card["id"], "type": card["type"],
        "slug": ic.slugify(card["type"]),
        "category": rec.get("category"),
        "is_machine": bool(rec.get("is_machine")),
        "domain": dom,
        "era": rec.get("era"),
        "active": card.get("active", True) is not False,
    }

    # ── Miner/forester-only fields ──
    if dom in ("mining", "wood") and card.get("family"):
        ladder = ic.MINING_LADDER if dom == "mining" else ic.WOOD_LADDER
        out["family"] = card["family"]
        out["level"] = card.get("level", 1)
        out["powered_tool"] = powered_tool
        out["base_rate"] = round(ic._miner_base_rate(card["family"], ladder, int(card.get("level", 1))), 4)
        reachable = ic._reachable_raws(card["family"], dom)
        out["reachable"] = reachable
        if len(reachable) > 1:
            out["mode"] = card.get("mode", "mixed")
            out["focus"] = card.get("focus")
        out["output_warehouse"] = card.get("output_warehouse")
        # Real-time CURRENT draw (0 if the card is off), not the rated
        # figure - a hand tool now draws a small amount too, and this
        # must never show power being used by a card that isn't active.
        out["energy_draw"] = ic.card_energy_demand(ind, card)
        nxt = ic.next_family(card["family"], dom)
        nxt_node = ic.NODES_BY_ID.get(nxt) if nxt else None
        if nxt_node:
            nerds, items = ic.tool_upgrade_bill(nxt, dom)
            out["upgrade"] = {"family": nxt, "name": nxt_node["name"], "researched": nxt in researched,
                              "nerds": nerds, "items": items, "skip_nerds": _skip_cost(nxt_node)}
        else:
            out["upgrade"] = None

    # ── Generator-only fields ──
    if gspec:
        out["generator"] = gspec
        if gspec.get("fuel"):
            out["input_warehouses"] = card.get("input_warehouses") or []

    # ── Processor-only fields ──
    if is_proc:
        out["jobs"] = jobs
        # Real-time CURRENT draw - 0 whenever the card isn't actually
        # working (off, idle, no request, starved of inputs), never the
        # flat rated figure a label like "while working" implied.
        out["energy_draw"] = ic.card_energy_demand(ind, card)
        out["energy_draw_rated"] = ic.processor_energy_draw(card)
        out["input_warehouses"] = card.get("input_warehouses") or []
        out["output_warehouse"] = card.get("output_warehouse")
        out["prog"] = round(float(card.get("prog", 0.0)), 2)
        out["request_qty"] = card.get("request_qty")
        out["request_item"] = card.get("request_item")
        out["request_done"] = int(card.get("request_done", 0))
        out["has_request"] = ic.processor_has_request(card)
        out["working"] = ic.processor_is_working(ind, card)

        active_job = None
        if card.get("request_item"):
            active_job = next((j for j in jobs if card["request_item"] in j["outputs"]), None)
        elif jobs:
            active_job = jobs[0]
        out["active_job_secs"] = active_job["secs"] if active_job else None

        # A quick, honest "why isn't this running" hint - only meaningful
        # while there is an unfinished request (an idle machine is idle by
        # design: no request, no production, no power draw).
        blocked = None
        if out["has_request"] and card.get("active", True) is not False and not out["working"]:
            active_jobs = jobs
            if card.get("request_item"):
                active_jobs = [j for j in jobs if card["request_item"] in j["outputs"]] or jobs
            in_ws = ic.get_warehouses(ind, card.get("input_warehouses"))
            out_w = ic.get_warehouse(ind, card.get("output_warehouse"))
            if in_ws and out_w and active_jobs:
                if ic.warehouse_capacity(out_w) - ic.warehouse_used(out_w) <= 0:
                    blocked = f"{out_w.get('name', 'Output warehouse')} is full"
                else:
                    missing = sorted({k for j in active_jobs for k, v in j["inputs"].items()
                                      if ic.combined_available(in_ws, k) < v})
                    blocked = "Waiting on: " + ", ".join(missing[:4]) + ("…" if len(missing) > 4 else "")
        out["blocked_reason"] = blocked

    return out


def _caps_payload(ind, researched):
    caps = {}
    for domain in ("mining", "wood", "processing"):
        limit = ic.cap_limit(ind, domain, researched)
        used = sum(1 for c in ind.get("cards", []) if (_card_cap_domain(c) == domain))
        caps[domain] = {"limit": limit, "used": used, "next_cost": ic.next_cap_cost(ind, domain)}
    return caps


def _card_cap_domain(card):
    dom = ic.card_domain(card)
    if dom in ("mining", "wood"):
        return dom
    if ic.is_processor(card):
        return "processing"
    return None


def _warehouses_payload(ind):
    out = []
    for w in ind.get("warehouses", []):
        lvl = max(0, min(int(w.get("level", 0)), len(ic.WAREHOUSE_CAPACITY_LEVELS) - 1))
        out.append({
            "id": w["id"], "name": w.get("name", w["id"]),
            "level": lvl, "level_name": ic.WAREHOUSE_CAPACITY_LEVELS[lvl]["name"],
            "capacity": ic.warehouse_capacity(w),
            "used": round(ic.warehouse_used(w), 2),
            "next_upgrade_cost": ic.next_warehouse_upgrade_cost(w),
            "inv": {k: round(float(v), 2) for k, v in (w.get("inv") or {}).items()},
        })
    return out


def _state_payload(d, ind, name):
    ic.run_tick(d, ind)
    # Power is always recomputed from the cards as they are RIGHT NOW, so the
    # top bar reflects a toggle/placement immediately instead of waiting for
    # the next tick (which is skipped if under 5s have passed).
    ind["power"] = ic.power_snapshot(d, ind)
    researched = set(ind.get("researched", []))
    buffs = ic.buffs_for_state(researched)
    weekly_h = ic.compute_weekly_study_hours(d)
    cards_out = [_card_public(c, buffs, ind) for c in ind.get("cards", [])]
    balance_fn = _DEPS.get("compute_current_balance")
    nerds = round(balance_fn(name, d), 1) if balance_fn else None
    return jsonify({
        "cards": cards_out,
        "researched": sorted(researched),
        "warehouses": _warehouses_payload(ind),
        "next_warehouse_cost": ic.next_new_warehouse_cost(ind),
        "warehouse_max": ic.WAREHOUSE_MAX_COUNT,
        "hours": {
            "lifetime": round(ic.compute_lifetime_study_hours(d), 2),
            "spent_research": round(ic.research_hours_spent(ind), 2),
            "available": round(ic.available_study_hours(d, ind), 2),
            "weekly": round(weekly_h, 2),
            "weekly_multiplier": ic.industrial_weekly_multiplier(weekly_h),
            "luck_bonus": round(ic.rare_luck_bonus(weekly_h), 3),
        },
        "caps": _caps_payload(ind, researched),
        "ladders": {
            "mining": {"families": [ic.HANDS_FAMILY] + ic.MINING_LADDER,
                       "reach": dict(ic.MINING_REACH, **{ic.HANDS_FAMILY: ic.HANDS_REACH_TIER})},
            "wood": {"families": [ic.HANDS_FAMILY] + ic.WOOD_LADDER,
                     "reach": dict(ic.WOOD_REACH, **{ic.HANDS_FAMILY: ic.HANDS_REACH_TIER})},
            "tool_level_hours": ic.TOOL_LEVEL_HOURS,
        },
        "starter_machines": sorted(ic.STARTER_MACHINE_NAMES),
        "free_placed": sorted(ic.free_placements(ind)),
        "hands_place_nerds": ic.HANDS_PLACE_NERDS,
        "hands_free": {"mining": "hands:mining" not in ic.free_placements(ind),
                       "wood": "hands:wood" not in ic.free_placements(ind)},
        "nerds": nerds,
        "skip_nerds_per_hour": ic.SKIP_NERDS_PER_HOUR,
        "power": ind["power"],
        "last_tick": ind.get("last_tick"),
    })


# ═══════════════════════════════════════════════════════════════════
# ── Cards: place / remove / configure ──
# ═══════════════════════════════════════════════════════════════════


@bp.route("/api/<name>/industrial/state")
@_locked
def industrial_state(name):
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    resp = _state_payload(d, ind, name)
    flush()
    return resp


@bp.route("/api/<name>/industrial/place", methods=["POST"])
@_locked
def industrial_place(name):
    """Acquire a card. Rules:
      - Miners/foresters are ONLY ever placed as Bare Hands; every better tool
        is reached by upgrading that card (see tool_upgrade).
      - Everything costs Nerds to place, scaled by how advanced it is. The
        first copy of each starter-kit item (Bare Hands miner, Bare Hands
        forester, Crude Hand-Crank Generator, Fabricator I) is free.
      - Non-starter machines also consume their build materials."""
    data = request.get_json(force=True)
    ctype = data.get("type")
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    ic.run_tick(d, ind)        # settle elapsed time under the OLD configuration
    researched = set(ind.get("researched", []))

    family = data.get("family")
    domain = data.get("domain") or "mining"
    consumed_build = {}
    price_key = None
    needs = {}

    if family:
        if family != ic.HANDS_FAMILY:
            return _err("Only Bare Hands can be placed - upgrade a card to reach better tools")
        if domain not in ("mining", "wood"):
            return _err("Unknown tool domain")
        limit = ic.cap_limit(ind, domain, researched)
        used = sum(1 for c in ind["cards"] if ic.card_domain(c) == domain)
        if used >= limit:
            return _err(f"{domain.title()} slot cap reached ({used}/{limit}) - buy another cap first")
        ctype = "Hands"
        price_key = f"hands:{domain}"
    else:
        if ctype not in ic.ITEMS:
            return _err("Unknown card type")
        rec = ic.ITEMS[ctype]
        intro = ic._MACHINE_INTRO.get(ctype)
        if not rec["is_machine"]:
            return _err(f"{ctype} is crafted inside machines, not built directly")
        if not (intro in researched or ctype in ic.STARTER_MACHINE_NAMES):
            return _err(f"{ctype} must be researched before it can be built")

        probe = {"id": "_probe", "type": ctype, "family": None}
        if ic.is_processor(probe):
            limit = ic.cap_limit(ind, "processing", researched)
            used = sum(1 for c in ind["cards"] if ic.is_processor(c))
            if used >= limit:
                return _err(f"Processing block cap reached ({used}/{limit}) - upgrade it first")
        price_key = ctype
        if ctype not in ic.STARTER_MACHINE_NAMES:
            needs = dict((ic.MACHINE_BUILD_RECIPES.get(ctype) or {}).get("inputs") or {})

    price = ic.place_price(ind, price_key)
    if needs:
        have = ic.total_inventory(ind)
        short = [f"{k} {int(v - float(have.get(k, 0)))} more" for k, v in needs.items() if float(have.get(k, 0)) < v]
        if short:
            return _err("Build materials missing (from any warehouse): " + ", ".join(short))
    if price > 0:
        balance = _need("compute_current_balance")(name=name, d=d)
        if balance < price:
            return _err(f"Not enough Nerds (need {price}, have {round(balance, 1)})")

    if needs:
        ic.consume_from_warehouses(ind, needs)
        consumed_build = needs
    if price > 0:
        _need("_spend_nerds")(d, f"place:{price_key}", 1, price)
    else:
        fp = ind.setdefault("free_placed", [])
        if price_key not in fp:
            fp.append(price_key)

    default_wh = ic.default_warehouse_id(ind)
    card = {"id": f"c{ind['next_id']}", "type": ctype, "active": True}
    if family:
        card["family"] = family
        card["domain"] = domain
        card["level"] = 1
        card["mode"] = "mixed"
        card["output_warehouse"] = data.get("output_warehouse") or default_wh
    elif ic.is_processor(card):
        card["input_warehouses"] = data.get("input_warehouses") or [default_wh]
        card["output_warehouse"] = data.get("output_warehouse") or default_wh
    else:
        gspec = ic.generator_spec(ctype)
        if gspec and gspec.get("fuel"):
            card["input_warehouses"] = data.get("input_warehouses") or [default_wh]
        # a fuel-less generator (Solar/Wind/the starter hand-crank) gets
        # NO warehouse field at all - it has nothing to route

    ind["next_id"] += 1
    ind["cards"].append(card)
    ind["power"] = ic.power_snapshot(d, ind)
    flush()
    return jsonify({"ok": True, "card": _card_public(card, ic.buffs_for_state(researched), ind),
                    "consumed_build": consumed_build, "nerds_spent": price})


@bp.route("/api/<name>/industrial/remove", methods=["POST"])
@_locked
def industrial_remove(name):
    data = request.get_json(force=True)
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    ic.run_tick(d, ind)
    card = _find_card(ind, data.get("id"))
    if not card:
        return _err("Card not found", 404)
    ind["cards"] = [c for c in ind["cards"] if c["id"] != card["id"]]
    ind["power"] = ic.power_snapshot(d, ind)
    flush()
    return jsonify({"ok": True})


@bp.route("/api/<name>/industrial/config", methods=["POST"])
@_locked
def industrial_config(name):
    """Everything about a card that isn't "how many of it exist" gets
    patched here: on/off (the load-balancing lever), harvest mode/focus
    for miners, which warehouse(s) it reads from / writes to, and
    starting or canceling a Production Request."""
    data = request.get_json(force=True)
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    ic.run_tick(d, ind)        # settle elapsed time under the OLD settings first
    card = _find_card(ind, data.get("id"))
    if not card:
        return _err("Card not found", 404)

    if "active" in data:
        card["active"] = bool(data["active"])
    if "mode" in data:
        card["mode"] = "focus" if data["mode"] == "focus" else "mixed"
    if "focus" in data:
        card["focus"] = data["focus"]

    if "output_warehouse" in data:
        w = ic.get_warehouse(ind, data["output_warehouse"])
        if not w:
            return _err("Unknown warehouse")
        card["output_warehouse"] = w["id"]

    if "input_warehouses" in data:
        # A processor (or fueled generator) can pull from SEVERAL
        # warehouses at once - this is the whole list, not one id.
        ids = data["input_warehouses"]
        if not isinstance(ids, list) or not ids:
            return _err("Pick at least one warehouse to pull from")
        resolved = []
        for wid in ids:
            w = ic.get_warehouse(ind, wid)
            if not w:
                return _err(f"Unknown warehouse: {wid}")
            if w["id"] not in resolved:
                resolved.append(w["id"])
        card["input_warehouses"] = resolved

    if "request_qty" in data:
        rq = data["request_qty"]
        if rq is None:
            card["request_qty"] = None
            card["request_item"] = None
        else:
            try:
                rq = int(rq)
            except (TypeError, ValueError):
                return _err("Request quantity must be a whole number")
            if rq < 1:
                return _err("Request quantity must be at least 1")
            jobs = ic._jobs_for_machine(card["type"])
            valid_outputs = sorted({k for j in jobs for k in j["outputs"]})
            req_item = data.get("request_item")
            if len(valid_outputs) > 1:
                # This machine can make more than one thing - a request
                # MUST commit to exactly one, or ticking could silently
                # keep making something else forever.
                if not req_item or req_item not in valid_outputs:
                    return _err("This machine can make more than one thing - pick which one to build: "
                               + ", ".join(valid_outputs))
                card["request_item"] = req_item
            else:
                card["request_item"] = valid_outputs[0] if valid_outputs else req_item
            card["request_qty"] = rq
            card["request_done"] = 0
            card["prog"] = 0.0
            card["active"] = True   # starting a request always (re)starts the card

    ind["power"] = ic.power_snapshot(d, ind)
    flush()
    return jsonify({"ok": True, "card": _card_public(card, ic.buffs_for_state(set(ind["researched"])), ind)})


# ═══════════════════════════════════════════════════════════════════
# ── Research / tools / caps ──
# ═══════════════════════════════════════════════════════════════════


@bp.route("/api/<name>/industrial/research", methods=["POST"])
@_locked
def industrial_research(name):
    data = request.get_json(force=True)
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    ok, err = ic.apply_research(d, ind, data.get("node_id"))
    if not ok:
        return _err(err)
    flush()
    node = ic.NODES_BY_ID[data["node_id"]]
    return jsonify({"ok": True, "node": data["node_id"],
                    "hours_available": round(ic.available_study_hours(d, ind), 2),
                    "unlocks": node.get("unlocks")})


def _tool_level_cost(family_node, target_level):
    idx = min(max(target_level - 1, 0), len(ic.TOOL_LEVEL_HOURS) - 1)
    hours = ic.TOOL_LEVEL_HOURS[idx]
    resources = {}
    for r in (family_node.get("resource_requirements") or []):
        q = max(1, round((r.get("quantity") or 2) / 3.0)) * max(1, target_level)
        resources[r["item"]] = resources.get(r["item"], 0) + q
    return hours, resources


@bp.route("/api/<name>/industrial/tool_level", methods=["POST"])
@_locked
def industrial_tool_level(name):
    data = request.get_json(force=True)
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    card = _find_card(ind, data.get("id"))
    if not card or ic.card_domain(card) not in ("mining", "wood"):
        return _err("Not a tool card")
    if card.get("family") in ic.POWERED_TOOL_IDS:
        return _err("Machine-era tools improve via upgrade modules, not levels")
    lvl = int(card.get("level", 1))
    if lvl >= 3:
        return _err("Already at max in-family level")
    fam_node = ic.NODES_BY_ID.get(card["family"])
    if not fam_node:
        return _err("Bare hands cannot be leveled further")
    hours, resources = _tool_level_cost(fam_node, lvl + 1)
    if ic.available_study_hours(d, ind) < hours:
        return _err(f"Not enough study hours (need {hours}h)")
    have = ic.total_inventory(ind)
    short = [k for k, v in resources.items() if float(have.get(k, 0)) < v]
    if short:
        return _err("Missing resources (from any warehouse): " + ", ".join(short))
    ic.consume_from_warehouses(ind, resources)
    ind.setdefault("research_log", []).append(
        {"id": f"tool:{card['id']}:{lvl + 1}", "hours": hours, "date": ic.now_iso(),
         "consumed": resources, "label": f"{card['type']} to level {lvl + 1}"})
    card["level"] = lvl + 1
    flush()
    return jsonify({"ok": True, "level": card["level"]})


def _upgrade_tool(name, skip_research):
    """Upgrade a miner/forester card IN PLACE to the next family on its own
    ladder. Costs Nerds + real materials (see ic.tool_upgrade_bill), and needs
    the next family researched - unless the person pays the extra "skip the
    study hours" Nerds price."""
    data = request.get_json(force=True)
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    ic.run_tick(d, ind)
    card = _find_card(ind, data.get("id"))
    if not card or ic.card_domain(card) not in ("mining", "wood") or not card.get("family"):
        return _err("Not a tool card")
    dom = ic.card_domain(card)
    nxt = ic.next_family(card["family"], dom)
    if not nxt:
        return _err("Already at the top of this ladder")
    nxt_node = ic.NODES_BY_ID.get(nxt)
    if not nxt_node:
        return _err("Next tier has no research node")
    is_researched = nxt in set(ind.get("researched", []))
    nerds, items = ic.tool_upgrade_bill(nxt, dom)
    total_nerds = nerds
    if not is_researched:
        if not skip_research:
            return _err(f"Research {nxt_node['name']} in the Tech Tree first (or pay to skip the research)")
        total_nerds += _skip_cost(nxt_node)
    balance = _need("compute_current_balance")(name=name, d=d)
    if balance < total_nerds:
        return _err(f"Not enough Nerds (need {total_nerds}, have {round(balance, 1)})")
    have = ic.total_inventory(ind)
    short = [f"{k} ×{int(v)}" for k, v in items.items() if float(have.get(k, 0)) < v]
    if short:
        return _err("Materials missing (from any warehouse): " + ", ".join(short))
    ic.consume_from_warehouses(ind, items)
    _need("_spend_nerds")(d, f"tool_upgrade:{nxt}", 1, total_nerds)
    ind.setdefault("research_log", []).append(
        {"id": f"upgrade:{card['id']}:{nxt}", "hours": 0, "date": ic.now_iso(),
         "consumed": items, "label": f"{'Money-skip' if not is_researched else 'Upgrade'} to {nxt_node['name']}"})
    card["family"] = nxt
    card["type"] = nxt_node["name"]
    card["level"] = 1
    ind["power"] = ic.power_snapshot(d, ind)
    flush()
    return jsonify({"ok": True, "family": nxt, "name": nxt_node["name"], "cost": total_nerds})


@bp.route("/api/<name>/industrial/tool_upgrade", methods=["POST"])
@_locked
def industrial_tool_upgrade(name):
    return _upgrade_tool(name, skip_research=False)


@bp.route("/api/<name>/industrial/tool_skip", methods=["POST"])
@_locked
def industrial_tool_skip(name):
    """Money-skipping research is no longer offered - every tool upgrade
    must be reached by actually researching it in the Tech Tree. Kept as
    a stub (rather than removed outright) so an old cached page hitting
    this endpoint gets a clear error instead of a 404."""
    return _err("Skipping research for Nerds is no longer available - research the upgrade in the Tech Tree first.")


@bp.route("/api/<name>/industrial/buy_cap", methods=["POST"])
@_locked
def industrial_buy_cap(name):
    data = request.get_json(force=True)
    domain = data.get("domain")
    if domain not in ("mining", "wood", "processing"):
        return _err("Unknown cap domain")
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    cost = ic.next_cap_cost(ind, domain)
    if cost is None:
        return _err("Maximum caps already purchased")
    balance_fn = _need("compute_current_balance")
    balance = balance_fn(name=name, d=d)
    if balance < cost:
        return _err(f"Not enough Nerds (need {cost}, have {round(balance, 1)})")
    _need("_spend_nerds")(d, f"cap_{domain}", 1, cost)
    bought = ind.setdefault("caps_bought", {"mining": 0, "wood": 0, "processing": 0})
    bought[domain] = int(bought.get(domain, 0)) + 1
    flush()
    return jsonify({"ok": True, "domain": domain, "cost": cost})


# ═══════════════════════════════════════════════════════════════════
# ── Warehouses ──
# ═══════════════════════════════════════════════════════════════════


@bp.route("/api/<name>/industrial/warehouse/add", methods=["POST"])
@_locked
def industrial_warehouse_add(name):
    data = request.get_json(silent=True) or {}
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    cost = ic.next_new_warehouse_cost(ind)
    if cost is None:
        return _err(f"Maximum of {ic.WAREHOUSE_MAX_COUNT} warehouses already built")
    balance_fn = _need("compute_current_balance")
    balance = balance_fn(name=name, d=d)
    if balance < cost:
        return _err(f"Not enough Nerds (need {cost}, have {round(balance, 1)})")
    _need("_spend_nerds")(d, "industrial_warehouse", 1, cost)
    wid = f"w{ind['next_id']}"
    ind["next_id"] += 1
    label = (data.get("name") or "").strip()[:40] or f"Warehouse {len(ind['warehouses']) + 1}"
    ind["warehouses"].append(ic._new_warehouse(wid, label))
    flush()
    return jsonify({"ok": True, "warehouse_id": wid, "cost": cost})


@bp.route("/api/<name>/industrial/warehouse/upgrade", methods=["POST"])
@_locked
def industrial_warehouse_upgrade(name):
    data = request.get_json(force=True)
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    w = ic.get_warehouse(ind, data.get("warehouse_id"))
    if not w:
        return _err("Warehouse not found", 404)
    cost = ic.next_warehouse_upgrade_cost(w)
    if cost is None:
        return _err("This warehouse is already at maximum capacity")
    balance_fn = _need("compute_current_balance")
    balance = balance_fn(name=name, d=d)
    if balance < cost:
        return _err(f"Not enough Nerds (need {cost}, have {round(balance, 1)})")
    _need("_spend_nerds")(d, f"warehouse_upgrade:{w['id']}", 1, cost)
    w["level"] = int(w.get("level", 0)) + 1
    flush()
    return jsonify({"ok": True, "warehouse_id": w["id"], "level": w["level"], "cost": cost})


@bp.route("/api/<name>/industrial/warehouse/rename", methods=["POST"])
@_locked
def industrial_warehouse_rename(name):
    data = request.get_json(force=True)
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    w = ic.get_warehouse(ind, data.get("warehouse_id"))
    if not w:
        return _err("Warehouse not found", 404)
    new_name = (data.get("name") or "").strip()
    if not new_name:
        return _err("Enter a name")
    w["name"] = new_name[:40]
    flush()
    return jsonify({"ok": True, "warehouse_id": w["id"], "name": w["name"]})


# ═══════════════════════════════════════════════════════════════════
# ── Tech tree & wiki ──
# ═══════════════════════════════════════════════════════════════════


@bp.route("/api/<name>/industrial/tree")
@_locked
def industrial_tree(name):
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    payload = ic.tree_snapshot(d, ind)
    payload["efficiency_nodes"] = [n["id"] for n in ic.EFFICIENCY_NODES]
    return jsonify(payload)


@bp.route("/api/<name>/industrial/wiki")
@_locked
def industrial_wiki(name):
    return jsonify(ic.wiki_snapshot())


# ═══════════════════════════════════════════════════════════════════
# ── Stock market ──
# ═══════════════════════════════════════════════════════════════════


def _extra_commodities():
    coms = _DEPS.get("plant_commodities") or []
    return [c["item_type"] for c in coms]


def _fruit_labels():
    coms = _DEPS.get("plant_commodities") or []
    return {c["item_type"]: c.get("label") for c in coms}


def _seed_item_types():
    coms = _DEPS.get("plant_commodities") or []
    return {c["item_type"] for c in coms if c.get("is_seed")}


@bp.route("/api/<name>/market/overview")
@_locked
def market_overview(name):
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    ic.run_tick(d, ind)
    flush()
    ov = ic.market_overview(d, ind, extra_commodities=_extra_commodities())
    labels = _fruit_labels()
    fruit_names = set(_extra_commodities())
    seed_names = _seed_item_types()
    for row in ov["rows"]:
        row["label"] = labels.get(row["item"], row["item"])
        if row["item"] in seed_names:
            row["category"] = "botanarium_seeds"
        elif row["item"] in fruit_names:
            row["category"] = "botanarium"
    balance_fn = _need("compute_current_balance")
    ov["nerds"] = round(balance_fn(name=name, d=d), 1)
    ov["holdings_note"] = "Sellable pool = everything in your industrial warehouses + Botanarium bag."
    return jsonify(ov)


@bp.route("/api/<name>/market/item/<path:item>")
@_locked
def market_item(name, item):
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    ic.run_tick(d, ind)
    flush()
    if not ic.is_known_commodity(item) and item not in set(_extra_commodities()):
        return _err("Unknown commodity", 404)
    det = ic.item_detail(d, ind, item)
    det["label"] = _fruit_labels().get(item, item)
    return jsonify(det)


@bp.route("/api/<name>/market/news")
@_locked
def market_news(name):
    return jsonify(ic.news_feed(ic.ensure_state(_profile_data(name)[0])))


@bp.route("/api/<name>/market/trade", methods=["POST"])
@_locked
def market_trade(name):
    data = request.get_json(force=True)
    side = data.get("side")
    item = data.get("item")
    qty = int(data.get("qty", 0))
    if side not in ("buy", "sell"):
        return _err("side must be buy or sell")
    if qty <= 0:
        return _err("Quantity must be positive")
    d, flush = _profile_data(name)
    ind = ic.ensure_state(d)
    ic.run_tick(d, ind)

    if not ic.is_known_commodity(item) and item not in set(_extra_commodities()):
        return _err("Unknown commodity", 404)

    today = ic.now_iso()[:10]
    epoch_now = ic.epoch_days_now()

    if side == "sell":
        held = ic.holdings_of(d, ind, item)
        if held < qty:
            return _err(f"You only hold {int(held)} × {item}")
        sold_today = sum(int(t.get("qty", 0)) for t in ind.get("trades", [])
                         if t.get("item") == item and t.get("side") == "sell"
                         and str(t.get("date", "")).startswith(today))
        cap = ic.daily_volume_cap(item)
        if sold_today + qty > cap:
            return _err(f"Daily trade volume cap: {cap}/day ({sold_today} already traded today)")
        px = ic.execute_trade_price(ind, item, "sell", qty, epoch_days=epoch_now)
        taken = ic.remove_holdings(d, ind, item, qty)
        proceeds = round(px * taken, 1)
        ind.setdefault("trades", []).append({
            "id": _need("gen_id")(8), "date": today, "epoch": epoch_now,
            "side": "sell", "item": item, "qty": taken, "unit": px,
            "total": proceeds, "net": proceeds,
        })
        flush()
        return jsonify({"ok": True, "side": "sell", "item": item, "qty": taken,
                        "unit_price": px, "proceeds": proceeds})

    is_seed = item in _seed_item_types()
    if is_seed:
        has_space_fn = _need("_inventory_has_space")
        if not has_space_fn(d, item):
            return _err("Your Botanarium inventory is full — free up a slot (Inventory & Shop) before buying seeds.")
    cap = ic.daily_volume_cap(item)
    bought_today = sum(int(t.get("qty", 0)) for t in ind.get("trades", [])
                       if t.get("item") == item and t.get("side") == "buy"
                       and str(t.get("date", "")).startswith(today))
    if bought_today + qty > cap:
        return _err(f"Daily trade volume cap: {cap}/day ({bought_today} already traded today)")
    px = ic.execute_trade_price(ind, item, "buy", qty, epoch_days=epoch_now)
    total = round(px * qty, 1)
    balance_fn = _need("compute_current_balance")
    balance = balance_fn(name=name, d=d)
    if balance < total:
        return _err(f"Not enough Nerds (need {total}, have {round(balance, 1)})")
    # The trade record appended below carries the net cash effect (-total) and
    # is what the balance and the Finance ledger read; also logging a spend
    # here charged every purchase twice.
    if is_seed:
        _need("_inventory_add")(d, item, qty)
    else:
        w = ic.get_warehouse(ind, data.get("warehouse_id")) or ic.get_warehouse(ind, None)
        if not w:
            return _err("No warehouse to receive the purchase")
        inv = w.setdefault("inv", {})
        inv[item] = float(inv.get(item, 0)) + qty
    ind.setdefault("trades", []).append({
        "id": _need("gen_id")(8), "date": today, "epoch": epoch_now,
        "side": "buy", "item": item, "qty": qty, "unit": px,
        "total": total, "net": -total,
    })
    flush()
    return jsonify({"ok": True, "side": "buy", "item": item, "qty": qty,
                    "unit_price": px, "total": total})


MARKET_INFO_PAGES = [
    {
        "id": "basics", "title": "Market Basics",
        "body": [
            "Every good your industry or Botanarium produces trades here as a COMMODITY. "
            "Prices move continuously with the seasons, world events, and your own trading.",
            "One real-world month replays a full simulated year (Jan→Dec). The cycle then "
            "starts over — learn each commodity's seasonal rhythm and trade with it.",
            "You can't sell more than you hold, daily volumes are capped per commodity, "
            "and extreme prices get pulled back toward realistic floors and ceilings.",
        ],
    },
    {
        "id": "events", "title": "World Events",
        "body": [
            "The Internet app reports wars, shortages, breakthroughs, weather and regulation. "
            "Each event pushes affected commodities up or down, then decays away.",
            "Effects PASS THROUGH production chains: a copper strike lifts Raw Copper most, "
            "Copper Ingot somewhat less, and finished wiring less again (~75% per step).",
            "SUBSTITUTE goods drift opposite each other: when aluminum spikes because of a "
            "copper shortage, buyers switch and aluminum's substitute relationship cools.",
        ],
    },
    {
        "id": "strategy", "title": "Strategy Tips",
        "body": [
            "DUMPING CRASHES YOUR OWN MARKET. Mass-selling one good depresses its price for "
            "about a week — spread large sales out, or diversify what you produce.",
            "Watch the calendar: fuel peaks in the simulated winter, construction booms when "
            "rates fall, luxury spikes around wedding season.",
            "High-value electronics and military goods swing hardest. If you can stockpile "
            "ahead of an announced event, the trend is yours.",
            "There is no single 'meta' crop: hundreds of commodities, different volatilities. "
            "Rotate production toward whatever the world is currently short of.",
        ],
    },
]


@bp.route("/api/<name>/market/info")
@_locked
def market_info(name):
    return jsonify({"pages": MARKET_INFO_PAGES})
