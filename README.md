# Katonic Case Desk

One screen for a person who works through cases with an AI agent. The case is
on the left, the agent's draft is in the middle, the person's decision is on
the right, and every decision lands in a register.

The agent drafts. A person decides. The desk records who decided what, and
when.

It is a small web app on the [Katonic](https://katonic.ai) agent API. The
configuration shipped here is the **regulatory change desk**: a regulatory
publication comes in, the Regulatory Monitoring Agent drafts a gap analysis
against the bank's policy library, and a compliance officer approves it,
edits it, sends it back with a note, or closes it as no action.

![The regulatory change desk](docs/desk.jpg)

The bank, its policies and its officers are invented. The two publications in
the demo are real.

## What it does

- **Takes publications in** by hand, by webhook from a feed, or from a sweep
  that asks the agent what a regulator has published.
- **Shows the agent's draft** as a summary and a table of requirements, each
  marked covered, partly covered, not covered, or not found in the library,
  with the policy clause it rests on. The marks are the agent's reading. The
  officer decides.
- **Lets the officer ask the agent** about the case, on the same session, so
  the agent has the publication and the draft in front of it.
- **Keeps four eyes.** The person who dropped a publication in cannot decide
  it.
- **Takes the decision**: approve and issue, edit the text, send back with a
  note, or close as no action. A sent-back case takes no decision until the
  agent has drafted again, and the new draft carries the officer's note.
- **Keeps the register**: who decided, when, which version of the draft, and
  the agent session. It exports as CSV.

## Try it without Katonic

You need Node.js 20 or later.

```bash
npm install
cp .env.example .env
```

Set these three lines in `.env`:

```
KATONIC_BASE_URL=http://localhost:8390
KATONIC_API_KEY=kapi_fake
KATONIC_AGENT_ID=fake
```

Then, in two terminals:

```bash
node demo/fake-platform.js    # a stand-in for the agent API
```

```bash
npm run seed                  # the two demo publications
npm start                     # http://localhost:3000
```

The stand-in answers with canned text that says it is canned. It shows the
screen and the flow. It is not a gap analysis.

## Run it with a real agent

You need a Katonic installation. [platform/README.md](platform/README.md) has
the steps:

1. Build the agent from [platform/agent-instructions.md](platform/agent-instructions.md).
2. Load a policy library: the three invented policies in `demo/policies/`, or
   your own.
3. Create an API key.
4. Deploy this repository through App Studio, with a Storage dataset attached
   for the desk's records.

## Make it another desk

Almost everything that makes this the regulatory change desk is in
[desk.config.json](desk.config.json): what a case is called, the intake form,
what the agent is asked for, which decisions exist, and what the register
records. The server and the page read it.

The desk was built to serve other case-shaped work the same way, such as
sanctions alert review, complaint handling or payment investigation. Only the
regulatory change configuration ships today, and the sweep feature still
speaks of regulators in the code.

## Settings folders kept outside the repository

A desk is a settings folder. It does not have to live in this repository. A
folder anywhere on the laptop or the server will do.

**Where the desk is.** Set `DESK_CONFIG` to the full path of the folder's
`desk.config.json`, for example
`C:\desks\third-party-risk\desk.config.json`. A relative path is read from
this folder. The demo cases named in the settings are read from the same
folder.

**Where its policy library is.** Set `DESK_LIBRARY_DIR` to a folder of
Markdown files. Use a full path here too. The desk hands the agent the files
that best match each case.

**Replies for the stand-in.** The stand-in platform (`demo/fake-platform.js`)
answers with canned text. A settings folder can carry its own canned replies in
a file `demo-replies.json`, beside `desk.config.json`:

```json
{
  "replies": {
    "Larkspur": "Summary\n...the full reply, table and last line...",
    "tessaly": "..."
  },
  "default": "optional reply for any other case"
}
```

Each key is a distinctive part of a case's title. Case does not matter. The
value is the full reply the stand-in gives for a draft request about that case.
Write it in the shape the desk expects, so the table and the last line are read
as marks. The stand-in adds its own first line saying that the reply is canned.
Start the stand-in with the same `DESK_CONFIG` as the desk:

```bash
DESK_CONFIG=C:/desks/third-party-risk/desk.config.json node demo/fake-platform.js
```

With no file, or with no `DESK_CONFIG`, the stand-in answers as it always did.

**One key file for many desks.** The desk reads `KATONIC_BASE_URL`,
`KATONIC_API_KEY` and `KATONIC_AGENT_ID`. A file named by `DESK_ENV_FILE`
overrides the process environment, key by key. If two desks share one key file,
set `DESK_AGENT_ID` in the process environment of each. It is the agent the
desk calls, whatever `KATONIC_AGENT_ID` says in any file. A file cannot
override it. Nothing else about the order changes.

**Several agents behind one desk.** Add an optional `routing` key to
`desk.config.json`. It picks the agent and the drafting instruction by the
value of one intake field:

```json
"routing": {
  "field": "kind",
  "kinds": {
    "Application pack": { "agentEnv": "PACK_AGENT_ID", "instruction": "Check the application pack..." },
    "Credit memo": { "agentEnv": "MEMO_AGENT_ID", "instruction": "Draft a credit memo..." }
  }
}
```

`field` is the key of an intake field. Each kind names the environment
variable that holds the agent id to call, and the instruction to use in place
of `draft.instruction`. Either can be left out. The table shape and the marks
stay the desk's own. A case whose value is not in the map uses the desk's agent
and instruction. If a kind names a variable that is empty, the draft fails with
a message that says which one to set. Questions about a case go to the same
agent that drafted it. The page shows the kind with the case's other details.
With no `routing` key nothing changes. The stand-in does not know about agents:
its replies come from `demo-replies.json`.

**Small page settings.** All optional; with none of them nothing changes.

- `case.jumpLabel`: the first button of the jump bar on a phone. Default "Questionnaire". The second button is the draft noun, `desk.draftNoun`, with a capital.
- `decisions[].proposalPrefix`: one prefix, or a list of them, with which the agent's proposal line starts when it means this decision. The button is marked "Agent's proposal".
- `draft.plainSource`: set `true` when the first column of a row ("Required by") holds a sentence and not a clause number, so it is not set in monospace.
- `intake.fields[].options`: a list of values. The form shows a list to choose from instead of a text box.

**Decisions and marks for each kind of work.** With `routing`, a kind can name which decisions its cases offer and which marks they use:

```json
"routing": {
  "field": "kind",
  "kinds": {
    "Credit analysis": {
      "agentEnv": "CREDIT_AGENT_ID",
      "instruction": "...",
      "decisions": ["approve", "refer", "send_back"],
      "marks": ["in order", "outside policy", "missing", "differs"]
    }
  }
}
```

`decisions` is a list of decision ids. A case of that kind shows only those buttons, and the server refuses any other decision with a message (HTTP 409). `marks` is a list of mark names. The count above the rows lists those marks, with a zero where none was given. A mark that the agent gave outside the list is still counted. A kind with no list, a kind that is not named, and a desk with no `routing` show every decision and every mark.

**Wording for a kind of work.** A kind can also give its own `markLabels`, `markHints`, `markTones` and `rowLabels`, each laid over the desk's setting of the same name, key by key. A media screening can say "Adverse" where an alert investigation says "Supports concern", and label the lines of its rows "Article" and "Who it is about". A mark's tone is `ok`, `warn`, `err`, `none`, `info` (a row about someone or something apart, in blue, with no tick or cross) or `plain` (background, in grey). An address in a row (http or https) is shown as a link.

`routing.other` takes the same two lists for a case whose kind is not named, or has no value: `"other": { "decisions": ["refer", "send_back"] }`. Without it such a case shows every decision.

**Lines with labels in a row.** A cell of a row may hold several lines, written with `<br>` in the agent's table. A line that starts `Label: value` is shown with its label apart from its value, one line each, and the value is kept whole. A desk whose rows put an old value and a new value side by side can write `Held: A<br>Corrected: B`. The value of a line labelled Corrected is set bold, and one labelled Held is set in the quiet colour. A cell without `<br>` is shown as before. On a phone the lines stack.

**A place for a long piece of writing.** Add objects to `draft.sections`, after the plain names the list may already hold:

```json
"sections": [
  "Summary",
  "Draft review",
  { "heading": "Draft response to the customer. Not sent.", "title": "Draft response to the customer", "hint": "Not sent." }
]
```

When the agent's reply has a line that is exactly `heading`, after the table, the text under it (up to the next section heading or the proposal line) is shown as a card below the rows, under `title`, with `hint` as a small line under the title. The card is set in the serif face, with paragraphs and line breaks kept. Nothing is read as HTML. Entries that are plain strings keep their old meaning (the names of the agent's own headings) and make no card. A reply without the heading shows no card. "Edit the text" gives each section its own box, and the whole text one step further. Every version is kept, and the issued document carries the text as approved, with each heading line written as a `##` title. The stand-in returns such text from `demo-replies.json` as it is; the file's format does not change.

**Small page settings** (all optional):

- `draft.markTones`: a tone for each mark: `ok`, `warn`, `err`, `none` or `person`. `person` is for a mark that is not a pass or a fail but needs a person to decide it: it is shown in the brand colour with a diamond, not in red.
- `letters.<outcome>.dateStyle`: `"long"` writes the dates of a letter as 8 Dec 2026. Without it they are written as 2026-12-08.
- `draft.rowLabels.check`: the label of the last line of a row. Default "Check".
- `due.workingDays`: `true` counts `standardDays` and `expeditedDays` as working days, Monday to Friday, with no holidays. Without it they are calendar days.
- Names: in "What happened", the waiting notice and the other notices, a person is shown by name where the desk can derive it (the signed-in person, the person who entered the case, or `first.last@...` read as "First Last"). The address stays as the element's title. The register and the export keep the address.
- A record id such as `DOC-8203` or `LD-20261123-6A10E8`, a date such as `2026-11-19`, an amount with its currency such as `USD 25,000.00`, and a long code of capitals and digits such as an IBAN or a bank identifier, never break across lines. This holds in the register too. Figures in rows line up.
- On a phone (600 px or narrower) every tab, filter, button, menu, link-like button and fold-out heading is at least 40 px high (the decision buttons 44 px).
- On a screen narrower than 1100 px, with a case open, the queue is one row that names it and shows the count. A tap opens it.

**Marks that are neither a pass nor a fail.** A desk that compares two records (a screening desk) can set `draft.markIcons`, a sign for each mark (`=`, `≈`, `≠`, `–`, `•`), which takes the place of the tick, half circle, cross and question mark that the tone would give. A mark with a sign is drawn with that sign only. `draft.markTones` still picks the colour. `draft.tallyLabels` gives the words the count of marks uses, for example `"differs": "differ"` so that it reads "5 differ".

**Two values side by side.** With `draft.sideBySide: true`, the first two values of a row (the case's and the other record's, labelled by `draft.rowLabels.source` and `.policy`) stand in two boxes of equal width, each under its label, with the reason first and the ids the row rests on after it, in smaller type. A value that is missing reads "none held". `draft.singleValueMarks` is a list of marks (for example `["noted"]`) whose row shows one box, labelled `draft.rowLabels.both`, when the two values are the same text.

**The proposal first.** With `draft.proposalFirst: true`, the strip above the rows leads with "The agent proposes" and the first sentence of the proposal in large type, then the rest of it, then the count of marks. When the case is decided it reads "The agent proposed" in smaller type.

**Words round a bare number.** `intake.fields[].shownAs` is a text with `{value}` in it, for example `"Match score {value}"`. It is used where the value stands alone (the chips under the title, the line in the list). The list of details and the register show the value.

**The alert text on a phone.** With `case.foldOnPhone: true`, on a screen narrower than 1100 px the case's own text and the question box sit under a heading that opens and closes them, closed at first, so the review is what the reader sees under the title.

Dates written like 21 Jul 1990 are kept whole across line ends, as ids and 2026-11-19 are. In a decided case the history reads with the desk's own past-tense label (`decisionLabels`) where it has one, for example "escalated: ...". A note follows a colon, or is a second sentence ("... . Note: ...") when the label already holds a colon.

**A decision the agent carries out.** On most desks a decision only records what a person chose. A decision may also carry `act`, and then the agent does the work the person confirmed, through its own tools, and reports what the systems returned:

```json
{
  "id": "carry_out",
  "label": "Confirm and carry out",
  "outcome": "issued",
  "needsNote": false,
  "hint": "Confirms version {version}{edited} and sends it to the agent to carry out.",
  "act": {
    "instruction": "The staff member has confirmed the proposal below. Carry out exactly what it says...",
    "title": "What the bank's systems returned",
    "waitingWords": ["waiting for approval"],
    "followUp": "Read the state of each request in the earlier outcome and report what it now shows. Change nothing.",
    "doneStatus": "carried_out",
    "waitingStatus": "waiting_approval",
    "failedStatus": "not_carried_out"
  }
}
```

What happens when a person takes that decision:

1. The decision is recorded as any decision is: who, when, the note, the version approved (an edit is a new version), the four-eyes rule, and the kind's allowed decisions. A decision the kind does not allow is refused with 409 and nothing is sent.
2. The case takes the status `acting` ("Carrying out") and the desk sends the agent **one** message: `act.instruction`, a line that tells it to read the current state first and do nothing that is already done, the case as the desk holds it, the draft as approved (the rows and the proposal, with the person's edits) and the person's note. The page shows the agent at work and refreshes on its own.
3. The agent's reply is kept as the **outcome** of the case (the text, the time, and who made the desk ask). It is shown on the case in a card of its own under `act.title`, set for reading, never read as HTML. It is part of the issued document. The register gets a row for each answer, with the first line of the answer in a column `outcome` (name the column in `register.columns` to see it), and "What happened" gets a line for each step.
4. If the reply holds one of `act.waitingWords` (without regard to case), the case takes `act.waitingStatus` and stays open. The card offers one button, "Ask for the outcome again", which sends `act.followUp` with the case, the proposal's own line and the earlier outcome. Each answer is added to the card, newest first. When an answer no longer holds a waiting word the case takes `act.doneStatus`, which counts as closed. Without `waitingWords` the first answer closes the case.
5. If the agent cannot be reached, or answers with an error, nothing is lost. The decision stands. The case takes `act.failedStatus`, the card says what the agent said and offers "Try again", which sends the **same message** again. The desk never tries a second time on its own. A failed ask for the outcome leaves the case waiting: what was asked for earlier is not undone. If the desk itself stops while the agent is working, the case comes back as not carried out, and a retry is safe because the agent reads the state first.

One click sends one message. A second click, two clicks at once and a reload find a case that is already being carried out and send nothing. A case that has been sent to the agent cannot be drafted again, removed or have its details changed.

Every `act` key is optional except that a desk will want `instruction`: `title` (default "What the agent returned"), `waitingWords`, `followUp`, `doneStatus` (`carried_out`), `waitingStatus` (`waiting_for_outcome`), `failedStatus` (`not_carried_out`), `askAgainLabel`, `retryLabel`, and the short lines `workingNote`, `waitingNote`, `doneNote`, `failedNote` that sit above the answer in each state. Give the three statuses a label in `statuses`; the desk supplies "Carrying out", "Carried out", "Waiting for the outcome" and "Not carried out" where you give none. A decision with an act opens a form with an optional note before it is sent (a note is required only if `needsNote` is not `false`). The desk reads only the waiting words: an answer that says the system refused still closes the case, and the person reads the card. A desk with no `act` looks and behaves as before.

The stand-in platform plays an act from `demo-replies.json` with three optional keys beside `replies`: `actions` (the reply to the act message, keyed like `replies` by a part of the case title), `followUps` (the reply to the question about the outcome; a list gives one answer for each time it is asked, the last repeating), and `failActionOnce` (a list of keys whose first act message is answered with an error, so the failure path can be tried). `actionDefault` and `followUpDefault` answer any other case.

```json
{
  "replies": { "Quillfeather": "Summary\n..." },
  "actions": { "Quillfeather": "Waiting for approval. Three requests were made." },
  "followUps": { "Quillfeather": ["Still waiting for approval.", "All approved. DSP-6002 is open."] },
  "failActionOnce": ["Tarrowgate"]
}
```

## What is real and what is a stand-in

| Piece | State |
|---|---|
| A publication arrives by hand, by webhook, or from a sweep | Real. The sweep asks the agent what a regulator published and parses its reply into lines the officer can open as cases. The parse is a convenience, not a guarantee |
| The agent's summary and gap analysis | Real, through `POST /public/v1/chat` to the published agent, streamed and assembled. What it finds depends on the policy library and the search tool the agent has. A draft that is not a table is shown as text |
| Send back, redraft, ask the agent | Real, on the same platform session as the draft |
| Approve, edit, send back, close as no action | Real in the desk. An edited draft is recorded as a new version by the officer |
| The register | Real, in the desk's own records |
| The officer's name | A stand-in (`LOCAL_USER`) unless the desk is told to trust the platform's sign-in headers. Every register row says which it was. See [platform/README.md](platform/README.md) |
| The platform's own approval step | Not used. The desk's register is the record. `platform/workflow.regulatory-change-desk.json` is a starting point for the same flow as a Katonic workflow agent; the desk does not call it |
| Sweeps on a schedule | Not wired. The sweep runs when the officer presses the button |
| The bank and its policy library | Invented (Meridian Trust Bank, three policies in `demo/policies/`) |

## Records

The desk keeps cases, sweeps and the register in one of two places:

- **A JSON file.** In `DATA_DIR` when it is set. On Katonic, in a folder on
  the Storage dataset attached to the app, so the records outlive a restart.
  Written whole on every change, which suits a desk with hundreds of cases.
- **PostgreSQL**, when `DATABASE_URL` is set. Two tables, created on first
  start.

`GET /api/health` says where the records are and whether a restart loses them.

## Security

- **This is code you deploy into your own installation.** Read it, or fork
  it, before you do.
- **The API key speaks for its owner.** Give it the Chat scope only, plus
  Knowledge search when the desk searches the library itself. Create it as
  the identity the desk should act as.
- **The desk calls one address**: your `KATONIC_BASE_URL`. The page loads no
  script, font or style from anywhere else.
- **Identity.** The desk believes the sign-in headers only when
  `TRUST_SIGN_IN_HEADERS=true`. Turn that on only where nothing can reach the
  app except through the platform's sign-in step.
- **Intake by webhook is off** until `INTAKE_TOKEN` is set. The feed sends it
  as `X-Intake-Token`.

## Layout

```
server.js            the API and the page shell (no framework, no build step)
app.js               the page, React without JSX
desk.css             the look
desk.config.json     what makes this desk the regulatory change desk
lib/cases.js         the rules: intake, four eyes, decisions, the register entry, the issued document
lib/agent.js         the Katonic agent API, streamed and assembled
lib/page-shared.js   rules the server and the page share: named sections, display names
lib/identity.js      who is signed in, and whether the headers are believed
lib/store.js         records: a JSON file, or PostgreSQL when DATABASE_URL is set
demo/                the two publications, the invented bank's policies, the seed, the stand-in agent API
platform/            running the desk on Katonic: the steps, the agent's instructions, a workflow
test/                node:test, including the desk end to end against a fake platform
```

## API

| Route | What |
|---|---|
| `GET /api/health`, `/api/config`, `/api/me` | State, the desk's configuration, who is signed in |
| `GET /api/cases`, `GET /api/cases/:id` | The cases |
| `POST /api/cases` | An officer drops a publication in (drafts at once unless `draft: false`) |
| `POST /api/intake` | The feed sends one (`X-Intake-Token`) |
| `PATCH /api/cases/:id`, `POST /api/cases/:id/remove` | Correct the details, or remove a wrong entry with a note |
| `POST /api/cases/:id/draft` | Ask the agent to draft (again) |
| `POST /api/cases/:id/decision` | `{decision, note, draft}`: approve, send_back, no_action |
| `POST /api/cases/:id/outcome/again`, `POST /api/cases/:id/outcome/retry` | Ask the agent for the outcome again (a case that waits), or send the same request again (a case that was not carried out). Only for a decision with an `act` |
| `POST /api/cases/:id/chat` | Ask the agent about this case |
| `GET /api/cases/:id/issued.md` | The issued document |
| `GET /api/sweeps`, `POST /api/sweeps`, `POST /api/sweeps/:id/open` | Sweeps |
| `GET /api/register`, `GET /api/register.csv` | The register |

## Tests

```bash
npm test
```

The tests use Node's own test runner and no network. They include the desk
end to end against a fake platform.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
