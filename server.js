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

// Which desk this is. DESK_CONFIG names another desk's config file (a path
// from this folder, for example desks/prior-authorisation/desk.config.json);
// without it the desk is the regulatory change desk.
function loadConfig(env) {
  const file = path.resolve(__dirname, (env && env.DESK_CONFIG) || "desk.config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.defineProperty(config, "__dir", { value: path.dirname(file), enumerable: false });
  // A decision the agent carries out gets its defaults, and its statuses their labels.
  return cases.withActs(config);
}

const DEFAULT_CONFIG = loadConfig({});

const FILES = {
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/desk.css": { file: "desk.css", type: "text/css; charset=utf-8" },
  "/shared.js": { file: "lib/page-shared.js", type: "text/javascript; charset=utf-8" },
  "/vendor/react.js": { file: "node_modules/react/umd/react.production.min.js", type: "text/javascript; charset=utf-8" },
  "/vendor/react-dom.js": { file: "node_modules/react-dom/umd/react-dom.production.min.js", type: "text/javascript; charset=utf-8" },
};

function page(base, name) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<script>try{var t=localStorage.getItem("desk-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>
<link rel="stylesheet" href="${base}/desk.css">
</head>
<body>
  <div id="root"></div>
  <script>window.APP_BASE = ${JSON.stringify(base)};</script>
  <script src="${base}/vendor/react.js"></script>
  <script src="${base}/vendor/react-dom.js"></script>
  <script src="${base}/shared.js"></script>
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
// The demo cases a desk ships with: config.demo names the file (beside the
// config) and the key that holds the list.
function demoCases(config) {
  const d = config.demo || { file: "demo/publications.json", key: "publications" };
  return JSON.parse(fs.readFileSync(path.resolve(config.__dir, d.file), "utf8"))[d.key];
}

async function createDesk(env = process.env) {
  const CONFIG = loadConfig(env);
  const store = await openStore(env);
  const agent = createAgentClient(env);
  const base = String(env.PUBLIC_URL || "").replace(/\/+$/, "");
  const drafting = new Map(); // case id -> promise, so a draft is not started twice
  const acting = new Map(); // case id -> promise, so a confirmed decision is not sent to the agent twice

  function who(req) {
    return readIdentity(req.headers, env);
  }
  const SHAPE = cases.shape(CONFIG);
  // A failure that is worth one more try: the agent was not reached, the
  // platform asked for another attempt, or the reply came back empty.
  function transient(err) {
    return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated|try again|HTTP 5\d\d|HTTP 429|empty reply/i.test(String(err && err.message));
  }
  async function chatOnceMore(args, onRetry) {
    try {
      const reply = await agent.chat(args);
      if (!String(reply.content || "").trim()) throw new Error("empty reply");
      return reply;
    } catch (err) {
      if (!transient(err)) throw err;
      if (onRetry) await onRetry(err);
      await new Promise((r) => setTimeout(r, Number(env.DESK_RETRY_WAIT_MS) || 2500));
      return agent.chat(args);
    }
  }
  function plain(err) {
    return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(String(err && err.message))
      ? "The agent could not be reached. Try again in a moment. If it keeps failing, tell your administrator."
      : err.message;
  }

  // A case as the page sees it: with the latest draft's gap table parsed into
  // rows and its summary picked out, so the page shows a table when there is
  // one and the text when there is not.
  function caseOut(c) {
    const latest = c.drafts.length ? c.drafts[c.drafts.length - 1] : null;
    const rules = cases.kindRules(CONFIG, c);
    const look = cases.lookConfig(CONFIG, c);
    const gaps = latest ? cases.proposalGaps(latest.text, look) : [];
    return {
      ...c,
      // What this kind of work shows: null means every decision, every mark.
      kind: rules.kind,
      decisions_allowed: rules.decisions,
      marks_allowed: rules.marks,
      sections: latest ? cases.parseSections(latest.text, CONFIG) : [],
      // How this kind of work words its marks and the lines of a row (null: as the desk does).
      look: look === CONFIG ? null : { marks: look.draft.marks, markHints: look.draft.markHints, markTones: look.draft.markTones, rowLabels: look.draft.rowLabels },
      gap_rows: latest ? cases.parseGapTable(latest.text, look, { headings: true }) : null,
      // The rows the agent's proposal does not name (draft.proposalNames), and the notice that says so.
      proposal_gaps: gaps,
      proposal_notice: gaps.length ? cases.proposalNotice(gaps) : "",
      // A chip for a case that needs to be seen first (case.flags).
      flag: cases.flagOf(CONFIG, c, latest ? latest.text : ""),
      summary: latest ? cases.summaryOf(latest.text, CONFIG).split("**").join("") : "",
      proposal: latest ? cases.proposalOf(latest.text, CONFIG) : "",
      checklist: latest ? cases.parseChecklist(latest.text, CONFIG) : null,
      next_step: latest ? cases.derivedProposal(latest.text, CONFIG) : null,
      gate_note: latest ? cases.gateNote(latest.text, CONFIG) : "",
      all_pass: latest ? cases.allPass(latest.text, CONFIG) : null,
    };
  }

  // The agent behind a case: the desk's own, or, on a desk with routing, the
  // one whose id sits in the environment variable the case's kind names.
  function agentFor(c) {
    const route = cases.routeOf(CONFIG, c);
    if (!route.agentEnv) return { id: agent.agentId, route };
    const id = env[route.agentEnv] || "";
    if (!id) throw new Error(`no agent is set for "${route.kind}": set ${route.agentEnv}`);
    return { id, route };
  }
  async function runDraft(c, by) {
    const statusBefore = c.status;
    c.status = "drafting";
    c.events.push({ at: new Date().toISOString(), who: by, what: "asked the agent for a draft" });
    await store.putCase(c);
    const p = (async () => {
      try {
        // Where the library cannot be attached to the agent, the desk searches
        // it with its own key and hands the passages over.
        const { id: agentId, route } = agentFor(c);
        let passages = null;
        const libraryId = env.KATONIC_LIBRARY_SOURCE_ID || "";
        if (libraryId) {
          const seen = new Map();
          for (const q of cases.libraryQueries(CONFIG, c)) {
            for (const p of await agent.search({ query: q, sourceIds: [libraryId], topK: 8 })) if (p.text && !seen.has(p.text)) seen.set(p.text, p);
          }
          passages = [...seen.values()].slice(0, 40);
        } else if (env.DESK_LIBRARY_DIR) {
          // No knowledge source on the platform: the library is a folder of
          // Markdown files beside the desk.
          const dir = path.resolve(__dirname, env.DESK_LIBRARY_DIR);
          const docs = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !/^readme/i.test(f)).map((f) => ({ name: f.replace(/\.md$/, ""), text: fs.readFileSync(path.join(dir, f), "utf8") }));
          passages = cases.localPassages(CONFIG, c, docs, env.KATONIC_LIBRARY_NAME, 1);
        }
        const reply = await chatOnceMore(
          { message: cases.draftPrompt(CONFIG, c, passages, { searched: Array.isArray(passages), sessionKnown: Boolean(c.agent_session_id), maxChars: Number(env.KATONIC_MAX_MESSAGE_CHARS) || 15000, instruction: route.instruction }), sessionId: c.agent_session_id || undefined, id: agentId },
          async (err) => {
            const now = await store.getCase(c.id);
            now.events.push({ at: new Date().toISOString(), who: "desk", what: `the agent did not answer (${plain(err) === err.message ? err.message.slice(0, 120) : "not reached"}); trying once more` });
            await store.putCase(now);
          },
        );
        const fresh = await store.getCase(c.id);
        cases.recordDraft(fresh, reply.content, "agent", reply.sessionId, new Date(), {
          agent_id: agentId,
          run_id: reply.runId || "",
          library: passages
            ? `${(passages[0] && passages[0].library) || env.KATONIC_LIBRARY_NAME || SHAPE.libraryNoun} (searched by the desk: ${passages.length} passages)`
            : env.KATONIC_LIBRARY_NAME || "",
          tools: reply.tools || [],
          warning: reply.warning || "",
        });
        // A proposal that leaves out a row the desk wants named is noted in the case's story (draft.proposalNames).
        cases.noteProposalGaps(CONFIG, fresh);
        fresh.last_error = "";
        await store.putCase(fresh);
      } catch (err) {
        const fresh = await store.getCase(c.id);
        // A failed draft changes nothing: a sent-back case stays sent back, so
        // the draft that was rejected cannot be approved.
        fresh.status = statusBefore === "drafting" ? (fresh.drafts.length ? "for_review" : "new") : statusBefore;
        fresh.last_error = plain(err);
        fresh.events.push({ at: new Date().toISOString(), who: "agent", what: `draft failed: ${plain(err)}${plain(err) === err.message ? "" : ` (${err.message})`}` });
        await store.putCase(fresh);
      } finally {
        drafting.delete(c.id);
      }
    })();
    drafting.set(c.id, p);
    return p;
  }

  // Sends the agent the message that carries a confirmed decision out (step
  // "act"), the same message again after a failure ("retry"), or the question
  // about the outcome ("again"), and keeps the answer on the case. Nothing is
  // sent twice for one click: the case holds the working status and this map
  // holds the run until the answer is in. The decision itself is already recorded.
  function runAct(c, step, message, by) {
    const p = (async () => {
      try {
        const which = agentFor(c);
        const reply = await agent.chat({ message, sessionId: c.agent_session_id || undefined, id: which.id });
        if (!String(reply.content || "").trim()) throw new Error("the agent sent an empty reply");
        const fresh = await store.getCase(c.id);
        const now = new Date();
        const done = cases.recordAnswer(CONFIG, fresh, reply.content, step, now, { by, run_id: reply.runId || "", tools: reply.tools || [], warning: reply.warning || "" });
        if (reply.sessionId && !fresh.agent_session_id) fresh.agent_session_id = reply.sessionId;
        if (fresh.issued_document) fresh.issued_document = cases.issuedDocument(CONFIG, fresh);
        await store.putCase(fresh);
        await store.appendRegister(cases.outcomeEntry(CONFIG, fresh, by, done.firstLine, now));
      } catch (err) {
        const fresh = await store.getCase(c.id);
        const now = new Date();
        const said = plainAct(err);
        cases.recordActFailure(CONFIG, fresh, step, said, now);
        if (fresh.issued_document) fresh.issued_document = cases.issuedDocument(CONFIG, fresh);
        await store.putCase(fresh);
        await store.appendRegister(cases.outcomeEntry(CONFIG, fresh, by, step === "again" ? `Could not ask again: ${said}` : `${cases.statusLabel(CONFIG, fresh.status)}: ${said}`, now));
      } finally {
        acting.delete(c.id);
      }
    })();
    acting.set(c.id, p);
    p.catch((err) => console.error("could not keep the outcome of", c.id, err.message));
    return p;
  }
  function plainAct(err) {
    const m = String(err && err.message);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|socket hang up|network|terminated/i.test(m)) return "The agent could not be reached.";
    // An error from the platform: its status and its own words, not the raw reply.
    const http = /^the agent did not answer: HTTP (\d+) ?([\s\S]*)$/.exec(m);
    if (http) {
      let said = http[2].trim();
      try {
        const j = JSON.parse(said);
        said = String(j.error || j.message || said);
      } catch (e) {
        /* not JSON: keep it */
      }
      return `The platform answered with an error (HTTP ${http[1]})${said ? `: ${said}` : ""}`.slice(0, 300);
    }
    return m.slice(0, 300);
  }
  // A case that was being carried out when the desk stopped: the answer never came. It is marked so, and can be tried again.
  async function settleStale() {
    for (const c of await store.listCases()) {
      if (c.status === cases.ACTING && c.outcome && !acting.has(c.id)) {
        cases.recordActFailure(CONFIG, c, c.outcome.answers.length ? "again" : "act", "the desk stopped before the agent answered, so it is not known what was done. Trying again is safe: the agent reads the current state first", new Date());
        await store.putCase(c);
      }
    }
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
      if (route === "/" || route === "") return send(res, 200, "text/html; charset=utf-8", page(base, CONFIG.desk.name));
      // The typefaces, from the @fontsource packages: /fonts/<family>/<file>.woff2
      const font = /^\/fonts\/(dm-sans|source-serif-4|jetbrains-mono)\/([a-z0-9-]+\.woff2)$/.exec(route);
      if (font) {
        return fs.readFile(path.join(__dirname, "node_modules", "@fontsource", font[1], "files", font[2]), (err, data) => {
          if (err) return send(res, 404, "text/plain", "Not found");
          res.writeHead(200, { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable" });
          res.end(data);
        });
      }
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
        const { errors, fieldErrors, fields } = cases.validateIntake(CONFIG, body);
        // error: one line of words; errors: one entry for each fault; fields: the short words for each field by its key.
        if (errors.length) return json(res, 400, { error: errors.join("; "), errors, fields: fieldErrors });
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
          return json(res, 409, err.fieldErrors ? { error: err.message, errors: err.errors, fields: err.fieldErrors } : { error: err.message });
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
        if (CONFIG.register.recordRemovals) await store.appendRegister(cases.removalEntry(CONFIG, c, who(req), body.note));
        return json(res, 200, caseOut(c));
      }

      if ((p = m("POST", /^\/api\/cases\/([^/]+)\/draft$/))) {
        const c = await store.getCase(p[0]);
        if (!c) return json(res, 404, { error: "no such case" });
        if (!agent.configured()) return json(res, 503, { error: `the agent is not configured: set ${agent.missing().join(", ")}` });
        if (SHAPE.closed.includes(c.status)) return json(res, 409, { error: "this case is closed" });
        if (c.outcome) return json(res, 409, { error: `this ${CONFIG.desk.caseNoun} was confirmed and sent to the agent to carry out; it cannot be drafted again` });
        if (SHAPE.waiting.includes(c.status)) return json(res, 409, { error: `this ${CONFIG.desk.caseNoun} is waiting for a reply; add the reply to draft again` });
        if (drafting.has(c.id)) return json(res, 202, { id: c.id, status: "drafting" });
        runDraft(c, who(req).email);
        return json(res, 202, { id: c.id, status: "drafting" });
      }

      // A reply from outside (the provider, on the prior authorisation desk)
      // is added to a case that was waiting for it, and the agent drafts again.
      if ((p = m("POST", /^\/api\/cases\/([^/]+)\/reply$/))) {
        const c = await store.getCase(p[0]);
        if (!c) return json(res, 404, { error: "no such case" });
        const body = await readBody(req);
        const user = who(req);
        try {
          cases.addReply(CONFIG, c, body.text, user);
        } catch (err) {
          return json(res, 409, { error: err.message });
        }
        await store.putCase(c);
        if (agent.configured()) runDraft(c, user.email);
        return json(res, 200, caseOut(await store.getCase(c.id)));
      }

      if ((p = m("POST", /^\/api\/cases\/([^/]+)\/decision$/))) {
        const c = await store.getCase(p[0]);
        if (!c) return json(res, 404, { error: "no such case" });
        const body = await readBody(req);
        const user = who(req);
        // One click sends the agent one message: a case that is being carried out takes no second decision.
        if (acting.has(c.id)) return json(res, 409, { error: `this ${CONFIG.desk.caseNoun} is being carried out` });
        let entry;
        try {
          entry = cases.applyDecision(CONFIG, c, body.decision, user, body.note, body.draft);
        } catch (err) {
          return json(res, 409, { error: err.message });
        }
        const carrying = c.status === cases.ACTING && c.outcome && c.outcome.state === "working";
        if (carrying) acting.set(c.id, Promise.resolve());
        if ((CONFIG.audit && CONFIG.audit.outcomes ? CONFIG.audit.outcomes : ["issued"]).includes(entry.decision)) c.issued_document = cases.issuedDocument(CONFIG, c);
        await store.putCase(c);
        await store.appendRegister(entry);
        if (carrying) runAct(c, "act", c.outcome.message, user.email);
        if (entry.decision === "sent_back" && CONFIG.rules.redraftOnSendBack && agent.configured()) runDraft(c, user.email);
        return json(res, 200, caseOut(c));
      }

      // A case that waits for the outcome asks the agent again; a case that was not carried out sends the same request again.
      if ((p = m("POST", /^\/api\/cases\/([^/]+)\/outcome\/(again|retry)$/))) {
        const c = await store.getCase(p[0]);
        if (!c) return json(res, 404, { error: "no such case" });
        if (!agent.configured()) return json(res, 503, { error: `the agent is not configured: set ${agent.missing().join(", ")}` });
        if (acting.has(c.id)) return json(res, 202, caseOut(c));
        const user = who(req);
        let message;
        try {
          message = cases.resumeAct(CONFIG, c, p[1], user);
        } catch (err) {
          return json(res, 409, { error: err.message });
        }
        acting.set(c.id, Promise.resolve());
        await store.putCase(c);
        runAct(c, p[1], message, user.email);
        return json(res, 200, caseOut(c));
      }

      if ((p = m("POST", /^\/api\/cases\/([^/]+)\/chat$/))) {
        const c = await store.getCase(p[0]);
        if (!c) return json(res, 404, { error: "no such case" });
        if (!agent.configured()) return json(res, 503, { error: `the agent is not configured: set ${agent.missing().join(", ")}` });
        if (acting.has(c.id)) return json(res, 409, { error: "the agent is carrying this case out. Ask when it has answered." });
        const body = await readBody(req);
        const message = String(body.message || "").trim();
        if (!message) return json(res, 400, { error: "say something" });
        const user = who(req);
        const at = new Date().toISOString();
        c.conversation.push({ role: "user", by: user.email, content: message, at });
        await store.putCase(c);
        let which;
        try {
          which = agentFor(c);
        } catch (err) {
          return json(res, 503, { error: err.message });
        }
        const reply = await agent.chat({ message: cases.chatPrompt(CONFIG, c, message, Boolean(c.agent_session_id)), sessionId: c.agent_session_id || undefined, id: which.id });
        const fresh = await store.getCase(c.id);
        if (reply.sessionId) fresh.agent_session_id = reply.sessionId;
        fresh.conversation.push({ role: "assistant", content: reply.content, at: new Date().toISOString() });
        await store.putCase(fresh);
        return json(res, 200, caseOut(fresh));
      }

      // Sweeps: ask the agent what a regulator published.
      if (!CONFIG.sweeps && route.startsWith("/api/sweeps")) return json(res, 404, { error: "this desk has no sweeps" });
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
      if ((p = m("GET", /^\/api\/cases\/([^/]+)\/letters\/(\d+)\.md$/))) {
        const c = await store.getCase(p[0]);
        const letter = c && (c.letters || [])[Number(p[1])];
        if (!letter) return json(res, 404, { error: "no such letter" });
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename=${letter.number}.md` });
        return res.end(letter.text);
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
      return json(res, 500, { error: plain(err) });
    }
  }

  // A first start with SEED_DEMO=true loads the demo publications as cases
  // that arrived from the feed, so a freshly deployed desk is not empty.
  if (String(env.SEED_DEMO || "").toLowerCase() === "true" && (await store.listCases()).length === 0) {
    try {
      for (const p of demoCases(CONFIG)) {
        const { errors, fields } = cases.validateIntake(CONFIG, p);
        if (!errors.length) await createCase(fields, null, p.arrived_via || "feed", false);
      }
    } catch (err) {
      console.error("could not seed the demo cases:", err.message);
    }
  }

  await settleStale();

  const server = http.createServer(handle);
  return { server, store, agent, config: CONFIG, drafting, acting, close: async () => { server.close(); await store.close(); } };
}

// Reads a settings file into env. The file wins over an ambient key in the
// shell, key by key, except DESK_AGENT_ID: when that is set in the process
// environment before the file is read, it stays, so one key file can serve
// several desks that each name their own agent.
function loadEnvFile(envFile, env) {
  if (!fs.existsSync(envFile)) return;
  const pinned = env.DESK_AGENT_ID;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const mm = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (mm) env[mm[1]] = mm[2].replace(/^"|"$/g, ""); // the desk's .env wins over an ambient key in the shell
  }
  if (pinned) env.DESK_AGENT_ID = pinned;
}

if (require.main === module) {
  // DESK_ENV_FILE names another settings file, so one checkout can run
  // against more than one platform.
  loadEnvFile(process.env.DESK_ENV_FILE || path.join(__dirname, ".env"), process.env);
  const PORT = Number(process.env.PORT || 3000);
  createDesk(process.env).then((desk) => {
    desk.server.listen(PORT, "0.0.0.0", () =>
      console.log(`${desk.config.desk.name}: listening on ${PORT}, served under "${process.env.PUBLIC_URL || "/"}", records in ${desk.store.kind}, agent ${desk.agent.configured() ? "configured" : "NOT configured (" + desk.agent.missing().join(", ") + ")"}`),
    );
  });
}

module.exports = { createDesk, loadEnvFile, CONFIG: DEFAULT_CONFIG, loadConfig, demoCases };
