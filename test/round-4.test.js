// Settings added after the desks were reviewed: a proposal that must name rows, a chip on a case,
// group headings, a filter on the count of marks, quiet marks, boxes that stack on a phone, labelled
// lines in the boxes, and the plain fixes to the page (one sign to a mark, errors beside the field).
// The page's own functions are lifted out of app.js and run on their own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const cases = require("../lib/cases");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "desk.config.json"), "utf8"));
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
vm.runInContext(["markClass", "Mark", "rowLabel", "CellText", "withIds", "tally", "Tally", "visibleRows", "GapRows", "documentLinkLabel", "Flag", "faultLines"].map(lift).join("\n"), sandbox);
const textOf = (n) => (n == null ? "" : typeof n === "string" ? n : (n.kids || []).map(textOf).join(""));
const find = (n, pred, out = []) => {
  if (n && typeof n === "object") {
    if (pred(n)) out.push(n);
    for (const k of n.kids || []) find(k, pred, out);
  }
  return out;
};
const cls = (n, c) => find(n, (x) => x.props && typeof x.props.className === "string" && x.props.className.split(" ").includes(c));

// ---- a proposal that must name the rows it rests on (draft.proposalNames) ----

const TPR = {
  desk: { id: "t", name: "T", caseNoun: "supplier", draftNoun: "assessment" },
  draft: {
    marks: { met: "Met", "partly met": "Partly met", "not met": "Not met", "not answered": "Not answered" },
    proposalPrefix: "Recommendation:",
    proposalNames: { marks: ["not met", "partly met", "not answered"], by: "source" },
  },
  intake: { fields: [{ key: "title", label: "Title", required: true }] },
};
const table = [
  "| # | Requirement | Standard | Answer | Evidence | Mark | Reason |",
  "|---|---|---|---|---|---|---|",
  "| 1 | Audit report | MTB-STD-041 2.1 | Yes | Report | not met | Old |",
  "| 2 | Encryption | MTB-STD-041 2.2 | Yes | Overview | met | Fine |",
  "| 3 | MFA | MTB-STD-041 2.3 | Admins only | Policy | partly met | Not all staff |",
  "| 4 | Incident notice | MTB-STD-041 2.4 | 72 hours | Terms | not met | Too slow |",
  "| 5 | Backups | MTB-STD-041 12.3 | - | - | not answered | Blank |",
].join("\n");
const reply = (proposal) => `Summary\nx\n\nDraft assessment. Not issued.\n\n${table}\n\n${proposal}`;

test("a proposal that names every row it must is complete: no notice", () => {
  const text = reply("Recommendation: do not recommend approval: requirements 2.1 and 2.4 are not met, 2.3 is partly met and 12.3 was not answered.");
  assert.deepEqual(cases.proposalGaps(text, TPR), []);
});

test("a proposal that leaves a row out names it, with the mark, in one quiet sentence", () => {
  const text = reply("Recommendation: ask the supplier for 2.1, 2.4 and 12.3.");
  const gaps = cases.proposalGaps(text, TPR);
  assert.deepEqual(gaps.map((g) => [g.ref, g.label]), [["2.3", "partly met"]]);
  assert.equal(cases.proposalNotice(gaps), "The proposal does not mention 2.3, which is marked partly met.");
});

test("a reference is a whole word: 2.3 is not found in 12.3, and 2.1 is not found in 2.10", () => {
  const text = reply("Recommendation: ask the supplier about 2.1, 2.4 and 12.3, and about 2.30 and 22.3.");
  assert.deepEqual(cases.proposalGaps(text, TPR).map((g) => g.ref), ["2.3"]);
  const t = reply("Recommendation: ask the supplier about 2.10.");
  assert.deepEqual(cases.proposalGaps(t, TPR).map((g) => g.ref), ["2.1", "2.3", "2.4", "12.3"]);
});

test("several rows with one mark share a sentence; two marks give two sentences", () => {
  const text = reply("Recommendation: ask about 12.3.");
  assert.equal(cases.proposalNotice(cases.proposalGaps(text, TPR)), "The proposal does not mention 2.1 and 2.4, which are marked not met. It does not mention 2.3, which is marked partly met.");
});

test("a row with no reference, a mark the desk did not name and a desk without the setting are not checked", () => {
  const noRef = reply("Recommendation: nothing.").replace("MTB-STD-041 2.1", "the standard");
  assert.ok(!cases.proposalGaps(noRef, TPR).some((g) => g.ref === "2.1"));
  const only = { ...TPR, draft: { ...TPR.draft, proposalNames: { marks: ["not answered"], by: "source" } } };
  assert.deepEqual(cases.proposalGaps(reply("Recommendation: nothing."), only).map((g) => g.ref), ["12.3"]);
  const none = { ...TPR, draft: { ...TPR.draft, proposalNames: undefined } };
  assert.deepEqual(cases.proposalGaps(reply("Recommendation: nothing."), none), []);
  assert.deepEqual(cases.proposalGaps(table, TPR), [], "no proposal line, no notice");
});

test("a proposal's gap is recorded in the case's story, and blocks nothing", () => {
  const config = { ...CONFIG, ...TPR, draft: { ...CONFIG.draft, ...TPR.draft } };
  const c = cases.newCase(config, { title: "A", regulator: "R", published_on: "2026-11-01" }, { email: "a@x.invalid", name: "A", source: "stand-in" }, "officer");
  cases.recordDraft(c, reply("Recommendation: ask about 2.1, 2.4 and 12.3."), "agent", "s1");
  const gaps = cases.noteProposalGaps(config, c);
  assert.equal(gaps.length, 1);
  const last = c.events[c.events.length - 1];
  assert.equal(last.who, "desk");
  assert.equal(last.what, "noted: the proposal of draft 1 does not mention 2.3, which is marked partly met.");
  assert.equal(c.status, "for_review", "nothing is blocked");
});

// ---- a chip on a case (case.flags) ----

const flagConfig = {
  ...CONFIG,
  case: {
    ...CONFIG.case,
    flags: [
      { label: "Over the limit", tone: "warn", field: "subject", matches: ["over the"] },
      { label: "Vulnerable customer", tone: "warn", reply: "Priority handling:", matches: ["vulnerable", "bereavement"] },
      { label: "Priority", tone: "warn", reply: "Priority handling:" },
    ],
  },
};
const aCase = (fields, status = "for_review") => ({ status, fields: { title: "T", ...fields } });

test("a flag from a case field shows when the field holds one of its words", () => {
  assert.deepEqual(cases.flagOf(flagConfig, aCase({ subject: "9 days, over the 5-day limit" }), ""), { label: "Over the limit", tone: "warn", title: "9 days, over the 5-day limit" });
  assert.equal(cases.flagOf(flagConfig, aCase({ subject: "2 days" }), ""), null);
});

test("a flag from the agent's reply reads a sentence that starts with its words; the first that fits wins", () => {
  const text = "Summary\nCategory: cards. Severity: high.\n\nProposal: approve the response: upheld. Priority handling: the customer may be vulnerable (a recent bereavement).";
  assert.equal(cases.flagOf(flagConfig, aCase({}), text).label, "Vulnerable customer");
  const urgent = "Proposal: approve the response: upheld. Priority handling: it is urgent, because the response is due.";
  assert.equal(cases.flagOf(flagConfig, aCase({}), urgent).label, "Priority");
  assert.equal(cases.flagOf(flagConfig, aCase({}), "Proposal: approve the response: upheld. No priority."), null);
});

test("a closed case, and a desk with no flags, show no chip", () => {
  const text = "Proposal: approve. Priority handling: vulnerable.";
  assert.equal(cases.flagOf(flagConfig, aCase({}, "issued"), text), null);
  assert.equal(cases.flagOf(CONFIG, aCase({}), text), null);
});

// ---- group headings and the filter on the count ----

const grouped = { ...CONFIG, draft: { ...CONFIG.draft, groupHeadings: true } };
const gtable = [
  "| # | Requirement | Source | Policy | Citation | Mark | Check |",
  "|---|---|---|---|---|---|---|",
  "| | Full year | | | | | |",
  "| 1 | Revenue | a | b | c | covered | |",
  "| | Outlook | | | | | |",
  "| 2 | Margin | a | b | c | not covered | |",
].join("\n");

test("a table row with only a requirement is a group heading: kept for the page, never counted or checked", () => {
  assert.deepEqual(cases.parseGapTable(gtable, grouped).map((r) => r.n), ["1", "2"]);
  const withHeads = cases.parseGapTable(gtable, grouped, { headings: true });
  assert.deepEqual(withHeads.map((r) => r.heading || r.n), ["Full year", "1", "Outlook", "2"]);
  assert.equal(cases.parseGapTable(gtable, CONFIG).length, 4, "without the setting the row is a row, as before");
});

const fconfig = { draft: { marks: { differs: "Differs", missing: "Missing", sourced: "Sourced" }, rowFilter: true, groupHeadings: true } };
const frows = [{ heading: "Full year" }, { n: "1", mark: "differs" }, { n: "2", mark: "sourced" }, { heading: "Outlook" }, { n: "3", mark: "sourced" }, { n: "4", mark: "missing" }];

test("a filter keeps the rows with a pressed mark, and a heading only while a row under it shows", () => {
  const rowsOf = (f) => Array.from(sandbox.visibleRows(frows, f).map((r) => r.heading || r.n));
  assert.deepEqual(rowsOf(null), ["Full year", "1", "2", "Outlook", "3", "4"]);
  assert.deepEqual(rowsOf([]), ["Full year", "1", "2", "Outlook", "3", "4"]);
  assert.deepEqual(rowsOf(["differs"]), ["Full year", "1"]);
  assert.deepEqual(rowsOf(["differs", "missing"]), ["Full year", "1", "Outlook", "4"]);
});

test("a heading is not counted, and each part of the count is a button with rowFilter", () => {
  assert.equal(Array.from(sandbox.tally(fconfig, frows)).map((p) => p.text).join(", "), "1 differs, 1 missing, 2 sourced");
  const picked = [];
  const out = sandbox.Tally({ config: fconfig, rows: frows, filter: ["missing"], onFilter: (f) => picked.push(f) });
  const buttons = find(out, (n) => n.tag === "button");
  assert.deepEqual(Array.from(buttons.map(textOf)), ["1 differs", "1 missing", "2 sourced"]);
  assert.deepEqual(Array.from(buttons.map((b) => b.props["aria-pressed"])), [false, true, false]);
  buttons[0].props.onClick();
  buttons[1].props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(picked)), [["missing", "differs"], []]);
  const plain = sandbox.Tally({ config: { draft: { marks: fconfig.draft.marks } }, rows: frows, filter: [], onFilter() {} });
  assert.equal(find(plain, (n) => n.tag === "button").length, 0, "without the setting the count is text, as before");
});

test("a heading row is drawn as a heading, and a quiet mark's row is marked quiet", () => {
  const config = { draft: { marks: { sourced: "Sourced" }, markTones: { sourced: "none" }, quietMarks: ["sourced"], rowLabels: { citation: "Evidence" } } };
  const out = sandbox.GapRows({ config, rows: [{ heading: "Full year" }, { n: "1", requirement: "R", mark: "sourced", tone: "none", source: "s", policy: "p", citation: "c", check: "k" }] });
  assert.deepEqual(Array.from(cls(out, "gaphead").map(textOf)), ["Full year"]);
  assert.match(cls(out, "gaprow")[0].props.className, /\bquiet\b/);
  const plain = sandbox.GapRows({ config: { draft: { ...config.draft, quietMarks: undefined } }, rows: [{ n: "1", requirement: "R", mark: "sourced", tone: "none", source: "s", policy: "p", citation: "c", check: "k" }] });
  assert.doesNotMatch(cls(plain, "gaprow")[0].props.className, /quiet/);
});

// ---- boxes and lines ----

const bconfig = { draft: { marks: { unmatched: "Unmatched" }, sideBySide: true, rowLabels: { source: "The item", policy: "Compared with", citation: "Ids", check: "Note" } } };
const brow = { n: "1", requirement: "R", mark: "unmatched", source: "STM-8101 (statement)<br>Amount: USD 12,480.00 credit<br>Date: 19 Nov 2026<br>Reference: INV-558210-AQ", policy: "No matched entry yet", citation: "STM-8101", check: "k" };

test("the two boxes take labelled lines, and stack on a phone only where the desk asks", () => {
  const stacked = sandbox.GapRows({ config: { draft: { ...bconfig.draft, stackOnPhone: true } }, rows: [brow] });
  assert.equal(cls(stacked, "pair")[0].props.className, "pair stack");
  const same = sandbox.GapRows({ config: bconfig, rows: [brow] });
  assert.equal(cls(same, "pair")[0].props.className, "pair", "without the setting the boxes are as before");
  assert.deepEqual(Array.from(cls(same, "clabel").map(textOf)), ["Amount", "Date", "Reference"]);
  assert.deepEqual(Array.from(cls(same, "cval").map(textOf)), ["USD 12,480.00 credit", "19 Nov 2026", "INV-558210-AQ"]);
  assert.equal(cls(same, "cline plain").length, 0);
  assert.equal(find(same, (n) => n.props && n.props.className === "cline plain").length, 1, "the first line has no label and is a plain line");
});

test("the one-box form takes labelled lines too", () => {
  const config = { draft: { ...bconfig.draft, singleValueMarks: ["unmatched"], rowLabels: { ...bconfig.draft.rowLabels, both: "What the search found" } } };
  const out = sandbox.GapRows({ config, rows: [{ ...brow, policy: brow.source }] });
  assert.equal(find(out, (n) => n.props && n.props.className === "pair one").length, 1);
  assert.deepEqual(Array.from(cls(out, "clabel").map(textOf)), ["Amount", "Date", "Reference"]);
  assert.doesNotMatch(textOf(out), /<br>/);
});

test("a label may hold letters, digits and spaces; lines with no label are a plain list", () => {
  const periods = sandbox.CellText({ text: "Corrected: USD 400.0 million<br>FY2024: USD 388.0 million<br>H1 2025: USD 190.1 million", k: "p" });
  const box = node("div", {}, periods);
  assert.deepEqual(Array.from(cls(box, "clabel").map(textOf)), ["Corrected", "FY2024", "H1 2025"]);
  const payments = sandbox.CellText({ text: "12 Nov 2026, 10:14, USD 120.00, Shop A<br>12 Nov 2026, 10:30, USD 80.00, Shop B", k: "p" });
  assert.deepEqual(Array.from(payments.map((n) => n.props.className)), ["cline plain", "cline plain"]);
  assert.equal(cls(node("div", {}, payments), "clabel").length, 0);
});

test("a mark with its own sign shows it whatever its tone", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "desk.css"), "utf8");
  const last = css.lastIndexOf("span.mark.has-icon::before");
  assert.ok(last > css.indexOf(".mark.tone-info::before") && last > css.indexOf(".mark.tone-plain::before"), "the rule that drops the tone's sign comes last and is the heavier");
  const info = sandbox.Mark({ config: { draft: { marks: { differs: "Differs" }, markIcons: { differs: "≠" } } }, mark: "differs", tone: "info" });
  assert.match(info.props.className, /tone-info has-icon/);
});

// ---- words and faults ----

test("the link to the issued document has the desk's own words where it gives them", () => {
  assert.equal(sandbox.documentLinkLabel({}), "Download the issued document");
  assert.equal(sandbox.documentLinkLabel({ audit: { linkLabel: "Download the record" } }), "Download the record");
  assert.equal(sandbox.documentLinkLabel({ desk: { documentLinkLabel: "Download the accepted draft" }, audit: { linkLabel: "x" } }), "Download the accepted draft");
});

test("intake faults come by field, in short words, and one line for each kind", () => {
  const { errors, fieldErrors } = cases.validateIntake(CONFIG, { title: "x", published_on: "1 Nov" });
  assert.ok(errors.length >= 2);
  assert.equal(fieldErrors.regulator, "Required.");
  assert.equal(fieldErrors.published_on, "Use the form YYYY-MM-DD.");
  assert.deepEqual(Array.from(sandbox.faultLines({ a: "Required.", b: "Required.", c: "Use the form YYYY-MM-DD." })), ["2 fields are required and empty. They are marked above.", "One date is not in the form YYYY-MM-DD. It is marked above."]);
  assert.deepEqual(Array.from(sandbox.faultLines({ a: "Required." })), ["One field is required and empty. It is marked above."]);
  assert.deepEqual(Array.from(sandbox.faultLines({})), []);
});

test("a chip shows its label and keeps the sentence as its hover text", () => {
  const out = sandbox.Flag({ flag: { label: "Priority", tone: "warn", title: "Priority handling: urgent." } });
  assert.equal(out.props.className, "flag f-warn");
  assert.equal(out.props.title, "Priority handling: urgent.");
  assert.equal(textOf(out), "Priority");
});

// ---- through the server ----

test("the server sends the notice, the chip and the faults by field", async () => {
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-r4-"));
  const config = {
    ...CONFIG,
    case: { ...CONFIG.case, flags: [{ label: "Priority", tone: "warn", reply: "Priority handling:" }] },
    draft: { ...CONFIG.draft, proposalPrefix: "Proposal:", proposalNames: { marks: ["not covered"], by: "citation" } },
  };
  fs.writeFileSync(path.join(dir, "desk.config.json"), JSON.stringify(config));
  const { createDesk } = require("../server");
  const desk = await createDesk({ DATA_DIR: dir, DESK_CONFIG: path.join(dir, "desk.config.json"), LOCAL_USER: "a.officer@example.invalid" });
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${desk.server.address().port}`;
  try {
    const bad = await fetch(`${base}/api/cases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "x", published_on: "1 Nov" }) });
    const body = await bad.json();
    assert.equal(bad.status, 400);
    assert.match(body.error, /Regulator is required/, "the one line is kept");
    assert.ok(body.errors.length >= 2);
    assert.equal(body.fields.regulator, "Required.");
    const c = cases.newCase(config, { title: "Notice", regulator: "R", published_on: "2026-11-01" }, null, "feed");
    const text = ["Summary", "x", "", "Draft gap analysis. Not issued.", "", "| # | Requirement | Source | Policy | Citation | Mark | Check |", "|---|---|---|---|---|---|---|", "| 1 | A | s | p | MTB-POL-014 4.1 | not covered | k |", "", "Proposal: send it back. Priority handling: urgent."].join("\n");
    cases.recordDraft(c, text, "agent", "s1");
    await desk.store.putCase(c);
    const out = await (await fetch(`${base}/api/cases/${c.id}`)).json();
    assert.equal(out.proposal_notice, "The proposal does not mention 4.1, which is marked not covered.");
    assert.deepEqual(out.proposal_gaps.map((g) => g.ref), ["4.1"]);
    assert.equal(out.flag.label, "Priority");
    assert.equal(out.flag.title, "Priority handling: urgent.");
  } finally {
    await desk.close();
  }
});
