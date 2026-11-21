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

function newId(prefix, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function validateIntake(config, body) {
  const errors = [];
  const fields = {};
  for (const f of config.intake.fields) {
    const v = body && body[f.key] != null ? String(body[f.key]).trim() : "";
    if (f.required && !v) errors.push(`${f.label} is required`);
    if (f.type === "date" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${f.label} must be YYYY-MM-DD`);
    fields[f.key] = v;
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

function publicationText(c) {
  const f = c.fields;
  const lines = [
    `Title: ${f.title}`,
    `Regulator: ${f.regulator}`,
    `Published on: ${f.published_on}`,
  ];
  if (f.link) lines.push(`Link: ${f.link}`);
  if (f.subject) lines.push(`Subject: ${f.subject}`);
  if (f.text) lines.push("", "Text, or the passages that matter:", f.text);
  else lines.push("", "No text was supplied. If a search tool is connected, read the publication at its link; otherwise say that you have only the title and work from it.");
  return lines.join("\n");
}

// The message that asks the agent for the summary and the draft. After a
// send-back it also carries the officer's note and the draft being replaced,
// so the redo is a redo and not a repeat.
// The searches the desk runs on the library for a publication, when the desk
// does the retrieval itself: its title, its subject, and each sentence of the
// text it was given.
function libraryQueries(c) {
  const f = c.fields;
  const qs = [f.title, f.subject];
  for (const s of String(f.text || "").split(/(?<=[.;:])s+/)) if (s.trim().length > 25) qs.push(s.trim().slice(0, 300));
  return [...new Set(qs.filter(Boolean))].slice(0, 10);
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
  const parts = [config.draft.instruction, "", "THE PUBLICATION", publicationText(c)];
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
      "THE POLICY LIBRARY",
      `The desk has searched the policy library "${passages[0].library || "policy library"}" for you. The passages it returned are below, each with its document. Treat them as the policy library's search results: compare each requirement with them, and cite the document and the clause number at the start of the passage. Where no passage bears on a requirement, mark it "not found". Do not say that no policy library is connected.`,
      "",
      ...passages.map((p, i) => `[${i + 1}] ${p.document}: ${p.text}`),
    );
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

function parseGapTable(text) {
  const rows = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((s) => s.trim());
    if (cells.length < 6) continue;
    if (/^-+:?$/.test(cells[0].replace(/\s/g, "")) || /^:?-+/.test(cells[1] || "")) continue; // the rule line
    if (/^#$/.test(cells[0]) || /^requirement$/i.test(cells[1] || "")) continue; // the header
    const [n, requirement, source, policy, citation, mark, check] = cells.length >= 7 ? cells : [...cells, ""];
    const m = MARKS.find((k) => (mark || "").toLowerCase().startsWith(k)) || "";
    rows.push({ n, requirement, source, policy, citation, mark: m, markText: mark || "", check: check || "" });
  }
  return rows.length ? rows : null;
}

function summaryOf(text) {
  const m = String(text || "").match(/summary\s*\n([\s\S]*?)(?:\n\s*\n|\n(?=#|\||draft gap analysis))/i);
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
    "THE PUBLICATION",
    publicationText(c),
    "",
    `THE CURRENT DRAFT`,
    latest,
    "",
    "THE QUESTION",
    message,
  ].join("\n");
}

function findDecision(config, id) {
  return config.decisions.find((d) => d.id === id) || null;
}

// Who may decide. Four eyes: the person who dropped the publication in cannot
// decide it. A publication the feed or a sweep brought in has no requester to
// exclude. A sent-back case is decided only after a new draft.
function canDecide(config, c, who) {
  if (c.status !== "for_review") {
    return {
      ok: false,
      reason:
        c.status === "sent_back"
          ? `a ${config.desk.caseNoun} that was sent back needs a new draft before it can be decided`
          : `a ${config.desk.caseNoun} can be decided only while it is for review`,
    };
  }
  if (config.rules.fourEyes && c.requested_by.source !== "system" && c.requested_by.email === who.email) {
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
  c.events.push({ at: now.toISOString(), who: by, what: `draft ${version} ${by === "agent" ? "written by the agent" : "edited"}` });
  return c;
}

// An officer corrects a publication's details. Allowed while the case is not
// closed; every change is an event.
function updateFields(config, c, patch, who, now = new Date()) {
  if (["issued", "no_action", "removed"].includes(c.status)) throw new Error("this case is closed");
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
  if (["issued", "no_action"].includes(c.status)) throw new Error("a decided case cannot be removed");
  if (!(note || "").trim()) throw new Error("removing needs a note");
  c.status = "removed";
  c.removed = { by: who.email, at: now.toISOString(), note };
  c.events.push({ at: now.toISOString(), who: who.email, what: `removed from the desk: ${note}` });
  return c;
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
  const check = canDecide(config, c, who);
  if (!check.ok) throw new Error(check.reason);
  if (d.needsNote && !(note || "").trim()) throw new Error(`"${d.label}" needs a note`);
  const latest = c.drafts.length ? c.drafts[c.drafts.length - 1].text : "";
  if (editedDraft != null && editedDraft.trim() && editedDraft !== latest) {
    recordDraft(c, editedDraft, who.email, c.agent_session_id, now);
  }
  c.decision = { id: d.id, outcome: d.outcome, by: who.email, by_source: who.source, at: now.toISOString(), note: note || "" };
  c.status = d.outcome;
  c.events.push({ at: now.toISOString(), who: who.email, what: `${d.label.toLowerCase()}${note ? `: ${note}` : ""}` });
  const agentDrafts = c.drafts.filter((v) => v.by === "agent");
  const entry = {
    at: now.toISOString(),
    case_id: c.id,
    title: c.fields.title,
    regulator: c.fields.regulator,
    published_on: c.fields.published_on,
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
    issued_text: d.outcome === "issued" ? (c.drafts.length ? c.drafts[c.drafts.length - 1].text : "") : "",
  };
  return entry;
}

// The document that is issued on approval.
function issuedDocument(config, c) {
  const latest = c.drafts[c.drafts.length - 1];
  return [
    `# ${config.desk.draftNoun[0].toUpperCase()}${config.desk.draftNoun.slice(1)}: ${c.fields.title}`,
    "",
    `Regulator: ${c.fields.regulator}. Published on: ${c.fields.published_on}.${c.fields.link ? ` Link: ${c.fields.link}.` : ""}`,
    `Issued by ${c.decision.by} on ${c.decision.at}. Draft version ${latest.version} of ${c.drafts.length}; version 1 was written by the agent${c.drafts.length > 1 ? ", later versions by the officer" : ""}.`,
    c.decision.note ? `Note: ${c.decision.note}` : "",
    "",
    latest.text.replace(/^.*Not issued\.?\s*$/im, "").trim(),
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
  newId,
  validateIntake,
  newCase,
  publicationText,
  draftPrompt,
  libraryQueries,
  chatPrompt,
  parseGapTable,
  summaryOf,
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
