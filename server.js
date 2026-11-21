// The case desk: the server.
//
// A Node server with no web framework. It serves one React page (app.js) and
// the desk's API. App Studio runs `npm install` then `npm start`; it sets PORT
// and PUBLIC_URL (the app's /apps/<name> path). React comes from node_modules
// as a ready-made browser file, so there is no build step.
//
// What is real and what is a stand-in is set out in README.md.

const fs = require("fs");
const http = require("http");
const path = require("path");

const { openStore } = require("./lib/store");
const { readIdentity } = require("./lib/identity");
const { createAgentClient } = require("./lib/agent");
const cases = require("./lib/cases");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "desk.config.json"), "utf8"));

const FILES = {
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/desk.css": { file: "desk.css", type: "text/css; charset=utf-8" },
  "/vendor/react.js": { file: "node_modules/react/umd/react.production.min.js", type: "text/javascript; charset=utf-8" },
  "/vendor/react-dom.js": { file: "node_modules/react-dom/umd/react-dom.production.min.js", type: "text/javascript; charset=utf-8" },
};

function page(base) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${CONFIG.desk.name}</title>
<link rel="stylesheet" href="${base}/desk.css">
</head>
<body>
  <div id="root"></div>
  <script>window.APP_BASE = ${JSON.stringify(base)};</script>
  <script src="${base}/vendor/react.js"></script>
  <script src="${base}/vendor/react-dom.js"></script>
  <script src="${base}/app.js"></script>
</body>
</html>
`;
}

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function json(res, status, data) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(data));
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function csv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

// Builds the desk around a store and an agent client, so a test can hand it
// a temporary folder and a fake agent.
async function createDesk(env = process.env) {
  const store = await openStore(env);
  const agent = createAgentClient(env);
  const base = String(env.PUBLIC_URL || "").replace(/\/+$/, "");
  const drafting = new Map(); // case id -> promise, so a draft is not started twice

  function who(req) {
    return readIdentity(req.headers, env);
  }

  // A case as the page sees it: with the latest draft's gap table parsed into
  // rows and its summary picked out, so the page shows a table when there is
  // one and the text when there is not.
  function caseOut(c) {
    const latest = c.drafts.length ? c.drafts[c.drafts.length - 1] : null;
    return { ...c, gap_rows: latest ? cases.parseGapTable(latest.text) : null, summary: latest ? cases.summaryOf(latest.text).split("**").join("") : "" };
  }

  async function runDraft(c, by) {
    const statusBefore = c.status;
    c.status = "drafting";
    c.events.push({ at: new Date().toISOString(), who: by, what: "draft requested from the agent" });
    await store.putCase(c);
    const p = (async () => {
      try {
        // Where the library cannot be attached to the agent, the desk searches
        // it with its own key and hands the passages over.
        let passages = null;
        const libraryId = env.KATONIC_LIBRARY_SOURCE_ID || "";
        if (libraryId) {
          const seen = new Map();
          for (const q of cases.libraryQueries(c)) {
            for (const p of await agent.search({ query: q, sourceIds: [libraryId], topK: 8 })) if (p.text && !seen.has(p.text)) seen.set(p.text, p);
          }
          passages = [...seen.values()].slice(0, 40);
        }
        const reply = await agent.chat({ message: cases.draftPrompt(CONFIG, c, passages, { sessionKnown: Boolean(c.agent_session_id), maxChars: Number(env.KATONIC_MAX_MESSAGE_CHARS) || 15000 }), sessionId: c.agent_session_id || undefined });
        const fresh = await store.getCase(c.id);
        cases.recordDraft(fresh, reply.content, "agent", reply.sessionId, new Date(), {
          agent_id: agent.agentId,
          run_id: reply.runId || "",
          library: passages
            ? `${(passages[0] && passages[0].library) || env.KATONIC_LIBRARY_NAME || "policy library"} (searched by the desk: ${passages.length} passages)`
            : env.KATONIC_LIBRARY_NAME || "",
          tools: reply.tools || [],
          warning: reply.warning || "",
        });
        fresh.last_error = "";
        await store.putCase(fresh);
      } catch (err) {
        const fresh = await store.getCase(c.id);
        // A failed draft changes nothing: a sent-back case stays sent back, so
        // the draft that was rejected cannot be approved.
        fresh.status = statusBefore === "drafting" ? (fresh.drafts.length ? "for_review" : "new") : statusBefore;
        fresh.last_error = err.message;
        fresh.events.push({ at: new Date().toISOString(), who: "agent", what: `draft failed: ${err.message}` });
        await store.putCase(fresh);
      } finally {
        drafting.delete(c.id);
      }
    })();
    drafting.set(c.id, p);
    return p;
  }

  async function createCase(fields, user, via, autoDraft) {
    const c = cases.newCase(CONFIG, fields, user, via);
    await store.putCase(c);
    if (autoDraft && agent.configured()) runDraft(c, user ? user.email : via);
    return c;
  }

  // Asks the agent once per regulator and records each answer as a sweep.
  let sweepRun = { running: false, started_at: "", expected: 0, done: 0, error: "" };
  async function runSweeps(targets, days, user, onProgress) {
    const results = [];
    const existing = await store.listCases();
    for (const t of targets) {
      const sweep = { id: cases.newId("sweep"), ran_at: new Date().toISOString(), by: user.email, regulator: t.regulator, subject: t.subject, days, reply: "", found: [], error: "" };
      try {
        const reply = await agent.chat({ message: cases.sweepPrompt(CONFIG, t.regulator, t.subject, days) });
        sweep.reply = reply.content;
        sweep.found = cases.parseSweep(reply.content).map((f) => {
          const dup = cases.findDuplicate(existing, f);
          return dup ? { ...f, already: dup.id } : f;
        });
      } catch (err) {
        sweep.error = err.message;
      }
      await store.putSweep(sweep);
      results.push(sweep);
      if (onProgress) onProgress(results.length);
    }
    return results;
  }

  async function handle(req, res) {
    let route = req.url.split("?")[0];
    const query = new URL(req.url, "http://x").searchParams;
    if (base && (route === base || route.startsWith(`${base}/`))) route = route.slice(base.length) || "/";
    const m = (method, pattern) => {
      if (req.method !== method) return null;
      const match = route.match(pattern);
      return match ? match.slice(1) : null;
    };
    let p;
    try {
      if (route === "/" || route === "") return send(res, 200, "text/html; charset=utf-8", page(base));
      if (FILES[route]) {
        const f = FILES[route];
        return fs.readFile(path.join(__dirname, f.file), (err, data) =>
          err ? send(res, 404, "text/plain", "Not found") : send(res, 200, f.type, data),
        );
      }

      if (m("GET", /^\/api\/health$/)) {
        return json(res, 200, {
          ok: true,
          desk: CONFIG.desk.id,
          store: store.kind,
          // Whether the records outlive a restart, and where they are.
          records: store.kind === "file" ? `${store.where}${store.kept ? "" : ", lost on restart"}` : "database",
          agent: agent.configured() ? "configured" : `not configured: set ${agent.missing().join(", ")}`,
          identity: String(env.TRUST_SIGN_IN_HEADERS || "").toLowerCase() === "true" ? "platform sign-in headers" : "stand-in",
          intake_webhook: env.INTAKE_TOKEN ? "on" : "off",
        });
      }
      if (m("GET", /^\/api\/config$/)) return json(res, 200, CONFIG);
      if (m("GET", /^\/api\/me$/)) return json(res, 200, who(req));

      if (m("GET", /^\/api\/cases$/)) return json(res, 200, (await store.listCases()).map(caseOut));
      if ((p = m("GET", /^\/api\/cases\/([^/]+)$/))) {
        const c = await store.getCase(p[0]);
        return c ? json(res, 200, caseOut(c)) : json(res, 404, { error: "no such case" });
      }

      // An officer drops a publication in.
      if (m("POST", /^\/api\/cases$/)) {
        const body = await readBody(req);
        const { errors, fields } = cases.validateIntake(CONFIG, body);
        if (errors.length) return json(res, 400, { error: errors.join("; ") });
        const c = await createCase(fields, who(req), "officer", body.draft !== false);
        return json(res, 201, caseOut(c));
      }

      // The bank's regulatory feed sends one in.
      if (m("POST", /^\/api\/intake$/)) {
        if (!env.INTAKE_TOKEN) return json(res, 404, { error: "intake by webhook is off (INTAKE_TOKEN is not set)" });
        if (req.headers["x-intake-token"] !== env.INTAKE_TOKEN) return json(res, 401, { error: "bad intake token" });
        const body = await readBody(req);
        const { errors, fields } = cases.validateIntake(CONFIG, body);
        if (errors.length) return json(res, 400, { error: errors.join("; ") });
        const c = await createCase(fields, null, "feed", true);
        return json(res, 202, { id: c.id, status: c.status });
      }

      // An officer corrects the details, or removes a wrong entry.
      if ((p = m("PATCH", /^\/api\/cases\/([^/]+)$/))) {
        const c = await store.getCase(p[0]);
        if (!c) return json(res, 404, { error: "no such case" });
        const body = await readBody(req);
        try {
          cases.updateFields(CONFIG, c, body, who(req));
        } catch (err) {
          return json(res, 409, { error: err.message });
        }
        await store.putCase(c);
        return json(res, 200, caseOut(c));
      }
      if ((p = m("POST", /^\/api\/cases\/([^/]+)\/remove$/))) {
        const c = await store.getCase(p[0]);
        if (!c) return json(res, 404, { error: "no such case" });
        const body = await readBody(req);
        try {
          cases.removeCase(CONFIG, c, who(req), body.note);
        } catch (err) {
          return json(res, 409, { error: err.message });
        }
        await store.putCase(c);
        return json(res, 200, caseOut(c));
      }

      if ((p = m("POST", /^\/api\/cases\/([^/]+)\/draft$/))) {
        const c = await store.getCase(p[0]);
        if (!c) return json(res, 404, { error: "no such case" });
        if (!agent.configured()) return json(res, 503, { error: `the agent is not configured: set ${agent.missing().join(", ")}` });
        if (["issued", "no_action", "removed"].includes(c.status)) return json(res, 409, { error: "this case is closed" });
        if (drafting.has(c.id)) return json(res, 202, { id: c.id, status: "drafting" });
        runDraft(c, who(req).email);
        return json(res, 202, { id: c.id, status: "drafting" });
      }

      if ((p = m("POST", /^\/api\/cases\/([^/]+)\/decision$/))) {
        const c = await store.getCase(p[0]);
        if (!c) return json(res, 404, { error: "no such case" });
        const body = await readBody(req);
        const user = who(req);
        let entry;
        try {
          entry = cases.applyDecision(CONFIG, c, body.decision, user, body.note, body.draft);
        } catch (err) {
          return json(res, 409, { error: err.message });
        }
        if (entry.decision === "issued") c.issued_document = cases.issuedDocument(CONFIG, c);
        await store.putCase(c);
        await store.appendRegister(entry);
        return json(res, 200, caseOut(c));
      }

      if ((p = m("POST", /^\/api\/cases\/([^/]+)\/chat$/))) {
        const c = await store.getCase(p[0]);
        if (!c) return json(res, 404, { error: "no such case" });
        if (!agent.configured()) return json(res, 503, { error: `the agent is not configured: set ${agent.missing().join(", ")}` });
        const body = await readBody(req);
        const message = String(body.message || "").trim();
        if (!message) return json(res, 400, { error: "say something" });
        const user = who(req);
        const at = new Date().toISOString();
        c.conversation.push({ role: "user", by: user.email, content: message, at });
        await store.putCase(c);
        const reply = await agent.chat({ message: cases.chatPrompt(CONFIG, c, message, Boolean(c.agent_session_id)), sessionId: c.agent_session_id || undefined });
        const fresh = await store.getCase(c.id);
        if (reply.sessionId) fresh.agent_session_id = reply.sessionId;
        fresh.conversation.push({ role: "assistant", content: reply.content, at: new Date().toISOString() });
        await store.putCase(fresh);
        return json(res, 200, caseOut(fresh));
      }

      // Sweeps: ask the agent what a regulator published.
      if (m("GET", /^\/api\/sweeps$/)) return json(res, 200, await store.listSweeps());
      if (m("GET", /^\/api\/sweeps\/status$/)) return json(res, 200, sweepRun);
      if (m("POST", /^\/api\/sweeps$/)) {
        if (!agent.configured()) return json(res, 503, { error: `the agent is not configured: set ${agent.missing().join(", ")}` });
        const body = await readBody(req);
        const user = who(req);
        const targets = body.regulator ? [{ regulator: body.regulator, subject: body.subject || "" }] : CONFIG.sweeps.regulators;
        const days = Number(body.days) || CONFIG.sweeps.defaultDays;
        // The agent takes about a minute per regulator, longer than a gateway
        // in front of the desk holds a request open. With wait:false the sweep
        // carries on after the reply and the page reads /api/sweeps/status.
        if (body.wait === false) {
          if (!sweepRun.running) {
            sweepRun = { running: true, started_at: new Date().toISOString(), expected: targets.length, done: 0, error: "" };
            const run = sweepRun;
            runSweeps(targets, days, user, (n) => { run.done = n; })
              .catch((err) => { run.error = err.message; })
              .finally(() => { run.running = false; });
          }
          return json(res, 202, sweepRun);
        }
        return json(res, 200, await runSweeps(targets, days, user));
      }
      // One line of a sweep becomes a case.
      if ((p = m("POST", /^\/api\/sweeps\/([^/]+)\/open$/))) {
        const sweeps = await store.listSweeps();
        const s = sweeps.find((x) => x.id === p[0]);
        if (!s) return json(res, 404, { error: "no such sweep" });
        const body = await readBody(req);
        const f = s.found[Number(body.index)];
        if (!f) return json(res, 400, { error: "no such line" });
        const dup = cases.findDuplicate(await store.listCases(), f);
        if (dup) return json(res, 409, { error: `already on the desk as "${dup.fields.title}"`, case_id: dup.id });
        const { errors, fields } = cases.validateIntake(CONFIG, {
          title: f.title,
          regulator: s.regulator,
          published_on: /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : body.published_on || "",
          link: f.link,
          subject: s.subject,
          text: f.line,
        });
        if (errors.length) return json(res, 400, { error: errors.join("; ") });
        const c = await createCase(fields, null, "sweep", true);
        c.events.push({ at: new Date().toISOString(), who: who(req).email, what: `opened from sweep ${s.id}` });
        await store.putCase(c);
        return json(res, 201, caseOut(c));
      }

      if (m("GET", /^\/api\/register$/)) return json(res, 200, await store.listRegister());
      if (m("GET", /^\/api\/register\.csv$/)) {
        const rows = await store.listRegister();
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=register.csv" });
        return res.end(csv(rows, CONFIG.register.columns));
      }
      if ((p = m("GET", /^\/api\/cases\/([^/]+)\/issued\.md$/))) {
        const c = await store.getCase(p[0]);
        if (!c || !c.issued_document) return json(res, 404, { error: "nothing issued for this case" });
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename=${c.id}.md` });
        return res.end(c.issued_document);
      }
      if (query.has("x")) return json(res, 400, { error: "unknown query" });
      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // A first start with SEED_DEMO=true loads the demo publications as cases
  // that arrived from the feed, so a freshly deployed desk is not empty.
  if (String(env.SEED_DEMO || "").toLowerCase() === "true" && (await store.listCases()).length === 0) {
    try {
      const { publications } = JSON.parse(fs.readFileSync(path.join(__dirname, "demo", "publications.json"), "utf8"));
      for (const p of publications) {
        const { errors, fields } = cases.validateIntake(CONFIG, p);
        if (!errors.length) await createCase(fields, null, p.arrived_via || "feed", false);
      }
    } catch (err) {
      console.error("could not seed the demo publications:", err.message);
    }
  }

  const server = http.createServer(handle);
  return { server, store, agent, config: CONFIG, drafting, close: async () => { server.close(); await store.close(); } };
}

if (require.main === module) {
  if (fs.existsSync(path.join(__dirname, ".env"))) {
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
      const mm = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (mm) process.env[mm[1]] = mm[2].replace(/^"|"$/g, ""); // the desk's .env wins over an ambient key in the shell
    }
  }
  const PORT = Number(process.env.PORT || 3000);
  createDesk(process.env).then((desk) => {
    desk.server.listen(PORT, "0.0.0.0", () =>
      console.log(`${CONFIG.desk.name}: listening on ${PORT}, served under "${process.env.PUBLIC_URL || "/"}", records in ${desk.store.kind}, agent ${desk.agent.configured() ? "configured" : "NOT configured (" + desk.agent.missing().join(", ") + ")"}`),
    );
  });
}

module.exports = { createDesk, CONFIG };
