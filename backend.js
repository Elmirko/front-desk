// Data layer. Two backends with the same functions:
//  • SupabaseBackend – the real product (accounts, every hotel's data in its own rows, live updates)
//  • DemoBackend     – runs in the browser with sample data, used when config.js is empty
(function () {
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "x" + Math.random().toString(36).slice(2) + Date.now().toString(36));
  const nowIso = () => new Date().toISOString();
  const fail = (e) => { throw new Error(e && e.message ? e.message : String(e)); };

  // ───────────────────────── Supabase ─────────────────────────
  function SupabaseBackend(url, key) {
    const sb = window.supabase.createClient(url, key);
    const chk = ({ data, error }) => { if (error) fail(error); return data; };
    return {
      demo: false,
      async user() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; },
      onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => cb(s ? s.user : null)); },
      async signIn(email, password) { chk(await sb.auth.signInWithPassword({ email, password })); },
      async signUp(email, password) { const d = chk(await sb.auth.signUp({ email, password })); return !!d.session; },
      async signOut() { await sb.auth.signOut(); },
      async myHotels() {
        const u = await this.user();
        return chk(await sb.from("members").select("role,display_name,hotel:hotels(id,name,brand)").eq("user_id", u.id));
      },
      async createHotel(name) { return chk(await sb.from("hotels").insert({ name }).select().single()).id; },
      async joinHotel(code, name) { return chk(await sb.rpc("join_hotel", { invite_code: code, your_name: name })); },
      async load(h) {
        const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
        const [floors, rooms, issues, members] = await Promise.all([
          sb.from("floors").select("*").eq("hotel_id", h).order("level"),
          sb.from("rooms").select("*").eq("hotel_id", h).order("position"),
          sb.from("issues").select("*").eq("hotel_id", h).or(`open.eq.true,fixed_at.gt.${weekAgo}`),
          sb.from("members").select("user_id,role,display_name").eq("hotel_id", h),
        ]);
        return { floors: chk(floors), rooms: chk(rooms), issues: chk(issues), members: chk(members) };
      },
      subscribe(h, cb) {
        const ch = sb.channel("hotel-" + h)
          .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `hotel_id=eq.${h}` }, (p) => cb("rooms", p.eventType, p.new, p.old))
          .on("postgres_changes", { event: "*", schema: "public", table: "issues", filter: `hotel_id=eq.${h}` }, (p) => cb("issues", p.eventType, p.new, p.old))
          .subscribe();
        return () => sb.removeChannel(ch);
      },
      async updateRoom(id, patch) { return chk(await sb.from("rooms").update(patch).eq("id", id).select().single()); },
      async addIssue(h, room_id, text) { return chk(await sb.from("issues").insert({ hotel_id: h, room_id, text }).select().single()); },
      async fixIssue(id) { return chk(await sb.from("issues").update({ open: false }).eq("id", id).select().single()); },
      async updateIssue(id, patch) { return chk(await sb.from("issues").update(patch).eq("id", id).select().single()); },
      async events(room_id) { return chk(await sb.from("room_events").select("*").eq("room_id", room_id).order("at", { ascending: false }).limit(20)); },
      // floors: [{level,name,rooms:[{id?,number,type,beds,pax,view,features,position}]}]
      async saveSetup(h, floors) {
        const existingF = chk(await sb.from("floors").select("*").eq("hotel_id", h));
        const existingR = chk(await sb.from("rooms").select("id,number").eq("hotel_id", h));
        const keepNumbers = new Set(floors.flatMap((f) => f.rooms.map((r) => r.number)));
        const gone = existingR.filter((r) => !keepNumbers.has(r.number)).map((r) => r.id);
        if (gone.length) chk(await sb.from("rooms").delete().in("id", gone));
        const fl = chk(await sb.from("floors").upsert(floors.map((f) => ({ hotel_id: h, level: f.level, name: f.name })), { onConflict: "hotel_id,level" }).select());
        const byLevel = Object.fromEntries(fl.map((f) => [f.level, f.id]));
        const levels = new Set(floors.map((f) => f.level));
        const oldFloors = existingF.filter((f) => !levels.has(f.level)).map((f) => f.id);
        const rows = floors.flatMap((f) => f.rooms.map((r, i) => ({ hotel_id: h, floor_id: byLevel[f.level], number: r.number, position: i, type: r.type, beds: r.beds, pax: r.pax, view: r.view || "", features: r.features || [], layout: r.layout || null })));
        if (rows.length) chk(await sb.from("rooms").upsert(rows, { onConflict: "hotel_id,number" }));
        if (oldFloors.length) chk(await sb.from("floors").delete().in("id", oldFloors));
      },
      async invites(h) { return chk(await sb.from("invites").select("*").eq("hotel_id", h).gt("expires_at", nowIso()).order("created_at", { ascending: false })); },
      async createInvite(h, role) { return chk(await sb.from("invites").insert({ hotel_id: h, role }).select().single()); },
      async deleteInvite(code) { chk(await sb.from("invites").delete().eq("code", code)); },
      async removeMember(h, user_id) { chk(await sb.from("members").delete().eq("hotel_id", h).eq("user_id", user_id)); },
    };
  }

  // ───────────────────────── Demo (in the browser) ─────────────────────────
  function DemoBackend() {
    const KEY = "frontdesk-demo-v3", HID = "demo-hotel", ME = { id: "demo-user", email: "demo@example.com" };
    const bc = "BroadcastChannel" in window ? new BroadcastChannel("frontdesk-demo") : null;
    let listeners = [], role = "owner";
    try { role = localStorage.getItem(KEY + "-role") || "owner"; } catch (e) {}
    const read = () => { try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.rooms) return d; } catch (e) {} const d = seed(); write(d); return d; };
    const write = (d) => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { memo = d; } };
    let memo = null;
    const db = () => memo || read();
    const emit = (table, type, n, o) => { const m = { table, type, n, o }; listeners.forEach((f) => f(m)); };
    if (bc) bc.onmessage = (ev) => listeners.forEach((f) => f(ev.data));
    const notify = (table, type, n, o) => { if (bc) bc.postMessage({ table, type, n, o }); };

    function seed() {
      const t = (m) => new Date(Date.now() - m * 60000).toISOString();
      const BEDS = { sgl: 1, dbl: 1, twn: 2, tpl: 3, fam: 3, ste: 2, stu: 1, ap1: 2, ap2: 3, ap3: 5, rest: 0, kit: 0, gym: 0, laun: 0 }, PAX = { sgl: 1, dbl: 2, twn: 2, tpl: 3, fam: 4, ste: 4, stu: 2, ap1: 4, ap2: 5, ap3: 8, rest: 1, kit: 1, gym: 1, laun: 1 };
      const SPACE_NO = { rest: "REST", kit: "KITCHEN", gym: "GYM", laun: "LAUNDRY" };
      const floors = [0, 1, 2, 3].map((l) => ({ id: "f" + l, hotel_id: HID, level: l, name: l === 0 ? "Ground floor" : l === 3 ? "Floor 3 · Apartments" : "Floor " + l }));
      const types = { 0: ["dbl", "twn", "sgl", "tpl", "rest", "kit", "gym", "laun"], 1: ["dbl", "twn", "tpl", "dbl", "fam", "ste", "sgl", "twn", "dbl", "tpl", "sgl", "ste"] };
      types[2] = types[1]; types[3] = ["ap2", "stu", "ap1", "ap3", "ap1", "stu"];
      const plan = { "01": "free", "02": "occupied", "03": "occupied", "04": "free", "101": "free", "102": "occupied", "103": "occupied", "104": "dirty", "105": "free", "106": "occupied", "107": "cleaning", "108": "free", "109": "occupied", "110": "dirty", "111": "occupied", "112": "free", "301": "free", "302": "occupied", "303": "dirty", "304": "free", "305": "occupied", "306": "free" };
      const names = ["Ana M.", "Marko P.", "J. Smith", "Ivana K.", "L. Rossi", "Nikola S.", "M. Weber", "Sara D.", "T. Novak", "Elena R.", "K. Tanaka", "D. Horvat"];
      const rooms = [], events = [];
      floors.forEach((f) => types[f.level].forEach((ty, i) => {
        const n = SPACE_NO[ty] || (f.level === 0 ? "0" + (i + 1) : String(f.level * 100 + i + 1)), half = Math.ceil(types[f.level].length / 2), top = i < half, pos = i % half;
        const feat = [];
        if (f.level > 0 && top) feat.push("balcony");
        if (/^(stu|ap)/.test(ty)) feat.push("kitchen");
        if (ty === "kit" || ty === "laun") feat.push("staff only");
        if (ty === "ste" || ty === "fam") feat.push("bathtub");
        if (["01", "101", "201"].includes(n)) feat.push("accessible");
        if (["102", "103", "202", "203"].includes(n)) feat.push("connecting");
        if (f.level > 0 && (pos === 0 || pos === half - 1)) feat.push("quiet");
        if (f.level > 0 && (pos === 2 || pos === 3)) feat.push("near lift");
        const st = SPACE_NO[ty] ? (ty === "gym" ? "dirty" : "free") : plan[n] || "occupied", k = rooms.length, lc = t(30 + ((k * 97) % 900)), since = st === "free" ? lc : t(10 + ((k * 37) % 400));
        const id = "r" + n;
        rooms.push({ id, hotel_id: HID, floor_id: f.id, number: n, position: i, type: ty, beds: BEDS[ty], pax: PAX[ty],
          view: SPACE_NO[ty] ? "" : f.level === 0 ? (top ? "garden" : "courtyard") : top ? "sea" : "city", features: feat,
          status: st, guest: st === "occupied" && !SPACE_NO[ty] ? names[k % names.length] : "", last_cleaned: lc, status_since: since, updated_at: since });
        events.push({ id: events.length + 1, hotel_id: HID, room_id: id, event: "cleaned", note: "", actor: null, at: lc });
        if (st !== "free") events.push({ id: events.length + 1, hotel_id: HID, room_id: id, event: st === "occupied" ? "checkin" : st === "dirty" ? "checkout" : "start", note: "", actor: null, at: since });
      }));
      const issues = [
        { id: "i1", hotel_id: HID, room_id: "r104", text: "Remote", open: true, reported_at: t(50), progress: "new", note: "" },
        { id: "i2", hotel_id: HID, room_id: "r202", text: "Air con", open: true, reported_at: t(140), progress: "parts", note: "compressor ordered", progress_at: t(90) },
        { id: "i3", hotel_id: HID, room_id: "r306", text: "Dishwasher", open: true, reported_at: t(35), progress: "new", note: "" },
      ];
      return { hotel: { id: HID, name: "Demo Hotel", brand: {} }, floors, rooms, issues, events, invites: [] };
    }

    return {
      demo: true,
      get role() { return role; },
      setRole(r) { role = r; try { localStorage.setItem(KEY + "-role", r); } catch (e) {} },
      reset() { const d = seed(); write(d); },
      async user() { return ME; },
      onAuth() {},
      async signIn() {}, async signUp() { return true; }, async signOut() {},
      async myHotels() { return [{ role, display_name: "Demo", hotel: db().hotel }]; },
      async createHotel() { return HID; }, async joinHotel() { return HID; },
      async load() { const d = db(); return { floors: d.floors, rooms: d.rooms, issues: d.issues, members: [{ user_id: ME.id, role, display_name: "You" }] }; },
      subscribe(_h, cb) {
        const f = (m) => cb(m.table, m.type, m.n, m.o);
        listeners.push(f);
        return () => { listeners = listeners.filter((x) => x !== f); };
      },
      async updateRoom(id, patch) {
        const d = db(), r = d.rooms.find((x) => x.id === id); if (!r) fail("Room not found");
        const old = { ...r }; Object.assign(r, patch);
        if (r.status !== old.status) {
          r.status_since = nowIso();
          if (r.status === "free" && ["dirty", "cleaning"].includes(old.status)) r.last_cleaned = nowIso();
          if (r.status !== "occupied") r.guest = "";
          const ev = r.status === "occupied" ? "checkin" : r.status === "dirty" ? "checkout" : r.status === "cleaning" ? "start" : r.status === "free" && ["dirty", "cleaning"].includes(old.status) ? "cleaned" : "status";
          d.events.push({ id: d.events.length + 1, hotel_id: HID, room_id: id, event: ev, note: r.status === "occupied" ? r.guest : "", actor: ME.id, at: nowIso() });
        }
        r.updated_at = nowIso(); write(d); notify("rooms", "UPDATE", r, old); return { ...r };
      },
      async addIssue(_h, room_id, text) {
        const d = db(), i = { id: uid(), hotel_id: HID, room_id, text, open: true, reported_at: nowIso(), progress: "new", note: "" };
        d.issues.push(i); d.events.push({ id: d.events.length + 1, hotel_id: HID, room_id, event: "issue", note: text, actor: ME.id, at: nowIso() });
        write(d); notify("issues", "INSERT", i, null); return { ...i };
      },
      async fixIssue(id) {
        const d = db(), i = d.issues.find((x) => x.id === id); if (!i) fail("Issue not found");
        const old = { ...i }; i.open = false; i.fixed_at = nowIso();
        d.events.push({ id: d.events.length + 1, hotel_id: HID, room_id: i.room_id, event: "fixed", note: i.text, actor: ME.id, at: nowIso() });
        write(d); notify("issues", "UPDATE", i, old); return { ...i };
      },
      async updateIssue(id, patch) {
        if (patch.open === false) return this.fixIssue(id);
        const d = db(), i = d.issues.find((x) => x.id === id); if (!i) fail("Issue not found");
        const old = { ...i }; Object.assign(i, patch);
        if (i.progress !== old.progress) i.progress_at = nowIso();
        if (i.progress !== old.progress) d.events.push({ id: d.events.length + 1, hotel_id: HID, room_id: i.room_id, event: i.progress === "working" ? "mt_in" : "mt_out",
          note: i.text + (i.progress === "parts" ? " · needs a part" : i.progress === "paused" ? " · not finished" : "") + (i.note && i.progress !== "working" ? " · " + i.note : ""), actor: ME.id, at: nowIso() });
        write(d); notify("issues", "UPDATE", i, old); return { ...i };
      },
      async events(room_id) { return db().events.filter((e) => e.room_id === room_id).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20); },
      async saveSetup(_h, floors) {
        const d = db(), byNum = Object.fromEntries(d.rooms.map((r) => [r.number, r]));
        d.floors = floors.map((f) => ({ id: "f" + f.level, hotel_id: HID, level: f.level, name: f.name }));
        d.rooms = floors.flatMap((f) => f.rooms.map((r, i) => ({
          ...(byNum[r.number] || { id: "r" + r.number, status: "free", guest: "", last_cleaned: null, status_since: nowIso() }),
          hotel_id: HID, floor_id: "f" + f.level, number: r.number, position: i, type: r.type, beds: r.beds, pax: r.pax, view: r.view || "", features: r.features || [], layout: r.layout || null })));
        write(d); notify("setup", "RELOAD", null, null);
      },
      async invites() { return db().invites; },
      async createInvite(_h, r) { const d = db(), i = { code: Math.random().toString(36).slice(2, 10).toUpperCase(), hotel_id: HID, role: r, created_at: nowIso(), expires_at: new Date(Date.now() + 30 * 864e5).toISOString() }; d.invites.unshift(i); write(d); return i; },
      async deleteInvite(code) { const d = db(); d.invites = d.invites.filter((i) => i.code !== code); write(d); },
      async removeMember() {},
    };
  }

  const c = window.APP_CONFIG || {};
  // ?demo in the address opens the sample hotel even on the live site (for showing hotels a demo without an account)
  const forceDemo = /[?&]demo\b/.test(location.search);
  if (forceDemo) { window.api = DemoBackend(); return; }
  if (c.SUPABASE_URL && c.SUPABASE_ANON_KEY && !window.supabase) {
    document.addEventListener("DOMContentLoaded", () => { document.body.innerHTML = '<p style="padding:24px;font:16px system-ui">Could not load the sign-in library. Check the internet connection and reload.</p>'; });
  }
  window.api = c.SUPABASE_URL && c.SUPABASE_ANON_KEY && window.supabase ? SupabaseBackend(c.SUPABASE_URL, c.SUPABASE_ANON_KEY) : DemoBackend();
})();
