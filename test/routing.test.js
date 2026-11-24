// Several agents behind one desk: the settings key "routing" picks the agent
// and the drafting instruction by the value of one intake field.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const cases = require("../lib/cases");
const { createDesk, loadConfig } = require("../server");

const PA = "desks/prior-authorisation/desk.config.json";
const BASE = loadConfig({ DESK_CONFIG: PA });
const ROUTING = {
  field: "urgency",
  kinds: {
    expedited: { agentEnv: "AGENT_EXPEDITED", instruction: "EXPEDITED INSTRUCTION: review this request first." },
  },
};
const withRouting = { ...BASE, routing: ROUTING };
const fake = (fields) => ({ fields, drafts: [], decision: null });

const TABLE = ["Summary", "A request.", "", "Draft criteria review. For review by a clinical reviewer. Not issued.", "", "| # | Criterion | Policy source | Evidence in the request | Where | Mark | Reviewer should check |", "|---|---|---|---|---|---|---|", "| 1 | Pain | HHP-MP-101 2.1 | Seven weeks | Note | met | Nothing |", "", "Proposed next step: approve, every criterion is met"].join("\n");

test("routeOf picks the kind by the field's value, ignoring case; anything else gets the desk's defaults", () => {
  assert.deepEqual(cases.routeOf(withRouting, fake({ urgency: "Expedited" })), { kind: "expedited", routed: true, agentEnv: "AGENT_EXPEDITED", instruction: ROUTING.kinds.expedited.instruction });
  assert.equal(cases.routeOf(withRouting, fake({ urgency: " EXPEDITED " })).routed, true);
  for (const v of ["Standard", "", undefined]) {
    const r = cases.routeOf(withRouting, fake({ urgency: v }));
    assert.deepEqual(r, { kind: "", routed: false, agentEnv: "", instruction: "" });
  }
  assert.equal(cases.routeOf(BASE, fake({ urgency: "Expedited" })).routed, false, "no routing key: nothing changes");
});

test("the routed instruction replaces the desk's single one; without one the prompt is as before", () => {
  const c = { ...fake({ title: "T", member_ref: "M", provider: "P", requested_on: "2026-11-01", urgency: "Expedited" }), conversation: [] };
  const routed = cases.draftPrompt(withRouting, c, null, { instruction: ROUTING.kinds.expedited.instruction });
  assert.ok(routed.startsWith("EXPEDITED INSTRUCTION"));
  assert.ok(!routed.includes(BASE.draft.instruction));
  assert.equal(cases.draftPrompt(BASE, c, null, {}), cases.draftPrompt(BASE, c, null));
  assert.ok(cases.draftPrompt(BASE, c, null).startsWith(BASE.draft.instruction));
});

function platform() {
  const calls = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        calls.push(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_STARTED", thread_id: "sess-r", run_id: "run-r" })}\n\n`);
        for (const piece of TABLE.match(/.{1,60}/gs)) res.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: piece })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function runDesk(extraEnv, check) {
  const p = await platform();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-"));
  const file = path.join(dir, "desk.config.json");
  fs.writeFileSync(file, JSON.stringify({ ...BASE, routing: ROUTING, demo: { file: path.resolve(__dirname, "..", "desks/prior-authorisation/cases.json"), key: "requests" } }));
  const desk = await createDesk({ DESK_CONFIG: file, DATA_DIR: dir, SEED_DEMO: "true", DESK_RETRY_WAIT_MS: "50", KATONIC_BASE_URL: p.url, KATONIC_API_KEY: "kapi_test", KATONIC_AGENT_ID: "agent-default", LOCAL_USER: "nurse@plan.invalid", LOCAL_USER_NAME: "Nurse", ...extraEnv });
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${desk.server.address().port}`;
  try {
    await check({ base, desk, calls: p.calls });
  } finally {
    await desk.close();
    p.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function draft(base, desk, c) {
  await fetch(`${base}/api/cases/${c.id}/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await desk.drafting.get(c.id);
  return (await fetch(`${base}/api/cases/${c.id}`)).json();
}

test("on the running desk: an expedited request goes to its own agent with its own instruction, the others to the desk's", async () => {
  await runDesk({ AGENT_EXPEDITED: "agent-expedited" }, async ({ base, desk, calls }) => {
    const list = await (await fetch(base + "/api/cases")).json();
    const expedited = list.find((c) => c.fields.urgency === "Expedited");
    const standard = list.find((c) => c.fields.urgency === "Standard");
    const a = await draft(base, desk, expedited);
    assert.equal(a.status, "for_review");
    assert.equal(calls[0].agent_id, "agent-expedited");
    assert.ok(calls[0].messages[0].content.startsWith("EXPEDITED INSTRUCTION"));
    assert.equal(a.drafts[0].agent_id, "agent-expedited", "the record names the agent that wrote the draft");
    const b = await draft(base, desk, standard);
    assert.equal(calls[1].agent_id, "agent-default");
    assert.ok(calls[1].messages[0].content.startsWith(BASE.draft.instruction));
    assert.equal(b.drafts[0].agent_id, "agent-default");
  });
});

test("a kind whose agent id is not set fails the draft in plain words and calls no agent", async () => {
  await runDesk({}, async ({ base, desk, calls }) => {
    const list = await (await fetch(base + "/api/cases")).json();
    const c = await draft(base, desk, list.find((x) => x.fields.urgency === "Expedited"));
    assert.equal(calls.length, 0);
    assert.match(c.last_error, /no agent is set for "expedited": set AGENT_EXPEDITED/);
    assert.equal(c.drafts.length, 0);
  });
});
