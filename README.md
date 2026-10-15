# Dashboard surcharges carburant

Site monopage qui va lire en direct les pages des transporteurs (Brent, DHL, FedEx, UPS, DPD,
Chronopost, GLS, GEODIS, Colissimo, TNT, Colis Privé, DSV, Régis Martelet) et affiche :

- le taux **en vigueur aujourd'hui** pour chaque service (choisi selon la date du jour),
- le **prochain taux** quand le transporteur l'a déjà publié (DHL, Colissimo, Colis Privé…),
- la variation par rapport à la période précédente et une mini-courbe d'historique,
- un comparatif de tous les taux, un export CSV (séparateur `;`, format Excel FR).

## Lancer (Windows)

Double-cliquez sur **`lancer.bat`**. Au premier lancement il crée un environnement Python et
installe Playwright (≈ 2 min), puis ouvre http://localhost:8050.

Le scraping se lance au démarrage puis toutes les 6 h ; le bouton **Actualiser** le relance à la demande.

Manuellement :

```
python -m pip install -r requirements.txt
python -m playwright install chromium
python server.py              # dashboard
python scraper.py             # scraping seul (ex. tâche planifiée Windows)
python scraper.py dhl ups     # seulement certaines sources
```

Variables d'environnement : `PORT` (8050), `REFRESH_HOURS` (6), `HEADLESS=0` (voir le navigateur
travailler, utile si un site bloque), `SCRAPE_ON_START=0`, `OPEN_BROWSER=0`, `CONCURRENCY` (4).

## Fonctionnement

- `scraper.py` ouvre chaque URL dans un vrai navigateur (Edge ou Chrome installés en priorité,
  sinon Chromium de Playwright) — nécessaire car UPS, FedEx et DHL génèrent leurs tableaux en JavaScript.
- `extract_core.js` : lecture générique des tableaux et des périodes (« Octobre 19-25, 2026 »,
  « 12.10.2026 - 18.10.2026 », « 12/10/2026 », « octobre 2026 »…) et choix du taux en vigueur.
- `extractors.js` : une petite fonction par transporteur. **Si un site change de présentation,
  c'est le seul fichier à modifier.**
- `data/latest.json` : dernier résultat. Si une source échoue, la dernière valeur connue reste
  affichée avec un avertissement. `data/history.json` cumule l'historique à chaque passage
  (le Brent n'a d'historique que grâce à ce fichier). `data/scraper.log` : journal du dernier scraping.

Le `data/latest.json` livré est un instantané du 14/10/2026, remplacé dès le premier scraping.

Les valeurs sont extraites automatiquement : vérifiez sur la page source avant toute facturation.
