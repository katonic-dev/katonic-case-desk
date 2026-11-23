// The platform's agent API, as the desk uses it. One route: POST
// /public/v1/chat with an API key. The key speaks for its owner (the desk's
// service identity), not for the officer: the platform does not hand an app
// the signed-in person's token. The officer's name comes from the sign-in
// header (lib/identity.js) and is recorded by the desk itself.
//
// Request body, as the Katonic SDK sends it:
//   { agent_id, messages: [{role: "user", content}], stream, session_id? }
// Buffered reply: { message: {role, content}, session_id, usage? }.
// Streamed reply: SSE "data:" lines; RUN_STARTED carries thread_id (the
// session), TEXT_MESSAGE_CONTENT carries delta, RUN_ERROR carries error,
// "[DONE]" ends it. Streaming is also the way past the edge's 60 s limit on a
// buffered reply, which a gap analysis can exceed, so the desk streams and
// assembles.

function createAgentClient(env = process.env, fetchImpl = globalThis.fetch) {
  const base = String(env.KATONIC_BASE_URL || "").replace(/\/+$/, "");
  const key = env.KATONIC_API_KEY || "";
  // DESK_AGENT_ID, when set in the process environment, is the agent the desk
  // calls, whatever KATONIC_AGENT_ID says (a settings file cannot override it:
  // see loadEnvFile in server.js).
  const agentId = env.DESK_AGENT_ID || env.KATONIC_AGENT_ID || "";

  function missing() {
    const names = ["KATONIC_BASE_URL", "KATONIC_API_KEY", "KATONIC_AGENT_ID"];
    return names.filter((k) => !env[k] && !(k === "KATONIC_AGENT_ID" && env.DESK_AGENT_ID));
  }

  async function createSession(id = agentId) {
    const r = await fetchImpl(`${base}/public/v1/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: id }),
    });
    if (!r.ok) throw new Error(`could not start a session: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    return data.id || data.session_id || "";
  }

  // Streams the reply and assembles it. onDelta, when given, sees each piece.
  async function chat({ message, sessionId, id = agentId, onDelta }) {
    const body = { agent_id: id, messages: [{ role: "user", content: message }], stream: true };
    if (sessionId) body.session_id = sessionId;
    const r = await fetchImpl(`${base}/public/v1/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`the agent did not answer: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    const type = (r.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("text/event-stream")) {
      // The buffered shape, should the edge answer that way.
      const data = await r.json();
      const content = data.message && data.message.content ? data.message.content : data.content || data.response || "";
      return { content, sessionId: data.session_id || sessionId || "", runId: data.run_id || "" };
    }
    const parts = [];
    const tools = []; // what the agent called: {name, args}, for the register
    const pending = {};
    let ended = false; // TEXT_MESSAGE_END seen
    let warning = "";
    let sid = sessionId || "";
    let runId = "";
    const result = () => ({ content: parts.join(""), sessionId: sid, runId, tools, warning });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") return result();
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch (err) {
          throw new Error(`malformed event from the agent: ${payload.slice(0, 120)}`);
        }
        if (evt.type === "RUN_STARTED") {
          if (evt.thread_id) sid = evt.thread_id;
          if (evt.run_id) runId = evt.run_id;
        } else if (evt.type === "TEXT_MESSAGE_CONTENT") {
          const delta = evt.delta || "";
          parts.push(delta);
          if (onDelta) onDelta(delta);
        } else if (evt.type === "TOOL_CALL_START") {
          pending[evt.tool_call_id] = { name: evt.tool_call_name || "", args: "" };
        } else if (evt.type === "TOOL_CALL_ARGS") {
          if (pending[evt.tool_call_id]) pending[evt.tool_call_id].args += evt.args || "";
        } else if (evt.type === "TOOL_CALL_END") {
          if (pending[evt.tool_call_id]) tools.push(pending[evt.tool_call_id]);
        } else if (evt.type === "TEXT_MESSAGE_END") {
          ended = true;
        } else if (evt.type === "RUN_ERROR") {
          const said = evt.error || evt.message || "unknown error";
          // Seen on a live installation: the whole reply arrives, the
          // message ends, and then the run reports an error. The text is
          // complete, so it is kept and the error is carried as a warning for
          // the officer to see. An error before the message ended still fails.
          if (ended && parts.join("").trim()) warning = `The platform reported an error after the reply ended: ${said}`;
          else throw new Error(`the agent's run failed: ${said}`);
        }
      }
    }
    return result();
  }

  // Searches the knowledge library with the desk's key (scope: Knowledge
  // search). Used when the library cannot be attached to the agent itself:
  // the desk retrieves the passages and hands them to the agent.
  async function search({ query, sourceIds, topK = 8 }) {
    const body = { query, top_k: topK };
    if (sourceIds && sourceIds.length) body.source_ids = sourceIds;
    const r = await fetchImpl(`${base}/public/v1/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`the library search failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    return (data.results || []).map((x) => ({
      text: String(x.text || x.content || x.chunk || "").trim(),
      document: String((x.source && x.source.document_title) || x.document_title || "").replace(/.(md|pdf|docx|txt)$/i, ""),
      library: (x.source && x.source.source_name) || "",
      score: x.score,
    }));
  }

  return { base, agentId, missing, search, configured: () => missing().length === 0, createSession, chat };
}

module.exports = { createAgentClient };
