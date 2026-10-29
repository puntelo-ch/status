// Alarm mit Quittung und Eskalation (ADR-0027): Ablauf mit einem gefälschten ntfy und einer
// gefälschten Uhr. Keine echten Wartezeiten, kein Netz.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ackTopicOf, handleAlarm, parseEvent } from "../lib/escalation.mjs";

const CONFIG = {
  server: "https://ntfy.sh",
  primaryTopic: "t-stufe-1",
  escalationTopic: "t-stellvertretung",
  deadlineSeconds: 900,
  pollSeconds: 20,
  retrySeconds: 60,
  expireSeconds: 7200,
  alarmId: "a1b2c3",
  startedAt: 1_800_000_000,
};

// ntfy zum Testen: `ackAt` sagt, nach wie vielen Sekunden wer quittiert («primary» oder
// «escalation»); `foreign` sind Quittungen alter Alarme mit einer anderen Kennung.
function fakeNtfy({ ackAt = {}, foreign = [] } = {}) {
  const clock = { t: 0 };
  const sent = [];
  const polls = [];
  const ntfy = {
    async publish(message) {
      sent.push({ ...message, at: clock.t });
    },
    async acks({ topic, since }) {
      polls.push({ topic, since });
      const own = Object.entries(ackAt)
        .filter(([, at]) => clock.t >= at)
        .map(([role]) => `${CONFIG.alarmId} ${role}`);
      return [...foreign, ...own];
    },
  };
  const sleep = async (seconds) => {
    clock.t += seconds;
  };
  const log = [];
  return { ntfy, sleep, clock, sent, polls, log: (line) => log.push(line), lines: log };
}

const run = (fake, event, config = CONFIG) =>
  handleAlarm({ event, config, ntfy: fake.ntfy, sleep: fake.sleep, log: fake.log });

const down = (check = "prod-backup", extra = {}) => ({
  check,
  status: "down",
  test: false,
  deadlineSeconds: null,
  ...extra,
});
const alarms = (fake) => fake.sent.filter((m) => m.priority === 5);

describe("parseEvent", () => {
  test("reads check and status from the dispatch payload", () => {
    assert.deepEqual(parseEvent({ client_payload: { check: "prod-backup", status: "down" } }), {
      check: "prod-backup",
      status: "down",
      test: false,
      deadlineSeconds: null,
    });
  });
  test("a test alarm may shorten the deadline, within bounds", () => {
    const e = parseEvent({
      client_payload: { check: "probealarm", status: "down", test: true, deadline: 120 },
    });
    assert.equal(e.test, true);
    assert.equal(e.deadlineSeconds, 120);
    assert.throws(() =>
      parseEvent({
        client_payload: { check: "probealarm", status: "down", test: true, deadline: 5 },
      }),
    );
  });
  test("a real alarm ignores a deadline from the payload", () => {
    const e = parseEvent({ client_payload: { check: "prod-dump", status: "down", deadline: 60 } });
    assert.equal(e.deadlineSeconds, null);
  });
  test("accepts the test notification of Healthchecks.io («TEST»)", () => {
    assert.equal(parseEvent({ client_payload: { check: "TEST", status: "down" } }).check, "TEST");
  });
  const invalid = [
    ["missing payload", {}],
    ["unknown status", { client_payload: { check: "prod-dump", status: "grace" } }],
    ["check with shell characters", { client_payload: { check: "x;rm -rf", status: "down" } }],
    ["check too long", { client_payload: { check: "a".repeat(65), status: "down" } }],
  ];
  for (const [name, payload] of invalid) {
    test(`rejects ${name}`, () => assert.throws(() => parseEvent(payload)));
  }
});

describe("ackTopicOf", () => {
  test("derives the acknowledgement topic from the alarm topic", () => {
    assert.equal(ackTopicOf("t-stufe-1"), "t-stufe-1-quittung");
  });
});

describe("handleAlarm", () => {
  test("down: alerts the primary topic with priority 5 every minute until acknowledged", async () => {
    const fake = fakeNtfy({ ackAt: { primary: 150 } });
    const result = await run(fake, down());
    assert.deepEqual(result, { outcome: "acknowledged", by: "primary", afterSeconds: 160 });
    const sent = alarms(fake);
    assert.deepEqual(
      sent.map((m) => m.at),
      [0, 60, 120],
    );
    for (const m of sent) {
      assert.equal(m.topic, "t-stufe-1");
      assert.match(m.title, /Stufe 1: prod-backup/);
    }
  });

  test("each alarm carries a button that acknowledges on ntfy.sh, not on our server", async () => {
    const fake = fakeNtfy({ ackAt: { primary: 20 } });
    await run(fake, down());
    const [first] = alarms(fake);
    assert.equal(first.actions.length, 1);
    const [button] = first.actions;
    assert.equal(button.action, "http");
    assert.equal(button.label, "Quittieren");
    assert.equal(button.method, "POST");
    assert.equal(button.url, "https://ntfy.sh/t-stufe-1-quittung");
    assert.equal(button.body, "a1b2c3 primary");
    assert.equal(button.clear, true);
    // Tippen auf die Mitteilung quittiert ebenfalls (falls der Knopf nicht geht).
    assert.equal(
      first.click,
      "https://ntfy.sh/t-stufe-1-quittung/publish?message=a1b2c3%20primary",
    );
  });

  test("polls the acknowledgement topic since the start of the alarm", async () => {
    const fake = fakeNtfy({ ackAt: { primary: 20 } });
    await run(fake, down());
    assert.deepEqual(fake.polls[0], { topic: "t-stufe-1-quittung", since: 1_800_000_000 });
  });

  test("ignores acknowledgements of older alarms", async () => {
    const fake = fakeNtfy({ ackAt: { primary: 300 }, foreign: ["zzz999 primary", "hallo"] });
    const result = await run(fake, down());
    assert.equal(result.afterSeconds, 300);
  });

  test("after acknowledging, a quiet note says who took over", async () => {
    const fake = fakeNtfy({ ackAt: { primary: 40 } });
    await run(fake, down());
    const last = fake.sent.at(-1);
    assert.ok(last.priority <= 2);
    assert.match(last.title, /quittiert/);
    assert.equal(last.actions, undefined);
  });

  test("acknowledged right at the deadline does not escalate", async () => {
    const fake = fakeNtfy({ ackAt: { primary: 900 } });
    const result = await run(fake, down("prod-dump"));
    assert.equal(result.outcome, "acknowledged");
    assert.ok(alarms(fake).every((m) => m.topic === "t-stufe-1" && !/Eskalation/.test(m.title)));
  });

  test("not acknowledged within the deadline: escalates to the deputy, who can acknowledge", async () => {
    const fake = fakeNtfy({ ackAt: { escalation: 1200 } });
    const result = await run(fake, down("prod-worker-heartbeat"));
    assert.deepEqual(result, { outcome: "acknowledged", by: "escalation", afterSeconds: 1200 });
    const toDeputy = alarms(fake).filter((m) => m.topic === "t-stellvertretung");
    assert.equal(toDeputy[0].at, 900);
    assert.match(toDeputy[0].title, /Eskalation/);
    assert.match(toDeputy[0].message, /15 Minuten nicht quittiert/);
    assert.equal(toDeputy[0].actions[0].body, "a1b2c3 escalation");
    // Davide klingelt weiter, bis jemand quittiert.
    assert.ok(alarms(fake).some((m) => m.topic === "t-stufe-1" && m.at >= 900));
    // Beide erfahren, dass quittiert ist.
    const notes = fake.sent.filter((m) => /quittiert/.test(m.title));
    assert.deepEqual(notes.map((m) => m.topic).sort(), ["t-stellvertretung", "t-stufe-1"]);
  });

  test("without a deputy the escalation rings the primary again, once a minute", async () => {
    const fake = fakeNtfy({ ackAt: { primary: 1000 } });
    const result = await run(fake, down("prod-dump"), { ...CONFIG, escalationTopic: "" });
    assert.equal(result.by, "primary");
    const late = alarms(fake).filter((m) => m.at >= 900);
    assert.ok(late.length > 0);
    assert.ok(late.every((m) => m.topic === "t-stufe-1" && /Eskalation/.test(m.title)));
    // Nie zwei Alarme in derselben Minute an dasselbe Thema.
    const ats = alarms(fake).map((m) => m.at);
    assert.equal(new Set(ats).size, ats.length);
  });

  test("nobody acknowledges: stops after deadline plus expiry and reports it", async () => {
    const fake = fakeNtfy();
    const result = await run(fake, down("prod-check"), { ...CONFIG, escalationTopic: "" });
    assert.equal(result.outcome, "unacknowledged");
    assert.ok(fake.clock.t >= 900 + 7200);
    // Unter dem Tageslimit von ntfy.sh für anonyme Absender (250 Nachrichten).
    assert.ok(fake.sent.length <= 140, `sent ${fake.sent.length}`);
  });

  test("a test alarm says so and uses its shorter deadline", async () => {
    const fake = fakeNtfy({ ackAt: { escalation: 150 } });
    const result = await run(fake, down("probealarm", { test: true, deadlineSeconds: 120 }));
    assert.equal(result.by, "escalation");
    const toDeputy = alarms(fake).filter((m) => m.topic === "t-stellvertretung");
    assert.equal(toDeputy[0].at, 120);
    assert.match(toDeputy[0].message, /2 Minuten nicht quittiert/);
    assert.ok(alarms(fake).every((m) => /^Probealarm/.test(m.title)));
  });

  test("up: sends an all-clear to the topics, without a button", async () => {
    const fake = fakeNtfy();
    const result = await run(fake, { check: "prod-backup", status: "up", test: false });
    assert.deepEqual(result, { outcome: "resolved" });
    assert.deepEqual(
      fake.sent.map((m) => m.topic),
      ["t-stufe-1", "t-stellvertretung"],
    );
    for (const m of fake.sent) {
      assert.equal(m.priority, 3);
      assert.match(m.title, /wieder in Ordnung/);
      assert.equal(m.actions, undefined);
    }
  });

  test("logs only the check, the step and the outcome", async () => {
    const fake = fakeNtfy({ ackAt: { primary: 60 } });
    await run(fake, down());
    const text = fake.lines.join("\n");
    assert.match(text, /prod-backup/);
    assert.doesNotMatch(text, /t-stufe-1|a1b2c3/);
  });
});
