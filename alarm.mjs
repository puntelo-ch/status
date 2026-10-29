#!/usr/bin/env node
// Eskalation eines Alarms der Stufe 1 (ADR-0027, docs/runbooks/bereitschaft.md). Läuft im
// Repository puntelo-ch/status als Workflow «alarm» auf ein repository_dispatch von Healthchecks.io
// oder von infra/status/probealarm.sh. Liest das Ereignis aus GITHUB_EVENT_PATH, die Themen aus
// der Umgebung. Endet mit Code 1, wenn niemand quittiert hat (GitHub meldet den roten Lauf per Mail).
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { ntfyClient } from "./lib/clients.mjs";
import { handleAlarm, parseEvent } from "./lib/escalation.mjs";

// Secrets des Repositorys puntelo-ch/status, nicht Teil von turbo.json.
const { NTFY_TOPIC_ESCALATION = "", ALARM_DEADLINE_SECONDS = "900" } = process.env;
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} missing`);
  return value;
};

const server = "https://ntfy.sh";
const event = parseEvent(JSON.parse(await readFile(env("GITHUB_EVENT_PATH"), "utf8")));
const result = await handleAlarm({
  event,
  config: {
    server,
    primaryTopic: env("NTFY_TOPIC_ALARM"),
    // Leer: Die Eskalation geht nochmals an Davide, solange es keine Stellvertretung gibt.
    escalationTopic: NTFY_TOPIC_ESCALATION,
    deadlineSeconds: Number(ALARM_DEADLINE_SECONDS),
    pollSeconds: 20,
    retrySeconds: 60,
    // 2 Stunden nach der Frist: höchstens rund 135 Nachrichten, unter dem Tageslimit von ntfy.sh.
    expireSeconds: 7200,
    // Kennung dieses Alarms: Nur eine Quittung mit ihr zählt, nicht die eines älteren Alarms.
    alarmId: randomBytes(6).toString("hex"),
    startedAt: Math.floor(Date.now() / 1000) - 5,
  },
  ntfy: ntfyClient({ server }),
  sleep: (seconds) => setTimeout(seconds * 1000),
  log: (line) => console.log(line),
});
if (result.outcome === "unacknowledged") process.exitCode = 1;
