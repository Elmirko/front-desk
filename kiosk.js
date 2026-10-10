// Staff apps for a phone or a wall tablet: two big buttons, "I'm in" and "I'm out".
//   hk.html → housekeeping (window.KIOSK = "hk")   mt.html → maintenance (window.KIOSK = "mt")
(function () {
"use strict";
const MODE = window.KIOSK === "mt" ? "mt" : "hk", api = window.api, { TY, esc } = window.SH;
const $ = (id) => document.getElementById(id);
const ALLOWED = { hk: ["hk", "desk", "owner"], mt: ["mt", "desk", "owner"] };
const ITEMS = ["Towels", "Soap & shampoo", "Light bulb", "Remote", "Toilet paper", "Air con"];
let H = null, floors = {}, rooms = {}, issues = [], screen = { k: "list" }, alertsOn = false, unsub = null;
const mins = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000)) : 0);
const dur = (m) => (m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? " " + (m % 60) + " min" : ""}`);
const floorName = (fid) => { const f = floors[fid]; return f ? f.name || (f.level === 0 ? "Ground floor" : "Floor " + f.level) : ""; };
const roomOf = (id) => rooms[id] || {};
// plain facts instead of running timers: "10:42 · 35 min ago"
const ago = (iso) => { const m = mins(iso); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`; };
const fmt = (iso) => { if (!iso) return "no record"; const d = new Date(iso), today = new Date().toDateString() === d.toDateString();
  return `${today ? "" : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " "}${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${ago(iso)}`; };
const ROLE = { owner: "Owner", desk: "Front desk", hk: "Housekeeping", mt: "Maintenance" };
let members = {}, evc = {};
const who = (uid) => { const m = members[uid]; return m ? m.display_name || ROLE[m.role] : ""; };
async function loadEvents(roomId) { if (evc[roomId]) return; try { evc[roomId] = await api.events(roomId); render(); } catch (e) {} }
const info = (rows) => `<dl class="k-info">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
const toast = (t) => { const d = document.createElement("div"); d.className = "toast"; d.textContent = t; $("toasts").appendChild(d); setTimeout(() => d.remove(), 3500); };

// ───────── alerts: sound + vibration + system notification ─────────
let actx = null;
function chime() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const t = actx.currentTime;
  [[880, 0], [1320, 0.18]].forEach(([f, d]) => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; o.type = "sine";
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5);
    o.connect(g).connect(actx.destination); o.start(t + d); o.stop(t + d + 0.55); }); } catch (e) {} }
function alertNew(title, body) {
  const b = $("alert"); b.innerHTML = `<b>${esc(title)}</b><span>${esc(body)}</span>`; b.hidden = false; clearTimeout(b._t); b._t = setTimeout(() => (b.hidden = true), 8000);
  if (!alertsOn) return;
  chime(); if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (document.hidden && "Notification" in window && Notification.permission === "granted") { try { new Notification(title, { body, icon: "icon.svg", tag: title }); } catch (e) {} }
}
async function enableAlerts() {
  alertsOn = true; chime();
  if ("Notification" in window && Notification.permission === "default") { try { await Notification.requestPermission(); } catch (e) {} }
  try { localStorage.setItem("fd-alerts-" + MODE, "1"); } catch (e) {}
  if (navigator.wakeLock) { try { await navigator.wakeLock.request("screen"); } catch (e) {} } // keep a wall tablet awake
  render();
}

// ───────── data ─────────
async function load() {
  const d = await api.load(H.id);
  floors = Object.fromEntries(d.floors.map((f) => [f.id, f]));
  rooms = Object.fromEntries(d.rooms.map((r) => [r.id, r]));
  issues = d.issues; members = Object.fromEntries((d.members || []).map((m) => [m.user_id, m])); evc = {};
}
function onChange(table, type, row) {
  if (table === "setup" || (table === "rooms" && type !== "UPDATE")) { load().then(render); return; }
  if (table === "rooms" && row) { const prev = rooms[row.id];
    if (MODE === "hk" && row.status === "dirty" && (!prev || prev.status !== "dirty")) alertNew(`Room ${row.number} needs cleaning`, `${floorName(row.floor_id)} · guest checked out`);
    rooms[row.id] = { ...prev, ...row }; delete evc[row.id]; }
  if (table === "issues" && row) { const i = issues.findIndex((x) => x.id === row.id);
    if (i < 0) { issues.push(row); if (MODE === "mt") alertNew(`New issue · Room ${roomOf(row.room_id).number || ""}`, row.text); }
    else issues[i] = { ...issues[i], ...row }; delete evc[row.room_id]; }
  render();
}

// ───────── housekeeping ─────────
function hkList() {
  const list = Object.values(rooms).filter((r) => r.status === "dirty" || r.status === "cleaning")
    .sort((a, b) => (b.status === "cleaning") - (a.status === "cleaning") || new Date(a.status_since) - new Date(b.status_since));
  if (!list.length) return `<div class="k-empty"><b>All rooms are clean</b><span>New rooms appear here the moment a guest checks out.</span></div>`;
  return `<div class="k-grid">${list.map((r) => `<button class="k-tile ${r.status}" data-room="${r.id}"><span class="k-n">${esc(r.number)}</span>
    <span class="k-s">${r.status === "cleaning" ? "IN PROGRESS · since " + fmt(r.status_since).split(" · ")[0] : (window.SH.isSpace(r.type) ? "REQUESTED " : "CHECKED OUT ") + fmt(r.status_since).split(" · ")[0]}</span>
    <span class="k-m">${esc(floorName(r.floor_id))} · ${esc(TY[r.type] || "")}${window.SH.isSpace(r.type) ? "" : " · " + esc(window.SH.BEDDESC[r.type] || "")}</span><span class="k-m">Last cleaned ${r.last_cleaned ? ago(r.last_cleaned) : "· no record"}</span></button>`).join("")}</div>`;
}
function hkInfo(r) {
  loadEvents(r.id); const sp = window.SH.isSpace(r.type), open = issues.filter((i) => i.room_id === r.id && i.open), ev = evc[r.id] || [];
  const cleans = ev.filter((e) => e.event === "cleaned").slice(0, 3);
  return info([
    r.status === "cleaning" ? ["Started", fmt(r.status_since)] : [sp ? "Requested" : "Guest checked out", fmt(r.status_since)],
    ["Last cleaned", fmt(r.last_cleaned)],
    sp ? ["Area", (r.features || []).includes("staff only") ? "🔒 Staff only" : "Guest area"] : ["Prepare", `${esc(window.SH.BEDDESC[r.type] || "")} · sleeps ${r.pax}`],
    open.length ? ["Known issues", open.map((i) => esc(i.text) + (i.progress === "parts" ? " (waiting for part)" : "")).join(", ")] : null,
    cleans.length > 1 ? ["Earlier cleanings", cleans.slice(1).map((e) => fmt(e.at).split(" · ")[0] + (who(e.actor) ? " · " + esc(who(e.actor)) : "")).join("<br>")] : null,
  ]); }
function hkRoom(r) {
  const plan = window.SH.layoutOf({ ty: r.type, layout: r.layout, features: r.features }) ? `<div class="k-plan">${window.SH.schematic({ ty: r.type, type: r.type, layout: r.layout, features: r.features })}</div>` : "";
  if (r.status === "dirty") return `<div class="k-room"><div class="k-head"><span class="k-big">${esc(r.number)}</span><span>${esc(floorName(r.floor_id))} · ${esc(TY[r.type] || "")}</span></div>${hkInfo(r)}${plan}
    <button class="k-btn in" data-act="in">I'M IN<small>Start cleaning</small></button></div>`;
  if (r.status === "cleaning") return `<div class="k-room"><div class="k-head"><span class="k-big">${esc(r.number)}</span><span>${esc(floorName(r.floor_id))} · ${esc(TY[r.type] || "")}</span></div>${hkInfo(r)}
    <p class="k-q">Anything missing or broken?</p><div class="chips k-chips">${ITEMS.map((x) => `<button aria-pressed="false" data-item="${esc(x)}">${esc(x)}</button>`).join("")}</div>
    <input class="k-note" id="kNote" placeholder="Other problem (optional)" maxlength="200">
    <button class="k-btn out" data-act="out">I'M OUT<small>Room is ready</small></button></div>`;
  return `<div class="k-empty"><b>Room ${esc(r.number)} is ${r.status === "free" ? "ready" : "occupied"}</b></div>`;
}

// ───────── maintenance ─────────
const PROG = { new: "New", working: "You are in the room", paused: "Not finished", parts: "Waiting for a part" };
function mtList() {
  const list = issues.filter((i) => i.open && rooms[i.room_id]).sort((a, b) => (b.progress === "working") - (a.progress === "working")
    || (roomOf(a.room_id).status === "occupied") - (roomOf(b.room_id).status === "occupied") || new Date(a.reported_at) - new Date(b.reported_at));
  if (!list.length) return `<div class="k-empty"><b>No open issues</b><span>New reports appear here instantly.</span></div>`;
  return `<div class="k-grid">${list.map((i) => { const r = roomOf(i.room_id), occ = r.status === "occupied";
    return `<button class="k-tile mt ${i.progress}" data-issue="${i.id}"><span class="k-n">${esc(r.number)}</span><span class="k-s">${esc(i.text)}</span>
      <span class="k-m">${PROG[i.progress] || "New"}${i.note && i.progress !== "working" ? " · " + esc(i.note) : ""} · ${occ ? "guest in room" : "room empty"}</span>
      <span class="k-m">Reported ${fmt(i.reported_at).split(" · ")[0]}${who(i.reported_by) ? " · by " + esc(who(i.reported_by)) : ""}</span></button>`; }).join("")}</div>`;
}
function mtInfo(i, r) {
  loadEvents(r.id); const ev = evc[r.id] || [], fixes = ev.filter((e) => e.event === "fixed"), occ = r.status === "occupied";
  const others = issues.filter((x) => x.room_id === r.id && x.id !== i.id && x.open);
  return info([
    ["Reported", fmt(i.reported_at) + (who(i.reported_by) ? " · by " + esc(who(i.reported_by)) : "")],
    ["Room", occ ? "Guest in room · knock first" : r.status === "cleaning" ? "Housekeeping inside now" : r.status === "dirty" ? "Empty · waiting for cleaning" : "Empty · ready for guests"],
    i.progress !== "new" ? ["Status", `${PROG[i.progress]}${i.note ? " · " + esc(i.note) : ""}${i.progress_at ? " · " + fmt(i.progress_at) : ""}`] : null,
    ["Where", `${esc(floorName(r.floor_id))} · ${esc(TY[r.type] || "")}`],
    others.length ? ["Also open here", others.map((x) => esc(x.text)).join(", ")] : null,
    fixes.length ? ["Earlier repairs here", `${fixes.length} · last: ${esc(fixes[0].note)} · ${fmt(fixes[0].at).split(" · ")[0]}`] : ["Earlier repairs here", "none recorded"],
  ]); }
function mtIssue(i) {
  const r = roomOf(i.room_id), occ = r.status === "occupied";
  const head = `<div class="k-head"><span class="k-big">${esc(r.number)}</span><span>${esc(i.text)}</span></div>${occ ? `<p class="k-warn">Guest in room · knock first</p>` : ""}${screen.k === "mt-out" ? "" : mtInfo(i, r)}`;
  if (i.progress !== "working") return `<div class="k-room">${head}
    <button class="k-btn in" data-act="mt-in">I'M IN<small>Start the repair</small></button></div>`;
  if (screen.k !== "mt-out") return `<div class="k-room">${head}
    <button class="k-btn out" data-act="mt-out">I'M OUT<small>Tell us how it went</small></button></div>`;
  // leaving: an outcome is required
  return `<div class="k-room">${head}<p class="k-q">How did it go?</p>
    <input class="k-note" id="kNote" placeholder="Note (part name, what is left…)" maxlength="200">
    <button class="k-btn out" data-out="fixed">FIXED<small>Room is OK again</small></button>
    <button class="k-btn mid" data-out="paused">NOT FINISHED<small>I will come back</small></button>
    <button class="k-btn bad" data-out="parts">NEEDS A PART<small>Can't finish now</small></button>
    <button class="linkbtn" data-act="mt-back">Still inside · go back</button></div>`;
}

// ───────── render ─────────
function render() {
  if (!H) return;
  $("kHotel").textContent = H.name + (api.demo ? " · demo" : "");
  $("kAlerts").textContent = alertsOn ? "Alerts on" : "Turn on alerts"; $("kAlerts").classList.toggle("on", alertsOn);
  let html = "";
  if (screen.k === "list") html = MODE === "hk" ? hkList() : mtList();
  else if (screen.k === "room") html = hkRoom(roomOf(screen.id));
  else if (screen.k === "done") html = `<div class="k-done"><span class="k-check">✓</span><b>${esc(screen.msg)}</b></div>`;
  else { const i = issues.find((x) => x.id === screen.id); html = i && i.open ? mtIssue(i) : `<div class="k-done"><span class="k-check">✓</span><b>Done</b></div>`; }
  $("kMain").innerHTML = (screen.k !== "list" && screen.k !== "done" ? `<button class="k-back" data-act="back">‹ All ${MODE === "hk" ? "rooms" : "issues"}</button>` : "") + html;
  bind();
}
function done(msg) { screen = { k: "done", msg }; render(); setTimeout(() => { if (screen.k === "done") { screen = { k: "list" }; render(); } }, 1800); }
function bind() {
  const m = $("kMain");
  m.querySelectorAll("[data-room]").forEach((b) => b.onclick = () => { screen = { k: "room", id: b.dataset.room }; render(); });
  m.querySelectorAll("[data-issue]").forEach((b) => b.onclick = () => { screen = { k: "issue", id: b.dataset.issue }; render(); });
  m.querySelectorAll(".k-chips button").forEach((b) => b.onclick = () => b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true"));
  m.querySelectorAll("[data-act]").forEach((b) => b.onclick = async () => {
    const a = b.dataset.act;
    if (a === "back") { screen = { k: "list" }; render(); return; }
    if (a === "mt-out") { screen = { k: "mt-out", id: screen.id }; render(); return; }
    if (a === "mt-back") { screen = { k: "issue", id: screen.id }; render(); return; }
    b.disabled = true;
    try {
      if (a === "in") { const r = await api.updateRoom(screen.id, { status: "cleaning" }); rooms[r.id] = r; render(); }
      if (a === "out") { const id = screen.id, miss = [...m.querySelectorAll('.k-chips [aria-pressed="true"]')].map((x) => x.dataset.item), note = ($("kNote").value || "").trim();
        const r = await api.updateRoom(id, { status: "free" }); rooms[r.id] = r;
        for (const t of note ? [...miss, note] : miss) { const i = await api.addIssue(H.id, id, t); issues.push(i); }
        done(`Room ${r.number} is ready${miss.length || note ? " · problem reported" : ""}`); }
      if (a === "mt-in") { const i = await api.updateIssue(screen.id, { progress: "working", note: "" }); Object.assign(issues.find((x) => x.id === i.id), i); render(); }
    } catch (e) { toast("Could not save: " + e.message); b.disabled = false; }
  });
  m.querySelectorAll("[data-out]").forEach((b) => b.onclick = async () => {
    const o = b.dataset.out, note = ($("kNote").value || "").trim(), id = screen.id; b.disabled = true;
    try { const i = await api.updateIssue(id, o === "fixed" ? { open: false, note } : { progress: o, note });
      Object.assign(issues.find((x) => x.id === id), i, o === "fixed" ? { open: false } : {});
      done(o === "fixed" ? `Room ${roomOf(i.room_id).number} · fixed` : o === "parts" ? "Saved · waiting for a part" : "Saved · not finished"); }
    catch (e) { toast("Could not save: " + e.message); b.disabled = false; }
  });
}

// ───────── sign in & start ─────────
async function start() {
  const me = await api.user();
  if (!me) { $("kLogin").hidden = false; $("kApp").hidden = true; return; }
  let list = []; try { list = await api.myHotels(); } catch (e) { toast(e.message); }
  const ok = list.filter((m) => m.hotel && ALLOWED[MODE].includes(m.role));
  if (!ok.length) { $("kLogin").hidden = true; $("kApp").hidden = false; $("kMain").innerHTML = `<div class="k-empty"><b>No access yet</b><span>Ask your manager for an invite code, then join the hotel in the <a href="index.html">main app</a>.</span></div>`; return; }
  let saved = null; try { saved = localStorage.getItem("fd-hotel"); alertsOn = localStorage.getItem("fd-alerts-" + MODE) === "1"; } catch (e) {}
  const m = ok.find((x) => x.hotel.id === saved) || ok[0]; H = { id: m.hotel.id, name: m.hotel.name };
  await load(); if (unsub) unsub(); unsub = api.subscribe(H.id, onChange);
  $("kLogin").hidden = true; $("kApp").hidden = false; render();
}
$("kForm").onsubmit = async (e) => { e.preventDefault(); $("kErr").textContent = "";
  try { await api.signIn($("kEmail").value.trim(), $("kPw").value); await start(); } catch (err) { $("kErr").textContent = err.message; } };
$("kAlerts").onclick = enableAlerts;
$("kOut").onclick = async () => { await api.signOut(); location.reload(); };
setInterval(() => { if (H && screen.k !== "mt-out" && !document.activeElement.matches("input")) render(); }, 30000);
setInterval(() => { const d = new Date(); $("kClock").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }, 1000);
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
start();
})();
