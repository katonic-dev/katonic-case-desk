// The history of a case reads as a sentence: the desk's own past-tense label of a decision where it has one.
const test = require("node:test");
const assert = require("node:assert/strict");

test("the history says what was decided in the desk's own past-tense words, else the button's label", () => {
  const cases = require("../lib/cases");
  const config = JSON.parse(JSON.stringify(require("../desk.config.json")));
  config.decisionLabels = { issued: "Accepted the draft" };
  const second = { email: "b.officer@example.invalid", name: "B. Officer", source: "stand-in" };
  const make = () => {
    const { fields } = cases.validateIntake(config, { title: "Notice 1", regulator: "A regulator", published_on: "2026-11-01" });
    const c = cases.newCase(config, fields, { email: "a.officer@example.invalid", name: "A. Officer", source: "stand-in" }, "officer");
    cases.recordDraft(c, "Draft gap analysis. For review by a compliance officer. Not issued.\nRequirement 1: covered.", "agent", "s");
    return c;
  };
  const withLabel = make();
  cases.applyDecision(config, withLabel, "approve", second, "");
  assert.match(withLabel.events[withLabel.events.length - 1].what, /^accepted the draft/);
  delete config.decisionLabels;
  const without = make();
  cases.applyDecision(config, without, "approve", second, "");
  assert.equal(without.events[without.events.length - 1].what, config.decisions.find((d) => d.id === "approve").label.toLowerCase());
});
