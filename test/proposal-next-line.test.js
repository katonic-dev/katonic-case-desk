// The proposal line: some models write the prefix on a line of its own and the
// proposal on the line below it. The desk reads that as the proposal too.

const test = require("node:test");
const assert = require("node:assert/strict");
const cases = require("../lib/cases");

const CONFIG = { draft: { proposalPrefix: "Proposal:", sections: [{ heading: "Draft response to the customer" }] } };

test("a proposal on the prefix's own line is read as before", () => {
  const text = ["Summary", "One line.", "", "Proposal: approve the response: upheld. Redress is a refund of USD 12.00."].join("\n");
  assert.equal(cases.proposalOf(text, CONFIG), "approve the response: upheld. Redress is a refund of USD 12.00.");
});

test("a proposal on the line below the prefix is read", () => {
  const text = ["Summary", "One line.", "", "Proposal:", "approve the response: upheld. Redress is a refund of USD 12.00."].join("\n");
  assert.equal(cases.proposalOf(text, CONFIG), "approve the response: upheld. Redress is a refund of USD 12.00.");
});

test("blank lines between the prefix and the proposal are skipped, and bold marks are dropped", () => {
  const text = ["**Proposal:**", "", "", "**approve the response: not upheld.** No redress."].join("\n");
  assert.equal(cases.proposalOf(text, CONFIG), "approve the response: not upheld. No redress.");
});

test("a prefix with nothing after it gives no proposal", () => {
  assert.equal(cases.proposalOf("Summary\nOne line.\n\nProposal:", CONFIG), "");
  assert.equal(cases.proposalOf("Proposal:\n\n", CONFIG), "");
});

test("a table row, a hash heading or a section heading under the prefix is not a proposal", () => {
  assert.equal(cases.proposalOf("Proposal:\n| 1 | Point | Claim |", CONFIG), "");
  assert.equal(cases.proposalOf("Proposal:\n## Draft review", CONFIG), "");
  assert.equal(cases.proposalOf("Proposal:\nDraft response to the customer\nDear customer,", CONFIG), "");
});

test("the first prefix line decides: a later one is not looked at", () => {
  const text = ["Proposal: approve the response: upheld.", "", "Proposal:", "refer to the team lead."].join("\n");
  assert.equal(cases.proposalOf(text, CONFIG), "approve the response: upheld.");
});

test("a desk with no proposal prefix has no proposal", () => {
  assert.equal(cases.proposalOf("Proposal:\napprove", { draft: {} }), "");
});
