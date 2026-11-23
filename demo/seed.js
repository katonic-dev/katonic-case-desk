// Loads the two demo publications into the desk's records as cases that
// arrived from the feed, without drafting. Run `npm run seed`, then start the
// desk and press "Ask the agent to draft" on each, or run
// `npm run seed -- --draft` with the agent configured to draft at once.

const fs = require("fs");
const path = require("path");
const { createDesk, demoCases } = require("../server");

async function main() {
  const envFile = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); // the desk's .env wins over an ambient key in the shell
    }
  }
  const draft = process.argv.includes("--draft");
  const desk = await createDesk(process.env);
  const publications = demoCases(desk.config);
  const existing = await desk.store.listCases();
  for (const p of publications) {
    if (existing.some((c) => c.fields.title === p.title)) {
      console.log(`already there: ${p.title}`);
      continue;
    }
    const { newCase, validateIntake } = require("../lib/cases");
    const { errors, fields } = validateIntake(desk.config, p);
    if (errors.length) throw new Error(errors.join("; "));
    const c = newCase(desk.config, fields, null, p.arrived_via || "feed");
    await desk.store.putCase(c);
    console.log(`added: ${p.title} (${c.id})`);
    if (draft) {
      if (!desk.agent.configured()) throw new Error(`agent not configured: ${desk.agent.missing().join(", ")}`);
      process.stdout.write("  drafting... ");
      const reply = await desk.agent.chat({ message: require("../lib/cases").draftPrompt(desk.config, c) });
      require("../lib/cases").recordDraft(c, reply.content, "agent", reply.sessionId);
      await desk.store.putCase(c);
      console.log(`done, ${reply.content.length} characters`);
    }
  }
  await desk.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
