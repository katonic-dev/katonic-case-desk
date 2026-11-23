// The case desk: the page. One React file, no JSX and no build step: the
// browser runs it as it is. `h` is React.createElement.
//
// Three columns: the cases on the left with their status, the draft in the
// middle, the decision and the conversation with the agent on the right. A
// Register tab shows what was decided, by whom and when.

const h = React.createElement;
const BASE = window.APP_BASE || "";

async function api(route, options) {
  const r = await fetch(`${BASE}${route}`, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// Times in the reader's own zone, with the zone named.
const ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (err) {
    return "";
  }
})();
function fmt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

const OPEN_STATUSES = ["new", "drafting", "for_review", "sent_back"];

function Chip({ config, status }) {
  return h("span", { className: `chip ${status}` }, status === "drafting" ? h("span", { className: "dot" }) : null, config.statuses[status] || status);
}

function hostOf(link) {
  try {
    return new URL(link).host.replace(/^www\./, "");
  } catch (err) {
    return link;
  }
}

// A desk may give each of its marks a tone (ok, warn, err, none) in
// config.draft.markTones; without one the mark's own name is the class.
function markClass(mark, tone) {
  return tone ? `tone-${tone}` : mark.replace(/ /g, "-") || "unknown";
}

function Mark({ config, mark, text, tone }) {
  const label = (config.draft.marks || {})[mark] || text || "";
  return h("span", { className: `mark ${markClass(mark, tone)}`, title: (config.draft.markHints || {})[mark] || undefined }, label);
}

function labelOf(config, key) {
  const f = config.intake.fields.find((x) => x.key === key);
  return f ? f.label : key;
}

// The fields a desk shows under a case's title and on its line in the list.
function metaFields(config) {
  return (config.case && config.case.metaFields) || ["regulator", "published_on"];
}

function closedStatuses(config) {
  return config.closedStatuses || ["issued", "no_action", "removed"];
}

function waitingStatuses(config) {
  return config.waitingStatuses || [];
}

// A date-only value ("2026-11-16") in the same style as the times on the page.
function fmtDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return value;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function show(config, key, value) {
  const f = config.intake.fields.find((x) => x.key === key);
  return f && f.type === "date" ? fmtDay(value) : value;
}

// Where a case came from, in the desk's own words.
function viaLabel(config, via) {
  return ((config.desk && config.desk.arrivedVia) || {})[via] || "";
}

// When a case is due, for desks whose config gives a turnaround:
// config.due = { field, urgencyField, standardDays, expeditedDays }.
function dueOf(config, c) {
  const d = config.due;
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(c.fields[d.field] || "")) return null;
  const expedited = /expedit|urgent/i.test(c.fields[d.urgencyField] || "");
  const date = new Date(`${c.fields[d.field]}T00:00:00`);
  date.setDate(date.getDate() + (expedited ? d.expeditedDays : d.standardDays));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((date - today) / 86400000);
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { date, expedited, days, text: days < 0 ? `Overdue since ${day}` : days === 0 ? "Due today" : `Due ${day}`, tone: days < 0 ? "err" : days <= 2 ? "warn" : "" };
}

function DueChip({ config, c }) {
  const due = dueOf(config, c);
  if (!due || closedStatuses(config).includes(c.status)) return null;
  return h("span", { className: `due ${due.tone}` }, h(Icon, { name: "clock" }), due.text);
}

// A small set of line icons, drawn here so the desk needs no icon files.
const ICONS = {
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5M9 13h6M9 17h6",
  mail: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm0 1 8 6 8-6",
  inbox: "M3 13l3-8h12l3 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5Zm0 0h5l1 2h6l1-2h5",
};

function Icon({ name }) {
  return h("svg", { className: "icon", viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: ICONS[name] }));
}

// A count of the marks in a review: "3 met, 1 partly met".
function tally(config, rows) {
  const counts = {};
  for (const r of rows) counts[r.mark || "unmarked"] = (counts[r.mark || "unmarked"] || 0) + 1;
  return Object.keys(config.draft.marks || {})
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${config.draft.marks[k].toLowerCase()}`)
    .concat(counts.unmarked ? [`${counts.unmarked} unmarked`] : [])
    .join(", ");
}

// The gap analysis as the agent wrote it: one row per requirement when it
// wrote the table it was asked for, else the text. The parser lives on the
// server (lib/cases.js); the page gets rows. The mark is the row's edge.
// A small label in front of a line of a row, where the desk's config names one.
function rowLabel(config, key) {
  const t = (config.draft.rowLabels || {})[key];
  return t ? h("span", { className: "lbl" }, t) : null;
}

function GapRows({ config, rows }) {
  return h(
    "div",
    { className: "gap" },
    rows.map((r, i) =>
      h(
        "div",
        { key: i, className: `gaprow ${markClass(r.mark, r.tone)}` },
        h("div", { className: "n" }, r.n),
        h(
          "div",
          null,
          h("div", { className: "req" }, h("span", { className: "text" }, r.requirement), h(Mark, { config, mark: r.mark, text: r.markText, tone: r.tone })),
          r.source ? h("div", { className: "src" }, rowLabel(config, "source"), r.source) : null,
          h("div", { className: "pol" }, rowLabel(config, "policy"), r.policy, r.citation ? h("span", { className: "cite" }, r.citation) : null),
          r.check ? h("div", { className: "chk" }, h("b", null, "Check: "), r.check) : null,
        ),
      ),
    ),
  );
}

// The completeness check: one line when nothing holds the case up, the open
// items when something does, and every item on request.
function Checklist({ rows }) {
  const required = rows.filter((r) => r.blocking);
  const open = required.filter((r) => r.status !== "complete");
  const flagged = rows.filter((r) => !r.blocking && r.status !== "complete");
  return h(
    "div",
    { className: `checkline ${open.length ? "held" : "ok"}` },
    h("div", null, h("b", null, "Completeness check: "), open.length ? `${open.length} required item${open.length === 1 ? "" : "s"} open. The review of the criteria waits for ${open.length === 1 ? "it" : "them"}.` : `all ${required.length} required items complete${flagged.length ? `, ${flagged.length} to note` : ""}.`),
    open.concat(flagged).map((r, i) => h("div", { key: i, className: "item" }, h("span", { className: `mark ${r.blocking ? "tone-err" : "tone-warn"}` }, r.status), " ", h("b", null, r.item), r.detail ? `: ${r.detail}` : "")),
    h("details", null, h("summary", null, "Every item"), rows.map((r, i) => h("div", { key: i, className: "item" }, h("span", { className: `mark ${r.status === "complete" ? "tone-ok" : r.blocking ? "tone-err" : "tone-warn"}` }, r.status), " ", h("b", null, r.item), r.blocking ? "" : " (does not hold the request up)", r.detail ? `: ${r.detail}` : ""))),
  );
}

function Fields({ config, form, setForm, prefix = "f" }) {
  return config.intake.fields.map((f) => {
    const id = `${prefix}-${f.key}`;
    return h(
      "label",
      { key: f.key, htmlFor: id },
      f.label + (f.required ? "" : " (optional)"),
      f.type === "textarea"
        ? h("textarea", { id, name: f.key, value: form[f.key] || "", onChange: (e) => setForm({ ...form, [f.key]: e.target.value }) })
        : h("input", { id, name: f.key, type: f.type === "date" ? "date" : "text", value: form[f.key] || "", onChange: (e) => setForm({ ...form, [f.key]: e.target.value }) }),
    );
  });
}

function IntakeForm({ config, onCreated }) {
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const c = await api("/api/cases", { method: "POST", body: JSON.stringify(form) });
      setForm({});
      setOpen(false);
      onCreated(c);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }
  const label = config.desk.addLabel || `Drop a ${config.desk.caseNoun} in`;
  const opener = h("button", { className: "btn", onClick: () => setOpen(true) }, label);
  if (!open) return opener;
  return h(React.Fragment, null, opener, h("div", { className: "overlay", onMouseDown: (e) => { if (e.target === e.currentTarget) setOpen(false); } }, h(
    "form",
    { className: "form panel", onSubmit: submit },
    h("h2", null, label),
    h(Fields, { config, form, setForm }),
    err ? h("div", { className: "notice bad" }, err) : null,
    h(
      "div",
      { className: "row" },
      h("button", { className: "btn primary", type: "submit", disabled: busy }, busy ? "Adding..." : "Add and draft"),
      h("button", { className: "btn quiet", type: "button", onClick: () => setOpen(false) }, "Cancel"),
    ),
  )));
}

// The agent answers in light Markdown. Shows bold, headings, quotes and
// bullets as such, so the reader never sees the marks themselves.
function inlineRich(text, key) {
  const parts = String(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  return parts.map((p, i) => {
    if (p.length > 4 && p.startsWith("**") && p.endsWith("**")) return h("strong", { key: `${key}-${i}` }, p.slice(2, -2));
    if (p.length > 2 && p.startsWith("`") && p.endsWith("`")) return h("code", { key: `${key}-${i}` }, p.slice(1, -1));
    return p;
  });
}
function Rich({ text }) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  return lines.map((line, i) => {
    const nl = i < lines.length - 1 ? "\n" : "";
    let m;
    if ((m = line.match(/^\s*>\s?(.*)$/))) return h("span", { key: i, className: "quote" }, inlineRich(m[1], i), nl);
    if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) return h("strong", { key: i }, inlineRich(m[1], i), nl);
    if ((m = line.match(/^(\s*)[-*]\s+(.*)$/))) return h(React.Fragment, { key: i }, `${m[1]}\u2022 `, inlineRich(m[2], i), nl);
    return h(React.Fragment, { key: i }, inlineRich(line, i), nl);
  });
}

// One line about sweeps for the list column; the sweeps themselves have a tab.
function SweepLine({ onOpen }) {
  const [last, setLast] = React.useState(undefined);
  React.useEffect(() => {
    api("/api/sweeps").then((s) => setLast(s[0] || null)).catch(() => setLast(null));
  }, []);
  return h(
    "p",
    { className: "sweepline" },
    last === undefined ? "Sweeps" : last ? `Last sweep ${fmt(last.ran_at)}: ${last.error ? "failed" : `${last.found.length} found`}. ` : "No sweep has run yet. ",
    h("button", { className: "linklike", onClick: onOpen }, "Open sweeps"),
  );
}

function Sweeps({ config, onOpened }) {
  const [sweeps, setSweeps] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [progress, setProgress] = React.useState("");
  async function load() {
    setSweeps(await api("/api/sweeps"));
  }
  React.useEffect(() => {
    load().catch(() => {});
  }, []);
  async function run() {
    setBusy(true);
    setErr("");
    try {
      // The sweep outlasts one request, so start it and watch its status.
      let st = await api("/api/sweeps", { method: "POST", body: JSON.stringify({ wait: false }) });
      const deadline = Date.now() + 10 * 60 * 1000;
      while (st.running && Date.now() < deadline) {
        setProgress(`${st.done} of ${st.expected} regulators done`);
        await new Promise((r) => setTimeout(r, 3000));
        st = await api("/api/sweeps/status");
        if (st.done) await load();
      }
      if (st.running) setErr("The sweep is still running. Its results will appear here when it finishes.");
      else if (st.error) setErr(st.error);
      await load();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }
  async function open(s, i) {
    try {
      const c = await api(`/api/sweeps/${s.id}/open`, { method: "POST", body: JSON.stringify({ index: i }) });
      onOpened(c);
    } catch (ex) {
      setErr(ex.message);
    }
  }
  return h(
    "div",
    null,
    h("h2", null, "Sweeps"),
    h("p", { className: "small" }, `Asks the agent what ${config.sweeps.regulators.map((r) => r.regulator).join(" and ")} published in the last ${config.sweeps.defaultDays} days. On the platform the workflow runs this on its schedule; here it runs when you press the button.`),
    h("button", { className: "btn quiet", onClick: run, disabled: busy }, busy ? "Sweeping..." : "Run a sweep now"),
    busy ? h("p", { className: "small", role: "status" }, `About a minute per regulator. ${progress}`) : null,
    err ? h("div", { className: "notice bad" }, err) : null,
    sweeps.slice(0, 4).map((s) =>
      h(
        "details",
        { key: s.id },
        h("summary", null, `${s.regulator}, ${fmt(s.ran_at)}: ${s.error ? "failed" : `${s.found.length} line${s.found.length === 1 ? " that looks" : "s that look"} like a publication`}`),
        s.error ? h("div", { className: "notice bad" }, s.error) : null,
        s.found.map((f, i) =>
          h(
            "div",
            { className: "found", key: i },
            h("div", null, f.title),
            h("div", { className: "small" }, [f.date, f.link].filter(Boolean).join(" · ")),
            f.already ? h("span", { className: "small" }, "Already on the desk") : h("button", { className: "btn quiet", onClick: () => open(s, i) }, "Open as a case"),
          ),
        ),
        h("details", null, h("summary", null, "What the agent said"), h("div", { className: "msg" }, s.reply)),
      ),
    ),
  );
}

function CaseView({ config, me, c, refresh }) {
  const latest = c.drafts.length ? c.drafts[c.drafts.length - 1] : null;
  const [draft, setDraft] = React.useState(latest ? latest.text : "");
  const [editing, setEditing] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [choice, setChoice] = React.useState(""); // the decision picked, before its note
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const [question, setQuestion] = React.useState("");
  const [details, setDetails] = React.useState(null); // the edit-details form, or null
  const [removing, setRemoving] = React.useState(false);
  const [reply, setReply] = React.useState("");
  const [chatErr, setChatErr] = React.useState("");
  React.useEffect(() => {
    setDraft(latest ? latest.text : "");
    setEditing(false);
    setNote("");
    setChoice("");
    setErr("");
    setDetails(null);
    setRemoving(false);
    setReply("");
  }, [c.id, latest ? latest.version : 0, c.status]);

  const waiting = waitingStatuses(config).includes(c.status);
  const standIn = Boolean(latest && /^\[Stand-in agent/.test(latest.text));
  const open = c.status === "for_review";
  const closed = closedStatuses(config).includes(c.status);
  const edited = latest && draft !== latest.text;
  const fourEyesBlocked = config.rules.fourEyes && c.requested_by.source !== "system" && c.requested_by.email === me.email;
  const rows = latest && !editing ? c.gap_rows || null : null;

  async function decide(d) {
    setBusy(d.id);
    setErr("");
    try {
      await api(`/api/cases/${c.id}/decision`, { method: "POST", body: JSON.stringify({ decision: d.id, note, draft }) });
      await refresh();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy("");
    }
  }
  async function redraft() {
    setBusy("draft");
    setErr("");
    try {
      await api(`/api/cases/${c.id}/draft`, { method: "POST", body: "{}" });
      await refresh();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy("");
    }
  }
  async function ask(e) {
    e.preventDefault();
    if (!question.trim()) return;
    setBusy("chat");
    setChatErr("");
    try {
      await api(`/api/cases/${c.id}/chat`, { method: "POST", body: JSON.stringify({ message: question }) });
      setQuestion("");
      await refresh();
    } catch (ex) {
      setChatErr(ex.message);
    } finally {
      setBusy("");
    }
  }
  async function sendReply(e) {
    e.preventDefault();
    if (!reply.trim()) return;
    setBusy("reply");
    setErr("");
    try {
      await api(`/api/cases/${c.id}/reply`, { method: "POST", body: JSON.stringify({ text: reply }) });
      await refresh();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy("");
    }
  }
  async function saveDetails(e) {
    e.preventDefault();
    setBusy("details");
    setErr("");
    try {
      await api(`/api/cases/${c.id}`, { method: "PATCH", body: JSON.stringify(details) });
      setDetails(null);
      await refresh();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy("");
    }
  }
  async function remove(e) {
    e.preventDefault();
    setBusy("remove");
    setErr("");
    try {
      await api(`/api/cases/${c.id}/remove`, { method: "POST", body: JSON.stringify({ note }) });
      setRemoving(false);
      await refresh();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy("");
    }
  }

  // What the desk shows beside a case's text decides the layout: a desk that
  // shows the text a case came with puts it in its own pane beside the review.
  const twoPane = Boolean(config.case && config.case.showText);
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const kc = config.case || {};
  const facts = (keys) => keys.map((key) => show(config, key, c.fields[key])).filter(Boolean).join(" · ");
  const arrivedText = `${viaLabel(config, c.arrived_via) ? `from ${viaLabel(config, c.arrived_via)}` : `via ${c.arrived_via}`}${c.arrived_via === "officer" ? `, ${viaLabel(config, "officer") ? "entered" : "dropped in"} by ${c.requested_by.email}` : ""}, ${fmt(c.created_at)}`;

  const header = details
    ? h(
        "form",
        { className: "form", onSubmit: saveDetails },
        h("h2", null, "Correct the details"),
        h(Fields, { config, form: details, setForm: setDetails, prefix: "edit" }),
        h("div", { className: "row" }, h("button", { className: "btn primary", type: "submit", disabled: busy === "details" }, "Save"), h("button", { className: "btn quiet", type: "button", onClick: () => setDetails(null) }, "Cancel")),
      )
    : h(
        "div",
        { className: "casehead" },
        h(
          "div",
          { className: "titlerow" },
          h("h2", null, c.fields.title),
          closed
            ? null
            : h(
                "details",
                { className: "menu" },
                h("summary", { "aria-label": "More actions", title: "More actions" }, "⋯"),
                h(
                  "div",
                  { className: "menu-items" },
                  h("button", { className: "btn quiet", onClick: () => setDetails({ ...c.fields }) }, "Correct the details"),
                  h("button", { className: "btn quiet", onClick: () => setRemoving(true) }, "Remove from the desk"),
                ),
              ),
        ),
        h(
          "div",
          { className: "statusline" },
          h(Chip, { config, status: c.status }),
          (kc.chipFields || []).filter((key) => c.fields[key]).map((key) => h("span", { key, className: `fact ${/expedit|urgent/i.test(c.fields[key]) ? "urgent" : ""}` }, c.fields[key])),
          h(DueChip, { config, c }),
        ),
        h("p", { className: "facts" }, facts(metaFields(config))),
        (kc.detailFields || []).some((key) => c.fields[key]) || c.fields.subject || c.fields.link
          ? h(
              "p",
              { className: "facts" },
              facts(kc.detailFields || []),
              c.fields.subject ? c.fields.subject : null,
              c.fields.link ? [c.fields.subject ? " · " : "", h("a", { key: "l", href: c.fields.link, target: "_blank", rel: "noreferrer", title: c.fields.link }, hostOf(c.fields.link)), h("span", { key: "o", className: "small" }, ` (opens the ${config.desk.caseNoun})`)] : null,
            )
          : null,
        h(
          "details",
          { className: "more" },
          h("summary", null, "More details"),
          h(
            "dl",
            { className: "meta" },
            config.intake.fields.filter((f) => f.type !== "textarea" && f.key !== "title" && c.fields[f.key]).map((f) => [h("dt", { key: `t-${f.key}` }, f.label), h("dd", { key: `d-${f.key}` }, show(config, f.key, c.fields[f.key]))]),
            h("dt", null, "Arrived"),
            h("dd", null, arrivedText),
          ),
        ),
        removing
          ? h(
              "form",
              { className: "form notice", onSubmit: remove },
              h("label", null, "Why it is removed (kept in the records)", h("input", { value: note, onChange: (e) => setNote(e.target.value) })),
              h("div", { className: "row" }, h("button", { className: "btn", type: "submit", disabled: busy === "remove" }, "Remove"), h("button", { className: "btn quiet", type: "button", onClick: () => setRemoving(false) }, "Keep it")),
            )
          : null,
      );

  const supplied = !twoPane
    ? null
    : c.fields[kc.showText]
      ? [h("h3", { key: "sh" }, kc.textHeading || labelOf(config, kc.showText)), h("div", { key: "st", className: "supplied" }, h("p", null, c.fields[kc.showText]))]
      : [h("h3", { key: "sh" }, kc.textHeading || labelOf(config, kc.showText)), h("p", { key: "st", className: "small" }, kc.noTextShown || `The desk holds no text for this ${config.desk.caseNoun}.`)];

  const notices = [
    c.status === "drafting" ? h("div", { key: "n1", className: "notice plain" }, "The agent is drafting. This page refreshes on its own.") : null,
    c.last_error ? h("div", { key: "n2", className: "notice bad" }, `The last run failed: ${c.last_error}`) : null,
    latest && latest.warning ? h("div", { key: "n3", className: "notice" }, latest.warning, " The draft below is complete as received; check it as you would any draft.") : null,
    c.status === "removed" ? h("div", { key: "n4", className: "notice plain" }, `Removed by ${c.removed.by} at ${fmt(c.removed.at)}: ${c.removed.note}`) : null,
  ];

  // The decision.
  let decisionPanel;
  if (open) {
    const chosen = config.decisions.find((d) => d.id === choice) || null;
    const approve = config.decisions.find((d) => d.id === "approve");
    const redo = config.decisions.filter((d) => d.outcome === "sent_back");
    const others = config.decisions.filter((d) => d.id !== "approve" && d.outcome !== "sent_back");
    // Where the desk has a pass mark, Approve is the filled button only when
    // every row carries it; otherwise approving takes a reason.
    const leanApprove = c.all_pass == null ? true : c.all_pass;
    const approveNeedsReason = Boolean(config.rules.reasonToApproveUnmet && c.all_pass === false);
    const noteLabel = (d) => d.noteLabel || (d.outcome === "sent_back" ? "What the agent should change (it sees this note)" : "Note (kept in the register)");
    decisionPanel = h(
      "div",
      { className: "decide" },
      fourEyesBlocked ? h("div", { className: "notice plain" }, config.rules.fourEyesText) : null,
      h(
        "div",
        { className: "actions" },
        approve
          ? h("button", { className: `btn ${leanApprove ? "primary" : choice === approve.id ? "chosen" : "outline"}`, disabled: Boolean(busy) || fourEyesBlocked || !latest, onClick: () => (approveNeedsReason ? setChoice(choice === approve.id ? "" : approve.id) : decide(approve)) }, busy === "approve" ? "Recording..." : approve.label)
          : null,
        others.map((d) =>
          h("button", { key: d.id, className: `btn ${choice === d.id ? "chosen" : "outline"}`, disabled: Boolean(busy) || fourEyesBlocked || !latest, onClick: () => setChoice(choice === d.id ? "" : d.id) }, d.label),
        ),
      ),
      latest && approve && leanApprove && !chosen
        ? h("p", { className: "will" }, (approve.hint || `Issues version {version}{edited} as the ${config.desk.draftNoun}, in your name.`).replace("{version}", latest.version).replace("{edited}", edited ? ", as edited by you," : ""))
        : null,
      chosen
        ? h(
            "form",
            { className: "form", onSubmit: (e) => { e.preventDefault(); decide(chosen); } },
            h("label", { htmlFor: "decision-note" }, chosen.id === "approve" ? config.rules.reasonToApproveUnmetLabel || "Why you are approving although a row is not met" : noteLabel(chosen), h("textarea", { id: "decision-note", value: note, autoFocus: true, onChange: (e) => setNote(e.target.value) })),
            chosen.noteHint ? h("p", { className: "small" }, chosen.noteHint) : null,
            h("div", { className: "row" }, h("button", { className: "btn primary", type: "submit", disabled: Boolean(busy) || !note.trim() }, busy === chosen.id ? "Recording..." : chosen.label), h("button", { className: "btn quiet", type: "button", onClick: () => setChoice("") }, "Cancel")),
          )
        : null,
      h(
        "p",
        { className: "small decided-as" },
        `Decided as ${me.name}. `,
        redo.map((d) => h("button", { key: d.id, className: "linklike", disabled: Boolean(busy) || (fourEyesBlocked && !config.rules.fourEyesAllowsRedo) || !latest, onClick: () => setChoice(choice === d.id ? "" : d.id) }, `Not ready to decide? ${d.label}`)),
      ),
    );
  } else if (waiting) {
    decisionPanel = h(
      "div",
      null,
      h("div", { className: "notice plain" }, `${config.statuses[c.status]} since ${fmt(c.decision.at)}. ${c.decision.by} asked: ${c.decision.note}`),
      (config.next || {})[c.status] ? h("p", { className: "small" }, config.next[c.status]) : null,
      h(
        "form",
        { className: "form", onSubmit: sendReply },
        h("label", { htmlFor: "reply-text" }, kc.replyLabel || "Add the reply", h("textarea", { id: "reply-text", value: reply, onChange: (e) => setReply(e.target.value) })),
        h("div", { className: "row" }, h("button", { className: "btn primary", type: "submit", disabled: busy === "reply" || !reply.trim() }, busy === "reply" ? "Adding..." : kc.replyButton || "Add the reply and draft again")),
      ),
    );
  } else if (c.status === "sent_back") {
    decisionPanel = h(
      "div",
      null,
      h("div", { className: "notice plain" }, `Sent back by ${c.decision.by} at ${fmt(c.decision.at)}: ${c.decision.note}`),
      h("p", { className: "small" }, "The agent gets the note and the draft it is replacing. Nothing can be decided until the new draft is in."),
    );
  } else if (c.decision) {
    decisionPanel = h(
      "div",
      null,
      h("div", { className: `notice ${c.decision.outcome === "issued" ? "ok" : "plain"}` }, `${(config.decisionLabels || {})[c.decision.outcome] || config.statuses[c.decision.outcome]} by ${c.decision.by} at ${fmt(c.decision.at)}.`, c.decision.note ? ` Note: ${c.decision.note}` : ""),
      (config.next || {})[c.decision.outcome] ? h("p", { className: "small" }, config.next[c.decision.outcome]) : null,
    );
  } else {
    decisionPanel = h("p", { className: "small" }, c.status === "drafting" ? "Nothing to decide until the draft is in." : c.status === "removed" ? "Removed from the desk." : "No draft to decide on yet.");
  }
  const draftButton =
    ["new", "sent_back"].includes(c.status) || (c.status === "for_review" && !latest)
      ? h("div", { className: "row" }, h("button", { className: `btn ${c.status === "sent_back" || !latest ? "primary" : ""}`, disabled: busy === "draft", onClick: redraft }, busy === "draft" ? "Asking..." : c.drafts.length ? "Ask the agent for a new draft" : "Ask the agent to draft"))
      : null;
  const decision = h("div", { className: "decision-block" }, decisionPanel, draftButton, err ? h("div", { className: "notice bad" }, err) : null);

  // One strip for what the agent found: the completeness check, the count of
  // marks and the proposed next step. On a two-pane desk the decision sits in
  // the same strip, pinned above the rows.
  const held = Boolean(c.checklist && c.checklist.some((r) => r.blocking && r.status !== "complete"));
  const hasVerdict = latest && !editing && (c.checklist || rows);
  const verdict = hasVerdict
    ? h(
        "div",
        { className: `verdict ${held ? "held" : c.all_pass === true ? "ok" : c.all_pass === false ? "attention" : "plain"}` },
        rows || c.proposal || c.next_step
          ? h(
              "div",
              { className: "headline" },
              rows ? h("span", { className: "tally" }, tally(config, rows)) : null,
              c.next_step
                ? [
                    h("span", { key: "ns" }, h("b", null, "Next step by the desk's rules: "), `${c.next_step.label}, because ${c.next_step.why}.`),
                    c.next_step.agentText
                      ? h("span", { key: "ag", className: `agentline ${c.next_step.agrees ? "" : "differs"}` }, c.next_step.agrees ? "The agent's words: " : "The agent proposed something else: ", c.next_step.agentText)
                      : null,
                  ]
                : c.proposal
                  ? h("span", null, h("b", null, "The agent proposes: "), c.proposal)
                  : config.draft.proposalPrefix
                    ? h("span", { className: "small" }, "The agent proposed no next step.")
                    : null,
            )
          : null,
        c.checklist ? h(Checklist, { rows: c.checklist }) : null,
        twoPane ? h("div", { className: "verdict-decision" }, decision) : null,
      )
    : null;

  const reviewHead = h(
    "h3",
    null,
    cap(config.desk.draftNoun),
    latest ? h("span", { className: "version" }, `version ${latest.version} of ${c.drafts.length}`) : null,
    latest && open ? h("button", { className: "btn quiet tiny", onClick: () => setEditing(!editing) }, editing ? "Show as a table" : "Edit the text") : null,
    standIn ? h("span", { className: "tag", title: "No real agent wrote this. The stand-in platform returns canned text so the screen can be seen." }, "stand-in agent, canned text") : null,
  );

  const review = [
    // The summary earns its place only where there is no table to read.
    latest && c.summary && !rows ? h("div", { key: "sum", className: "card" }, h("p", { className: "summary" }, c.summary)) : null,
    latest
      ? editing && open
        ? h("textarea", { key: "edit", className: "draft", value: draft, onChange: (e) => setDraft(e.target.value) })
        : rows
          ? h(GapRows, { key: "rows", config, rows })
          : c.checklist
            ? h("div", { key: "gate", className: "card" }, h("p", { className: "summary" }, c.gate_note || "The review stopped before the criteria were checked."))
            : h("div", { key: "prose", className: "draft" }, latest.text)
      : h("div", { key: "none", className: "empty" }, c.status === "drafting" ? "Waiting for the agent..." : "No draft yet."),
    latest && open
      ? h("p", { key: "ver", className: "small" }, edited ? "You have edited the draft. Your version is recorded when you decide." : `Version ${latest.version} was written by ${latest.by === "agent" ? "the agent" : latest.by} at ${fmt(latest.at)}${latest.library ? `, against ${latest.library}` : ""}. Edit it if you need to; the register keeps every version.`)
      : null,
    c.issued_document || (c.letters || []).length
      ? h(
          "p",
          { key: "docs", className: "docs" },
          c.issued_document ? h("a", { href: `${BASE}/api/cases/${c.id}/issued.md` }, h(Icon, { name: "file" }), (config.audit && config.audit.linkLabel) || "Download the issued document") : null,
          (c.letters || []).map((l, i) => h("a", { key: i, href: `${BASE}/api/cases/${c.id}/letters/${i}.md` }, h(Icon, { name: "mail" }), `${((config.letters || {})[l.kind] || {}).linkLabel || "Letter"} ${l.number}`)),
        )
      : null,
    latest && (rows || c.checklist) && !editing && latest.text.replace(/\|.*\n?/g, "").trim().length > 0
      ? h("details", { key: "raw" }, h("summary", null, "The draft as the agent wrote it"), h("div", { className: "draft" }, latest.text))
      : null,
    latest && latest.tools && latest.tools.length
      ? h("details", { key: "tools" }, h("summary", null, `What the agent looked at (${latest.tools.length} tool call${latest.tools.length === 1 ? "" : "s"})`), h("ul", { className: "events" }, latest.tools.map((t, i) => h("li", { key: i }, h("time", null, t.name), h("span", null, t.args)))))
      : null,
    c.drafts.length > 1
      ? h("details", { key: "old" }, h("summary", null, "Earlier versions"), c.drafts.slice(0, -1).map((d) => h("div", { key: d.version }, h("h3", null, `Version ${d.version}, ${d.by === "agent" ? "the agent" : d.by}, ${fmt(d.at)}`), h("div", { className: "draft" }, d.text))))
      : null,
  ];

  const history = [
    h("h3", { key: "hh" }, "What happened"),
    h("ul", { key: "hl", className: "events" }, c.events.map((e, i) => {
      const arrived = /^arrived via (\w+)$/.exec(e.what);
      const from = arrived && viaLabel(config, arrived[1]);
      const plainVia = arrived && e.who === arrived[1] ? { feed: "Arrived from the feed", sweep: "Found by a sweep" }[arrived[1]] : "";
      return h("li", { key: i }, h("time", null, fmt(e.at)), from ? h("span", null, `Arrived from ${from}`) : plainVia ? h("span", null, plainVia) : h("span", null, h("span", { className: "who" }, e.who), " ", e.what));
    })),
  ];

  const chat = closed
    ? null
    : [
        h("h3", { key: "h" }, "Ask the agent about this one"),
        h(
          "div",
          { key: "c", className: "chat" },
          c.conversation.map((m, i) => h("div", { key: i, className: `msg ${m.role}` }, h("span", { className: "by" }, m.role === "user" ? m.by : "the agent", " · ", fmt(m.at)), m.role === "user" ? m.content : h(Rich, { text: m.content }))),
          h(
            "form",
            { onSubmit: ask, className: "form" },
            h("textarea", { value: question, placeholder: kc.askPlaceholder || "For example: which clause of the publication does requirement 2 come from?", onChange: (e) => setQuestion(e.target.value) }),
            chatErr ? h("div", { className: "notice bad" }, chatErr) : null,
            h("div", { className: "row" }, h("button", { className: "btn", type: "submit", disabled: busy === "chat" }, busy === "chat" ? "Asking..." : "Ask")),
          ),
        ),
      ];

  if (twoPane) {
    return [
      h("div", { key: "source", className: "col source" }, header, supplied, chat),
      h("div", { key: "review", className: "col review" }, notices, reviewHead, verdict || h("div", { className: "verdict plain" }, decision), review, history),
    ];
  }
  return [
    h("div", { key: "middle", className: "col" }, header, notices, reviewHead, verdict, review, history),
    h("div", { key: "right", className: "col" }, h("h3", null, "Decision"), decision, chat),
  ];
}

function Register({ config, onOpen }) {
  const [rows, setRows] = React.useState([]);
  React.useEffect(() => {
    api("/api/register").then(setRows).catch(() => {});
  }, []);
  const cols = config.register.screenColumns || config.register.columns.filter((c) => !["agent_session_id", "run_ids", "agent_id", "tool_calls", "platform_warning"].includes(c));
  const heading = (c) => {
    const t = (config.register.labels || {})[c] || labelOf(config, c).replace(/_/g, " ");
    return t ? t[0].toUpperCase() + t.slice(1) : t;
  };
  const cell = (r, c) => {
    if (c === "decided_at") return fmt(r[c]);
    if (c === "title" && onOpen) return h("a", { href: "#", onClick: (e) => { e.preventDefault(); onOpen(r.case_id); } }, r[c]);
    if (c === "arrived_via") return viaLabel(config, r[c]) || r[c];
    if (config.intake.fields.some((f) => f.key === c)) return show(config, c, r[c]);
    if (c === "decision") return h("span", null, (config.decisionLabels || {})[r[c]] || config.statuses[r[c]] || r[c], r[c] === "issued" ? [" ", h("a", { key: "l", className: "doclink", href: `${BASE}/api/cases/${r.case_id}/issued.md`, title: "Download the issued document", "aria-label": "Download the issued document" }, h(Icon, { name: "file" }))] : null);
    if (c === "identity_source") return r[c] === "platform-sign-in" ? "platform sign-in" : "local";
    return String(r[c] == null ? "" : r[c]);
  };
  return h(
    "div",
    { className: "col wide" },
    h("h2", null, "Register"),
    h("p", { className: "small" }, config.register.heading, " ", h("a", { href: `${BASE}/api/register.csv` }, "Download as CSV"), " (every column, including the agent, run and session ids)."),
    h(
      "table",
      { className: "register" },
      h("thead", null, h("tr", null, cols.map((c) => h("th", { key: c, className: `c-${c}` }, heading(c))))),
      h("tbody", null, rows.map((r, i) => h("tr", { key: i }, cols.map((c) => h("td", { key: c }, cell(r, c)))))),
    ),
    rows.length ? null : h("p", { className: "small" }, "Nothing decided yet."),
  );
}

// The reader's choice of theme: the system's, light or dark. It is kept in
// this browser only; if the browser will not keep it, the desk still works.
function readTheme() {
  try {
    const t = window.localStorage.getItem("desk-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch (err) {
    return "system";
  }
}

function applyTheme(t) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    if (t === "system") window.localStorage.removeItem("desk-theme");
    else window.localStorage.setItem("desk-theme", t);
  } catch (err) {
    /* not kept; the choice lasts until the page is closed */
  }
}

function ThemeSwitch() {
  const [theme, setTheme] = React.useState(readTheme());
  React.useEffect(() => applyTheme(theme), [theme]);
  return h(
    "div",
    { className: "themeswitch", role: "group", "aria-label": "Theme" },
    [["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([id, label]) => h("button", { key: id, className: theme === id ? "on" : "", "aria-pressed": theme === id, onClick: () => setTheme(id) }, label)),
  );
}

function App() {
  const [config, setConfig] = React.useState(null);
  const [me, setMe] = React.useState(null);
  const [health, setHealth] = React.useState(null);
  const [list, setList] = React.useState([]);
  const [selected, setSelected] = React.useState("");
  const [tab, setTab] = React.useState("desk");
  const [filter, setFilter] = React.useState("open");
  const [search, setSearch] = React.useState("");

  async function refresh() {
    const l = await api("/api/cases");
    setList(l);
    if (!selected && l.length) setSelected(l[0].id);
  }
  React.useEffect(() => {
    Promise.all([api("/api/config"), api("/api/me"), api("/api/health")]).then(([c, m, hh]) => {
      setConfig(c);
      setMe(m);
      setHealth(hh);
      document.title = c.desk.name;
    });
    refresh();
  }, []);
  // While anything is drafting, poll.
  React.useEffect(() => {
    if (!list.some((c) => c.status === "drafting")) return undefined;
    const t = setInterval(() => refresh().catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [list]);

  if (!config || !me) return h("p", { style: { padding: 20 } }, "Loading...");
  const current = list.find((c) => c.id === selected);

  const filters = [
    { id: "open", label: "Open", test: (c) => OPEN_STATUSES.includes(c.status) || waitingStatuses(config).includes(c.status) },
    { id: "mine", label: "Mine to decide", test: (c) => c.status === "for_review" && !(config.rules.fourEyes && c.requested_by.source !== "system" && c.requested_by.email === me.email) },
    { id: "for_review", label: config.statuses.for_review, test: (c) => c.status === "for_review" },
    { id: "sent_back", label: config.statuses.sent_back, test: (c) => c.status === "sent_back" },
    ...waitingStatuses(config).map((s) => ({ id: s, label: (config.filterLabels || {})[s] || config.statuses[s] || s, test: (c) => c.status === s })),
    { id: "closed", label: "Closed", test: (c) => closedStatuses(config).includes(c.status) && c.status !== "removed" },
    { id: "all", label: "All", test: () => true },
  ];
  // The chips always shown; the rest appear only while they hold something.
  const always = ["open", "all"];
  const q = search.trim().toLowerCase();
  const active = filters.find((f) => f.id === filter) || filters[0];
  const byDue = (a, b) => {
    const da = dueOf(config, a);
    const db = dueOf(config, b);
    return da && db ? da.date - db.date : 0;
  };
  const pool = q ? list : list.filter(active.test);
  const shown = pool.filter((c) => !q || Object.values(c.fields).join(" ").slice(0, 2000).toLowerCase().includes(q)).sort(byDue);
  const listFields = (config.case && config.case.listFields) || metaFields(config);
  const counts = Object.fromEntries(filters.map((f) => [f.id, list.filter(f.test).length]));

  return h(
    "div",
    { className: "desk" },
    h(
      "header",
      { className: "masthead" },
      h("h1", null, config.desk.name),
      h("nav", { className: "tabs", "aria-label": "Views" }, h("button", { className: tab === "desk" ? "on" : "", onClick: () => setTab("desk") }, "Desk"), config.sweeps ? h("button", { className: tab === "sweeps" ? "on" : "", onClick: () => setTab("sweeps") }, "Sweeps") : null, h("button", { className: tab === "register" ? "on" : "", onClick: () => setTab("register") }, "Register")),
      h("span", { className: "spacer" }),
      health && health.agent !== "configured" ? h("span", { className: "pill warn", title: health.agent }, "agent not configured") : null,
      h(ThemeSwitch),
      h("span", { className: "me" }, h("b", null, me.name), me.source === "platform-sign-in" ? null : h("span", { className: "pill", title: "No platform sign-in in front of this desk; the name comes from a local setting" }, "demo sign-in")),
    ),
    tab === "sweeps" && config.sweeps
      ? h("div", { className: "columns" }, h("div", { className: "col wide narrowpage" }, h(Sweeps, { config, onOpened: async (c) => { await refresh(); setSelected(c.id); setFilter("all"); setTab("desk"); } })))
      : tab === "register"
      ? h("div", { className: "columns" }, h(Register, { config, onOpen: (id) => { setSelected(id); setFilter("all"); setTab("desk"); } }))
      : h(
          "div",
          { className: `columns ${config.case && config.case.showText ? "two" : ""}` },
          h(
            "div",
            { className: "col list" },
            h(IntakeForm, { config, onCreated: async (c) => { await refresh(); setSelected(c.id); setFilter("open"); } }),
            h("h3", null, config.desk.caseNounPlural[0].toUpperCase() + config.desk.caseNounPlural.slice(1)),
            h("input", { className: "search", type: "search", placeholder: (config.case && config.case.searchPlaceholder) || "Search by title, regulator or subject", value: search, onChange: (e) => setSearch(e.target.value) }),
            h("div", { className: "filters", role: "tablist" }, filters.filter((f) => always.includes(f.id) || counts[f.id] || f.id === filter).map((f) => h("button", { key: f.id, className: f.id === filter ? "on" : "", onClick: () => setFilter(f.id) }, f.label, h("b", null, counts[f.id])))),
            h("ul", { className: `caselist ${config.case && config.case.listTitleLines === 2 ? "two-line" : ""}` }, shown.map((c) => h("li", { key: c.id, className: c.id === selected ? "on" : "", onClick: () => setSelected(c.id) }, h("div", { className: "t" }, c.fields.title), h("div", { className: "s" }, h("span", null, listFields.map((key) => show(config, key, c.fields[key])).filter(Boolean).join(" · ")), h(DueChip, { config, c }), h(Chip, { config, status: c.status }))))),
            shown.length ? h("p", { className: "small" }, q ? `${shown.length} found in all ${config.desk.caseNounPlural}, open and closed` : `${shown.length} of ${list.length}`) : h("p", { className: "small" }, list.length ? "Nothing matches." : `No ${config.desk.caseNounPlural} yet.`),
            config.sweeps ? h(SweepLine, { onOpen: () => setTab("sweeps") }) : null,
            h("p", { className: "invented" }, (config.case && config.case.demoNote) || "Demo data: the bank, its policies and its officers are invented. The two publications are real."),
          ),
          current ? h(CaseView, { key: current.id, config, me, c: current, refresh }) : h("div", { className: "col blank" }, h("div", { className: "emptystate" }, h(Icon, { name: "inbox" }), h("p", null, list.length ? `Pick a ${config.desk.caseNoun} on the left.` : `No ${config.desk.caseNounPlural} on the desk yet.`), h("p", { className: "small" }, list.length ? "Its details and the agent's review open here." : `${config.desk.addLabel || `Drop a ${config.desk.caseNoun} in`}, or wait for one to arrive.`))),
        ),
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
