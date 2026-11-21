// A STAND-IN for the platform's agent API, for local demos and screen work
// only. It answers POST /public/v1/chat the way the platform does (an event
// stream) with canned text that says it is canned. Nothing it writes is a
// real gap analysis. Point the desk at it with
//   KATONIC_BASE_URL=http://localhost:8390 KATONIC_API_KEY=kapi_fake KATONIC_AGENT_ID=fake
// Never use it on the platform.

const http = require("http");

const PORT = Number(process.env.PORT || 8390);

function canned(text, sessionId) {
  if (text.includes("What has")) {
    return "[Stand-in agent: canned reply, not a search.]\n- Example publication A - 2026-11-03 - example of a line the desk can open as a case - https://example.invalid/a\nNothing else for the period.";
  }
  if (sessionId && !text.includes("THE PUBLICATION")) {
    return "[Stand-in agent: canned reply.] In a real run the Regulatory Monitoring Agent would answer from the publication and the policy library on this same session.";
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
