// Uploads the invented bank's three policies to the platform as a File Upload
// knowledge source, through the agent API, and waits for them to be indexed.
// Needs a key with the Documents and knowledge:sync scopes. Run once:
//   node demo/upload-policies.js
// Prints the source's id and name; attach that source to the Regulatory
// Monitoring Agent's Knowledge section in Studio.

const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); // the desk's .env wins over an ambient key in the shell
}
const base = String(process.env.KATONIC_BASE_URL || "").replace(/\/+$/, "");
const key = (process.env.KATONIC_API_KEY || "").trim();
const NAME = process.env.KATONIC_LIBRARY_NAME || "Meridian policy library (invented)";
if (!base || !key) {
  console.error("set KATONIC_BASE_URL and KATONIC_API_KEY in .env");
  process.exit(4);
}

async function api(route, options = {}) {
  const r = await fetch(`${base}/public/v1${route}`, { ...options, headers: { Authorization: `Bearer ${key}`, ...(options.headers || {}) } });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = text;
  }
  return { status: r.status, data };
}

async function main() {
  // Reuse the source if it is already there.
  const list = await api("/sources");
  if (list.status !== 200) throw new Error(`cannot list sources: HTTP ${list.status} ${JSON.stringify(list.data).slice(0, 200)}`);
  const sources = Array.isArray(list.data) ? list.data : list.data.sources || list.data.items || [];
  let source = sources.find((s) => s.name === NAME);
  if (source) {
    console.log(`source exists: ${source.id} "${source.name}" (${source.status || ""})`);
  } else {
    const created = await api("/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: NAME, connector_type: "file_upload", auth_type: "api_key", config: {} }),
    });
    if (created.status >= 300) throw new Error(`cannot create the source: HTTP ${created.status} ${JSON.stringify(created.data).slice(0, 300)}`);
    source = created.data;
    console.log(`source created: ${source.id} "${source.name}"`);
  }

  const dir = path.join(__dirname, "policies");
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("MTB-POL-") && f.endsWith(".md"));
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([fs.readFileSync(path.join(dir, f))], { type: "text/markdown" }), f);
  const up = await api(`/sources/${source.id}/upload`, { method: "POST", body: form });
  if (up.status >= 300) throw new Error(`upload failed: HTTP ${up.status} ${JSON.stringify(up.data).slice(0, 300)}`);
  console.log(`uploaded ${files.length} files: ${JSON.stringify(up.data).slice(0, 200)}`);

  // An upload starts a run itself; ask for one only if it did not.
  const ing = await api(`/sources/${source.id}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  console.log(`ingest: HTTP ${ing.status} ${JSON.stringify(ing.data).slice(0, 200)}`);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    const s = await api(`/sources/${source.id}`);
    const st = s.data && (s.data.status || s.data.state || "");
    const docs = s.data && (s.data.document_count ?? s.data.documents ?? s.data.doc_count ?? "");
    console.log(`  ${new Date().toISOString().slice(11, 19)} status=${st} documents=${docs}`);
    if (/synced|ready|completed|indexed/i.test(st) && Number(docs) >= files.length) break;
    if (/failed|error/i.test(st)) throw new Error(`indexing failed: ${JSON.stringify(s.data).slice(0, 400)}`);
  }
  console.log(`\nSOURCE_ID=${source.id}\nSOURCE_NAME=${source.name}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
