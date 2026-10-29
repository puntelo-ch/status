#!/usr/bin/env node
// Baut die Statusseite nach `_site/` (ADR-0027, docs/runbooks/statusseite.md). Läuft im Repository
// puntelo-ch/status alle 5 Minuten und bei jeder neuen Meldung:
//   UPTIMEROBOT_READONLY_KEY=… HC_PING_STATUS_PAGE=… node build.mjs
// Eine fehlerhafte Meldung bricht ab (die alte Seite bleibt stehen, GitHub meldet den roten Lauf).
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchMonitors, pingHealthchecks } from "./lib/clients.mjs";
import { componentsFromMonitors, parseMeldung, renderPage } from "./lib/page.mjs";

// Secrets des Repositorys puntelo-ch/status, nicht Teil von turbo.json.
const { UPTIMEROBOT_READONLY_KEY = "", HC_PING_STATUS_PAGE = "" } = process.env;
const root = import.meta.dirname;
const out = join(root, "_site");

const files = (await readdir(join(root, "meldungen")))
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .sort();
const meldungen = [];
for (const file of files) {
  meldungen.push(parseMeldung(await readFile(join(root, "meldungen", file), "utf8"), file));
}

const monitors = await fetchMonitors({ apiKey: UPTIMEROBOT_READONLY_KEY });
const html = renderPage({
  components: componentsFromMonitors(monitors),
  meldungen,
  now: new Date(),
});

await mkdir(out, { recursive: true });
await writeFile(join(out, "index.html"), html);
await cp(join(root, "status.css"), join(out, "status.css"));
await cp(join(root, "marke"), join(out, "marke"), { recursive: true });

await pingHealthchecks({ url: HC_PING_STATUS_PAGE, ok: monitors !== null });
console.log(
  `status page built: ${meldungen.length} notes, monitors ${monitors ? "ok" : "unavailable"}`,
);
