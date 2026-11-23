// The stand-in platform (demo/fake-platform.js) answers from the settings
// folder's own demo-replies.json when DESK_CONFIG names a folder that has one.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cases = require("../lib/cases");
const { createDesk, loadConfig } = require("../server");
const { canned, createServer } = require("../demo/fake-platform");

const PA = "desks/prior-authorisation/desk.config.json";
const CONFIG = loadConfig({ DESK_CONFIG: PA });

const REPLY = (name) =>
  [
    "Summary",
    `${name}: a stand-in summary line.`,
    "",
    "Draft criteria review. For review by a clinical reviewer. Not issued.",
    "",
    "| # | Criterion | Policy source | Evidence in the request | Where | Mark | Reviewer should check |",
    "|---|---|---|---|---|---|---|",
    `| 1 | Criterion for ${name} | HHP-MP-101 2.1 | Seven weeks | Note | met | Nothing |`,
    `| 2 | Second criterion | HHP-MP-101 2.2 | Nothing supplied | Not in the request | not documented | The sixth week |`,
    "",
    "Proposed next step: ask the provider for more information: (1) the sixth week.",
  ].join("\n");

function folder(withReplies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replies-"));
  fs.writeFileSync(path.join(dir, "desk.config.json"), JSON.stringify(CONFIG));
  fs.copyFileSync(path.join(__dirname, "..", "desks/prior-authorisation/cases.json"), path.join(dir, "cases.json"));
  if (withReplies) fs.writeFileSync(path.join(dir, "demo-replies.json"), JSON.stringify(withReplies));
  return { dir, env: { DESK_CONFIG: path.join(dir, "desk.config.json") } };
}

const caseWith = (title, extra = {}) => ({
  fields: { title, member_ref: "M-1", provider: "Dr P", requested_on: "2026-11-01", service_code: "1", diagnosis: "d", text: "Some clinical text.", urgency: "Standard", ...extra },
  drafts: [],
  decision: null,
  conversation: [],
});
const draftRequest = (title) => cases.draftPrompt(CONFIG, caseWith(title), null);
const marks = (text) => cases.parseGapTable(text, CONFIG).map((r) => r.mark);

test("a case is matched by a distinctive part of its title, ignoring case, and the reply says it is a stand-in", () => {
  const { dir, env } = folder({ replies: { MRI: REPLY("mri"), "glucose monitor": REPLY("glucose") } });
  try {
    const a = canned(draftRequest("MRI of the lumbar spine"), undefined, env);
    assert.match(a, /^\[Stand-in agent: canned text/);
    assert.match(a, /Criterion for mri/);
    assert.match(canned(draftRequest("Continuous GLUCOSE MONITOR, sensors"), undefined, env), /Criterion for glucose/);
    assert.match(canned(draftRequest("Lowercase mri case"), undefined, env), /Criterion for mri/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the stand-in's first line does not disturb the table, the summary or the proposal", () => {
  const { dir, env } = folder({ replies: { MRI: REPLY("mri") } });
  try {
    const reply = canned(draftRequest("MRI of the spine"), undefined, env);
    assert.deepEqual(marks(reply), marks(REPLY("mri")));
    assert.deepEqual(marks(reply), ["met", "not documented"]);
    assert.equal(cases.summaryOf(reply, CONFIG), "mri: a stand-in summary line.");
    assert.equal(cases.proposalOf(reply, CONFIG), cases.proposalOf(REPLY("mri"), CONFIG));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a case with no matching key gets the file's default; with no default, today's text; the redo note is carried", () => {
  const withDefault = folder({ replies: { MRI: REPLY("mri") }, default: REPLY("default") });
  const without = folder({ replies: { MRI: REPLY("mri") } });
  try {
    assert.match(canned(draftRequest("Something else"), undefined, withDefault.env), /Criterion for default/);
    assert.match(canned(draftRequest("Something else"), undefined, without.env), /Stand-in agent: canned text/);
    assert.doesNotMatch(canned(draftRequest("Something else"), undefined, without.env), /Criterion for/);
    const redo = canned(draftRequest("MRI of the spine") + "\nThe previous draft was sent back with this note: check 2.2", undefined, withDefault.env);
    assert.match(redo, /This is the redo; the note was: "check 2.2"/);
  } finally {
    fs.rmSync(withDefault.dir, { recursive: true, force: true });
    fs.rmSync(without.dir, { recursive: true, force: true });
  }
});

test("a question on the same session and a sweep are not answered with a draft", () => {
  const { dir, env } = folder({ replies: { MRI: REPLY("mri") }, default: REPLY("default") });
  try {
    assert.match(canned("Where is the six weeks?", "sess-1", env), /canned reply\./);
    assert.match(canned("What has the regulator published?", undefined, env), /not a search/);
    const asked = cases.chatPrompt(CONFIG, caseWith("MRI of the spine"), "Why?", false);
    assert.doesNotMatch(canned(asked, undefined, env), /Criterion for/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without a replies file, or without DESK_CONFIG, the stand-in answers exactly as before", () => {
  const { dir, env } = folder(null);
  try {
    const text = draftRequest("MRI of the lumbar spine without contrast");
    const before = canned(text, undefined, {});
    assert.equal(canned(text, undefined, env), before);
    assert.match(before, /Checked against coverage policy HHP-MP-101/);
    assert.equal(canned(text, undefined, { DESK_CONFIG: path.join(dir, "no-such-folder", "desk.config.json") }), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("on the running desk, drafting against the stand-in gives parsed marks from the settings folder", async () => {
  const { dir, env } = folder({ replies: { MRI: REPLY("mri") } });
  const standIn = createServer(env);
  await new Promise((r) => standIn.listen(0, "127.0.0.1", r));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "replies-data-"));
  const desk = await createDesk({ ...env, DATA_DIR: data, SEED_DEMO: "true", KATONIC_BASE_URL: `http://127.0.0.1:${standIn.address().port}`, KATONIC_API_KEY: "kapi_fake", KATONIC_AGENT_ID: "fake", LOCAL_USER: "nurse@plan.invalid", LOCAL_USER_NAME: "Nurse" });
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${desk.server.address().port}`;
  try {
    // The desk seeds its demo cases from cases.json in the settings folder.
    const list = await (await fetch(base + "/api/cases")).json();
    const mri = list.find((c) => /MRI/.test(c.fields.title));
    await fetch(`${base}/api/cases/${mri.id}/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await desk.drafting.get(mri.id);
    const c = await (await fetch(`${base}/api/cases/${mri.id}`)).json();
    assert.equal(c.status, "for_review");
    assert.deepEqual(c.gap_rows.map((r) => r.mark), ["met", "not documented"]);
    assert.match(c.drafts[0].text, /^\[Stand-in agent/);
  } finally {
    await desk.close();
    standIn.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});
