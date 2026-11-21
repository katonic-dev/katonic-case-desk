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

function Mark({ config, mark, text }) {
  const label = (config.draft.marks || {})[mark] || text || "";
  return h("span", { className: `mark ${mark.replace(/ /g, "-") || "unknown"}` }, label);
}

// The gap analysis as the agent wrote it: one row per requirement when it
// wrote the table it was asked for, else the text. The parser lives on the
// server (lib/cases.js); the page gets rows. The mark is the row's edge.
function GapRows({ config, rows }) {
  return h(
    "div",
    { className: "gap" },
    rows.map((r, i) =>
      h(
        "div",
        { key: i, className: `gaprow ${r.mark.replace(/ /g, "-") || "unknown"}` },
        h("div", { className: "n" }, r.n),
        h(
          "div",
          null,
          h("div", { className: "req" }, h("span", { className: "text" }, r.requirement), h(Mark, { config, mark: r.mark, text: r.markText })),
          r.source ? h("div", { className: "src" }, r.source) : null,
          h("div", { className: "pol" }, r.policy, r.citation ? h("span", { className: "cite" }, r.citation) : null),
          r.check ? h("div", { className: "chk" }, h("b", null, "Check: "), r.check) : null,
        ),
      ),
    ),
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
  if (!open) return h("button", { className: "btn", onClick: () => setOpen(true) }, `Drop a ${config.desk.caseNoun} in`);
  return h(
    "form",
    { className: "form", onSubmit: submit },
    h(Fields, { config, form, setForm }),
    err ? h("div", { className: "notice bad" }, err) : null,
    h(
      "div",
      { className: "row" },
      h("button", { className: "btn primary", type: "submit", disabled: busy }, busy ? "Adding..." : "Add and draft"),
      h("button", { className: "btn quiet", type: "button", onClick: () => setOpen(false) }, "Cancel"),
    ),
  );
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
    h("h3", null, "Sweeps"),
    h("p", { className: "small" }, `Asks the agent what ${config.sweeps.regulators.map((r) => r.regulator).join(" and ")} published in the last ${config.sweeps.defaultDays} days. On the platform the workflow runs this on its schedule; here it runs when you press the button.`),
    h("button", { className: "btn quiet", onClick: run, disabled: busy }, busy ? "Sweeping..." : "Run a sweep now"),
    busy ? h("p", { className: "small", role: "status" }, `About a minute per regulator. ${progress}`) : null,
    err ? h("div", { className: "notice bad" }, err) : null,
    sweeps.slice(0, 4).map((s) =>
      h(
        "details",
        { key: s.id },
        h("summary", null, `${s.regulator}, ${fmt(s.ran_at)}: ${s.error ? "failed" : `${s.found.length} line${s.found.length === 1 ? "" : "s"} that look like a publication`}`),
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
  React.useEffect(() => {
    setDraft(latest ? latest.text : "");
    setEditing(false);
    setNote("");
    setChoice("");
    setErr("");
    setDetails(null);
    setRemoving(false);
  }, [c.id, latest ? latest.version : 0, c.status]);

  const open = c.status === "for_review";
  const closed = ["issued", "no_action", "removed"].includes(c.status);
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
    setErr("");
    try {
      await api(`/api/cases/${c.id}/chat`, { method: "POST", body: JSON.stringify({ message: question }) });
      setQuestion("");
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
        null,
        h("h2", null, c.fields.title, h(Chip, { config, status: c.status })),
        h(
          "dl",
          { className: "meta" },
          h("dt", null, "Regulator"), h("dd", null, c.fields.regulator),
          h("dt", null, "Published"), h("dd", null, c.fields.published_on),
          c.fields.link ? h("dt", null, "Link") : null, c.fields.link ? h("dd", null, h("a", { href: c.fields.link, target: "_blank", rel: "noreferrer", title: c.fields.link }, hostOf(c.fields.link)), h("span", { className: "small" }, " (opens the publication)")) : null,
          c.fields.subject ? h("dt", null, "Subject") : null, c.fields.subject ? h("dd", null, c.fields.subject) : null,
          h("dt", null, "Arrived"), h("dd", null, `via ${c.arrived_via}${c.arrived_via === "officer" ? `, dropped in by ${c.requested_by.email}` : ""}, ${fmt(c.created_at)}`),
        ),
        closed ? null : h("div", { className: "row small" }, h("button", { className: "btn quiet", onClick: () => setDetails({ ...c.fields }) }, "Correct the details"), h("button", { className: "btn quiet", onClick: () => setRemoving(true) }, "Remove from the desk")),
        removing
          ? h(
              "form",
              { className: "form notice", onSubmit: remove },
              h("label", null, "Why it is removed (kept in the records)", h("input", { value: note, onChange: (e) => setNote(e.target.value) })),
              h("div", { className: "row" }, h("button", { className: "btn", type: "submit", disabled: busy === "remove" }, "Remove"), h("button", { className: "btn quiet", type: "button", onClick: () => setRemoving(false) }, "Keep it")),
            )
          : null,
      );

  const middle = h(
    "div",
    { className: "col" },
    header,
    c.status === "drafting" ? h("div", { className: "notice" }, "The agent is drafting. This page refreshes on its own.") : null,
    c.last_error ? h("div", { className: "notice bad" }, `The last run failed: ${c.last_error}`) : null,
    latest && latest.warning ? h("div", { className: "notice" }, latest.warning, " The draft below is complete as received; check it as you would any draft.") : null,
    c.status === "removed" ? h("div", { className: "notice" }, `Removed by ${c.removed.by} at ${fmt(c.removed.at)}: ${c.removed.note}`) : null,
    latest && c.summary ? [h("h3", { key: "sh" }, "Summary"), h("div", { key: "s", className: "card" }, h("p", { className: "summary" }, c.summary))] : null,
    h(
      "h3",
      null,
      `${config.desk.draftNoun}${latest ? `, version ${latest.version} of ${c.drafts.length}` : ""}`,
      latest && open ? h("button", { className: "btn quiet tiny", onClick: () => setEditing(!editing) }, editing ? "Show as a table" : "Edit the text") : null,
    ),
    latest
      ? editing && open
        ? h("textarea", { className: "draft", value: draft, onChange: (e) => setDraft(e.target.value) })
        : rows
          ? h(GapRows, { config, rows })
          : h("div", { className: "draft" }, latest.text)
      : h("div", { className: "draft small" }, c.status === "drafting" ? "Waiting for the agent..." : "No draft yet."),
    latest && open
      ? h("p", { className: "small" }, edited ? "You have edited the draft. Your version is recorded when you decide." : `Version ${latest.version} was written by ${latest.by === "agent" ? "the agent" : latest.by} at ${fmt(latest.at)}${latest.library ? `, against ${latest.library}` : ""}. Edit it if you need to; the register keeps every version.`)
      : null,
    latest && rows && !editing && latest.text.replace(/\|.*\n?/g, "").trim().length > 0
      ? h("details", null, h("summary", null, "The draft as the agent wrote it"), h("div", { className: "draft" }, latest.text))
      : null,
    latest && latest.tools && latest.tools.length
      ? h("details", null, h("summary", null, `What the agent looked at (${latest.tools.length} tool call${latest.tools.length === 1 ? "" : "s"})`), h("ul", { className: "events" }, latest.tools.map((t, i) => h("li", { key: i }, h("time", null, t.name), h("span", null, t.args)))))
      : null,
    c.issued_document ? h("p", null, h("a", { href: `${BASE}/api/cases/${c.id}/issued.md` }, "Download the issued document")) : null,
    c.drafts.length > 1
      ? h("details", null, h("summary", null, "Earlier versions"), c.drafts.slice(0, -1).map((d) => h("div", { key: d.version }, h("h3", null, `Version ${d.version}, ${d.by === "agent" ? "the agent" : d.by}, ${fmt(d.at)}`), h("div", { className: "draft" }, d.text))))
      : null,
    h("h3", null, "What happened"),
    h("ul", { className: "events" }, c.events.map((e, i) => h("li", { key: i }, h("time", null, fmt(e.at)), h("span", null, h("span", { className: "who" }, e.who), " ", e.what)))),
  );

  let decisionPanel;
  if (open) {
    const chosen = config.decisions.find((d) => d.id === choice) || null;
    const approve = config.decisions.find((d) => d.id === "approve");
    decisionPanel = h(
      "div",
      { className: "decide" },
      fourEyesBlocked ? h("div", { className: "notice" }, config.rules.fourEyesText) : null,
      h(
        "div",
        { className: "actions" },
        approve ? h("button", { className: "btn primary", disabled: Boolean(busy) || fourEyesBlocked || !latest, onClick: () => decide(approve) }, busy === "approve" ? "Recording..." : approve.label) : null,
        latest && approve ? h("p", { className: "will" }, `Issues version ${latest.version}${edited ? ", as edited by you," : ""} as the ${config.desk.draftNoun}, in your name.`) : null,
        config.decisions.filter((d) => d.id !== "approve").map((d) =>
          h("button", { key: d.id, className: `btn ${choice === d.id ? "" : "quiet"}`, disabled: Boolean(busy) || fourEyesBlocked || !latest, onClick: () => setChoice(choice === d.id ? "" : d.id) }, d.label),
        ),
      ),
      chosen
        ? h(
            "form",
            { className: "form", onSubmit: (e) => { e.preventDefault(); decide(chosen); } },
            h("label", { htmlFor: "decision-note" }, chosen.id === "send_back" ? "What the agent should change (it sees this note)" : "Why no action is needed", h("textarea", { id: "decision-note", value: note, autoFocus: true, onChange: (e) => setNote(e.target.value) })),
            h("div", { className: "row" }, h("button", { className: "btn", type: "submit", disabled: Boolean(busy) || !note.trim() }, busy === chosen.id ? "Recording..." : chosen.label), h("button", { className: "btn quiet", type: "button", onClick: () => setChoice("") }, "Cancel")),
          )
        : null,
      h("p", { className: "small" }, `Decided as ${me.name}. The register records who decided and when.`),
    );
  } else if (c.status === "sent_back") {
    decisionPanel = h(
      "div",
      null,
      h("div", { className: "notice plain" }, `Sent back by ${c.decision.by} at ${fmt(c.decision.at)}: ${c.decision.note}`),
      h("p", { className: "small" }, "The agent gets the note and the draft it is replacing. Nothing can be decided until the new draft is in."),
    );
  } else if (c.decision) {
    decisionPanel = h("div", { className: `notice ${c.decision.outcome === "issued" ? "ok" : ""}` }, `${config.statuses[c.decision.outcome]} by ${c.decision.by} at ${fmt(c.decision.at)}.`, c.decision.note ? ` Note: ${c.decision.note}` : "");
  } else {
    decisionPanel = h("p", { className: "small" }, c.status === "drafting" ? "Nothing to decide until the draft is in." : c.status === "removed" ? "Removed from the desk." : "No draft to decide on yet.");
  }

  const right = h(
    "div",
    { className: "col" },
    h("h3", null, "Decision"),
    decisionPanel,
    ["new", "sent_back"].includes(c.status) || (c.status === "for_review" && !latest)
      ? h("div", { className: "row" }, h("button", { className: `btn ${c.status === "sent_back" ? "primary" : ""}`, disabled: busy === "draft", onClick: redraft }, busy === "draft" ? "Asking..." : c.drafts.length ? "Ask the agent for a new draft" : "Ask the agent to draft"))
      : null,
    err ? h("div", { className: "notice bad" }, err) : null,
    closed
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
              h("textarea", { value: question, placeholder: "For example: which clause of the publication does requirement 2 come from?", onChange: (e) => setQuestion(e.target.value) }),
              h("div", { className: "row" }, h("button", { className: "btn", type: "submit", disabled: busy === "chat" }, busy === "chat" ? "Asking..." : "Ask")),
            ),
          ),
        ],
  );

  return [middle, right];
}

function Register({ config }) {
  const [rows, setRows] = React.useState([]);
  React.useEffect(() => {
    api("/api/register").then(setRows).catch(() => {});
  }, []);
  const cols = config.register.columns.filter((c) => !["agent_session_id", "run_ids", "agent_id", "tool_calls", "platform_warning"].includes(c));
  const cell = (r, c) => {
    if (c === "decided_at") return fmt(r[c]);
    if (c === "decision") return h("span", null, config.statuses[r[c]] || r[c], r[c] === "issued" ? [" ", h("a", { key: "l", href: `${BASE}/api/cases/${r.case_id}/issued.md` }, "document")] : null);
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
      h("thead", null, h("tr", null, cols.map((c) => h("th", { key: c }, c.replace(/_/g, " "))))),
      h("tbody", null, rows.map((r, i) => h("tr", { key: i }, cols.map((c) => h("td", { key: c }, cell(r, c)))))),
    ),
    rows.length ? null : h("p", { className: "small" }, "Nothing decided yet."),
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
    { id: "open", label: "Open", test: (c) => OPEN_STATUSES.includes(c.status) },
    { id: "mine", label: "Mine to decide", test: (c) => c.status === "for_review" && !(config.rules.fourEyes && c.requested_by.source !== "system" && c.requested_by.email === me.email) },
    { id: "for_review", label: config.statuses.for_review, test: (c) => c.status === "for_review" },
    { id: "sent_back", label: config.statuses.sent_back, test: (c) => c.status === "sent_back" },
    { id: "issued", label: config.statuses.issued, test: (c) => c.status === "issued" },
    { id: "no_action", label: config.statuses.no_action, test: (c) => c.status === "no_action" },
    { id: "all", label: "All", test: () => true },
  ];
  const q = search.trim().toLowerCase();
  const active = filters.find((f) => f.id === filter) || filters[0];
  const shown = list.filter(active.test).filter((c) => !q || `${c.fields.title} ${c.fields.regulator} ${c.fields.subject || ""}`.toLowerCase().includes(q));
  const counts = Object.fromEntries(filters.map((f) => [f.id, list.filter(f.test).length]));

  return h(
    "div",
    { className: "desk" },
    h(
      "header",
      { className: "masthead" },
      h("h1", null, config.desk.name),
      h("nav", { className: "tabs", "aria-label": "Views" }, h("button", { className: tab === "desk" ? "on" : "", onClick: () => setTab("desk") }, "Desk"), h("button", { className: tab === "register" ? "on" : "", onClick: () => setTab("register") }, "Register")),
      h("span", { className: "spacer" }),
      health && health.agent !== "configured" ? h("span", { className: "pill warn", title: health.agent }, "agent not configured") : null,
      h("span", { className: "me" }, h("b", null, me.name), me.source === "platform-sign-in" ? null : h("span", { className: "pill", title: "No platform sign-in in front of this desk; the name comes from a local setting" }, "signed in locally")),
    ),
    tab === "register"
      ? h("div", { className: "columns" }, h(Register, { config }))
      : h(
          "div",
          { className: "columns" },
          h(
            "div",
            { className: "col" },
            h(IntakeForm, { config, onCreated: async (c) => { await refresh(); setSelected(c.id); setFilter("open"); } }),
            h("h3", null, config.desk.caseNounPlural),
            h("input", { className: "search", type: "search", placeholder: "Search by title, regulator or subject", value: search, onChange: (e) => setSearch(e.target.value) }),
            h("div", { className: "filters", role: "tablist" }, filters.map((f) => h("button", { key: f.id, className: f.id === filter ? "on" : "", onClick: () => setFilter(f.id) }, f.label, h("b", null, counts[f.id])))),
            h("ul", { className: "caselist" }, shown.map((c) => h("li", { key: c.id, className: c.id === selected ? "on" : "", onClick: () => setSelected(c.id) }, h("div", { className: "t" }, c.fields.title), h("div", { className: "s" }, h("span", null, `${c.fields.regulator} · ${c.fields.published_on}`), h(Chip, { config, status: c.status }))))),
            shown.length ? h("p", { className: "small" }, `${shown.length} of ${list.length}`) : h("p", { className: "small" }, list.length ? "Nothing matches." : `No ${config.desk.caseNounPlural} yet.`),
            h(Sweeps, { config, onOpened: async (c) => { await refresh(); setSelected(c.id); } }),
            h("p", { className: "invented" }, "Demo data: the bank, its policies and its officers are invented. The two publications are real."),
          ),
          current ? h(CaseView, { key: current.id, config, me, c: current, refresh }) : h("div", { className: "col" }, h("p", { className: "small" }, `Pick a ${config.desk.caseNoun} on the left, or drop one in.`)),
        ),
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
