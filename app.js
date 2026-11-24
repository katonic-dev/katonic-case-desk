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

// A desk may give each of its marks a tone (ok, warn, err, none, person) in
// config.draft.markTones; without one the mark's own name is the class.
function markClass(mark, tone) {
  return tone ? `tone-${tone}` : mark.replace(/ /g, "-") || "unknown";
}

// A desk may give a mark its own sign in config.draft.markIcons (for a mark that is
// neither a pass nor a fail, such as "=" for a match on a list). Without one the
// tone's sign is used.
function Mark({ config, mark, text, tone }) {
  const label = (config.draft.marks || {})[mark] || text || "";
  const icon = (config.draft.markIcons || {})[mark];
  return h("span", { className: `mark ${markClass(mark, tone)}${icon ? " has-icon" : ""}`, title: (config.draft.markHints || {})[mark] || undefined }, icon ? h("span", { className: "mi", "aria-hidden": true }, icon + "\u00a0") : null, label);
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

// intake.fields[].shownAs, for example "Match score {value}", is used where the value stands alone
// (the line in the list, the chips); the plain list of details shows the value.
function show(config, key, value, plain) {
  const f = config.intake.fields.find((x) => x.key === key);
  if (f && f.type === "date") return fmtDay(value);
  return f && f.shownAs && value && !plain ? String(f.shownAs).split("{value}").join(value) : value;
}

// Where a case came from, in the desk's own words.
function viaLabel(config, via) {
  return ((config.desk && config.desk.arrivedVia) || {})[via] || "";
}

// Working days are Monday to Friday. No holidays: the desk does not know a bank's calendar.
function addWorkingDays(from, n) {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d;
}

// The working days from one day to another: positive when "to" is later,
// negative when it is earlier, 0 for the same day. The first day is not counted.
function workingDaysBetween(from, to) {
  const sign = to >= from ? 1 : -1;
  const a = sign === 1 ? new Date(from) : new Date(to);
  const b = sign === 1 ? new Date(to) : new Date(from);
  let n = 0;
  while (a < b) {
    a.setDate(a.getDate() + 1);
    if (a.getDay() !== 0 && a.getDay() !== 6) n++;
  }
  return n * sign;
}

// When a case is due, for desks whose config gives a turnaround:
// config.due = { field, urgencyField, standardDays, expeditedDays, workingDays }.
// With workingDays: true the days are Monday to Friday; otherwise calendar days.
function dueOf(config, c, now = new Date()) {
  const d = config.due;
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(c.fields[d.field] || "")) return null;
  const expedited = /expedit|urgent/i.test(c.fields[d.urgencyField] || "");
  let date = new Date(`${c.fields[d.field]}T00:00:00`);
  if (d.workingDays === true) date = addWorkingDays(date, expedited ? d.expeditedDays : d.standardDays);
  else date.setDate(date.getDate() + (expedited ? d.expeditedDays : d.standardDays));
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = d.workingDays === true ? workingDaysBetween(today, date) : Math.round((date - today) / 86400000);
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { date, expedited, days, text: days < 0 ? `Overdue since ${day}` : days === 0 ? "Due today" : `Due ${day}`, tone: days < 0 ? "err" : days <= 2 ? "warn" : "" };
}

function DueChip({ config, c }) {
  const due = dueOf(config, c);
  if (!due || closedStatuses(config).includes(c.status)) return null;
  return h("span", { className: `due ${due.tone}` }, h(Icon, { name: "clock" }), due.text);
}

// An address (http or https) becomes a link. A record id (DOC-8203, MTB-POL-031, LD-20261123-6A10E8) or a date (2026-11-19, 19 Nov 2026) is kept whole: it is
// wrapped, not changed, so a copied id is the id. Returns the text itself when
// it holds no id.
function withIds(text, key = "i") {
  const s = String(text == null ? "" : text);
  // Also kept whole: an amount with its currency (USD 25,000.00), and a long code that mixes
  // capitals and digits, such as an IBAN or a bank identifier.
  const re = /https?:\/\/[^\s<>"')]*[^\s<>"').,;]|\b[A-Z]{2,}(?:-[A-Z0-9]+)+\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b|\b[A-Z]{3} \d(?:[\d,]*\d)?(?:\.\d+)?|\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{8,34}\b/g;
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(/^https?:/.test(m[0]) ? h("a", { key: `${key}-${m.index}`, className: "ext", href: m[0], target: "_blank", rel: "noopener noreferrer" }, m[0]) : h("span", { key: `${key}-${m.index}`, className: "id" }, m[0]));
    last = m.index + m[0].length;
  }
  if (!out.length) return s;
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// A person by name, with the sign-in address as the element's title. The name
// is the desk's own where it knows it (the signed-in person, the person who
// entered the case) and otherwise read from the address, where it can be.
function nameOf(me, c, email) {
  return window.DeskShared.displayName(email, [{ email: me.email, name: me.name }].concat(c && c.requested_by ? [{ email: c.requested_by.email, name: c.requested_by.name }] : []));
}

function Named({ me, c, email }) {
  const name = nameOf(me, c, email);
  return h("span", { className: "named", title: name !== email ? email : undefined }, name);
}

// A long piece of writing: paragraphs split at blank lines, line breaks kept,
// nothing read as HTML (React writes text as text).
function Prose({ text }) {
  const paras = String(text || "").replace(/\r/g, "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paras.map((p, i) => h("p", { key: i }, p.split("\n").map((line, j, all) => h(React.Fragment, { key: j }, withIds(line, `${i}-${j}`), j < all.length - 1 ? h("br") : null))));
}

// One card for each named section the agent wrote (draft.sections).
function SectionCards({ sections }) {
  return sections.map((s) =>
    h(
      "section",
      { key: s.heading, className: "card prose-card", "aria-label": s.title },
      h("div", { className: "prose-title" }, s.title),
      s.hint ? h("div", { className: "prose-hint" }, s.hint) : null,
      h("div", { className: "prose" }, h(Prose, { text: s.text })),
    ),
  );
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
// A kind of work that names its marks (only) shows each of them, with a zero
// where none was given; a mark outside the list is still counted when it was given.
function tally(config, rows, only) {
  const counts = {};
  for (const r of rows) counts[r.mark || "unmarked"] = (counts[r.mark || "unmarked"] || 0) + 1;
  const marks = config.draft.marks || {};
  const named = Array.isArray(only) ? only.filter((k) => marks[k]) : [];
  const keys = named.length ? named.concat(Object.keys(marks).filter((k) => !named.includes(k) && counts[k])) : Object.keys(marks).filter((k) => counts[k]);
  const words = config.draft.tallyLabels || {};
  return keys.map((k) => ({ text: `${counts[k] || 0} ${(words[k] || marks[k]).toLowerCase()}`, zero: !counts[k] })).concat(counts.unmarked ? [{ text: `${counts.unmarked} unmarked`, zero: false }] : []);
}

// draft.proposalFirst: the proposal leads the strip, its first sentence large, the count of marks below it.
function ProposalLead({ text, past }) {
  const t = String(text || "").trim();
  const at = t.search(/\.(\s|$)/);
  const lead = at > 0 ? t.slice(0, at + 1) : t;
  const rest = at > 0 ? t.slice(at + 1).trim() : "";
  return h("span", { className: `proposal-lead${past ? " past" : ""}` }, h("span", { className: "plabel" }, past ? "The agent proposed" : "The agent proposes"), h("span", { className: "pword" }, lead.charAt(0).toUpperCase() + lead.slice(1)), rest ? h("span", { className: "preason" }, rest) : null);
}

function Tally({ config, rows, only }) {
  const parts = tally(config, rows, only);
  return h("span", { className: "tally" }, parts.map((p, i) => h(React.Fragment, { key: i }, i ? ", " : "", h("span", { className: p.zero ? "zero" : undefined }, p.text))));
}

// The gap analysis as the agent wrote it: one row per requirement when it
// wrote the table it was asked for, else the text. The parser lives on the
// server (lib/cases.js); the page gets rows. The mark is the row's edge.
// A small label in front of a line of a row, where the desk's config names one.
function rowLabel(config, key) {
  const t = (config.draft.rowLabels || {})[key];
  return t ? h("span", { className: "lbl" }, t) : null;
}

// A cell of a row may hold several lines, written with <br>. A line that starts
// "Label: value" shows its label apart from the value.
function CellText({ text, k }) {
  const lines = String(text == null ? "" : text).split(/\s*<br\s*\/?>\s*/i).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return withIds(lines[0] || "", k);
  return lines.map((line, i) => {
    const m = /^([A-Z][A-Za-z ]{1,24}): (.+)$/.exec(line);
    return h("span", { key: i, className: m ? `cline l-${m[1].toLowerCase().replace(/ /g, "-")}` : "cline" }, m ? [h("span", { key: "l", className: "clabel" }, m[1]), h("span", { key: "v", className: "cval" }, withIds(m[2], `${k}${i}`))] : withIds(line, `${k}${i}`));
  });
}

function GapRows({ config, rows }) {
  const rl = config.draft.rowLabels || {};
  // A desk that labels the citation ("Evidence") gets its lines in two aligned columns.
  if (rl.citation) {
    const kv = (cls, label, value) => h("div", { className: `kv ${cls}`, key: cls }, h("span", { className: "k" }, label), h("span", { className: cls === "src" && config.draft.plainSource ? "v long" : "v" }, CellText({ text: value, k: cls })));
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
            h("div", { className: "req" }, h("span", { className: "text" }, withIds(r.requirement, "q")), h(Mark, { config, mark: r.mark, text: r.markText, tone: r.tone })),
            // draft.sideBySide: the first two values (the case's and the other record's) stand in two columns, each under its label.
            // draft.singleValueMarks: for a row with one of these marks whose two values are the same text, one box (labelled rowLabels.both) in place of two.
            config.draft.sideBySide && (r.source || r.policy) && (config.draft.singleValueMarks || []).includes(r.mark) && String(r.source || "").trim().toLowerCase() === String(r.policy || "").trim().toLowerCase()
              ? h("div", { className: "pair one" }, h("div", { className: "cell cell-a" }, h("span", { className: "k" }, rl.both || ""), h("span", { className: "v" }, withIds(r.source, "one"))))
              : config.draft.sideBySide && (r.source || r.policy)
              ? h(
                  "div",
                  { className: "pair" },
                  h("div", { className: "cell cell-a" }, h("span", { className: "k" }, rl.source || ""), h("span", { className: "v" }, r.source ? withIds(r.source, "src") : h("span", { className: "none" }, "none held"))),
                  h("div", { className: "cell cell-b" }, h("span", { className: "k" }, rl.policy || ""), h("span", { className: "v" }, r.policy ? withIds(r.policy, "pol") : h("span", { className: "none" }, "none held"))),
                )
              : null,
            h(
              "div",
              { className: "kvs" },
              !config.draft.sideBySide && r.source ? kv("src", rl.source || "", r.source) : null,
              !config.draft.sideBySide && r.policy ? kv("pol", rl.policy || "", r.policy) : null,
              // with the values side by side the reason comes first and the ids it rests on after it
              config.draft.sideBySide && r.check ? kv("chk", rl.check || "Check", r.check) : null,
              r.citation ? kv("evid", rl.citation, r.citation) : null,
              !config.draft.sideBySide && r.check ? kv("chk", rl.check || "Check", r.check) : null,
            ),
          ),
        ),
      ),
    );
  }
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
          h("div", { className: "req" }, h("span", { className: "text" }, withIds(r.requirement, "q")), h(Mark, { config, mark: r.mark, text: r.markText, tone: r.tone })),
          r.source ? h("div", { className: "src" }, rowLabel(config, "source"), withIds(r.source, "s")) : null,
          h("div", { className: "pol" }, rowLabel(config, "policy"), withIds(r.policy, "p"), r.citation ? h("span", { className: rowLabel(config, "citation") ? "cite own" : "cite" }, rowLabel(config, "citation"), withIds(r.citation, "c")) : null),
          r.check ? h("div", { className: "chk" }, h("b", null, `${rl.check || "Check"}: `), withIds(r.check, "k")) : null,
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
      f.hint ? h("span", { className: "hint" }, f.hint) : null,
      // A field with options is a list to choose from (intake.fields[].options).
      Array.isArray(f.options) && f.options.length
        ? h("select", { id, name: f.key, value: form[f.key] || "", onChange: (e) => setForm({ ...form, [f.key]: e.target.value }) }, h("option", { key: "", value: "" }, "Choose one"), f.options.map((o) => h("option", { key: o, value: o }, o)))
        : f.type === "textarea"
        ? h("textarea", { id, name: f.key, value: form[f.key] || "", onChange: (e) => setForm({ ...form, [f.key]: e.target.value }) })
        : h("input", { id, name: f.key, type: f.type === "date" ? "date" : "text", value: form[f.key] || "", onChange: (e) => setForm({ ...form, [f.key]: e.target.value }) }),
    );
  });
}

// A field may carry a default (intake.fields[].default) that the form starts with.
function defaultsOf(config) {
  return Object.fromEntries(config.intake.fields.filter((f) => f.default).map((f) => [f.key, f.default]));
}

function IntakeForm({ config, onCreated }) {
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(defaultsOf(config));
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const c = await api("/api/cases", { method: "POST", body: JSON.stringify(form) });
      setForm(defaultsOf(config));
      setOpen(false);
      onCreated(c);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }
  const label = config.desk.addLabel || `Drop a ${config.desk.caseNoun} in`;
  const opener = h("button", { className: "btn", onClick: () => { setErr(""); setOpen(true); } }, label);
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

// The text a case came with, with light formatting where it has the patterns:
// a line wholly in capitals is a section heading, a line that starts with a
// clause number is a question, and a short lead-in before a colon is a label.
// A text with none of these is shown as it is.
function CaseText({ text }) {
  const CAPS = /^[A-Z][A-Z0-9 ,&/'()-]{2,}$/;
  const NUM = /^\d+(\.\d+)+\s/;
  const LEAD = /^([A-Z][A-Za-z' ]{1,18}):\s+(.*)$/;
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  if (!lines.some((l) => CAPS.test(l.trim()) || NUM.test(l.trim()) || LEAD.test(l.trim()))) return h("p", null, withIds(text, "t"));
  return h(
    "div",
    { className: "ct" },
    lines.map((l, i) => {
      const t = l.trim();
      if (!t) return h("div", { key: i, className: "bl" });
      if (CAPS.test(t)) return h("div", { key: i, className: "sec" }, t);
      if (NUM.test(t)) return h("div", { key: i, className: "qn" }, withIds(t, i));
      const m = LEAD.exec(t);
      if (m) return h("div", { key: i, className: "ld" }, h("span", { className: "lead" }, m[1]), h("span", null, withIds(m[2], i)));
      return h("div", { key: i }, withIds(t, i));
    }),
  );
}

// The decision whose proposalPrefix the agent's recommendation starts with (the longest wins).
function proposedDecision(config, text) {
  const t = String(text || "").trim().toLowerCase();
  let best = null;
  for (const d of config.decisions) {
    // A decision may name one prefix or a list of them.
    for (const raw of [].concat(d.proposalPrefix || [])) {
      const p = String(raw || "").toLowerCase();
      if (t && p && t.startsWith(p) && (!best || p.length > best.p.length)) best = { id: d.id, p };
    }
  }
  return best ? best.id : "";
}

// Approve is the filled button when every row passes, unless the agent proposes another decision.
function leansApprove(allPass, proposedId, approve) {
  return (allPass == null ? true : allPass) && (!proposedId || !approve || proposedId === approve.id);
}

// The two labels of the phone jump bar: the case (case.jumpLabel, else "Questionnaire") and the draft noun.
function jumpLabels(config) {
  const noun = String((config.desk && config.desk.draftNoun) || "assessment");
  return [(config.case && config.case.jumpLabel) || "Questionnaire", noun.charAt(0).toUpperCase() + noun.slice(1)];
}

function CaseView({ config, me, c, refresh }) {
  const latest = c.drafts.length ? c.drafts[c.drafts.length - 1] : null;
  const [draft, setDraft] = React.useState(latest ? latest.text : "");
  const [editing, setEditing] = React.useState(false);
  // case.foldOnPhone: on a narrow screen the case's own text and the question box start folded, so the review is the first thing under the title.
  const [foldChoice, setFoldChoice] = React.useState(null);
  const [, setWidth] = React.useState(0);
  React.useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const foldOpen = window.innerWidth > 1100 || foldChoice === true;
  const [note, setNote] = React.useState("");
  const [choice, setChoice] = React.useState(""); // the decision picked, before its note
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const [question, setQuestion] = React.useState("");
  const [details, setDetails] = React.useState(null); // the edit-details form, or null
  const [removing, setRemoving] = React.useState(false);
  const [reply, setReply] = React.useState("");
  const [chatErr, setChatErr] = React.useState("");
  const [typed, setTyped] = React.useState({}); // a section's text as typed, so its box keeps what is being typed
  React.useEffect(() => {
    setDraft(latest ? latest.text : "");
    setTyped({});
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
  const sections = Array.isArray(c.sections) ? c.sections : [];
  // A kind of work may word its marks and the lines of a row in its own way (routing.kinds.<kind>.markLabels and the like).
  const vcfg = c.look ? { ...config, draft: { ...config.draft, marks: c.look.marks, markHints: c.look.markHints, markTones: c.look.markTones, rowLabels: c.look.rowLabels } } : config;
  // A kind of work may offer only some of the decisions (routing.kinds.<kind>.decisions).
  const decisions = Array.isArray(c.decisions_allowed) ? config.decisions.filter((d) => c.decisions_allowed.includes(d.id)) : config.decisions;

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
  // A desk with routing shows the kind its agent was picked by, with the other details.
  const rf = config.routing && config.routing.field;
  // The kind is not shown a second time when it already sits in the chips beside the status.
  const detailKeys = (kc.detailFields || []).concat(rf && !metaFields(config).includes(rf) && !(kc.detailFields || []).includes(rf) && !(kc.chipFields || []).includes(rf) ? [rf] : []);
  const facts = (keys) => withIds(keys.map((key) => show(config, key, c.fields[key])).filter(Boolean).join(" · "), "facts");
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
          h("h2", null, withIds(c.fields.title, "title")),
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
          (kc.chipFields || []).filter((key) => c.fields[key]).map((key) => h("span", { key, className: `fact ${/expedit|urgent/i.test(c.fields[key]) ? "urgent" : ""}` }, show(config, key, c.fields[key]))),
          h(DueChip, { config, c }),
        ),
        h("p", { className: "facts" }, facts(metaFields(config))),
        detailKeys.some((key) => c.fields[key]) || c.fields.subject || c.fields.link
          ? h(
              "p",
              { className: "facts" },
              facts(detailKeys),
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
            config.intake.fields.filter((f) => f.type !== "textarea" && f.key !== "title" && c.fields[f.key]).map((f) => [h("dt", { key: `t-${f.key}` }, f.label), h("dd", { key: `d-${f.key}` }, show(config, f.key, c.fields[f.key], true))]),
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
      ? [h("h3", { key: "sh" }, kc.textHeading || labelOf(config, kc.showText)), h("div", { key: "st", className: "supplied" }, h(CaseText, { text: c.fields[kc.showText] }))]
      : [h("h3", { key: "sh" }, kc.textHeading || labelOf(config, kc.showText)), h("p", { key: "st", className: "small" }, kc.noTextShown || `The desk holds no text for this ${config.desk.caseNoun}.`)];

  const notices = [
    c.status === "drafting" ? h("div", { key: "n1", className: "notice plain" }, "The agent is drafting. This page refreshes on its own.") : null,
    c.last_error ? h("div", { key: "n2", className: "notice bad" }, `The last run failed: ${c.last_error}`) : null,
    latest && latest.warning ? h("div", { key: "n3", className: "notice" }, latest.warning, " The draft below is complete as received; check it as you would any draft.") : null,
    c.status === "removed" ? h("div", { key: "n4", className: "notice plain" }, "Removed by ", h(Named, { me, c, email: c.removed.by }), ` at ${fmt(c.removed.at)}: ${c.removed.note}`) : null,
  ];

  // The decision.
  const askedLines = waiting && c.decision ? String(c.decision.note || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  let decisionPanel;
  if (open) {
    const chosen = decisions.find((d) => d.id === choice) || null;
    // The desk's approving decision is the one called "approve" or, failing that, the one whose outcome is "issued".
    const approve = decisions.find((d) => d.id === "approve") || decisions.find((d) => d.outcome === "issued");
    const redo = decisions.filter((d) => d.outcome === "sent_back");
    const others = decisions.filter((d) => d !== approve && d.outcome !== "sent_back");
    // Where the desk has a pass mark, Approve is the filled button only when
    // every row carries it; otherwise approving takes a reason.
    // When the agent proposes another decision, Approve is not the filled one.
    const proposedId = proposedDecision({ ...config, decisions }, c.proposal);
    const leanApprove = leansApprove(c.all_pass, proposedId, approve);
    const approveNeedsReason = Boolean(config.rules.reasonToApproveUnmet && c.all_pass === false);
    const tag = (d) => (proposedId === d.id ? h("span", { className: "proposed" }, "Agent's proposal") : null);
    const noteLabel = (d) => d.noteLabel || (d.outcome === "sent_back" ? "What the agent should change (it sees this note)" : "Note (kept in the register)");
    decisionPanel = h(
      "div",
      { className: "decide" },
      fourEyesBlocked ? h("div", { className: "notice plain" }, config.rules.fourEyesText) : null,
      h(
        "div",
        { className: "actions" },
        approve
          ? h("button", { className: `btn ${leanApprove ? "primary" : choice === approve.id ? "chosen" : "outline"}`, disabled: Boolean(busy) || fourEyesBlocked || !latest, onClick: () => (approveNeedsReason ? setChoice(choice === approve.id ? "" : approve.id) : decide(approve)) }, busy === approve.id ? "Recording..." : approve.label, tag(approve))
          : null,
        others.map((d) =>
          h("button", { key: d.id, className: `btn ${choice === d.id ? "chosen" : "outline"}`, disabled: Boolean(busy) || fourEyesBlocked || !latest, onClick: () => setChoice(choice === d.id ? "" : d.id) }, d.label, tag(d)),
        ),
      ),
      latest && approve && leanApprove && !chosen
        ? h("p", { className: "will" }, (approve.hint || `Issues version {version}{edited} as the ${config.desk.draftNoun}, in your name.`).replace("{version}", latest.version).replace("{edited}", edited ? ", as edited by you," : ""))
        : null,
      chosen
        ? h(
            "form",
            { className: "form", onSubmit: (e) => { e.preventDefault(); decide(chosen); } },
            h("label", { htmlFor: "decision-note" }, approve && chosen.id === approve.id ? config.rules.reasonToApproveUnmetLabel || "Why you are approving although a row is not met" : noteLabel(chosen), h("textarea", { id: "decision-note", value: note, autoFocus: true, onChange: (e) => setNote(e.target.value) })),
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
      h(
        "div",
        { className: "notice plain" },
        h("p", { className: "lead" }, `${config.statuses[c.status]} since ${fmt(c.decision.at)}. `, h(Named, { me, c, email: c.decision.by }), askedLines.length ? " asked:" : "."),
        // What was asked, in a block of its own, one item to a line.
        askedLines.length ? h("div", { className: "asked" }, askedLines.map((l, i) => h("div", { key: i }, withIds(l, i)))) : null,
      ),
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
      h("div", { className: "notice plain" }, "Sent back by ", h(Named, { me, c, email: c.decision.by }), ` at ${fmt(c.decision.at)}: ${c.decision.note}`),
      h("p", { className: "small" }, "The agent gets the note and the draft it is replacing. Nothing can be decided until the new draft is in."),
    );
  } else if (c.decision) {
    decisionPanel = h(
      "div",
      null,
      h("div", { className: `notice ${c.decision.outcome === "issued" ? "ok" : "plain"}` }, h("b", { className: "declabel" }, (config.decisionLabels || {})[c.decision.outcome] || config.statuses[c.decision.outcome]), " by ", h(Named, { me, c, email: c.decision.by }), ` at ${fmt(c.decision.at)}.`, c.decision.note ? h("div", { className: "decnote" }, `Note: ${c.decision.note}`) : null),
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
              rows && !config.draft.proposalFirst ? h(Tally, { config: vcfg, rows, only: c.marks_allowed }) : null,
              c.next_step
                ? [
                    h("span", { key: "ns" }, h("b", null, "Next step by the desk's rules: "), `${c.next_step.label}, because ${c.next_step.why}.`),
                    c.next_step.agentText
                      ? h("span", { key: "ag", className: `agentline ${c.next_step.agrees ? "" : "differs"}` }, c.next_step.agrees ? "The agent's words: " : "The agent proposed something else: ", c.next_step.agentText)
                      : null,
                  ]
                : c.proposal
                  ? config.draft.proposalFirst
                    ? h(ProposalLead, { text: c.proposal, past: closed })
                    : h("span", null, h("b", null, "The agent proposes: "), c.proposal)
                  : config.draft.proposalPrefix
                    ? h("span", { className: "small" }, "The agent proposed no next step.")
                    : null,
            )
          : null,
        rows && config.draft.proposalFirst ? h("div", { className: "headline tallyline" }, h(Tally, { config, rows, only: c.marks_allowed })) : null,
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
    latest && c.summary && !rows ? h("div", { key: "sum", className: "card" }, h("p", { className: "summary" }, withIds(c.summary, "su"))) : null,
    latest
      ? editing && open
        ? sections.length
          ? [
              // Each named section in a box of its own; the whole text, with the table, is one step further.
              ...sections.map((s, i) => {
                const now = window.DeskShared.parseSections(draft, config).find((x) => x.heading === s.heading);
                const id = `sec-edit-${i}`;
                return h(
                  "div",
                  { key: `edit-${s.heading}`, className: "editsec" },
                  h("label", { htmlFor: id, className: "prose-title" }, s.title),
                  s.hint ? h("div", { className: "prose-hint" }, s.hint) : null,
                  h("textarea", {
                    id,
                    className: "draft prose-edit",
                    rows: Math.min(28, Math.max(6, String(typed[s.heading] != null ? typed[s.heading] : now ? now.text : "").split("\n").reduce((n, l) => n + Math.ceil((l.length || 1) / 64), 1))),
                    value: typed[s.heading] != null ? typed[s.heading] : now ? now.text : "",
                    onChange: (e) => {
                      setTyped({ ...typed, [s.heading]: e.target.value });
                      setDraft(window.DeskShared.replaceSection(draft, config, s.heading, e.target.value));
                    },
                  }),
                );
              }),
              h("details", { key: "edit-whole", className: "editwhole" }, h("summary", null, `The whole text, with the table and the last line`), h("textarea", { className: "draft", "aria-label": "The whole text", value: draft, onChange: (e) => { setTyped({}); setDraft(e.target.value); } })),
            ]
          : h("textarea", { key: "edit", className: "draft", value: draft, onChange: (e) => setDraft(e.target.value) })
        : rows
          ? h(GapRows, { key: "rows", config: vcfg, rows })
          : c.checklist
            ? h("div", { key: "gate", className: "card" }, h("p", { className: "summary" }, c.gate_note || "The review stopped before the criteria were checked."))
            : h("div", { key: "prose", className: "draft" }, sections.length ? window.DeskShared.stripSections(latest.text, config) : latest.text)
      : twoPane && c.status !== "drafting" ? null : h("div", { key: "none", className: "empty" }, c.status === "drafting" ? "Waiting for the agent..." : "No draft yet."),
    // The agent's long pieces of writing, each on a card of its own below the rows.
    latest && !editing && sections.length ? h(SectionCards, { key: "sections", sections }) : null,
    latest && open
      ? h("p", { key: "ver", className: "small" }, edited ? "You have edited the draft. Your version is recorded when you decide." : ["Version ", latest.version, " was written by ", latest.by === "agent" ? "the agent" : h(Named, { key: "by", me, c, email: latest.by }), ` at ${fmt(latest.at)}${latest.library ? `, against ${latest.library}` : ""}. Edit it if you need to; the register keeps every version.`])
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
      return h("li", { key: i }, h("time", null, fmt(e.at)), from ? h("span", null, `Arrived from ${from}`) : plainVia ? h("span", null, plainVia) : h("span", null, h("span", { className: "who" }, h(Named, { me, c, email: e.who })), " ", withIds(e.what, `ev${i}`)));
    })),
  ];

  const chat = closed
    ? null
    : [
        h("h3", { key: "h" }, "Ask the agent about this one"),
        h(
          "div",
          { key: "c", className: "chat" },
          c.conversation.map((m, i) => h("div", { key: i, className: `msg ${m.role}` }, h("span", { className: "by" }, m.role === "user" ? h(Named, { me, c, email: m.by }) : "the agent", " · ", fmt(m.at)), m.role === "user" ? m.content : h(Rich, { text: m.content }))),
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
    const jump = (id) => () => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };
    return [
      h("div", { key: "jump", className: "jump", role: "group", "aria-label": "Jump to" }, h("button", { className: "btn quiet", onClick: jump("pane-questionnaire") }, jumpLabels(config)[0]), h("button", { className: "btn quiet", onClick: jump("pane-assessment") }, jumpLabels(config)[1])),
      h(
        "div",
        { key: "source", id: "pane-questionnaire", className: "col source" },
        header,
        kc.foldOnPhone
          ? h(
              "details",
              { className: "fold", open: foldOpen },
              h("summary", { className: "foldsum", onClick: (e) => { e.preventDefault(); setFoldChoice(!foldOpen); } }, h("span", null, kc.textHeading || labelOf(config, kc.showText)), h("span", { className: "foldhint", "aria-hidden": true }, foldOpen ? "Hide" : "Read")),
              supplied,
              chat,
            )
          : [supplied, chat],
      ),
      h("div", { key: "review", id: "pane-assessment", className: "col review" }, notices, reviewHead, verdict || h("div", { className: "verdict plain" }, decision), review, history),
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
    if (config.intake.fields.some((f) => f.key === c)) return withIds(show(config, c, r[c], true), c);
    if (c === "decision") return h("span", null, (config.decisionLabels || {})[r[c]] || config.statuses[r[c]] || r[c], r[c] === "issued" ? [" ", h("a", { key: "l", className: "doclink", href: `${BASE}/api/cases/${r.case_id}/issued.md`, title: "Download the issued document", "aria-label": "Download the issued document" }, h(Icon, { name: "file" }))] : null);
    if (c === "identity_source") return r[c] === "platform-sign-in" ? "platform sign-in" : "local";
    return withIds(String(r[c] == null ? "" : r[c]), c);
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
      h("tbody", null, rows.map((r, i) => h("tr", { key: i }, cols.map((c) => h("td", { key: c, className: `c-${c}` }, cell(r, c)))))),
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

// True while the screen is narrow enough that the queue sits above the case.
function useNarrow() {
  const query = "(max-width: 1100px)";
  const [narrow, setNarrow] = React.useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    on();
    if (m.addEventListener) m.addEventListener("change", on);
    else m.addListener(on);
    return () => (m.removeEventListener ? m.removeEventListener("change", on) : m.removeListener(on));
  }, []);
  return narrow;
}

function App() {
  const narrow = useNarrow();
  const [queueOpen, setQueueOpen] = React.useState(false); // the queue on a narrow screen, while a case is open
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
  // Picking a case opens it. On a narrow screen the queue then folds away, and the page starts at the case.
  const pick = (id) => {
    setSelected(id);
    if (narrow) {
      setQueueOpen(false);
      window.scrollTo(0, 0);
    }
  };
  const collapsed = narrow && Boolean(current);

  const queue = [
    h(IntakeForm, { key: "add", config, onCreated: async (c) => { await refresh(); pick(c.id); setFilter("open"); } }),
    collapsed ? null : h("h3", { key: "h" }, config.desk.caseNounPlural[0].toUpperCase() + config.desk.caseNounPlural.slice(1)),
    h("input", { key: "q", className: "search", type: "search", placeholder: (config.case && config.case.searchPlaceholder) || "Search by title, regulator or subject", value: search, onChange: (e) => setSearch(e.target.value) }),
    h("div", { key: "f", className: "filters", role: "tablist" }, filters.filter((f) => always.includes(f.id) || counts[f.id] || f.id === filter).map((f) => h("button", { key: f.id, className: f.id === filter ? "on" : "", onClick: () => setFilter(f.id) }, f.label, h("b", null, counts[f.id])))),
    h("ul", { key: "l", className: `caselist ${config.case && config.case.listTitleLines === 2 ? "two-line" : ""}` }, shown.map((c) => h("li", { key: c.id, className: c.id === selected ? "on" : "", onClick: () => pick(c.id) }, h("div", { className: "t" }, withIds(c.fields.title, "lt")), h("div", { className: "s" }, h("span", null, withIds(listFields.map((key) => show(config, key, c.fields[key])).filter(Boolean).join(" · "), "line")), h(DueChip, { config, c }), h(Chip, { config, status: c.status }))))),
    shown.length ? h("p", { key: "n", className: "small" }, q ? `${shown.length} found in all ${config.desk.caseNounPlural}, open and closed` : `${shown.length} of ${list.length}`) : h("p", { key: "n", className: "small" }, list.length ? "Nothing matches." : `No ${config.desk.caseNounPlural} yet.`),
    config.sweeps ? h(SweepLine, { key: "s", onOpen: () => setTab("sweeps") }) : null,
    h("p", { key: "i", className: "invented" }, (config.case && config.case.demoNote) || "Demo data: the bank, its policies and its officers are invented. The two publications are real."),
  ];

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
      ? h("div", { className: "columns" }, h("div", { className: "col wide narrowpage" }, h(Sweeps, { config, onOpened: async (c) => { await refresh(); pick(c.id); setFilter("all"); setTab("desk"); } })))
      : tab === "register"
      ? h("div", { className: "columns" }, h(Register, { config, onOpen: (id) => { pick(id); setFilter("all"); setTab("desk"); } }))
      : h(
          "div",
          { className: `columns ${config.case && config.case.showText ? "two" : ""}` },
          // One tree on every width, so a form that is open survives a resize. On a narrow screen,
          // with a case open, the queue is one row that names it and opens on a tap; elsewhere it is open and its row is hidden.
          h(
            "details",
            { className: `col list queue ${current ? "" : "solo"}`, open: !collapsed || queueOpen, onToggle: (e) => { if (collapsed) setQueueOpen(e.currentTarget.open); } },
            h("summary", { className: "queue-summary" }, h("span", { className: "queue-name" }, config.desk.caseNounPlural[0].toUpperCase() + config.desk.caseNounPlural.slice(1)), h("span", { className: "queue-count" }, shown.length), h("span", { className: "queue-filter" }, q ? "found" : active.label)),
            h("div", { className: "queue-body" }, queue),
          ),
          current ? h(CaseView, { key: current.id, config, me, c: current, refresh }) : h("div", { className: "col blank" }, h("div", { className: "emptystate" }, h(Icon, { name: "inbox" }), h("p", null, list.length ? `Pick a ${config.desk.caseNoun} on the left.` : `No ${config.desk.caseNounPlural} on the desk yet.`), h("p", { className: "small" }, list.length ? "Its details and the agent's review open here." : `${config.desk.addLabel || `Drop a ${config.desk.caseNoun} in`}, or wait for one to arrive.`))),
        ),
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
