// The page is plain browser code. These two small functions are lifted out of
// app.js and run on their own, so the phone jump bar and the proposal marker
// are tested without a browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").split("\r\n").join("\n");
function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  const end = src.indexOf("\n}\n", start);
  const m = start >= 0 && end > start ? [src.slice(start, end + 3)] : null;
  assert.ok(m, `${name} is in app.js`);
  return m[0];
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${lift("jumpLabels")}
${lift("leansApprove")}\n${lift("proposedDecision")}`, ctx);

test("jump bar: the first label defaults to Questionnaire, the second is the draft noun", () => {
  assert.deepEqual(Array.from(ctx.jumpLabels({ desk: { draftNoun: "assessment" }, case: {} })), ["Questionnaire", "Assessment"]);
  assert.deepEqual(Array.from(ctx.jumpLabels({ desk: { draftNoun: "review" }, case: { jumpLabel: "The case" } })), ["The case", "Review"]);
});

test("a decision may name one proposal prefix or a list; the longest match wins", () => {
  const config = { decisions: [
    { id: "approve", proposalPrefix: ["send the pack to the loan officer", "nothing differs"] },
    { id: "ask", proposalPrefix: "send the list" },
    { id: "refer", proposalPrefix: ["refer to", "send the differences to a banker"] },
    { id: "plain" },
  ] };
  assert.equal(ctx.proposedDecision(config, "Send the pack to the loan officer: all in order"), "approve");
  assert.equal(ctx.proposedDecision(config, "nothing differs, send to a banker to confirm"), "approve");
  assert.equal(ctx.proposedDecision(config, "send the list to the loan officer: ask for X"), "ask");
  assert.equal(ctx.proposedDecision(config, "send the differences to a banker: rate margin"), "refer");
  assert.equal(ctx.proposedDecision(config, "refer to the credit officer"), "refer");
  assert.equal(ctx.proposedDecision(config, "something else"), "");
  assert.equal(ctx.proposedDecision(config, ""), "");
});

test("an intake field with options is drawn as a list; one without is a text box", () => {
  const sandbox = { h: (tag, props, ...kids) => ({ tag, props, kids: kids.flat() }) };
  vm.createContext(sandbox);
  vm.runInContext(lift("Fields"), sandbox);
  const config = { intake: { fields: [
    { key: "kind", label: "Kind", required: true, options: ["A", "B"] },
    { key: "name", label: "Name", required: true },
  ] } };
  const out = sandbox.Fields({ config, form: { kind: "A" }, setForm() {} });
  const control = (label) => label.kids[label.kids.length - 1];
  const kind = control(out[0]);
  assert.equal(kind.tag, "select");
  assert.deepEqual(kind.kids.map((o) => o.props.value), ["", "A", "B"]);
  assert.equal(control(out[1]).tag, "input");
});

test("Approve is the filled button only when every row passes and the agent does not propose another decision", () => {
  const approve = { id: "approve" };
  assert.equal(ctx.leansApprove(true, "", approve), true);
  assert.equal(ctx.leansApprove(null, "", approve), true);
  assert.equal(ctx.leansApprove(true, "approve", approve), true);
  assert.equal(ctx.leansApprove(true, "refer", approve), false);
  assert.equal(ctx.leansApprove(false, "approve", approve), false);
});
