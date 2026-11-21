// The desk end to end against a fake platform: a publication arrives from the
// feed, the agent drafts, an officer asks a question, a second officer edits
// and approves, the register has the row. The fake answers /public/v1/chat the
// way the platform does (an event stream).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createDesk } = require("../server");

function fakePlatform() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.url === "/public/v1/chat") {
        const text = body.messages[0].content;
        const reply = text.includes("THE QUESTION") || (body.session_id && !text.includes("THE PUBLICATION"))
          ? "It comes from clause 4.2."
          : text.includes("What has")
            ? "- Guidelines on X - 2026-10-07 - changes Y - https://reg.invalid/x\nNothing else."
            : "Summary: a notice.\n\nDraft gap analysis. For review by a compliance officer. Not issued.\n1. Requirement A: covered [MTB-POL-014 4.1].";
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_STARTED", thread_id: body.session_id || "sess-42", run_id: "run-1" })}\n\n`);
        for (const piece of reply.match(/.{1,20}/gs)) res.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: piece })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

async function call(base, route, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch(`${base}${route}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}

async function waitFor(fn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

test("feed in, agent drafts, officer asks, second officer edits and approves, register has the row", async () => {
  const fake = await fakePlatform();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-"));
  const env = {
    DATA_DIR: dir,
    KATONIC_BASE_URL: fake.url,
    KATONIC_API_KEY: "kapi_test",
    KATONIC_AGENT_ID: "agent-1",
    INTAKE_TOKEN: "feed-secret",
    TRUST_SIGN_IN_HEADERS: "true",
    LOCAL_USER: "standin@local",
    PUBLIC_URL: "/apps/desk",
  };
  const desk = await createDesk(env);
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${desk.server.address().port}`;
  const asA = { "x-forwarded-email": "a@bank.invalid", "x-forwarded-preferred-username": "A" };
  const asB = { "x-forwarded-email": "b@bank.invalid", "x-forwarded-preferred-username": "B" };
  try {
    // The page and the files are served under the /apps path and without it.
    assert.equal((await call(base, "/apps/desk/")).status, 200);
    assert.ok(String((await call(base, "/")).data).includes('window.APP_BASE = "/apps/desk"'));
    assert.equal((await call(base, "/apps/desk/api/health")).data.store, "file");

    // The feed needs its token.
    assert.equal((await call(base, "/api/intake", { method: "POST", body: { title: "N" } })).status, 401);
    const intake = await call(base, "/api/intake", { method: "POST", headers: { "x-intake-token": "feed-secret" }, body: { title: "Notice 7", regulator: "Reg", published_on: "2026-11-02", text: "Firms must..." } });
    assert.equal(intake.status, 202);
    const id = intake.data.id;

    // The agent drafts; the case goes up for review with the session kept.
    const drafted = await waitFor(async () => {
      const c = (await call(base, `/api/cases/${id}`)).data;
      return c.status === "for_review" ? c : null;
    });
    assert.equal(drafted.drafts.length, 1);
    assert.equal(drafted.drafts[0].by, "agent");
    assert.equal(drafted.agent_session_id, "sess-42");
    assert.ok(drafted.drafts[0].text.includes("Not issued"));
    assert.equal(fake.calls[0].auth, "Bearer kapi_test");
    assert.equal(fake.calls[0].body.agent_id, "agent-1");
    assert.equal(fake.calls[0].body.stream, true);
    assert.ok(fake.calls[0].body.messages[0].content.includes("Title: Notice 7"));

    // Officer A asks the agent about it, on the same session.
    const chat = await call(base, `/api/cases/${id}/chat`, { method: "POST", headers: asA, body: { message: "Where does requirement 1 come from?" } });
    assert.equal(chat.status, 200);
    assert.equal(chat.data.conversation.length, 2);
    assert.equal(chat.data.conversation[1].content, "It comes from clause 4.2.");
    assert.equal(fake.calls[1].body.session_id, "sess-42");
    assert.equal(fake.calls[1].body.messages[0].content, "Where does requirement 1 come from?");

    // A decision without the sign-in header would be the stand-in; here B decides with an edit.
    const bad = await call(base, `/api/cases/${id}/decision`, { method: "POST", headers: asB, body: { decision: "send_back", note: "" } });
    assert.equal(bad.status, 409);
    const ok = await call(base, `/api/cases/${id}/decision`, { method: "POST", headers: asB, body: { decision: "approve", draft: drafted.drafts[0].text.replace("covered", "partly covered") } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.status, "issued");
    assert.equal(ok.data.decision.by, "b@bank.invalid");
    assert.equal(ok.data.drafts.length, 2);
    assert.ok(ok.data.issued_document.includes("partly covered"));

    // The register and the issued document.
    const reg = (await call(base, "/api/register")).data;
    assert.equal(reg.length, 1);
    assert.equal(reg[0].decided_by, "b@bank.invalid");
    assert.equal(reg[0].identity_source, "platform-sign-in");
    assert.equal(reg[0].arrived_via, "feed");
    const csv = await call(base, "/api/register.csv");
    assert.ok(String(csv.data).startsWith("case_id,title,regulator"));
    assert.ok(String(csv.data).includes("b@bank.invalid"));
    const issued = await call(base, `/api/cases/${id}/issued.md`);
    assert.ok(String(issued.data).startsWith("# Gap analysis: Notice 7"));

    // A closed case takes no new draft and no new decision.
    assert.equal((await call(base, `/api/cases/${id}/draft`, { method: "POST", body: {} })).status, 409);
    assert.equal((await call(base, `/api/cases/${id}/decision`, { method: "POST", headers: asA, body: { decision: "approve" } })).status, 409);

    // An officer drops one in: four eyes keeps them from deciding it.
    const dropped = await call(base, "/api/cases", { method: "POST", headers: asA, body: { title: "Notice 8", regulator: "Reg", published_on: "2026-11-03", draft: false } });
    assert.equal(dropped.status, 201);
    assert.equal(dropped.data.requested_by.email, "a@bank.invalid");
    await call(base, `/api/cases/${dropped.data.id}/draft`, { method: "POST", body: {} });
    await waitFor(async () => (await call(base, `/api/cases/${dropped.data.id}`)).data.status === "for_review");
    const self = await call(base, `/api/cases/${dropped.data.id}/decision`, { method: "POST", headers: asA, body: { decision: "approve" } });
    assert.equal(self.status, 409);
    assert.match(self.data.error, /cannot decide/);

    // A sweep finds a line and opens it as a case.
    const sweeps = await call(base, "/api/sweeps", { method: "POST", headers: asA, body: { regulator: "Reg", subject: "X", days: 30 } });
    assert.equal(sweeps.status, 200);
    assert.equal(sweeps.data[0].found.length, 1);
    const opened = await call(base, `/api/sweeps/${sweeps.data[0].id}/open`, { method: "POST", headers: asA, body: { index: 0 } });
    assert.equal(opened.status, 201);
    assert.equal(opened.data.arrived_via, "sweep");
    assert.equal(opened.data.fields.published_on, "2026-10-07");
    // The same line again: already on the desk.
    const again2 = await call(base, "/api/sweeps", { method: "POST", headers: asA, body: { regulator: "Reg", subject: "X", days: 30 } });
    assert.equal(again2.data[0].found[0].already, opened.data.id);
    assert.equal((await call(base, `/api/sweeps/${again2.data[0].id}/open`, { method: "POST", headers: asA, body: { index: 0 } })).status, 409);

    // A sweep the page starts does not hold the request open: it answers at
    // once and the page reads the status until the sweep is done.
    const before = (await call(base, "/api/sweeps")).data.length;
    const started = await call(base, "/api/sweeps", { method: "POST", headers: asA, body: { regulator: "Reg", subject: "X", days: 30, wait: false } });
    assert.equal(started.status, 202);
    assert.equal(started.data.expected, 1);
    await waitFor(async () => (await call(base, "/api/sweeps/status")).data.running === false);
    const status = (await call(base, "/api/sweeps/status")).data;
    assert.equal(status.done, 1);
    assert.equal(status.error, "");
    assert.equal((await call(base, "/api/sweeps")).data.length, before + 1);

    // Details can be corrected; a wrong entry is removed with a reason and leaves the open list.
    const fixed = await call(base, `/api/cases/${opened.data.id}`, { method: "PATCH", headers: asA, body: { subject: "Operational resilience" } });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.data.fields.subject, "Operational resilience");
    assert.equal((await call(base, `/api/cases/${opened.data.id}/remove`, { method: "POST", headers: asA, body: {} })).status, 409);
    const removed = await call(base, `/api/cases/${opened.data.id}/remove`, { method: "POST", headers: asA, body: { note: "duplicate" } });
    assert.equal(removed.data.status, "removed");

    // A sent-back case cannot be approved until it is re-drafted, and the redo carries the note.
    const sb = await call(base, "/api/intake", { method: "POST", headers: { "x-intake-token": "feed-secret" }, body: { title: "Notice 9", regulator: "Reg", published_on: "2026-11-04" } });
    await waitFor(async () => (await call(base, `/api/cases/${sb.data.id}`)).data.status === "for_review");
    const sentBack = await call(base, `/api/cases/${sb.data.id}/decision`, { method: "POST", headers: asB, body: { decision: "send_back", note: "Quote clause 4" } });
    assert.equal(sentBack.data.status, "sent_back");
    assert.equal((await call(base, `/api/cases/${sb.data.id}/decision`, { method: "POST", headers: asA, body: { decision: "approve" } })).status, 409);
    await call(base, `/api/cases/${sb.data.id}/draft`, { method: "POST", body: {} });
    const redone = await waitFor(async () => {
      const c = (await call(base, `/api/cases/${sb.data.id}`)).data;
      return c.status === "for_review" && c.drafts.length === 2 ? c : null;
    });
    const redoCall = fake.calls[fake.calls.length - 1];
    assert.ok(redoCall.body.messages[0].content.includes("Quote clause 4"));
    assert.ok(redoCall.body.messages[0].content.includes("Your previous draft is earlier in this conversation"));
    assert.ok(!redoCall.body.messages[0].content.includes("THE PREVIOUS DRAFT"), "the session has the old draft; it is not sent again");
    assert.ok(redoCall.body.messages[0].content.length <= 15000);
    assert.equal(redone.gap_rows, null, "the fake writes prose, so no table rows");

    // Records survive a restart.
    await desk.close();
    const again = await createDesk(env);
    assert.equal((await again.store.listCases()).length, 4);
    assert.equal((await again.store.listRegister()).length, 2);
    await again.store.close();
  } finally {
    fake.server.close();
    desk.server.close();
  }
});

test("without the agent configured the desk still takes cases and says what is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-"));
  const desk = await createDesk({ DATA_DIR: dir });
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${desk.server.address().port}`;
  try {
    const health = (await call(base, "/api/health")).data;
    assert.match(health.agent, /not configured/);
    assert.equal(health.identity, "stand-in");
    const c = await call(base, "/api/cases", { method: "POST", body: { title: "N", regulator: "R", published_on: "2026-01-01" } });
    assert.equal(c.status, 201);
    assert.equal(c.data.status, "new");
    const d = await call(base, `/api/cases/${c.data.id}/draft`, { method: "POST", body: {} });
    assert.equal(d.status, 503);
    assert.match(d.data.error, /KATONIC_API_KEY/);
  } finally {
    await desk.close();
  }
});
