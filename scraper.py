"""
Scraper des surcharges carburant.

Ouvre chaque page source dans un vrai navigateur (Playwright : Edge / Chrome / Chromium),
injecte extract_core.js + extractors.js et récupère les taux en JSON.

Utilisation autonome :  python scraper.py            (écrit data/latest.json + data/history.json)
                        python scraper.py dhl ups    (seulement certaines sources)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime, date
from pathlib import Path

from playwright.async_api import async_playwright, TimeoutError as PWTimeout

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
LATEST = DATA / "latest.json"
HISTORY = DATA / "history.json"
STATUS = DATA / "status.json"

JS = (ROOT / "extract_core.js").read_text(encoding="utf-8") + "\n" + (ROOT / "extractors.js").read_text(encoding="utf-8")

# id, nom affiché, type, url, attente supplémentaire (s) pour le rendu JS
SOURCES = [
    {"id": "brent", "name": "Brent", "kind": "index", "freq": "temps réel",
     "url": "https://prixdubaril.com/", "wait": 1},
    {"id": "dhl", "name": "DHL Express", "kind": "express", "freq": "hebdo",
     "url": "https://mydhl.express.dhl/fr/fr/ship/surcharges.html#/fuel_surcharge", "wait": 3},
    {"id": "fedex", "name": "FedEx", "kind": "express", "freq": "hebdo / mensuel",
     "url": "https://www.fedex.com/fr-fr/shipping/surcharges.html", "wait": 4},
    {"id": "ups", "name": "UPS", "kind": "express", "freq": "hebdo",
     "url": "https://www.ups.com/fr/fr/support/shipping-support/shipping-costs-rates/fuel-surcharges", "wait": 4},
    {"id": "dpd", "name": "DPD France", "kind": "messagerie", "freq": "mensuel",
     "url": "https://www.dpd.com/fr/fr/fuel-surcharge/", "wait": 1},
    {"id": "chronopost", "name": "Chronopost", "kind": "messagerie", "freq": "mensuel",
     "url": "https://www.chronopost.fr/fr/surcharge-carburant", "wait": 1},
    {"id": "gls", "name": "GLS France", "kind": "messagerie", "freq": "mensuel",
     "url": "https://gls-group.com/FR/en/newsroom/fuel-surcharge/", "wait": 1},
    {"id": "geodis", "name": "GEODIS", "kind": "messagerie", "freq": "mensuel",
     "url": "https://geodis.com/fr/transport-de-marchandises/transport-de-colis-et-de-palettes/taux-de-surcharge-energie", "wait": 1},
    {"id": "colissimo", "name": "Colissimo", "kind": "messagerie", "freq": "mensuel",
     "url": "https://www.colissimo.entreprise.laposte.fr/offres-et-services/tarifs-generaux/supplements-tarifaires-colissimo", "wait": 1},
    {"id": "tnt", "name": "TNT", "kind": "express", "freq": "hebdo / mensuel",
     "url": "https://www.tnt.com/express/fr_fr/site/comment/facturation/comprendre-votre-facture/baremes-et-historiques.html#cms-dt-1=0", "wait": 2},
    {"id": "colisprive", "name": "Colis Privé", "kind": "messagerie", "freq": "mensuel",
     "url": "https://colisprive.fr/tgo/", "wait": 1},
    {"id": "dsv", "name": "DSV XPress", "kind": "express", "freq": "hebdo",
     "url": "https://www.dsv.com/fr-fr/nos-solutions/modes-de-transport/envois-xpress/surcharge-carburant-et-zone-eloignees", "wait": 2},
    {"id": "martelet", "name": "Régis Martelet", "kind": "messagerie", "freq": "mensuel",
     "url": "https://www.martelet.fr/espace-clients/taxe-gasoil.php", "wait": 1},
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
HEADLESS = os.environ.get("HEADLESS", "1") != "0"
CONCURRENCY = int(os.environ.get("CONCURRENCY", "4"))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


async def launch(pw):
    """Essaie Edge puis Chrome installés (moins détectés), sinon le Chromium de Playwright."""
    args = ["--disable-blink-features=AutomationControlled"]
    for channel in ("msedge", "chrome", None):
        try:
            kw = {"headless": HEADLESS, "args": args}
            if channel:
                kw["channel"] = channel
            b = await pw.chromium.launch(**kw)
            log("Navigateur :", channel or "chromium (playwright)")
            return b
        except Exception as e:  # navigateur absent
            log("  ", channel or "chromium", "indisponible :", str(e).splitlines()[0][:120])
    raise RuntimeError("Aucun navigateur disponible. Lancez : python -m playwright install chromium")


async def scrape_one(context, src, sem):
    async with sem:
        t0 = time.time()
        page = await context.new_page()
        res = {"id": src["id"], "ok": False, "series": [], "info": None, "error": None}
        try:
            await page.goto(src["url"], wait_until="domcontentloaded", timeout=60000)
            try:
                await page.wait_for_load_state("networkidle", timeout=15000)
            except PWTimeout:
                pass
            await page.wait_for_timeout(src.get("wait", 1) * 1000)
            out = None
            for attempt in range(4):  # contenus chargés tardivement en JS
                await page.evaluate(JS)  # évite le CSP (pas de <script> injecté)
                out = await page.evaluate(f"window.__EXTRACT[{json.dumps(src['id'])}]()")
                if out and out.get("series"):
                    break
                await page.wait_for_timeout(3000)
            res["series"] = (out or {}).get("series", [])
            res["info"] = (out or {}).get("info")
            res["ok"] = bool(res["series"])
            if not res["ok"]:
                title = await page.title()
                res["error"] = f"Aucune donnée trouvée (page : « {title[:80]} »). Structure du site modifiée ou blocage anti-robot."
        except Exception as e:
            res["error"] = f"{type(e).__name__}: {str(e).splitlines()[0][:200]}"
        finally:
            await page.close()
        res["duration_s"] = round(time.time() - t0, 1)
        log(f"{src['id']:<11} {'OK ' if res['ok'] else 'ERR'} {res['duration_s']:>5}s",
            " | ".join(f"{s['label']}={s['current']['value']}{s['unit']}" for s in res["series"]) or res["error"])
        return res


def update_history(results, now_iso):
    """Historique cumulatif : site + dates de scraping, pour garder plus que ce que les sites affichent."""
    hist = json.loads(HISTORY.read_text(encoding="utf-8")) if HISTORY.exists() else {}
    today = date.today().isoformat()
    for r in results:
        for s in r["series"]:
            key = f"{r['id']}|{s['label']}"
            h = hist.setdefault(key, {})
            for p in s.get("history") or []:
                h[p["start"]] = {"v": p["value"], "p": p["period"]}
            if r["id"] == "brent":  # cours du jour : un point par date de scraping
                h[today] = {"v": s["current"]["value"], "p": today}
            elif s.get("current"):
                c = s["current"]
                h[c["start"]] = {"v": c["value"], "p": c["period"]}
    HISTORY.write_text(json.dumps(hist, ensure_ascii=False, indent=0), encoding="utf-8")
    return hist


def write_status(**kw):
    STATUS.write_text(json.dumps(kw, ensure_ascii=False), encoding="utf-8")


async def main(only=None):
    srcs = [s for s in SOURCES if not only or s["id"] in only]
    started = datetime.now().isoformat(timespec="seconds")
    write_status(running=True, started=started, pid=os.getpid())
    try:
        async with async_playwright() as pw:
            browser = await launch(pw)
            context = await browser.new_context(
                user_agent=UA, locale="fr-FR", timezone_id="Europe/Paris",
                viewport={"width": 1366, "height": 900},
                extra_http_headers={"Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"},
            )
            await context.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
            sem = asyncio.Semaphore(CONCURRENCY)
            results = await asyncio.gather(*(scrape_one(context, s, sem) for s in srcs))
            await browser.close()

        # fusion avec l'existant si scraping partiel ou source en erreur (on garde la dernière bonne valeur)
        prev = json.loads(LATEST.read_text(encoding="utf-8")) if LATEST.exists() else {}
        prev_by_id = {r["id"]: r for r in prev.get("results", [])}
        now = datetime.now().isoformat(timespec="seconds")
        merged = []
        new_by_id = {r["id"]: r for r in results}
        for s in SOURCES:
            r = new_by_id.get(s["id"])
            if r is None:
                r = prev_by_id.get(s["id"])
                if r is None:
                    continue
            else:
                r["scraped_at"] = now
                if not r["ok"] and prev_by_id.get(s["id"], {}).get("ok"):
                    old = prev_by_id[s["id"]]
                    r["series"], r["info"] = old["series"], old.get("info")
                    r["stale_since"] = old.get("scraped_at")
            merged.append({**{k: s[k] for k in ("id", "name", "kind", "freq", "url")}, **r})

        update_history(results, now)
        LATEST.write_text(json.dumps({"updated_at": now, "results": merged}, ensure_ascii=False, indent=1), encoding="utf-8")
        ok = sum(r["ok"] for r in results)
        log(f"Terminé : {ok}/{len(results)} sources OK -> {LATEST}")
    finally:
        write_status(running=False, started=started, finished=datetime.now().isoformat(timespec="seconds"))


if __name__ == "__main__":
    asyncio.run(main(set(sys.argv[1:]) or None))
