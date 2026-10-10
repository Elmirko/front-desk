// Shared vocabulary + apartment schematics (used by the main app and the staff apps)
(function () {
  const TY = { sgl: "Single", dbl: "Double", twn: "Twin", tpl: "Triple", fam: "Family", ste: "Suite", stu: "Studio", ap1: "1-bedroom apartment", ap2: "2-bedroom apartment", ap3: "3-bedroom apartment" };
  const BEDS = { sgl: 1, dbl: 1, twn: 2, tpl: 3, fam: 3, ste: 2, stu: 1, ap1: 2, ap2: 3, ap3: 5 };
  const PAX = { sgl: 1, dbl: 2, twn: 2, tpl: 3, fam: 4, ste: 4, stu: 2, ap1: 4, ap2: 5, ap3: 8 };
  const BEDROOMS = { stu: 0, ap1: 1, ap2: 2, ap3: 3 };
  const BEDDESC = { sgl: "1 single", dbl: "1 king", twn: "2 singles", tpl: "3 singles", fam: "1 king + 2 singles", ste: "1 king + sofa bed",
    stu: "1 queen + kitchenette", ap1: "1 king + sofa bed", ap2: "1 king + 2 singles + sofa bed", ap3: "2 kings + 2 singles + sofa bed" };
  const isApt = (ty) => /^(stu|ap\d)$/.test(ty);
  // other spaces: not sold, but cleaned, repaired and shown on the plan
  const SPACES = { conf: "Conference room", meet: "Meeting room", rest: "Restaurant", bar: "Bar", kit: "Kitchen", spa: "Spa", gym: "Gym", pool: "Pool",
    laun: "Laundry", stor: "Storage", staff: "Staff room", office: "Office", tech: "Technical room", lobby: "Lobby", wc: "Public restroom", park: "Parking" };
  const STAFF_ONLY = new Set(["kit", "laun", "stor", "staff", "office", "tech"]);
  const isSpace = (ty) => !!SPACES[ty];
  Object.assign(TY, SPACES);
  Object.keys(SPACES).forEach((k) => { BEDS[k] = 0; PAX[k] = 1; BEDDESC[k] = STAFF_ONLY.has(k) ? "staff only" : "guest area"; });

  // Floor-plan templates for apartments. Units: 100 wide × 64 deep. k = bed | living | kitchen | bath | entry
  const LAYOUTS = {
    stu: [{ k: "living", l: "Studio", d: "Queen bed · sofa", x: 0, y: 0, w: 64, h: 64 }, { k: "kitchen", l: "Kitchenette", d: "", x: 64, y: 0, w: 36, h: 26 },
          { k: "bath", l: "Bath", d: "Shower", x: 64, y: 26, w: 36, h: 22 }, { k: "entry", l: "Entry", d: "", x: 64, y: 48, w: 36, h: 16 }],
    ap1: [{ k: "bed", l: "Bedroom", d: "King bed", x: 0, y: 0, w: 40, h: 38 }, { k: "living", l: "Living room", d: "Sofa bed", x: 40, y: 0, w: 60, h: 38 },
          { k: "bath", l: "Bath", d: "Shower", x: 0, y: 38, w: 28, h: 26 }, { k: "entry", l: "Entry", d: "", x: 28, y: 38, w: 32, h: 26 }, { k: "kitchen", l: "Kitchen", d: "Dining for 4", x: 60, y: 38, w: 40, h: 26 }],
    ap2: [{ k: "bed", l: "Bedroom 1", d: "King bed", x: 0, y: 0, w: 34, h: 36 }, { k: "bed", l: "Bedroom 2", d: "2 singles", x: 34, y: 0, w: 32, h: 36 },
          { k: "living", l: "Living room", d: "Sofa bed", x: 66, y: 0, w: 34, h: 36 }, { k: "bath", l: "Bath", d: "Tub", x: 0, y: 36, w: 24, h: 28 },
          { k: "entry", l: "Entry", d: "", x: 24, y: 36, w: 22, h: 28 }, { k: "kitchen", l: "Kitchen", d: "Dining for 6", x: 46, y: 36, w: 54, h: 28 }],
    ap3: [{ k: "bed", l: "Bedroom 1", d: "King bed", x: 0, y: 0, w: 30, h: 34 }, { k: "bed", l: "Bedroom 2", d: "King bed", x: 30, y: 0, w: 26, h: 34 },
          { k: "bed", l: "Bedroom 3", d: "2 singles", x: 56, y: 0, w: 22, h: 34 }, { k: "bath", l: "Bath 1", d: "Tub", x: 78, y: 0, w: 22, h: 34 },
          { k: "living", l: "Living room", d: "Sofa bed", x: 0, y: 34, w: 46, h: 30 }, { k: "kitchen", l: "Kitchen", d: "Dining for 8", x: 46, y: 34, w: 30, h: 30 },
          { k: "bath", l: "Bath 2", d: "Shower", x: 76, y: 34, w: 24, h: 16 }, { k: "entry", l: "Entry", d: "", x: 76, y: 50, w: 24, h: 14 }],
  };
  const layoutOf = (r) => (r.layout && r.layout.length ? r.layout : LAYOUTS[r.ty || r.type] || null);

  // little furniture glyphs, drawn inside each space
  function glyph(s) {
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2 + 3;
    if (s.k === "bed") { const two = /2 singles/.test(s.d); return two
      ? `<rect class="fx" x="${cx - 9}" y="${cy - 5}" width="7" height="11" rx="1"/><rect class="fx" x="${cx + 2}" y="${cy - 5}" width="7" height="11" rx="1"/>`
      : `<rect class="fx" x="${cx - 7}" y="${cy - 6}" width="14" height="12" rx="1.2"/><line class="fx" x1="${cx - 7}" y1="${cy - 2.5}" x2="${cx + 7}" y2="${cy - 2.5}"/>`; }
    if (s.k === "living") return `<rect class="fx" x="${cx - 10}" y="${cy - 3}" width="20" height="6" rx="1.5"/><rect class="fx" x="${cx - 4}" y="${cy + 5}" width="8" height="4" rx="1"/>`;
    if (s.k === "kitchen") return `<rect class="fx" x="${s.x + 2}" y="${s.y + s.h - 6}" width="${s.w - 4}" height="4"/><circle class="fx" cx="${cx}" cy="${cy}" r="3.5"/>`;
    if (s.k === "bath") return /Tub/.test(s.d) ? `<rect class="fx" x="${cx - 6}" y="${cy - 3}" width="12" height="6" rx="3"/>` : `<rect class="fx" x="${cx - 4}" y="${cy - 4}" width="8" height="8"/><line class="fx" x1="${cx - 4}" y1="${cy - 4}" x2="${cx + 4}" y2="${cy + 4}"/>`;
    return "";
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function schematic(r, big) {
    const L = layoutOf(r); if (!L) return "";
    const balcony = r.feat ? r.feat.has("balcony") : (r.features || []).includes("balcony"), H = balcony ? 74 : 64;
    let g = L.map((s) => `<g class="sp sp-${s.k}"><rect x="${s.x + 0.6}" y="${s.y + 0.6}" width="${s.w - 1.2}" height="${s.h - 1.2}" rx="1.4"/>${glyph(s)}
      <text x="${s.x + 2.4}" y="${s.y + 5.4}" class="t1">${esc(s.l)}</text>${big && s.d ? `<text x="${s.x + 2.4}" y="${s.y + 9.6}" class="t2">${esc(s.d)}</text>` : ""}</g>`).join("");
    if (balcony) g += `<g class="sp sp-balcony"><rect x="0.6" y="64.6" width="98.8" height="8.8" rx="1.4"/><text x="3" y="70.6" class="t1">Balcony</text></g>`;
    // door gap at the entry
    const e = L.find((s) => s.k === "entry"); if (e) g += `<line class="door" x1="${e.x + e.w / 2 - 4}" y1="${e.y + e.h - 0.4}" x2="${e.x + e.w / 2 + 4}" y2="${e.y + e.h - 0.4}"/>`;
    return `<svg class="schem ${big ? "big" : ""}" viewBox="-1 -1 102 ${H + 2}" role="img" aria-label="Floor plan of ${esc(TY[r.ty || r.type])}">${g}</svg>`;
  }
  window.SH = { TY, BEDS, PAX, BEDROOMS, BEDDESC, LAYOUTS, isApt, SPACES, STAFF_ONLY, isSpace, layoutOf, schematic, esc };
})();
