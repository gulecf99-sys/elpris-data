# elpris-data

Offentlige data til [Elpris](https://elpris.gulecf.workers.dev) – appen der viser elbilens rigtige elpris.

| Fil | Indhold | Opdateres |
| --- | --- | --- |
| `tillaeg.json` (grenen `main`) | Elselskabernes tillæg og abonnement inkl. moms | Ugentligt |
| `lade/*.json` (grenen `data`) | Offentlige ladestandere og priser fra operatørernes AFIR-data (via Spirii), delt i fliser á 0,25° × 0,5° | Hver anden time af GitHub Actions |

Ladestander-data hentes af `scripts/ladestandere.mjs` (workflow: `.github/workflows/ladestandere.yml`). Fejler en operatør, beholdes dens ladere fra forrige kørsel. Grenen `data` overskrives ved hver kørsel, så historikken ikke vokser.

Kilder: operatørernes AFIR-data via Spirii (DATEX II), elselskabernes egne prissider.
