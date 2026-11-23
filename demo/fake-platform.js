// A STAND-IN for the platform's agent API, for local demos and screen work
// only. It answers POST /public/v1/chat the way the platform does (an event
// stream) with canned text that says it is canned. Nothing it writes is a
// real gap analysis. Point the desk at it with
//   KATONIC_BASE_URL=http://localhost:8390 KATONIC_API_KEY=kapi_fake KATONIC_AGENT_ID=fake
// Never use it on the platform.

const http = require("http");

const PORT = Number(process.env.PORT || 8390);

// Canned criteria reviews for the prior authorisation desk's three demo
// requests. They follow the invented policies in desks/prior-authorisation.
const PRIOR_AUTH = {
  mri: {
    policy: "HHP-MP-101",
    rows: [
      "| 1 | Low back pain, with or without leg pain, for at least six weeks | HHP-MP-101 2.1 | Pain radiating to the left leg for about seven weeks | Referral note, 14 November | met | That the onset date matches the first visit on 28 September |",
      "| 2 | At least six weeks of conservative treatment in the last six months | HHP-MP-101 2.2 | Five weekly physiotherapy sessions attended; ibuprofen since 28 September | Physiotherapist's letter, 13 November | partly met | Whether a sixth week of physiotherapy or a home exercise programme is documented |",
      "| 3 | A physical examination in the last 30 days, including a neurological examination of the legs | HHP-MP-101 2.3 | Straight leg raise positive on the left, ankle reflex reduced, power normal | Examination, 14 November | met | Nothing further |",
      "| 4 | How the result is expected to change the member's care | HHP-MP-101 2.4 | To plan a possible referral to the spine service | Referral note, 14 November | met | Nothing further |",
    ],
    replyRow: "| 2 | At least six weeks of conservative treatment in the last six months | HHP-MP-101 2.2 | Six weekly physiotherapy sessions, as the provider's reply records; ibuprofen since 28 September | Physiotherapist's letter, 13 November; provider's reply | met | That the sixth session's date is in the reply |",
    replyNext: "Proposed next step: approve, every criterion is met",
    next: "Proposed next step: ask the provider for more information: (1) the sixth week of physiotherapy, or a documented home exercise programme.",
    redoRow: "| 2 | At least six weeks of conservative treatment in the last six months | HHP-MP-101 2.2 | Five weekly physiotherapy sessions attended (12 October to 13 November); ibuprofen 400 mg three times a day since 28 September, which is seven weeks of pain relief | Physiotherapist's letter, 13 November; referral note | partly met | Whether pain relief counts toward the six weeks under 2.2 when the physiotherapy course is five weeks |",
  },
  glucose: {
    policy: "HHP-MP-214",
    rows: [
      "| 1 | A diagnosis of diabetes | HHP-MP-214 2.1 | Type 2 diabetes for eleven years | Clinic letter, 17 November | met | Nothing further |",
      "| 2 | Insulin by three or more injections a day, or by pump | HHP-MP-214 2.2 | Glargine once a day and aspart with each meal, four injections a day | Clinic letter, 17 November | met | Nothing further |",
      "| 3 | Tests capillary glucose four or more times a day, shown for the last 30 days | HHP-MP-214 2.3 | Meter download for the last 30 days, average 5.1 tests a day | Meter download attached | met | That the download is in the file |",
      "| 4 | A structured diabetes education course completed | HHP-MP-214 2.4 | Course completed 22 June 2026 | Clinic letter, 17 November | met | Nothing further |",
      "| 5 | Seen by the prescriber in the last six months | HHP-MP-214 2.5 | Seen in clinic in person on 17 November 2026 | Clinic letter, 17 November | met | Nothing further |",
    ],
    next: "Proposed next step: approve, every criterion is met",
  },
  bronchoscopy: {
    policy: "HHP-MP-305",
    rows: [
      "| 1 | A lung nodule of 8 mm or more on CT in the last 60 days | HHP-MP-305 2.1 | 1.8 cm spiculated nodule, right lower lobe | CT chest, 15 October | met | Nothing further |",
      "| 2 | Growth on serial imaging, uptake on PET, or suspicious shape | HHP-MP-305 2.2 | Grew from 1.2 cm to 1.8 cm in 3 months; SUV max 4.2; spiculated | CT 12 July and 15 October; PET/CT 22 October | met | Nothing further |",
      "| 3 | Lung function tested in the last 90 days, or a statement that the member is fit for the procedure | HHP-MP-305 2.3 | FEV1 78% predicted; an acceptable candidate for the procedure | Pulmonary function tests, 18 October | met | Nothing further |",
      "| 4 | The requesting clinician is a respiratory physician or thoracic surgeon, or the request records a referral to one | HHP-MP-305 2.4 | Nothing supplied | Not in the request | not documented | The requesting clinician's specialty |",
      "| 5 | Risks discussed and consent recorded | HHP-MP-305 2.5 | Risks including pneumothorax and bleeding were discussed; the member consents | Last paragraph of the request | met | Nothing further |",
    ],
    next: "Proposed next step: ask the provider for more information: (1) the requesting clinician's specialty, or the referral to a respiratory physician or thoracic surgeon.",
  },
  adalimumab: {
    policy: "HHP-PH-330",
    rows: [
      "| 1 | Diagnosis by a rheumatologist, who is the prescriber | HHP-PH-330 2.1 | Seropositive rheumatoid arthritis, diagnosed February 2026; request from a rheumatology clinic | Specialist letter, 18 November | met | Nothing further |",
      "| 2 | Active disease: DAS28 above 5.1 in the last 30 days | HHP-PH-330 2.2 | DAS28 of 5.4 on 10 November 2026, eight swollen joints | Specialist letter, 18 November | met | Nothing further |",
      "| 3 | Methotrexate at 15 mg a week or more for at least three months | HHP-PH-330 2.3 | Started 2 March, 20 mg a week by May, continuing | Specialist letter, 18 November | met | Nothing further |",
      "| 4 | A second conventional medicine for at least three months | HHP-PH-330 2.4 | Nothing supplied | Not in the request | not documented | Whether one was tried, or why none is suitable |",
      "| 5 | Tuberculosis and hepatitis B screening in the last 12 months | HHP-PH-330 2.5 | Nothing supplied | Not in the request | not documented | The screening results and their dates |",
    ],
    next: "Proposed next step: ask the provider for more information: (1) the second conventional medicine tried, or why none is suitable; (2) the tuberculosis and hepatitis B screening results.",
  },
};

function cannedPriorAuth(text) {
  const title = (text.match(/^Request: (.*)$/m) || [, "the request"])[1];
  const key = /MRI/i.test(title) ? "mri" : /glucose/i.test(title) ? "glucose" : /adalimumab/i.test(title) ? "adalimumab" : /bronchoscopy/i.test(title) ? "bronchoscopy" : "";
  const codes = (text.match(/^Procedure or medicine code: (.*)$/m) || [, ""])[1];
  const several = /,/.test(codes);
  const checklist = [
    "Completeness check",
    "",
    "| Item | Status | What was found |",
    "|---|---|---|",
    "| Member reference | complete | Present |",
    "| Requesting provider | complete | Named, with their practice |",
    "| Diagnosis | complete | Given |",
    `| Procedure or medicine code | ${codes ? "complete" : "missing"} | ${codes || "None given"} |`,
    "| Clinical information present | complete | A clinical narrative is supplied |",
    "| Clinical information of substance | complete | History, findings and results specific to the member |",
    "| Urgency | complete | Stated |",
    `| More than one code | ${several ? "incomplete" : "complete"} | ${several ? `Several codes (${codes}): check they may be requested together` : "One code"} |`,
    "| Type of service | complete | Can be classed |",
    "",
  ];
  const redo = /sent back with this note/.test(text);
  const note = (text.match(/sent back with this note: (.*)$/m) || [, ""])[1];
  const head = `[Stand-in agent: canned text so the screen can be seen without a platform. Not a real criteria review.${redo ? ` This is the redo; the note was: "${note}".` : ""}]`;
  if (text.includes("No clinical information was supplied")) {
    return [head, "", "Summary", `${title}: a prior authorisation request with no clinical information.`, "", "Completeness check", "", "| Item | Status | What was found |", "|---|---|---|", "| Member reference | complete | Present |", "| Requesting provider | complete | Named |", "| Diagnosis | missing | None given |", "| Procedure or medicine code | missing | None given |", "| Clinical information present | missing | Nothing supplied |", "| Clinical information of substance | missing | Nothing supplied |", "| Urgency | incomplete | Not stated |", "| More than one code | complete | No code to compare |", "| Type of service | incomplete | Cannot be classed without a code |", "", "Draft criteria review. For review by a clinical reviewer. Not issued.", "", "Gate 1 stopped the review: the request has no clinical information, diagnosis or code, so the criteria cannot be judged.", "", "Proposed next step: ask the provider for more information: (1) the diagnosis; (2) the procedure or medicine code; (3) the clinical notes supporting the request."].join("\n");
  }
  if (!key) {
    return [head, "", "Summary", `${title}: a prior authorisation request, received by the desk.`, "", "Draft criteria review. For review by a clinical reviewer. Not issued.", "", "| # | Criterion | Policy source | Evidence in the request | Where | Mark | Reviewer should check |", "|---|---|---|---|---|---|---|", "| 1 | The stand-in has no coverage policy for this service | None | Nothing supplied | Not in the request | not documented | Which coverage policy applies |", "", "Proposed next step: ask the provider for more information: (1) which service is requested."].join("\n");
  }
  const k = PRIOR_AUTH[key];
  const member = (text.match(/^Member reference: (.*)$/m) || [, ""])[1];
  const replied = text.includes("Provider's reply") && k.replyRow;
  const rows = replied ? k.rows.map((r) => (r.startsWith("| 2 |") ? k.replyRow : r)) : redo && k.redoRow ? k.rows.map((r) => (r.startsWith("| 2 |") ? k.redoRow : r)) : k.rows;
  return [
    head,
    "",
    "Summary",
    `${title}, for member ${member}. Checked against coverage policy ${k.policy} of the invented health plan.`,
    "",
    ...checklist,
    "Draft criteria review. For review by a clinical reviewer. Not issued.",
    "",
    "| # | Criterion | Policy source | Evidence in the request | Where | Mark | Reviewer should check |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    replied ? k.replyNext : k.next,
  ].join("\n");
}

function canned(text, sessionId) {
  if (text.includes("THE PRIOR AUTHORISATION REQUEST") && !text.includes("THE QUESTION")) return cannedPriorAuth(text);
  if (text.includes("What has")) {
    return "[Stand-in agent: canned reply, not a search.]\n- Example publication A - 2026-11-03 - example of a line the desk can open as a case - https://example.invalid/a\nNothing else for the period.";
  }
  if (sessionId && !text.includes("THE PUBLICATION")) {
    return "[Stand-in agent: canned reply.] In a real run the agent would answer from the case and its library on this same session.";
  }
  const title = (text.match(/^Title: (.*)$/m) || [, "the publication"])[1];
  const redo = text.includes("THE PREVIOUS DRAFT");
  const note = (text.match(/sent back with this note: (.*)$/m) || [, ""])[1];
  return [
    `[Stand-in agent: canned text so the screen can be seen without a platform. Not a real gap analysis.${redo ? ` This is the redo; the note was: "${note}".` : ""}]`,
    "",
    "Summary",
    `${title}: a regulator's publication, received by the desk. Whom it applies to, what it changes and from when would be read from the text or the link.`,
    "",
    "Draft gap analysis. For review by a compliance officer. Not issued.",
    "",
    "| # | Requirement | Source | Policy says | Citation | Mark | Reviewer should check |",
    "|---|---|---|---|---|---|---|",
    "| 1 | The board and senior management hold ultimate responsibility for AI risk management | Section 3 | The Risk Committee owns model risk; the board receives no AI risk report | MTB-POL-014 2.1, 7.3 | partly covered | Whether the Risk Committee's remit satisfies the board-level expectation |",
    "| 2 | An inventory of AI systems with a materiality assessment | Section 4 | A model inventory with three materiality tiers | MTB-POL-014 3.1 to 3.3 | covered | Whether AI systems that are not \"models\" under 1.2 are in it |",
    `| 3 | Controls for AI agents that act without a person's review | Section 5 | ${redo ? "Such systems are not permitted; a proposal to use one is a material change needing Committee approval" : "Such systems are not permitted"} | MTB-POL-014 7.1${redo ? ", 4.1" : ""} | not covered | Whether any such system is in use; the policy forbids rather than controls |`,
    "| 4 | Staff competence in AI | Section 6 | Staff are told which systems use AI; nothing on competence | MTB-POL-014 5.3 | not found | Training records |",
  ].join("\n");
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/public/v1/chat" && req.method === "POST") {
      const text = body.messages && body.messages[0] ? body.messages[0].content : "";
      const sid = body.session_id || `fake-session-${Date.now()}`;
      const reply = canned(text, body.session_id);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "RUN_STARTED", thread_id: sid, run_id: `fake-run-${Date.now()}` })}\n\n`);
      const pieces = reply.match(/.{1,40}/gs) || [];
      let i = 0;
      const tick = setInterval(() => {
        if (i >= pieces.length) {
          clearInterval(tick);
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        res.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: pieces[i++] })}\n\n`);
      }, 15);
      return;
    }
    if (req.url === "/public/v1/sessions" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: `fake-session-${Date.now()}` }));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "the stand-in platform knows only /public/v1/chat and /public/v1/sessions" }));
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`stand-in platform on ${PORT}: canned replies, not a real agent`));
