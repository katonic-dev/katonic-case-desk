// A table whose header names a "Mark" column that is not the sixth is read by that header:
// the cells between the first two and the mark are the row's lines, in order, and the cell after
// the mark is its last line. A table of seven columns, or one with no "Mark" header, is read as before.
const test = require("node:test");
const assert = require("node:assert/strict");
const cases = require("../lib/cases");

const config = (marks) => ({ draft: { marks: Object.fromEntries(marks.map((m) => [m, m])) } });

test("a six-column table with the mark fifth keeps its mark and its note", () => {
  const text = [
    "| # | Clause | What the clause says | What the file shows | Mark | Note |",
    "|---|---|---|---|---|---|",
    "| 1 | 1.2 | We pay for theft. | Taken from a forecourt; DOC-1 | applies | Theft, as the police report says |",
    "| 2 | no clause | No clause speaks of it | The key was in the vehicle; DOC-2 | wording silent | For the adjuster |",
  ].join("\n");
  const rows = cases.parseGapTable(text, config(["applies", "wording silent"]));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { ...rows[0] },
    { n: "1", requirement: "1.2", source: "We pay for theft.", policy: "Taken from a forecourt; DOC-1", citation: "", mark: "applies",
      markText: "applies", tone: "", check: "Theft, as the police report says" },
  );
  assert.equal(rows[1].mark, "wording silent");
  assert.equal(rows[1].check, "For the adjuster");
});

test("a five-column table with the mark fourth is read, and no longer dropped", () => {
  const text = [
    "| # | The letter must include | Where it comes from | Mark | Note |",
    "|---|---|---|---|---|",
    "| 1 | the claim id | the claim record | included | - |",
    "| 2 | the team | the claim record names none | cannot include | A handler adds it |",
  ].join("\n");
  const rows = cases.parseGapTable(text, config(["included", "cannot include"]));
  assert.deepEqual(rows.map((r) => [r.requirement, r.source, r.policy, r.mark, r.check]), [
    ["the claim id", "the claim record", "", "included", "-"],
    ["the team", "the claim record names none", "", "cannot include", "A handler adds it"],
  ]);
});

test("a seven-column table is read exactly as before", () => {
  const text = [
    "| # | Finding | Evidence | What the records show | Rule | Mark | Note |",
    "|---|---|---|---|---|---|---|",
    "| 1 | Where it is | PAY-1 | credited | No rule needed | confirmed | none |",
  ].join("\n");
  const [row] = cases.parseGapTable(text, config(["confirmed"]));
  assert.deepEqual([row.requirement, row.source, row.policy, row.citation, row.mark, row.check],
    ["Where it is", "PAY-1", "credited", "No rule needed", "confirmed", "none"]);
});

test("a six-column table whose header has no Mark column is read as before, with the mark sixth", () => {
  const text = [
    "| # | Requirement | Source | Policy | Citation | Result |",
    "|---|---|---|---|---|---|",
    "| 1 | Keep records | REG-1 | POL-2 | clause 4 | covered |",
  ].join("\n");
  const [row] = cases.parseGapTable(text, config(["covered"]));
  assert.equal(row.mark, "covered");
  assert.equal(row.citation, "clause 4");
});

test("a second table in one reply is read by its own header", () => {
  const text = [
    "| # | Item | What the report says | Source | Mark | Note |",
    "|---|---|---|---|---|---|",
    "| 1 | Policy | POL-1 | LR-1 | found | - |",
    "",
    "| # | Finding | Evidence | What the records show | Rule | Mark | Note |",
    "|---|---|---|---|---|---|---|",
    "| 1 | Status | PAY-1 | credited | No rule needed | confirmed | none |",
  ].join("\n");
  const rows = cases.parseGapTable(text, config(["found", "confirmed"]));
  assert.deepEqual(rows.map((r) => r.mark), ["found", "confirmed"]);
  assert.equal(rows[1].citation, "No rule needed");
});
