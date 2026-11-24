// Small rules that the server and the page both use, so that each has one
// copy: the named sections of a draft, and the display name of a person. The
// file runs in Node (require) and in the browser (a script tag, window.DeskShared).
// No I/O, no dependencies.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DeskShared = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // The sections a desk names in draft.sections. The list may also hold plain
  // strings (the names of the agent's own headings, read by the summary); only
  // the entries that are objects with a heading are cards.
  function sectionSettings(config) {
    const list = config && config.draft && config.draft.sections;
    return Array.isArray(list) ? list.filter((s) => s && typeof s === "object" && typeof s.heading === "string" && s.heading.trim()) : [];
  }

  // A line as a heading is compared: without bold marks or leading hashes.
  function bare(line) {
    return String(line).split("**").join("").replace(/^\s*#{1,6}\s+/, "").trim();
  }

  function linesOf(text) {
    return String(text == null ? "" : text).split("\r").join("").split("\n");
  }

  // Where each named section sits in the text: the line of its heading, and
  // the lines of its body (up to the next section heading, or the proposal
  // line, or the end). Only lines after the table are looked at. A heading is
  // a line that is exactly the section's heading.
  function locate(text, config) {
    const defs = sectionSettings(config);
    if (!defs.length) return [];
    const lines = linesOf(text);
    let lastTable = -1;
    lines.forEach((l, i) => {
      if (l.trim().startsWith("|")) lastTable = i;
    });
    const prefix = String((config.draft && config.draft.proposalPrefix) || "").toLowerCase();
    const isProposal = (l) => Boolean(prefix) && bare(l).toLowerCase().startsWith(prefix);
    const found = [];
    for (const def of defs) {
      const at = lines.findIndex((l, i) => i > lastTable && bare(l) === def.heading.trim());
      if (at >= 0) found.push({ def, at });
    }
    found.sort((a, b) => a.at - b.at);
    return found.map((f, i) => {
      let end = i + 1 < found.length ? found[i + 1].at : lines.length;
      for (let j = f.at + 1; j < end; j++) {
        if (isProposal(lines[j])) {
          end = j;
          break;
        }
      }
      return { def: f.def, at: f.at, end, lines };
    });
  }

  // The sections that hold text: [{heading, title, hint, text}], in the order
  // the settings list them. A heading with nothing under it gives no section.
  function parseSections(text, config) {
    const out = locate(text, config)
      .map((s) => ({ heading: s.def.heading, title: s.def.title || s.def.heading, hint: s.def.hint || "", text: s.lines.slice(s.at + 1, s.end).join("\n").trim(), order: sectionSettings(config).indexOf(s.def) }))
      .filter((s) => s.text);
    return out.sort((a, b) => a.order - b.order).map(({ order, ...rest }) => rest);
  }

  // The text with one section's body replaced. The heading stays. The caller
  // passes the text as typed, so a trailing newline typed in a box is kept.
  function replaceSection(text, config, heading, body) {
    const s = locate(text, config).find((x) => x.def.heading === heading);
    if (!s) return String(text == null ? "" : text);
    const lines = s.lines;
    let a = s.at + 1;
    let b = s.end;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    const fresh = linesOf(body);
    if (a === b) return lines.slice(0, s.at + 1).concat([""], fresh, lines.slice(s.at + 1)).join("\n");
    return lines.slice(0, a).concat(fresh, lines.slice(b)).join("\n");
  }

  // The text without the sections, for the place where the whole text is shown
  // as prose and the cards already show them.
  function stripSections(text, config) {
    const found = locate(text, config);
    if (!found.length) return String(text == null ? "" : text);
    const lines = found[0].lines.slice();
    const drop = new Set();
    for (const s of found) for (let i = s.at; i < s.end; i++) drop.add(i);
    return lines
      .filter((_, i) => !drop.has(i))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // The text with each section's heading line written as a title of its own,
  // for the document that is issued.
  function retitle(text, config) {
    const found = locate(text, config);
    if (!found.length) return String(text == null ? "" : text);
    const lines = found[0].lines.slice();
    for (const s of found) lines[s.at] = `## ${s.def.title || s.def.heading}`;
    return lines.join("\n");
  }

  // A person's name from the sign-in address, where it can be read from it:
  // "l.officer@bank.example" is "L. Officer". An address with one word before
  // the @ (officer@..., jdoe@...) cannot be read, so the address stays.
  // known is a list of {email, name}: a name the desk was told wins.
  function displayName(who, known = []) {
    const s = String(who == null ? "" : who);
    if (!s.includes("@")) return s;
    const hit = known.find((k) => k && k.email === s && k.name && k.name !== s);
    if (hit) return hit.name;
    const parts = s.split("@")[0].split(/[._-]+/).filter((p) => /^[A-Za-z]+$/.test(p));
    if (parts.length < 2 || parts.length !== s.split("@")[0].split(/[._-]+/).filter(Boolean).length) return s;
    return parts.map((p) => (p.length === 1 ? `${p.toUpperCase()}.` : p[0].toUpperCase() + p.slice(1).toLowerCase())).join(" ");
  }

  return { sectionSettings, parseSections, replaceSection, stripSections, retitle, displayName };
});
