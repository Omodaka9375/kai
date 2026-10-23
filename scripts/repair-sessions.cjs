// One-time repair for cross-contaminated kai-sessions-*.json store files.
// RUN AFTER QUITTING KAI — the running app re-pollutes on every save.
//
// What it fixes (all idempotent — safe to re-run):
//   1. Re-homes session METAS whose workspaceRoot belongs in a different
//      project file (the in-memory list is global; each file must only hold
//      its own project's metas — that was the corruption vector). Stripping
//      without re-homing orphans the session's blob → it loads blank.
//   2. Moves message BLOBS whose meta was just re-homed (or whose meta lives
//      in another file) along with it — blob without meta in this file =
//      session loads blank.
//   3. Resets `activeId` to null when it references a session not in this
//      file (loadAll() then falls back to the project's newest session).
//   4. Drops dead blobs (no meta anywhere — data of deleted sessions).
// A .repair-backup.json is written for every file before it is modified.
//
// After the script prints CLEAN, start KAI again. The fixed build
// (saveSessionsList/saveActiveId scope filtering) keeps files clean.

const fs = require("fs");
const path = require("path");

const DIR =
  process.env.KAI_SESSIONS_DIR || "C:/Users/Valsinarb/AppData/Roaming/app.kai.terminal";

function nwp(p) {
  if (typeof p !== "string" || !p) return null;
  let n = p.replace(/\\/g, "/").toLowerCase();
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}
function pk(r) {
  const n = nwp(r);
  if (!n) return null;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < n.length; i++) {
    h ^= BigInt(n.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(36);
}
function sp(r) {
  const k = pk(r);
  return k ? `kai-sessions-${k}.json` : "kai-sessions.json";
}

const list = () =>
  fs.readdirSync(DIR).filter((f) => /^kai-sessions.*\.json$/.test(f) && !/backup/.test(f));

function load(f) {
  return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
}
function save(f, j) {
  fs.writeFileSync(path.join(DIR, f), JSON.stringify(j, null, 2));
}
function backup(f) {
  const full = path.join(DIR, f);
  if (!fs.existsSync(full + ".repair-backup.json"))
    fs.copyFileSync(full, full + ".repair-backup.json");
}

let stats = { metas: 0, metasRehomed: 0, blobsMoved: 0, blobsDead: 0, activeReset: 0 };

// Pass 1: id → home file (meta lookup across ALL live files).
const home = {};
for (const f of list()) {
  for (const s of load(f).sessions || []) {
    if (s && s.id) home[s.id] = sp(s.workspaceRoot);
  }
}

// Pass 2: repair each file.
for (const f of list()) {
  const j = load(f);
  const sess = Array.isArray(j.sessions) ? j.sessions : [];
  const ids = new Set(sess.map((s) => s && s.id));

  // metas that belong elsewhere
  const keep = [];
  const rehome = new Map(); // sid → newest meta (may exist in several polluted files)
  for (const s of sess) {
    if (!s || !s.id) continue;
    const own = s.workspaceRoot == null ? "kai-sessions.json" : sp(s.workspaceRoot);
    if (own === f) keep.push(s);
    else {
      const prev = rehome.get(s.id);
      if (!prev || (s.updatedAt || 0) > (prev.updatedAt || 0)) rehome.set(s.id, s);
    }
  }
  const removed = new Set(rehome.keys());

  // blobs to move / drop — a session whose meta is being re-homed keeps its
  // blob (moved along to the home file); only blobs with no meta ANYWHERE die.
  const moves = [];
  const dead = [];
  for (const k of Object.keys(j)) {
    if (!k.startsWith("messages:")) continue;
    const sid = k.slice(9);
    if (ids.has(sid) && !removed.has(sid)) continue; // meta here, stays
    const m = rehome.get(sid);
    const h = m ? (m.workspaceRoot == null ? "kai-sessions.json" : sp(m.workspaceRoot)) : home[sid];
    if (!h) dead.push(k); // no meta anywhere
    else if (h !== f) moves.push([k, h]);
    // h === f: blob already sits in its home file — the foreign meta being
    // re-homed (from whichever file holds it) will pair with it. Keep it.
  }

  const activeBad = j.activeId != null && !keep.some((s) => s.id === j.activeId);
  if (!removed.size && !moves.length && !dead.length && !activeBad) {
    console.log("clean:", f, `(${keep.length} sessions)`);
    continue;
  }

  backup(f);

  // apply re-homes + moves into target files first (read fresh per target)
  const targets = new Map();
  const target = (file) => {
    if (!targets.has(file)) {
      const full = path.join(DIR, file);
      targets.set(file, fs.existsSync(full) ? load(file) : { sessions: [] });
    }
    const t = targets.get(file);
    if (!Array.isArray(t.sessions)) t.sessions = [];
    return t;
  };
  for (const [sid, meta] of rehome) {
    const own = meta.workspaceRoot == null ? "kai-sessions.json" : sp(meta.workspaceRoot);
    const t = target(own);
    const ex = t.sessions.find((s) => s && s.id === sid);
    if (!ex) t.sessions.push(meta);
    else if ((ex.updatedAt || 0) < (meta.updatedAt || 0))
      t.sessions[t.sessions.indexOf(ex)] = meta;
    stats.metasRehomed++;
  }
  for (const [k, h] of moves) {
    target(h)[k] = j[k];
    delete j[k];
    stats.blobsMoved++;
  }
  for (const [h, hj] of targets) {
    const hf = path.join(DIR, h);
    if (!fs.existsSync(hf + ".repair-backup.json"))
      fs.copyFileSync(hf, hf + ".repair-backup.json");
    save(h, hj);
  }

  for (const k of dead) {
    delete j[k];
    stats.blobsDead++;
  }

  j.sessions = keep;
  stats.metas += removed.size;
  if (activeBad) {
    j.activeId = null;
    stats.activeReset++;
  }
  save(f, j);
  console.log(
    "REPAIRED:", f,
    "| metas -" + removed.size,
    "| metas re-homed " + rehome.size,
    "| blobs moved", moves.length, "→", [...new Set(moves.map((m) => m[1]))].join(","),
  );
}

// Pass 3: verify — every live file must hold only its own metas, every blob
// must have a meta in the same file, every activeId must be local.
const issues = [];
for (const f of list()) {
  const j = load(f);
  const sess = Array.isArray(j.sessions) ? j.sessions : [];
  const ids = new Set(sess.map((s) => s && s.id));
  for (const s of sess) {
    if (!s || !s.id || s.workspaceRoot == null) continue;
    if (sp(s.workspaceRoot) !== f) issues.push(`${f}: foreign meta ${s.id}`);
  }
  for (const k of Object.keys(j)) {
    if (k.startsWith("messages:") && !ids.has(k.slice(9)))
      issues.push(`${f}: blob without meta ${k.slice(9)}`);
  }
  if (j.activeId != null && !ids.has(j.activeId))
    issues.push(`${f}: foreign activeId`);
}

console.log("---");
console.log(
  "metas removed:", stats.metas,
  "| metas re-homed:", stats.metasRehomed,
  "| blobs moved:", stats.blobsMoved,
  "| dead blobs dropped:", stats.blobsDead,
  "| activeIds reset:", stats.activeReset,
);
if (issues.length) {
  console.log("REMAINING ISSUES " + issues.length + " — DO NOT START KAI YET:");
  issues.slice(0, 15).forEach((i) => console.log("  " + i));
  process.exit(1);
} else {
  console.log("ALL FILES CLEAN — safe to start KAI (use the fixed build).");
}