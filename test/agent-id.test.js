// DESK_AGENT_ID: one key file, many desks. The variable names the agent when
// it is set in the process environment, whatever a settings file says.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAgentClient } = require("../lib/agent");
const { loadEnvFile } = require("../server");

const KEYS = { KATONIC_BASE_URL: "http://x.invalid", KATONIC_API_KEY: "kapi_test" };

test("without DESK_AGENT_ID the agent is KATONIC_AGENT_ID, as before", () => {
  const a = createAgentClient({ ...KEYS, KATONIC_AGENT_ID: "agent-a" });
  assert.equal(a.agentId, "agent-a");
  assert.deepEqual(a.missing(), []);
  assert.deepEqual(createAgentClient({ ...KEYS }).missing(), ["KATONIC_AGENT_ID"]);
});

test("DESK_AGENT_ID is the agent the desk calls, whatever KATONIC_AGENT_ID says", () => {
  const a = createAgentClient({ ...KEYS, KATONIC_AGENT_ID: "agent-a", DESK_AGENT_ID: "agent-desk" });
  assert.equal(a.agentId, "agent-desk");
  const alone = createAgentClient({ ...KEYS, DESK_AGENT_ID: "agent-desk" });
  assert.equal(alone.agentId, "agent-desk");
  assert.ok(alone.configured(), "DESK_AGENT_ID alone is enough");
});

test("a settings file overrides the process environment key by key, but not DESK_AGENT_ID", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-env-"));
  const file = path.join(dir, "shared.env");
  fs.writeFileSync(file, 'KATONIC_API_KEY="kapi_from_file"\nKATONIC_AGENT_ID=agent-in-file\nDESK_AGENT_ID=agent-in-file-too\n');
  try {
    const env = { KATONIC_API_KEY: "kapi_ambient", KATONIC_AGENT_ID: "agent-ambient", DESK_AGENT_ID: "agent-mine" };
    loadEnvFile(file, env);
    assert.equal(env.KATONIC_API_KEY, "kapi_from_file", "the file still wins for the other keys");
    assert.equal(env.KATONIC_AGENT_ID, "agent-in-file");
    assert.equal(env.DESK_AGENT_ID, "agent-mine");
    assert.equal(createAgentClient({ KATONIC_BASE_URL: "http://x.invalid", ...env }).agentId, "agent-mine");
    // Not set in the process: the file's value is used.
    const bare = {};
    loadEnvFile(file, bare);
    assert.equal(bare.DESK_AGENT_ID, "agent-in-file-too");
    // No file: nothing happens.
    loadEnvFile(path.join(dir, "missing.env"), bare);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
