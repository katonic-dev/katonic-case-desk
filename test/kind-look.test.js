// A kind of work may word its marks and the lines of a row in its own way; an address in a row is a
// link; a decision's line in the story reads as a sentence.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const cases = require("../lib/cases");

const CONFIG = {
  desk: { caseNoun: "case", draftNoun: "file" },
  routing: {
    field: "kind",
    kinds: {
      Screening: { markLabels: { "supports concern": "Adverse" }, markTones: { neutral: "plain" }, rowLabels: { citation: "Article page" } },
      Alert: { marks: ["neutral"] },
    },
  },
  draft: {
    marks: { "supports concern": "Supports concern", neutral: "Neutral" },
    markTones: { "supports concern": "err", neutral: "none" },
    rowLabels: { source: "Evidence", citation: "Found at" },
  },
  decisions: [{ id: "open_case", label: "Open a case", outcome: "case_to_open", needsNote: true }],
  decisionLabels: { case_to_open: "Decided: open a case" },
  rules: {},
  intake: { fields: [{ key: "kind" }] },
};
const fake = (kind) => ({ fields: { kind } });

test("a kind's own wording is laid over the desk's, key by key", () => {
  const look = cases.lookConfig(CONFIG, fake("Screening"));
  assert.equal(look.draft.marks["supports concern"], "Adverse");
  assert.equal(look.draft.marks.neutral, "Neutral");
  assert.equal(look.draft.markTones.neutral, "plain");
  assert.equal(look.draft.markTones["supports concern"], "err");
  assert.deepEqual(look.draft.rowLabels, { source: "Evidence", citation: "Article page" });
  assert.equal(CONFIG.draft.marks["supports concern"], "Supports concern", "the desk's own setting is not changed");
});

test("a kind that names none of it, an unknown kind and a desk with no routing get the config as it is", () => {
  assert.equal(cases.lookConfig(CONFIG, fake("Alert")), CONFIG);
  assert.equal(cases.lookConfig(CONFIG, fake("Other")), CONFIG);
  const plain = { ...CONFIG, routing: undefined };
  assert.equal(cases.lookConfig(plain, fake("Screening")), plain);
});

test("an address in a row becomes a link and an id stays whole", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").split("\r\n").join("\n");
  const start = src.indexOf("function withIds(");
  const body = src.slice(start, src.indexOf("\n}\n", start) + 3);
  const node = (tag, props, ...kids) => ({ tag, props: props || {}, kids: kids.flat(Infinity) });
  const sandbox = { h: node, React: { Fragment: "fragment", createElement: node } };
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox);
  const out = sandbox.withIds("See http://localhost:8080/news/pages/ART-6003. Then ART-6004 on 2026-11-24.");
  const link = out.find((n) => n && n.tag === "a");
  assert.equal(link.props.href, "http://localhost:8080/news/pages/ART-6003", "the full stop is not part of the address");
  assert.equal(link.props.rel, "noopener noreferrer");
  assert.equal(JSON.stringify(out.filter((n) => n && n.tag === "span").map((n) => n.kids[0])), JSON.stringify(["ART-6004", "2026-11-24"]));
});

test("a decision's line in the story reads as a past sentence with its note", () => {
  const c = { id: "x", arrived_via: "feed", status: "for_review", fields: { kind: "Alert" }, requested_by: { source: "system", email: "feed" }, drafts: [{ version: 1, text: "t" }], events: [] };
  cases.applyDecision(CONFIG, c, "open_case", { email: "a@b.invalid", source: "local" }, "High priority", null);
  assert.equal(c.events[c.events.length - 1].what, "decided: open a case. Note: High priority");
});
