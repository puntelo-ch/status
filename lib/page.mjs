// Statusseite unter status.puntelo.ch (ADR-0027): reine Funktionen ohne Netz und ohne Uhr.
// Der Zustand der Bereiche kommt aus UptimeRobot, Störungen und Wartungen aus Dateien in
// `meldungen/` des Repositorys puntelo-ch/status. Keine Personendaten, nichts von fremden Hosts.

// Die drei Bereiche der Produktion mit dem Namen ihres Monitors in UptimeRobot
// (infra/monitoring/setup.sh). Staging, Odoo und GlitchTip gehören nicht auf die öffentliche Seite.
export const COMPONENTS = [
  { id: "website", monitor: "Puntelo Website", label: "Website puntelo.ch" },
  { id: "app", monitor: "Puntelo App", label: "Verwaltung (app.puntelo.ch)" },
  { id: "buchung", monitor: "Puntelo Buchung", label: "Online-Buchung und Widget" },
];

const STATE_TEXT = {
  betrieb: "Alle Systeme laufen",
  wartung: "Wartung läuft",
  stoerung: "Störung",
  unbekannt: "Status zurzeit nicht abrufbar",
};
const COMPONENT_TEXT = { betrieb: "läuft", stoerung: "Störung", unbekannt: "unbekannt" };

// UptimeRobot API v2: 0 pausiert, 1 noch nicht geprüft, 2 erreichbar, 8 scheint down, 9 down.
function stateOfMonitor(status) {
  if (status === 2) return "betrieb";
  if (status === 8 || status === 9) return "stoerung";
  return "unbekannt";
}

export function componentsFromMonitors(monitors) {
  return COMPONENTS.map((c) => {
    const found = monitors?.find((m) => m.friendly_name === c.monitor);
    return { id: c.id, label: c.label, state: found ? stateOfMonitor(found.status) : "unbekannt" };
  });
}

// "YYYY-MM-DD HH:MM" in Zürcher Zeit; Meldungen schreiben Zeiten so, der Vergleich ist textuell.
export function zurichMinute(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const MINUTE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const KINDS = { störung: "störung", stoerung: "störung", wartung: "wartung" };
const FIELDS = new Set(["art", "titel", "beginn", "ende", "betrifft"]);

// Eine Meldung: Kopf zwischen zwei Zeilen «---», danach Absätze. Fehler nennen die Datei, damit
// der Lauf der Statusseite rot wird und Davide weiss, welche Datei zu korrigieren ist.
export function parseMeldung(text, file) {
  const fail = (why) => {
    throw new Error(`${file}: ${why}`);
  };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) fail("header between two lines «---» missing");
  const head = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon < 0) fail(`line without «:» in the header: ${line}`);
    const key = line.slice(0, colon).trim();
    if (!FIELDS.has(key)) fail(`unknown field «${key}»`);
    head[key] = line.slice(colon + 1).trim();
  }
  const art = KINDS[head.art];
  if (!art) fail("art must be «störung» or «wartung»");
  if (!head.titel) fail("titel missing");
  if (!MINUTE.test(head.beginn ?? "")) fail("beginn must look like 2026-11-30 14:05");
  const ende = head.ende ? head.ende : null;
  if (ende !== null && !MINUTE.test(ende)) fail("ende must look like 2026-11-30 14:05");
  if (ende !== null && ende < head.beginn) fail("ende is before beginn");
  if (art === "wartung" && ende === null) fail("a wartung needs an ende");
  const betrifft = head.betrifft
    ? head.betrifft
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  for (const id of betrifft) {
    if (!COMPONENTS.some((c) => c.id === id)) fail(`unknown area «${id}» in betrifft`);
  }
  const absaetze = match[2]
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s*\r?\n\s*/g, " ").trim())
    .filter(Boolean);
  return { file, art, titel: head.titel, beginn: head.beginn, ende, betrifft, absaetze };
}

export function phaseOf(meldung, now) {
  const t = zurichMinute(now);
  if (meldung.beginn > t) return "geplant";
  if (meldung.ende !== null && meldung.ende <= t) return "vorbei";
  return "aktiv";
}

export function overall(components, meldungen, now) {
  const active = meldungen.filter((m) => phaseOf(m, now) === "aktiv");
  if (active.some((m) => m.art === "störung")) return "stoerung";
  if (components.some((c) => c.state === "stoerung")) return "stoerung";
  if (active.some((m) => m.art === "wartung")) return "wartung";
  if (components.some((c) => c.state === "unbekannt")) return "unbekannt";
  return "betrieb";
}

const escapeHtml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// "2026-12-01 22:00" → "01.12.2026, 22:00"
const swiss = (minute) =>
  `${minute.slice(8, 10)}.${minute.slice(5, 7)}.${minute.slice(0, 4)}, ${minute.slice(11)}`;

const PHASE_TEXT = { aktiv: "läuft", geplant: "geplant", vorbei: "behoben" };
const KEEP_DAYS = 30;

function renderMeldung(m, now) {
  const phase = phaseOf(m, now);
  const kind = m.art === "wartung" ? "Wartung" : "Störung";
  const status = m.art === "wartung" && phase === "vorbei" ? "abgeschlossen" : PHASE_TEXT[phase];
  const areas = m.betrifft
    .map((id) => COMPONENTS.find((c) => c.id === id).label)
    .map(escapeHtml)
    .join(", ");
  const time = m.ende ? `${swiss(m.beginn)} bis ${swiss(m.ende)}` : `seit ${swiss(m.beginn)}`;
  return [
    `<article class="meldung meldung-${phase}">`,
    `<h3>${kind}: ${escapeHtml(m.titel)} <span class="phase">${status}</span></h3>`,
    `<p class="zeit">${time}${areas ? ` · betrifft ${areas}` : ""}</p>`,
    ...m.absaetze.map((p) => `<p>${escapeHtml(p)}</p>`),
    "</article>",
  ].join("\n");
}

export function renderPage({ components, meldungen, now }) {
  const state = overall(components, meldungen, now);
  const oldest = zurichMinute(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
  const byStart = [...meldungen].sort((a, b) => (a.beginn < b.beginn ? 1 : -1));
  const current = byStart.filter((m) => phaseOf(m, now) !== "vorbei");
  const past = byStart.filter((m) => phaseOf(m, now) === "vorbei" && m.ende >= oldest);

  const section = (title, list, empty) =>
    [
      `<section><h2>${title}</h2>`,
      list.length
        ? list.map((m) => renderMeldung(m, now)).join("\n")
        : `<p class="leer">${empty}</p>`,
      "</section>",
    ].join("\n");

  return `<!doctype html>
<html lang="de-CH">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'">
<meta http-equiv="refresh" content="300">
<meta name="referrer" content="no-referrer">
<title>Puntelo Status</title>
<link rel="icon" href="marke/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="marke/tokens.css">
<link rel="stylesheet" href="status.css">
</head>
<body>
<header><img src="marke/puntelo-wortmarke-farbe.svg" alt="Puntelo" width="140" height="36"></header>
<main>
<div class="gesamt gesamt-${state}" role="status"><h1>${STATE_TEXT[state]}</h1></div>
<ul class="bereiche">
${components
  .map(
    (c) =>
      `<li class="bereich-${c.state}"><span>${escapeHtml(c.label)}</span><span class="zustand">${COMPONENT_TEXT[c.state]}</span></li>`,
  )
  .join("\n")}
</ul>
${section("Aktuelle Meldungen und geplante Wartungen", current, "Keine aktuellen Meldungen.")}
${section(`Vergangene ${KEEP_DAYS} Tage`, past, "Keine Störungen in den letzten 30 Tagen.")}
</main>
<footer>
<p>Geprüft am ${swiss(zurichMinute(now))} (Zürcher Zeit). Die Seite prüft alle 5 Minuten von ausserhalb unserer Server und lädt sich selbst neu.</p>
<p>Fragen: <a href="mailto:hallo@puntelo.ch">hallo@puntelo.ch</a> · <a href="https://puntelo.ch">puntelo.ch</a></p>
</footer>
</body>
</html>
`;
}
