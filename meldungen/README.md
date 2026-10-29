# Meldungen auf status.puntelo.ch

Jede Störung und jede geplante Wartung ist eine Datei `JJJJ-MM-TT-stichwort.md` in diesem Ordner. Auf github.com: «Add file» → «Create new file», Namen eingeben, Text einfügen, «Commit changes». Die Seite ist nach 1 bis 2 Minuten aktuell. Ist eine Datei fehlerhaft, bleibt die alte Seite stehen und GitHub schickt eine Mail mit dem Grund.

## Störung

```
---
art: störung
titel: Online-Buchung antwortet langsam
beginn: 2026-11-30 14:05
betrifft: buchung
---
Wir prüfen die Ursache. Bereits gebuchte Termine sind nicht betroffen.
```

Ist sie behoben: dieselbe Datei bearbeiten, `ende: 2026-11-30 14:40` ergänzen und einen Absatz anhängen, z. B. «14:40 Behoben. Ursache war …». Die Meldung bleibt 30 Tage unter «Vergangene 30 Tage».

## Wartung

```
---
art: wartung
titel: Aktualisierung der Datenbank
beginn: 2026-12-02 22:00
ende: 2026-12-02 22:30
betrifft: app, buchung
---
Die Verwaltung und die Online-Buchung sind bis zu 10 Minuten nicht erreichbar.
```

## Felder

| Feld | Pflicht | Inhalt |
|---|---|---|
| `art` | ja | `störung` oder `wartung` |
| `titel` | ja | kurz, ohne Namen von Betrieben oder Personen |
| `beginn` | ja | `JJJJ-MM-TT HH:MM`, Zürcher Zeit |
| `ende` | bei Wartung | wie `beginn`; bei einer Störung erst, wenn sie behoben ist |
| `betrifft` | nein | `website`, `app`, `buchung`, mit Komma getrennt |

Nie Personendaten, Namen von Betrieben oder interne Adressen in eine Meldung schreiben: das Repository und die Seite sind öffentlich.
