# Run the desk on Katonic

You need a Katonic installation, a model the agent can use, and, for the
policy library, an embedding model registered in AI Gateway.

## 1. Build the agent

1. In Studio, create an agent from a blank chat agent.
2. Paste the text in [agent-instructions.md](agent-instructions.md) into its
   instructions and choose a reasoning model.
3. Optional: attach a web search tool from Catalog, Tools. With one, a sweep
   can find what a regulator has published. Without one, the agent says it
   cannot search, and the desk still drafts a gap analysis for every
   publication you drop in.
4. Publish the agent and copy the **published** agent's id. The id of the
   draft in the builder is a different id and does not answer.

## 2. Load the policy library

Use the three invented policies in `demo/policies/`, or your own.

- In Knowledge, choose Connect Source, then File Upload, and add the files.
  The demo names the source "Meridian policy library (invented)".
- Or run `node demo/upload-policies.js` from your machine. It uploads the
  three files through the API, waits for them to be indexed and prints the
  source's id. It needs a key with the Documents and knowledge:sync scopes.

Then connect the library in one of two ways:

- Attach the source in the agent's Knowledge section and publish again.
- Or set `KATONIC_LIBRARY_SOURCE_ID` to the source's id. The desk then
  searches the library itself and hands the passages to the agent.

## 3. Create an API key

Give the key the Chat scope. Add Knowledge search when you set
`KATONIC_LIBRARY_SOURCE_ID`. The key speaks for its owner, so create it as
the identity the desk should act as.

## 4. Deploy the app

In App Studio, choose New app.

| Step | What to enter |
|---|---|
| Source | This repository as a Git repository. Or copy the folder into a Storage dataset and choose "Deploy this folder" |
| Framework | Node/React. Leave the start command empty: App Studio runs `npm install`, then `npm start` |
| Attach dataset | A Storage dataset for the desk's records. Without one, the records are lost when the app restarts |
| Health check path | `/api/health` |
| Access | Private or Shared |

Environment variables:

| Name | Value |
|---|---|
| `KATONIC_BASE_URL` | The address of your installation |
| `KATONIC_API_KEY` | The key from step 3. Mark it as a secret |
| `KATONIC_AGENT_ID` | The published agent's id from step 1 |
| `KATONIC_LIBRARY_NAME` | The library's name, recorded on every draft and in the register |
| `KATONIC_LIBRARY_SOURCE_ID` | Optional. The source's id, when the desk searches the library itself |
| `SEED_DEMO` | Optional. `true` loads the two demo publications on the first start |
| `LOCAL_USER_NAME` | Optional. The stand-in officer's name |
| `INTAKE_TOKEN` | Optional. Turns on intake by webhook at `/api/intake` |

Leave `DATA_DIR` unset. With a dataset attached, the desk keeps its records
in a `desk-records` folder on it.

When the app is running, open `/api/health` under the app's address. It
should say `"records": "attached dataset"` and `"agent": "configured"`.

## Who is signed in

App Studio puts a sign-in step in front of an app that is not public and
passes the signed-in person's email to the app in `X-Forwarded-Email`.

The desk believes that header only when `TRUST_SIGN_IN_HEADERS=true`. Turn it
on only where nothing can reach the app's port except through that sign-in
step. Anywhere else, leave it unset: the desk uses the stand-in identity from
`LOCAL_USER`, and every register row says `identity_source: stand-in`.

Four eyes needs real identities. With the stand-in identity every visitor is
the same officer: a publication dropped in by hand cannot be decided, and one
that arrived from the feed can be decided by anyone.

## A database instead of a file

Set `DATABASE_URL` to a PostgreSQL connection string. The desk creates its
two tables on first start and ignores the dataset.

## The workflow

[workflow.regulatory-change-desk.json](workflow.regulatory-change-desk.json)
is the same flow as a four-step Katonic workflow agent: in, agent, approve,
out. It is a starting point for running the flow with the platform's own
approval step and schedule. The desk does not call it: the desk calls the
agent directly and records decisions in its own register.
