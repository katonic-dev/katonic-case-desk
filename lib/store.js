// Where the desk keeps its records.
//
// Two backends behind one interface:
//   * a JSON file in DATA_DIR (a Storage dataset mounted into the app, or
//     ./data locally). Written whole, atomically, on every change. Fine for a
//     desk with hundreds of cases; not for thousands.
//   * PostgreSQL, when DATABASE_URL is set: the connection string the platform
//     hands a packaged app whose definition asks for a database,
//     or a database the bank brings. Two tables, created on first start.
//
// Records: cases, sweeps, and the register (append-only).

const fs = require("fs");
const path = require("path");

function emptyState() {
  return { cases: {}, sweeps: {}, register: [] };
}

class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "desk.json");
    this.state = emptyState();
    this.kind = "file";
  }
  async init() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } else {
      await this._flush();
    }
    return this;
  }
  async _flush() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
  async listCases() {
    return Object.values(this.state.cases).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  async getCase(id) {
    return this.state.cases[id] || null;
  }
  async putCase(c) {
    this.state.cases[c.id] = c;
    await this._flush();
    return c;
  }
  async listSweeps() {
    return Object.values(this.state.sweeps).sort((a, b) => (a.ran_at < b.ran_at ? 1 : -1));
  }
  async putSweep(s) {
    this.state.sweeps[s.id] = s;
    await this._flush();
    return s;
  }
  async listRegister() {
    return this.state.register.slice();
  }
  async appendRegister(entry) {
    this.state.register.push(entry);
    await this._flush();
    return entry;
  }
  async close() {}
}

class PgStore {
  constructor(url) {
    this.url = url;
    this.kind = "postgres";
  }
  async init() {
    let pg;
    try {
      pg = require("pg");
    } catch (err) {
      throw new Error("DATABASE_URL is set but the pg package is not installed: run npm install");
    }
    this.pool = new pg.Pool({ connectionString: this.url });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS desk_documents (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        body JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (kind, id)
      )`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS desk_register (
        seq BIGSERIAL PRIMARY KEY,
        body JSONB NOT NULL,
        written_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    return this;
  }
  async _list(kind, orderKey) {
    const r = await this.pool.query("SELECT body FROM desk_documents WHERE kind = $1", [kind]);
    return r.rows.map((row) => row.body).sort((a, b) => (a[orderKey] < b[orderKey] ? 1 : -1));
  }
  async _put(kind, doc) {
    await this.pool.query(
      `INSERT INTO desk_documents (kind, id, body, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (kind, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
      [kind, doc.id, JSON.stringify(doc)],
    );
    return doc;
  }
  async listCases() {
    return this._list("case", "created_at");
  }
  async getCase(id) {
    const r = await this.pool.query("SELECT body FROM desk_documents WHERE kind = 'case' AND id = $1", [id]);
    return r.rows[0] ? r.rows[0].body : null;
  }
  async putCase(c) {
    return this._put("case", c);
  }
  async listSweeps() {
    return this._list("sweep", "ran_at");
  }
  async putSweep(s) {
    return this._put("sweep", s);
  }
  async listRegister() {
    const r = await this.pool.query("SELECT body FROM desk_register ORDER BY seq");
    return r.rows.map((row) => row.body);
  }
  async appendRegister(entry) {
    await this.pool.query("INSERT INTO desk_register (body) VALUES ($1)", [JSON.stringify(entry)]);
    return entry;
  }
  async close() {
    await this.pool.end();
  }
}

// Where the JSON file goes. DATA_DIR when it is set. Otherwise a folder of the
// desk's own on the Storage dataset the platform attached to the app (it names
// the mount in KATONIC_DATASET_PATH), so the records outlive the pod. Only
// with neither does the desk fall back to ./data, which a restart on the
// platform throws away.
function dataDir(env = process.env) {
  if (env.DATA_DIR) return { dir: path.resolve(env.DATA_DIR), kept: true, where: "DATA_DIR" };
  if (env.KATONIC_DATASET_PATH) return { dir: path.join(env.KATONIC_DATASET_PATH, "desk-records"), kept: true, where: "attached dataset" };
  return { dir: path.resolve("./data"), kept: false, where: "local folder" };
}

async function openStore(env = process.env) {
  if (env.DATABASE_URL) return new PgStore(env.DATABASE_URL).init();
  const d = dataDir(env);
  const store = await new FileStore(d.dir).init();
  store.where = d.where;
  store.kept = d.kept;
  return store;
}

module.exports = { openStore, dataDir, FileStore, PgStore };
