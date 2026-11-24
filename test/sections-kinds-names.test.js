// Second round of desk settings: named sections of a long piece of writing,
// decisions and marks per kind of work, the label of a row's last line,
// display names in the story of a case, record ids kept whole, and working
// days in a due date.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const http = require("http");
const cases = require("../lib/cases");
const shared = require("../lib/page-shared");
const { createDesk, loadConfig } = require("../server");
const { canned } = require("../demo/fake-platform");

const PA = "desks/prior-authorisation/desk.config.json";
const BASE = loadConfig({ DESK_CONFIG: PA });

// ----- the page's own functions, lifted out of app.js and run on their own
const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").split("\r\n").join("\n");
function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `${name} is in app.js`);
  return src.slice(start, end + 3);
}
const node = (tag, props, ...kids) => ({ tag, props: props || {}, kids: kids.flat(Infinity) });
const sandbox = { h: node, React: { Fragment: "fragment", createElement: node } };
vm.createContext(sandbox);
vm.runInContext(["markClass", "Mark", "rowLabel", "CellText", "withIds", "tally", "visibleRows", "GapRows", "addWorkingDays", "workingDaysBetween", "dueOf", "fmtDay"].map(lift).join("\n"), sandbox);
const textOf = (n) => (n == null ? "" : typeof n === "string" ? n : n.kids.map(textOf).join(""));
const find = (n, pred, out = []) => {
  if (n && typeof n === "object") {
    if (pred(n)) out.push(n);
    for (const k of n.kids || []) find(k, pred, out);
  }
  return out;
};

// ----- sections of a long piece of writing
const SECTIONED = {
  draft: {
    proposalPrefix: "Proposal:",
    sections: [
      "Summary",
      "Draft review",
      { heading: "Draft response to the customer. Not sent.", title: "Draft response", hint: "Not sent." },
      { heading: "Entry for the log.", title: "Log entry" },
    ],
  },
};
const REPLY = [
  "Summary",
  "A short summary.",
  "",
  "Draft response to the customer. Not sent.",
  "(this heading is above the table, so it is not read as a section)",
  "",
  "Draft review. Not issued.",
  "",
  "| # | Point | Claim | Shows | Source | Mark | Note |",
  "|---|---|---|---|---|---|---|",
  "| 1 | One | a | b | CMP-1001 | ok | n |",
  "",
  "Draft response to the customer. Not sent.",
  "Dear Anselm,",
  "",
  "We looked at your account.<b>not markup</b>",
  "Line two of the same paragraph.",
  "",
  "Entry for the log.",
  "CMP-1001. Upheld.",
  "",
  "Proposal: approve the response.",
].join("\n");

test("sections: the text under a heading, after the table, up to the next heading or the proposal line", () => {
  const s = shared.parseSections(REPLY, SECTIONED);
  assert.deepEqual(s.map((x) => x.heading), ["Draft response to the customer. Not sent.", "Entry for the log."]);
  assert.equal(s[0].title, "Draft response");
  assert.equal(s[0].hint, "Not sent.");
  assert.equal(s[0].text, "Dear Anselm,\n\nWe looked at your account.<b>not markup</b>\nLine two of the same paragraph.");
  assert.equal(s[1].title, "Log entry");
  assert.equal(s[1].text, "CMP-1001. Upheld.");
  assert.ok(!s.some((x) => x.text.includes("Proposal:")), "the proposal line is not part of a section");
});

test("sections: a reply without the heading, or a desk without sections, gives none", () => {
  assert.deepEqual(shared.parseSections("Summary\nx\n\n| # | a | b | c | d | e | f |\n|---|\n| 1 | a | b | c | d | ok | n |\n\nProposal: approve", SECTIONED), []);
  assert.deepEqual(shared.parseSections(REPLY, { draft: { sections: ["Summary", "Draft review"] } }), [], "plain names are not cards");
  assert.deepEqual(shared.parseSections(REPLY, { draft: {} }), []);
  assert.deepEqual(shared.parseSections(REPLY, BASE), []);
  // A line that only contains the heading is not the heading.
  assert.deepEqual(shared.parseSections("Entry for the log. And more\ntext\n", SECTIONED), []);
  // A heading with nothing under it gives no card.
  assert.deepEqual(shared.parseSections("Entry for the log.\n\nProposal: x", SECTIONED), []);
});

test("sections: without a table the whole text is read, and the old string list still names the summary's next heading", () => {
  const plain = "Summary\nA line.\n\nEntry for the log.\nA log line.\n\nProposal: x";
  assert.equal(shared.parseSections(plain, SECTIONED)[0].text, "A log line.");
  const config = { ...BASE, draft: { ...BASE.draft, sections: ["Summary", "Draft review", { heading: "Entry for the log.", title: "Log" }] } };
  assert.equal(cases.summaryOf("Summary\nThe summary.\nDraft review\n| x |", config), "The summary.");
});

test("sections: replacing one section's text keeps the rest and the heading, and an emptied section can be filled again", () => {
  const a = shared.replaceSection(REPLY, SECTIONED, "Entry for the log.", "CMP-1001. Upheld, with an apology.");
  assert.equal(shared.parseSections(a, SECTIONED)[1].text, "CMP-1001. Upheld, with an apology.");
  assert.equal(shared.parseSections(a, SECTIONED)[0].text, shared.parseSections(REPLY, SECTIONED)[0].text);
  assert.ok(a.endsWith("Proposal: approve the response."));
  const emptied = shared.replaceSection(REPLY, SECTIONED, "Entry for the log.", "");
  assert.equal(shared.parseSections(emptied, SECTIONED).length, 1);
  const refilled = shared.replaceSection(emptied, SECTIONED, "Entry for the log.", "Again.");
  assert.equal(shared.parseSections(refilled, SECTIONED)[1].text, "Again.");
  assert.ok(refilled.includes("Proposal: approve the response."));
  assert.equal(shared.replaceSection(REPLY, SECTIONED, "No such heading", "x"), REPLY);
});

test("sections: stripped from the prose, and titled for the issued document", () => {
  const rest = shared.stripSections(REPLY, SECTIONED);
  assert.ok(!rest.includes("Dear Anselm") && !rest.includes("CMP-1001. Upheld"));
  assert.ok(rest.includes("Proposal: approve the response."));
  const titled = shared.retitle(REPLY, SECTIONED);
  assert.ok(titled.includes("## Draft response\nDear Anselm,"));
  assert.ok(titled.includes("## Log entry\nCMP-1001. Upheld."));
  assert.equal(shared.retitle("no sections here", SECTIONED), "no sections here");
});

test("the issued document carries the section text as approved, and a person's edit of it", () => {
  const config = { ...BASE, audit: undefined, draft: { ...BASE.draft, sections: SECTIONED.draft.sections, proposalPrefix: "Proposal:" } };
  const edited = shared.replaceSection(REPLY, SECTIONED, "Entry for the log.", "CMP-1001. Upheld by the officer.");
  const c = { fields: { title: "T", regulator: "r", published_on: "2026-11-01" }, drafts: [{ version: 1, text: REPLY, by: "agent" }, { version: 2, text: edited, by: "o@x.invalid" }], decision: { by: "o@x.invalid", at: "2026-11-24T10:00:00Z", note: "" } };
  const doc = cases.issuedDocument(config, c);
  assert.ok(doc.includes("We looked at your account."));
  assert.ok(doc.includes("CMP-1001. Upheld by the officer."));
  assert.ok(!doc.includes("Upheld.\n"), "the edited text replaced the agent's");
  assert.ok(doc.includes("## Draft response"));
});

test("the stand-in returns the section text from demo-replies.json as it is, and the desk reads the cards from it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sections-"));
  try {
    const config = { ...BASE, draft: { ...BASE.draft, sections: SECTIONED.draft.sections, proposalPrefix: "Proposal:" } };
    fs.writeFileSync(path.join(dir, "desk.config.json"), JSON.stringify(config));
    fs.writeFileSync(path.join(dir, "demo-replies.json"), JSON.stringify({ replies: { "Anselm": REPLY } }));
    const request = cases.draftPrompt(config, { fields: { title: "Anselm Drozdowich (CMP-1001)", member_ref: "M", provider: "P", requested_on: "2026-11-01", text: "x" }, drafts: [], decision: null }, null);
    const reply = canned(request, undefined, { DESK_CONFIG: path.join(dir, "desk.config.json") });
    assert.ok(reply.endsWith(REPLY), "the file's text, whole");
    assert.equal(shared.parseSections(reply, config).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----- decisions and marks per kind
const ROUTED = {
  ...BASE,
  routing: {
    field: "urgency",
    kinds: {
      expedited: { decisions: ["approve", "send_back"], marks: ["met", "not met"] },
      "Standard": { agentEnv: "X", decisions: [], marks: [] },
    },
  },
};
const fake = (urgency) => ({ id: "c1", fields: { urgency }, drafts: [], decision: null });

test("per kind: a kind names its decisions and marks; an unlisted kind, an empty list or no routing means all", () => {
  assert.deepEqual(cases.kindRules(ROUTED, fake("Expedited")), { kind: "expedited", decisions: ["approve", "send_back"], marks: ["met", "not met"] });
  assert.deepEqual(cases.kindRules(ROUTED, fake("Standard")), { kind: "Standard", decisions: null, marks: null }, "an empty list is not a list");
  assert.deepEqual(cases.kindRules(ROUTED, fake("Other")), { kind: "", decisions: null, marks: null });
  assert.deepEqual(cases.kindRules(BASE, fake("Expedited")), { kind: "", decisions: null, marks: null });
});

test("per kind: a decision the kind does not allow is refused, one it allows goes through", () => {
  const c = { ...fake("Expedited"), status: "for_review", requested_by: { email: "feed", source: "system" }, conversation: [], events: [], drafts: [{ version: 1, text: "x", by: "agent" }] };
  const who = { email: "r@x.invalid", source: "stand-in" };
  assert.throws(() => cases.applyDecision(ROUTED, c, "request_info", who, "need more"), /"Ask the provider[^"]*" is not a decision for this kind of .* \(expedited\)/s);
  assert.equal(c.status, "for_review", "nothing was recorded");
  const entry = cases.applyDecision({ ...ROUTED, rules: { ...ROUTED.rules, reasonToApproveUnmet: false } }, c, "approve", who, "");
  assert.equal(entry.decision, "issued");
  const other = { ...c, status: "for_review", fields: { urgency: "Standard" }, decision: null, events: [] };
  assert.equal(cases.applyDecision(ROUTED, other, "request_info", who, "need more").decision, "info_requested");
});

const TABLE = ["Summary", "A request.", "", "Draft criteria review. For review by a clinical reviewer. Not issued.", "", "| # | Criterion | Policy source | Evidence in the request | Where | Mark | Reviewer should check |", "|---|---|---|---|---|---|---|", "| 1 | Pain | HHP-MP-101 2.1 | Seven weeks | Note | met | Nothing |", "", "Proposed next step: approve, every criterion is met"].join("\n");

function platform() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_STARTED", thread_id: "sess-k", run_id: "run-k" })}\n\n`);
        for (const piece of TABLE.match(/.{1,60}/gs)) res.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: piece })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("on the running desk: page data carries the kind's decisions and marks, and the server refuses another decision", async () => {
  const p = await platform();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kinds-"));
  const file = path.join(dir, "desk.config.json");
  const config = { ...BASE, routing: { field: "urgency", kinds: { Expedited: { decisions: ["approve", "send_back"], marks: ["met", "not met"] } } }, rules: { ...BASE.rules, reasonToApproveUnmet: false }, demo: { file: path.resolve(__dirname, "..", "desks/prior-authorisation/cases.json"), key: "requests" } };
  fs.writeFileSync(file, JSON.stringify(config));
  const desk = await createDesk({ DESK_CONFIG: file, DATA_DIR: dir, SEED_DEMO: "true", DESK_RETRY_WAIT_MS: "50", KATONIC_BASE_URL: p.url, KATONIC_API_KEY: "kapi_test", KATONIC_AGENT_ID: "agent-default", LOCAL_USER: "nurse@plan.invalid", LOCAL_USER_NAME: "Nurse" });
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${desk.server.address().port}`;
  try {
    const list = await (await fetch(base + "/api/cases")).json();
    const exp = list.find((c) => c.fields.urgency === "Expedited");
    const std = list.find((c) => c.fields.urgency === "Standard");
    assert.deepEqual(exp.decisions_allowed, ["approve", "send_back"]);
    assert.deepEqual(exp.marks_allowed, ["met", "not met"]);
    assert.equal(exp.kind, "Expedited");
    assert.equal(std.decisions_allowed, null);
    assert.equal(std.marks_allowed, null);
    for (const c of [exp, std]) {
      await fetch(`${base}/api/cases/${c.id}/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      await desk.drafting.get(c.id);
    }
    const post = (id, body) => fetch(`${base}/api/cases/${id}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const refused = await post(exp.id, { decision: "refer", note: "to a doctor" });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /not a decision for this kind/);
    assert.equal((await (await fetch(`${base}/api/cases/${exp.id}`)).json()).status, "for_review");
    assert.equal((await post(std.id, { decision: "refer", note: "to a doctor" })).status, 200, "a kind that lists nothing allows everything");
    assert.equal((await post(exp.id, { decision: "approve" })).status, 200);
    assert.equal((await (await fetch(base + "/api/register")).json()).length, 2, "only the two decisions taken are in the register");
  } finally {
    await desk.close();
    p.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the page's tally lists the kind's marks, with zeros, and still counts a mark outside the list", () => {
  const config = { draft: { marks: { "in order": "In order", missing: "Missing", differs: "Differs", "outside policy": "Outside policy" } } };
  const rows = [{ mark: "in order" }, { mark: "in order" }, { mark: "differs" }, { mark: "" }];
  const text = (only) => Array.from(sandbox.tally(config, rows, only)).map((p) => p.text).join(", ");
  assert.equal(text(undefined), "2 in order, 1 differs, 1 unmarked", "no setting: as before");
  assert.equal(text(null), "2 in order, 1 differs, 1 unmarked");
  assert.equal(text(["in order", "missing", "differs"]), "2 in order, 0 missing, 1 differs, 1 unmarked");
  assert.equal(text(["in order", "differs"]), "2 in order, 1 differs, 1 unmarked");
  assert.equal(text(["in order"]), "2 in order, 1 differs, 1 unmarked", "a given mark outside the list is not hidden");
});

// ----- the label of a row's last line
function rowsOf(draft) {
  const config = { draft };
  const row = { n: "1", requirement: "Req", source: "Src", policy: "Pol", citation: "Cit", check: "Look at it", mark: "", markText: "", tone: "" };
  return sandbox.GapRows({ config, rows: [row] });
}
test("row labels: the last line is labelled Check unless rowLabels.check says otherwise, in both layouts", () => {
  const labelled = { rowLabels: { source: "S", policy: "P", citation: "C" } };
  const plain = {};
  const last = (tree, sel) => find(tree, (n) => n.props && typeof n.props.className === "string" && n.props.className.split(" ").includes(sel)).map(textOf);
  assert.deepEqual(last(rowsOf(labelled), "chk"), ["CheckLook at it"]);
  assert.deepEqual(last(rowsOf({ rowLabels: { ...labelled.rowLabels, check: "Note" } }), "chk"), ["NoteLook at it"]);
  assert.deepEqual(last(rowsOf(plain), "chk"), ["Check: Look at it"]);
  assert.deepEqual(last(rowsOf({ rowLabels: { check: "Reason" } }), "chk"), ["Reason: Look at it"]);
});

// ----- display names
test("display names: read from the address where they can be, else the address; a name the desk knows wins", () => {
  assert.equal(shared.displayName("l.officer@meridiantrust.invalid"), "L. Officer");
  assert.equal(shared.displayName("anselm.drozdowich@x.invalid"), "Anselm Drozdowich");
  assert.equal(shared.displayName("rosalind_heathcote-brae@x.invalid"), "Rosalind Heathcote Brae");
  assert.equal(shared.displayName("officer@example.invalid"), "officer@example.invalid", "one word: cannot be read");
  assert.equal(shared.displayName("j.smith2@x.invalid"), "j.smith2@x.invalid", "digits: not a name");
  assert.equal(shared.displayName("agent"), "agent");
  assert.equal(shared.displayName("desk"), "desk");
  assert.equal(shared.displayName("c.officer@x.invalid", [{ email: "c.officer@x.invalid", name: "Chloe Officer" }]), "Chloe Officer");
  assert.equal(shared.displayName("c.officer@x.invalid", [{ email: "c.officer@x.invalid", name: "c.officer@x.invalid" }]), "C. Officer");
});

// ----- record ids
test("record ids are wrapped whole, the characters unchanged", () => {
  const out = sandbox.withIds("See DOC-8203 and MTB-POL-031, then LAP-8002; LD-20261123-6A10E8 is new. Not 2026-11-23 or e-mail.", "t");
  const ids = out.filter((x) => typeof x === "object").map(textOf);
  assert.deepEqual(Array.from(ids), ["DOC-8203", "MTB-POL-031", "LAP-8002", "LD-20261123-6A10E8", "2026-11-23"]);
  assert.ok(out.filter((x) => typeof x === "object").every((n) => n.props.className === "id"));
  assert.equal(out.map(textOf).join(""), "See DOC-8203 and MTB-POL-031, then LAP-8002; LD-20261123-6A10E8 is new. Not 2026-11-23 or e-mail.", "a copy reads the same");
  assert.equal(sandbox.withIds("nothing here", "t"), "nothing here");
});

// ----- working days
test("due dates: working days run Monday to Friday; calendar days stay as they were", () => {
  const d = (s) => new Date(`${s}T00:00:00`);
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  // 2026-11-20 is a Friday.
  assert.equal(d("2026-11-20").getDay(), 5);
  assert.equal(iso(sandbox.addWorkingDays(d("2026-11-20"), 1)), "2026-11-23");
  assert.equal(iso(sandbox.addWorkingDays(d("2026-11-20"), 5)), "2026-11-27");
  assert.equal(iso(sandbox.addWorkingDays(d("2026-11-18"), 15)), "2026-12-09");
  assert.equal(iso(sandbox.addWorkingDays(d("2026-11-18"), 0)), "2026-11-18");
  assert.equal(sandbox.workingDaysBetween(d("2026-11-20"), d("2026-11-23")), 1);
  assert.equal(sandbox.workingDaysBetween(d("2026-11-23"), d("2026-11-20")), -1);
  assert.equal(sandbox.workingDaysBetween(d("2026-11-21"), d("2026-11-23")), 1, "from a Saturday");
  assert.equal(sandbox.workingDaysBetween(d("2026-11-23"), d("2026-11-23")), 0);
  const c = { fields: { received_on: "2026-11-18", urgency: "Standard" } };
  const calendar = { due: { field: "received_on", urgencyField: "urgency", standardDays: 15, expeditedDays: 5 } };
  const working = { due: { ...calendar.due, workingDays: true } };
  const now = d("2026-11-24");
  assert.equal(iso(sandbox.dueOf(calendar, c, now).date), "2026-12-03", "15 calendar days");
  assert.equal(iso(sandbox.dueOf(working, c, now).date), "2026-12-09", "15 working days");
  assert.equal(sandbox.dueOf(working, c, now).days, 11);
  assert.equal(sandbox.dueOf(working, c, d("2026-12-09")).text, "Due today");
  assert.match(sandbox.dueOf(working, c, d("2026-12-10")).text, /^Overdue since/);
  assert.equal(sandbox.dueOf(working, { fields: { received_on: "2026-11-18", urgency: "Expedited" } }, now).days, 1, "5 working days from the 18th is the 25th, so one is left");
});

test("a letter can write its dates as 8 Dec 2026 when dateStyle is long", () => {
  const config = JSON.parse(JSON.stringify(require("../desk.config.json")));
  const L = { title: "T", prefix: "XX", days: 14, toField: "title", opening: "O", fields: [], dateLine: "Please send it by {until}.", body: [], signature: "S" };
  const c = { fields: { title: "A" }, drafts: [], id: "1" };
  const who = { email: "a@b.invalid", name: "A" };
  const now = new Date("2026-11-24T09:00:00Z");
  config.letters = { info_requested: { ...L } };
  assert.ok(cases.letterFor(config, c, { outcome: "info_requested" }, who, "x", now).text.includes("Please send it by 2026-12-08."));
  config.letters.info_requested.dateStyle = "long";
  assert.ok(cases.letterFor(config, c, { outcome: "info_requested" }, who, "x", now).text.includes("Please send it by 8 Dec 2026.") && cases.letterFor(config, c, { outcome: "info_requested" }, who, "x", now).text.includes("Date: 24 Nov 2026"));
});

// ----- amounts and codes kept whole, cells with several lines, labels for each kind
test("an amount with its currency and a long code of capitals and digits are wrapped whole", () => {
  const out = sandbox.withIds("Sent USD 1,850.00 to XB82BRVN73201150000124 at TESLXTT1, not USD 37.50. Fee, USD 4,200, then 12 items.", "t");
  const ids = out.filter((x) => typeof x === "object").map(textOf);
  assert.deepEqual(Array.from(ids), ["USD 1,850.00", "XB82BRVN73201150000124", "TESLXTT1", "USD 37.50", "USD 4,200"]);
  assert.equal(out.map(textOf).join(""), "Sent USD 1,850.00 to XB82BRVN73201150000124 at TESLXTT1, not USD 37.50. Fee, USD 4,200, then 12 items.");
  assert.equal(sandbox.withIds("Plain words only, ACSC and AC04.", "t"), "Plain words only, ACSC and AC04.", "short codes are left alone");
});

test("a cell with <br> shows one line each, and a line that starts Label: shows the label apart", () => {
  const cls = (n, c) => find(n, (x) => x.props && typeof x.props.className === "string" && x.props.className.split(" ").includes(c)).map(textOf);
  const tree = sandbox.CellText({ text: "Held: XB82BRVN73201150000124<br>Corrected: XB82BRVN73201150000142<br />Rest of it", k: "p" });
  assert.equal(tree.length, 3);
  const box = node("div", {}, tree);
  assert.deepEqual(Array.from(cls(box, "clabel")), ["Held", "Corrected"]);
  assert.deepEqual(Array.from(cls(box, "cval")), ["XB82BRVN73201150000124", "XB82BRVN73201150000142"]);
  assert.equal(sandbox.CellText({ text: "One line. Note: not a label line", k: "p" }), "One line. Note: not a label line", "one line stays as it was");
});

test("a kind of work can carry its own row labels (through lookConfig, the one way)", () => {
  const config = { draft: { rowLabels: { source: "Evidence", citation: "Rule and source", check: "Note" } }, routing: { field: "kind", kinds: { A: { rowLabels: { citation: "Rule" } }, B: {} } } };
  const row = { n: "1", requirement: "Req", source: "Src", policy: "Pol", citation: "Cit", check: "Look", mark: "", markText: "", tone: "" };
  const labels = (kind) => find(sandbox.GapRows({ config: cases.lookConfig(config, { fields: { kind } }), rows: [row] }), (n) => n.props && n.props.className === "k").map(textOf);
  assert.deepEqual(Array.from(labels("B")), ["Evidence", "", "Rule and source", "Note"]);
  assert.deepEqual(Array.from(labels("A")), ["Evidence", "", "Rule", "Note"]);
});

test("the story of a case names a decision in the past tense where the desk gives the outcome a label, else by the button's label", () => {
  const who = { email: "r@x.invalid", source: "stand-in" };
  const mk = () => ({ ...fake("Standard"), status: "for_review", requested_by: { email: "feed", source: "system" }, conversation: [], events: [], drafts: [{ version: 1, text: "x", by: "agent" }] });
  const withLabels = { ...ROUTED, decisionLabels: { sent_back: "Asked the agent to redo the review" } };
  const a = mk();
  cases.applyDecision(withLabels, a, "send_back", who, "Cite clause 4");
  assert.equal(a.events[a.events.length - 1].what, "asked the agent to redo the review: Cite clause 4");
  const b = mk();
  const bare = { ...ROUTED, decisionLabels: {} };
  cases.applyDecision(bare, b, "send_back", who, "Cite clause 4");
  assert.match(b.events[b.events.length - 1].what, /^[a-z]/);
  assert.match(b.events[b.events.length - 1].what, /: Cite clause 4$/);
});

test("routing.other gives the decisions and marks of a kind the desk does not know", () => {
  const cfg = { routing: { field: "kind", kinds: { A: { decisions: ["approve"] } }, other: { decisions: ["refer", "send_back"], marks: ["unclear"] } } };
  const at = (k) => cases.kindRules(cfg, { fields: { kind: k } });
  assert.deepEqual(at("A").decisions, ["approve"]);
  assert.deepEqual(at("Z").decisions, ["refer", "send_back"]);
  assert.deepEqual(at("Z").marks, ["unclear"]);
  assert.equal(at("").decisions && at("").decisions.join(), "refer,send_back", "no value at all is an unknown kind too");
  const none = { routing: { field: "kind", kinds: { A: { decisions: ["approve"] } } } };
  assert.equal(cases.kindRules(none, { fields: { kind: "Z" } }).decisions, null, "without other, an unknown kind shows every decision as before");
});

test("a letter may write its dates as 24 Nov 2026; by default they stay as 2026-11-24", () => {
  const who = { email: "r@x.invalid", source: "stand-in" };
  const mk = () => ({ ...fake("Standard"), fields: { urgency: "Standard", name: "Ann" }, status: "for_review", requested_by: { email: "feed", source: "system" }, conversation: [], events: [], letters: [], drafts: [{ version: 1, text: "x", by: "agent" }] });
  const letter = (extra) => ({ ...ROUTED, letters: { info_requested: { title: "More", prefix: "ZZ", days: 7, opening: "Hello.", list: "note", listHeading: "Need", dateLine: "By {until}.", body: [], signature: "Desk", ...extra } } });
  const now = new Date("2026-11-24T10:00:00Z");
  const cfgOf = (extra) => ({ ...letter(extra), decisions: [...ROUTED.decisions, { id: "ask", label: "Ask", outcome: "info_requested", needsNote: true }], routing: undefined });
  const a = mk();
  cases.applyDecision(cfgOf({}), a, "ask", who, "One thing", null, now);
  assert.match(a.letters[0].text, /Date: 2026-11-24/);
  assert.match(a.letters[0].text, /By 2026-12-01./);
  const b = mk();
  cases.applyDecision(cfgOf({ dateStyle: "long" }), b, "ask", who, "One thing", null, now);
  assert.match(b.letters[0].text, /Date: 24 Nov 2026/);
  assert.match(b.letters[0].text, /By 1 Dec 2026./);
});
