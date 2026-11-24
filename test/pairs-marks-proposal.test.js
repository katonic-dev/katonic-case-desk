// Settings for a desk whose marks are not pass or fail (a screening desk): a
// sign of its own on each mark, the two values side by side, the proposal
// first, words round a bare number, and readable dates kept whole. The page's
// own functions are lifted out of app.js and run on their own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
vm.runInContext(["markClass", "Mark", "rowLabel", "CellText", "withIds", "tally", "visibleRows", "GapRows", "fmtDay", "show", "ProposalLead"].map(lift).join("\n"), sandbox);
const textOf = (n) => (n == null ? "" : typeof n === "string" ? n : (n.kids || []).map(textOf).join(""));
const find = (n, pred, out = []) => {
  if (n && typeof n === "object") {
    if (pred(n)) out.push(n);
    for (const k of n.kids || []) find(k, pred, out);
  }
  return out;
};

const base = {
  draft: {
    marks: { matches: "Matches", differs: "Differs", noted: "Noted" },
    markTones: { matches: "err", differs: "none", noted: "none" },
    rowLabels: { source: "Customer", policy: "List entry", citation: "Source", check: "Reason", both: "Customer and list entry" },
  },
};
const row = (over) => ({ n: 1, requirement: "Date of birth", source: "21 Jul 1990", policy: "2 Feb 1962", citation: "CUS-1005; WL-9001", check: "Twenty-eight years apart.", mark: "differs", tone: "none", ...over });

test("a mark with its own sign shows it; one without keeps the tone's sign", () => {
  const withIcon = sandbox.Mark({ config: { draft: { ...base.draft, markIcons: { differs: "≠" } } }, mark: "differs", tone: "none" });
  assert.match(withIcon.props.className, /has-icon/);
  assert.equal(find(withIcon, (n) => n.props && n.props.className === "mi").map(textOf)[0], "≠ ");
  assert.equal(textOf(withIcon).replace(/ /g, " "), "≠ Differs");
  const plain = sandbox.Mark({ config: base, mark: "differs", tone: "none" });
  assert.doesNotMatch(plain.props.className, /has-icon/);
  assert.equal(textOf(plain), "Differs");
});

test("a date written as 21 Jul 1990 is kept whole, like 2026-11-19", () => {
  const out = sandbox.withIds("Born 21 Jul 1990, listed 2 Feb 1962 and 2026-11-19; 31 Foo 2026 is not a date.", "t");
  const ids = Array.from(out.filter((x) => typeof x === "object").map(textOf));
  assert.deepEqual(ids, ["21 Jul 1990", "2 Feb 1962", "2026-11-19"]);
  assert.equal(out.map(textOf).join(""), "Born 21 Jul 1990, listed 2 Feb 1962 and 2026-11-19; 31 Foo 2026 is not a date.");
});

test("tallyLabels give the words for the count of marks", () => {
  const config = { draft: { marks: { matches: "Matches", "partly matches": "Partly matches", differs: "Differs" }, tallyLabels: { matches: "match", "partly matches": "partly match", differs: "differ" } } };
  const rows = [{ mark: "differs" }, { mark: "differs" }, { mark: "matches" }, { mark: "partly matches" }];
  assert.equal(Array.from(sandbox.tally(config, rows)).map((p) => p.text).join(", "), "1 match, 1 partly match, 2 differ");
  const none = { draft: { marks: { differs: "Differs" } } };
  assert.equal(Array.from(sandbox.tally(none, [{ mark: "differs" }])).map((p) => p.text).join(", "), "1 differs");
});

test("sideBySide: two boxes under their labels, the reason before the ids; without it the old lines", () => {
  const config = { draft: { ...base.draft, sideBySide: true } };
  const out = sandbox.GapRows({ config, rows: [row()] });
  const cells = find(out, (n) => n.props && /^cell /.test(n.props.className || ""));
  assert.equal(cells.length, 2);
  assert.deepEqual(Array.from(cells.map((c) => c.kids.map(textOf).join("|"))), ["Customer|21 Jul 1990", "List entry|2 Feb 1962"]);
  const kvs = find(out, (n) => n.props && n.props.className === "kvs")[0];
  assert.deepEqual(Array.from(find(kvs, (n) => n.props && /^kv /.test(n.props.className || "")).map((n) => n.props.className)), ["kv chk", "kv evid"]);
  assert.equal(find(kvs, (n) => n.props && n.props.className === "kv src").length, 0, "the values are not repeated as lines");
  const old = sandbox.GapRows({ config: base, rows: [row()] });
  assert.equal(find(old, (n) => n.props && n.props.className === "pair").length, 0);
});

test("sideBySide: a missing value says none held; a single-value mark with equal text is one box", () => {
  const config = { draft: { ...base.draft, sideBySide: true, singleValueMarks: ["noted"] } };
  const gap = sandbox.GapRows({ config, rows: [row({ policy: "" })] });
  assert.match(textOf(gap), /none held/);
  const same = sandbox.GapRows({ config, rows: [row({ mark: "noted", source: "SCR-1990, closed as a false positive", policy: "SCR-1990, closed as a false positive" })] });
  const one = find(same, (n) => n.props && n.props.className === "pair one");
  assert.equal(one.length, 1);
  assert.equal(find(one[0], (n) => n.props && /^cell /.test(n.props.className || "")).length, 1);
  assert.match(textOf(one[0]), /Customer and list entry/);
  const different = sandbox.GapRows({ config, rows: [row({ mark: "noted", source: "SCR-1990", policy: "None" })] });
  assert.equal(find(different, (n) => n.props && n.props.className === "pair one").length, 0, "two values that differ stay two boxes");
});

test("shownAs puts words round a value that stands alone; the plain list shows the value", () => {
  const config = { intake: { fields: [{ key: "score", label: "Match score", shownAs: "Match score {value}" }, { key: "alert", label: "Alert" }, { key: "received_on", label: "On", type: "date" }] } };
  assert.equal(sandbox.show(config, "score", "78"), "Match score 78");
  assert.equal(sandbox.show(config, "score", "78", true), "78");
  assert.equal(sandbox.show(config, "score", ""), "");
  assert.equal(sandbox.show(config, "alert", "SCR-2001"), "SCR-2001");
});

test("the proposal's first sentence leads, the reason follows", () => {
  const out = sandbox.ProposalLead({ text: "escalate. The entry names her as the spouse. The officer decides." });
  assert.equal(find(out, (n) => n.props && n.props.className === "pword").map(textOf)[0], "Escalate.");
  assert.equal(find(out, (n) => n.props && n.props.className === "preason").map(textOf)[0], "The entry names her as the spouse. The officer decides.");
  const short = sandbox.ProposalLead({ text: "clear" });
  assert.equal(find(short, (n) => n.props && n.props.className === "pword").map(textOf)[0], "Clear");
  assert.equal(find(short, (n) => n.props && n.props.className === "preason").length, 0);
});

test("once the case is decided the proposal is shown in the past tense", () => {
  const out = sandbox.ProposalLead({ text: "escalate. Reason.", past: true });
  assert.match(out.props.className, /past/);
  assert.equal(find(out, (n) => n.props && n.props.className === "plabel").map(textOf)[0], "The agent proposed");
});
