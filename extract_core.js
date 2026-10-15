// Bibliothèque d'extraction injectée dans chaque page (Playwright page.evaluate).
// Expose window.__FS avec des helpers génériques : tables, périodes FR/EN, sélection du taux courant.
(() => {
  const MONTHS = {
    janvier: 1, jan: 1, january: 1, janv: 1,
    fevrier: 2, février: 2, fevr: 2, févr: 2, feb: 2, february: 2,
    mars: 3, march: 3, mar: 3,
    avril: 4, april: 4, avr: 4, apr: 4,
    mai: 5, may: 5,
    juin: 6, june: 6, jun: 6,
    juillet: 7, july: 7, juil: 7, jul: 7,
    aout: 8, août: 8, august: 8, aug: 8,
    septembre: 9, september: 9, sept: 9, sep: 9,
    octobre: 10, october: 10, oct: 10,
    novembre: 11, november: 11, nov: 11,
    decembre: 12, décembre: 12, december: 12, dec: 12, déc: 12,
  };
  const norm = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  // "53,50 %" / "49.75%" / "23:15%" -> 53.5 ; "1,00 €/kg" -> {value:1, unit:'€/kg'}
  function parseValue(s) {
    s = norm(s);
    let m = s.match(/(-?\d+(?:[.,:]\d+)?)\s*%/);
    if (m) return { value: parseFloat(m[1].replace(/[,:]/, '.')), unit: '%' };
    m = s.match(/(-?\d+(?:[.,]\d+)?)\s*(€|eur)\s*\/\s*kg/i);
    if (m) return { value: parseFloat(m[1].replace(',', '.')), unit: '€/kg' };
    return null;
  }

  const ymd = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  // Parse un libellé de période -> {start: Date, end: Date|null, kind}
  function parsePeriod(label) {
    const s = norm(label).toLowerCase();
    // dates numériques dd/mm/yyyy ou dd.mm.yyyy
    const num = [...s.matchAll(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/g)].map((m) => ymd(+m[3], +m[2], +m[1]));
    if (num.length) return { start: num[0], end: num[1] || null, kind: num[1] ? 'range' : 'start' };

    const years = [...s.matchAll(/\b(20\d{2})\b/g)].map((m) => +m[1]);
    const year = years.length ? years[years.length - 1] : new Date().getUTCFullYear();
    const toks = [...s.replace(/\b20\d{2}\b/g, ' ').matchAll(/([a-zéûôà]+)|(\d{1,2})/g)];
    const seq = [];
    for (const t of toks) {
      if (t[1] && MONTHS[t[1]] !== undefined) seq.push({ m: MONTHS[t[1]] });
      else if (t[2]) seq.push({ d: +t[2] });
    }
    const monthsOnly = seq.filter((x) => x.m);
    if (!monthsOnly.length) return null;
    const days = seq.filter((x) => x.d);
    if (!days.length) {
      const m = monthsOnly[0].m;
      const y = years[0] || year;
      return { start: ymd(y, m, 1), end: ymd(y, m, lastDay(y, m)), kind: 'month' };
    }
    const monthFirst = seq[0].m !== undefined;
    const pts = [];
    if (monthFirst) {
      let cur = null;
      for (const x of seq) { if (x.m) cur = x.m; else pts.push({ m: cur, d: x.d }); }
    } else {
      let pending = [];
      for (const x of seq) {
        if (x.d) pending.push(x.d);
        else { pending.forEach((d) => pts.push({ m: x.m, d })); pending = []; }
      }
      const lastM = monthsOnly[monthsOnly.length - 1].m;
      pending.forEach((d) => pts.push({ m: lastM, d }));
    }
    let a = pts[0], b = pts[1];
    let start = ymd(year, a.m, a.d);
    let end = b ? ymd(year, b.m, b.d) : null;
    if (end && end < start) start = ymd(year - 1, a.m, a.d);
    return { start, end, kind: end ? 'range' : 'start' };
  }

  // Toutes les tables -> [{el, heading, header:[..], rows:[[..]]}]
  function headingBefore(el) {
    const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,strong,b,p.title,.title,[class*=heading],[class*=title]')];
    let best = '';
    for (const h of hs) {
      if (h.contains(el) || el.contains(h)) continue;
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const t = norm(h.innerText);
        if (t && t.length < 200) best = t;
      }
    }
    return best;
  }
  function tables() {
    return [...document.querySelectorAll('table')].map((t) => {
      const rows = [...t.rows].map((r) => [...r.cells].map((c) => norm(c.innerText)));
      return { el: t, heading: headingBefore(t), header: rows[0] || [], rows: rows.slice(1) };
    });
  }

  // Convertit une table en série [{period, start, end, value, unit}] (colonne période + colonne valeur)
  function series(tbl, valueCol = null, periodCol = null) {
    const out = [];
    const allRows = [tbl.header, ...tbl.rows];
    for (const r of allRows) {
      if (r.length < 2) continue;
      let pc = periodCol, vc = valueCol;
      if (pc === null) pc = r.findIndex((c) => parsePeriod(c) && !parseValue(c));
      if (vc === null) vc = r.findIndex((c, i) => i !== pc && parseValue(c));
      if (pc < 0 || vc < 0 || !r[pc] || !r[vc]) continue;
      const p = parsePeriod(r[pc]);
      const v = parseValue(r[vc]);
      if (!p || !v) continue;
      out.push({ period: r[pc], start: p.start, end: p.end, kind: p.kind, value: v.value, unit: v.unit });
    }
    return out;
  }

  // Série d'une colonne précise (période en colonne pc). bare=true accepte un nombre sans "%".
  function colSeries(tbl, col, { pc = 0, bare = false, unit = '%' } = {}) {
    const out = [];
    for (const r of [tbl.header, ...tbl.rows]) {
      if (r.length <= Math.max(col, pc)) continue;
      const p = parsePeriod(r[pc]);
      if (!p) continue;
      let v = parseValue(r[col]);
      if (!v && bare) {
        const m = norm(r[col]).match(/^(\d+(?:[.,]\d+)?)$/);
        if (m) v = { value: parseFloat(m[1].replace(',', '.')), unit };
      }
      if (!v) continue;
      out.push({ period: r[pc], start: p.start, end: p.end, kind: p.kind, value: v.value, unit: v.unit });
    }
    return out;
  }

  // Une table "période | col1 | col2 ..." -> une série par colonne de valeurs.
  function multiSeries(tbl, opts = {}) {
    const n = Math.max(...[tbl.header, ...tbl.rows].map((r) => r.length));
    const res = [];
    for (let c = 1; c < n; c++) {
      const s = colSeries(tbl, c, opts);
      if (s.length) res.push({ label: norm(tbl.header[c] || 'Col ' + c), data: s });
    }
    return res;
  }

  // Table transposée : en-tête = mois, lignes = services.
  function transposedSeries(tbl) {
    const res = [];
    const hdrP = tbl.header.map((h) => parsePeriod(h));
    if (hdrP.filter(Boolean).length < 1) return res;
    for (const r of tbl.rows) {
      const data = [];
      r.forEach((cell, i) => {
        const p = hdrP[i];
        const v = parseValue(cell);
        if (p && v) data.push({ period: tbl.header[i], start: p.start, end: p.end, kind: p.kind, value: v.value, unit: v.unit });
      });
      if (data.length) res.push({ label: norm(r[0]), data });
    }
    return res;
  }

  // Extraction par regex dans le texte : groupes (période, valeur)
  function textSeries(re, text) {
    text = norm(text || document.body.textContent);
    const out = [];
    const seen = new Set();
    for (const m of text.matchAll(re)) {
      const p = parsePeriod(m[1]);
      const v = parseValue(m[2] + '%');
      if (!p || !v) continue;
      const k = p.start.getTime();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ period: norm(m[1]), start: p.start, end: p.end, kind: p.kind, value: v.value, unit: v.unit });
    }
    return out;
  }

  const MONTH_RE = '(?:janv(?:ier)?|f[ée]vr(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|sept(?:embre)?|oct(?:obre)?|nov(?:embre)?|d[ée]c(?:embre)?|january|february|march|april|may|june|july|august|september|october|november|december)';

  // Choisit le taux en vigueur (période contenant aujourd'hui) + le prochain s'il est publié.
  function pick(ser, today = new Date()) {
    if (!ser.length) return null;
    const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const items = ser.map((x) => ({ ...x })).sort((a, b) => a.start - b.start);
    // compléter les fins manquantes avec le début suivant - 1 jour
    items.forEach((x, i) => {
      if (!x.end) x.end = items[i + 1] ? new Date(items[i + 1].start - 86400000) : null;
    });
    // dernière ligne hebdo sans fin : start + 6 jours
    const last = items[items.length - 1];
    if (last && !last.end && items.length > 1 && last.start - items[items.length - 2].start <= 8 * 86400000) {
      last.end = new Date(+last.start + 6 * 86400000);
    }
    let current = items.filter((x) => x.start <= t && (!x.end || t <= x.end)).pop();
    if (!current) current = items.filter((x) => x.start <= t).pop() || items[0];
    const next = items.find((x) => x.start > t) || null;
    const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    const fmt = (x) => x && ({ period: x.period, start: iso(x.start), end: iso(x.end), value: x.value, unit: x.unit });
    return {
      current: fmt(current),
      next: fmt(next),
      history: items.map(fmt),
    };
  }

  // Trouve une table dont l'en-tête/heading/contenu matche une regex.
  function findTables(re) {
    return tables().filter((t) => re.test(t.heading + ' ' + t.header.join(' ')));
  }
  function periodTables() {
    return tables().filter((t) => series(t).length >= 1);
  }

  // Construit un bloc résultat {key,label,unit,current,next,history}
  function out(label, data, extra = {}) {
    const p = pick(data);
    if (!p) return null;
    return { label, unit: p.current.unit, ...p, ...extra };
  }
  // Fusionne plusieurs séries (même indicateur réparti sur plusieurs tables), dédoublonnage par date de début
  function merge(...lists) {
    const m = new Map();
    lists.flat().forEach((x) => { if (!m.has(+x.start)) m.set(+x.start, x); });
    return [...m.values()];
  }

  window.__FS = { norm, parseValue, parsePeriod, tables, series, colSeries, multiSeries, transposedSeries,
    textSeries, MONTH_RE, pick, out, merge, findTables, periodTables, MONTHS };
})();
