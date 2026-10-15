// Un extracteur par source. Chaque fonction s'exécute DANS la page (après extract_core.js)
// et renvoie { series: [ {label, unit, current, next, history} ], info?: {...} }.
(() => {
  const F = window.__FS;
  const clean = (arr) => arr.filter(Boolean);
  const M = F.MONTH_RE;

  const E = {
    // ---------------------------------------------------------------- BRENT
    brent() {
      const num = (s) => (s ? parseFloat(String(s).replace(/\s/g, '').replace(',', '.')) : null);
      const read = (k) => {
        const d = document.querySelector(`.pdb-hero-item--${k} data, #${k} data`);
        return d ? num(d.getAttribute('value') || d.textContent) : null;
      };
      let brent = read('brent');
      const text = F.norm(document.body.innerText);
      if (brent == null) {
        const m = text.match(/Brent[^$]{0,80}?(\d{2,3}[,.]\d{2})\s*\$/i);
        brent = m ? num(m[1]) : null;
      }
      const wti = read('wti');
      const eur = num(document.querySelector('.pdb-hero-item--brent .pdb-hero-eur__seg--baril b')?.textContent);
      const varM = text.match(/BRENT[^▲▼]{0,80}([▲▼])\s*([\d,]+)\s*\$\s*([+-]?[\d,]+)%/i);
      const dateM = text.match(/((?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+\d{1,2}\s+\S+\s+\d{4}\s*·\s*\d{1,2}:\d{2})/i);
      const today = new Date().toISOString().slice(0, 10);
      const mk = (label, v, unit) => v == null ? null : ({
        label, unit, current: { period: dateM ? dateM[1] : today, start: today, end: today, value: v, unit }, next: null, history: [],
      });
      return {
        series: clean([mk('Brent ($/baril)', brent, '$'), mk('Brent (€/baril)', eur, '€'), mk('WTI ($/baril)', wti, '$')]),
        info: { variation: varM ? (varM[1] === '▼' ? '-' : '+') + varM[3].replace(/^[+-]/, '') + ' %' : null },
      };
    },

    // ---------------------------------------------------------------- DHL
    dhl() {
      const pts = F.periodTables().filter((t) => /entr[ée]e en vigueur|effective/i.test(t.header.join(' ')));
      const res = pts.map((t, i) => {
        const day = /day definite|intra-europe|europe/i.test(t.heading) || i === 1;
        return F.out(day ? 'Day Definite Intra-Europe' : 'Time Definite (national & international)', F.series(t));
      });
      return { series: clean(res) };
    },

    // ---------------------------------------------------------------- FEDEX
    fedex() {
      const groups = { intl: [], regional: [], national: [], freight: [] };
      for (const t of F.periodTables()) {
        const s = F.series(t);
        if (!s.length) continue;
        const hdr = t.header.join(' ');
        if (s[0].unit === '€/kg') groups.freight.push(s);
        else if (/USGC/i.test(hdr)) groups.intl.push(s);
        else if (s.every((x) => x.kind === 'month')) groups.national.push(s);
        else groups.regional.push(s);
      }
      return {
        series: clean([
          groups.intl.length && F.out('International Express', F.merge(...groups.intl)),
          groups.regional.length && F.out('Regional Economy (Europe)', F.merge(...groups.regional)),
          groups.national.length && F.out('National (France)', F.merge(...groups.national)),
          groups.freight.length && F.out('Fret IXF / ATA', F.merge(...groups.freight)),
        ]),
      };
    },

    // ---------------------------------------------------------------- UPS
    ups() {
      const t = F.periodTables().find((x) => /dates? d.effet|effective/i.test(x.header.join(' ')));
      if (!t) return { series: [] };
      const labels = [/standard/i, /au sein de l.ue|within the eu/i, /en dehors|outside/i];
      const names = ['Standard', 'Express UE', 'Express & Expedited hors UE'];
      return {
        series: clean(F.multiSeries(t).map((s) => {
          const i = labels.findIndex((re) => re.test(s.label));
          return F.out(i >= 0 ? names[i] : s.label, s.data);
        })),
      };
    },

    // ---------------------------------------------------------------- DPD
    dpd() {
      const t = F.periodTables().find((x) => /routier|a[ée]rien/i.test(x.header.join(' ')));
      if (!t) return { series: [] };
      return {
        series: clean(F.multiSeries(t).map((s) =>
          F.out(/a[ée]rien/i.test(s.label) ? 'Aérien (intercontinental)' : 'Routier (Classic, Predict, Relais)', s.data))),
      };
    },

    // ---------------------------------------------------------------- CHRONOPOST
    chronopost() {
      const all = F.tables();
      const road = [], air = [];
      for (const t of all) {
        // tableau transposé (en-tête = mois)
        for (const s of F.transposedSeries(t)) {
          if (/a[ée]rien|international/i.test(s.label)) air.push(s.data);
          else if (/routier|national/i.test(s.label)) road.push(s.data);
        }
        // historique : Mois | Taux routier | Taux aérien
        if (/taux routier|taux a[ée]rien/i.test(t.header.join(' '))) {
          for (const s of F.multiSeries(t)) (/a[ée]rien/i.test(s.label) ? air : road).push(s.data);
        }
      }
      return {
        series: clean([
          road.length && F.out('Routier (national + Chrono Classic)', F.merge(...road)),
          air.length && F.out('Aérien (international)', F.merge(...air)),
        ]),
      };
    },

    // ---------------------------------------------------------------- GLS
    gls() {
      let data = [];
      const t = F.tables().find((x) => /surcharge/i.test(x.header.join(' ')) && /month|mois/i.test(x.header.join(' ')));
      if (t) data = F.colSeries(t, 1, { bare: true });
      const txt = F.textSeries(new RegExp(`surcharge for (${M}\\s+\\d{4}) is set at\\s*(\\d+[.,]\\d+)\\s*%`, 'gi'));
      data = F.merge(data, txt);
      return { series: clean([F.out('Diesel surcharge (France)', data)]) };
    },

    // ---------------------------------------------------------------- GEODIS
    geodis() {
      const gen = F.textSeries(new RegExp(`Taux g[ée]n[ée]ral\\s+(${M}\\s+\\d{4})\\s*:?\\s*(\\d+[.,]\\d+)\\s*%`, 'gi'));
      const aff = F.textSeries(new RegExp(`affr[eè]tement\\s+(${M}\\s+\\d{4})\\s*:?\\s*(\\d+[.,]\\d+)\\s*%`, 'gi'));
      return {
        series: clean([F.out('Taux général (messagerie & express)', gen), F.out('Affrètement', aff)]),
      };
    },

    // ---------------------------------------------------------------- COLISSIMO
    colissimo() {
      const t = F.periodTables().find((x) => /CAE/i.test(x.header.join(' ')));
      if (!t) return { series: [] };
      return {
        series: clean(F.multiSeries(t).map((s) =>
          F.out(/a[ée]rien/i.test(s.label) ? 'CAE aérien' : 'CAE routier', s.data))),
      };
    },

    // ---------------------------------------------------------------- TNT
    tnt() {
      const t = F.periodTables().find((x) => /semaine|week/i.test(x.header.join(' ')));
      const intl = t ? F.series(t) : [];
      const dom = F.textSeries(new RegExp(`Surcharge de\\s+(${M}\\s+\\d{4})\\s*:\\s*(\\d+[.,:]\\d+)\\s*%`, 'gi'));
      return {
        series: clean([F.out('International Express (tous services)', intl), F.out('National (France)', dom)]),
      };
    },

    // ---------------------------------------------------------------- COLIS PRIVE
    colisprive() {
      let data = [...document.querySelectorAll('.liste-cap-mensuel > div')].map((d) => {
        const lab = F.norm(d.querySelector('strong')?.textContent);
        const p = F.parsePeriod(lab);
        const v = F.parseValue(d.querySelector('span')?.textContent);
        return p && v ? { period: lab, start: p.start, end: p.end, kind: p.kind, value: v.value, unit: v.unit } : null;
      }).filter(Boolean);
      if (!data.length) {
        data = F.textSeries(new RegExp(`(${M}\\s+\\d{4})\\s*:?\\s*(\\d+[.,]\\d+)\\s*%`, 'gi'), document.body.innerText);
      }
      return { series: clean([F.out('CAP routier', data)]), info: { note: 'Barème du mois M = indice CNR de M-2' } };
    },

    // ---------------------------------------------------------------- DSV
    dsv() {
      const t = F.periodTables().find((x) => /p[ée]riode/i.test(x.header.join(' ')) && /xpress/i.test(x.header.join(' ')));
      if (!t) return { series: [] };
      return { series: clean(F.multiSeries(t).map((s) => F.out(s.label, s.data))) };
    },

    // ---------------------------------------------------------------- REGIS MARTELET
    martelet() {
      const data = F.textSeries(new RegExp(`gasoil\\s*[-–:]\\s*(${M}\\s+\\d{4})\\s*:\\s*(\\d+[.,]\\d+)\\s*%`, 'gi'));
      const hist = [...document.querySelectorAll('a')].find((a) => /historique.*\.xlsx/i.test(a.href));
      return { series: clean([F.out('Surcharge gasoil', data)]), info: { history_xlsx: hist ? hist.href : null } };
    },
  };

  window.__EXTRACT = E;
})();
