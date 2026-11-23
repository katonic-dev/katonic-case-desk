# Prior authorisation desk

A second configuration of the Katonic Case Desk, for a health plan's prior
authorisation team. A request comes in, the Prior Authorisation Review Agent
checks it against the plan's coverage policy, and a clinical reviewer decides.

The health plan (Harbourline), its coverage policies, its members and its
clinics are invented. Nothing here is clinical guidance.

## What the reviewer gets

- **A completeness check first.** Nine items, six of which hold the request
  up. A request with no diagnosis, code or real clinical notes stops there.
- **Three gates in order**: the request is complete, a coverage policy
  applies, the policy's criteria are documented. The agent stops at the first
  gate that fails and says which.
- **One row per criterion**, marked met, partly met, not met or not
  documented, with the policy clause and where the evidence is in the request.
- **The agent's proposed next step**: approve, ask the provider, or refer to
  the medical director.
- **Three decisions**: approve, ask the provider for more information, refer
  to the medical director. The desk has no decision that refuses a request.
- **Waiting for the provider.** Asking for information keeps the request
  open. The provider's reply is added to the clinical information and the
  agent reviews again.
- **Letters and a record.** Approval and the request for information each
  write a letter to the provider. Approval and referral write an eight-section
  audit record.

## Run it

```bash
npm install
DESK_CONFIG=desks/prior-authorisation/desk.config.json SEED_DEMO=true npm start
```

Without a platform, start `node demo/fake-platform.js` first and point
`KATONIC_BASE_URL` at it. Its replies are canned and say so.

With a real agent, build it in Katonic Studio from `agent-instructions.md`,
publish it with the REST API channel on, and set `KATONIC_BASE_URL`,
`KATONIC_API_KEY` (Chat scope) and `KATONIC_AGENT_ID`.

## Where the policies come from

Two ways, pick one:

- `KATONIC_LIBRARY_SOURCE_ID`: the policies are a knowledge source on the
  platform and the desk searches it.
- `DESK_LIBRARY_DIR=desks/prior-authorisation/policies`: the policies are
  Markdown files beside the desk, and the desk hands the agent the one that
  matches the request.

## Settings this desk adds

| Setting | What it does |
|---|---|
| `DESK_CONFIG` | Which desk to be. Without it, the regulatory change desk. |
| `DESK_ENV_FILE` | A settings file to read in place of `.env`. |
| `DESK_LIBRARY_DIR` | A folder of policy files to hand to the agent. |

## What was tested, and what was not

Tested on 23 November 2026: the automated tests, fourteen scenarios through
the screens with canned replies, and a run against a real agent on a Katonic
development cluster with the four demo requests and six further checks.

Not tested: the platform's sign-in in front of the desk, the desk deployed
through App Studio, two reviewers at once, the request feed, and any clinical
review of the agent's judgements. The same request can be marked differently
on two runs, so the marks are a draft for the reviewer and never a decision.

## Credit

The completeness checklist, the order of the gates, the shape of the agent's
instructions, the two letters, the sections of the audit record and the fourth
demo request are adapted from Microsoft's Prior Authorization Multi-Agent
Solution Accelerator (MIT licence). See `NOTICE` and
`THIRD-PARTY-LICENCE-MIT.txt`. No code from that project is included.
