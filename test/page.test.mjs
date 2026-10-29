// Statusseite (ADR-0027): Zustand der Bereiche, Meldungen und HTML. Ohne Netz, «Jetzt» als Parameter.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  componentsFromMonitors,
  overall,
  parseMeldung,
  phaseOf,
  renderPage,
  zurichMinute,
} from "../lib/page.mjs";

const NOW = new Date("2026-11-30T13:00:00Z"); // 14:00 in Zürich

const monitor = (name, status) => ({ friendly_name: name, status });

describe("componentsFromMonitors", () => {
  const cases = [
    { status: 2, state: "betrieb" },
    { status: 8, state: "stoerung" },
    { status: 9, state: "stoerung" },
    { status: 0, state: "unbekannt" },
    { status: 1, state: "unbekannt" },
  ];
  for (const { status, state } of cases) {
    test(`UptimeRobot status ${status} is ${state}`, () => {
      const [website] = componentsFromMonitors([monitor("Puntelo Website", status)]);
      assert.equal(website.state, state);
    });
  }

  test("shows the three production areas in a fixed order, missing ones as unknown", () => {
    const components = componentsFromMonitors([
      monitor("Puntelo Buchung", 2),
      monitor("Odoo PopSoda", 9),
      monitor("Puntelo Staging", 9),
    ]);
    assert.deepEqual(
      components.map((c) => [c.id, c.state]),
      [
        ["website", "unbekannt"],
        ["app", "unbekannt"],
        ["buchung", "betrieb"],
      ],
    );
  });

  test("without data every area is unknown", () => {
    assert.ok(componentsFromMonitors(null).every((c) => c.state === "unbekannt"));
  });
});

describe("zurichMinute", () => {
  test("winter time is UTC+1", () => {
    assert.equal(zurichMinute(new Date("2026-11-30T13:00:00Z")), "2026-11-30 14:00");
  });
  test("summer time is UTC+2", () => {
    assert.equal(zurichMinute(new Date("2026-07-01T22:30:00Z")), "2026-07-02 00:30");
  });
});

describe("parseMeldung", () => {
  const text = [
    "---",
    "art: störung",
    "titel: Online-Buchung langsam",
    "beginn: 2026-11-30 13:40",
    "betrifft: buchung, app",
    "---",
    "Wir prüfen die Ursache.",
    "",
    "Buchungen gehen nicht verloren.",
  ].join("\n");

  test("reads the header and the paragraphs", () => {
    assert.deepEqual(parseMeldung(text, "2026-11-30-buchung.md"), {
      file: "2026-11-30-buchung.md",
      art: "störung",
      titel: "Online-Buchung langsam",
      beginn: "2026-11-30 13:40",
      ende: null,
      betrifft: ["buchung", "app"],
      absaetze: ["Wir prüfen die Ursache.", "Buchungen gehen nicht verloren."],
    });
  });

  test("accepts «stoerung» without umlaut and an end", () => {
    const m = parseMeldung(
      "---\nart: stoerung\ntitel: X\nbeginn: 2026-11-30 13:40\nende: 2026-11-30 14:10\n---\nBehoben.",
      "a.md",
    );
    assert.equal(m.art, "störung");
    assert.equal(m.ende, "2026-11-30 14:10");
  });

  const invalid = [
    ["no header", "Nur Text"],
    ["unknown kind", "---\nart: panne\ntitel: X\nbeginn: 2026-11-30 13:40\n---\n"],
    ["missing title", "---\nart: wartung\nbeginn: 2026-11-30 13:40\n---\n"],
    ["bad start", "---\nart: wartung\ntitel: X\nbeginn: 30.11.2026 13:40\n---\n"],
    [
      "end before start",
      "---\nart: wartung\ntitel: X\nbeginn: 2026-11-30 13:40\nende: 2026-11-30 12:00\n---\n",
    ],
    ["maintenance without end", "---\nart: wartung\ntitel: X\nbeginn: 2026-11-30 13:40\n---\n"],
    [
      "unknown area",
      "---\nart: störung\ntitel: X\nbeginn: 2026-11-30 13:40\nbetrifft: odoo\n---\n",
    ],
    ["unknown field", "---\nart: störung\ntitel: X\nbeginn: 2026-11-30 13:40\nfarbe: rot\n---\n"],
  ];
  for (const [name, input] of invalid) {
    test(`rejects ${name} and names the file`, () => {
      assert.throws(() => parseMeldung(input, "kaputt.md"), /kaputt\.md/);
    });
  }
});

describe("phaseOf", () => {
  const m = (art, beginn, ende = null) => ({ art, beginn, ende });
  const cases = [
    ["incident without end is active", m("störung", "2026-11-30 13:40"), "aktiv"],
    ["incident that ended is over", m("störung", "2026-11-30 13:40", "2026-11-30 13:55"), "vorbei"],
    [
      "incident ending later is active",
      m("störung", "2026-11-30 13:40", "2026-11-30 15:00"),
      "aktiv",
    ],
    [
      "future maintenance is planned",
      m("wartung", "2026-12-01 22:00", "2026-12-01 23:00"),
      "geplant",
    ],
    ["running maintenance", m("wartung", "2026-11-30 13:30", "2026-11-30 14:30"), "aktiv"],
    [
      "maintenance starting now runs",
      m("wartung", "2026-11-30 14:00", "2026-11-30 14:30"),
      "aktiv",
    ],
    ["finished maintenance", m("wartung", "2026-11-29 22:00", "2026-11-29 23:00"), "vorbei"],
  ];
  for (const [name, meldung, phase] of cases) {
    test(name, () => assert.equal(phaseOf(meldung, NOW), phase));
  }
});

describe("overall", () => {
  const up = componentsFromMonitors([
    monitor("Puntelo Website", 2),
    monitor("Puntelo App", 2),
    monitor("Puntelo Buchung", 2),
  ]);
  const incident = { art: "störung", beginn: "2026-11-30 13:40", ende: null };
  const maintenance = { art: "wartung", beginn: "2026-11-30 13:30", ende: "2026-11-30 14:30" };
  const planned = { art: "wartung", beginn: "2026-12-01 22:00", ende: "2026-12-01 23:00" };

  const cases = [
    ["all up", up, [], "betrieb"],
    ["planned maintenance does not count yet", up, [planned], "betrieb"],
    ["running maintenance", up, [maintenance], "wartung"],
    ["an incident note wins over green monitors", up, [incident, maintenance], "stoerung"],
    [
      "a red monitor is an incident",
      componentsFromMonitors([
        monitor("Puntelo Website", 2),
        monitor("Puntelo App", 9),
        monitor("Puntelo Buchung", 2),
      ]),
      [],
      "stoerung",
    ],
    ["no data is unknown, never green", componentsFromMonitors(null), [], "unbekannt"],
  ];
  for (const [name, components, meldungen, state] of cases) {
    test(name, () => assert.equal(overall(components, meldungen, NOW), state));
  }
});

describe("renderPage", () => {
  const components = componentsFromMonitors([
    monitor("Puntelo Website", 2),
    monitor("Puntelo App", 2),
    monitor("Puntelo Buchung", 9),
  ]);
  const meldungen = [
    {
      file: "a.md",
      art: "störung",
      titel: "Buchung <gestört>",
      beginn: "2026-11-30 13:40",
      ende: null,
      betrifft: ["buchung"],
      absaetze: ["Wir prüfen & melden uns."],
    },
    {
      file: "b.md",
      art: "wartung",
      titel: "Datenbank-Update",
      beginn: "2026-12-01 22:00",
      ende: "2026-12-01 23:00",
      betrifft: [],
      absaetze: [],
    },
    {
      file: "c.md",
      art: "störung",
      titel: "Alte Störung",
      beginn: "2026-09-01 10:00",
      ende: "2026-09-01 11:00",
      betrifft: [],
      absaetze: [],
    },
  ];
  const html = renderPage({ components, meldungen, now: NOW });

  test("is a German page with the overall state", () => {
    assert.match(html, /<html lang="de-CH">/);
    assert.match(html, /Störung/);
    assert.match(html, /Online-Buchung und Widget/);
  });
  test("escapes texts from notes", () => {
    assert.match(html, /Buchung &lt;gestört&gt;/);
    assert.match(html, /Wir prüfen &amp; melden uns\./);
    assert.doesNotMatch(html, /<gestört>/);
  });
  test("lists planned maintenance with Swiss dates", () => {
    assert.match(html, /Datenbank-Update/);
    assert.match(html, /01\.12\.2026, 22:00/);
  });
  test("drops notes that ended more than 30 days ago", () => {
    assert.doesNotMatch(html, /Alte Störung/);
  });
  test("shows when it was checked and loads nothing from other hosts", () => {
    assert.match(html, /30\.11\.2026, 14:00/);
    assert.doesNotMatch(html, /src="https?:/);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/);
  });
  test("has a strict content security policy", () => {
    assert.match(html, /http-equiv="Content-Security-Policy"/);
    assert.match(html, /default-src 'none'/);
  });
});
