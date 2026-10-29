// Anfragen an ntfy, UptimeRobot und Healthchecks.io mit gefälschtem fetch.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fetchMonitors, ntfyClient, pingHealthchecks } from "../lib/clients.mjs";

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 200, body: { status: 1 } };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { fetch, calls };
}

describe("ntfyClient", () => {
  test("publishes as JSON to the server root with topic, priority and buttons", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { id: "m1" } }]);
    const client = ntfyClient({ server: "https://ntfy.sh", fetch });
    await client.publish({
      topic: "t1",
      title: "T",
      message: "M",
      priority: 5,
      tags: ["rotating_light"],
      actions: [{ action: "http", label: "Quittieren", url: "https://ntfy.sh/t1-quittung" }],
    });
    assert.equal(calls[0].url, "https://ntfy.sh/");
    assert.equal(calls[0].init.method, "POST");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.topic, "t1");
    assert.equal(body.priority, 5);
    assert.equal(body.actions[0].label, "Quittieren");
  });

  test("fails loudly without naming the topic", async () => {
    const { fetch } = fakeFetch([{ status: 429, body: { error: "limit reached" } }]);
    const client = ntfyClient({ server: "https://ntfy.sh", fetch });
    await assert.rejects(
      () => client.publish({ topic: "secret-topic", title: "T", message: "M", priority: 5 }),
      (err) => /429/.test(err.message) && !err.message.includes("secret-topic"),
    );
  });

  test("reads the acknowledgements since a point in time", async () => {
    const lines = [
      { event: "open" },
      { event: "message", message: "a1 primary" },
      { event: "keepalive" },
      { event: "message", message: "a1 escalation" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => `${lines}\n` };
    };
    const client = ntfyClient({ server: "https://ntfy.sh", fetch });
    assert.deepEqual(await client.acks({ topic: "t1-quittung", since: 1_800_000_000 }), [
      "a1 primary",
      "a1 escalation",
    ]);
    assert.equal(calls[0].url, "https://ntfy.sh/t1-quittung/json?poll=1&since=1800000000");
  });

  test("a failed poll counts as no acknowledgement, the alarm keeps ringing", async () => {
    const fetch = async () => {
      throw new Error("network down");
    };
    const client = ntfyClient({ server: "https://ntfy.sh", fetch });
    assert.deepEqual(await client.acks({ topic: "t1-quittung", since: 1 }), []);
  });
});

describe("fetchMonitors", () => {
  test("asks UptimeRobot with the read-only key and returns the monitors", async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        body: { stat: "ok", monitors: [{ friendly_name: "Puntelo App", status: 2 }] },
      },
    ]);
    const monitors = await fetchMonitors({ apiKey: "ur-ro", fetch });
    assert.deepEqual(monitors, [{ friendly_name: "Puntelo App", status: 2 }]);
    assert.equal(calls[0].url, "https://api.uptimerobot.com/v2/getMonitors");
    assert.equal(new URLSearchParams(calls[0].init.body).get("api_key"), "ur-ro");
  });

  test("returns null when UptimeRobot answers with an error, so the page shows «unknown»", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: { stat: "fail" } }]);
    assert.equal(await fetchMonitors({ apiKey: "ur-ro", fetch }), null);
  });

  test("returns null when the request fails", async () => {
    const fetch = async () => {
      throw new Error("network down");
    };
    assert.equal(await fetchMonitors({ apiKey: "ur-ro", fetch }), null);
  });
});

describe("pingHealthchecks", () => {
  test("pings the url, or /fail when something went wrong", async () => {
    const { fetch, calls } = fakeFetch([]);
    await pingHealthchecks({ url: "https://hc-ping.com/abc", ok: true, fetch });
    await pingHealthchecks({ url: "https://hc-ping.com/abc", ok: false, fetch });
    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://hc-ping.com/abc", "https://hc-ping.com/abc/fail"],
    );
  });

  test("without a url it does nothing", async () => {
    const { fetch, calls } = fakeFetch([]);
    await pingHealthchecks({ url: "", ok: true, fetch });
    assert.equal(calls.length, 0);
  });
});
