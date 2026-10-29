// Netzzugriffe der Statusseite und des Eskalationsablaufs (ADR-0027). fetch kommt von aussen, damit
// die Tests ohne Netz laufen. Schlüssel und Themen stehen nie in Fehlermeldungen oder im Log.

// ntfy.sh, öffentlicher Server, unabhängig von unserer Instanz. Themen sind geheim wie Schlüssel:
// Sie stehen nie in Fehlermeldungen.
export function ntfyClient({ server, fetch = globalThis.fetch }) {
  return {
    async publish(message) {
      const res = await fetch(`${server}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`ntfy publish failed: HTTP ${res.status}`);
    },
    // Texte der Nachrichten im Thema seit `since` (Unix-Sekunden). Bei einem Fehler leer: Der Alarm
    // klingelt dann weiter, statt fälschlich als quittiert zu gelten.
    async acks({ topic, since }) {
      try {
        const res = await fetch(
          `${server}/${encodeURIComponent(topic)}/json?poll=1&since=${since}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (!res.ok) return [];
        return (await res.text())
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((m) => m.event === "message" && typeof m.message === "string")
          .map((m) => m.message);
      } catch {
        return [];
      }
    },
  };
}

// UptimeRobot API v2 mit dem Schlüssel «nur lesen». Bei jedem Fehler null: Die Seite zeigt dann
// «nicht abrufbar» statt eines alten, vielleicht falschen «alles läuft».
export async function fetchMonitors({ apiKey, fetch = globalThis.fetch }) {
  try {
    const res = await fetch("https://api.uptimerobot.com/v2/getMonitors", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: apiKey, format: "json", limit: "50" }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json();
    if (!res.ok || body.stat !== "ok" || !Array.isArray(body.monitors)) return null;
    return body.monitors.map(({ friendly_name, status }) => ({ friendly_name, status }));
  } catch {
    return null;
  }
}

// Herzschlag der Statusseite an Healthchecks.io (Check `status-page`, Stufe 2): bleibt er aus,
// laufen die geplanten Workflows nicht mehr (GitHub schaltet sie nach 60 Tagen ohne Änderung ab).
export async function pingHealthchecks({ url, ok, fetch = globalThis.fetch }) {
  if (!url) return;
  await fetch(ok ? url : `${url}/fail`, { method: "POST", signal: AbortSignal.timeout(10_000) });
}
