const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cases = require("../lib/cases");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "desk.config.json"), "utf8"));
const officer = { email: "a.officer@example.invalid", name: "A. Officer", source: "stand-in" };
const second = { email: "b.officer@example.invalid", name: "B. Officer", source: "platform-sign-in" };

function dropped(by = officer, via = "officer") {
  const { errors, fields } = cases.validateIntake(CONFIG, { title: "Notice 1", regulator: "A regulator", published_on: "2026-11-01" });
  assert.deepEqual(errors, []);
  return cases.newCase(CONFIG, fields, via === "officer" ? by : null, via);
}

test("intake needs the required fields and a real date", () => {
  const { errors } = cases.validateIntake(CONFIG, { title: "x", published_on: "1 Nov" });
  assert.ok(errors.some((e) => e.includes("Regulator")));
  assert.ok(errors.some((e) => e.includes("YYYY-MM-DD")));
});

test("a new case is new, with the arrival on record", () => {
  const c = dropped();
  assert.equal(c.status, "new");
  assert.equal(c.requested_by.email, officer.email);
  assert.match(c.events[0].what, /arrived via officer/);
});

test("the draft prompt carries the instruction and the publication", () => {
  const c = dropped();
  const p = cases.draftPrompt(CONFIG, c);
  assert.ok(p.includes("Not issued"));
  assert.ok(p.includes("Title: Notice 1"));
  assert.ok(p.includes("No text was supplied"));
});

test("the agent's draft puts the case up for review", () => {
  const c = dropped();
  cases.recordDraft(c, "Draft gap analysis. Not issued.\n\n1. ...", "agent", "sess-1");
  assert.equal(c.status, "for_review");
  assert.equal(c.agent_session_id, "sess-1");
  assert.equal(c.drafts.length, 1);
});

test("four eyes: the person who dropped it in cannot decide it", () => {
  const c = dropped();
  cases.recordDraft(c, "draft", "agent", "s");
  assert.equal(cases.canDecide(CONFIG, c, officer).ok, false);
  assert.equal(cases.canDecide(CONFIG, c, second).ok, true);
  assert.throws(() => cases.applyDecision(CONFIG, c, "approve", officer, "", null), /cannot decide/);
});

test("a publication from the feed has no requester to exclude", () => {
  const c = dropped(null, "feed");
  cases.recordDraft(c, "draft", "agent", "s");
  assert.equal(cases.canDecide(CONFIG, c, officer).ok, true);
});

test("nothing can be decided before there is a draft", () => {
  const c = dropped();
  assert.equal(cases.canDecide(CONFIG, c, second).ok, false);
});

test("approving records who, when and what was issued; an edit becomes a version by the officer", () => {
  const c = dropped();
  cases.recordDraft(c, "Draft gap analysis. For review by a compliance officer. Not issued.\nRequirement 1: covered.", "agent", "s");
  const entry = cases.applyDecision(CONFIG, c, "approve", second, "", "Draft gap analysis. For review by a compliance officer. Not issued.\nRequirement 1: partly covered.");
  assert.equal(c.status, "issued");
  assert.equal(c.drafts.length, 2);
  assert.equal(c.drafts[1].by, second.email);
  assert.equal(entry.decision, "issued");
  assert.equal(entry.decided_by, second.email);
  assert.equal(entry.identity_source, "platform-sign-in");
  assert.equal(entry.draft_versions, 2);
  assert.ok(entry.issued_text.includes("partly covered"));
  const doc = cases.issuedDocument(CONFIG, c);
  assert.ok(doc.startsWith("# Gap analysis: Notice 1"));
  assert.ok(!/Not issued/.test(doc), "the issued document drops the draft heading");
  assert.ok(doc.includes("version 2 of 2"));
});

test("send back and no action need a note", () => {
  const c = dropped();
  cases.recordDraft(c, "draft", "agent", "s");
  assert.throws(() => cases.applyDecision(CONFIG, c, "send_back", second, "", null), /needs a note/);
  cases.applyDecision(CONFIG, c, "send_back", second, "Cite clause 4", null);
  assert.equal(c.status, "sent_back");
  // A sent-back case can be decided again after a new draft.
  cases.recordDraft(c, "draft 2", "agent", "s");
  const entry = cases.applyDecision(CONFIG, c, "no_action", second, "Bears on no policy", null);
  assert.equal(entry.decision, "no_action");
  assert.equal(c.status, "no_action");
});

test("a closed case cannot be decided again", () => {
  const c = dropped();
  cases.recordDraft(c, "draft", "agent", "s");
  cases.applyDecision(CONFIG, c, "approve", second, "", null);
  assert.equal(cases.canDecide(CONFIG, c, second).ok, false);
});

test("a sweep reply is parsed into lines that look like a publication", () => {
  const text = [
    "Here is what I found:",
    "- Guidelines on AI Risk Management - 2026-10-07 - sets expectations for FIs - https://www.mas.gov.sg/x",
    "1. **Consultation on payments** (15 October 2026) https://example.org/p",
    "Nothing else was returned for the period.",
  ].join("\n");
  const found = cases.parseSweep(text);
  assert.equal(found.length, 2);
  assert.equal(found[0].title, "Guidelines on AI Risk Management");
  assert.equal(found[0].date, "2026-10-07");
  assert.equal(found[0].link, "https://www.mas.gov.sg/x");
  assert.equal(found[1].title, "Consultation on payments");
  assert.equal(found[1].date, "15 October 2026");
});

test("a sent-back case cannot be decided until there is a new draft, and the redo carries the note", () => {
  const c = dropped(null, "feed");
  cases.recordDraft(c, "draft 1", "agent", "s");
  cases.applyDecision(CONFIG, c, "send_back", second, "Cite clause 4", null);
  assert.equal(c.status, "sent_back");
  const check = cases.canDecide(CONFIG, c, officer);
  assert.equal(check.ok, false);
  assert.match(check.reason, /new draft/);
  assert.throws(() => cases.applyDecision(CONFIG, c, "approve", officer, "", null), /new draft/);
  const p = cases.draftPrompt(CONFIG, c);
  assert.ok(p.includes("Cite clause 4"));
  assert.ok(p.includes("THE PREVIOUS DRAFT\ndraft 1"));
  cases.recordDraft(c, "draft 2", "agent", "s", new Date(), { agent_id: "agent-1", run_id: "run-2", library: "Lib v3" });
  assert.equal(c.status, "for_review");
  assert.ok(!cases.draftPrompt(CONFIG, c).includes("THE PREVIOUS DRAFT"), "a fresh draft after a new one carries no note");
  const entry = cases.applyDecision(CONFIG, c, "approve", officer, "", null);
  assert.equal(entry.library, "Lib v3");
  assert.equal(entry.agent_id, "agent-1");
  assert.equal(entry.run_ids, "run-2");
});

test("the draft message stays inside the platform's limit, and a failed redo does not need the old draft", () => {
  const c = dropped(null, "feed");
  const passages = Array.from({ length: 60 }, (_, i) => ({ document: "POL-" + i, library: "Lib", text: "x".repeat(400) }));
  const first = cases.draftPrompt(CONFIG, c, passages, { maxChars: 15000 });
  assert.ok(first.length <= 15000, "first draft message: " + first.length);
  assert.ok(first.includes("[1] POL-0"));
  cases.recordDraft(c, "d".repeat(14000), "agent", "s");
  cases.applyDecision(CONFIG, c, "send_back", second, "Fix row 3", null);
  const withSession = cases.draftPrompt(CONFIG, c, passages, { sessionKnown: true, maxChars: 15000 });
  assert.ok(withSession.length <= 15000 && withSession.includes("Fix row 3") && !withSession.includes("THE PREVIOUS DRAFT"));
  const noSession = cases.draftPrompt(CONFIG, c, passages, { sessionKnown: false, maxChars: 15000 });
  assert.ok(noSession.length <= 15000 && noSession.includes("THE PREVIOUS DRAFT") && noSession.includes("[cut to fit]"));
});

test("the gap table is parsed into rows with marks; prose gives null", () => {
  const text = [
    "Summary",
    "A notice about things.",
    "",
    "Draft gap analysis. For review by a compliance officer. Not issued.",
    "| # | Requirement | Source | Policy says | Citation | Mark | Reviewer should check |",
    "|---|---|---|---|---|---|---|",
    "| 1 | MFA on every account | s.3 | MFA required for critical systems | MTB-POL-033 6.2 | partly covered | Non-critical systems |",
    "| 2 | Encrypt removable media | s.5 | nothing | - | Not found in the policy library | Ask IT |",
  ].join("\n");
  const rows = cases.parseGapTable(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].mark, "partly covered");
  assert.equal(rows[0].citation, "MTB-POL-033 6.2");
  assert.equal(rows[1].mark, "not found");
  assert.equal(cases.summaryOf(text), "A notice about things.");
  assert.equal(cases.parseGapTable("1. Requirement: ... covered"), null);
});

test("details can be corrected while open; a wrong entry is removed with a reason; duplicates are found", () => {
  const c = dropped();
  cases.updateFields(CONFIG, c, { title: "Notice 1 (corrected)", link: "https://reg.invalid/n1" }, second);
  assert.equal(c.fields.title, "Notice 1 (corrected)");
  assert.match(c.events[c.events.length - 1].what, /details changed: title, link/);
  assert.throws(() => cases.updateFields(CONFIG, c, { published_on: "yesterday" }, second), /YYYY-MM-DD/);
  assert.ok(cases.findDuplicate([c], { link: "https://reg.invalid/n1/" }));
  assert.ok(cases.findDuplicate([c], { title: "notice 1 (CORRECTED)" }));
  assert.equal(cases.findDuplicate([c], { title: "Other" }), null);
  assert.throws(() => cases.removeCase(CONFIG, c, second, ""), /needs a note/);
  cases.removeCase(CONFIG, c, second, "duplicate of Notice 2");
  assert.equal(c.status, "removed");
  assert.equal(cases.findDuplicate([c], { title: "Notice 1 (corrected)" }), null, "a removed case is not a duplicate");
  assert.throws(() => cases.updateFields(CONFIG, c, { title: "x" }, second), /closed/);
});

test("the chat prompt carries the context only when the session is new", () => {
  const c = dropped();
  cases.recordDraft(c, "the draft", "agent", "s");
  assert.equal(cases.chatPrompt(CONFIG, c, "why?", true), "why?");
  assert.ok(cases.chatPrompt(CONFIG, c, "why?", false).includes("the draft"));
});

test("the records go to DATA_DIR, else the attached dataset, else a local folder", () => {
  const path = require("node:path");
  const { dataDir } = require("../lib/store");
  assert.equal(dataDir({ DATA_DIR: "/x/y", KATONIC_DATASET_PATH: "/data/ds" }).where, "DATA_DIR");
  const onDataset = dataDir({ KATONIC_DATASET_PATH: "/data/ds" });
  assert.equal(onDataset.dir, path.join("/data/ds", "desk-records"));
  assert.equal(onDataset.kept, true);
  assert.equal(dataDir({}).kept, false);
});
