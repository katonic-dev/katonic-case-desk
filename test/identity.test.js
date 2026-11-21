const test = require("node:test");
const assert = require("node:assert/strict");
const { readIdentity } = require("../lib/identity");

const headers = {
  "x-forwarded-email": "c.officer@bank.invalid",
  "x-forwarded-user": "kc-sub-1",
  "x-forwarded-preferred-username": "cofficer",
  "x-forwarded-groups": "compliance, audit",
};

test("the sign-in headers are believed only when told to", () => {
  const trusted = readIdentity(headers, { TRUST_SIGN_IN_HEADERS: "true" });
  assert.equal(trusted.email, "c.officer@bank.invalid");
  assert.equal(trusted.source, "platform-sign-in");
  assert.deepEqual(trusted.groups, ["compliance", "audit"]);

  const not = readIdentity(headers, { TRUST_SIGN_IN_HEADERS: "false", LOCAL_USER: "me@local" });
  assert.equal(not.email, "me@local");
  assert.equal(not.source, "stand-in");
});

test("with no header the stand-in is used even when trusted", () => {
  const id = readIdentity({}, { TRUST_SIGN_IN_HEADERS: "true", LOCAL_USER: "me@local", LOCAL_USER_NAME: "Me" });
  assert.equal(id.email, "me@local");
  assert.equal(id.name, "Me");
  assert.equal(id.source, "stand-in");
});
