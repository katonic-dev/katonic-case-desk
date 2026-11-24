// The case desk's own rules. Pure functions: no I/O, so they are tested on
// their own. desk.config.json says what a case is called and which decisions
// exist; this file says how a case moves.
//
// A case:
//   id, status, fields (from config.intake.fields), arrived_via
//   ("officer" | "feed" | "sweep"), requested_by {email, name, source},
//   created_at, drafts [{version, text, by, at, agent_session_id}],
//   conversation [{role, content, at}], decision {id, outcome, by, at, note},
//   events [{at, who, what}].

const crypto = require("crypto");
const shared = require("./page-shared");

function newId(prefix, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

// What a desk says about its own cases. Every value has a default, and the
// defaults are the regulatory change desk's, so a config that says nothing
// here behaves as that desk does.
function shape(config) {
  const k = config.case || {};
  const text = config.intake.fields.find((f) => f.type === "textarea");
  return {
    heading: k.heading || "THE PUBLICATION",
    metaFields: k.metaFields || ["regulator", "published_on"],
    queryFields: k.queryFields || ["title", "subject"],
    textField: k.textField || (text ? text.key : "text"),
    noTextNote: k.noTextNote || "No text was supplied. If a search tool is connected, read the publication at its link; otherwise say that you have only the title and work from it.",
    libraryHeading: k.libraryHeading || "THE POLICY LIBRARY",
    libraryNoun: k.libraryNoun || "policy library",
    libraryInstruction:
      k.libraryInstruction ||
      'The desk has searched the policy library "{library}" for you. The passages it returned are below, each with its document. Treat them as the policy library\'s search results: compare each requirement with them, and cite the document and the clause number at the start of the passage. Where no passage bears on a requirement, mark it "not found". Do not say that no policy library is connected.',
    closed: config.closedStatuses || ["issued", "no_action", "removed"],
    // Decided, but the case is not over: it waits for a reply from outside.
    waiting: config.waitingStatuses || [],
  };
}

function labelOf(config, key) {
  const f = config.intake.fields.find((x) => x.key === key);
  return f ? f.label : key;
}

function validateIntake(config, body) {
  const errors = [];
  const fields = {};
  for (const f of config.intake.fields) {
    const v = body && body[f.key] != null ? String(body[f.key]).trim() : "";
    if (f.required && !v) errors.push(`${f.label} is required`);
    if (f.type === "date" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${f.label} must be YYYY-MM-DD`);
    fields[f.key] = v;
    if (!v && f.default && f.type !== "date") fields[f.key] = f.default;
  }
  return { errors, fields };
}

function newCase(config, fields, who, via, now = new Date()) {
  return {
    id: newId("case", now),
    desk: config.desk.id,
    status: "new",
    fields,
    arrived_via: via,
    requested_by: who ? { email: who.email, name: who.name, source: who.source } : { email: via, name: via, source: "system" },
    created_at: now.toISOString(),
    drafts: [],
    conversation: [],
    decision: null,
    agent_session_id: "",
    events: [{ at: now.toISOString(), who: who ? who.email : via, what: `arrived via ${via}` }],
  };
}

// The case as the agent reads it: each field under its own label, in the
// order the config lists them, and the long text last.
function caseText(config, c) {
  const s = shape(config);
  const f = c.fields;
  const lines = [];
  for (const fd of config.intake.fields) {
    if (fd.key === s.textField) continue;
    if (fd.required || f[fd.key]) lines.push(`${fd.label}: ${f[fd.key] || ""}`);
  }
  if (f[s.textField]) lines.push("", `${labelOf(config, s.textField)}:`, f[s.textField]);
  else lines.push("", s.noTextNote);
  return lines.join("\n");
}

// The message that asks the agent for the summary and the draft. After a
// send-back it also carries the officer's note and the draft being replaced,
// so the redo is a redo and not a repeat.
// The searches the desk runs on the library for a publication, when the desk
// does the retrieval itself: its title, its subject, and each sentence of the
// text it was given.
function libraryQueries(config, c) {
  const k = shape(config);
  const f = c.fields;
  const qs = k.queryFields.map((key) => f[key]);
  for (const s of String(f[k.textField] || "").split(/(?<=[.;:])\s+/)) if (s.trim().length > 25) qs.push(s.trim().slice(0, 300));
  return [...new Set(qs.filter(Boolean))].slice(0, 10);
}

// A library kept as files beside the desk (DESK_LIBRARY_DIR), for a desk with
// no knowledge source on the platform: the documents that share the most words
// with the case are handed to the agent whole, as passages.
function localPassages(config, c, docs, libraryName, limit = 2) {
  const k = shape(config);
  const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z]{4,}/g) || []);
  const want = words(k.queryFields.map((key) => c.fields[key]).join(" "));
  return docs
    .map((d) => ({ d, score: [...words(d.text.slice(0, 600))].filter((w) => want.has(w)).length }))
    .sort((a, b) => b.score - a.score)
    .filter((x, i) => x.score > 0 && i < limit)
    .map((x) => ({ text: x.d.text, document: x.d.name, library: libraryName || k.libraryNoun }));
}

// passages: [{text, document, library}] the desk retrieved from the policy
// library, or null when the library is attached to the agent itself.
// opts.sessionKnown: the agent already holds the earlier draft in this
// conversation, so a redo does not send it again. opts.maxChars: the
// platform refuses a message over its limit (16,000 characters on the dev
// cluster, "chat.message_too_long"), so passages and the previous draft are
// trimmed to fit.
function draftPrompt(config, c, passages, opts = {}) {
  const maxChars = opts.maxChars || 15000;
  const k = shape(config);
  const parts = [opts.instruction || config.draft.instruction, "", k.heading, caseText(config, c)];
  const redo = Boolean(c.decision && c.decision.outcome === "sent_back" && c.drafts.length);
  const redoHead = redo
    ? ["", `WHAT THE ${config.desk.deciderRole.toUpperCase()} ASKED FOR`, `The previous draft was sent back with this note: ${c.decision.note}`, "Write a new draft that answers the note. Keep what was right."]
    : [];
  const used = () => parts.join("\n").length + redoHead.join("\n").length;
  if (passages && passages.length) {
    const room = maxChars - used() - 700 - (redo && !opts.sessionKnown ? 3000 : 0);
    const kept = [];
    let size = 0;
    for (const p of passages) {
      const line = `[${kept.length + 1}] ${p.document}: ${p.text}`;
      if (size + line.length + 1 > room) break;
      kept.push(line);
      size += line.length + 1;
    }
    passages = kept.length ? passages.slice(0, kept.length) : [];
  }
  if (passages && passages.length) {
    parts.push(
      "",
      k.libraryHeading,
      k.libraryInstruction.split("{library}").join(passages[0].library || k.libraryNoun),
      "",
      ...passages.map((p, i) => `[${i + 1}] ${p.document}: ${p.text}`),
    );
  }
  if (Array.isArray(passages) && passages.length === 0 && opts.searched) {
    parts.push("", k.libraryHeading, `The desk searched the ${k.libraryNoun} and it returned nothing for this ${config.desk.caseNoun}. Do not say that no library is connected: say that the library holds nothing that covers it.`);
  }
  if (redo) {
    parts.push(...redoHead);
    if (opts.sessionKnown) {
      parts.push("Your previous draft is earlier in this conversation. Revise it; do not start from nothing.");
    } else {
      const previous = c.drafts[c.drafts.length - 1].text;
      const room = Math.max(0, maxChars - parts.join("\n").length - 60);
      parts.push("", "THE PREVIOUS DRAFT", previous.length > room ? previous.slice(0, room) + "\n[cut to fit]" : previous);
    }
  }
  return parts.join("\n");
}

// The gap analysis as rows, when the agent wrote the table it was asked for.
// Columns: #, requirement, source, policy says, citation, mark, check.
// Returns null when no such table is in the text, and the page shows the
// prose instead.
const MARKS = ["covered", "partly covered", "not covered", "not found"];

// The marks a desk uses are the keys of config.draft.marks. The longest is
// tried first, so "met with conditions" is not read as "met".
function marksOf(config) {
  const keys = config && config.draft && config.draft.marks ? Object.keys(config.draft.marks) : MARKS;
  return [...keys].sort((a, b) => b.length - a.length);
}

function parseGapTable(text, config) {
  const marks = marksOf(config);
  const tones = (config && config.draft && config.draft.markTones) || {};
  const rows = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((s) => s.trim());
    if (cells.length < 6) continue;
    if (/^-+:?$/.test(cells[0].replace(/\s/g, "")) || /^:?-+/.test(cells[1] || "")) continue; // the rule line
    if (/^#$/.test(cells[0]) || /^(requirement|criterion)$/i.test(cells[1] || "")) continue; // the header
    const [n, requirement, source, policy, citation, mark, check] = cells.length >= 7 ? cells : [...cells, ""];
    const m = marks.find((k) => (mark || "").toLowerCase().startsWith(k)) || "";
    rows.push({ n, requirement, source, policy, citation, mark: m, markText: mark || "", tone: tones[m] || "", check: check || "" });
  }
  return rows.length ? rows : null;
}

// The one line under the table where the agent says what it would do next,
// for desks whose config names how that line starts.
function proposalOf(text, config) {
  const prefix = config && config.draft && config.draft.proposalPrefix;
  if (!prefix) return "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\*\*/g, "").trim();
    if (line.toLowerCase().startsWith(prefix.toLowerCase())) return line.slice(prefix.length).trim();
  }
  return "";
}

// The completeness check the agent writes before the review, for desks whose
// config asks for one: a three-column table (item, status, what was found).
// config.draft.checklist.blocking names the items that hold a case up.
const CHECK_STATUSES = ["complete", "incomplete", "missing"];

function parseChecklist(text, config) {
  const k = config && config.draft && config.draft.checklist;
  if (!k) return null;
  const blocking = new Set((k.blocking || []).map((s) => s.toLowerCase()));
  const rows = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((s) => s.replace(/\*\*/g, "").trim());
    if (cells.length < 3 || cells.length > 4) continue;
    const status = cells[1].toLowerCase();
    if (!CHECK_STATUSES.includes(status)) continue;
    rows.push({ item: cells[0], status, detail: cells[2] || "", blocking: blocking.has(cells[0].toLowerCase()) });
  }
  return rows.length ? rows : null;
}

// When a gate stopped the review there is no criteria table: the agent writes
// one or two sentences under the review's heading instead. This picks them out.
function gateNote(text, config) {
  const heading = config && config.draft && config.draft.reviewHeading;
  if (!heading || parseGapTable(text, config)) return "";
  const prefix = (config.draft.proposalPrefix || "\u0000").toLowerCase();
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((l) => l.replace(/[#*]/g, "").trim().toLowerCase().startsWith(heading.toLowerCase()));
  if (start < 0) return "";
  const kept = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.replace(/\*\*/g, "").trim();
    if (line.toLowerCase().startsWith(prefix)) break;
    if (line && !line.startsWith("|")) kept.push(line);
  }
  return kept.join(" ");
}

// What a decision is called once taken ("Referred to the medical director"),
// where the desk's config says; otherwise the status it leads to.
// A time as the desk shows it elsewhere: "24 Nov 2026 02:21 UTC".
function niceTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function decisionLabel(config, outcome) {
  return (config.decisionLabels || {})[outcome] || config.statuses[outcome] || outcome;
}

// The next step by the desk's own rules, for desks whose config gives them
// (config.draft.proposalRules). The same marks always give the same step:
// an open required item or an "ask" mark asks the outside party; a "refer"
// mark, or a review a later gate stopped, refers; every row passing approves.
// The agent's own line is kept beside it, and whether the two agree.
function proposalKind(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return "";
  if (t.startsWith("approve")) return "approve";
  if (t.startsWith("ask")) return "ask";
  if (t.startsWith("refer")) return "refer";
  return "other";
}

// "criterion 2 is", "criteria 2 and 4 are".
function several(rows) {
  const ns = rows.map((r) => r.n);
  return ns.length === 1 ? `criterion ${ns[0]} is` : `criteria ${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]} are`;
}

function derivedProposal(text, config) {
  const rules = config && config.draft && config.draft.proposalRules;
  if (!rules) return null;
  const agentText = proposalOf(text, config);
  const agentKind = proposalKind(agentText);
  const checklist = parseChecklist(text, config) || [];
  const rows = parseGapTable(text, config);
  const open = checklist.filter((r) => r.blocking && r.status !== "complete");
  let kind;
  let why;
  if (open.length) {
    kind = "ask";
    why = `${open.length} required item${open.length === 1 ? " is" : "s are"} open: ${open.map((r) => r.item).join("; ")}`;
  } else if (!rows) {
    if (!checklist.length) return null; // nothing to judge by
    kind = "refer";
    why = "the review stopped before the criteria were checked";
  } else {
    const refer = rows.filter((r) => (rules.refer || []).includes(r.mark));
    const ask = rows.filter((r) => (rules.ask || []).includes(r.mark) || !r.mark);
    if (refer.length) {
      kind = "refer";
      why = `${several(refer)} marked "${refer[0].mark}"`;
    } else if (ask.length) {
      kind = "ask";
      why = `${several(ask)} not marked "${config.draft.passMark}"`;
    } else {
      kind = "approve";
      why = "every criterion is met";
    }
  }
  return { kind, label: (rules.labels || {})[kind] || kind, why, agentText, agentKind, agrees: !agentKind || agentKind === kind };
}

// True when nothing in the draft stands in the way of approval: no blocking
// item of the completeness check is open, and every row of the review carries
// the desk's pass mark. Null when the draft gives nothing to judge by.
function allPass(text, config) {
  const pass = config && config.draft && config.draft.passMark;
  if (!pass) return null;
  const checklist = parseChecklist(text, config);
  if (checklist && checklist.some((r) => r.blocking && r.status !== "complete")) return false;
  const rows = parseGapTable(text, config);
  if (rows) return rows.every((r) => r.mark === pass);
  // A completeness check with no criteria table after it is a review that a
  // gate stopped: nothing was found to support approval.
  return checklist ? false : null;
}

// The letter a decision sends, for desks whose config has one for that
// outcome. The desk writes it from the case and the decision; no model does.
function letterFor(config, c, d, who, note, now = new Date()) {
  const L = (config.letters || {})[d.outcome];
  if (!L) return null;
  const iso = (dt) => dt.toISOString().slice(0, 10);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const readable = (dt) => `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
  const until = new Date(now);
  until.setUTCDate(until.getUTCDate() + (L.days || 0));
  const number = `${L.prefix || "REF"}-${iso(now).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const fill = (s) => String(s).split("{number}").join(number).split("{date}").join(L.dateStyle === "long" ? readable(now) : iso(now)).split("{until}").join(L.dateStyle === "long" ? readable(until) : iso(until));
  const latest = c.drafts.length ? c.drafts[c.drafts.length - 1].text : "";
  let list = [];
  if (L.list === "note") list = String(note || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (L.list === "met") list = (parseGapTable(latest, config) || []).filter((r) => r.mark === config.draft.passMark).map((r) => `${r.requirement} (${r.source})`);
  const lines = [
    `# ${L.title}`,
    "",
    `Reference: ${number}`,
    `Date: ${L.dateStyle === "long" ? readable(now) : iso(now)}`,
    L.toField && c.fields[L.toField] ? `To: ${c.fields[L.toField]}` : null,
    "",
    L.opening,
    "",
    ...(L.fields || []).filter((key) => c.fields[key]).map((key) => `- ${labelOf(config, key)}: ${c.fields[key]}`),
    "",
    list.length ? `## ${L.listHeading}` : null,
    ...list.map((s) => `- ${s}`),
    list.length ? "" : null,
    L.dateLine ? fill(L.dateLine) : null,
    "",
    ...(L.body || []).map(fill),
    "",
    L.signature || "",
  ].filter((l) => l !== null);
  return { kind: d.outcome, number, at: now.toISOString(), by: who.email, until: iso(until), text: lines.join("\n").replace(/\n{3,}/g, "\n\n") };
}

function summaryOf(text, config) {
  // draft.sections holds the agent's own heading names (strings) and may also
  // hold the long-writing sections of a desk (objects); only a string is read here.
  const names = ((config && config.draft && config.draft.sections) || []).filter((x) => typeof x === "string");
  const next = names[1] || "draft gap analysis";
  const esc = next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = String(text || "").match(new RegExp(`summary\\s*\\n([\\s\\S]*?)(?:\\n\\s*\\n|\\n(?=#|\\||${esc}))`, "i"));
  return m ? m[1].trim() : "";
}

// The conversation about a case rides the same session as the draft, so the
// agent already has the publication and the draft in context. If the session
// was lost (or never made), the first message carries the context again.
function chatPrompt(config, c, message, sessionKnown) {
  if (sessionKnown) return message;
  const latest = c.drafts.length ? c.drafts[c.drafts.length - 1].text : "(no draft yet)";
  return [
    `Context: a ${config.desk.caseNoun} at the ${config.desk.name}, and the current draft ${config.desk.draftNoun}. Answer the question that follows about it; do not re-issue the whole draft unless asked.`,
    "",
    shape(config).heading,
    caseText(config, c),
    "",
    `THE CURRENT DRAFT`,
    latest,
    "",
    "THE QUESTION",
    message,
  ].join("\n");
}

// Several agents behind one desk. config.routing = { field, kinds: { <value>:
// { agentEnv, instruction } } } picks, by the value of one intake field, the
// environment variable that holds the agent id and the drafting instruction.
// A value that is not in the map, or no routing key, gives the desk's own
// defaults. Values are compared without regard to case.
function routeOf(config, c) {
  const none = { kind: "", routed: false, agentEnv: "", instruction: "" };
  const r = config.routing;
  if (!r || !r.field || !r.kinds) return none;
  const value = String((c.fields && c.fields[r.field]) || "").trim().toLowerCase();
  const key = Object.keys(r.kinds).find((k) => k.trim().toLowerCase() === value);
  if (!value || !key) return none;
  const kind = r.kinds[key] || {};
  return { kind: key, routed: true, agentEnv: kind.agentEnv || "", instruction: kind.instruction || "" };
}

// What a kind of work shows: the decisions and the marks it names
// (routing.kinds.<kind>.decisions and .marks). A list that is missing or empty
// is null, which means every decision or every mark, as on a desk with no routing.
function kindRules(config, c) {
  const r = routeOf(config, c);
  // A value the desk does not know takes the lists in routing.other, where the desk gives them.
  const other = config.routing && config.routing.kinds && config.routing.other && typeof config.routing.other === "object" ? config.routing.other : {};
  const kind = r.routed ? config.routing.kinds[r.kind] || {} : other;
  const list = (v) => (Array.isArray(v) && v.length ? v.map(String) : null);
  return { kind: r.kind, decisions: list(kind.decisions), marks: list(kind.marks) };
}

// How a kind of work words its marks and the lines of a row
// (routing.kinds.<kind>.markLabels, .markHints, .markTones, .rowLabels). Each is
// laid over the desk's own setting of the same name, key by key. A kind that
// names none of them, and a desk with no routing, get the config as it is.
const LOOK_KEYS = { markLabels: "marks", markHints: "markHints", markTones: "markTones", rowLabels: "rowLabels" };
function lookConfig(config, c) {
  const r = routeOf(config, c);
  const kind = r.routed ? config.routing.kinds[r.kind] || {} : {};
  const draft = { ...(config.draft || {}) };
  let changed = false;
  for (const [from, to] of Object.entries(LOOK_KEYS)) {
    if (kind[from] && typeof kind[from] === "object" && !Array.isArray(kind[from])) {
      draft[to] = { ...(draft[to] || {}), ...kind[from] };
      changed = true;
    }
  }
  return changed ? { ...config, draft } : config;
}

function findDecision(config, id) {
  return config.decisions.find((d) => d.id === id) || null;
}

// Who may decide. Four eyes: the person who dropped the publication in cannot
// decide it. A publication the feed or a sweep brought in has no requester to
// exclude. A sent-back case is decided only after a new draft.
function canDecide(config, c, who, d) {
  if (c.status !== "for_review") {
    return {
      ok: false,
      reason:
        c.status === "sent_back"
          ? `a ${config.desk.caseNoun} that was sent back needs a new draft before it can be decided`
          : `a ${config.desk.caseNoun} can be decided only while it is for review`,
    };
  }
  const redo = Boolean(d && d.outcome === "sent_back" && config.rules.fourEyesAllowsRedo);
  if (!redo && config.rules.fourEyes && c.requested_by.source !== "system" && c.requested_by.email === who.email) {
    return { ok: false, reason: config.rules.fourEyesText };
  }
  return { ok: true };
}

// meta: what the agent's draft was made with, for the register: agent_id,
// run_id, library (the policy library's source name).
function recordDraft(c, text, by, sessionId, now = new Date(), meta = {}) {
  const version = c.drafts.length + 1;
  c.drafts.push({
    version,
    text,
    by,
    at: now.toISOString(),
    agent_session_id: sessionId || "",
    agent_id: meta.agent_id || "",
    run_id: meta.run_id || "",
    library: meta.library || "",
    tools: meta.tools || [],
    warning: meta.warning || "",
  });
  if (sessionId) c.agent_session_id = sessionId;
  // A redo answers the send-back; the decision stays in the events and the
  // register, and the case is open again.
  if (c.status === "sent_back") c.decision = null;
  c.status = "for_review";
  c.events.push({ at: now.toISOString(), who: by, what: by === "agent" ? `wrote draft ${version}` : `edited the text, now draft ${version}` });
  return c;
}

// An officer corrects a publication's details. Allowed while the case is not
// closed; every change is an event.
function updateFields(config, c, patch, who, now = new Date()) {
  if (shape(config).closed.includes(c.status)) throw new Error("this case is closed");
  const { errors, fields } = validateIntake(config, { ...c.fields, ...patch });
  if (errors.length) throw new Error(errors.join("; "));
  const changed = Object.keys(fields).filter((k) => fields[k] !== c.fields[k]);
  if (!changed.length) return c;
  c.fields = fields;
  c.events.push({ at: now.toISOString(), who: who.email, what: `details changed: ${changed.join(", ")}` });
  return c;
}

// A wrong entry is removed from the desk, not deleted: it stays in the
// records with the reason, out of the list.
function removeCase(config, c, who, note, now = new Date()) {
  if (shape(config).closed.filter((s) => s !== "removed").includes(c.status)) throw new Error("a decided case cannot be removed");
  if (!(note || "").trim()) throw new Error("removing needs a note");
  c.status = "removed";
  c.removed = { by: who.email, at: now.toISOString(), note };
  c.events.push({ at: now.toISOString(), who: who.email, what: `removed from the desk: ${note}` });
  return c;
}

// The register row for a removal, for desks that record removals there.
function removalEntry(config, c, who, note, now = new Date()) {
  return {
    at: now.toISOString(),
    case_id: c.id,
    ...Object.fromEntries(config.intake.fields.filter((f) => f.type !== "textarea").map((f) => [f.key, c.fields[f.key] || ""])),
    arrived_via: c.arrived_via,
    requested_by: c.requested_by.email,
    draft_versions: c.drafts.length,
    decision: "removed",
    decided_by: who.email,
    identity_source: who.source,
    decided_at: now.toISOString(),
    note: note || "",
    agent_session_id: c.agent_session_id,
    issued_text: "",
  };
}

// Is this publication already on the desk? By link, else by title.
function findDuplicate(list, { link, title }) {
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\/+$/, "");
  const l = norm(link);
  const t = norm(title);
  return (
    list.find((c) => c.status !== "removed" && ((l && norm(c.fields.link) === l) || (t && norm(c.fields.title) === t))) || null
  );
}

// Applies a decision and returns the register entry. An edited draft given
// with the decision is recorded first as a new version by the officer, so the
// register says what was issued and that a person changed it.
function applyDecision(config, c, decisionId, who, note, editedDraft, now = new Date()) {
  const d = findDecision(config, decisionId);
  if (!d) throw new Error(`unknown decision: ${decisionId}`);
  const rules = kindRules(config, c);
  if (rules.decisions && !rules.decisions.includes(d.id)) throw new Error(`"${d.label}" is not a decision for this kind of ${config.desk.caseNoun}${rules.kind ? ` (${rules.kind})` : ""}`);
  const check = canDecide(config, c, who, d);
  if (!check.ok) throw new Error(check.reason);
  if (d.needsNote && !(note || "").trim()) throw new Error(`"${d.label}" needs a note`);
  const latest = c.drafts.length ? c.drafts[c.drafts.length - 1].text : "";
  // Approving against the draft's own marks takes a reason, where the desk asks for one.
  if (d.outcome === "issued" && config.rules.reasonToApproveUnmet && !(note || "").trim()) {
    if (allPass(editedDraft != null && editedDraft.trim() ? editedDraft : latest, config) === false) {
      throw new Error(config.rules.reasonToApproveUnmetText || "Approving while a row is not met needs a reason");
    }
  }
  if (editedDraft != null && editedDraft.trim() && editedDraft !== latest) {
    recordDraft(c, editedDraft, who.email, c.agent_session_id, now);
  }
  c.decision = { id: d.id, outcome: d.outcome, by: who.email, by_source: who.source, at: now.toISOString(), note: note || "" };
  c.status = d.outcome;
  // The history reads as a sentence with the desk's own past-tense label (Escalated, Asked for more information) where it has one.
  // A label that already holds a colon ("decided: open a case") takes its note as a second sentence.
  const done = String((config.decisionLabels || {})[d.outcome] || d.label).toLowerCase();
  c.events.push({ at: now.toISOString(), who: who.email, what: `${done}${note ? (done.includes(":") ? `. Note: ${note}` : `: ${note}`) : ""}` });
  const letter = letterFor(config, c, d, who, note, now);
  if (letter) {
    c.letters = (c.letters || []).concat(letter);
    c.events.push({ at: now.toISOString(), who: who.email, what: `letter ${letter.number} prepared` });
  }
  const agentDrafts = c.drafts.filter((v) => v.by === "agent");
  const entry = {
    at: now.toISOString(),
    case_id: c.id,
    // Every short field of the case, under its own key, so a desk's register
    // can carry whichever of them its config names as columns.
    ...Object.fromEntries(config.intake.fields.filter((f) => f.type !== "textarea").map((f) => [f.key, c.fields[f.key] || ""])),
    arrived_via: c.arrived_via,
    requested_by: c.requested_by.email,
    draft_versions: c.drafts.length,
    decision: d.outcome,
    decided_by: who.email,
    identity_source: who.source,
    decided_at: c.decision.at,
    note: note || "",
    library: agentDrafts.length ? agentDrafts[agentDrafts.length - 1].library : "",
    agent_id: agentDrafts.length ? agentDrafts[agentDrafts.length - 1].agent_id : "",
    run_ids: agentDrafts.map((v) => v.run_id).filter(Boolean).join(" "),
    tool_calls: agentDrafts.length ? (agentDrafts[agentDrafts.length - 1].tools || []).map((t) => t.name).join(" ") : "",
    platform_warning: agentDrafts.length ? agentDrafts[agentDrafts.length - 1].warning || "" : "",
    agent_session_id: c.agent_session_id,
    letter_number: letter ? letter.number : "",
    issued_text: d.outcome === "issued" ? (c.drafts.length ? c.drafts[c.drafts.length - 1].text : "") : "",
  };
  return entry;
}

// A reply from outside arrives on a case that was waiting for it. The reply
// joins the case's text, and the case goes back to the agent for a new draft
// in the light of it. Nothing can be decided until that draft is in.
function addReply(config, c, text, who, now = new Date()) {
  const k = shape(config);
  if (!k.waiting.includes(c.status)) throw new Error(`a reply can be added only while the ${config.desk.caseNoun} is waiting for one`);
  if (!(text || "").trim()) throw new Error("the reply is empty");
  const kc = config.case || {};
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  c.fields[k.textField] = `${c.fields[k.textField] || ""}\n\n${kc.replyHeading || "Reply received"}, ${day}:\n${text.trim()}`.trim();
  c.status = "sent_back";
  c.decision = { id: "reply", outcome: "sent_back", by: who.email, by_source: who.source, at: now.toISOString(), note: kc.replyNote || "A reply has been added at the end of the text. Review everything again in the light of it." };
  c.events.push({ at: now.toISOString(), who: who.email, what: (kc.replyEvent || "added a reply") });
  return c;
}

// The fuller record for desks whose config asks for one (config.audit): the
// request, the completeness check, each criterion, the decision and its
// reason, what was asked of the outside party, the trail, and how the record
// was made. Written by the desk from what it holds.
function auditDocument(config, c) {
  const latest = c.drafts[c.drafts.length - 1];
  const k = shape(config);
  const rows = parseGapTable(latest.text, config) || [];
  const checklist = parseChecklist(latest.text, config) || [];
  const agentDrafts = c.drafts.filter((v) => v.by === "agent");
  const lastAgent = agentDrafts[agentDrafts.length - 1] || {};
  const proposal = proposalOf(lastAgent.text || "", config);
  const cell = (s) => String(s || "").replace(/\|/g, "/");
  const letters = c.letters || [];
  const outside = c.events.filter((e) => /letter .* prepared|reply/i.test(e.what));
  return [
    `# ${config.desk.draftNoun[0].toUpperCase()}${config.desk.draftNoun.slice(1)}: ${c.fields.title}`,
    "",
    `${k.metaFields.map((key) => `${labelOf(config, key)}: ${c.fields[key] || ""}`).join(". ")}.`,
    `${decisionLabel(config, c.decision.outcome)} by ${c.decision.by} on ${c.decision.at}. Draft version ${latest.version} of ${c.drafts.length}.`,
    "",
    "## 1. Summary",
    summaryOf(latest.text, config) || "No summary was written.",
    "",
    "## 2. The request",
    ...config.intake.fields.filter((f) => f.key !== k.textField && c.fields[f.key]).map((f) => `- ${f.label}: ${c.fields[f.key]}`),
    "",
    `${labelOf(config, k.textField)}:`,
    c.fields[k.textField] || "None supplied.",
    "",
    "## 3. Completeness check",
    ...(checklist.length ? ["| Item | Status | What was found | Holds the request up |", "|---|---|---|---|", ...checklist.map((r) => `| ${cell(r.item)} | ${r.status} | ${cell(r.detail)} | ${r.blocking ? "yes" : "no"} |`)] : ["The draft carried no completeness check."]),
    "",
    "## 4. Criterion by criterion",
    ...(rows.length ? ["| # | Criterion | Source | Evidence | Where | Mark | To check |", "|---|---|---|---|---|---|---|", ...rows.map((r) => `| ${cell(r.n)} | ${cell(r.requirement)} | ${cell(r.source)} | ${cell(r.policy)} | ${cell(r.citation)} | ${r.mark || cell(r.markText)} | ${cell(r.check)} |`)] : ["The draft carried no criteria table."]),
    "",
    "## 5. Decision and reason",
    `- Decision: ${decisionLabel(config, c.decision.outcome)}`,
    `- Decided by: ${c.decision.by} (${c.decision.by_source === "platform-sign-in" ? "platform sign-in" : "local sign-in"})`,
    `- Decided at: ${c.decision.at}`,
    `- The agent proposed: ${proposal || "nothing"}`,
    (() => {
      const dp = derivedProposal(lastAgent.text || "", config);
      return dp ? `- By the desk's rules from the marks: ${dp.label}, because ${dp.why}${dp.agrees ? "" : ". The agent's own line differed."}` : null;
    })(),
    `- The reviewer's note: ${c.decision.note || "none"}`,
    latest.by !== "agent" ? `- The reviewer edited the draft: version ${latest.version} is theirs.` : "- The reviewer did not edit the draft.",
    "",
    "## 6. Letters and replies",
    ...(letters.length || outside.length
      ? [...letters.map((l) => ({ at: l.at, line: `- ${l.at}: letter ${l.number} (${decisionLabel(config, l.kind)})` })), ...outside.filter((e) => /reply/i.test(e.what)).map((e) => ({ at: e.at, line: `- ${e.at}: ${e.who} ${e.what}` }))].sort((a, b) => (a.at < b.at ? -1 : 1)).map((x) => x.line)
      : ["None."]),
    "",
    "## 7. Audit trail",
    ...c.events.map((e) => `- ${e.at}: ${e.who} ${e.what}`),
    "",
    "## 8. How this record was made",
    `- An agent drafted the review. A person decided. The agent cannot approve, and the desk has no decision that refuses a ${config.desk.caseNoun}.`,
    `- Agent: ${lastAgent.agent_id || "not recorded"}. Runs: ${agentDrafts.map((v) => v.run_id).filter(Boolean).join(", ") || "not recorded"}.`,
    `- Compared against: ${lastAgent.library || "not recorded"}.`,
    `- Versions: ${c.drafts.map((v) => `${v.version} by ${v.by === "agent" ? "the agent" : v.by}`).join("; ")}.`,
    lastAgent.warning ? `- Platform warning on the last run: ${lastAgent.warning}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// Who wrote each version of the draft, in one sentence or two.
function versionAuthors(c) {
  const list = (vs) => (vs.length === 1 ? `version ${vs[0]}` : `versions ${vs.slice(0, -1).join(", ")} and ${vs[vs.length - 1]}`);
  const agent = c.drafts.filter((v) => v.by === "agent").map((v) => v.version);
  const people = c.drafts.filter((v) => v.by !== "agent");
  const parts = [];
  if (agent.length) parts.push(`The agent wrote ${list(agent)}.`);
  for (const by of [...new Set(people.map((v) => v.by))]) parts.push(`${by} edited ${list(people.filter((v) => v.by === by).map((v) => v.version))}.`);
  return parts.join(" ");
}

// The document that is issued on approval.
function issuedDocument(config, c) {
  if (config.audit) return auditDocument(config, c);
  const latest = c.drafts[c.drafts.length - 1];
  return [
    `# ${config.desk.draftNoun[0].toUpperCase()}${config.desk.draftNoun.slice(1)}: ${c.fields.title}`,
    "",
    `${shape(config).metaFields.map((key) => `${labelOf(config, key)}: ${c.fields[key] || ""}`).join(". ")}.${c.fields.link ? ` Link: ${c.fields.link}.` : ""}`,
    `${(config.desk && config.desk.issuedVerb) || "Issued by"} ${c.decision.by} on ${niceTime(c.decision.at)}. Draft version ${latest.version} of ${c.drafts.length}. ${versionAuthors(c)}`,
    c.decision.note ? `Note: ${c.decision.note}` : "",
    "",
    shared.retitle(latest.text, config).replace(/^.*Not issued\.?\s*$/im, "").trim(),
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// A sweep asks the agent what a regulator published. The reply is prose; this
// picks out lines that look like a publication so the officer can add one as
// a case with one click. Anything it misses, the officer adds by hand.
function parseSweep(text) {
  const found = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (!line || line.length < 12) continue;
    const link = (line.match(/https?:\/\/\S+/) || [""])[0].replace(/[),.\]]+$/, "");
    const date = (line.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2} [A-Z][a-z]+ \d{4}|[A-Z][a-z]+ \d{1,2}, \d{4})\b/) || [""])[0];
    if (!link && !date) continue;
    let title = line.split(/\s[-–—:|]\s|\(|,\s(?=\d{1,2} [A-Z])/)[0].replace(/\*\*/g, "").replace(/^["“]|["”]$/g, "").trim();
    if (title.length > 160) title = title.slice(0, 157) + "...";
    found.push({ title, date, link, line });
  }
  return found;
}

function sweepPrompt(config, regulator, subject, days) {
  return `What has ${regulator} published on ${subject} in the last ${days} days? List each publication on its own line: its title, its date (YYYY-MM-DD), what it changes, and its link, as the search returned them. If the search returns nothing for the period, say so. Do not compare with the policy library yet.`;
}

module.exports = {
  niceTime,
  routeOf,
  kindRules,
  lookConfig,
  parseSections: shared.parseSections,
  newId,
  validateIntake,
  newCase,
  shape,
  labelOf,
  caseText,
  marksOf,
  draftPrompt,
  localPassages,
  libraryQueries,
  chatPrompt,
  parseGapTable,
  summaryOf,
  proposalOf,
  proposalKind,
  derivedProposal,
  gateNote,
  decisionLabel,
  removalEntry,
  parseChecklist,
  letterFor,
  auditDocument,
  allPass,
  addReply,
  MARKS,
  findDecision,
  canDecide,
  recordDraft,
  updateFields,
  removeCase,
  findDuplicate,
  applyDecision,
  issuedDocument,
  parseSweep,
  sweepPrompt,
};
