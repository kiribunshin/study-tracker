#!/usr/bin/env python3
"""StudyTracker v1.1.1 — Portable study tracking web app."""
import os, json, time, hashlib, shutil, math, uuid
from flask import Flask, jsonify, request, send_file, abort
from pathlib import Path
from collections import defaultdict
from datetime import datetime
from werkzeug.utils import secure_filename

app = Flask(__name__)

# ── Configuration ──
SAVES_DIR = Path(__file__).parent / "saves"
SAVES_DIR.mkdir(exist_ok=True)
FILES_DIR_NAME = "_files"  # subdirectory per save for subject/skill files
DEFAULT_DATA = {
    "self_study": [],
    "attendance": [],
    "exams": [],
    "events": [],
    "timers": [],
    "logins": []
}

# ── Helpers ──
def now_str():
    return time.strftime("%Y-%m-%dT%H:%M:%S")

def today_str():
    return time.strftime("%Y-%m-%d")

def gen_id(n=10):
    """Generate a short, guaranteed-unique id. Several endpoints used to
    derive ids from md5(name) alone, which meant two items with the same
    name (e.g. two subjects both called "Math") collided on the same id
    and silently corrupted lookups. uuid4 has no such collision risk."""
    return uuid.uuid4().hex[:n]

def week_num(start_date_str, date_str):
    """Calculate week number (1-indexed) from a start date."""
    from datetime import datetime
    start = datetime.strptime(start_date_str, "%Y-%m-%d")
    date = datetime.strptime(date_str, "%Y-%m-%d")
    delta = (date - start).days
    return max(1, (delta // 7) + 1)

def save_dir(profile):
    return SAVES_DIR / profile

def files_dir(profile):
    return save_dir(profile) / FILES_DIR_NAME

def config_path(profile):
    return save_dir(profile) / "config.json"

def data_path(profile):
    return save_dir(profile) / "data.json"

def load_config(profile):
    p = config_path(profile)
    if p.exists():
        with open(p) as f:
            cfg = json.load(f)
        # Backfill defaults for fields introduced in later versions —
        # profiles created before v1.1 won't have these keys yet.
        cfg.setdefault("ml_prediction_enabled", True)
        cfg.setdefault("attendance_default_mode", "manual")
        cfg.setdefault("attendance_autofill_last_date", "")
        return cfg
    return None

def save_config(profile, d):
    d["_last_modified"] = now_str()
    with open(config_path(profile), "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)

def load_data(profile):
    p = data_path(profile)
    if p.exists():
        with open(p) as f:
            data = json.load(f)
    else:
        data = {}
    return {key: data.get(key, value.copy() if isinstance(value, list) else value) for key, value in DEFAULT_DATA.items()}

def save_data(profile, d):
    d = {key: d.get(key, value.copy() if isinstance(value, list) else value) for key, value in DEFAULT_DATA.items()}
    p = data_path(profile)
    # Keep one rolling backup of the previous version before overwriting.
    # This is a last-resort safety net independent of the undo/trash
    # system below — if anything ever wipes data unexpectedly, the prior
    # state is still recoverable straight from disk.
    if p.exists():
        try:
            shutil.copy(p, p.parent / (p.name + ".bak"))
        except Exception:
            pass
    with open(p, "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)

# ── Undo / trash ──
# A lightweight, single-level undo for accidental deletions. Kept in a
# separate trash.json (not inside data.json/DEFAULT_DATA) so it can't
# interfere with the core data schema. Delete endpoints for self_study,
# attendance, and exams push the removed record here before saving;
# /api/<name>/undo_delete pops the most recent one back in.
def trash_path(profile):
    return save_dir(profile) / "trash.json"

def load_trash(profile):
    p = trash_path(profile)
    if p.exists():
        try:
            with open(p) as f:
                return json.load(f)
        except Exception:
            return []
    return []

def save_trash(profile, trash):
    with open(trash_path(profile), "w") as f:
        json.dump(trash[-20:], f, indent=2, ensure_ascii=False)

def push_trash(profile, kind, record):
    if not record:
        return
    trash = load_trash(profile)
    trash.append({"kind": kind, "record": record, "deleted_at": now_str()})
    save_trash(profile, trash)

def ensure_profile(profile):
    """Create save directory structure for a profile."""
    sd = save_dir(profile)
    sd.mkdir(parents=True, exist_ok=True)
    (sd / FILES_DIR_NAME).mkdir(exist_ok=True)
    # Create default config if new
    cp = config_path(profile)
    if not cp.exists():
        default_config = {
            "profile_name": profile,
            "created": now_str(),
            "academic_years": [],
            "subjects": [],
            "skills": [],
            "ml_min_records": 30,
            "ml_prediction_enabled": True,
            "attendance_default_mode": "manual",  # "manual" | "mostly_present" | "mostly_absent"
            "attendance_autofill_last_date": "",
            "difficulty_labels": {
                "1": "Trivial", "2": "Very Easy", "3": "Easy", "4": "Fair",
                "5": "Moderate", "6": "Challenging", "7": "Hard", "8": "Very Hard",
                "9": "Brutal", "10": "Nightmare"
            }
        }
        save_config(profile, default_config)
    # Create default data if new
    dp = data_path(profile)
    if not dp.exists():
        save_data(profile, load_data(profile))

def pearson_correlation(x, y):
    """Compute Pearson correlation between two lists of numbers."""
    n = len(x)
    if n < 2:
        return None
    mean_x = sum(x) / n
    mean_y = sum(y) / n
    numerator = sum((xi - mean_x) * (yi - mean_y) for xi, yi in zip(x, y))
    denom_x = math.sqrt(sum((xi - mean_x) ** 2 for xi in x))
    denom_y = math.sqrt(sum((yi - mean_y) ** 2 for yi in y))
    if denom_x == 0 or denom_y == 0:
        return None
    return round(numerator / (denom_x * denom_y), 3)

def compute_ml_features(name, cfg, d):
    """Per-subject aggregate stats + a normalized vector, used for the
    similarity ("students with a pattern like yours...") insights below."""
    subjects = {s["id"]: s for s in cfg.get("subjects", [])}

    study_minutes = defaultdict(float)
    study_difficulty = defaultdict(list)
    attendance_status = defaultdict(list)
    exam_scores = defaultdict(list)
    study_daily_minutes = defaultdict(lambda: defaultdict(float))

    for r in d.get("self_study", []):
        sid = r.get("subject_id", "")
        if sid not in subjects:
            continue
        mins = r.get("minutes", 0)
        diff = r.get("difficulty", 5)
        date = r.get("date", "")
        study_minutes[sid] += mins
        study_difficulty[sid].append(diff)
        if date:
            study_daily_minutes[sid][date] += mins

    for r in d.get("attendance", []):
        sid = r.get("subject_id", "")
        if sid not in subjects:
            continue
        status = r.get("status", "present")
        attendance_status[sid].append(1 if status == "present" else 0)

    for e in d.get("exams", []):
        sid = e.get("subject_id", "")
        if sid not in subjects:
            continue
        score = e.get("score")
        if score is not None:
            exam_scores[sid].append(score)

    features = {}
    for sid, s in subjects.items():
        total = study_minutes.get(sid, 0)
        diffs = study_difficulty.get(sid, [])
        avg_diff = sum(diffs) / len(diffs) if diffs else 0
        att = attendance_status.get(sid, [])
        att_rate = sum(att) / len(att) if att else 0
        scores = exam_scores.get(sid, [])
        avg_score = sum(scores) / len(scores) if scores else 0
        daily = study_daily_minutes.get(sid, {})
        daily_vals = list(daily.values()) if daily else [0]
        if len(daily_vals) > 1:
            mean_daily = sum(daily_vals) / len(daily_vals)
            variance = sum((v - mean_daily) ** 2 for v in daily_vals) / len(daily_vals)
            consistency = math.sqrt(variance)
        else:
            consistency = 0

        features[sid] = {
            "name": s["name"],
            "total_self_study_minutes": total,
            "avg_difficulty": avg_diff,
            "attendance_rate": att_rate,
            "avg_score": avg_score,
            "study_consistency": consistency,
            "vector": [total, avg_diff, att_rate * 100, avg_score * 5, consistency]
        }

    return features


def build_exam_training_data(cfg, d):
    """Build (X, y) training pairs from the person's OWN exam history:
    X = [self-study minutes logged for that subject up to the exam date,
         average difficulty of those sessions, attendance rate up to that
         date], y = the score they actually got. This is what lets the
         urgency model be genuinely personal instead of a fixed rule that
         treats a 4.0 and a 9.5 GPA student identically."""
    subjects = {s["id"]: s for s in cfg.get("subjects", [])}
    X, y = [], []
    for e in d.get("exams", []):
        score = e.get("score")
        sid = e.get("subject_id", "")
        if score is None or sid not in subjects:
            continue
        exam_date = e.get("date", "")
        mins = 0.0
        diffs = []
        for r in d.get("self_study", []):
            if r.get("subject_id") == sid and r.get("date", "") and r.get("date", "") <= exam_date:
                mins += r.get("minutes", 0)
                diffs.append(r.get("difficulty", 5))
        avg_diff = sum(diffs) / len(diffs) if diffs else subjects[sid].get("difficulty", 5)
        att_list = []
        for r in d.get("attendance", []):
            if r.get("subject_id") == sid and r.get("date", "") and r.get("date", "") <= exam_date:
                att_list.append(1 if r.get("status") == "present" else (0.5 if r.get("status") == "partial" else 0))
        att_rate = sum(att_list) / len(att_list) if att_list else 0.5
        X.append([mins, avg_diff, att_rate])
        y.append(score)
    return X, y


def _fit_score_model(X_train, y_train):
    """Fits a small linear regression (effort -> exam score) on the
    person's own history. Returns None if sklearn is unavailable or there
    isn't enough data yet — callers fall back to a self-relative signal
    in that case rather than a hardcoded universal threshold."""
    if len(X_train) < 4:
        return None
    try:
        from sklearn.linear_model import LinearRegression
        import numpy as np
        model = LinearRegression()
        model.fit(np.array(X_train), np.array(y_train))
        return model
    except Exception:
        return None


def get_urgency_recommendations(cfg, d, ml_enabled=True):
    """Primary recommendation source. For every subject with an upcoming
    (status='scheduled') exam, predicts the score the person is currently
    on track for, using a regression trained on their OWN past exam
    outcomes (study minutes + difficulty + attendance -> score). Ranks
    every subject by an urgency score = predicted shortfall x difficulty
    x how soon the exam is, replacing the old fixed ">=7 difficulty AND
    <120 minutes" rule that was identical for every person and every
    subject regardless of their actual history.

    When there isn't enough exam history yet to train a model (cold
    start), falls back to comparing the subject's study time against the
    person's OWN average across their other subjects — still personal,
    just not predictive yet."""
    subjects = {s["id"]: s for s in cfg.get("subjects", [])}
    if not subjects:
        return []

    # ml_enabled comes from the person's Settings toggle (some people find
    # a running "predicted exam score" unhealthy to look at). When off,
    # skip fitting a model entirely — every subject falls through to the
    # self-relative cold-start heuristic below instead, which is never
    # framed as a predicted score.
    if ml_enabled:
        X_train, y_train = build_exam_training_data(cfg, d)
        model = _fit_score_model(X_train, y_train)
    else:
        model = None

    today = today_str()
    recs = []

    per_subject_minutes = {}
    for sid in subjects:
        per_subject_minutes[sid] = sum(
            r.get("minutes", 0) for r in d.get("self_study", []) if r.get("subject_id") == sid
        )
    avg_minutes_all = sum(per_subject_minutes.values()) / len(per_subject_minutes) if per_subject_minutes else 0

    for sid, s in subjects.items():
        sname = s["name"]
        diff = s.get("difficulty", 5)
        mins = per_subject_minutes.get(sid, 0)
        att_list = [
            1 if r.get("status") == "present" else (0.5 if r.get("status") == "partial" else 0)
            for r in d.get("attendance", []) if r.get("subject_id") == sid
        ]
        att_rate = (sum(att_list) / len(att_list)) if att_list else 0.5

        upcoming = sorted(
            [e for e in d.get("exams", []) if e.get("subject_id") == sid and e.get("status") == "scheduled" and e.get("date", "") >= today],
            key=lambda e: e.get("date", "")
        )
        next_exam = upcoming[0] if upcoming else None
        days_until = None
        if next_exam:
            try:
                days_until = (datetime.strptime(next_exam["date"], "%Y-%m-%d") - datetime.strptime(today, "%Y-%m-%d")).days
            except Exception:
                days_until = None

        if model is not None:
            import numpy as np
            predicted = float(model.predict(np.array([[mins, diff, att_rate]]))[0])
            predicted = max(0.0, min(20.0, predicted))
            soon_multiplier = 1.6 if (days_until is not None and days_until <= 7) else (1.2 if (days_until is not None and days_until <= 14) else 1.0)
            urgency = (20 - predicted) * (diff / 10) * soon_multiplier
            if next_exam is not None and (predicted < 12 or (days_until is not None and days_until <= 5 and predicted < 15)):
                when = f" in {days_until} day{'s' if days_until != 1 else ''}" if days_until is not None else ""
                recs.append({
                    "type": "warning" if predicted < 10 else "info",
                    "source": "ml_predictive",
                    "urgency": round(urgency, 2),
                    "msg": (
                        f"{sname}: at your current pace ({mins // 60:.0f}h logged, difficulty {diff}/10), "
                        f"you're predicted around {predicted:.1f}/20 on \u201c{next_exam.get('name', 'the exam')}\u201d{when}. "
                        f"Consider prioritizing this one."
                    )
                })
            elif next_exam is None and predicted < 11 and diff >= 6:
                recs.append({
                    "type": "info",
                    "source": "ml_predictive",
                    "urgency": round((20 - predicted) * (diff / 10) * 0.6, 2),
                    "msg": (
                        f"{sname}: based on your study pattern so far, your projected performance "
                        f"({predicted:.1f}/20) is on the low side for a difficulty {diff}/10 subject."
                    )
                })
        elif next_exam is not None:
            # Cold start — not enough exam history to train a model yet.
            # Compare against the person's own average instead of a fixed
            # global constant.
            if diff >= 6 and mins < avg_minutes_all * 0.65:
                when = f", with \u201c{next_exam.get('name', 'an exam')}\u201d in {days_until} day{'s' if days_until != 1 else ''}" if days_until is not None else ""
                recs.append({
                    "type": "warning",
                    "source": "heuristic",
                    "urgency": round((diff / 10) * max(1.0, (avg_minutes_all - mins) / 60), 2),
                    "msg": (
                        f"{sname} is rated difficulty {diff}/10 and you've logged less study time than "
                        f"most of your other subjects ({mins // 60:.0f}h){when}. Not enough exam history yet "
                        f"for a precise prediction — logging a few scored exams will sharpen this."
                    )
                })

    recs.sort(key=lambda r: r.get("urgency", 0), reverse=True)
    return recs


def get_pattern_insights(cfg, d):
    """Secondary, lower-priority insights: nearest-neighbor similarity
    between subjects (kept from the original design) — "subject A looks
    like subject B in your history, and B is going better"."""
    features = compute_ml_features("", cfg, d)
    if len(features) < 2:
        return []
    try:
        from sklearn.neighbors import NearestNeighbors
        import numpy as np
    except Exception:
        return []

    subject_ids = list(features.keys())
    vectors = [features[sid]["vector"] for sid in subject_ids]
    X = np.array(vectors)
    means = X.mean(axis=0)
    stds = X.std(axis=0)
    stds[stds == 0] = 1
    X_norm = (X - means) / stds

    n_neighbors = min(3, len(subject_ids) - 1)
    if n_neighbors < 1:
        return []

    nn = NearestNeighbors(n_neighbors=n_neighbors + 1, metric='euclidean')
    nn.fit(X_norm)
    distances, indices = nn.kneighbors(X_norm)

    recs = []
    for i, sid in enumerate(subject_ids):
        feat = features[sid]
        for j_idx in range(1, len(indices[i])):
            neighbor_sid = subject_ids[indices[i][j_idx]]
            neighbor_feat = features[neighbor_sid]
            dist = distances[i][j_idx]
            if dist <= 0:
                continue
            if neighbor_feat["total_self_study_minutes"] > feat["total_self_study_minutes"] * 1.3:
                recs.append({
                    "type": "info", "source": "ml_pattern",
                    "urgency": round(1 / (1 + dist), 3),
                    "msg": f"{feat['name']} is similar to {neighbor_feat['name']} in your history, but you've studied {neighbor_feat['name']} more. Consider more time on {feat['name']}."
                })
    return recs


def get_spaced_repetition_recs(cfg, d):
    """Suggests revisiting subjects/skills that haven't been touched in a
    while, scaled to difficulty (harder material decays faster and
    should be reviewed sooner)."""
    today = datetime.strptime(today_str(), "%Y-%m-%d")
    last_studied = {}
    for r in d.get("self_study", []):
        if r.get("status") not in ("Done", "Partial"):
            continue
        key = ("s", r["subject_id"]) if r.get("subject_id") else (("k", r["skill_id"]) if r.get("skill_id") else None)
        if not key or not r.get("date"):
            continue
        if key not in last_studied or r["date"] > last_studied[key]:
            last_studied[key] = r["date"]

    recs = []
    items = [("s", s["id"], s["name"], s.get("difficulty", 5)) for s in cfg.get("subjects", [])]
    items += [("k", s["id"], s["name"], s.get("difficulty", 5)) for s in cfg.get("skills", [])]
    for kind, iid, name, diff in items:
        key = (kind, iid)
        if key not in last_studied:
            continue
        try:
            last_date = datetime.strptime(last_studied[key], "%Y-%m-%d")
        except Exception:
            continue
        days_since = (today - last_date).days
        interval = max(2, 10 - diff)
        if days_since > interval:
            recs.append({
                "type": "info", "source": "spaced_repetition",
                "urgency": round((days_since - interval) / 5.0, 2),
                "msg": f"You haven't studied {name} in {days_since} days — a quick review session could help retention (difficulty {diff}/10)."
            })
    return recs

def get_recommendations(cfg, d):
    """Single entry point for all Smart Recommendations — replaces the
    old get_heuristic_recommendations()/get_ml_recommendations() split,
    which used to be called separately and merged in a way that produced
    duplicate/mislabeled entries. Everything here is either predictive
    (regression on the person's own exam history), self-relative
    (cold-start fallback), or a simple attendance-policy check."""
    ml_enabled = cfg.get("ml_prediction_enabled", True)
    recs = get_urgency_recommendations(cfg, d, ml_enabled=ml_enabled)

    # Attendance-rate warning (kept — this is a fixed academic policy
    # threshold, not a personalized guess, so a constant is appropriate
    # here unlike the old difficulty/study-time rule).
    attendance_by_subject_events = defaultdict(int)
    attendance_by_subject_present = defaultdict(int)
    for r in d.get("attendance", []):
        sid = r.get("subject_id", "")
        attendance_by_subject_events[sid] += 1
        if r.get("status") == "present":
            attendance_by_subject_present[sid] += 1
    for s in cfg.get("subjects", []):
        sid = s["id"]
        total_events = attendance_by_subject_events.get(sid, 0)
        if total_events > 0:
            rate = attendance_by_subject_present.get(sid, 0) / total_events * 100
            if rate < 70:
                recs.append({
                    "type": "warning", "source": "heuristic", "urgency": round((70 - rate) / 10, 2),
                    "msg": f"Attendance for {s['name']} is {rate:.0f}% — below the 70% threshold."
                })

    # No self-study logged at all for a subject yet
    studied_subject_ids = {r.get("subject_id") for r in d.get("self_study", []) if r.get("subject_id")}
    for s in cfg.get("subjects", []):
        if s["id"] not in studied_subject_ids:
            recs.append({"type": "info", "source": "heuristic", "urgency": 0.1, "msg": f"You haven't logged any self-study for {s['name']} yet."})

    if ml_enabled:
        recs += get_pattern_insights(cfg, d)
    recs += get_spaced_repetition_recs(cfg, d)
    recs.sort(key=lambda r: r.get("urgency", 0), reverse=True)
    return recs[:15]


# ── Profile management ──
@app.route("/api/profiles")
def list_profiles():
    profiles = []
    for d in sorted(SAVES_DIR.iterdir()):
        if d.is_dir() and (d / "config.json").exists():
            with open(d / "config.json") as f:
                cfg = json.load(f)
            profiles.append({
                "name": d.name,
                "subjects": len(cfg.get("subjects", [])),
                "created": cfg.get("created", ""),
                "modified": cfg.get("_last_modified", "")
            })
    return jsonify(profiles)

@app.route("/api/profiles", methods=["POST"])
def create_profile():
    data = request.get_json(force=True)
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Profile name required"}), 400
    if not name.replace("_", "").replace("-", "").isalnum():
        return jsonify({"error": "Only letters, numbers, _ and - allowed"}), 400
    sd = save_dir(name)
    if sd.exists():
        return jsonify({"error": "Profile already exists"}), 409
    ensure_profile(name)
    # Update config with initial data
    cfg = load_config(name)
    for key in ["academic_years", "subjects", "skills"]:
        if key in data:
            cfg[key] = data[key]
    save_config(name, cfg)
    return jsonify({"ok": True, "name": name})

@app.route("/api/profiles/<name>", methods=["DELETE"])
def delete_profile(name):
    sd = save_dir(name)
    if not sd.exists():
        return jsonify({"error": "Profile not found"}), 404
    shutil.rmtree(sd)
    return jsonify({"ok": True})

@app.route("/api/<name>/wipe", methods=["POST"])
def wipe_data(name):
    """Reset all tracking data but keep config (subjects, years, etc.).
    Two bugs fixed here: (1) this route used to live at
    /api/profiles/<name>/wipe (GET) while the frontend called
    /api/<name>/wipe, so the "Wipe Data" button always 404'd; the path now
    matches the rest of the /api/<name>/... convention and uses POST since
    it's destructive. (2) the old body did save_data(name, load_data(name))
    which just re-saved the existing data unchanged -- it never actually
    wiped anything even when reached directly."""
    ensure_profile(name)
    save_data(name, {"self_study": [], "attendance": [], "exams": [], "events": [], "timers": []})
    return jsonify({"ok": True})

@app.route("/api/<name>/undo_delete", methods=["POST"])
def undo_delete(name):
    """Restores the single most recently deleted self-study, attendance,
    or exam record. Nothing fancier than a one-slot-at-a-time stack —
    deleting again after an undo just pushes a new trash entry, it
    doesn't overwrite anything you already restored."""
    ensure_profile(name)
    trash = load_trash(name)
    if not trash:
        return jsonify({"error": "Nothing to undo"}), 404
    last = trash.pop()
    save_trash(name, trash)
    kind = last.get("kind")
    record = last.get("record") or {}
    d = load_data(name)
    if kind not in d or not isinstance(d[kind], list):
        return jsonify({"error": "Unknown record type"}), 400
    if not any(r.get("id") == record.get("id") for r in d[kind]):
        d[kind].append(record)
    save_data(name, d)
    return jsonify({"ok": True, "kind": kind, "record": record})

@app.route("/api/<name>/export")
def export_profile(name):
    """Export entire save folder as a downloadable archive."""
    import zipfile, io
    sd = save_dir(name)
    if not sd.exists():
        return jsonify({"error": "Profile not found"}), 404
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file in sd.rglob('*'):
            if file.is_file():
                arcname = file.relative_to(sd)
                zf.write(file, arcname)
    buffer.seek(0)
    return send_file(buffer, mimetype="application/zip",
                     as_attachment=True, download_name=f"{name}.zip")

# ── Config CRUD ──
@app.route("/api/<name>/config", methods=["GET"])
def get_config(name):
    ensure_profile(name)
    return jsonify(load_config(name))

@app.route("/api/<name>/config", methods=["PUT"])
def update_config(name):
    ensure_profile(name)
    data = request.get_json(force=True)
    cfg = load_config(name)
    cfg.update(data)
    save_config(name, cfg)
    return jsonify({"ok": True})

# ── Data bundle ──
# The frontend's loadData() has always called this exact path expecting
# the combined self_study/attendance/exams/events/timers bundle
# back — but this route never existed, so every call 404'd, was caught
# silently, and cachedData stayed null forever. That's why self-study,
# attendance, and exam record lists, the dashboard's Today/
# Recent Activity panels, and the Timetable's exam/event overlays all
# appeared permanently empty even though records were being saved
# correctly (visible via /stats, which reads straight off disk and never
# depended on this endpoint).
@app.route("/api/<name>/data")
def get_data(name):
    ensure_profile(name)
    return jsonify(load_data(name))

# ── Academic Years ──
@app.route("/api/<name>/years", methods=["POST"])
def add_year(name):
    ensure_profile(name)
    data = request.get_json(force=True)
    year = {
        "id": gen_id(8),
        "label": data["label"],
        "start_date": data["start_date"],
        "end_date": data["end_date"],
        "exam_periods": [],
        "vacation_weeks": []
    }
    cfg = load_config(name)
    cfg.setdefault("academic_years", []).append(year)
    save_config(name, cfg)
    return jsonify({"ok": True, "year": year})

@app.route("/api/<name>/years/<year_id>", methods=["PUT"])
def update_year(name, year_id):
    ensure_profile(name)
    data = request.get_json(force=True)
    cfg = load_config(name)
    for y in cfg.get("academic_years", []):
        if y["id"] == year_id:
            y.update(data)
            break
    save_config(name, cfg)
    return jsonify({"ok": True})

@app.route("/api/<name>/years/<year_id>", methods=["DELETE"])
def delete_year(name, year_id):
    ensure_profile(name)
    cfg = load_config(name)
    cfg["academic_years"] = [y for y in cfg.get("academic_years", []) if y["id"] != year_id]
    save_config(name, cfg)
    return jsonify({"ok": True})

# ── Exam Periods ──
# A period (start_date/end_date) within an academic year during which
# ONLY exams populate the timetable — regular C/TD/TP lessons for that
# subject's recurring schedule are hidden for those dates. Exams can still
# be added freely outside any exam period too; periods only ever narrow
# what the *lesson* schedule shows, they never restrict exam creation.
@app.route("/api/<name>/years/<year_id>/exam_periods", methods=["POST"])
def add_exam_period(name, year_id):
    ensure_profile(name)
    data = request.get_json(force=True)
    period = {
        "id": gen_id(8),
        "label": data.get("label", "Exam Period"),
        "start_date": data["start_date"],
        "end_date": data["end_date"]
    }
    cfg = load_config(name)
    for y in cfg.get("academic_years", []):
        if y["id"] == year_id:
            y.setdefault("exam_periods", []).append(period)
            break
    else:
        return jsonify({"error": "Year not found"}), 404
    save_config(name, cfg)
    return jsonify({"ok": True, "period": period})

@app.route("/api/<name>/years/<year_id>/exam_periods/<period_id>", methods=["DELETE"])
def delete_exam_period(name, year_id, period_id):
    ensure_profile(name)
    cfg = load_config(name)
    for y in cfg.get("academic_years", []):
        if y["id"] == year_id:
            y["exam_periods"] = [p for p in y.get("exam_periods", []) if p["id"] != period_id]
            break
    save_config(name, cfg)
    return jsonify({"ok": True})

# ── Vacation Weeks ──
# A date range (a day, several days, or weeks) within an academic year
# with 0 scheduled lesson (C/TD/TP) hours. Skills CAN still be scheduled
# during a vacation for self-study/self-skilling — only the subject
# lesson schedule is suppressed, not skills or exams.
@app.route("/api/<name>/years/<year_id>/vacation_weeks", methods=["POST"])
def add_vacation_week(name, year_id):
    ensure_profile(name)
    data = request.get_json(force=True)
    vac = {
        "id": gen_id(8),
        "label": data.get("label", "Vacation"),
        "start_date": data["start_date"],
        "end_date": data["end_date"]
    }
    cfg = load_config(name)
    for y in cfg.get("academic_years", []):
        if y["id"] == year_id:
            y.setdefault("vacation_weeks", []).append(vac)
            break
    else:
        return jsonify({"error": "Year not found"}), 404
    save_config(name, cfg)
    return jsonify({"ok": True, "vacation": vac})

@app.route("/api/<name>/years/<year_id>/vacation_weeks/<vac_id>", methods=["DELETE"])
def delete_vacation_week(name, year_id, vac_id):
    ensure_profile(name)
    cfg = load_config(name)
    for y in cfg.get("academic_years", []):
        if y["id"] == year_id:
            y["vacation_weeks"] = [v for v in y.get("vacation_weeks", []) if v["id"] != vac_id]
            break
    save_config(name, cfg)
    return jsonify({"ok": True})

# ── Subjects ──
@app.route("/api/<name>/subjects", methods=["POST"])
def add_subject(name):
    ensure_profile(name)
    data = request.get_json(force=True)
    subject = {
        "id": gen_id(8),
        "name": data["name"],
        "color": data.get("color", "#4a90d9"),
        "difficulty": data.get("difficulty", 5),
        "year_id": data.get("year_id", ""),
        "schedule": data.get("schedule", [])  # [{day: "monday", type: "C", start: "08:00", end: "09:30"}]
    }
    cfg = load_config(name)
    cfg.setdefault("subjects", []).append(subject)
    save_config(name, cfg)
    # Create file folder
    fd = files_dir(name) / subject["id"]
    fd.mkdir(exist_ok=True)
    return jsonify({"ok": True, "subject": subject})

@app.route("/api/<name>/subjects/<sub_id>", methods=["PUT"])
def update_subject(name, sub_id):
    ensure_profile(name)
    data = request.get_json(force=True)
    cfg = load_config(name)
    for s in cfg.get("subjects", []):
        if s["id"] == sub_id:
            s.update(data)
            break
    save_config(name, cfg)
    return jsonify({"ok": True})

@app.route("/api/<name>/subjects/<sub_id>", methods=["DELETE"])
def delete_subject(name, sub_id):
    ensure_profile(name)
    cfg = load_config(name)
    cfg["subjects"] = [s for s in cfg.get("subjects", []) if s["id"] != sub_id]
    save_config(name, cfg)
    # Cascade delete: previously, records referencing this subject_id
    # were left orphaned in data.json (showing as "Unknown" everywhere
    # and silently inflating/skewing stats). Now everything tied to the
    # subject — self-study, attendance, exams — is removed with it,
    # matching the "deleting it deletes everything associated" warning
    # shown in the UI before this call is made.
    d = load_data(name)
    d["self_study"] = [r for r in d.get("self_study", []) if r.get("subject_id") != sub_id]
    d["attendance"] = [r for r in d.get("attendance", []) if r.get("subject_id") != sub_id]
    d["exams"] = [r for r in d.get("exams", []) if r.get("subject_id") != sub_id]
    save_data(name, d)
    fd = files_dir(name) / sub_id
    if fd.exists():
        shutil.rmtree(fd)
    return jsonify({"ok": True})

# ── Skills ──
@app.route("/api/<name>/skills", methods=["POST"])
def add_skill(name):
    ensure_profile(name)
    data = request.get_json(force=True)
    skill = {
        "id": gen_id(8),
        "name": data["name"],
        "category": data.get("category", ""),
        "difficulty": data.get("difficulty", 5),
        "color": data.get("color", "#e91e63"),
        # Skills can now optionally carry their own recurring schedule
        # blocks (same shape as subject schedule), so they can be placed
        # on the Timetable — e.g. during a vacation week, when lessons
        # are suppressed but self-skilling sessions still make sense.
        "schedule": data.get("schedule", [])
    }
    cfg = load_config(name)
    cfg.setdefault("skills", []).append(skill)
    save_config(name, cfg)
    fd = files_dir(name) / f"skill_{skill['id']}"
    fd.mkdir(exist_ok=True)
    return jsonify({"ok": True, "skill": skill})

@app.route("/api/<name>/skills/<skill_id>", methods=["PUT"])
def update_skill(name, skill_id):
    ensure_profile(name)
    data = request.get_json(force=True)
    cfg = load_config(name)
    for s in cfg.get("skills", []):
        if s["id"] == skill_id:
            s.update(data)
            break
    save_config(name, cfg)
    return jsonify({"ok": True})

@app.route("/api/<name>/skills/<skill_id>", methods=["DELETE"])
def delete_skill(name, skill_id):
    ensure_profile(name)
    cfg = load_config(name)
    cfg["skills"] = [s for s in cfg.get("skills", []) if s["id"] != skill_id]
    save_config(name, cfg)
    d = load_data(name)
    d["self_study"] = [r for r in d.get("self_study", []) if r.get("skill_id") != skill_id]
    save_data(name, d)
    fd = files_dir(name) / f"skill_{skill_id}"
    if fd.exists():
        shutil.rmtree(fd)
    return jsonify({"ok": True})

# ── Self-Study Records ──
@app.route("/api/<name>/self_study", methods=["POST"])
def add_self_study(name):
    ensure_profile(name)
    data = request.get_json(force=True)
    record = {
        "id": gen_id(12),
        "date": data.get("date", today_str()),
        "subject_id": data.get("subject_id", ""),
        "skill_id": data.get("skill_id", ""),
        "minutes": int(data.get("minutes", 0)),
        "difficulty": data.get("difficulty", 5),
        "status": data.get("status", "Done"),  # Done, Partial, Skipped
        "note": data.get("note", ""),
        "created": now_str()
    }
    d = load_data(name)
    d["self_study"].append(record)
    save_data(name, d)
    xp_earned = compute_self_study_record_xp(record["minutes"], record["difficulty"], record["status"])
    return jsonify({"ok": True, "record": record, "xp_earned": xp_earned})

@app.route("/api/<name>/self_study/<rec_id>", methods=["PUT"])
def update_self_study(name, rec_id):
    ensure_profile(name)
    data = request.get_json(force=True)
    d = load_data(name)
    for r in d["self_study"]:
        if r["id"] == rec_id:
            r.update(data)
            r["modified"] = now_str()
            break
    save_data(name, d)
    return jsonify({"ok": True})

@app.route("/api/<name>/self_study/<rec_id>", methods=["DELETE"])
def delete_self_study(name, rec_id):
    ensure_profile(name)
    d = load_data(name)
    removed = next((r for r in d["self_study"] if r["id"] == rec_id), None)
    d["self_study"] = [r for r in d["self_study"] if r["id"] != rec_id]
    if removed:
        push_trash(name, "self_study", removed)
    save_data(name, d)
    return jsonify({"ok": True, "undoable": bool(removed)})

# ── Attendance Records ──
@app.route("/api/<name>/attendance", methods=["POST"])
def add_attendance(name):
    ensure_profile(name)
    data = request.get_json(force=True)
    record = {
        "id": gen_id(12),
        "date": data.get("date", today_str()),
        "subject_id": data.get("subject_id", ""),
        "type": data.get("type", "C"),  # C, TD, TP
        "event_label": data.get("event_label", ""),  # e.g. "TD1", "Lab 3"
        "status": data.get("status", "present"),  # present, partial, absent
        "minutes": int(data.get("minutes", 0)),
        "note": data.get("note", ""),
        "created": now_str()
    }
    d = load_data(name)
    d["attendance"].append(record)
    save_data(name, d)
    return jsonify({"ok": True, "record": record})

@app.route("/api/<name>/attendance/<rec_id>", methods=["PUT"])
def update_attendance(name, rec_id):
    ensure_profile(name)
    data = request.get_json(force=True)
    d = load_data(name)
    for r in d["attendance"]:
        if r["id"] == rec_id:
            r.update(data)
            r["modified"] = now_str()
            break
    save_data(name, d)
    return jsonify({"ok": True})

@app.route("/api/<name>/attendance/<rec_id>", methods=["DELETE"])
def delete_attendance(name, rec_id):
    ensure_profile(name)
    d = load_data(name)
    removed = next((r for r in d["attendance"] if r["id"] == rec_id), None)
    d["attendance"] = [r for r in d["attendance"] if r["id"] != rec_id]
    if removed:
        push_trash(name, "attendance", removed)
    save_data(name, d)
    return jsonify({"ok": True, "undoable": bool(removed)})

# ── Presence/Absence Default Mode ──
# Instead of manually marking every single attended class, the person
# picks whether they're mostly present or mostly absent, and this fills
# in the *expected* status for every past scheduled lesson automatically
# — leaving them to only log the exceptions (the opposite status) by
# hand. Off by default ("manual"), matching the old fully-manual flow.
def _daterange(start_str, end_str):
    start = datetime.strptime(start_str, "%Y-%m-%d")
    end = datetime.strptime(end_str, "%Y-%m-%d")
    cur = start
    one_day = __import__("datetime").timedelta(days=1)
    while cur <= end:
        yield cur.strftime("%Y-%m-%d")
        cur += one_day

def _date_in_range(date_str, start, end):
    if not start or not end:
        return False
    return start <= date_str <= end

def autofill_attendance_for_profile(name):
    """Bounded to dates within each subject's assigned academic year, and
    skips dates suppressed by that year's exam periods/vacation weeks,
    mirroring the Timetable's own suppression rules exactly so autofilled
    records never contradict what's shown there. Subjects without a year
    assigned are skipped (no date bounds to work from)."""
    cfg = load_config(name)
    mode = cfg.get("attendance_default_mode", "manual")
    if mode not in ("mostly_present", "mostly_absent"):
        return 0
    default_status = "present" if mode == "mostly_present" else "absent"

    d = load_data(name)
    existing = set((r.get("subject_id"), r.get("date"), r.get("type")) for r in d.get("attendance", []))

    years_by_id = {y["id"]: y for y in cfg.get("academic_years", [])}
    yesterday = (datetime.strptime(today_str(), "%Y-%m-%d") - __import__("datetime").timedelta(days=1)).strftime("%Y-%m-%d")
    last_filled = cfg.get("attendance_autofill_last_date", "")
    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    created = 0

    for s in cfg.get("subjects", []):
        yr = years_by_id.get(s.get("year_id", ""))
        if not yr or not yr.get("start_date") or not yr.get("end_date") or not s.get("schedule"):
            continue
        range_start = max(yr["start_date"], last_filled) if last_filled else yr["start_date"]
        range_end = min(yesterday, yr["end_date"])
        if range_start > range_end:
            continue
        for date_str in _daterange(range_start, range_end):
            if any(_date_in_range(date_str, p.get("start_date"), p.get("end_date")) for p in yr.get("exam_periods", [])):
                continue
            if any(_date_in_range(date_str, v.get("start_date"), v.get("end_date")) for v in yr.get("vacation_weeks", [])):
                continue
            dow = day_names[datetime.strptime(date_str, "%Y-%m-%d").weekday()]
            for sch in s.get("schedule", []):
                if sch.get("day") != dow:
                    continue
                sch_type = sch.get("type", "C")
                key = (s["id"], date_str, sch_type)
                if key in existing:
                    continue
                try:
                    sh, sm = (sch.get("start") or "08:00").split(":")
                    eh, em = (sch.get("end") or sch.get("start") or "09:00").split(":")
                    minutes = max(15, (int(eh) * 60 + int(em)) - (int(sh) * 60 + int(sm)))
                except Exception:
                    minutes = 90
                d.setdefault("attendance", []).append({
                    "id": gen_id(12), "date": date_str, "subject_id": s["id"],
                    "type": sch_type, "event_label": f"{s['name']} {sch_type} (auto)",
                    "status": default_status, "minutes": minutes,
                    "note": "Auto-filled by default attendance mode", "created": now_str()
                })
                existing.add(key)
                created += 1

    if created:
        save_data(name, d)
    cfg["attendance_autofill_last_date"] = yesterday
    save_config(name, cfg)
    return created

@app.route("/api/<name>/attendance/autofill", methods=["POST"])
def attendance_autofill(name):
    ensure_profile(name)
    created = autofill_attendance_for_profile(name)
    return jsonify({"ok": True, "created": created})

# ── Exams ──
@app.route("/api/<name>/exams", methods=["POST"])
def add_exam(name):
    ensure_profile(name)
    data = request.get_json(force=True)
    exam = {
        "id": gen_id(12),
        "year_id": data.get("year_id", ""),
        "subject_id": data.get("subject_id", ""),
        "name": data.get("name", ""),
        "date": data.get("date", today_str()),
        "start_time": data.get("start_time", "08:00"),
        "duration_minutes": int(data.get("duration_minutes", 120)),
        "status": data.get("status", "scheduled"),  # scheduled, done, missed
        "note": data.get("note", ""),
        "score": data.get("score", None),  # 0-20 scale, null if not graded
        "ranking": data.get("ranking", None),  # e.g. "15/120"
        "max_score": data.get("max_score", 20),
        "notes": data.get("notes", ""),  # additional notes
        "created": now_str()
    }
    # Validate score range
    if exam["score"] is not None:
        exam["score"] = max(0, min(20, float(exam["score"])))
    d = load_data(name)
    d["exams"].append(exam)
    save_data(name, d)
    return jsonify({"ok": True, "exam": exam})

@app.route("/api/<name>/exams/<exam_id>", methods=["PUT"])
def update_exam(name, exam_id):
    ensure_profile(name)
    data = request.get_json(force=True)
    d = load_data(name)
    for e in d["exams"]:
        if e["id"] == exam_id:
            e.update(data)
            # Validate score range if being updated
            if "score" in data and e.get("score") is not None:
                e["score"] = max(0, min(20, float(e["score"])))
            e["modified"] = now_str()
            break
    save_data(name, d)
    return jsonify({"ok": True})

@app.route("/api/<name>/exams/<exam_id>", methods=["DELETE"])
def delete_exam(name, exam_id):
    ensure_profile(name)
    d = load_data(name)
    removed = next((e for e in d["exams"] if e["id"] == exam_id), None)
    d["exams"] = [e for e in d["exams"] if e["id"] != exam_id]
    if removed:
        push_trash(name, "exams", removed)
    save_data(name, d)
    return jsonify({"ok": True, "undoable": bool(removed)})

# ── Events (one-time) ──
@app.route("/api/<name>/events", methods=["POST"])
def add_event(name):
    ensure_profile(name)
    data = request.get_json(force=True)
    event = {
        "id": gen_id(12),
        "date": data.get("date", today_str()),
        "name": data.get("name", ""),
        "type": data.get("type", "meeting"),  # meeting, workshop, other
        "start_time": data.get("start_time", ""),
        "end_time": data.get("end_time", ""),
        "minutes": int(data.get("minutes", 0)),
        "status": data.get("status", "scheduled"),
        "note": data.get("note", ""),
        "created": now_str()
    }
    d = load_data(name)
    d["events"].append(event)
    save_data(name, d)
    return jsonify({"ok": True, "event": event})

@app.route("/api/<name>/events/<event_id>", methods=["PUT"])
def update_event(name, event_id):
    ensure_profile(name)
    data = request.get_json(force=True)
    d = load_data(name)
    for e in d["events"]:
        if e["id"] == event_id:
            e.update(data)
            e["modified"] = now_str()
            break
    save_data(name, d)
    return jsonify({"ok": True})

@app.route("/api/<name>/events/<event_id>", methods=["DELETE"])
def delete_event(name, event_id):
    ensure_profile(name)
    d = load_data(name)
    d["events"] = [e for e in d["events"] if e["id"] != event_id]
    save_data(name, d)
    return jsonify({"ok": True})

# ── Timer ──
@app.route("/api/<name>/timer/start", methods=["POST"])
def timer_start(name):
    ensure_profile(name)
    data = request.get_json(force=True)
    timer = {
        "id": gen_id(12),
        "subject_id": data.get("subject_id", ""),
        "skill_id": data.get("skill_id", ""),
        "planned_minutes": int(data.get("planned_minutes", 0)),
        "actual_minutes": 0,
        "started_at": now_str(),
        "status": "running",
        "note": data.get("note", "")
    }
    d = load_data(name)
    d["timers"].append(timer)
    save_data(name, d)
    return jsonify({"ok": True, "timer": timer})

@app.route("/api/<name>/timer/<timer_id>/stop", methods=["POST"])
def timer_stop(name, timer_id):
    ensure_profile(name)
    data = request.get_json(force=True)
    d = load_data(name)
    xp_earned = 0
    for t in d["timers"]:
        if t["id"] == timer_id:
            t["status"] = "completed"
            t["actual_minutes"] = int(data.get("actual_minutes", 0))
            t["completed_at"] = now_str()
            t["difficulty"] = data.get("difficulty", 5)
            t["self_study_status"] = data.get("self_study_status", "Done")
            # Auto-create self-study record if requested
            if data.get("auto_record", True):
                record = {
                    "id": gen_id(12),
                    "date": today_str(),
                    "subject_id": t.get("subject_id", ""),
                    "skill_id": t.get("skill_id", ""),
                    "minutes": t["actual_minutes"],
                    "difficulty": data.get("difficulty", 5),
                    "status": data.get("self_study_status", "Done"),
                    "note": t.get("note", ""),
                    "created": now_str()
                }
                d["self_study"].append(record)
                xp_earned = compute_self_study_record_xp(record["minutes"], record["difficulty"], record["status"])
            break
    save_data(name, d)
    return jsonify({"ok": True, "xp_earned": xp_earned})

@app.route("/api/<name>/timer/<timer_id>", methods=["DELETE"])
def delete_timer(name, timer_id):
    ensure_profile(name)
    d = load_data(name)
    d["timers"] = [t for t in d["timers"] if t["id"] != timer_id]
    save_data(name, d)
    return jsonify({"ok": True})

# ── File Upload ──
@app.route("/api/<name>/files/<ref_type>/<ref_id>", methods=["POST"])
def upload_file(name, ref_type, ref_id):
    ensure_profile(name)
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "Empty filename"}), 400
    # SECURITY: the raw filename used to be trusted as-is, so a filename
    # like "../../config.json" could write outside the intended folder.
    # secure_filename() strips path separators and unsafe characters.
    safe_name = secure_filename(file.filename)
    if not safe_name:
        return jsonify({"error": "Invalid filename"}), 400
    if ref_type == "skill":
        fd = files_dir(name) / f"skill_{ref_id}"
    else:
        fd = files_dir(name) / ref_id
    fd.mkdir(exist_ok=True)
    filepath = fd / safe_name
    file.save(filepath)
    return jsonify({"ok": True, "filename": safe_name, "size": filepath.stat().st_size})

@app.route("/api/<name>/files/<ref_type>/<ref_id>")
def list_files(name, ref_type, ref_id):
    ensure_profile(name)
    if ref_type == "skill":
        fd = files_dir(name) / f"skill_{ref_id}"
    else:
        fd = files_dir(name) / ref_id
    if not fd.exists():
        return jsonify([])
    files = []
    for f in sorted(fd.iterdir()):
        if f.is_file():
            files.append({
                "name": f.name,
                "size": f.stat().st_size,
                "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(f.stat().st_mtime))
            })
    return jsonify(files)

@app.route("/api/<name>/files/<ref_type>/<ref_id>/<filename>")
def download_file(name, ref_type, ref_id, filename):
    ensure_profile(name)
    filename = secure_filename(filename)
    if ref_type == "skill":
        fd = files_dir(name) / f"skill_{ref_id}"
    else:
        fd = files_dir(name) / ref_id
    filepath = fd / filename
    if not filepath.exists():
        abort(404)
    return send_file(filepath)

@app.route("/api/<name>/files/<ref_type>/<ref_id>/<filename>", methods=["DELETE"])
def delete_file(name, ref_type, ref_id, filename):
    ensure_profile(name)
    filename = secure_filename(filename)
    if ref_type == "skill":
        fd = files_dir(name) / f"skill_{ref_id}"
    else:
        fd = files_dir(name) / ref_id
    filepath = fd / filename
    if filepath.exists():
        filepath.unlink()
    return jsonify({"ok": True})

# ── ML Recommendations ──
@app.route("/api/<name>/ml_recommendations")
def ml_recommendations(name):
    """Kept as a standalone endpoint for anyone integrating externally,
    but the main app now gets recommendations from /stats, which already
    calls the same get_recommendations()."""
    ensure_profile(name)
    cfg = load_config(name)
    d = load_data(name)
    recommendations = get_recommendations(cfg, d)
    return jsonify({"recommendations": recommendations})


# ── Gamification (XP / Levels / Streaks / Unlockables) ──
# Design note: XP and streaks are DERIVED from the actual self_study/
# attendance/exam records every time this is requested, rather
# than being persisted as a mutable counter. A persisted counter would
# drift out of sync the moment someone edits or deletes a record after
# the fact (e.g. deletes a self-study session after already being
# awarded XP for it) — recomputing from source data is slightly more
# work per request but can never be wrong.

def xp_for_level(level):
    """XP required to go from `level` to `level+1`. Uncapped — there is
    no maximum level — but each level costs progressively more XP than
    the last, the same general shape as long-run MMO leveling curves
    (e.g. League of Legends past level 30): steady, always a bit more
    per level, never actually capped.

    Tuned so early levels come fast (level 2 within the first study
    session) and mid-game unlocks land at realistic usage milestones —
    roughly: Lv5 ~7h, Lv10 ~34h, Lv15 ~82h, Lv20 ~150h, Lv30 ~375h,
    Lv50 ~1160h — with high levels (80-125+) as a genuine multi-year
    prestige tail rather than a wall nobody reaches. An earlier version
    of this curve put Lv20 at ~500h, which felt punishing rather than
    motivating; these constants replace it."""
    return int(35 * (level ** 1.22)) + 40

def level_from_xp(total_xp):
    level = 1
    remaining = max(0.0, total_xp)
    guard = 0
    while remaining >= xp_for_level(level) and guard < 200000:
        remaining -= xp_for_level(level)
        level += 1
        guard += 1
    return level, remaining, xp_for_level(level)

def compute_self_study_record_xp(minutes, difficulty, status):
    """XP for a single self-study record: minutes * (1 + difficulty/20)
    * a status multiplier (Done=1x, Partial=0.5x, Skipped=0x). A harder
    subject (higher difficulty) earns more per minute — e.g. at
    difficulty 5/10 that's 1.25 XP/min, at difficulty 10/10 it's 1.5
    XP/min, both at status Done."""
    mult = 1.0 if status == "Done" else (0.5 if status == "Partial" else 0.0)
    return round(minutes * (1 + difficulty / 20.0) * mult, 1)

def compute_total_xp(d, cfg=None):
    xp = 0.0
    for r in d.get("self_study", []):
        mins = r.get("minutes", 0)
        diff = r.get("difficulty", 5)
        status = r.get("status", "Done")
        mult = 1.0 if status == "Done" else (0.5 if status == "Partial" else 0.0)
        xp += mins * (1 + diff / 20.0) * mult
    for r in d.get("attendance", []):
        if r.get("status") == "present":
            xp += 8
        elif r.get("status") == "partial":
            xp += 4
    for e in d.get("exams", []):
        if e.get("status") == "done":
            score = e.get("score")
            xp += 20 + ((score / 20.0) * 30 if score is not None else 0)
    # Additional XP sources (badges/mastery/quests/logins) — added so that
    # reaching high levels doesn't depend on raw study minutes alone.
    _, badge_xp = compute_badge_progress(d)
    xp += badge_xp
    if cfg is not None:
        _, mastery_xp = compute_mastery(cfg, d)
        xp += mastery_xp
    _, quest_xp = compute_quest_progress(d)
    xp += quest_xp
    xp += compute_login_xp(d)
    return xp

def compute_streak(d):
    done_dates = sorted(set(
        r.get("date") for r in d.get("self_study", [])
        if r.get("status") == "Done" and r.get("date")
    ))
    if not done_dates:
        return 0, 0
    try:
        date_objs = [datetime.strptime(x, "%Y-%m-%d").date() for x in done_dates]
    except Exception:
        return 0, 0

    best = 1
    cur_run = 1
    for i in range(1, len(date_objs)):
        if (date_objs[i] - date_objs[i - 1]).days == 1:
            cur_run += 1
        else:
            cur_run = 1
        best = max(best, cur_run)

    last_date = date_objs[-1]
    try:
        today = datetime.strptime(today_str(), "%Y-%m-%d").date()
    except Exception:
        today = last_date
    if (today - last_date).days > 1:
        current = 0
    else:
        current = 1
        i = len(date_objs) - 1
        while i > 0 and (date_objs[i] - date_objs[i - 1]).days == 1:
            current += 1
            i -= 1
    return current, best

TIERS = ["Bachelor's I", "Bachelor's II", "Bachelor's III", "Master's I", "Master's II",
         "Master's III", "PhD I", "PhD II", "PhD III", "Laureate"]
TIER_XP = [30, 80, 180, 350, 650, 1200, 2200, 4000, 7000, 12000]
MASTERY_TIER_XP = [20, 50, 120, 250, 500, 900, 1600, 3000, 5200, 9000]

def _tier_progress(value, thresholds):
    """Given a raw accumulator value and 8 ascending thresholds, return
    (tier_index reached (-1 if none), xp earned from all tiers reached,
    next threshold or None)."""
    reached = -1
    xp = 0
    for i, t in enumerate(thresholds):
        if value >= t:
            reached = i
            xp += TIER_XP[i]
        else:
            break
    nxt = thresholds[reached + 1] if reached + 1 < len(thresholds) else None
    return reached, xp, nxt

BADGE_DEFS = [
    {"id": "hours", "label": "Study Hours", "icon": "\U0001F4DA", "thresholds_min": [60, 300, 900, 2400, 6000, 15000, 36000, 72000, 132000, 240000]},
    {"id": "streak", "label": "Study Streak", "icon": "\U0001F525", "thresholds_days": [2, 3, 5, 7, 14, 30, 60, 100, 180, 365]},
    {"id": "early_bird", "label": "Early Bird", "icon": "\U0001F305", "thresholds_count": [1, 3, 7, 15, 30, 60, 120, 250, 450, 800]},
    {"id": "night_owl", "label": "Night Owl", "icon": "\U0001F989", "thresholds_count": [1, 3, 7, 15, 30, 60, 120, 250, 450, 800]},
    {"id": "attendance", "label": "Perfect Attendance", "icon": "\u2705", "thresholds_count": [5, 15, 30, 60, 120, 250, 500, 1000, 1800, 3200]},
    {"id": "exam_ace", "label": "Exam Ace", "icon": "\U0001F3C6", "thresholds_count": [1, 2, 4, 7, 12, 20, 35, 60, 100, 160]},
    {"id": "comeback", "label": "Comeback Kid", "icon": "\U0001F4AA", "thresholds_count": [1, 2, 4, 7, 12, 20, 35, 50, 75, 110]},
    {"id": "well_rounded", "label": "Well-Rounded", "icon": "\u2696\uFE0F", "thresholds_count": [1, 2, 4, 8, 15, 25, 40, 60, 90, 130]},
    {"id": "variety", "label": "Subject Variety", "icon": "\U0001F3AF", "thresholds_count": [2, 4, 6, 9, 13, 18, 25, 35, 48, 65]},
    {"id": "weekend", "label": "Weekend Warrior", "icon": "\U0001F3D6\uFE0F", "thresholds_count": [1, 3, 7, 15, 30, 60, 120, 250, 450, 800]},
    {"id": "marathon", "label": "Marathoner", "icon": "\U0001F3C3", "thresholds_count": [1, 3, 6, 12, 20, 35, 60, 100, 150, 220]},
    {"id": "login_streak", "label": "Loyal Login", "icon": "\U0001F4C5", "thresholds_days": [3, 7, 14, 30, 60, 100, 180, 365, 600, 900]},
]

def _week_key(date_str):
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        y, w, _ = dt.isocalendar()
        return f"{y}-W{w:02d}"
    except Exception:
        return None

def compute_badge_progress(d):
    """Returns list of badge dicts with tier reached + xp. Also used to
    feed extra XP sources so leveling doesn't rely on raw study time
    alone."""
    ss = d.get("self_study", [])
    done = [r for r in ss if r.get("status") == "Done"]
    total_minutes = sum(r.get("minutes", 0) for r in done)

    def _hour(ts_created):
        try:
            return int(ts_created[11:13])
        except Exception:
            return None

    early = sum(1 for r in done if (h := _hour(r.get("created", ""))) is not None and h < 8)
    night = sum(1 for r in done if (h := _hour(r.get("created", ""))) is not None and (h >= 22 or h < 4))
    marathon = sum(1 for r in done if r.get("minutes", 0) >= 120)

    weekend = 0
    for r in done:
        try:
            wd = datetime.strptime(r.get("date", ""), "%Y-%m-%d").weekday()
            if wd >= 5:
                weekend += 1
        except Exception:
            pass

    attendance_present = sum(1 for r in d.get("attendance", []) if r.get("status") == "present")
    exam_ace = sum(1 for e in d.get("exams", []) if e.get("score") is not None and e.get("score", 0) >= 16)

    variety_ids = set()
    for r in done:
        if r.get("subject_id"):
            variety_ids.add(("s", r["subject_id"]))
        if r.get("skill_id"):
            variety_ids.add(("k", r["skill_id"]))
    variety = len(variety_ids)

    # comeback: gaps of >=5 days between consecutive Done dates
    dates = sorted(set(r.get("date") for r in done if r.get("date")))
    comeback = 0
    for i in range(1, len(dates)):
        try:
            gap = (datetime.strptime(dates[i], "%Y-%m-%d") - datetime.strptime(dates[i - 1], "%Y-%m-%d")).days
            if gap >= 5:
                comeback += 1
        except Exception:
            pass

    # well-rounded: weeks with both self_study and attendance present
    weeks_study = set(_week_key(r.get("date", "")) for r in done)
    weeks_att = set(_week_key(r.get("date", "")) for r in d.get("attendance", []))
    well_rounded = len((weeks_study & weeks_att) - {None})

    _, best_streak = compute_streak(d)
    login_dates = sorted(set(d.get("logins", [])))
    login_streak_best = _best_run(login_dates)

    values = {
        "hours": (total_minutes, "thresholds_min"),
        "streak": (best_streak, "thresholds_days"),
        "early_bird": (early, "thresholds_count"),
        "night_owl": (night, "thresholds_count"),
        "attendance": (attendance_present, "thresholds_count"),
        "exam_ace": (exam_ace, "thresholds_count"),
        "comeback": (comeback, "thresholds_count"),
        "well_rounded": (well_rounded, "thresholds_count"),
        "variety": (variety, "thresholds_count"),
        "weekend": (weekend, "thresholds_count"),
        "marathon": (marathon, "thresholds_count"),
        "login_streak": (login_streak_best, "thresholds_days"),
    }

    badges = []
    total_badge_xp = 0
    for b in BADGE_DEFS:
        thresholds = b.get("thresholds_min") or b.get("thresholds_count") or b.get("thresholds_days")
        value, _ = values[b["id"]]
        tier_idx, xp, nxt = _tier_progress(value, thresholds)
        total_badge_xp += xp
        badges.append({
            "id": b["id"], "label": b["label"], "icon": b["icon"],
            "value": value, "tier_index": tier_idx,
            "tier_name": TIERS[tier_idx] if tier_idx >= 0 else None,
            "next_threshold": nxt, "max_tier": tier_idx == len(thresholds) - 1
        })
    return badges, total_badge_xp

def _best_run(sorted_unique_dates):
    if not sorted_unique_dates:
        return 0
    try:
        objs = [datetime.strptime(x, "%Y-%m-%d").date() for x in sorted_unique_dates]
    except Exception:
        return 0
    best = 1
    run = 1
    for i in range(1, len(objs)):
        if (objs[i] - objs[i - 1]).days == 1:
            run += 1
        else:
            run = 1
        best = max(best, run)
    return best

def compute_mastery(cfg, d):
    """Per-subject and per-skill mastery, same Iron..Challenger tiers,
    based on minutes invested. Every subject/skill the person adds opens
    up a brand new masterable track (and its XP potential)."""
    thresholds = [60, 300, 900, 2400, 6000, 12000, 24000, 45000, 80000, 140000]
    minutes_by_subject = defaultdict(float)
    minutes_by_skill = defaultdict(float)
    for r in d.get("self_study", []):
        if r.get("status") != "Done":
            continue
        if r.get("subject_id"):
            minutes_by_subject[r["subject_id"]] += r.get("minutes", 0)
        if r.get("skill_id"):
            minutes_by_skill[r["skill_id"]] += r.get("minutes", 0)

    mastery = []
    total_mastery_xp = 0
    for s in cfg.get("subjects", []):
        mins = minutes_by_subject.get(s["id"], 0)
        tier_idx, xp, nxt = _tier_progress(mins, thresholds)
        # mastery uses its own smaller xp table
        xp = sum(MASTERY_TIER_XP[:tier_idx + 1]) if tier_idx >= 0 else 0
        total_mastery_xp += xp
        mastery.append({"type": "subject", "id": s["id"], "name": s["name"], "minutes": mins,
                         "tier_index": tier_idx, "tier_name": TIERS[tier_idx] if tier_idx >= 0 else None, "next_threshold": nxt})
    for s in cfg.get("skills", []):
        mins = minutes_by_skill.get(s["id"], 0)
        tier_idx, xp, nxt = _tier_progress(mins, thresholds)
        xp = sum(MASTERY_TIER_XP[:tier_idx + 1]) if tier_idx >= 0 else 0
        total_mastery_xp += xp
        mastery.append({"type": "skill", "id": s["id"], "name": s["name"], "minutes": mins,
                         "tier_index": tier_idx, "tier_name": TIERS[tier_idx] if tier_idx >= 0 else None, "next_threshold": nxt})
    return mastery, total_mastery_xp

QUEST_DEFS = [
    {"id": "days3", "label": "Study on 3+ different days this week", "xp": 40},
    {"id": "hours5", "label": "Log 5+ hours of self-study this week", "xp": 60},
    {"id": "variety2", "label": "Study 2+ different subjects/skills this week", "xp": 40},
    {"id": "attendance3", "label": "Log attendance for 3+ classes this week", "xp": 30},
]

def _week_records(records, week):
    return [r for r in records if _week_key(r.get("date", "")) == week]

def compute_quest_progress(d):
    """Weekly quests, evaluated per ISO week found in the data. Fully
    derived (no 'claimed' state) — a week either satisfies a quest or it
    doesn't, so total XP from quests is just the sum across every week
    that satisfied each quest. Also returns THIS week's live status."""
    all_weeks = set()
    for coll in ("self_study", "attendance"):
        for r in d.get(coll, []):
            wk = _week_key(r.get("date", ""))
            if wk:
                all_weeks.add(wk)
    this_week = _week_key(today_str())
    all_weeks.add(this_week)

    total_quest_xp = 0
    this_week_status = []
    for week in all_weeks:
        study = _week_records(d.get("self_study", []), week)
        att = _week_records(d.get("attendance", []), week)
        done_study = [r for r in study if r.get("status") == "Done"]
        days = len(set(r.get("date") for r in done_study))
        hours = sum(r.get("minutes", 0) for r in done_study) / 60.0
        variety = len(set((r.get("subject_id"), r.get("skill_id")) for r in done_study if r.get("subject_id") or r.get("skill_id")))
        attendance_logged = len(att)

        results = {
            "days3": days >= 3, "hours5": hours >= 5,
            "variety2": variety >= 2, "attendance3": attendance_logged >= 3
        }
        for q in QUEST_DEFS:
            if results.get(q["id"]):
                total_quest_xp += q["xp"]
        if week == this_week:
            this_week_status = [{"id": q["id"], "label": q["label"], "xp": q["xp"], "done": results.get(q["id"], False)} for q in QUEST_DEFS]

    return this_week_status, total_quest_xp

def compute_login_xp(d):
    """10 xp per unique login day, 5x (50xp) on every 7th consecutive day
    of an unbroken streak. Login dates are appended (deduped) by the
    /ping_login endpoint, so this is just as derivable as everything
    else — no fragile incremented counter."""
    dates = sorted(set(d.get("logins", [])))
    if not dates:
        return 0
    try:
        objs = [datetime.strptime(x, "%Y-%m-%d").date() for x in dates]
    except Exception:
        return 0
    xp = 0
    run = 1
    for i in range(len(objs)):
        if i > 0 and (objs[i] - objs[i - 1]).days == 1:
            run += 1
        else:
            run = 1
        xp += 50 if run % 7 == 0 else 10
    return xp


def _login_stats(d):
    login_dates = sorted(set(d.get("logins", [])))
    this_week = _week_key(today_str())
    login_days_this_week = sum(1 for day in login_dates if _week_key(day) == this_week)
    streak_current, streak_best = compute_streak(d)
    return {
        "login_dates": login_dates,
        "login_days_total": len(login_dates),
        "login_days_this_week": login_days_this_week,
        "login_streak_current": streak_current,
        "login_streak_best": streak_best,
    }


# Cosmetic themes unlocked by level. sakura/light/dark are the free
# starting set; everything else is a level-gated "skin".
THEME_CATALOG = [
    {"id": "sakura", "label": "Sakura", "level": 1},
    {"id": "light", "label": "Light", "level": 1},
    {"id": "dark", "label": "Dark", "level": 1},
    {"id": "breeze", "label": "Breeze", "level": 5},
    {"id": "midnight", "label": "Midnight", "level": 10},
    {"id": "forest", "label": "Forest", "level": 15},
    {"id": "sunset", "label": "Sunset", "level": 20},
    {"id": "ocean", "label": "Ocean", "level": 25},
    {"id": "rosegold", "label": "Rose Gold", "level": 30},
    {"id": "autumn", "label": "Autumn", "level": 40},
    {"id": "cyberpunk", "label": "Cyberpunk", "level": 50},
    {"id": "nord", "label": "Nord", "level": 65},
    {"id": "mono", "label": "Mono", "level": 80},
    {"id": "candy", "label": "Candy", "level": 100},
    {"id": "coffee", "label": "Coffee", "level": 125},
]

TITLE_TIERS = [
    (1, "Novice Scholar"), (5, "Diligent Student"), (10, "Focused Learner"),
    (20, "Dedicated Apprentice"), (30, "Skilled Researcher"), (45, "Adept Scholar"),
    (60, "Expert Analyst"), (80, "Master of Study"), (100, "Grandmaster Scholar"),
    (130, "Sage"), (160, "Luminary"), (200, "Archmage of Diligence"),
]

def title_for_level(level):
    title = TITLE_TIERS[0][1]
    for lvl, name in TITLE_TIERS:
        if level >= lvl:
            title = name
        else:
            break
    return title

@app.route("/api/<name>/gamification")
def gamification_status(name):
    ensure_profile(name)
    cfg = load_config(name)
    d = load_data(name)
    total_xp = compute_total_xp(d, cfg)
    level, xp_into, xp_needed = level_from_xp(total_xp)
    current_streak, best_streak = compute_streak(d)
    login_stats = _login_stats(d)
    unlocked = [t["id"] for t in THEME_CATALOG if t["level"] <= level]
    locked = [t for t in THEME_CATALOG if t["level"] > level]
    badges, _ = compute_badge_progress(d)
    mastery, _ = compute_mastery(cfg, d)
    quests_this_week, _ = compute_quest_progress(d)
    return jsonify({
        "xp": round(total_xp, 1),
        "level": level,
        "xp_into_level": round(xp_into, 1),
        "xp_for_next": xp_needed,
        "progress_pct": round(xp_into / xp_needed * 100, 1) if xp_needed else 0,
        "title": title_for_level(level),
        "streak_current": current_streak,
        "streak_best": best_streak,
        "login_streak_current": login_stats["login_streak_current"],
        "login_streak_best": login_stats["login_streak_best"],
        "login_days_total": login_stats["login_days_total"],
        "login_days_this_week": login_stats["login_days_this_week"],
        "unlocked_themes": unlocked,
        "locked_themes": locked,
        "theme_catalog": THEME_CATALOG,
        "badges": badges,
        "mastery": mastery,
        "quests_this_week": quests_this_week
    })

@app.route("/api/<name>/ping_login", methods=["POST"])
def ping_login(name):
    """Records today's date as a login (deduped) — call once per app
    load. Source data for the login-streak XP/badge, same derived-not-
    persisted-counter approach as everything else."""
    ensure_profile(name)
    d = load_data(name)
    logins = set(d.get("logins", []))
    today = today_str()
    is_new = today not in logins
    logins.add(today)
    d["logins"] = sorted(logins)
    save_data(name, d)
    login_stats = _login_stats(d)
    return jsonify({"ok": True, "new_today": is_new, **login_stats})


# ── Charts (seaborn) ──
# Charts are rendered server-side with seaborn/matplotlib and served as
# PNGs, styled to match the app's neon-dark theme. This replaced an
# earlier Chart.js (client-side) implementation — seaborn gives a much
# more polished, "professional report" look, and the same generator
# functions are reused by the PDF weekly report below.
import io as _io
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import seaborn as sns

# Fallback constants (also THEME_PALETTES["dark"]'s values) — kept as
# plain names so any code that still references them directly works.
CHART_BG = "#10151d"
CHART_PANEL = "#161d29"
CHART_BORDER = "#22304a"
CHART_TEXT = "#e8f1f8"
CHART_DIM = "#7188a0"
CHART_PALETTE = ["#00e5ff", "#7c3aed", "#ff2e88", "#39ff8f", "#ffcc00", "#ff8a3d", "#5fc9f8", "#c9a4ff"]
TIER_HEX = {"Bachelor's I": "#8a8a8a", "Bachelor's II": "#a3672f", "Bachelor's III": "#b9c2cc",
            "Master's I": "#e0b23a", "Master's II": "#4fd6c4", "Master's III": "#2ecc71",
            "PhD I": "#5fc9f8", "PhD II": "#c9a4ff", "PhD III": "#ff6ec7", "Laureate": "#ffd700"}

# Per-theme chart palettes, mirroring the CSS custom properties for each
# `data-theme` in styles.css (--bg2 as chart panel bg, --border, --text,
# --textdim, plus a 8-color qualitative palette built from that theme's
# accent/accent2/accent3/green/amber/red/gold tokens). This is what makes
# charts (and by extension the PDF report, which reuses generate_chart)
# match whatever theme is active in the app instead of always dark.
THEME_PALETTES = {
    "dark":     {"bg": "#0a0e14", "panel": "#10151d", "border": "#22304a", "text": "#e8f1f8", "dim": "#7188a0",
                 "palette": ["#00e5ff", "#7c3aed", "#ff2e88", "#39ff8f", "#ffcc00", "#ff8a3d", "#5fc9f8", "#c9a4ff"]},
    "light":    {"bg": "#ffffff", "panel": "#f8f9fa", "border": "#ced4da", "text": "#212529", "dim": "#6c757d",
                 "palette": ["#4a90d9", "#2d6da3", "#6bb3f0", "#28a745", "#fd7e14", "#dc3545", "#ffc107", "#6f42c1"]},
    "sakura":   {"bg": "#fdf6f6", "panel": "#fff9f9", "border": "#f49ac1", "text": "#3e2723", "dim": "#8d6e63",
                 "palette": ["#e91e63", "#ad1457", "#ff4081", "#2e7d32", "#e65100", "#c62828", "#f9a825", "#ab47bc"]},
    "breeze":   {"bg": "#f0f7ff", "panel": "#ffffff", "border": "#a0c4ff", "text": "#2a3a50", "dim": "#6080a0",
                 "palette": ["#6090d0", "#4070b0", "#80b0e0", "#4caf90", "#e8a030", "#d06060", "#d4a017", "#8e7cc3"]},
    "midnight": {"bg": "#0a0e1a", "panel": "#111827", "border": "#1e2d3d", "text": "#c9d1d9", "dim": "#586069",
                 "palette": ["#00ff88", "#00cc6a", "#00d4ff", "#ffb800", "#ff6b6b", "#ffd700", "#8892b0", "#c792ea"]},
    "forest":   {"bg": "#f4f7f1", "panel": "#ffffff", "border": "#a9c497", "text": "#263420", "dim": "#6b7f5e",
                 "palette": ["#4d7c3d", "#345a29", "#7fae5e", "#c98a26", "#b0453a", "#c9a227", "#3f8f42", "#8fae3d"]},
    "sunset":   {"bg": "#1a1023", "panel": "#241631", "border": "#4a2a5e", "text": "#f5e6e8", "dim": "#b79bc4",
                 "palette": ["#ff7849", "#d9534f", "#ffb347", "#4caf50", "#ffcc66", "#ff5f6d", "#c792ea", "#7fd8be"]},
    "ocean":    {"bg": "#08161e", "panel": "#0e2430", "border": "#1c4a5e", "text": "#d6f3f5", "dim": "#6f9ea5",
                 "palette": ["#22c1c3", "#1a8f91", "#5fe0e3", "#2ecc71", "#f4b942", "#e85d5d", "#ffd166", "#7fa8d9"]},
    "rosegold": {"bg": "#fdf5f2", "panel": "#ffffff", "border": "#e0b6a4", "text": "#4a3229", "dim": "#97776a",
                 "palette": ["#b76e79", "#9c5a63", "#d9a679", "#6b9b6e", "#c98a3f", "#c4595f", "#d4a94e", "#a688b0"]},
    "autumn":   {"bg": "#fbf3ea", "panel": "#ffffff", "border": "#d3a05f", "text": "#402c1c", "dim": "#8a6a4e",
                 "palette": ["#c1622b", "#96431a", "#e08e3e", "#6b8f3f", "#d99424", "#b0402b", "#c98a27", "#a9752f"]},
    "cyberpunk":{"bg": "#0a0a12", "panel": "#12121e", "border": "#3a2a4e", "text": "#eaf6ff", "dim": "#8888aa",
                 "palette": ["#ff2e88", "#b3005c", "#00e5ff", "#39ff8f", "#ffcc00", "#ff3860", "#ffe600", "#c792ea"]},
    "nord":     {"bg": "#2e3440", "panel": "#3b4252", "border": "#4c566a", "text": "#e5e9f0", "dim": "#8b93a6",
                 "palette": ["#88c0d0", "#5e81ac", "#8fbcbb", "#a3be8c", "#ebcb8b", "#bf616a", "#d08770", "#b48ead"]},
    "mono":     {"bg": "#ffffff", "panel": "#f5f5f5", "border": "#bbbbbb", "text": "#111111", "dim": "#6e6e6e",
                 "palette": ["#222222", "#555555", "#888888", "#3a7d44", "#a67c00", "#a83232", "#8a7000", "#444444"]},
    "candy":    {"bg": "#fff0fa", "panel": "#ffffff", "border": "#ff8ad8", "text": "#3a1a35", "dim": "#a35f95",
                 "palette": ["#ff4fc3", "#d626a0", "#7bd6ff", "#4fd68c", "#ffb84f", "#ff5c7a", "#ffd54f", "#c792ea"]},
    "coffee":   {"bg": "#221a14", "panel": "#2c221a", "border": "#4d3c2c", "text": "#f0e4d6", "dim": "#a5907c",
                 "palette": ["#c8965a", "#8a5a2e", "#e0b888", "#7ea15a", "#d9a441", "#c26b4f", "#d1a94e", "#a97c50"]},
}

def _theme_colors(theme):
    return THEME_PALETTES.get(theme, THEME_PALETTES["dark"])

def _style(tc):
    sns.set_theme(style="darkgrid", rc={
        "figure.facecolor": tc["bg"], "axes.facecolor": tc["panel"],
        "axes.edgecolor": tc["border"], "axes.labelcolor": tc["text"],
        "text.color": tc["text"], "xtick.color": tc["dim"], "ytick.color": tc["dim"],
        "grid.color": tc["border"], "savefig.facecolor": tc["bg"],
        "font.family": "sans-serif"
    })
    sns.set_palette(tc["palette"])

def _empty_fig(msg, tc):
    _style(tc)
    fig, ax = plt.subplots(figsize=(6, 3.2))
    ax.text(0.5, 0.5, msg, ha="center", va="center", color=tc["dim"], fontsize=12)
    ax.axis("off")
    return fig

def _fig_bytes(fig):
    buf = _io.BytesIO()
    fig.savefig(buf, format="png", dpi=140, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf

def _bar(labels, values, title, tc, xlabel="", horizontal=False, colors=None):
    _style(tc)
    if not labels:
        return _empty_fig("No data yet", tc)
    fig, ax = plt.subplots(figsize=(6.5, min(13, max(3.2, 0.42 * len(labels))) if horizontal else 4))
    palette = colors or (tc["palette"] * (len(labels) // len(tc["palette"]) + 1))[:len(labels)]
    if horizontal:
        sns.barplot(x=values, y=labels, ax=ax, palette=palette, hue=labels, legend=False)
        ax.set_xlabel(xlabel)
    else:
        sns.barplot(x=labels, y=values, ax=ax, palette=palette, hue=labels, legend=False)
        ax.set_ylabel(xlabel)
        plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
    ax.set_title(title, fontsize=13, fontweight="bold", color=tc["text"])
    fig.tight_layout()
    return fig

def _pie(labels, values, title, tc):
    _style(tc)
    if not labels or sum(values) == 0:
        return _empty_fig("No data yet", tc)
    fig, ax = plt.subplots(figsize=(5.5, 5))
    colors = (tc["palette"] * (len(labels) // len(tc["palette"]) + 1))[:len(labels)]
    wedges, texts, autotexts = ax.pie(values, labels=labels, autopct="%1.0f%%", colors=colors,
                                        wedgeprops={"edgecolor": tc["bg"], "linewidth": 2},
                                        textprops={"color": tc["text"], "fontsize": 9})
    for t in autotexts:
        t.set_color(tc["bg"])
        t.set_fontweight("bold")
    ax.set_title(title, fontsize=13, fontweight="bold", color=tc["text"])
    return fig

def _scatter_reg(x, y, xlabel, ylabel, title, tc, diagonal=False):
    _style(tc)
    if len(x) < 2:
        return _empty_fig("Not enough data yet", tc)
    fig, ax = plt.subplots(figsize=(6, 4.5))
    sns.regplot(x=x, y=y, ax=ax, scatter_kws={"color": tc["palette"][0], "s": 45, "alpha": .85},
                line_kws={"color": tc["palette"][2]})
    if diagonal:
        lo, hi = min(min(x), min(y)), max(max(x), max(y))
        ax.plot([lo, hi], [lo, hi], linestyle="--", color=tc["dim"], linewidth=1)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.set_title(title, fontsize=13, fontweight="bold", color=tc["text"])
    fig.tight_layout()
    return fig

def _line(x_labels, values, title, ylabel, tc):
    _style(tc)
    if len(values) < 2:
        return _empty_fig("Not enough data yet", tc)
    fig, ax = plt.subplots(figsize=(7, 4))
    sns.lineplot(x=range(len(values)), y=values, ax=ax, color=tc["palette"][0], linewidth=2.2, marker="o", markersize=4)
    ax.fill_between(range(len(values)), values, alpha=.15, color=tc["palette"][0])
    step = max(1, len(x_labels) // 10)
    ax.set_xticks(range(0, len(x_labels), step))
    ax.set_xticklabels([x_labels[i] for i in range(0, len(x_labels), step)], rotation=30, ha="right")
    ax.set_ylabel(ylabel)
    ax.set_title(title, fontsize=13, fontweight="bold", color=tc["text"])
    fig.tight_layout()
    return fig

def _radar(labels, series, title, tc):
    _style(tc)
    if len(labels) < 3:
        return _empty_fig("Need 3+ subjects for a radar chart", tc)
    import numpy as np
    angles = np.linspace(0, 2 * 3.14159265, len(labels), endpoint=False).tolist()
    angles += angles[:1]
    fig, ax = plt.subplots(figsize=(5.5, 5.5), subplot_kw={"projection": "polar"})
    fig.patch.set_facecolor(tc["bg"])
    ax.set_facecolor(tc["panel"])
    for i, (name, vals) in enumerate(series):
        vals = vals + vals[:1]
        color = tc["palette"][i % len(tc["palette"])]
        ax.plot(angles, vals, linewidth=2, label=name, color=color)
        ax.fill(angles, vals, alpha=.15, color=color)
    ax.set_xticks(angles[:-1])
    ax.set_xticklabels(labels, color=tc["text"], fontsize=8)
    ax.tick_params(colors=tc["dim"])
    ax.set_title(title, fontsize=13, fontweight="bold", color=tc["text"], pad=20)
    ax.legend(loc="upper right", bbox_to_anchor=(1.3, 1.1), fontsize=8, facecolor=tc["panel"], labelcolor=tc["text"])
    return fig

def _heatmap_calendar(by_date, title, tc):
    _style(tc)
    if not by_date:
        return _empty_fig("No data yet", tc)
    import numpy as np
    from datetime import timedelta
    dates = sorted(by_date.keys())
    first = datetime.strptime(dates[0], "%Y-%m-%d")
    last = datetime.strptime(dates[-1], "%Y-%m-%d")
    start = first - timedelta(days=first.weekday())
    n_days = (last - start).days + 1
    n_weeks = n_days // 7 + 1
    grid = np.zeros((7, n_weeks))
    cur = start
    for i in range(n_weeks * 7):
        key = cur.strftime("%Y-%m-%d")
        grid[cur.weekday(), i // 7] = by_date.get(key, 0) / 60.0
        cur += timedelta(days=1)
    # Rotated 90° clockwise: weeks now flow top-to-bottom (earliest at
    # top) and weekdays run left-to-right, instead of the original
    # weekday-rows/week-columns layout.
    rotated = np.rot90(grid, k=-1)
    weekday_labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    # k=-1 (clockwise) reverses the weekday axis in the process, so the
    # column labels need to be reversed to match.
    rotated_labels = list(reversed(weekday_labels))
    fig, ax = plt.subplots(figsize=(3.6, min(14, 1 + n_weeks * 0.35)))
    sns.heatmap(rotated, ax=ax, cmap=sns.light_palette(tc["palette"][0], as_cmap=True), cbar_kws={"label": "Hours"},
                xticklabels=rotated_labels, yticklabels=False, linewidths=.5, linecolor=tc["bg"])
    ax.set_title(title, fontsize=13, fontweight="bold", color=tc["text"])
    fig.tight_layout()
    return fig

def generate_chart(chart_id, cfg, d, stats_cache=None, theme="dark"):
    """Dispatch a chart_id to its builder. stats_cache is the already-
    computed get_stats() payload when available (avoids recomputation
    when called from the PDF report, which needs every chart at once).
    theme selects the color palette so charts (and the PDF report, which
    reuses this same function) match whatever theme is active in the
    app instead of always rendering dark."""
    stats = stats_cache if stats_cache is not None else _compute_stats_payload(cfg, d)
    subjects = {s["id"]: s["name"] for s in cfg.get("subjects", [])}
    tc = _theme_colors(theme)

    if chart_id == "self_study_by_subject":
        items = stats["self_study"]["by_subject"]
        return _pie(list(items.keys()), [v / 60 for v in items.values()], "Self-Study Distribution (hours)", tc)
    if chart_id == "daily_study_hours":
        by_date = stats["self_study"]["by_date"]
        dates = sorted(by_date.keys())
        return _bar([dt[5:] for dt in dates], [by_date[dt] / 60 for dt in dates], "Daily Study Hours", tc, "Hours")
    if chart_id == "attendance_by_type":
        bt = stats["attendance"]["by_type"]
        labels = [k for k, v in bt.items() if v > 0]
        return _pie(labels, [bt[k] / 60 for k in labels], "Uni Hours by Type", tc)
    if chart_id == "difficulty_radar":
        avg_diff = stats["self_study"]["avg_difficulty"]
        by_subj = stats["self_study"]["by_subject"]
        names = list(avg_diff.keys())[:8]
        series = [("Difficulty", [avg_diff[n] for n in names]),
                  ("Study Hrs (scaled)", [min(10, by_subj.get(n, 0) / 60) for n in names])]
        return _radar(names, series, "Subject Difficulty Profile", tc)
    if chart_id == "exam_scores":
        by_subj = stats["exam_scores"]["by_subject"]
        labels, values = [], []
        for name, scores in by_subj.items():
            for i, s in enumerate(scores):
                labels.append(f"{name} #{i+1}")
                values.append(s)
        return _bar(labels, values, "Exam Scores (out of 20)", tc, "Score")
    if chart_id == "attendance_summary":
        a = stats["attendance"]
        return _bar(["Present", "Partial", "Absent"], [a["present"], a["partial"], a["absent"]], "Attendance Summary", tc, "Count", horizontal=True,
                    colors=[tc["palette"][3], tc["palette"][4], tc["palette"][5]])
    if chart_id == "day_of_week":
        dow = stats["by_day_of_week"]
        return _bar(list(dow.keys()), [v / 60 for v in dow.values()], "Study by Day of Week", tc, "Hours")
    if chart_id == "status_breakdown":
        sc = stats["self_study"]["status_counts"]
        return _pie(list(sc.keys()), list(sc.values()), "Session Status Breakdown", tc)
    if chart_id == "difficulty_vs_score":
        pts = stats["difficulty_vs_score"]
        return _scatter_reg([p["difficulty"] for p in pts], [p["score"] for p in pts], "Difficulty", "Score", "Difficulty vs Exam Score", tc)
    if chart_id == "predicted_vs_actual":
        pts = stats["predicted_vs_actual"]
        return _scatter_reg([p["actual"] for p in pts], [p["predicted"] for p in pts], "Actual Score", "Predicted Score", "ML Model Fit", tc, diagonal=True)
    if chart_id == "xp_over_time":
        pts = stats["xp_over_time"]
        return _line([p["date"][5:] for p in pts], [p["cumulative_xp"] for p in pts], "XP Growth Over Time", "Cumulative XP", tc)
    if chart_id == "time_allocation":
        ta = stats["time_allocation"]
        labels = [k.replace("_", " ") for k in ta.keys()]
        return _pie(labels, [v / 60 for v in ta.values()], "Time Allocation (hours)", tc)
    if chart_id == "badges_by_tier":
        bt = stats["badge_tier_counts"]
        return _bar(list(bt.keys()), list(bt.values()), "Badges Earned by Tier", tc, "Count", colors=[TIER_HEX[k] for k in bt.keys()])
    if chart_id == "mastery_levels":
        m = stats["mastery"]
        labels = [x["name"] for x in m]
        values = [x["tier_index"] + 1 for x in m]
        colors = [TIER_HEX.get(x["tier_name"], "#666") for x in m]
        return _bar(labels, values, "Mastery Levels", tc, "Tier (1=Bachelor's I..10=Laureate)", horizontal=True, colors=colors)
    if chart_id == "study_heatmap":
        return _heatmap_calendar(stats["self_study"]["by_date"], "Study Consistency Heatmap", tc)
    return _empty_fig("Unknown chart", tc)

@app.route("/api/<name>/charts/<chart_id>")
def get_chart(name, chart_id):
    ensure_profile(name)
    cfg = load_config(name)
    d = load_data(name)
    theme = request.args.get("theme", "dark")
    fig = generate_chart(chart_id, cfg, d, theme=theme)
    return send_file(_fig_bytes(fig), mimetype="image/png")

def _filter_data_to_range(d, start_date, end_date):
    """Returns a copy of `d` containing only records dated within
    [start_date, end_date] (inclusive), for the weekly report."""
    def in_range(item):
        dt = item.get("date", "")
        return bool(dt) and start_date <= dt <= end_date
    return {
        "self_study": [r for r in d.get("self_study", []) if in_range(r)],
        "attendance": [r for r in d.get("attendance", []) if in_range(r)],
        "exams": [r for r in d.get("exams", []) if in_range(r)],
        "events": [r for r in d.get("events", []) if in_range(r)],
        "timers": d.get("timers", []),
        "logins": d.get("logins", [])
    }

def _report_cover_page(profile_name, cfg, week_stats, gam, start_date, end_date, tc):
    _style(tc)
    fig = plt.figure(figsize=(8.5, 11))
    fig.patch.set_facecolor(tc["bg"])
    fig.text(0.5, 0.93, "StudyTracker", ha="center", fontsize=26, fontweight="bold", color=tc["palette"][0])
    fig.text(0.5, 0.885, "Weekly Summary Report", ha="center", fontsize=15, color=tc["text"])
    fig.text(0.5, 0.85, f"{profile_name}  \u2022  {start_date} to {end_date}", ha="center", fontsize=11, color=tc["dim"])

    ss = week_stats["self_study"]
    att = week_stats["attendance"]
    ex = week_stats["exams"]
    lines = [
        f"Self-study logged:      {ss['total_hours']}h across {ss['total_sessions']} session(s)",
        f"Subjects/skills touched: {len(ss['by_subject'])}",
        f"Attendance:              {att['present']} present / {att['partial']} partial / {att['absent']} absent",
        f"Exams this week:        {ex['total']} ({ex['done']} completed)",
        "",
        f"Current level:           {gam['level']}  ({gam['title']})",
        f"XP this profile:        {round(gam['xp'])}",
        f"Study streak:           {gam['streak_current']} day(s)  (best: {gam['streak_best']})",
    ]
    fig.text(0.5, 0.72, "\n".join(lines), ha="center", va="top", fontsize=12, color=tc["text"], family="monospace", linespacing=2.0)

    recs = week_stats.get("recommendations", [])[:5]
    if recs:
        fig.text(0.1, 0.38, "Top Recommendations", fontsize=13, fontweight="bold", color=tc["palette"][2])
        rec_lines = [f"\u2022 {r['msg']}" for r in recs]
        wrapped = []
        for line in rec_lines:
            while len(line) > 90:
                cut = line.rfind(" ", 0, 90)
                wrapped.append(line[:cut])
                line = "    " + line[cut:]
            wrapped.append(line)
        fig.text(0.1, 0.34, "\n".join(wrapped), fontsize=9.5, color=tc["text"], va="top", linespacing=1.6, wrap=True)

    fig.text(0.5, 0.03, "Generated by StudyTracker", ha="center", fontsize=8, color=tc["dim"])
    return fig

@app.route("/api/<name>/report/weekly")
def weekly_report(name):
    ensure_profile(name)
    cfg = load_config(name)
    d = load_data(name)
    theme = request.args.get("theme", "dark")
    tc = _theme_colors(theme)
    today = datetime.strptime(today_str(), "%Y-%m-%d")
    start_date = (today - __import__("datetime").timedelta(days=6)).strftime("%Y-%m-%d")
    end_date = today_str()
    week_d = _filter_data_to_range(d, start_date, end_date)
    week_stats = _compute_stats_payload(cfg, week_d)

    total_xp = compute_total_xp(d, cfg)
    level, xp_into, xp_needed = level_from_xp(total_xp)
    streak_current, streak_best = compute_streak(d)
    gam = {"xp": total_xp, "level": level, "title": title_for_level(level),
           "streak_current": streak_current, "streak_best": streak_best}

    from matplotlib.backends.backend_pdf import PdfPages
    buf = _io.BytesIO()
    with PdfPages(buf) as pdf:
        cover = _report_cover_page(name, cfg, week_stats, gam, start_date, end_date, tc)
        pdf.savefig(cover, facecolor=tc["bg"])
        plt.close(cover)

        weekly_chart_ids = ["self_study_by_subject", "daily_study_hours", "day_of_week",
                             "attendance_by_type", "attendance_summary", "status_breakdown"]
        for cid in weekly_chart_ids:
            fig = generate_chart(cid, cfg, week_d, stats_cache=week_stats, theme=theme)
            pdf.savefig(fig, facecolor=tc["bg"])
            plt.close(fig)

        # A couple of all-time charts for longer-term context
        all_stats = _compute_stats_payload(cfg, d)
        for cid in ["xp_over_time", "study_heatmap"]:
            fig = generate_chart(cid, cfg, d, stats_cache=all_stats, theme=theme)
            pdf.savefig(fig, facecolor=tc["bg"])
            plt.close(fig)

    buf.seek(0)
    return send_file(buf, mimetype="application/pdf", as_attachment=True,
                      download_name=f"studytracker_weekly_{name}_{end_date}.pdf")

# ── Statistics ──
# ── Statistics ──
def _compute_stats_payload(cfg, d):

    subjects = {s["id"]: s for s in cfg.get("subjects", [])}
    skills = {s["id"]: s for s in cfg.get("skills", [])}

    # Self-study stats
    self_study_by_subject = {}
    self_study_by_date = {}
    self_study_total_minutes = 0
    self_study_by_week = {}
    self_study_status_counts = {"Done": 0, "Partial": 0, "Skipped": 0}
    self_study_difficulty_sum = {}
    self_study_difficulty_count = {}

    for r in d.get("self_study", []):
        sid = r.get("subject_id", "")
        sname = subjects.get(sid, {}).get("name", "Unknown") if sid else r.get("skill_id", "")
        if r.get("skill_id"):
            sname = f"[Skill] {skills.get(r['skill_id'], {}).get('name', 'Unknown')}"

        mins = r.get("minutes", 0)
        self_study_by_subject[sname] = self_study_by_subject.get(sname, 0) + mins
        self_study_total_minutes += mins

        date = r.get("date", "")
        self_study_by_date[date] = self_study_by_date.get(date, 0) + mins

        status = r.get("status", "Done")
        self_study_status_counts[status] = self_study_status_counts.get(status, 0) + 1

        diff = r.get("difficulty", 5)
        self_study_difficulty_sum[sname] = self_study_difficulty_sum.get(sname, 0) + diff
        self_study_difficulty_count[sname] = self_study_difficulty_count.get(sname, 0) + 1

    # Attendance stats
    attendance_by_subject = {}
    attendance_present = 0
    attendance_partial = 0
    attendance_absent = 0
    attendance_minutes_by_subject = {}
    attendance_by_type = {"C": 0, "TD": 0, "TP": 0}

    for r in d.get("attendance", []):
        sid = r.get("subject_id", "")
        sname = subjects.get(sid, {}).get("name", "Unknown")
        status = r.get("status", "present")
        atype = r.get("type", "C")
        mins = r.get("minutes", 0)

        if status == "present":
            attendance_present += 1
            attendance_minutes_by_subject[sname] = attendance_minutes_by_subject.get(sname, 0) + mins
            attendance_by_type[atype] = attendance_by_type.get(atype, 0) + mins
        elif status == "partial":
            attendance_partial += 1
            attendance_minutes_by_subject[sname] = attendance_minutes_by_subject.get(sname, 0) + mins
            attendance_by_type[atype] = attendance_by_type.get(atype, 0) + mins
        else:
            attendance_absent += 1

        attendance_by_subject[sname] = attendance_by_subject.get(sname, 0) + 1

    # Exam stats
    exams_total = len(d.get("exams", []))
    exams_done = sum(1 for e in d.get("exams", []) if e.get("status") == "done")
    exams_missed = sum(1 for e in d.get("exams", []) if e.get("status") == "missed")
    exams_by_subject = {}
    for e in d.get("exams", []):
        sid = e.get("subject_id", "")
        sname = subjects.get(sid, {}).get("name", "Unknown")
        exams_by_subject[sname] = exams_by_subject.get(sname, 0) + 1

    # ── Exam Scores (0-20) ──
    exam_scores_by_subject = {}  # {subject_name: [scores]}
    all_scores = []
    exam_scores_done = []
    for e in d.get("exams", []):
        score = e.get("score")
        if score is not None:
            sid = e.get("subject_id", "")
            sname = subjects.get(sid, {}).get("name", "Unknown")
            exam_scores_by_subject.setdefault(sname, []).append(score)
            all_scores.append(score)
            if e.get("status") == "done":
                exam_scores_done.append(score)

    avg_score = round(sum(all_scores) / len(all_scores), 2) if all_scores else None
    highest_score = max(all_scores) if all_scores else None
    lowest_score = min(all_scores) if all_scores else None

    # Score vs study correlation per subject
    score_study_correlation = {}
    for sname, scores in exam_scores_by_subject.items():
        # Get study minutes on dates near exam dates for this subject
        subject_id = None
        for sid, s in subjects.items():
            if s["name"] == sname:
                subject_id = sid
                break
        if subject_id:
            study_mins = []
            score_vals = []
            exam_dates = [e.get("date", "") for e in d.get("exams", [])
                         if e.get("subject_id") == subject_id and e.get("score") is not None]
            for r in d.get("self_study", []):
                if r.get("subject_id") == subject_id and r.get("date", "") in exam_dates:
                    study_mins.append(r.get("minutes", 0))
                    # Find corresponding score
                    for e in d.get("exams", []):
                        if e.get("subject_id") == subject_id and e.get("date", "") == r.get("date", "") and e.get("score") is not None:
                            score_vals.append(e["score"])
                            break
            if len(study_mins) >= 2 and len(score_vals) >= 2:
                corr = pearson_correlation(study_mins, score_vals)
                if corr is not None:
                    score_study_correlation[sname] = corr

    # Attendance-Score impact: compare scores when present vs absent
    attendance_score_impact = {}
    for sname, scores in exam_scores_by_subject.items():
        subject_id = None
        for sid, s in subjects.items():
            if s["name"] == sname:
                subject_id = sid
                break
        if subject_id:
            scores_when_present = []
            scores_when_absent = []
            for e in d.get("exams", []):
                if e.get("subject_id") != subject_id or e.get("score") is None:
                    continue
                exam_date = e.get("date", "")
                # Check if student was present on that date
                was_present = any(
                    r.get("subject_id") == subject_id and r.get("date", "") == exam_date and r.get("status") == "present"
                    for r in d.get("attendance", [])
                )
                was_absent = any(
                    r.get("subject_id") == subject_id and r.get("date", "") == exam_date and r.get("status") == "absent"
                    for r in d.get("attendance", [])
                )
                if was_present:
                    scores_when_present.append(e["score"])
                elif was_absent:
                    scores_when_absent.append(e["score"])
            if scores_when_present or scores_when_absent:
                avg_present = round(sum(scores_when_present) / len(scores_when_present), 2) if scores_when_present else None
                avg_absent = round(sum(scores_when_absent) / len(scores_when_absent), 2) if scores_when_absent else None
                attendance_score_impact[sname] = {
                    "avg_score_when_present": avg_present,
                    "avg_score_when_absent": avg_absent,
                    "present_count": len(scores_when_present),
                    "absent_count": len(scores_when_absent),
                    "difference": round(avg_present - avg_absent, 2) if avg_present is not None and avg_absent is not None else None
                }

    # Event stats
    events_total = len(d.get("events", []))
    events_done = sum(1 for e in d.get("events", []) if e.get("status") == "done")

    # ── Smart Recommendations (single unified engine — see
    # get_recommendations() near the top of this file) ──
    recommendations = get_recommendations(cfg, d)


    # ── Extended data for the expanded Stats/charts page ──
    DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    by_day_of_week = {n: 0 for n in DOW_NAMES}
    for r in d.get("self_study", []):
        if r.get("status") != "Done" or not r.get("date"):
            continue
        try:
            wd = datetime.strptime(r["date"], "%Y-%m-%d").weekday()
            by_day_of_week[DOW_NAMES[wd]] += r.get("minutes", 0)
        except Exception:
            pass

    difficulty_vs_score = []
    for e in d.get("exams", []):
        if e.get("score") is None:
            continue
        sid = e.get("subject_id", "")
        diff = subjects.get(sid, {}).get("difficulty")
        if diff is not None:
            difficulty_vs_score.append({"difficulty": diff, "score": e["score"], "subject": subjects.get(sid, {}).get("name", "Unknown")})

    # Predicted vs actual (in-sample) — visualizes how well the urgency
    # model's regression actually fits this person's own history. Only
    # computed when ML prediction is enabled (see ml_prediction_enabled).
    predicted_vs_actual = []
    if cfg.get("ml_prediction_enabled", True):
        X_train, y_train = build_exam_training_data(cfg, d)
        model = _fit_score_model(X_train, y_train)
        if model is not None:
            import numpy as np
            preds = model.predict(np.array(X_train))
            for actual, pred in zip(y_train, preds):
                predicted_vs_actual.append({"actual": actual, "predicted": round(max(0, min(20, float(pred))), 2)})

    # XP over time (cumulative), from the "flow" sources only (self-study,
    # attendance, exams) — badges/quests/logins are lumpy milestone
    # bonuses rather than a daily trend, so they're left out of this
    # specific chart to keep the curve meaningful.
    xp_events = []
    for r in d.get("self_study", []):
        if r.get("date"):
            mult = 1.0 if r.get("status") == "Done" else (0.5 if r.get("status") == "Partial" else 0.0)
            xp_events.append((r["date"], r.get("minutes", 0) * (1 + r.get("difficulty", 5) / 20.0) * mult))
    for r in d.get("attendance", []):
        if r.get("date"):
            xp_events.append((r["date"], 8 if r.get("status") == "present" else (4 if r.get("status") == "partial" else 0)))
    for e in d.get("exams", []):
        if e.get("date") and e.get("status") == "done":
            score = e.get("score")
            xp_events.append((e["date"], 20 + ((score / 20.0) * 30 if score is not None else 0)))
    xp_by_date = defaultdict(float)
    for dt, xp in xp_events:
        xp_by_date[dt] += xp
    xp_over_time = []
    running = 0.0
    for dt in sorted(xp_by_date.keys()):
        running += xp_by_date[dt]
        xp_over_time.append({"date": dt, "cumulative_xp": round(running, 1)})

    time_allocation = {
        "self_study": self_study_total_minutes,
        "attendance": sum(attendance_minutes_by_subject.values()),
        "events": sum(e.get("minutes", 0) for e in d.get("events", []))
    }

    badges_list, _ = compute_badge_progress(d)
    badge_tier_counts = {t: 0 for t in TIERS}
    for b in badges_list:
        if b["tier_name"]:
            badge_tier_counts[b["tier_name"]] += 1

    mastery_list, _ = compute_mastery(cfg, d)

    return {
        "self_study": {
            "total_minutes": self_study_total_minutes,
            "total_hours": round(self_study_total_minutes / 60, 1),
            "total_sessions": len(d.get("self_study", [])),
            "by_subject": self_study_by_subject,
            "by_date": self_study_by_date,
            "status_counts": self_study_status_counts,
            "avg_difficulty": {k: round(self_study_difficulty_sum[k] / v, 1)
                             for k, v in self_study_difficulty_count.items()}
        },
        "attendance": {
            "present": attendance_present,
            "partial": attendance_partial,
            "absent": attendance_absent,
            "total_events": attendance_present + attendance_partial + attendance_absent,
            "minutes_by_subject": attendance_minutes_by_subject,
            "by_type": attendance_by_type
        },
        "exams": {
            "total": exams_total,
            "done": exams_done,
            "missed": exams_missed,
            "by_subject": exams_by_subject
        },
        "exam_scores": {
            "by_subject": exam_scores_by_subject,
            "avg_score": avg_score,
            "highest": highest_score,
            "lowest": lowest_score,
            "score_vs_study_correlation": score_study_correlation
        },
        "attendance_score_impact": attendance_score_impact,
        "by_day_of_week": by_day_of_week,
        "difficulty_vs_score": difficulty_vs_score,
        "predicted_vs_actual": predicted_vs_actual,
        "xp_over_time": xp_over_time,
        "time_allocation": time_allocation,
        "badge_tier_counts": badge_tier_counts,
        "mastery": mastery_list,
        "events": {
            "total": events_total,
            "done": events_done
        },
        "recommendations": recommendations
    }

@app.route("/api/<name>/stats")
def get_stats(name):
    ensure_profile(name)
    cfg = load_config(name)
    d = load_data(name)
    return jsonify(_compute_stats_payload(cfg, d))

# ── Static files ──
@app.route("/")
def index():
    return send_file(Path(__file__).parent / "index.html")

@app.route("/app.js")
def app_js():
    return send_file(Path(__file__).parent / "app.js")

@app.route("/styles.css")
def styles_css():
    return send_file(Path(__file__).parent / "styles.css")

if __name__ == "__main__":
    print("StudyTracker v1.1.1 — http://localhost:8080")
    app.run(host="127.0.0.1", port=8080, debug=False)
