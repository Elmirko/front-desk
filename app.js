// Front Desk app: sign in → pick hotel → live building view, housekeeping, maintenance, setup, team.
(function () {
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = window.api;

// ───────────── vocabulary ─────────────
const { TY, BEDS, PAX, BEDDESC, BEDROOMS } = window.SH;
const VIEWS = ["", "sea", "city", "garden", "courtyard", "mountain", "pool"];
const FEATURES = ["balcony", "bathtub", "kitchen", "accessible", "connecting", "quiet", "near lift", "staff only"];
const isSpace = (id) => ROOMS[id] && SH.isSpace(ROOMS[id].ty);
const staffOnly = (R) => R.feat.has("staff only");
// type <select> with guest rooms and other spaces in separate groups
const typeOpts = (v, blank) => (blank ? `<option value="">${blank}</option>` : "") +
  `<optgroup label="Guest rooms">${Object.keys(TY).filter((k) => !SH.isSpace(k)).map((k) => `<option value="${k}" ${k === v ? "selected" : ""}>${TY[k]}</option>`).join("")}</optgroup>` +
  `<optgroup label="Other spaces">${Object.keys(SH.SPACES).map((k) => `<option value="${k}" ${k === v ? "selected" : ""}>${TY[k]}</option>`).join("")}</optgroup>`;
const STATUS = { free: "Free", occupied: "Occupied", dirty: "To clean", cleaning: "Cleaning" };
const EV = { mt_in: "Maintenance went in", mt_out: "Maintenance left", checkin: "Check-in", checkout: "Check-out", start: "Cleaning started", cleaned: "Cleaned", issue: "Issue reported", fixed: "Fixed", status: "Status changed" };
const ROLE = { owner: "Owner", desk: "Front desk", hk: "Housekeeping", mt: "Maintenance" };
const TABS = { owner: ["desk", "hk", "mt", "setup", "team"], desk: ["desk", "hk", "mt"], hk: ["hk"], mt: ["mt"] };
const TABNAME = { desk: "Front desk", hk: "Housekeeping", mt: "Maintenance", setup: "Setup", team: "Team" };
const ITEMS = ["Towels", "Soap & shampoo", "Light bulb", "Remote", "Toilet paper", "Air con"];
const TOAST = { cleaned: (n) => `Room ${n} is clean and ready`, checkout: (n) => `Room ${n}: guest left, needs cleaning`, issue: (n) => `Room ${n}: issue reported`, fixed: (n) => `Room ${n}: issue fixed`, start: (n) => `Room ${n}: cleaning in progress`, checkin: (n) => `Room ${n}: guest checked in` };
const FH = 150;
const PROG = { working: "Maintenance is in the room now", paused: "Started · not finished", parts: "Waiting for a part" };

// ───────────── state ─────────────
let me = null, hotels = [], H = null; // H = {id,name,role}
let FLOORS = [], ROOMS = {}, BYNUM = {}, state = {}, issues = [], members = {}, evCache = {};
let floor = 0, sel = null, view = "desk", mode = "building", unsub = null;
const floorName = (l) => { const f = FLOORS.find((x) => x.id === l); return f && f.name ? f.name : l === 0 ? "Ground floor" : "Floor " + l; };
const floorShort = (l) => (l === 0 ? "G" : String(l));
const mins = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000)) : null);
const dur = (m) => (m < 1 ? "under a minute" : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h${m % 60 ? " " + (m % 60) + " min" : ""}` : `${Math.floor(m / 1440)} d`);
const ago = (iso) => (iso ? (mins(iso) < 1 ? "just now" : dur(mins(iso)) + " ago") : "no record");
const durOf = (iso) => (iso ? dur(mins(iso)) : "–");
const short = (iso) => { if (!iso) return "–"; const m = mins(iso); return m < 60 ? m + "m" : m < 1440 ? Math.floor(m / 60) + "h" : Math.floor(m / 1440) + "d"; };
const rec = (id) => state[id] || { status: "free" };
const num = (id) => (ROOMS[id] ? ROOMS[id].n : "?");
const openIss = (id) => issues.filter((i) => i.room_id === id && i.open);
const since = (id) => rec(id).status_since;
const roomsOf = (l) => Object.keys(ROOMS).filter((id) => l == null || ROOMS[id].floor === l);
const can = (v) => H && TABS[H.role].includes(v);

function toast(msg) { const d = document.createElement("div"); d.className = "toast"; d.textContent = msg; $("toasts").appendChild(d); setTimeout(() => d.remove(), 3600); }
function show(screen) { ["auth", "onboard", "app"].forEach((s) => ($("scr-" + s).hidden = s !== screen)); }

// ───────────── building the model from database rows ─────────────
function ingest(d) {
  FLOORS = d.floors.map((f) => ({ id: f.level, fid: f.id, name: f.name, rooms: [] })).sort((a, b) => a.id - b.id);
  const byFid = Object.fromEntries(FLOORS.map((f) => [f.fid, f]));
  ROOMS = {}; BYNUM = {}; state = {};
  d.rooms.slice().sort((a, b) => a.position - b.position).forEach((r) => {
    const f = byFid[r.floor_id]; if (!f) return;
    ROOMS[r.id] = { id: r.id, n: r.number, ty: r.type, floor: f.id, i: f.rooms.length, beds: r.beds, pax: r.pax, view: r.view || "", feat: new Set(r.features || []), layout: r.layout || null };
    BYNUM[r.number] = r.id; f.rooms.push(r.id); state[r.id] = r;
  });
  issues = d.issues || [];
  members = Object.fromEntries((d.members || []).map((m) => [m.user_id, m]));
  if (!FLOORS.find((f) => f.id === floor)) floor = (FLOORS.find((f) => f.rooms.length) || FLOORS[0] || { id: 0 }).id;
}
const who = (uid) => { if (!uid) return ""; const m = members[uid]; return m ? m.display_name || ROLE[m.role] : ""; };

// ───────────── stats ─────────────
function stats(l) { const c = { total: 0, free: 0, occupied: 0, dirty: 0, cleaning: 0, issueRooms: 0, blocking: 0 };
  roomsOf(l).forEach((id) => { const r = rec(id), sp = isSpace(id);
    if (!sp) { c.total++; c[r.status]++; } else if (r.status === "dirty" || r.status === "cleaning") c[r.status]++;
    if (openIss(id).length) { c.issueRooms++; if (!sp && r.status !== "occupied") c.blocking++; } }); return c; }
const readyList = (l) => roomsOf(l).filter((id) => !isSpace(id) && rec(id).status === "free").sort((a, b) => (openIss(a).length > 0) - (openIss(b).length > 0) || new Date(rec(b).last_cleaned || 0) - new Date(rec(a).last_cleaned || 0));
const bestRoom = () => readyList(null).filter((id) => !openIss(id).length)[0] || null;
const queue = (l) => roomsOf(l).filter((id) => ["dirty", "cleaning"].includes(rec(id).status)).sort((a, b) => new Date(since(a) || 0) - new Date(since(b) || 0));
function issueList(l) { const out = []; issues.filter((i) => i.open && ROOMS[i.room_id] && (l == null || ROOMS[i.room_id].floor === l)).forEach((i) => out.push({ id: i.room_id, i }));
  return out.sort((a, b) => (rec(a.id).status === "occupied") - (rec(b.id).status === "occupied") || new Date(a.i.reported_at) - new Date(b.i.reported_at)); }

// ───────────── writes ─────────────
async function patchRoom(id, patch, toastKey) {
  const prev = { ...rec(id) };
  state[id] = { ...prev, ...patch }; if (patch.status && patch.status !== prev.status) state[id].status_since = new Date().toISOString();
  if (patch.status === "free" && ["dirty", "cleaning"].includes(prev.status)) state[id].last_cleaned = new Date().toISOString();
  delete evCache[id]; render(); if (toastKey) toast(TOAST[toastKey](num(id)));
  try { state[id] = await api.updateRoom(id, patch); render(); }
  catch (e) { state[id] = prev; render(); toast("Could not save: " + e.message); }
}
async function addIssue(id, text) {
  const tmp = { id: "tmp" + Date.now() + Math.random(), room_id: id, text, open: true, reported_at: new Date().toISOString() };
  issues.push(tmp); delete evCache[id]; render();
  try { const i = await api.addIssue(H.id, id, text); issues = issues.filter((x) => x.id !== tmp.id && x.id !== i.id).concat(i); render(); }
  catch (e) { issues = issues.filter((x) => x !== tmp); render(); toast("Could not save: " + e.message); }
}
async function fixIssue(iid) {
  const it = issues.find((i) => i.id === iid); if (!it) return; it.open = false; delete evCache[it.room_id]; render(); toast(TOAST.fixed(num(it.room_id)));
  try { const i = await api.fixIssue(iid); Object.assign(it, i); render(); } catch (e) { it.open = true; render(); toast("Could not save: " + e.message); }
}

// ───────────── 3D building ─────────────
function layout(f) {
  const ids = f.rooms, n = ids.length, rooms = [], areas = [];
  areas.push({ k: "LIFT", x: 435, y: 30, w: 130, h: 98 }, { k: "STAIRS", x: 435, y: 136, w: 130, h: 100 });
  if (!n) { areas.push({ k: "LOBBY", x: 30, y: 30, w: 395, h: 206 }, { k: "", x: 575, y: 30, w: 395, h: 206 }, { k: "", x: 30, y: 316, w: 395, h: 214 }, { k: "SERVICE", x: 435, y: 316, w: 130, h: 214 }, { k: "", x: 575, y: 316, w: 395, h: 214 }); return { rooms, areas }; }
  areas.push({ k: "SERVICE", x: 435, y: 316, w: 130, h: 214 });
  const top = Math.ceil(n / 2), rows = [ids.slice(0, top), ids.slice(top)];
  rows.forEach((row, ri) => {
    const lc = Math.ceil(row.length / 2), sides = [row.slice(0, lc), row.slice(lc)];
    sides.forEach((side, si) => { if (!side.length) return; const x0 = si ? 575 : 30, w = (395 - 8 * (side.length - 1)) / side.length;
      side.forEach((id, k) => rooms.push({ id, x: x0 + k * (w + 8), y: ri ? 316 : 30, w, h: ri ? 214 : 206, d: ri ? "t" : "b" })); });
  });
  return { rooms, areas };
}
const WR = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/></svg>`;
function buildWorld() {
  let h = "";
  FLOORS.forEach((f, i) => { const L = layout(f);
    h += `<div class="fl ${i === FLOORS.length - 1 ? "topfloor" : ""}" data-floor="${f.id}"><div class="top"><div class="corr"><span class="exit l">EXIT</span><span class="exit r">EXIT</span></div>` +
      L.areas.map((a) => `<div class="area" style="left:${a.x}px;top:${a.y}px;width:${a.w}px;height:${a.h}px">${a.k}</div>`).join("") +
      L.rooms.map((r) => `<div class="tile${r.w < 90 ? " narrow" : ""}" id="t-${r.id}" data-room="${r.id}" role="button" tabindex="-1" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;--fs:${Math.round(Math.min(42, r.w * 0.34, (r.w * 1.12) / Math.max(3, ROOMS[r.id].n.length)))}px"><span class="best">NEXT</span><span class="wr">${WR}</span><b class="num">${esc(ROOMS[r.id].n)}</b><span class="sub"></span><i class="door ${r.d}"></i></div>`).join("") +
      `</div><div class="front" role="button" tabindex="0" aria-label="${esc(floorName(f.id))}"><div class="la"><b>${esc(floorName(f.id))}</b><span></span></div><div class="lb"></div><div class="lc"></div></div></div>`; });
  $("world").innerHTML = h;
  document.querySelectorAll(".front").forEach((el) => { const id = +el.parentNode.dataset.floor; el.onclick = () => { if (mode === "building") openFloor(id); }; el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFloor(id); } }; });
  document.querySelectorAll(".tile").forEach((el) => { const go = () => { if (mode === "floor") selectRoom(el.dataset.room); }; el.onclick = go; el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } }; });
}
function updateWorld() {
  const best = bestRoom();
  FLOORS.forEach((f) => { const el = document.querySelector(`.fl[data-floor="${f.id}"]`); if (!el) return;
    const c = stats(f.id), full = c.total > 0 && c.free === 0, cl = c.dirty + c.cleaning, la = el.querySelector(".la");
    la.className = "la " + (!c.total ? "none" : full ? "full" : "has"); la.querySelector("span").textContent = !c.total ? "NO ROOMS" : full ? "FULL" : `${c.free} / ${c.total} FREE`;
    const lb = el.querySelector(".lb"), lc = el.querySelector(".lc");
    lb.classList.toggle("on", cl > 0); lb.textContent = `${cl} ${cl === 1 ? "room" : "rooms"} to clean`;
    lc.classList.toggle("on", c.issueRooms > 0); lc.textContent = `${c.issueRooms} ${c.issueRooms === 1 ? "room needs" : "rooms need"} repair`;
    f.rooms.forEach((id) => { const r = rec(id), st = r.status, tile = $("t-" + id); if (!tile) return;
      tile.className = `tile${tile.classList.contains("narrow") ? " narrow" : ""}${isSpace(id) ? " space" : ""}${staffOnly(ROOMS[id]) ? " staff" : ""} s-${st}${openIss(id).length ? " has-issue" : ""}${openIss(id).some((i) => i.progress === "working") ? " mt-in" : ""}${SH.isApt(ROOMS[id].ty) ? " apt" : ""}${sel === id ? " sel" : ""}${best === id ? " is-best" : ""}`;
      tile.querySelector(".sub").textContent = isSpace(id) ? (st === "dirty" ? "Needs cleaning" : st === "cleaning" ? "Cleaning" : TY[ROOMS[id].ty]) : st === "occupied" ? r.guest || "Occupied" : st === "free" ? "✓ " + short(r.last_cleaned) : st === "dirty" ? "Wait " + short(r.status_since) : "Cleaning";
      tile.setAttribute("aria-label", `Room ${ROOMS[id].n}, ${STATUS[st]}`); tile.tabIndex = mode === "floor" ? 0 : -1; }); });
}
function camera() {
  const st = $("stage"), sw = st.clientWidth, sh = st.clientHeight, wide = window.innerWidth >= 900, n = Math.max(FLOORS.length, 1);
  st.classList.toggle("mode-b", mode === "building"); st.classList.toggle("mode-f", mode === "floor");
  const fls = [...document.querySelectorAll(".fl")];
  $("holo").classList.toggle("out", mode !== "building");
  if (mode === "building") { // the hologram is in front; the plan waits tilted and hidden, ready to fly in
    const s = Math.min((sw - 24) / 1010, (sh - 80) / 570) * 0.55;
    $("world").style.transform = `translate(0px,60px) scale(${s}) rotateX(62deg) rotateZ(-18deg)`;
    fls.forEach((el) => { const id = +el.dataset.floor, cur = id === floor; el.classList.toggle("gone", !cur); el.style.transform = `translateZ(${cur ? 0 : id > floor ? 600 : -900}px)`; });
  } else { const aw = sw - (wide ? 430 : 24), s = Math.min(aw / 1010, (sh - 80) / 570);
    $("world").style.transform = `translate(${wide ? -(sw - aw) / 2 + 8 : 0}px,20px) scale(${s}) rotateX(0deg)`;
    fls.forEach((el) => { const id = +el.dataset.floor, cur = id === floor; el.classList.toggle("gone", !cur); el.style.transform = `translateZ(${cur ? 0 : id > floor ? 600 : -900}px)`; }); }
}
// ───────────── 3D hologram of the building (main page) ─────────────
function buildHolo() {
  const n = FLOORS.length, strips = `<span class="h-strips"><i class="h-sr"></i><i class="h-sc"></i></span>`;
  let h = `<div class="h-scene"><div class="h-rot"><div class="h-base"></div><div class="h-beam b1"></div><div class="h-beam b2"></div>`;
  FLOORS.forEach((f, i) => { h += `<div class="h-fl${f.id === 0 ? " lobby" : ""}" data-floor="${f.id}" style="--i:${i}">` +
    ["f", "r", "b", "l"].map((sd) => `<div class="h-face h-${sd}"><span class="h-win"></span>${sd === "f" && f.id === 0 ? `<span class="h-door"></span>` : ""}${sd === "f" || sd === "b" ? `<b class="h-num">${floorShort(f.id)}</b>` : ""}${strips}</div>`).join("") +
    `<i class="h-mark"></i></div>`; });
  h += `<div class="h-roof"><div class="h-cap"></div><div class="h-sign">${esc(H ? H.name : "")}</div><div class="h-sign back">${esc(H ? H.name : "")}</div></div></div></div><svg class="h-lines" aria-hidden="true"></svg><div class="h-labels"></div>`;
  $("holo").innerHTML = h;
  $("holo").style.setProperty("--n", n); $("holo").style.setProperty("--mid", (n - 1) / 2);
  $("holo").querySelectorAll(".h-fl").forEach((el) => { el.onclick = () => openFloor(+el.dataset.floor); });
  sizeHolo();
}
function sizeHolo() {
  const st = $("stage"), sw = st.clientWidth, sh = st.clientHeight, n = Math.max(FLOORS.length, 1), wide = window.innerWidth >= 900, hv = $("holo");
  const fh = Math.max(8, Math.min(70, (sh * 0.55) / (n + 1.2))), w = Math.min(Math.max(fh * 5, 170), sw * (wide ? 0.36 : 0.56));
  hv.style.setProperty("--FH", fh + "px"); hv.style.setProperty("--W", w + "px"); hv.style.setProperty("--D", w * 0.55 + "px");
  hv.style.setProperty("--cx", wide ? "42%" : "50%"); hv.style.setProperty("--cy", (sh * 0.6) + "px");
  requestAnimationFrame(holoLabels);
}
function updateHolo() {
  FLOORS.forEach((f) => { const el = document.querySelector(`.h-fl[data-floor="${f.id}"]`); if (!el) return; const c = stats(f.id);
    el.classList.toggle("has", c.total > 0 && c.free > 0); el.classList.toggle("full", c.total > 0 && c.free === 0); el.classList.toggle("none", !c.total);
    el.classList.toggle("cl", c.dirty + c.cleaning > 0); el.classList.toggle("rp", c.issueRooms > 0); });
  holoLabels();
}
function holoLabels() {
  const box = document.querySelector("#holo .h-labels"), svg = document.querySelector("#holo .h-lines"); if (!box) return;
  const fl = $("floorList"); fl.innerHTML = [...FLOORS].reverse().map((f) => { const c = stats(f.id); return `<button class="callout ${!c.total ? "none" : c.free ? "" : "full"}" style="position:static;transform:none;width:100%" data-floor="${f.id}"><b>${esc(floorName(f.id))}</b><div class="row"><span class="c-free">● ${c.free} free</span><span class="c-occ">● ${c.occupied} occ</span>${c.dirty + c.cleaning ? `<span class="c-clean">● ${c.dirty + c.cleaning} clean</span>` : ""}${c.issueRooms ? `<span class="c-issue">● ${c.issueRooms} fix</span>` : ""}</div></button>`; }).join("");
  fl.querySelectorAll("[data-floor]").forEach((b) => b.onclick = () => openFloor(+b.dataset.floor));
  const wide = window.innerWidth >= 900; if (!wide || mode !== "building") { box.innerHTML = ""; svg.innerHTML = ""; return; }
  if (FLOORS.length > 10) { // tall building: a scrollable floor column instead of callouts
    svg.innerHTML = ""; box.innerHTML = `<div class="h-col">${[...FLOORS].reverse().map((f) => { const c = stats(f.id), cls = !c.total ? "none" : c.free ? "" : "full";
      return `<button class="hc ${cls}" data-floor="${f.id}"><b>${esc(floorShort(f.id))}</b><span>${!c.total ? "no rooms" : c.free ? c.free + " free" : "full"}</span>${c.dirty + c.cleaning ? `<i class="c-clean">●</i>` : ""}${c.issueRooms ? `<i class="c-issue">●</i>` : ""}</button>`; }).join("")}</div>`;
    box.querySelectorAll("[data-floor]").forEach((b) => { const fl = () => document.querySelector(`.h-fl[data-floor="${b.dataset.floor}"]`);
      b.onclick = () => openFloor(+b.dataset.floor); b.onmouseenter = () => fl() && fl().classList.add("hl"); b.onmouseleave = () => fl() && fl().classList.remove("hl"); });
    return; }
  const sr = $("stage").getBoundingClientRect(), hv = getComputedStyle($("holo")), w = parseFloat(hv.getPropertyValue("--W")), d = parseFloat(hv.getPropertyValue("--D"));
  let html = "", lines = "";
  FLOORS.slice().reverse().forEach((f) => { const m = document.querySelector(`.h-fl[data-floor="${f.id}"] .h-mark`); if (!m) return; const r = m.getBoundingClientRect(), c = stats(f.id);
    const y = r.top - sr.top, x0 = r.left - sr.left + Math.hypot(w, d) / 2 + 14, lx = Math.min(sr.width - 260, x0 + 70);
    const cls = !c.total ? "none" : c.free ? "" : "full";
    html += `<button class="callout ${cls}" data-floor="${f.id}" style="left:${lx}px;top:${y}px;right:auto"><b>${esc(floorName(f.id))}</b><div class="row">${!c.total ? `<span>No rooms</span>` : `<span class="c-free">● ${c.free} free</span><span class="c-occ">● ${c.occupied} occ</span>${c.dirty + c.cleaning ? `<span class="c-clean">● ${c.dirty + c.cleaning} clean</span>` : ""}${c.issueRooms ? `<span class="c-issue">● ${c.issueRooms} fix</span>` : ""}`}</div></button>`;
    lines += `<path d="M${x0},${y} L${lx},${y}"/><circle cx="${x0}" cy="${y}" r="3"/>`; });
  box.innerHTML = html; svg.innerHTML = lines;
  box.querySelectorAll("[data-floor]").forEach((b) => { const fl = () => document.querySelector(`.h-fl[data-floor="${b.dataset.floor}"]`);
    b.onclick = () => openFloor(+b.dataset.floor); b.onmouseenter = () => fl() && fl().classList.add("hl"); b.onmouseleave = () => fl() && fl().classList.remove("hl"); });
}
function openFloor(id) { floor = id; mode = "floor"; sel = null; render(); }
function toBuilding() { mode = "building"; sel = null; render(); }
function selectRoom(id) { sel = id; render(); loadEvents(id); }
function goRoom(id) { floor = ROOMS[id].floor; mode = "floor"; view = "desk"; selectRoom(id); }
async function loadEvents(id) { if (evCache[id]) return; try { evCache[id] = await api.events(id); if (sel === id) render(); } catch (e) {} }

// ───────────── desk panels ─────────────
function nextHtml() { const best = bestRoom(), c = stats(null), q = queue(null), iss = issueList(null);
  if (!c.total) return "";
  const pill = best ? `<button class="nextbtn" data-go="${best}"><span><small>NEXT GUEST GETS</small><br><b>Room ${esc(num(best))}</b></span><span class="go">Give room ›</span></button>` : `<div class="nextbtn none"><span><small>NEXT GUEST GETS</small><br><b>No room ready</b></span></div>`;
  return pill + `<div class="mini"><span><b class="c-free">${c.free}</b> ready to sell</span><span><b class="c-clean">${q.length}</b> to clean</span><span><b class="c-issue">${iss.length}</b> issues</span><span><b>${Math.round((c.occupied / c.total) * 100)}%</b> occupied</span></div>`; }
const li = (id, sub, tag, cls) => `<li><button data-go="${id}"><span class="rn ${cls || ""}">${esc(num(id))}</span><small>${sub}</small>${tag ? `<span class="tag">${tag}</span>` : ""}</button></li>`;
function floorHtml(l) { const c = stats(l), rl = readyList(l), q = queue(l), iss = issueList(l);
  return `<h2>${esc(floorName(l))}</h2>
  <div class="fstats"><div><b class="c-free">${c.free}</b><small>free</small></div><div><b class="c-occ">${c.occupied}</b><small>occupied</small></div><div><b class="c-clean">${c.dirty + c.cleaning}</b><small>to clean</small></div><div><b class="c-issue">${c.issueRooms}</b><small>repairs</small></div></div>
  <div class="sec"><h4>Ready for guests · freshest first</h4>${rl.length ? `<ul class="list">${rl.map((id) => li(id, `${rec(id).last_cleaned ? "✓ cleaned " + ago(rec(id).last_cleaned) : "new · no cleaning yet"} · ${TY[ROOMS[id].ty]}`, openIss(id).length ? `<span class="c-issue">⚠ issue</span>` : "", "c-free")).join("")}</ul>` : `<p class="empty">No free rooms on this floor.</p>`}</div>
  <div class="sec"><h4>Cleaning queue · longest wait first</h4>${q.length ? `<ul class="list">${q.map((id) => li(id, rec(id).status === "cleaning" ? `Started ${ago(since(id))}` : `Waiting ${durOf(since(id))}`, rec(id).status === "cleaning" ? "In progress" : "", "c-clean")).join("")}</ul>` : `<p class="empty">Nothing waiting.</p>`}</div>
  <div class="sec"><h4>Repairs · empty rooms first</h4>${iss.length ? `<ul class="list">${iss.map(({ id, i }) => li(id, `${esc(i.text)} · ${ago(i.reported_at)}`, rec(id).status === "occupied" ? "Guest in room" : "", "c-issue")).join("")}</ul>` : `<p class="empty">All working.</p>`}</div>`; }
function spaceHtml(id) { const r = rec(id), st = r.status, R = ROOMS[id], s = r.status_since, so = staffOnly(R);
  const iss = issues.filter((i) => i.room_id === id).sort((a, b) => b.open - a.open || new Date(b.reported_at) - new Date(a.reported_at)).slice(0, 6), ev = evCache[id];
  const v = st === "dirty" ? ["wait", "NEEDS CLEANING", `Requested ${ago(s)}`] : st === "cleaning" ? ["soon", "BEING CLEANED", `Started ${ago(s)}`] : ["space", so ? "STAFF ONLY" : "GUEST AREA", `Last cleaned ${ago(r.last_cleaned)}`];
  const a = st === "dirty" ? `<button class="big b-cleaning" data-do="start">Start cleaning</button>` : st === "cleaning" ? `<button class="big b-free" data-do="cleaned">Cleaned</button>` : `<button class="big b-dirty" data-do="request">Request cleaning</button>`;
  return `<div class="rt"><h3 style="font-size:${R.n.length > 5 ? 30 : 44}px">${esc(R.n)}</h3><span class="meta">${TY[R.ty]} · ${esc(floorName(R.floor))}</span><button class="small x" id="closeRoom" aria-label="Back to floor">✕</button></div>
   <div class="verdict v-${v[0]}">${so ? "🔒 " : ""}${v[1]}<small>${v[2]}</small></div>${a}
   <div class="sec"><h4>Issues here</h4>${iss.map((i) => `<div class="issue ${i.open ? "" : "done"}"><span>${esc(i.text)} <small style="color:var(--muted)">${ago(i.reported_at)}</small>${i.open && PROG[i.progress] ? `<br><small class="prog p-${i.progress}">${PROG[i.progress]}${i.note && i.progress !== "working" ? " · " + esc(i.note) : ""}</small>` : ""}</span>${i.open ? `<button class="small" data-fix="${i.id}">Fixed</button>` : ""}</div>`).join("")}
    <div class="field"><input id="issueTxt" placeholder="Report an issue" autocomplete="off" maxlength="300"><button class="small" data-do="issue">Add</button></div></div>
   <div class="sec"><details><summary>History${ev ? ` (${ev.length})` : ""}</summary>${ev ? `<ul class="hist">${ev.map((h) => `<li><time>${ago(h.at)}</time><span>${EV[h.event] || esc(h.event)}${h.note ? `: ${esc(h.note)}` : ""}</span></li>`).join("")}</ul>` : `<p class="empty">Loading…</p>`}</details></div>`; }
function roomHtml(id) { if (isSpace(id)) return spaceHtml(id); const r = rec(id), st = r.status, R = ROOMS[id], oi = openIss(id), s = r.status_since;
  let v;
  if (st === "free" && !oi.length) v = ["yes", "READY TO SELL", `Cleaned ${ago(r.last_cleaned)}`];
  else if (st === "free") v = ["warn", "FREE, BUT HAS AN ISSUE", oi.map((i) => esc(i.text)).join(", ")];
  else if (st === "occupied") v = ["no", "NOT AVAILABLE · OCCUPIED", `${r.guest ? esc(r.guest) + " · " : ""}in room for ${durOf(s)}`];
  else if (st === "dirty") v = ["wait", "NOT AVAILABLE · NEEDS CLEANING", `Waiting ${durOf(s)}`];
  else v = ["soon", "SOON · BEING CLEANED", `Started ${ago(s)}`];
  let a = "";
  if (st === "free") a = `<div class="field"><input id="guest" placeholder="Guest name (optional)" autocomplete="off" maxlength="80"></div><button class="big b-occupied" data-do="checkin">Check in</button>`;
  if (st === "occupied") a = `<button class="big b-dirty" data-do="checkout">Check out</button>`;
  if (st === "dirty") a = `<button class="big b-cleaning" data-do="start">Start cleaning</button>`;
  if (st === "cleaning") a = `<p class="meta">Anything missing?</p><div class="chips" id="miss">${ITEMS.map((x) => `<button aria-pressed="false" data-item="${esc(x)}">${esc(x)}</button>`).join("")}</div><button class="big b-free" data-do="cleaned">Cleaned</button>`;
  const iss = issues.filter((i) => i.room_id === id).sort((a, b) => b.open - a.open || new Date(b.reported_at) - new Date(a.reported_at)).slice(0, 6);
  const ev = evCache[id];
  return `<div class="rt"><h3>${esc(R.n)}</h3><span class="meta">${TY[R.ty]} · ${esc(floorName(R.floor))}</span><button class="small x" id="closeRoom" aria-label="Back to floor">✕</button></div>
   <div class="rfacts"><i>${BEDDESC[R.ty]}</i><i>sleeps ${R.pax}</i>${R.view ? `<i>${esc(R.view)} view</i>` : ""}${[...R.feat].map((f) => `<i>${esc(f)}</i>`).join("")}</div>
   <div class="verdict v-${v[0]}">${v[1]}<small>${v[2]}</small></div>${a}
   ${SH.layoutOf(R) ? `<div class="sec"><h4>Layout · tap to enlarge</h4><button class="schem-btn" data-plan="${id}" aria-label="Open floor plan">${SH.schematic(R)}</button></div>` : ""}
   <div class="sec"><h4>Issues in this room</h4>${iss.map((i) => `<div class="issue ${i.open ? "" : "done"}"><span>${esc(i.text)} <small style="color:var(--muted)">${ago(i.reported_at)}</small>${i.open && PROG[i.progress] ? `<br><small class="prog p-${i.progress}">${PROG[i.progress]}${i.note && i.progress !== "working" ? " · " + esc(i.note) : ""}</small>` : ""}</span>${i.open ? `<button class="small" data-fix="${i.id}">Fixed</button>` : ""}</div>`).join("")}
    <div class="field"><input id="issueTxt" placeholder="Report an issue or missing item" autocomplete="off" maxlength="300"><button class="small" data-do="issue">Add</button></div></div>
   <div class="sec"><h4>Details</h4><dl class="facts"><dt>Last cleaned</dt><dd>${ago(r.last_cleaned)}</dd><dt>In this status</dt><dd>${STATUS[st]} · ${durOf(s)}</dd>${st === "occupied" && r.guest ? `<dt>Guest</dt><dd>${esc(r.guest)}</dd>` : ""}<dt>Type</dt><dd>${TY[R.ty]} · ${BEDDESC[R.ty]}</dd></dl></div>
   <div class="sec"><details><summary>History${ev ? ` (${ev.length})` : ""}</summary>${ev ? `<ul class="hist">${ev.map((h) => `<li><time>${ago(h.at)}</time><span>${EV[h.event] || esc(h.event)}${h.note ? `: ${esc(h.note)}` : ""} <small style="color:var(--muted)">${who(h.actor) ? "· " + esc(who(h.actor)) : ""}</small></span></li>`).join("")}</ul>` : `<p class="empty">Loading…</p>`}</details></div>`; }

// ───────────── housekeeping & maintenance ─────────────
function hkHtml() { const list = queue(null).sort((a, b) => (rec(b).status === "cleaning") - (rec(a).status === "cleaning"));
  return list.length ? list.map((id) => { const st = rec(id).status; return `<div class="task"><div class="n s-${st}">${esc(num(id))}</div><div><b>${STATUS[st]}</b><br><span class="meta">${st === "dirty" ? "Waiting " + durOf(since(id)) : "Started " + ago(since(id))} · ${esc(floorName(ROOMS[id].floor))}</span></div>
   ${st === "cleaning" ? `<div class="chips" style="grid-column:1/-1;margin:0" data-miss="${id}">${ITEMS.map((x) => `<button aria-pressed="false" data-item="${esc(x)}">${esc(x)}</button>`).join("")}</div>` : ""}
   <div class="acts">${st === "dirty" ? `<button class="big b-cleaning" data-room="${id}" data-do="start">Start cleaning</button>` : `<button class="big b-free" data-room="${id}" data-do="cleaned">Cleaned</button>`}</div></div>`; }).join("") : `<p class="empty">Every room is clean. Nice work!</p>`; }
function mtHtml() { const l = issueList(null);
  return l.length ? l.map(({ id, i }) => { const occ = rec(id).status === "occupied"; return `<div class="task"><div class="n s-issue">${esc(num(id))}</div><div><span class="prio" style="${occ ? "color:var(--muted)" : ""}">${occ ? "Guest in room" : "Room empty · fix now"}</span><br><b>${esc(i.text)}</b>${PROG[i.progress] ? `<br><small class="prog p-${i.progress}">${PROG[i.progress]}${i.note && i.progress !== "working" ? " · " + esc(i.note) : ""}</small>` : ""}<br><span class="meta">${ago(i.reported_at)} · ${esc(floorName(ROOMS[id].floor))}</span></div><div class="acts"><button class="big b-free" data-room="${id}" data-fix="${i.id}">Fixed</button></div></div>`; }).join("") : `<p class="empty">No open issues.</p>`; }

// ───────────── Setup (owner) ─────────────
let draft = null;
function draftFromModel() { return FLOORS.map((f) => ({ level: f.id, name: f.name || (f.id === 0 ? "Ground floor" : "Floor " + f.id), rooms: f.rooms.map((id) => { const R = ROOMS[id]; return { number: R.n, type: R.ty, beds: R.beds, pax: R.pax, view: R.view, features: [...R.feat], layout: R.layout }; }) })); }
function setupHtml() {
  if (!draft) draft = draftFromModel();
  const opt = (arr, v, lab) => arr.map((x) => `<option value="${esc(x)}" ${x === v ? "selected" : ""}>${esc(lab ? lab(x) : x)}</option>`).join("");
  const sel = setupSel;
  return `<div class="blk"><h2>Import your rooms</h2><p class="meta" style="margin-bottom:12px">Fastest way: paste the room list from Excel, Google Sheets or your booking system (or upload a .csv). Columns are recognised automatically: room, floor, type, beds, sleeps, view, features. Only room numbers are required; the floor is read from the number (204 → floor 2).</p>
   <textarea id="impText" class="imp" rows="5" spellcheck="false" placeholder="Room	Type	View	Features&#10;101	Double	Sea	balcony&#10;102	Twin	City&#10;103	2 bedroom apartment	Sea	balcony, kitchen"></textarea>
   <div class="row" style="margin-top:10px;align-items:center"><label class="small filebtn">Upload .csv<input type="file" id="impFile" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden></label>
    <a class="small" download="rooms-template.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent("Room,Floor,Type,Beds,Sleeps,View,Features\n101,1,Double,1,2,sea,balcony\n102,1,Twin,2,2,city,\n103,1,2 bedroom apartment,3,5,sea,balcony kitchen\n")}">Download template</a>
    <div></div><button class="big b-hud" id="impGo" style="flex:0 0 auto;margin:0;padding:11px 18px;font-size:15px">Read rooms</button></div>
   <div id="impOut"></div></div>
   <div class="blk"><h2>Quick build</h2><p class="meta" style="margin-bottom:12px">Generate floors and room numbers, then fine-tune each room below. Room numbers follow floor × 100 (101, 102…), ground floor 01, 02…</p>
   <div class="row"><div><label for="qbLow">Lowest floor</label><select id="qbLow"><option value="0">Ground (0)</option><option value="1" selected>1</option></select></div>
   <div><label for="qbHigh">Highest floor</label><input id="qbHigh" type="number" min="0" max="60" value="3"></div>
   <div><label for="qbPer">Rooms per floor</label><input id="qbPer" type="number" min="0" max="60" value="12"></div>
   <div><label for="qbG">Rooms on ground floor</label><input id="qbG" type="number" min="0" max="60" value="0"></div>
   <div><label for="qbType">Default type</label><select id="qbType">${typeOpts("dbl")}</select></div>
   <div style="flex:0 0 auto"><button class="big b-hud" id="qbGo" style="margin:0;padding:11px 18px;font-size:15px">Generate</button></div></div></div>` +
   `<div class="blk"><h2>Rules for many rooms</h2><p class="meta" style="margin-bottom:12px">One line changes every matching room on every floor. Example: numbers ending in <b>01, 25</b> → Suite, sea view. Or <b>odd numbers</b> → sea view, <b>even</b> → city view.</p>
    <div class="row"><div><label for="ruMode">Rooms</label><select id="ruMode"><option value="end">with numbers ending in</option><option value="odd">with odd numbers</option><option value="even">with even numbers</option><option value="range">numbered from–to</option><option value="floors">on floors</option></select></div>
     <div><label for="ruVal">Value</label><input id="ruVal" placeholder="01, 25   ·   101-120   ·   2-5"></div>
     <div><label for="ruType">Set type</label><select id="ruType">${typeOpts("", "keep")}</select></div>
     <div><label for="ruView">Set view</label><select id="ruView"><option value="__">keep</option>${opt(VIEWS, "__", (x) => x || "no view")}</select></div>
     <div><label for="ruFeat">Feature</label><select id="ruFeat"><option value="">keep</option>${FEATURES.map((f) => `<option value="+${f}">+ ${f}</option><option value="-${f}">− ${f}</option>`).join("")}</select></div>
     <div style="flex:0 0 auto"><button class="big b-hud" id="ruGo" style="margin:0;padding:11px 18px;font-size:15px">Apply</button></div></div></div>` +
   draft.map((f, fi) => `<div class="blk"><div class="row" style="align-items:center;margin-bottom:10px"><div style="flex:0 0 90px"><label>Level</label><input value="${f.level}" type="number" data-fl="${fi}" data-k="level"></div><div><label>Floor name</label><input value="${esc(f.name)}" data-fl="${fi}" data-k="name"></div><div style="flex:0 0 auto;align-self:end;display:flex;gap:6px;flex-wrap:wrap"><button class="small" data-addroom="${fi}">+ Room</button><select class="small addsp" data-addspace="${fi}" aria-label="Add a space"><option value="">+ Space…</option>${Object.keys(SH.SPACES).map((k) => `<option value="${k}">${TY[k]}</option>`).join("")}</select>${draft.some((g) => g.level > f.level) ? `<button class="small" data-copyup="${fi}" title="Same room types, views and features on every floor above, renumbered">Copy to floors above</button>` : ""}<button class="small" data-delfloor="${fi}">Remove floor</button></div></div>
    <div class="tablewrap"><table class="rtab"><thead><tr><th><input type="checkbox" data-selfloor="${fi}" aria-label="Select all rooms on this floor" ${f.rooms.length && f.rooms.every((_, ri) => sel.has(fi + ":" + ri)) ? "checked" : ""}></th><th>Room</th><th>Type</th><th>Beds</th><th>Sleeps</th><th>View</th><th>Features</th><th></th></tr></thead><tbody>${f.rooms.map((r, ri) => `<tr class="${sel.has(fi + ":" + ri) ? "picked" : ""}">
     <td><input type="checkbox" data-sel="${fi}:${ri}" aria-label="Select room ${esc(r.number)}" ${sel.has(fi + ":" + ri) ? "checked" : ""}></td>
     <td class="num"><input value="${esc(r.number)}" data-fl="${fi}" data-ri="${ri}" data-k="number" aria-label="Room number"></td>
     <td><select data-fl="${fi}" data-ri="${ri}" data-k="type" aria-label="Type">${typeOpts(r.type)}</select></td>
     <td class="n2"><input type="number" min="0" max="12" value="${r.beds}" data-fl="${fi}" data-ri="${ri}" data-k="beds" aria-label="Beds"></td>
     <td class="n2"><input type="number" min="1" max="16" value="${r.pax}" data-fl="${fi}" data-ri="${ri}" data-k="pax" aria-label="Sleeps"></td>
     <td><select data-fl="${fi}" data-ri="${ri}" data-k="view" aria-label="View">${opt(VIEWS, r.view, (x) => x || "–")}</select></td>
     <td><div class="feats">${FEATURES.map((ft) => `<label><input type="checkbox" data-fl="${fi}" data-ri="${ri}" data-feat="${ft}" ${r.features.includes(ft) ? "checked" : ""}>${ft}</label>`).join("")}</div></td>
     <td><button class="small" data-delroom="${fi}:${ri}" aria-label="Remove room">✕</button></td></tr>`).join("")}</tbody></table></div></div>`).join("") +
   `<div class="row" style="margin-bottom:30px"><button class="small" id="addFloor">+ Floor</button><div></div><button class="big b-free" id="saveSetup" style="flex:0 0 auto;margin:0;padding:14px 26px">Save setup</button></div><div class="err" id="setupErr"></div>` +
   (sel.size ? `<div class="bulk hud"><b>${sel.size} selected</b>
     <select id="bkType" aria-label="Set type">${typeOpts("", "Type…")}</select>
     <select id="bkView" aria-label="Set view"><option value="__">View…</option>${opt(VIEWS, "__", (x) => x || "no view")}</select>
     <select id="bkFeat" aria-label="Feature"><option value="">Feature…</option>${FEATURES.map((f) => `<option value="+${f}">+ ${f}</option><option value="-${f}">− ${f}</option>`).join("")}</select>
     <button class="small b-hud" id="bkApply">Apply</button><button class="small" id="bkClear">Clear</button></div>` : "");
}
let setupSel = new Set();
function applyType(r, t) { r.type = t; r.beds = BEDS[t]; r.pax = PAX[t]; r.layout = null;
  if (SH.isApt(t) && !r.features.includes("kitchen")) r.features = [...r.features, "kitchen"];
  if (SH.STAFF_ONLY.has(t) && !r.features.includes("staff only")) r.features = [...r.features, "staff only"];
  if (SH.isSpace(t)) r.view = r.view || ""; }
// rule tool: one line changes hundreds of rooms
function ruleMatch(r, mode, val) { const n = parseInt(r.number.replace(/\D/g, ""), 10), end = r.number.slice(-2);
  if (mode === "end") return val.split(/[,\s]+/).filter(Boolean).some((x) => r.number.endsWith(x.padStart(Math.min(2, r.number.length), "0")) || r.number.endsWith(x));
  if (mode === "odd") return n % 2 === 1; if (mode === "even") return n % 2 === 0;
  if (mode === "range") { const m = val.match(/(\d+)\s*[-–]\s*(\d+)/); return m ? n >= +m[1] && n <= +m[2] : false; }
  if (mode === "floors") { const m = val.match(/(-?\d+)\s*[-–]\s*(-?\d+)/), lv = r._level; return m ? lv >= +m[1] && lv <= +m[2] : val.split(/[,\s]+/).map(Number).includes(lv); }
  return false; }
// ── spreadsheet import: understands headers in English/Serbian and hotel shorthand ──
function typeFromText(t) { t = (t || "").toLowerCase();
  const sp = [["conf", /conferen|konferen|congress|ballroom/], ["meet", /meeting|sastan|boardroom/], ["rest", /restaurant|restoran|dining/], ["bar", /^\s*(lobby )?bar\b|kafić|kafic/], ["kit", /^\s*(main |hotel )?(kitchen|kuhinja)\s*$/],
    ["spa", /\bspa\b|wellness|sauna/], ["gym", /\bgym\b|fitness|teretan/], ["pool", /\bpool\b|bazen/], ["laun", /laundr|vešeraj|veseraj|perionic/], ["stor", /storage|magacin|ostava|linen/],
    ["staff", /staff room|osoblje|garderob/], ["office", /office|kancelar/], ["tech", /technical|boiler|kotlarn|server|tehni/], ["lobby", /^\s*lobby\s*$|^\s*lobi\s*$/], ["wc", /^\s*(public )?(wc|toilet|restroom)\s*$/], ["park", /parking|garaž|garaz/]];
  for (const [k, re] of sp) if (re.test(t)) return k;
  const br = t.match(/(\d)\s*-?\s*(br|bed\s*room|bedroom|bdr|spava)/); if (br) return ["", "ap1", "ap2", "ap3"][Math.min(3, +br[1])] || "ap1";
  if (/studio/.test(t)) return "stu"; if (/one[- ]bed|1br/.test(t)) return "ap1"; if (/two[- ]bed|2br/.test(t)) return "ap2"; if (/three[- ]bed|3br/.test(t)) return "ap3";
  if (/apart|apt|flat|stan/.test(t)) return "ap1"; if (/suite|ste|apartman/.test(t)) return "ste"; if (/famil|fam|porodi/.test(t)) return "fam";
  if (/tripl|tpl|trokrev/.test(t)) return "tpl"; if (/twin|twn|dva odvojena/.test(t)) return "twn"; if (/single|sgl|jednokrev/.test(t)) return "sgl";
  if (/double|dbl|king|queen|dvokrev|bračn|bracn/.test(t)) return "dbl"; return null; }
const FEAT_WORDS = { balcony: /balcon|balkon|terrace|teras/, bathtub: /tub|kada|bath\b|bathtub/, kitchen: /kitchen|kuhinj|kitchenette|čajna|cajna/, accessible: /accessib|wheelchair|invalid|\bada\b|\bprm\b/, connecting: /connect|adjoin|spojen/, quiet: /quiet|mirn|tih/, "near lift": /near lift|lift|elevator/ };
const VIEW_WORDS = { sea: /sea|ocean|more|mora/, city: /city|grad|street|ulic/, garden: /garden|bašt|bast|vrt/, courtyard: /court|dvorišt|dvorist/, mountain: /mountain|planin/, pool: /pool|bazen/ };
function parseCells(line, d) { const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === d && !q) { out.push(cur.trim()); cur = ""; } else cur += ch; }
  out.push(cur.trim()); return out; }
function importRooms(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim()); if (!lines.length) return null;
  const d = lines[0].includes("\t") ? "\t" : (lines[0].split(";").length > lines[0].split(",").length ? ";" : ",");
  let rows = lines.map((l) => parseCells(l, d)), col = {};
  const H = { room: /^(room|rooms|no\.?|nr\.?|number|broj|soba|unit|room no\.?|room number|broj sobe|#)$/, floor: /floor|level|sprat|etaž|etaz/, type: /type|categ|tip|kateg|room type/, beds: /^(beds?|kreveti?|broj kreveta)$/, pax: /sleep|pax|guest|max|occup|osob|kapacit/, view: /view|pogled/, feat: /feature|amenit|extra|note|opis|oprem/ };
  const head = rows[0].map((c) => c.toLowerCase());
  if (head.some((c) => Object.values(H).some((re) => re.test(c)) && !/^\d+$/.test(c))) { head.forEach((c, i) => { for (const k in H) if (col[k] === undefined && H[k].test(c)) { col[k] = i; break; } }); rows = rows.slice(1); }
  if (col.room === undefined) col.room = 0;
  const skipped = [], byLevel = {};
  rows.forEach((r, ri) => {
    const number = (r[col.room] || "").replace(/^(room|soba)\s*/i, "").trim(); if (!number) { skipped.push(ri + 1); return; }
    const all = r.join(" ").toLowerCase(), digits = number.replace(/\D/g, "");
    let level = col.floor !== undefined && /-?\d+/.test(r[col.floor] || "") ? parseInt(r[col.floor].match(/-?\d+/)[0], 10) : /^(g|p|gf|ground|prizemlje)$/i.test(r[col.floor] || "") ? 0 : digits.length >= 3 ? parseInt(digits.slice(0, -2), 10) : 0;
    const type = typeFromText(col.type !== undefined ? r[col.type] : "") || typeFromText(all) || "dbl";
    const beds = col.beds !== undefined && /\d/.test(r[col.beds] || "") ? parseInt(r[col.beds], 10) : BEDS[type];
    const pax = col.pax !== undefined && /\d/.test(r[col.pax] || "") ? parseInt(r[col.pax], 10) : PAX[type];
    const vtxt = (col.view !== undefined ? r[col.view] : all).toLowerCase(), view = Object.keys(VIEW_WORDS).find((v) => VIEW_WORDS[v].test(vtxt)) || "";
    const ftxt = (col.feat !== undefined ? r[col.feat] + " " + (col.type !== undefined ? r[col.type] : "") : all).toLowerCase();
    const features = SH.isSpace(type) ? [] : Object.keys(FEAT_WORDS).filter((f) => FEAT_WORDS[f].test(ftxt)); if (SH.isApt(type) && !features.includes("kitchen")) features.push("kitchen");
    if (SH.STAFF_ONLY.has(type) || /staff only|samo osoblje|zabranjen/.test(all)) features.push("staff only");
    (byLevel[level] = byLevel[level] || []).push({ number, type, beds: Math.max(0, Math.min(12, beds || 0)), pax: Math.max(1, Math.min(16, pax || 1)), view, features, layout: null });
  });
  const floorsOut = Object.keys(byLevel).map(Number).sort((a, b) => a - b).map((l) => ({ level: l, name: l === 0 ? "Ground floor" : "Floor " + l,
    rooms: byLevel[l].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })) }));
  return { floors: floorsOut, count: floorsOut.reduce((n, f) => n + f.rooms.length, 0), skipped, cols: Object.keys(col) };
}
function bindSetup(root) {
  const D = () => draft;
  root.querySelectorAll("[data-k]").forEach((el) => el.onchange = () => { const f = D()[+el.dataset.fl], k = el.dataset.k;
    if (el.dataset.ri === undefined) { f[k] = k === "level" ? parseInt(el.value || "0", 10) : el.value; return; }
    const r = f.rooms[+el.dataset.ri]; r[k] = k === "beds" || k === "pax" ? parseInt(el.value || "0", 10) : el.value.trim();
    if (k === "type") { applyType(r, r.type); renderSetup(); } });
  root.querySelectorAll("[data-feat]").forEach((el) => el.onchange = () => { const r = D()[+el.dataset.fl].rooms[+el.dataset.ri], ft = el.dataset.feat; r.features = el.checked ? [...new Set([...r.features, ft])] : r.features.filter((x) => x !== ft); });
  root.querySelectorAll("[data-addroom]").forEach((b) => b.onclick = () => { const f = D()[+b.dataset.addroom], last = f.rooms[f.rooms.length - 1]; const next = last && /^\d+$/.test(last.number) ? String(+last.number + 1).padStart(last.number.length, "0") : (f.level === 0 ? "0" : f.level) + String(f.rooms.length + 1).padStart(2, "0"); f.rooms.push({ number: next, type: "dbl", beds: 1, pax: 2, view: "", features: [] }); renderSetup(); });
  root.querySelectorAll("[data-delroom]").forEach((b) => b.onclick = () => { const [fi, ri] = b.dataset.delroom.split(":").map(Number); D()[fi].rooms.splice(ri, 1); setupSel = new Set(); renderSetup(); });
  root.querySelectorAll("[data-delfloor]").forEach((b) => b.onclick = () => { D().splice(+b.dataset.delfloor, 1); setupSel = new Set(); renderSetup(); });
  // import
  let parsed = null;
  const showImport = () => { const t = $("impText").value; parsed = importRooms(t); const o = $("impOut");
    if (!parsed || !parsed.count) { o.innerHTML = `<p class="err">No rooms found. The first column should be the room number.</p>`; return; }
    const types = {}; parsed.floors.forEach((f) => f.rooms.forEach((r) => (types[r.type] = (types[r.type] || 0) + 1)));
    o.innerHTML = `<div class="imp-sum"><b>Found ${parsed.count} rooms on ${parsed.floors.length} floor${parsed.floors.length > 1 ? "s" : ""}</b>
      <span>${Object.entries(types).map(([k, n]) => `${n} × ${TY[k]}`).join(" · ")}</span>
      <span class="meta">Columns used: ${parsed.cols.join(", ")}${parsed.skipped.length ? ` · skipped rows without a room number: ${parsed.skipped.slice(0, 8).join(", ")}` : ""}</span>
      <button class="big b-free" id="impUse" style="margin-top:10px">Use these ${parsed.count} rooms</button><span class="meta">Replaces the list below. Nothing is saved until you press Save setup.</span></div>`;
    $("impUse").onclick = () => { draft = parsed.floors; setupSel = new Set(); renderSetup(); toast(`${parsed.count} rooms imported · check them, then Save setup`); }; };
  const ig = $("impGo"); if (ig) ig.onclick = showImport;
  const ifl = $("impFile"); if (ifl) ifl.onchange = () => { const f = ifl.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { $("impText").value = rd.result; showImport(); }; rd.readAsText(f); };
  // copy a floor's pattern upwards
  root.querySelectorAll("[data-copyup]").forEach((b) => b.onclick = () => { const src = D()[+b.dataset.copyup];
    D().forEach((f) => { if (f.level <= src.level) return;
      f.rooms = src.rooms.map((r, i) => { const n = /^\d{3,}$/.test(r.number) ? String(f.level * 100 + (parseInt(r.number, 10) % 100)) : f.level + String(i + 1).padStart(2, "0");
        return { ...r, number: n, features: [...r.features], layout: r.layout }; }); });
    renderSetup(); toast("Copied to the floors above"); });
  // selection + bulk edit
  root.querySelectorAll("[data-sel]").forEach((c) => c.onchange = () => { c.checked ? setupSel.add(c.dataset.sel) : setupSel.delete(c.dataset.sel); renderSetup(); });
  root.querySelectorAll("[data-selfloor]").forEach((c) => c.onchange = () => { const fi = +c.dataset.selfloor; D()[fi].rooms.forEach((_, ri) => c.checked ? setupSel.add(fi + ":" + ri) : setupSel.delete(fi + ":" + ri)); renderSetup(); });
  const bk = $("bkApply"); if (bk) bk.onclick = () => { const t = $("bkType").value, v = $("bkView").value, ft = $("bkFeat").value;
    setupSel.forEach((k) => { const [fi, ri] = k.split(":").map(Number), r = D()[fi] && D()[fi].rooms[ri]; if (!r) return;
      if (t) applyType(r, t);
      if (v !== "__") r.view = v;
      if (ft) { const name = ft.slice(1); r.features = ft[0] === "+" ? [...new Set([...r.features, name])] : r.features.filter((x) => x !== name); } });
    renderSetup(); toast(`Updated ${setupSel.size} rooms`); };
  root.querySelectorAll("[data-addspace]").forEach((sl) => sl.onchange = () => { const t = sl.value; if (!t) return; const f = D()[+sl.dataset.addspace];
    const used = new Set(D().flatMap((g) => g.rooms.map((r) => r.number))), base = { conf: "CONF", meet: "MEET", rest: "REST", bar: "BAR", kit: "KITCHEN", spa: "SPA", gym: "GYM", pool: "POOL", laun: "LAUNDRY", stor: "STORE", staff: "STAFF", office: "OFFICE", tech: "TECH", lobby: "LOBBY", wc: "WC", park: "PARKING" }[t];
    let code = f.level === 0 ? base : base + "-" + f.level, k = 2; while (used.has(code)) code = base + "-" + (f.level ? f.level + "." : "") + k++;
    const r = { number: code, features: [], view: "" }; applyType(r, t); f.rooms.push(r); renderSetup(); });
  const rg = $("ruGo"); if (rg) rg.onclick = () => { const mode = $("ruMode").value, val = $("ruVal").value.trim(), t = $("ruType").value, v = $("ruView").value, ft = $("ruFeat").value; let n = 0;
    if ((mode === "end" || mode === "range" || mode === "floors") && !val) { toast("Type a value first, e.g. 01, 25"); return; }
    D().forEach((f) => f.rooms.forEach((r) => { if (SH.isSpace(r.type)) return; r._level = f.level; if (!ruleMatch(r, mode, val)) return; n++;
      if (t) applyType(r, t); if (v !== "__") r.view = v; if (ft) { const nm = ft.slice(1); r.features = ft[0] === "+" ? [...new Set([...r.features, nm])] : r.features.filter((x) => x !== nm); } delete r._level; }));
    D().forEach((f) => f.rooms.forEach((r) => delete r._level)); renderSetup(); toast(n ? `Rule applied to ${n} rooms` : "No rooms matched"); };
  const bc = $("bkClear"); if (bc) bc.onclick = () => { setupSel = new Set(); renderSetup(); };
  const af = $("addFloor"); if (af) af.onclick = () => { const l = D().length ? Math.max(...D().map((f) => f.level)) + 1 : 0; D().push({ level: l, name: l === 0 ? "Ground floor" : "Floor " + l, rooms: [] }); renderSetup(); };
  const go = $("qbGo"); if (go) go.onclick = () => { const lo = +$("qbLow").value, hi = Math.max(lo, +$("qbHigh").value || lo), per = Math.max(0, +$("qbPer").value || 0), g = Math.max(0, +$("qbG").value || 0), ty = $("qbType").value; draft = [];
    for (let l = lo; l <= hi; l++) { const cnt = l === 0 ? g : per; draft.push({ level: l, name: l === 0 ? "Ground floor" : "Floor " + l, rooms: Array.from({ length: cnt }, (_, i) => ({ number: l === 0 ? String(i + 1).padStart(2, "0") : String(l * 100 + i + 1), type: ty, beds: BEDS[ty], pax: PAX[ty], view: "", features: [] })) }); }
    renderSetup(); };
  const sv = $("saveSetup"); if (sv) sv.onclick = async () => {
    const nums = D().flatMap((f) => f.rooms.map((r) => r.number)), lv = D().map((f) => f.level);
    const err = !nums.every((n) => n) ? "Every room needs a number." : new Set(nums).size !== nums.length ? "Two rooms have the same number." : new Set(lv).size !== lv.length ? "Two floors have the same level." : "";
    if (err) { $("setupErr").textContent = err; return; }
    sv.disabled = true; sv.textContent = "Saving…";
    try { await api.saveSetup(H.id, D().slice().sort((a, b) => a.level - b.level)); draft = null; await openHotel(H, true); view = "desk"; mode = "building"; render(); toast("Setup saved"); }
    catch (e) { $("setupErr").textContent = e.message; sv.disabled = false; sv.textContent = "Save setup"; } };
}
function renderSetup() { const v = $("view-setup"), y = window.scrollY, t = $("impText") ? $("impText").value : ""; v.innerHTML = setupHtml(); if (t && $("impText")) $("impText").value = t; bindSetup(v); window.scrollTo(0, y); }

// ───────────── Team (owner) ─────────────
async function renderTeam() {
  const v = $("view-team"); v.innerHTML = `<div class="setup"><div class="blk"><h2>Invite your team</h2><p class="meta">Create a code for the role and give it to the person. They sign up, choose “Join a hotel” and type the code. Codes work for 30 days and can be used by several people.</p>
   <div class="row" style="margin-top:12px">${["desk", "hk", "mt"].map((r) => `<button class="small" data-inv="${r}">+ ${ROLE[r]} code</button>`).join("")}</div><div id="invList" style="margin-top:14px"><p class="empty">Loading…</p></div></div>
   <div class="blk"><h2>Staff apps</h2><p class="meta">Open these on the phone or tablet the staff use, then “Add to Home screen”. They sign in with their own account.</p>
    <div class="row" style="margin-top:12px"><a class="small" href="hk.html${api.demo ? "?demo" : ""}" target="_blank" rel="noopener">Housekeeping app ›</a><a class="small" href="mt.html${api.demo ? "?demo" : ""}" target="_blank" rel="noopener">Maintenance app ›</a></div></div>
   <div class="blk"><h2>People</h2><div id="memList"></div></div></div>`;
  const draw = async () => { let inv = []; try { inv = await api.invites(H.id); } catch (e) { toast(e.message); }
    $("invList").innerHTML = inv.length ? inv.map((i) => `<div class="invite"><span class="r">${ROLE[i.role]}</span><span class="code">${esc(i.code)}</span><span class="meta">valid until ${new Date(i.expires_at).toLocaleDateString()}</span><button class="small" style="margin-left:auto" data-delinv="${esc(i.code)}">Delete</button></div>`).join("") : `<p class="empty">No active codes.</p>`;
    $("invList").querySelectorAll("[data-delinv]").forEach((b) => b.onclick = async () => { await api.deleteInvite(b.dataset.delinv); draw(); });
    $("memList").innerHTML = Object.values(members).map((m) => `<div class="invite"><span class="r">${ROLE[m.role]}</span><span>${esc(m.display_name || (m.user_id === me.id ? "You" : "—"))}</span>${m.user_id !== me.id ? `<button class="small" style="margin-left:auto" data-rm="${m.user_id}">Remove</button>` : ""}</div>`).join("");
    $("memList").querySelectorAll("[data-rm]").forEach((b) => b.onclick = async () => { if (b.dataset.armed) { await api.removeMember(H.id, b.dataset.rm); delete members[b.dataset.rm]; draw(); } else { b.dataset.armed = 1; b.textContent = "Click again to remove"; } }); };
  v.querySelectorAll("[data-inv]").forEach((b) => b.onclick = async () => { try { await api.createInvite(H.id, b.dataset.inv); draw(); } catch (e) { toast(e.message); } });
  draw();
}

// ───────────── Concierge search (hotel slang) ─────────────
const VOCAB = [
  [/^(sgl|single|sngl)$/, { k: "type", v: ["sgl"], l: "single" }], [/^(dbl|double|king|kng|queen|qn|kb)$/, { k: "type", v: ["dbl", "fam", "ste"], l: "king bed" }],
  [/^(twn|twin|tw)$/, { k: "type", v: ["twn"], l: "twin" }], [/^(tpl|trpl|triple|trp)$/, { k: "beds", v: 3, l: "3+ beds" }],
  [/^(fam|family|fml)$/, { k: "type", v: ["fam"], l: "family" }], [/^(ste|suite|jrs|junior|jr)$/, { k: "type", v: ["ste"], l: "suite" }],
  [/^(sv|sea|seaview|ocean|ov)$/, { k: "view", v: "sea", l: "sea view" }], [/^(cv|city|cityview|street)$/, { k: "view", v: "city", l: "city view" }],
  [/^(gv|garden)$/, { k: "view", v: "garden", l: "garden view" }], [/^(court|courtyard|yard)$/, { k: "view", v: "courtyard", l: "courtyard" }],
  [/^(mv|mountain|mountainview)$/, { k: "view", v: "mountain", l: "mountain view" }], [/^(pv|pool|poolview)$/, { k: "view", v: "pool", l: "pool view" }],
  [/^(blc|balc|balcony|terrace|terr)$/, { k: "feat", v: "balcony", l: "balcony" }], [/^(tub|bath|bathtub)$/, { k: "feat", v: "bathtub", l: "bathtub" }],
  [/^(acc|ada|accessible|wheelchair|wc|disabled|prm)$/, { k: "feat", v: "accessible", l: "accessible" }],
  [/^(conn|connecting|adjoining|adj|cnx)$/, { k: "feat", v: "connecting", l: "connecting" }], [/^(quiet|qt|silent|calm)$/, { k: "feat", v: "quiet", l: "quiet" }],
  [/^(lift|elevator|nl|nearlift)$/, { k: "feat", v: "near lift", l: "near lift" }],
  [/^(apt|apts|apartment|apartments|flat|unit)$/, { k: "type", v: ["stu", "ap1", "ap2", "ap3"], l: "apartment" }], [/^(stu|studio)$/, { k: "type", v: ["stu"], l: "studio" }],
  [/^(kit|kitchen|kitchenette|kn|cook)$/, { k: "feat", v: "kitchen", l: "kitchen" }],
  [/^(hf|high|top|highfloor)$/, { k: "high", v: 0, l: "high floor" }], [/^(lf|low|gf|ground|lowfloor|groundfloor)$/, { k: "low", v: 0, l: "low floor" }],
];
function parseQ(q) { const raw = q.toLowerCase().replace(/[,;+]/g, " ").replace(/\b(high|low|near|sea|city|ground|mountain|pool)\s+(floor|lift|view)\b/g, "$1$2").trim();
  const c = { tags: [], unknown: [], room: null }; const toks = raw.split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) { const t = toks[i], nx = toks[i + 1] || "";
    let m = t.match(/^(\d+)(br|bdr|bedroom|bedrooms|b|bd|bed|beds|pax|p|ppl|ad|adults|guests|g|pers)?$/);
    if (m) { const n = +m[1]; let unit = m[2];
      if (!unit && /^(br|bdr|bedroom|bedrooms|b|bd|bed|beds|pax|p|ppl|people|ad|adults|guests|persons|pers|g)$/.test(nx)) { unit = nx; i++; }
      if (/^(br|bdr|bedroom|bedrooms)$/.test(unit || "")) { c.tags.push({ k: "br", v: n, l: n + "+ bedrooms" }); continue; }
      if (!unit && BYNUM[t]) { c.room = BYNUM[t]; c.tags.push({ k: "room", v: BYNUM[t], l: "room " + t }); continue; }
      if (!unit && (nx === "floor" || nx === "fl")) { c.tags.push({ k: "floor", v: [n], l: floorName(n).toLowerCase() }); i++; continue; }
      if (/^(b|bd|bed|beds)$/.test(unit || "")) { c.tags.push({ k: "beds", v: n, l: n + "+ beds" }); continue; }
      if (unit) { c.tags.push({ k: "pax", v: n, l: "sleeps " + n + "+" }); continue; } }
    m = t.match(/^(f|fl|floor)(\d+)$/); if (m) { c.tags.push({ k: "floor", v: [+m[2]], l: floorName(+m[2]).toLowerCase() }); continue; }
    if (/^(view|room|rooms|with|and|a|the|for|need|w|please|pls|ready|free|clean)$/.test(t)) continue;
    const hit = VOCAB.find(([re]) => re.test(t)); if (hit) c.tags.push(hit[1]); else c.unknown.push(t); }
  return c; }
function fits(R, tg) { const lv = FLOORS.map((f) => f.id), hi = Math.max(...lv), lo = Math.min(...lv);
  switch (tg.k) { case "type": return tg.v.includes(R.ty); case "beds": return R.beds >= tg.v; case "pax": return R.pax >= tg.v;
    case "view": return R.view === tg.v; case "feat": return R.feat.has(tg.v); case "floor": return tg.v.includes(R.floor); case "room": return R.id === tg.v;
    case "br": return (BEDROOMS[R.ty] ?? 0) >= tg.v && SH.isApt(R.ty); case "high": return R.floor >= hi - Math.floor((hi - lo) / 3); case "low": return R.floor <= lo + Math.floor((hi - lo) / 3); } return false; }
function concierge(q) { const c = parseQ(q), tags = c.tags; if (!tags.length) return { c, ready: [], soon: [], close: [] };
  const score = (id) => tags.filter((tg) => fits(ROOMS[id], tg)).length;
  const avail = (id) => { const r = rec(id); return r.status === "free" && !openIss(id).length ? "ready" : r.status === "dirty" || r.status === "cleaning" ? "soon" : null; };
  const byFresh = (a, b) => new Date(rec(b).last_cleaned || 0) - new Date(rec(a).last_cleaned || 0);
  const gapTag = tags.find((x) => x.k === "beds" || x.k === "pax"), gap = (id) => (gapTag ? (gapTag.k === "beds" ? ROOMS[id].beds : ROOMS[id].pax) - gapTag.v : 0);
  const sorter = (a, b) => gap(a) - gap(b) || byFresh(a, b), all = Object.keys(ROOMS).filter((id) => !isSpace(id) || tags.some((t) => t.k === "room")), full = all.filter((id) => score(id) === tags.length);
  return { c, ready: full.filter((id) => avail(id) === "ready").sort(sorter), soon: full.filter((id) => avail(id) === "soon").sort((a, b) => (rec(b).status === "cleaning") - (rec(a).status === "cleaning") || sorter(a, b)),
    close: tags.length > 1 ? all.filter((id) => avail(id) === "ready" && score(id) === tags.length - 1).sort(sorter).slice(0, 4) : [] }; }
let cqIdx = 0;
function cqRow(id, kind, tags, label) { const R = ROOMS[id], r = rec(id);
  const facts = [["beds", BEDDESC[R.ty]], ...(R.view ? [["view", R.view + " view"]] : []), ...[...R.feat].map((f) => ["feat", f])];
  const chip = ([k, l]) => { const t = tags.find((tg) => tg.k === k && (k !== "feat" || tg.v === l) && (k !== "view" || tg.v + " view" === l)); return `<i class="${t ? "hit" : ""}">${esc(l)}</i>`; };
  const missing = tags.filter((tg) => !fits(R, tg)).map((tg) => `<i class="miss">no ${esc(tg.l)}</i>`).join("");
  const st = kind === "soon" ? (r.status === "cleaning" ? "being cleaned now" : "waiting for cleaning") : kind === "ready" ? "cleaned " + ago(r.last_cleaned) : STATUS[r.status];
  return `<button class="cq-row" data-cq="${id}"><span class="rn">${esc(R.n)}</span><span class="d"><b>${TY[R.ty]}</b> · sleeps ${R.pax} · ${esc(floorName(R.floor))} · ${st}<span class="f">${facts.map(chip).join("")}${missing}</span></span>${SH.layoutOf(R) ? `<span class="cq-mini">${SH.schematic(R)}</span>` : ""}<span class="go ${kind === "soon" ? "soon" : ""}">${label || (kind === "soon" ? "Hold" : "Check in")} ›</span></button>`; }
function renderConcierge() { const q = $("cq").value, box = $("cres");
  if (document.activeElement !== $("cq") && !q) { box.hidden = true; return; }
  box.hidden = false;
  if (!q.trim()) box.innerHTML = `<div class="cq-h">Try</div><div class="cq-sug">${["3 beds", "sv blc", "twn quiet", "4 pax", "acc", "conn", "ste hf", "2 beds city"].map((x) => `<button data-sug="${x}">${x}</button>`).join("")}</div>`;
  else { const { c, ready, soon, close } = concierge(q), tags = c.tags;
    let h = `<div class="cq-tags">${tags.map((t) => `<span>${esc(t.l)}</span>`).join("")}${c.unknown.map((u) => `<span class="unk" title="Not understood">${esc(u)}</span>`).join("")}</div>`;
    if (c.room && tags.length === 1) h += `<div class="cq-h">Room · ${STATUS[rec(c.room).status]}</div>` + cqRow(c.room, "room", tags, "Open");
    else if (!tags.length) h += `<p class="cq-empty">Type what the guest wants, like “3 beds”, “sea view” or “acc”.</p>`;
    else { h += `<div class="cq-h">Ready now · ${ready.length}</div>` + (ready.length ? ready.slice(0, 8).map((id) => cqRow(id, "ready", tags)).join("") : `<p class="cq-empty">Nothing clean and free matches exactly.</p>`);
      if (soon.length) h += `<div class="cq-h">Ready soon · after cleaning</div>` + soon.slice(0, 4).map((id) => cqRow(id, "soon", tags)).join("");
      if (!ready.length && close.length) h += `<div class="cq-h">Close matches · ready now</div>` + close.map((id) => cqRow(id, "ready", tags)).join(""); }
    box.innerHTML = h; }
  const rows = [...box.querySelectorAll(".cq-row")]; cqIdx = Math.min(cqIdx, Math.max(rows.length - 1, 0)); rows.forEach((r, i) => r.classList.toggle("act", i === cqIdx));
  box.querySelectorAll("[data-sug]").forEach((b) => b.onmousedown = (e) => { e.preventDefault(); $("cq").value = b.dataset.sug; cqIdx = 0; renderConcierge(); });
  box.querySelectorAll("[data-cq]").forEach((b) => b.onmousedown = (e) => { e.preventDefault(); pickCq(b.dataset.cq); }); }
function pickCq(id) { $("cq").blur(); $("cres").hidden = true; goRoom(id); setTimeout(() => { const g = $("guest"); if (g) g.focus(); }, 1100); }

// ───────────── render ─────────────
function render() {
  if (!H) return;
  const tabs = TABS[H.role]; if (!tabs.includes(view)) view = tabs[0];
  $("t-title").textContent = TABNAME[view]; $("hotelName").textContent = H.name + (api.demo ? " · demo" : "");
  $("tabs").innerHTML = tabs.map((v) => `<button role="tab" data-tab="${v}" aria-selected="${v === view}">${TABNAME[v]}</button>`).join("");
  $("tabs").hidden = tabs.length < 2; $("tabs").querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { view = b.dataset.tab; if (view === "team") renderTeam(); if (view === "setup") renderSetup(); render(); });
  $("concierge").hidden = !can("desk");
  $("calmBtn").hidden = view !== "desk"; $("calmBtn").setAttribute("aria-pressed", document.body.classList.contains("calm")); $("calmBtn").textContent = document.body.classList.contains("calm") ? "Calm mode on" : "Calm mode";
  ["desk", "hk", "mt", "setup", "team"].forEach((v) => ($("view-" + v).hidden = v !== view));
  if (api.demo) { $("banner").hidden = false; $("banner").innerHTML = `Demo hotel with sample data, saved only in this browser. Try it live: open the <a href="hk.html${location.search.includes("demo") ? "?demo" : ""}" target="_blank" rel="noopener">Housekeeping app</a> in a second tab, then check a guest out here.`; } else $("banner").hidden = true;
  if (view === "desk") {
    const noRooms = !Object.keys(ROOMS).length;
    $("modeLabel").textContent = mode === "building" ? "" : floorName(floor); $("modeHint").textContent = mode === "building" ? (noRooms ? "No rooms yet · open Setup" : "") : "Click a room";
    $("fsw").innerHTML = FLOORS.map((f) => `<button data-f="${f.id}" aria-pressed="${f.id === floor}" aria-label="${esc(floorName(f.id))}">${floorShort(f.id)}</button>`).join("");
    $("fsw").querySelectorAll("button").forEach((b) => b.onclick = () => { floor = +b.dataset.f; sel = null; render(); });
    $("next").innerHTML = nextHtml(); bind($("next"));
    updateWorld(); camera(); sizeHolo(); updateHolo();
    const keep = {}; ["guest", "issueTxt"].forEach((id) => { const e = $(id); if (e) keep[id] = { v: e.value, f: document.activeElement === e }; });
    if (mode === "floor") { $("side").innerHTML = sel && ROOMS[sel] ? roomHtml(sel) : floorHtml(floor);
      Object.entries(keep).forEach(([id, k]) => { const e = $(id); if (e) { e.value = k.v; if (k.f) e.focus(); } });
      const x = $("closeRoom"); if (x) x.onclick = () => { sel = null; render(); }; bind($("side")); }
  }
  if (view === "hk") { $("hkList").innerHTML = hkHtml(); bind($("hkList")); }
  if (view === "mt") { $("mtList").innerHTML = mtHtml(); bind($("mtList")); }
}
function bind(root) {
  root.querySelectorAll("[data-go]").forEach((b) => b.onclick = () => goRoom(b.dataset.go));
  root.querySelectorAll(".chips button").forEach((b) => b.onclick = () => b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true"));
  root.querySelectorAll("[data-do]").forEach((b) => b.onclick = () => { const id = b.dataset.room || sel, d = b.dataset.do;
    if (d === "checkin") patchRoom(id, { status: "occupied", guest: (($("guest") || {}).value || "").trim() }, "checkin");
    if (d === "checkout") patchRoom(id, { status: "dirty" }, "checkout");
    if (d === "request") patchRoom(id, { status: "dirty" });
    if (d === "start") patchRoom(id, { status: "cleaning" }, "start");
    if (d === "cleaned") { const box = root.querySelector(`[data-miss="${id}"]`) || root.querySelector("#miss"); const miss = box ? [...box.querySelectorAll('[aria-pressed="true"]')].map((x) => x.dataset.item) : [];
      patchRoom(id, { status: "free" }, "cleaned"); miss.forEach((m) => addIssue(id, m)); }
    if (d === "issue") { const inp = $("issueTxt"), txt = ((inp && inp.value) || "").trim(); if (!txt) { inp && inp.focus(); return; } inp.value = ""; addIssue(id, txt); toast(TOAST.issue(num(id))); } });
  root.querySelectorAll("[data-fix]").forEach((b) => b.onclick = () => fixIssue(b.dataset.fix));
  root.querySelectorAll("[data-plan]").forEach((b) => b.onclick = () => openPlan(b.dataset.plan));
}
function openPlan(id) { const R = ROOMS[id], L = SH.layoutOf(R) || [];
  $("planModal").innerHTML = `<div class="pm-card hud" role="dialog" aria-modal="true" aria-label="Floor plan"><div class="rt"><h3>${esc(R.n)}</h3><span class="meta">${TY[R.ty]} · sleeps ${R.pax} · ${esc(floorName(R.floor))}</span><button class="small x" id="pmClose" aria-label="Close">✕</button></div>
    ${SH.schematic(R, true)}<div class="pm-list">${L.map((s) => `<span class="pm-${s.k}"><b>${esc(s.l)}</b>${s.d ? " · " + esc(s.d) : ""}</span>`).join("")}</div></div>`;
  $("planModal").hidden = false; $("pmClose").focus();
  const close = () => { $("planModal").hidden = true; }; $("pmClose").onclick = close; $("planModal").onclick = (e) => { if (e.target.id === "planModal") close(); };
}

// ───────────── live updates ─────────────
function onChange(table, type, row, old) {
  if (table === "setup" || (table === "rooms" && (type === "INSERT" || type === "DELETE"))) { openHotel(H, true); return; }
  if (table === "rooms" && row && ROOMS[row.id]) { const prev = state[row.id];
    if (prev && prev.status !== row.status && prev.updated_at !== row.updated_at) { const k = row.status === "free" ? "cleaned" : row.status === "dirty" ? "checkout" : row.status === "cleaning" ? "start" : "checkin"; toast(TOAST[k](num(row.id))); }
    state[row.id] = { ...prev, ...row }; delete evCache[row.id]; render(); }
  if (table === "issues" && row) { const i = issues.findIndex((x) => x.id === row.id);
    if (i < 0) { issues.push(row); if (ROOMS[row.room_id]) toast(TOAST.issue(num(row.room_id))); } else { if (issues[i].open && !row.open) toast(TOAST.fixed(num(row.room_id))); issues[i] = { ...issues[i], ...row }; }
    delete evCache[row.room_id]; render(); }
}

// ───────────── auth & hotel flow ─────────────
async function openHotel(h, keepView) {
  H = h; try { localStorage.setItem("fd-hotel", h.id); } catch (e) {}
  const d = await api.load(h.id); ingest(d); evCache = {};
  if (unsub) unsub(); unsub = api.subscribe(h.id, onChange);
  if (!keepView) { view = TABS[h.role][0]; mode = "building"; sel = null; }
  if (h.role === "owner" && !Object.keys(ROOMS).length) { view = "setup"; draft = [];  }
  $("stage").classList.add("notrans"); buildWorld(); show("app"); buildHolo(); render(); if (view === "setup") renderSetup();
  $("world").getBoundingClientRect(); requestAnimationFrame(() => requestAnimationFrame(() => $("stage").classList.remove("notrans")));
}
async function afterLogin() {
  me = await api.user(); if (!me) { show("auth"); return; }
  let list = [];
  try { list = await api.myHotels(); } catch (e) { toast(e.message); }
  hotels = list.filter((m) => m.hotel).map((m) => ({ id: m.hotel.id, name: m.hotel.name, role: m.role }));
  if (!hotels.length) { show("onboard"); return; }
  let saved = null; try { saved = localStorage.getItem("fd-hotel"); } catch (e) {}
  const pick = $("hotelPick"); pick.hidden = hotels.length < 2; pick.innerHTML = hotels.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
  const h = hotels.find((x) => x.id === saved) || hotels[0]; pick.value = h.id;
  pick.onchange = () => openHotel(hotels.find((x) => x.id === pick.value));
  if (api.demo) { const dr = $("demoRoles"); dr.hidden = false; const draw = () => { dr.innerHTML = `<span class="who">View as</span>` + Object.keys(ROLE).map((r) => `<button data-r="${r}" aria-pressed="${api.role === r}">${ROLE[r]}</button>`).join("") + `<button data-reset="1">Reset</button>`;
      dr.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => { api.setRole(b.dataset.r); H.role = b.dataset.r; draw(); view = TABS[H.role][0]; render(); });
      dr.querySelectorAll("[data-reset]").forEach((b) => b.onclick = () => { if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = "Sure?"; return; } api.reset(); location.reload(); }); }; draw(); }
  await openHotel(h);
}
let signingUp = false;
$("authSwitch").onclick = () => { signingUp = !signingUp; $("authTitle").textContent = signingUp ? "Create account" : "Sign in"; $("authBtn").textContent = signingUp ? "Create account" : "Sign in"; $("authSwitch").textContent = signingUp ? "Have an account? Sign in" : "New here? Create an account"; $("pw").autocomplete = signingUp ? "new-password" : "current-password"; $("authErr").textContent = ""; };
$("authForm").onsubmit = async (e) => { e.preventDefault(); $("authErr").textContent = ""; $("authBtn").disabled = true;
  try { if (signingUp) { const ready = await api.signUp($("email").value.trim(), $("pw").value); if (!ready) { $("authErr").className = "ok"; $("authErr").textContent = "Check your email to confirm the account, then sign in."; signingUp = true; $("authSwitch").click(); return; } } else await api.signIn($("email").value.trim(), $("pw").value);
    await afterLogin(); } catch (err) { $("authErr").className = "err"; $("authErr").textContent = err.message; } finally { $("authBtn").disabled = false; } };
$("createForm").onsubmit = async (e) => { e.preventDefault(); try { await api.createHotel($("hname").value.trim()); await afterLogin(); } catch (err) { $("createErr").textContent = err.message; } };
$("joinForm").onsubmit = async (e) => { e.preventDefault(); try { await api.joinHotel($("jcode").value.trim(), $("jname").value.trim()); await afterLogin(); } catch (err) { $("joinErr").textContent = err.message; } };
const out = async () => { await api.signOut(); try { localStorage.removeItem("fd-hotel"); } catch (e) {} location.reload(); };
$("signOut").onclick = out; $("obSignOut").onclick = out;
$("back").onclick = toBuilding;
try { if (localStorage.getItem("fd-calm") === "1") document.body.classList.add("calm"); } catch (e) {}
$("calmBtn").onclick = () => { const on = document.body.classList.toggle("calm"); try { localStorage.setItem("fd-calm", on ? "1" : "0"); } catch (e) {} render(); };
$("cq").addEventListener("input", () => { cqIdx = 0; renderConcierge(); });
$("cq").addEventListener("focus", renderConcierge);
$("cq").addEventListener("blur", () => setTimeout(() => { $("cres").hidden = true; }, 120));
$("cq").addEventListener("keydown", (e) => { const rows = [...$("cres").querySelectorAll(".cq-row")];
  if (e.key === "ArrowDown") { e.preventDefault(); cqIdx = Math.min(cqIdx + 1, rows.length - 1); renderConcierge(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); cqIdx = Math.max(cqIdx - 1, 0); renderConcierge(); }
  else if (e.key === "Enter" && rows[cqIdx]) { e.preventDefault(); pickCq(rows[cqIdx].dataset.cq); }
  else if (e.key === "Escape") { $("cq").value = ""; $("cq").blur(); } });
window.addEventListener("keydown", (e) => {
  if (e.key === "/" && H && can("desk") && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); view = "desk"; render(); $("cq").focus(); }
  if (e.key === "Escape" && view === "desk" && mode === "floor" && !/INPUT/.test(document.activeElement.tagName)) { if (sel) { sel = null; render(); } else toBuilding(); } });
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { camera(); sizeHolo(); }, 120); });
setInterval(() => { if (document.visibilityState === "visible" && H && !["setup", "team"].includes(view)) render(); }, 60000);
api.onAuth((u) => { if (!u && me) location.reload(); });
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
afterLogin();
})();
