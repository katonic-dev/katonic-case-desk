// A decision the agent carries out (decisions[].act): the decision is recorded
// as any decision is, then the agent is sent one message, and its answer is kept
// as the outcome of the case. A fake agent stands in for the platform.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const cases = require("../lib/cases");
const { createDesk, loadConfig } = require("../server");

const BASE = loadConfig({});
const ACT = {
  instruction: "CARRY OUT WHAT WAS CONFIRMED. Use the bank's tools.",
  title: "What the bank's systems returned",
  waitingWords: ["waiting for approval", "awaiting approval"],
  followUp: "ASK AGAIN: read the current state and report. Change nothing.",
  doneStatus: "carried_out",
  waitingStatus: "waiting_approval",
  failedStatus: "not_carried_out",
};
const CARRY = { id: "carry_out", label: "Confirm and carry out", outcome: "issued", needsNote: false, act: ACT };

function withAct(extra = {}) {
  return {
    ...JSON.parse(JSON.stringify(BASE)),
    decisions: [...BASE.decisions, CARRY],
    statuses: { ...BASE.statuses, waiting_approval: "Waiting for approval", carried_out: "Carried out", not_carried_out: "Not carried out" },
    register: { ...BASE.register, columns: [...BASE.register.columns, "outcome"] },
    ...extra,
  };
}

const TABLE = ["Summary", "A notice.", "", "Draft gap analysis. For review by a compliance officer. Not issued.", "", "| # | Requirement | Source | Policy says | Citation | Mark | Reviewer should check |", "|---|---|---|---|---|---|---|", "| 1 | Block the card | Call | Lost | CRD-2001 | covered | Nothing |", "", "Proposal: carry out: block card CRD-2001."].join("\n");

// A fake agent. Replies for the act and the follow-up come from queues; an entry {fail: 503} is an error.
function platform(script) {
  const calls = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", async () => {
        const body = raw ? JSON.parse(raw) : {};
        const message = body.messages[0].content;
        calls.push({ body, message });
        const kind = message.includes("THE EARLIER OUTCOME") ? "again" : message.includes("THE PROPOSAL AS CONFIRMED") ? "act" : "draft";
        let item = kind === "draft" ? TABLE : (script[kind] || []).shift();
        if (item === undefined) item = kind === "act" ? "Done. Reference DSP-6002." : "Done again.";
        if (script.delay && kind !== "draft") await new Promise((r) => setTimeout(r, script.delay));
        if (item && item.fail) {
          res.writeHead(item.fail, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "down for now" }));
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_STARTED", thread_id: "sess-a", run_id: `run-${calls.length}` })}\n\n`);
        for (const piece of String(item).match(/.{1,40}/gs)) res.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: piece })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const A = { "x-forwarded-email": "a@bank.invalid", "x-forwarded-preferred-username": "A" };
const B = { "x-forwarded-email": "b@bank.invalid", "x-forwarded-preferred-username": "B" };

async function call(base, route, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch(`${base}${route}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = text;
  }
  return { status: r.status, data };
}

async function run(script, config, check, dataDir) {
  const p = await platform(script);
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "act-"));
  const file = path.join(dir, "desk.config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  const env = { DESK_CONFIG: file, DATA_DIR: dir, DESK_RETRY_WAIT_MS: "20", KATONIC_BASE_URL: p.url, KATONIC_API_KEY: "kapi_test", KATONIC_AGENT_ID: "agent-1", TRUST_SIGN_IN_HEADERS: "true" };
  const desk = await createDesk(env);
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${desk.server.address().port}`;
  try {
    await check({ base, desk, calls: p.calls, env, dir, file });
  } finally {
    await desk.close();
    p.server.close();
  }
}

// A case A dropped in and the agent drafted, ready for B to decide.
async function ready(base, desk, regulator = "Reg") {
  const made = await call(base, "/api/cases", { method: "POST", headers: A, body: { title: "Notice 7", regulator, published_on: "2026-11-02", text: "Block the card.", draft: false } });
  assert.equal(made.status, 201);
  await call(base, `/api/cases/${made.data.id}/draft`, { method: "POST", body: {} });
  await desk.drafting.get(made.data.id);
  const c = (await call(base, `/api/cases/${made.data.id}`)).data;
  assert.equal(c.status, "for_review");
  return c;
}
const actCalls = (calls) => calls.filter((c) => c.message.includes("THE PROPOSAL AS CONFIRMED") && !c.message.includes("THE EARLIER OUTCOME"));
const againCalls = (calls) => calls.filter((c) => c.message.includes("THE EARLIER OUTCOME"));
const wait = async (desk, id) => {
  while (desk.acting.has(id)) await desk.acting.get(id);
};

test("an act is filled in with defaults, its statuses get labels and its closing status is closed; a desk with no act is untouched", () => {
  const a = cases.actOf(BASE, { act: { instruction: "Do it" } });
  assert.equal(a.doneStatus, "carried_out");
  assert.equal(a.waitingStatus, "waiting_for_outcome");
  assert.equal(a.failedStatus, "not_carried_out");
  assert.equal(a.askAgainLabel, "Ask for the outcome again");
  assert.equal(a.retryLabel, "Try again");
  assert.deepEqual(a.waitingWords, []);
  assert.equal(cases.actOf(BASE, { id: "x" }), null);
  const cfg = cases.withActs(withAct());
  assert.equal(cfg.statuses.acting, "Carrying out");
  assert.ok(cfg.closedStatuses.includes("carried_out"));
  assert.ok(!cfg.closedStatuses.includes("waiting_approval"), "waiting and failed stay open");
  assert.equal(cfg.decisions.find((d) => d.id === "carry_out").act.title, "What the bank's systems returned");
  const plain = JSON.parse(JSON.stringify(BASE));
  assert.deepEqual(cases.withActs(JSON.parse(JSON.stringify(BASE))), plain, "a desk with no act is unchanged");
  assert.ok(!("acting" in BASE.statuses));
  assert.ok(cases.shape(BASE).closed.every((s) => ["issued", "no_action", "removed"].includes(s)));
});

test("waiting words are matched without regard to case; the stand-in line is not the agent's first line", () => {
  const act = cases.actOf(BASE, CARRY);
  assert.equal(cases.holdsWaitingWord(act, "All three are WAITING FOR APPROVAL."), true);
  assert.equal(cases.holdsWaitingWord(act, "Blocked. Reference DSP-6002."), false);
  assert.equal(cases.holdsWaitingWord(cases.actOf(BASE, { act: {} }), "waiting for approval"), false, "no waiting words: never waiting");
  assert.equal(cases.firstLine("[Stand-in agent: canned text.]\n\n**Waiting for approval.** Three requests."), "Waiting for approval. Three requests.");
});

test("the act message holds the instruction, the case, the draft as approved with the person's edit, the note, and the rule to read first", () => {
  const cfg = withAct();
  cfg.draft.proposalPrefix = "Proposal:";
  const c = cases.newCase(cfg, { title: "Notice 7", regulator: "Reg", published_on: "2026-11-02", text: "Block the card." }, { email: "a@bank.invalid", name: "A", source: "x" }, "officer");
  cases.recordDraft(c, TABLE, "agent", "s1");
  c.status = "for_review";
  const who = { email: "b@bank.invalid", name: "B", source: "x" };
  cases.applyDecision(cfg, c, "carry_out", who, "The customer confirmed by voice.", TABLE.replace("Lost", "Lost on the train"));
  const m = c.outcome.message;
  assert.ok(m.startsWith("CARRY OUT WHAT WAS CONFIRMED."));
  assert.ok(m.includes("Do nothing that is already done"), "the engine adds the rule to read the state first");
  assert.ok(m.includes("Title: Notice 7"));
  assert.ok(m.includes("THE PROPOSAL AS CONFIRMED (version 2, edited by the person who confirmed it)"));
  assert.ok(m.includes("Lost on the train"), "the draft as edited");
  assert.ok(m.includes("The customer confirmed by voice."));
  assert.equal(c.status, "acting");
  assert.equal(c.decision.outcome, "issued", "the decision is recorded as any decision is");
  assert.equal(c.decision.note, "The customer confirmed by voice.");
  c.outcome.answers.unshift({ at: "2026-11-24T10:00:00.000Z", text: "Waiting for approval. DSP-6002", by: "b@bank.invalid", step: "act", waiting: true });
  const f = cases.followUpPrompt(cfg, c);
  assert.ok(f.startsWith("ASK AGAIN"));
  assert.ok(f.includes("THE EARLIER OUTCOME") && f.includes("Waiting for approval. DSP-6002"));
  assert.ok(f.includes("block card CRD-2001") && !f.includes("| 1 | Block the card"), "the proposal's own line, not the table");
});

test("a decision the desk does not allow for the kind, or the person who entered the case, is refused before anything is sent", async () => {
  const cfg = withAct({ routing: { field: "regulator", kinds: { Narrow: { decisions: ["approve", "send_back"] } } } });
  await run({}, cfg, async ({ base, desk, calls }) => {
    const narrow = await ready(base, desk, "Narrow");
    const sent = calls.length;
    const refused = await call(base, `/api/cases/${narrow.id}/decision`, { method: "POST", headers: B, body: { decision: "carry_out" } });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /not a decision for this kind/);
    const open = await ready(base, desk, "Reg");
    const self = await call(base, `/api/cases/${open.id}/decision`, { method: "POST", headers: A, body: { decision: "carry_out" } });
    assert.equal(self.status, 409);
    assert.match(self.data.error, /cannot decide/);
    assert.equal(calls.length - sent, 1 + 0 + 0, "only the draft of the second case was asked for");
    assert.equal(actCalls(calls).length, 0);
    assert.equal((await call(base, "/api/register")).data.length, 0, "a refused decision records nothing");
  });
});

test("confirm: decision recorded, one message sent, the answer is the outcome; waiting keeps it open; asking again closes it; story, register, export and issued document show it", async () => {
  const script = { act: ["Waiting for approval. 3 requests were made: DSP-6002.\n\n- Block: waiting for approval\n- Dispute: waiting for approval"], again: ["All approved.\n\n- Block: applied\n- Dispute DSP-6002: opened"] };
  await run(script, withAct(), async ({ base, desk, calls }) => {
    const c = await ready(base, desk);
    const out = await call(base, `/api/cases/${c.id}/decision`, { method: "POST", headers: B, body: { decision: "carry_out", note: "Confirmed with the customer", draft: TABLE.replace("Lost", "Lost, on the train") } });
    assert.equal(out.status, 200);
    assert.equal(out.data.status, "acting", "the decision answers at once; the agent works on");
    assert.equal(out.data.decision.by, "b@bank.invalid");
    assert.equal(out.data.drafts.length, 2, "the person's edit is a new version, as for any decision");
    await wait(desk, c.id);
    const w = (await call(base, `/api/cases/${c.id}`)).data;
    assert.equal(w.status, "waiting_approval");
    assert.equal(w.outcome.state, "waiting");
    assert.equal(w.outcome.answers.length, 1);
    assert.equal(w.outcome.answers[0].by, "b@bank.invalid");
    assert.ok(w.outcome.at && w.outcome.text.includes("DSP-6002"));
    assert.equal(actCalls(calls).length, 1, "one click, one message");
    assert.ok(actCalls(calls)[0].message.includes("Lost, on the train") && actCalls(calls)[0].message.includes("Confirmed with the customer"));
    assert.equal(actCalls(calls)[0].body.session_id, c.agent_session_id, "on the case's own session");
    assert.ok(w.issued_document.includes("## What the bank's systems returned") && w.issued_document.includes("Waiting for approval"));
    // Waiting: it is not closed, and it cannot be drafted, decided again or removed.
    assert.equal((await call(base, `/api/cases/${c.id}/draft`, { method: "POST", body: {} })).status, 409);
    assert.equal((await call(base, `/api/cases/${c.id}/decision`, { method: "POST", headers: A, body: { decision: "approve" } })).status, 409);
    assert.equal((await call(base, `/api/cases/${c.id}/remove`, { method: "POST", headers: A, body: { note: "x" } })).status, 409);
    assert.equal((await call(base, `/api/cases/${c.id}`, { method: "PATCH", headers: A, body: { subject: "x" } })).status, 409);
    // The outcome cannot be asked for while it is not waiting.
    assert.equal((await call(base, `/api/cases/${c.id}/outcome/retry`, { method: "POST", headers: A, body: {} })).status, 409);
    const again = await call(base, `/api/cases/${c.id}/outcome/again`, { method: "POST", headers: A, body: {} });
    assert.equal(again.status, 200);
    assert.equal(again.data.status, "acting");
    await wait(desk, c.id);
    const d = (await call(base, `/api/cases/${c.id}`)).data;
    assert.equal(d.status, "carried_out");
    assert.equal(d.outcome.state, "done");
    assert.equal(d.outcome.answers.length, 2);
    assert.ok(d.outcome.answers[0].text.startsWith("All approved"), "newest first");
    assert.equal(d.outcome.answers[0].by, "a@bank.invalid", "who asked again");
    assert.equal(againCalls(calls).length, 1);
    assert.ok(againCalls(calls)[0].message.includes("Waiting for approval. 3 requests were made"), "the follow-up carries the earlier outcome");
    assert.equal(actCalls(calls).length, 1, "asking again does not send the act again");
    assert.equal((await call(base, `/api/cases/${c.id}/outcome/again`, { method: "POST", headers: A, body: {} })).status, 409, "a closed case is not asked again");
    // The story.
    const story = d.events.map((e) => e.what);
    const at = (re) => story.findIndex((s) => re.test(s));
    assert.ok(at(/^confirm and carry out/i) >= 0 || at(/carry out/i) >= 0);
    assert.ok(at(/sent the confirmed proposal to the agent to carry out/) > 0);
    assert.ok(at(/answered: waiting for approval/) > at(/sent the confirmed proposal/));
    assert.ok(at(/asked the agent for the outcome again/) > at(/answered: waiting for approval/));
    assert.ok(at(/answered again: carried out/) > at(/asked the agent for the outcome again/));
    assert.ok(d.issued_document.includes("All approved.") && d.issued_document.includes("asked again"));
    // The register: the decision, then a row for each answer, each with its first line.
    const reg = (await call(base, "/api/register")).data;
    assert.deepEqual(reg.map((r) => r.decision), ["issued", "waiting_approval", "carried_out"]);
    assert.equal(reg[1].outcome, "Waiting for approval. 3 requests were made: DSP-6002.");
    assert.equal(reg[2].outcome, "All approved.");
    assert.equal(reg[0].draft_versions, 2);
    const csv = (await call(base, "/api/register.csv")).data;
    assert.ok(csv.split("\n")[0].endsWith("outcome"));
    assert.ok(csv.includes("All approved."));
    // The page's settings say what the statuses mean.
    const cfg = (await call(base, "/api/config")).data;
    assert.equal(cfg.statuses.acting, "Carrying out");
    assert.ok(cfg.closedStatuses.includes("carried_out"));
  });
});

test("an agent that cannot be reached: the decision stands, the case is not carried out, and trying again sends the very same message once", async () => {
  const script = { act: [{ fail: 503 }, "Done. Reference RPL-7001."] };
  await run(script, withAct(), async ({ base, desk, calls }) => {
    const c = await ready(base, desk);
    await call(base, `/api/cases/${c.id}/decision`, { method: "POST", headers: B, body: { decision: "carry_out", note: "ok" } });
    await wait(desk, c.id);
    const f = (await call(base, `/api/cases/${c.id}`)).data;
    assert.equal(f.status, "not_carried_out");
    assert.equal(f.outcome.state, "failed");
    assert.match(f.outcome.error.message, /HTTP 503/);
    assert.equal(f.decision.by, "b@bank.invalid", "the decision stands");
    assert.equal(f.outcome.answers.length, 0);
    assert.equal(actCalls(calls).length, 1, "no automatic second try");
    assert.ok(f.events.some((e) => /could not carry it out/.test(e.what)));
    assert.equal((await call(base, `/api/cases/${c.id}/outcome/again`, { method: "POST", headers: A, body: {} })).status, 409, "a failed case is tried again, not asked again");
    const first = actCalls(calls)[0].message;
    const r = await call(base, `/api/cases/${c.id}/outcome/retry`, { method: "POST", headers: A, body: {} });
    assert.equal(r.status, 200);
    // A second click while it is on its way sends nothing more.
    const twice = await call(base, `/api/cases/${c.id}/outcome/retry`, { method: "POST", headers: A, body: {} });
    assert.ok([200, 202, 409].includes(twice.status));
    await wait(desk, c.id);
    assert.equal(actCalls(calls).length, 2, "one retry, one message");
    assert.equal(actCalls(calls)[1].message, first, "the same message");
    const d = (await call(base, `/api/cases/${c.id}`)).data;
    assert.equal(d.status, "carried_out");
    assert.equal(d.outcome.error, null);
    assert.equal(d.outcome.answers[0].step, "retry");
    assert.ok(d.events.some((e) => /tried again/.test(e.what)));
    const reg = (await call(base, "/api/register")).data;
    assert.deepEqual(reg.map((x) => x.decision), ["issued", "not_carried_out", "carried_out"]);
    assert.match(reg[1].outcome, /^Not carried out: .*HTTP 503/);
  });
});

test("a failed ask for the outcome leaves the case waiting: what was asked for earlier is not undone", async () => {
  const script = { act: ["Waiting for approval."], again: [{ fail: 503 }, "Approved. DSP-6002."] };
  await run(script, withAct(), async ({ base, desk }) => {
    const c = await ready(base, desk);
    await call(base, `/api/cases/${c.id}/decision`, { method: "POST", headers: B, body: { decision: "carry_out" } });
    await wait(desk, c.id);
    await call(base, `/api/cases/${c.id}/outcome/again`, { method: "POST", headers: A, body: {} });
    await wait(desk, c.id);
    const w = (await call(base, `/api/cases/${c.id}`)).data;
    assert.equal(w.status, "waiting_approval");
    assert.match(w.outcome.error.message, /HTTP 503/);
    assert.equal(w.outcome.answers.length, 1);
    await call(base, `/api/cases/${c.id}/outcome/again`, { method: "POST", headers: A, body: {} });
    await wait(desk, c.id);
    const d = (await call(base, `/api/cases/${c.id}`)).data;
    assert.equal(d.status, "carried_out");
    assert.equal(d.outcome.error, null);
  });
});

test("a double click, and two clicks at once, send the agent the act message once", async () => {
  await run({ delay: 150 }, withAct(), async ({ base, desk, calls }) => {
    const c = await ready(base, desk);
    const body = { decision: "carry_out", note: "x" };
    const [one, two] = await Promise.all([call(base, `/api/cases/${c.id}/decision`, { method: "POST", headers: B, body }), call(base, `/api/cases/${c.id}/decision`, { method: "POST", headers: B, body })]);
    assert.deepEqual([one.status, two.status].sort(), [200, 409]);
    const third = await call(base, `/api/cases/${c.id}/decision`, { method: "POST", headers: B, body });
    assert.equal(third.status, 409, "a reload and a click again");
    await wait(desk, c.id);
    assert.equal(actCalls(calls).length, 1);
    assert.equal((await call(base, "/api/register")).data.filter((r) => r.decision === "issued").length, 1, "one decision in the register");
    // Asking about the case while the agent works is held back.
    const d = (await call(base, `/api/cases/${c.id}`)).data;
    assert.equal(d.status, "carried_out");
  });
});

test("a case left carrying out when the desk stopped is marked not carried out when it starts again, and can be tried again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "act-"));
  let id;
  await run({ delay: 3000 }, withAct(), async ({ base, desk }) => {
    const c = await ready(base, desk);
    id = c.id;
    await call(base, `/api/cases/${c.id}/decision`, { method: "POST", headers: B, body: { decision: "carry_out" } });
    assert.equal((await call(base, `/api/cases/${c.id}`)).data.status, "acting");
  }, dir);
  await run({}, withAct(), async ({ base, calls }) => {
    const c = (await call(base, `/api/cases/${id}`)).data;
    assert.equal(c.status, "not_carried_out");
    assert.match(c.outcome.error.message, /the desk stopped before the agent answered/);
    assert.equal(calls.length, 0, "starting the desk sends nothing");
  }, dir);
});

test("the ask-for-the-outcome and retry routes need the agent to be configured and a case that has something sent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "act-"));
  const file = path.join(dir, "desk.config.json");
  fs.writeFileSync(file, JSON.stringify(withAct()));
  const desk = await createDesk({ DESK_CONFIG: file, DATA_DIR: dir });
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${desk.server.address().port}`;
  try {
    const made = await call(base, "/api/cases", { method: "POST", body: { title: "N", regulator: "R", published_on: "2026-01-01" } });
    assert.equal((await call(base, `/api/cases/${made.data.id}/outcome/again`, { method: "POST", body: {} })).status, 503);
    assert.equal((await call(base, "/api/cases/nope/outcome/again", { method: "POST", body: {} })).status, 404);
  } finally {
    await desk.close();
  }
  await run({}, withAct(), async ({ base: b, desk: d }) => {
    const c = await ready(b, d);
    const r = await call(b, `/api/cases/${c.id}/outcome/again`, { method: "POST", headers: A, body: {} });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /nothing sent to the agent/);
  });
});

// The stand-in platform plays an act from the settings folder's demo-replies.json.
test("the stand-in answers an act and a follow-up from actions and followUps, and fails one case once", async () => {
  const { canned, createServer } = require("../demo/fake-platform");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "act-replies-"));
  const cfg = withAct();
  fs.writeFileSync(path.join(dir, "desk.config.json"), JSON.stringify(cfg));
  fs.writeFileSync(
    path.join(dir, "demo-replies.json"),
    JSON.stringify({
      replies: { Alpha: "Summary\nAlpha." },
      actions: { Alpha: "Waiting for approval. Alpha requests made." },
      followUps: { Alpha: ["Still waiting for approval.", "All approved. DSP-6002."], Beta: "Beta is done." },
      actionDefault: "Nothing to carry out for this case.",
      failActionOnce: ["Beta"],
    }),
  );
  const env = { DESK_CONFIG: path.join(dir, "desk.config.json") };
  const c = (title) => cases.newCase(cfg, { title, regulator: "R", published_on: "2026-11-02", text: "t" }, { email: "a@x", name: "A", source: "x" }, "officer");
  const draftText = (title) => cases.draftPrompt(cfg, c(title), null);
  const actText = (title) => {
    const k = c(title);
    cases.recordDraft(k, "Summary\nS\n\nProposal: carry out: x", "agent", "s");
    k.status = "for_review";
    cases.applyDecision(cfg, k, "carry_out", { email: "b@x", name: "B", source: "x" }, "", null);
    return k.outcome.message;
  };
  const followText = (title) => {
    const k = c(title);
    cases.recordDraft(k, "Summary\nS\n\nProposal: carry out: x", "agent", "s");
    k.status = "for_review";
    cases.applyDecision(cfg, k, "carry_out", { email: "b@x", name: "B", source: "x" }, "", null);
    k.outcome.answers.unshift({ at: new Date().toISOString(), text: "Waiting for approval.", by: "b@x", step: "act" });
    return cases.followUpPrompt(cfg, k);
  };
  // A draft request is answered as before, an act from "actions", a follow-up from "followUps".
  assert.match(canned(draftText("Alpha notice"), undefined, env), /Summary\nAlpha\./);
  assert.match(canned(actText("Alpha notice"), undefined, env), /^\[Stand-in agent[^\n]*Not a real outcome[^\n]*\]\n\nWaiting for approval\. Alpha requests made\./);
  assert.doesNotMatch(canned(actText("Alpha notice"), undefined, env), /Summary/);
  const state = { failed: new Set(), asked: new Map() };
  assert.match(canned(followText("Alpha notice"), "s", env, state), /Still waiting for approval\./, "the first follow-up");
  assert.match(canned(followText("Alpha notice"), "s", env, state), /All approved\. DSP-6002\./, "the second");
  assert.match(canned(followText("Alpha notice"), "s", env, state), /All approved\. DSP-6002\./, "the last one repeats");
  assert.match(canned(followText("Beta notice"), "s", env, state), /Beta is done\./);
  assert.match(canned(actText("Gamma notice"), undefined, env), /Nothing to carry out for this case\./, "actionDefault");
  // A settings folder with none of the new keys answers an act with a plain line that changes nothing.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "act-replies-"));
  fs.writeFileSync(path.join(bare, "desk.config.json"), JSON.stringify(cfg));
  fs.writeFileSync(path.join(bare, "demo-replies.json"), JSON.stringify({ replies: { Alpha: "Summary\nAlpha." } }));
  assert.match(canned(actText("Alpha notice"), undefined, { DESK_CONFIG: path.join(bare, "desk.config.json") }), /Nothing was changed/);
  // failActionOnce: the first act message for Beta is an error, the second is answered; a draft is never failed.
  const server = createServer(env);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/public/v1/chat`;
  const post = (message) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: "x", messages: [{ role: "user", content: message }], stream: true }) });
  try {
    assert.equal((await post(draftText("Beta notice"))).status, 200);
    assert.equal((await post(actText("Beta notice"))).status, 503);
    const ok = await post(actText("Beta notice"));
    assert.equal(ok.status, 200);
    assert.equal((await post(actText("Alpha notice"))).status, 200, "other cases are not failed");
  } finally {
    server.close();
  }
});
