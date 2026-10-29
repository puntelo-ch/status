// Alarm der Stufe 1 mit Quittung und Eskalation (ADR-0027). Healthchecks.io meldet «down» oder
// «up» per repository_dispatch an puntelo-ch/status; dieser Ablauf schickt jede Minute eine
// Mitteilung mit Priorität 5 über ntfy.sh an Davide, bis jemand quittiert, und nach Ablauf der
// Frist zusätzlich an die Stellvertretung (ohne Stellvertretung nochmals an Davide). Quittiert wird
// mit einem Knopf in der Mitteilung: Er schreibt die Kennung des Alarms in ein Quittungsthema auf
// ntfy.sh, das dieser Ablauf abfragt. Unser Server ist dabei nicht beteiligt.
// ntfy, Uhr und Log kommen von aussen, damit der Ablauf ohne Netz und ohne Warten prüfbar ist.

// Namen der Checks von Healthchecks.io, auch der Testnachricht («TEST»); nie Zeichen für die Shell.
const CHECK = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const TEST_DEADLINE = { min: 60, max: 900 };

export function parseEvent(event) {
  const payload = event?.client_payload;
  if (!payload || typeof payload !== "object") throw new Error("client_payload missing");
  const { check, status } = payload;
  if (typeof check !== "string" || !CHECK.test(check)) throw new Error("invalid check name");
  if (status !== "down" && status !== "up") throw new Error("status must be down or up");
  const test = payload.test === true;
  let deadlineSeconds = null;
  // Nur ein Probealarm darf die Frist verkürzen, damit die Probe keine 15 Minuten dauert.
  if (test && payload.deadline !== undefined) {
    const d = payload.deadline;
    if (!Number.isInteger(d) || d < TEST_DEADLINE.min || d > TEST_DEADLINE.max) {
      throw new Error(`deadline must be between ${TEST_DEADLINE.min} and ${TEST_DEADLINE.max}`);
    }
    deadlineSeconds = d;
  }
  return { check, status, test, deadlineSeconds };
}

export const ackTopicOf = (topic) => `${topic}-quittung`;

export async function handleAlarm({ event, config, ntfy, sleep, log }) {
  const { check, status, test } = event;
  const prefix = test ? "Probealarm " : "";
  const { primaryTopic, escalationTopic, server } = config;
  const topics = escalationTopic ? [primaryTopic, escalationTopic] : [primaryTopic];

  if (status === "up") {
    // Der laufende «down» desselben Checks ist schon abgebrochen (concurrency im Workflow).
    for (const topic of topics) {
      await ntfy.publish({
        topic,
        priority: 3,
        tags: ["white_check_mark"],
        title: `${prefix}${check} wieder in Ordnung`,
        message: `${check} meldet wieder «up». Der Alarm dazu ist beendet.`,
      });
    }
    log(`${check}: up, all-clear sent`);
    return { outcome: "resolved" };
  }

  const ackTopic = ackTopicOf(primaryTopic);
  const ackUrl = `${server}/${ackTopic}`;
  const alarm = (topic, role, title, message) => {
    const body = `${config.alarmId} ${role}`;
    return ntfy.publish({
      topic,
      priority: 5,
      tags: ["rotating_light"],
      title,
      message,
      // Tippen auf die Mitteilung öffnet eine Adresse, die ebenfalls quittiert.
      click: `${ackUrl}/publish?message=${encodeURIComponent(body)}`,
      actions: [
        { action: "http", label: "Quittieren", url: ackUrl, method: "POST", body, clear: true },
      ],
    });
  };

  const deadline = event.deadlineSeconds ?? config.deadlineSeconds;
  const minutes = Math.round(deadline / 60);
  const firstTitle = `${prefix}Stufe 1: ${check}`;
  const firstText = `${check} ist rot. Bitte quittieren und nach docs/runbooks/ueberwachung.md vorgehen.`;
  const escTitle = `${prefix}Eskalation Stufe 1: ${check}`;
  const escText = `${check} ist rot und wurde ${minutes} Minuten nicht quittiert. Bitte quittieren und nach docs/runbooks/bereitschaft.md vorgehen.`;

  let elapsed = 0;
  let nextAlarm = 0;
  let escalated = false;
  log(`${check}: down, alarm started, deadline ${deadline}s`);

  while (elapsed < deadline + config.expireSeconds) {
    if (elapsed >= nextAlarm) {
      if (elapsed >= deadline && !escalated) {
        escalated = true;
        log(`${check}: not acknowledged within ${deadline}s, escalated`);
      }
      if (!escalated) {
        await alarm(primaryTopic, "primary", firstTitle, firstText);
      } else if (escalationTopic) {
        // Davide klingelt weiter, die Stellvertretung zusätzlich; wer zuerst quittiert, übernimmt.
        await alarm(primaryTopic, "primary", firstTitle, firstText);
        await alarm(escalationTopic, "escalation", escTitle, escText);
      } else {
        await alarm(primaryTopic, "primary", escTitle, escText);
      }
      nextAlarm += config.retrySeconds;
    }
    await sleep(config.pollSeconds);
    elapsed += config.pollSeconds;
    const own = (await ntfy.acks({ topic: ackTopic, since: config.startedAt })).find((m) =>
      m.startsWith(`${config.alarmId} `),
    );
    if (own) {
      const by = own.endsWith(" escalation") ? "escalation" : "primary";
      const who = by === "primary" ? "Davide" : "die Stellvertretung";
      for (const topic of escalated ? topics : [primaryTopic]) {
        await ntfy.publish({
          topic,
          priority: 2,
          tags: ["ok_hand"],
          title: `${prefix}${check} quittiert`,
          message: `Der Alarm zu ${check} ist von ${who} quittiert und klingelt nicht mehr.`,
        });
      }
      log(`${check}: acknowledged by ${by} after ${elapsed}s`);
      return { outcome: "acknowledged", by, afterSeconds: elapsed };
    }
  }
  log(`${check}: nobody acknowledged, alarm stopped after ${elapsed}s`);
  return { outcome: "unacknowledged" };
}
