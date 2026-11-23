// The prior authorisation desk: the same server and rules as the regulatory
// change desk, with its own config. These tests cover what that config changes:
// the fields, the marks, the decisions and the register.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const cases = require("../lib/cases");
const { createDesk, loadConfig, demoCases } = require("../server");

const CONFIG = loadConfig({ DESK_CONFIG: "desks/prior-authorisation/desk.config.json" });
const intake = { email: "intake@plan.invalid", name: "Intake", source: "platform-sign-in" };
const nurse = { email: "nurse@plan.invalid", name: "Nurse", source: "platform-sign-in" };

const TABLE = [
  "Summary",
  "MRI of the lumbar spine, for member H-204817.",
  "",
  "Draft criteria review. For review by a clinical reviewer. Not issued.",
  "",
  "| # | Criterion | Policy source | Evidence in the request | Where | Mark | Reviewer should check |",
  "|---|---|---|---|---|---|---|",
  "| 1 | Pain for at least six weeks | HHP-MP-101 2.1 | About seven weeks | Referral note | met | Onset date |",
  "| 2 | Six weeks of conservative treatment | HHP-MP-101 2.2 | Five sessions | Physiotherapist's letter | partly met | A sixth week |",
  "| 3 | Findings that set the six weeks aside | HHP-MP-101 3.1 | Nothing supplied | Not in the request | not documented | Weakness |",
  "| 4 | Prescriber is a rheumatologist | HHP-PH-330 2.1 | A family doctor asked | Referral note | not met | Who prescribes |",
  "",
  "Proposed next step: ask the provider for more information: (1) the sixth week.",
].join("\n");

test("the four demo requests pass the desk's own intake rules", () => {
  const list = demoCases(CONFIG);
  assert.equal(list.length, 4);
  for (const r of list) assert.deepEqual(cases.validateIntake(CONFIG, r).errors, []);
});

test("the agent reads the request under the desk's own labels and heading", () => {
  const { fields } = cases.validateIntake(CONFIG, demoCases(CONFIG)[0]);
  const c = cases.newCase(CONFIG, fields, null, "feed");
  const prompt = cases.draftPrompt(CONFIG, c);
  assert.ok(prompt.includes("THE PRIOR AUTHORISATION REQUEST"));
  assert.ok(prompt.includes("Member reference: H-204817"));
  assert.ok(prompt.includes("Clinical information supplied:"));
  assert.ok(!prompt.includes("THE PUBLICATION"));
  assert.ok(!/regulator/i.test(prompt));
  assert.ok(prompt.includes("Never propose a denial"));
});

test("a request with no clinical information says so to the agent", () => {
  const { fields } = cases.validateIntake(CONFIG, { title: "X-ray", member_ref: "H-1", provider: "Dr B", requested_on: "2026-11-20" });
  const prompt = cases.draftPrompt(CONFIG, cases.newCase(CONFIG, fields, null, "feed"));
  assert.ok(prompt.includes("No clinical information was supplied"));
});

test("the criteria table is parsed with this desk's marks and their tones", () => {
  const rows = cases.parseGapTable(TABLE, CONFIG);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.mark), ["met", "partly met", "not documented", "not met"]);
  assert.deepEqual(rows.map((r) => r.tone), ["ok", "warn", "none", "err"]);
  assert.equal(rows[1].citation, "Physiotherapist's letter");
  assert.equal(cases.summaryOf(TABLE, CONFIG), "MRI of the lumbar spine, for member H-204817.");
});

test("the desk has no deny decision", () => {
  assert.deepEqual(CONFIG.decisions.map((d) => d.id), ["approve", "request_info", "refer", "send_back"]);
  assert.ok(!CONFIG.decisions.some((d) => /den(y|ial)|reject|refuse/i.test(`${d.id} ${d.label} ${d.outcome}`)));
});

const ALL_MET = TABLE.split("\n").filter((l) => !/^\| [234] \|/.test(l)).join("\n").replace(/Proposed next step:.*/, "Proposed next step: approve, every criterion is met");

test("the agent's proposed next step and whether every criterion is met are read from the draft", () => {
  assert.equal(cases.proposalOf(TABLE, CONFIG), "ask the provider for more information: (1) the sixth week.");
  assert.equal(cases.allPass(TABLE, CONFIG), false);
  assert.equal(cases.allPass(ALL_MET, CONFIG), true);
  assert.equal(cases.allPass("No table here.", CONFIG), null);
});

test("approving while a criterion is not marked met takes a reason; with every criterion met it does not", () => {
  const make = (text) => {
    const { fields } = cases.validateIntake(CONFIG, demoCases(CONFIG)[0]);
    const c = cases.newCase(CONFIG, fields, null, "feed");
    cases.recordDraft(c, text, "agent", "s1");
    return c;
  };
  assert.throws(() => cases.applyDecision(CONFIG, make(TABLE), "approve", nurse, ""), /needs a reason/);
  assert.equal(cases.applyDecision(CONFIG, make(TABLE), "approve", nurse, "The sixth session is in the attached letter.").decision, "issued");
  assert.equal(cases.applyDecision(CONFIG, make(ALL_MET), "approve", nurse, "").decision, "issued");
});

test("a request waiting for the provider takes no decision; the reply joins the clinical information and the agent is asked again", () => {
  const { fields } = cases.validateIntake(CONFIG, demoCases(CONFIG)[0]);
  const c = cases.newCase(CONFIG, fields, null, "feed");
  cases.recordDraft(c, TABLE, "agent", "s1");
  assert.throws(() => cases.addReply(CONFIG, c, "Too early.", nurse), /waiting/);
  cases.applyDecision(CONFIG, c, "request_info", nurse, "The sixth week of physiotherapy.");
  assert.equal(c.status, "info_requested");
  assert.throws(() => cases.applyDecision(CONFIG, c, "approve", nurse, "x"), /only while it is for review/);
  assert.throws(() => cases.addReply(CONFIG, c, "  ", nurse), /empty/);
  cases.addReply(CONFIG, c, "Sixth session attended on 20 November.", nurse, new Date("2026-11-24T08:00:00Z"));
  assert.equal(c.status, "sent_back");
  assert.ok(c.fields.text.endsWith("Provider's reply, 24 Nov 2026:\nSixth session attended on 20 November."));
  const prompt = cases.draftPrompt(CONFIG, c, null, { sessionKnown: true });
  assert.ok(prompt.includes("Sixth session attended on 20 November."));
  assert.ok(prompt.includes("The provider has replied."));
  assert.throws(() => cases.applyDecision(CONFIG, c, "approve", nurse, "x"), /needs a new draft/);
  cases.recordDraft(c, ALL_MET, "agent", "s1");
  assert.equal(cases.applyDecision(CONFIG, c, "approve", nurse, "").decision, "issued");
});

test("asking for information and referring need a note and reach the register with the request's own fields; only a referral closes the request", () => {
  for (const [id, outcome] of [["request_info", "info_requested"], ["refer", "referred"]]) {
    const { fields } = cases.validateIntake(CONFIG, demoCases(CONFIG)[2]);
    const c = cases.newCase(CONFIG, fields, intake, "officer");
    cases.recordDraft(c, TABLE, "agent", "s1");
    assert.throws(() => cases.applyDecision(CONFIG, c, id, nurse, ""), /needs a note/);
    const entry = cases.applyDecision(CONFIG, c, id, nurse, "Screening results are missing.");
    assert.equal(c.status, outcome);
    assert.equal(entry.decision, outcome);
    assert.equal(entry.member_ref, "H-330951");
    assert.equal(entry.provider, fields.provider);
    assert.equal(entry.issued_text, "");
    assert.equal(entry.text, undefined, "the clinical text stays out of the register");
    assert.throws(() => cases.applyDecision(CONFIG, c, "approve", nurse, ""), /only while it is for review/);
    if (outcome === "referred") assert.throws(() => cases.updateFields(CONFIG, c, { urgency: "Expedited" }, nurse), /closed/);
    else assert.equal(cases.updateFields(CONFIG, c, { urgency: "Expedited" }, nurse).fields.urgency, "Expedited");
  }
});

test("the person who entered a request cannot decide it", () => {
  const { fields } = cases.validateIntake(CONFIG, demoCases(CONFIG)[1]);
  const c = cases.newCase(CONFIG, fields, intake, "officer");
  cases.recordDraft(c, TABLE, "agent", "s1");
  assert.equal(cases.canDecide(CONFIG, c, intake).ok, false);
  assert.equal(cases.canDecide(CONFIG, c, nurse).ok, true);
});

test("an approved request issues a criteria review that names the member reference", () => {
  const { fields } = cases.validateIntake(CONFIG, demoCases(CONFIG)[1]);
  const c = cases.newCase(CONFIG, fields, null, "feed");
  cases.recordDraft(c, ALL_MET, "agent", "s1");
  cases.applyDecision(CONFIG, c, "approve", nurse, "");
  const doc = cases.issuedDocument(CONFIG, c);
  assert.ok(doc.startsWith("# Criteria review: Continuous glucose monitor"));
  assert.ok(doc.includes("Member reference: H-118302"));
  assert.ok(!/Not issued/.test(doc));
});

test("the desk runs end to end on its own config: seeded, drafted, decided, in the register, and with no sweeps", async () => {
  const platform = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_STARTED", thread_id: body.session_id || "sess-pa", run_id: "run-pa" })}\n\n`);
        for (const piece of TABLE.match(/.{1,60}/gs)) res.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: piece })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-desk-"));
  const desk = await createDesk({
    DESK_CONFIG: "desks/prior-authorisation/desk.config.json",
    DATA_DIR: dir,
    SEED_DEMO: "true",
    KATONIC_BASE_URL: platform.url,
    KATONIC_API_KEY: "kapi_test",
    KATONIC_AGENT_ID: "agent-pa",
    LOCAL_USER: nurse.email,
    LOCAL_USER_NAME: nurse.name,
  });
  await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${desk.server.address().port}`;
  const call = async (route, options = {}) => {
    const r = await fetch(base + route, { method: options.method || "GET", headers: { "Content-Type": "application/json" }, body: options.body ? JSON.stringify(options.body) : undefined });
    const text = await r.text();
    let data = text;
    try { data = JSON.parse(text); } catch (err) { /* csv */ }
    return { status: r.status, data };
  };
  try {
    assert.equal((await call("/api/config")).data.desk.id, "prior-authorisation");
    const list = (await call("/api/cases")).data;
    assert.equal(list.length, 4);
    assert.equal((await call("/api/sweeps")).status, 404);
    const mri = list.find((c) => /MRI/.test(c.fields.title));
    assert.equal((await call(`/api/cases/${mri.id}/draft`, { method: "POST" })).status, 202);
    await desk.drafting.get(mri.id);
    const drafted = (await call(`/api/cases/${mri.id}`)).data;
    assert.equal(drafted.status, "for_review");
    assert.equal(drafted.gap_rows.length, 4);
    const decided = await call(`/api/cases/${mri.id}/decision`, { method: "POST", body: { decision: "request_info", note: "Sixth week of physiotherapy." } });
    assert.equal(decided.data.status, "info_requested");
    assert.equal((await call(`/api/cases/${mri.id}/draft`, { method: "POST" })).status, 409);
    assert.equal(drafted.proposal, "ask the provider for more information: (1) the sixth week.");
    assert.equal(drafted.all_pass, false);
    const replied = await call(`/api/cases/${mri.id}/reply`, { method: "POST", body: { text: "Sixth session attended on 20 November." } });
    assert.equal(replied.status, 200);
    await desk.drafting.get(mri.id);
    const again = (await call(`/api/cases/${mri.id}`)).data;
    assert.equal(again.status, "for_review");
    assert.equal(again.drafts.length, 2);
    assert.ok(again.fields.text.includes("Provider's reply"));
    const csv = (await call("/api/register.csv")).data;
    assert.ok(String(csv).startsWith("case_id,title,member_ref,provider,requested_on"));
    assert.ok(String(csv).includes("info_requested"));
    assert.ok(String(csv).includes("H-204817"));
  } finally {
    await desk.close();
    platform.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CHECK = [
  "Completeness check",
  "",
  "| Item | Status | What was found |",
  "|---|---|---|",
  "| Member reference | complete | Present |",
  "| Clinical information of substance | incomplete | Two generic sentences |",
  "| More than one code | incomplete | Two codes |",
  "",
].join("\n");

test("the completeness check is read from the draft; an open required item holds approval, an open optional one does not", () => {
  const rows = cases.parseChecklist(CHECK + TABLE, CONFIG);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.status, r.blocking]), [["complete", true], ["incomplete", true], ["incomplete", false]]);
  assert.equal(cases.parseGapTable(CHECK + TABLE, CONFIG).length, 4, "the checklist rows are not taken for criteria");
  assert.equal(cases.allPass(CHECK + ALL_MET, CONFIG), false);
  assert.equal(cases.allPass(CHECK.replace("| incomplete | Two generic sentences |", "| complete | Specific |") + ALL_MET, CONFIG), true);
  assert.equal(cases.parseChecklist(TABLE, CONFIG), null);
  assert.ok(CONFIG.draft.instruction.includes("stop at the first gate that fails"));
});

test("approving writes an approval letter with a number, a period and the criteria met; asking for information writes a letter with what is needed", () => {
  const make = (i, text) => {
    const { fields } = cases.validateIntake(CONFIG, demoCases(CONFIG)[i]);
    const c = cases.newCase(CONFIG, fields, null, "feed");
    cases.recordDraft(c, text, "agent", "s1");
    return c;
  };
  const a = make(1, ALL_MET);
  const entry = cases.applyDecision(CONFIG, a, "approve", nurse, "", null, new Date("2026-11-24T09:00:00Z"));
  assert.equal(a.letters.length, 1);
  assert.match(a.letters[0].number, /^PA-20261124-[0-9A-F]{6}$/);
  assert.equal(entry.letter_number, a.letters[0].number);
  assert.ok(a.letters[0].text.includes("Authorisation period: 2026-11-24 to 2027-02-22."));
  assert.ok(a.letters[0].text.includes("- Pain for at least six weeks (HHP-MP-101 2.1)"));
  assert.ok(a.letters[0].text.includes("To: Dr M. Lindqvist"));
  assert.ok(!/H-118302[^\n]*\n[^\n]*name/i.test(a.letters[0].text));
  const b = make(2, TABLE);
  cases.applyDecision(CONFIG, b, "request_info", nurse, "The second conventional medicine tried.\nThe tuberculosis screening result.", null, new Date("2026-11-24T09:00:00Z"));
  assert.match(b.letters[0].number, /^PI-20261124-/);
  assert.ok(b.letters[0].text.includes("- The tuberculosis screening result."));
  assert.ok(b.letters[0].text.includes("Please send it by 2026-12-24."));
  assert.ok(b.letters[0].text.includes("This is not a decision on the request."));
  const r = make(0, TABLE);
  cases.applyDecision(CONFIG, r, "refer", nurse, "Criterion 4 is not met.");
  assert.equal((r.letters || []).length, 0, "a referral is internal and sends no letter");
});

test("the audit record has its eight sections, names who decided and what the agent proposed, and carries no patient name", () => {
  const { fields } = cases.validateIntake(CONFIG, demoCases(CONFIG)[3]);
  const c = cases.newCase(CONFIG, fields, null, "feed");
  cases.recordDraft(c, CHECK + TABLE, "agent", "s1", new Date(), { agent_id: "agent-pa", run_id: "run-9", library: "Harbourline coverage policies (invented)" });
  cases.applyDecision(CONFIG, c, "refer", nurse, "Criterion 4 is not met.");
  const doc = cases.issuedDocument(CONFIG, c);
  for (const h of ["## 1. Summary", "## 2. The request", "## 3. Completeness check", "## 4. Criterion by criterion", "## 5. Decision and reason", "## 6. Letters and replies", "## 7. Audit trail", "## 8. How this record was made"]) assert.ok(doc.includes(h), h);
  assert.ok(doc.includes("- Decided by: nurse@plan.invalid (platform sign-in)"));
  assert.ok(doc.includes("- The agent proposed: ask the provider for more information"));
  assert.ok(doc.includes("Agent: agent-pa. Runs: run-9."));
  assert.ok(doc.includes("Referred to the medical director by nurse@plan.invalid"));
  assert.ok(!/John Smith|date of birth/i.test(doc));
});

test("a review stopped at a gate yields its reason, not a table", () => {
  const stopped = ["Summary", "X.", "", CHECK, "Draft criteria review. For review by a clinical reviewer. Not issued.", "", "Gate 1 stopped the review: the request has no clinical information.", "", "Proposed next step: ask the provider for more information: (1) the notes."].join("\n");
  assert.equal(cases.gateNote(stopped, CONFIG), "Gate 1 stopped the review: the request has no clinical information.");
  assert.equal(cases.gateNote(CHECK + TABLE, CONFIG), "", "a draft with a criteria table has no gate note");
  assert.equal(cases.allPass(stopped, CONFIG), false);
});

test("the person who entered a request cannot decide it but can ask the agent to redo the review", () => {
  const { fields } = cases.validateIntake(CONFIG, demoCases(CONFIG)[0]);
  const c = cases.newCase(CONFIG, fields, intake, "officer");
  cases.recordDraft(c, TABLE, "agent", "s1");
  assert.throws(() => cases.applyDecision(CONFIG, c, "refer", intake, "x"), /cannot decide/);
  assert.equal(cases.applyDecision(CONFIG, c, "send_back", intake, "Look at criterion 2 again.").decision, "sent_back");
});

test("decisions are named by what was done, and a removal has a register row", () => {
  assert.equal(cases.decisionLabel(CONFIG, "referred"), "Referred to the medical director");
  assert.equal(cases.decisionLabel(CONFIG, "info_requested"), "Asked the provider for information");
  const { fields } = cases.validateIntake(CONFIG, demoCases(CONFIG)[0]);
  const c = cases.newCase(CONFIG, fields, null, "feed");
  cases.removeCase(CONFIG, c, nurse, "Entered twice.");
  const row = cases.removalEntry(CONFIG, c, nurse, "Entered twice.");
  assert.equal(row.decision, "removed");
  assert.equal(row.member_ref, "H-204817");
  assert.equal(row.note, "Entered twice.");
});

test("on the running desk: a redo drafts again by itself, an unreachable agent is said in plain words, and a removal reaches the register", async () => {
  let up = true;
  const platform = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        if (!up) return req.socket.destroy();
        const body = raw ? JSON.parse(raw) : {};
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_STARTED", thread_id: body.session_id || "sess-r", run_id: "run-r" })}\n\n`);
        for (const piece of TABLE.match(/.{1,60}/gs)) res.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: piece })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-desk-"));
  const desk = await createDesk({ DESK_CONFIG: "desks/prior-authorisation/desk.config.json", DATA_DIR: dir, SEED_DEMO: "true", KATONIC_BASE_URL: platform.url, KATONIC_API_KEY: "kapi_test", KATONIC_AGENT_ID: "agent-pa", LOCAL_USER: nurse.email, LOCAL_USER_NAME: nurse.name });
  await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${desk.server.address().port}`;
  const call = async (route, options = {}) => {
    const r = await fetch(base + route, { method: options.method || "GET", headers: { "Content-Type": "application/json" }, body: options.body ? JSON.stringify(options.body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  try {
    const list = (await call("/api/cases")).data;
    const a = list[0];
    await call(`/api/cases/${a.id}/draft`, { method: "POST" });
    await desk.drafting.get(a.id);
    await call(`/api/cases/${a.id}/decision`, { method: "POST", body: { decision: "send_back", note: "Look again at criterion 2." } });
    await desk.drafting.get(a.id);
    const redone = (await call(`/api/cases/${a.id}`)).data;
    assert.equal(redone.status, "for_review");
    assert.equal(redone.drafts.length, 2, "the redo drafted without a second request");
    up = false;
    const b = list[1];
    await call(`/api/cases/${b.id}/draft`, { method: "POST" });
    await desk.drafting.get(b.id);
    const failed = (await call(`/api/cases/${b.id}`)).data;
    assert.equal(failed.status, "new");
    assert.match(failed.last_error, /could not be reached/);
    await call(`/api/cases/${b.id}/remove`, { method: "POST", body: { note: "Entered twice." } });
    const reg = (await call("/api/register")).data;
    assert.ok(reg.some((r) => r.case_id === b.id && r.decision === "removed"));
  } finally {
    await desk.close();
    platform.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a library kept as files hands the agent the policy that matches the request, and no other", () => {
  const dir = path.join(__dirname, "..", "desks", "prior-authorisation", "policies");
  const docs = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({ name: f.replace(/\.md$/, ""), text: fs.readFileSync(path.join(dir, f), "utf8") }));
  assert.equal(docs.length, 4);
  const expect = ["HHP-MP-101", "HHP-MP-214", "HHP-PH-330", "HHP-MP-305"];
  demoCases(CONFIG).forEach((r, i) => {
    const c = cases.newCase(CONFIG, cases.validateIntake(CONFIG, r).fields, null, "feed");
    const got = cases.localPassages(CONFIG, c, docs, "Harbourline coverage policies (invented)", 1);
    assert.equal(got.length, 1, r.title);
    assert.ok(got[0].document.startsWith(expect[i]), `${r.title} -> ${got[0].document}`);
    const prompt = cases.draftPrompt(CONFIG, c, got, { maxChars: 15000 });
    assert.ok(prompt.includes("THE COVERAGE POLICIES"));
    assert.ok(prompt.length <= 15000, `prompt is ${prompt.length} characters`);
  });
});

test("a review stopped at gate 2, with a complete checklist and no criteria table, does not lean toward approval", () => {
  const complete = CHECK.replace("| incomplete | Two generic sentences |", "| complete | Specific |");
  const stopped = ["Summary", "X.", "", complete, "Draft criteria review. For review by a clinical reviewer. Not issued.", "", "Gate 2 stopped the review: no policy covers shoulder ultrasound.", "", "Proposed next step: refer to the medical director: gate 2."].join("\n");
  assert.equal(cases.allPass(stopped, CONFIG), false);
  assert.match(cases.gateNote(stopped, CONFIG), /^Gate 2 stopped/);
});

test("when the desk's own search finds no policy, the agent is told the library was searched", () => {
  const c = cases.newCase(CONFIG, cases.validateIntake(CONFIG, { title: "Physiotherapy", member_ref: "H-1", provider: "Dr B", requested_on: "2026-11-23" }).fields, null, "feed");
  const told = cases.draftPrompt(CONFIG, c, [], { searched: true });
  assert.ok(told.includes("returned nothing for this request"));
  assert.ok(!cases.draftPrompt(CONFIG, c, null).includes("returned nothing"));
});
