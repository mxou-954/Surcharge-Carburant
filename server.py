"""
Dashboard surcharges carburant — serveur local (bibliothèque standard uniquement).

    python server.py              -> http://localhost:8050
Variables : PORT (8050), REFRESH_HOURS (6), HEADLESS (1), OPEN_BROWSER (1), SCRAPE_ON_START (1)
"""
from __future__ import annotations

import csv
import io
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
LATEST, HISTORY, STATUS = DATA / "latest.json", DATA / "history.json", DATA / "status.json"
INDEX = ROOT / "static" / "index.html"

PORT = int(os.environ.get("PORT", "8050"))
REFRESH_HOURS = float(os.environ.get("REFRESH_HOURS", "6"))

_lock = threading.Lock()
_proc: subprocess.Popen | None = None


def read_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def running() -> bool:
    return _proc is not None and _proc.poll() is None


def start_scrape(only: list[str] | None = None) -> bool:
    global _proc
    with _lock:
        if running():
            return False
        log = open(DATA / "scraper.log", "w", encoding="utf-8")
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        _proc = subprocess.Popen([sys.executable, "-u", str(ROOT / "scraper.py"), *(only or [])],
                                 cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=env)
        return True


def age_hours() -> float:
    d = read_json(LATEST, {})
    try:
        return (datetime.now() - datetime.fromisoformat(d["updated_at"])).total_seconds() / 3600
    except Exception:
        return 1e9


def scheduler():
    if os.environ.get("SCRAPE_ON_START", "1") == "1":
        start_scrape()
        time.sleep(300)
    while True:
        if age_hours() >= REFRESH_HOURS and not running():
            start_scrape()
        time.sleep(300)


def payload():
    d = read_json(LATEST, {"updated_at": None, "results": []})
    d["history"] = read_json(HISTORY, {})
    d["running"] = running()
    d["refresh_hours"] = REFRESH_HOURS
    return d


def to_csv() -> str:
    d = read_json(LATEST, {"results": []})
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Transporteur", "Indicateur", "Valeur", "Unité", "Période en vigueur", "Début", "Fin",
                "Prochaine valeur", "Prochaine période", "Source", "Mis à jour"])
    for r in d["results"]:
        for s in r.get("series", []):
            c, n = s.get("current") or {}, s.get("next") or {}
            w.writerow([r["name"], s["label"], str(c.get("value", "")).replace(".", ","), s.get("unit"),
                        c.get("period"), c.get("start"), c.get("end"),
                        str(n.get("value", "")).replace(".", ","), n.get("period", ""), r["url"], r.get("scraped_at")])
    return "﻿" + buf.getvalue()


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        b = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send(200, INDEX.read_bytes(), "text/html; charset=utf-8")
        elif path == "/api/data":
            self._send(200, json.dumps(payload(), ensure_ascii=False), "application/json; charset=utf-8")
        elif path == "/api/status":
            self._send(200, json.dumps({"running": running(), **read_json(STATUS, {})}), "application/json")
        elif path == "/api/log":
            self._send(200, (DATA / "scraper.log").read_text(encoding="utf-8") if (DATA / "scraper.log").exists() else "", "text/plain; charset=utf-8")
        elif path == "/export.csv":
            self.send_response(200)
            b = to_csv().encode("utf-8")
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="surcharges_{datetime.now():%Y-%m-%d}.csv"')
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        else:
            self._send(404, "not found", "text/plain")

    def do_POST(self):
        if self.path.startswith("/api/refresh"):
            only = None
            if "?" in self.path:
                q = self.path.split("?", 1)[1]
                only = [x for x in q.replace("only=", "").split(",") if x] or None
            started = start_scrape(only)
            self._send(202, json.dumps({"started": started, "running": True}), "application/json")
        else:
            self._send(404, "not found", "text/plain")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    threading.Thread(target=scheduler, daemon=True).start()
    url = f"http://localhost:{PORT}"
    print(f"Dashboard : {url}   (rafraîchissement auto toutes les {REFRESH_HOURS:g} h, Ctrl+C pour arrêter)")
    if os.environ.get("OPEN_BROWSER", "1") == "1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
