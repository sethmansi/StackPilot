# 🧭 StackPilot

**AI-assisted stacked pull request manager for Azure DevOps.**

StackPilot makes dependent code changes easier to develop, review, and merge. It
brings **PR dependencies**, **branch synchronization**, **stack-aware reviews**,
and **reviewer-friendly descriptions** into one workflow, driven through the CLI
or through **comment-based commands** on a PR. AI guidance is combined with
**controlled Git operations**, **explicit approvals**, and a full **audit trail**
so developers stay in control.

> Hackathon prototype. Runs fully offline with an in-memory Azure DevOps mock, or
> against a real Azure DevOps organization with a PAT.

---

## Why stacked PRs?

A large feature is easier to review as a chain of small, dependent PRs than as one
giant diff:

```
◆ feature/auth-api      → feature/auth-service   !103  depends on !102
│
◆ feature/auth-service  → feature/auth-schema    !102  depends on !101
│
◆ feature/auth-schema   → main                   !101
│
◇ main (trunk)
```

Each PR targets the branch below it. Reviewers approve bottom-up; StackPilot keeps
the chain consistent when bases move or the bottom merges.

---

## Features

| Capability | What StackPilot does |
|---|---|
| **PR dependencies** | Opens PRs bottom-up, each targeting the branch below, and records the `depends-on` link (encoded in the PR description + a posted comment). |
| **Branch synchronization** | Detects drift (base moved / branch changed) and plans the exact `git rebase --onto` + `push --force-with-lease` operations to restack. |
| **Stack-aware reviews** | Generates a review summary spanning all PRs with a suggested bottom-up review order. |
| **Reviewer-friendly descriptions** | AI-generates structured PR descriptions: what changed, areas touched, commits, review guidance, and a stack map. |
| **Comment-based commands** | `/stackpilot sync`, `/stackpilot review`, `/stackpilot merge`, etc. — the same engine a real ADO comment webhook would call. |
| **Controlled Git + approvals** | Every mutating operation is previewed as a plan and gated behind an explicit approval before anything runs. |
| **Audit trail** | Append-only log of every action (planned and applied) with actor and timestamp. |

---

## Architecture

```
CLI (commander)  ──┐
comment commands ──┼──►  StackManager (engine)
                   │        │
                   │        ├─ Provider  (Azure DevOps REST  |  in-memory mock)
                   │        ├─ GitService (real git CLI      |  simulated mock)
                   │        ├─ AIProvider (pluggable         |  deterministic mock)
                   │        └─ StackStore  (.stackpilot/state.json + audit + approvals)
```

Everything is an interface, so the **same engine** drives real Azure DevOps and the
offline demo. Swapping in a real LLM is a one-file change (`AIProvider`).

Source layout (`src/`):

- `core/` — domain types + `StackManager` engine (lifecycle, sync, merge, approvals)
- `providers/` — `Provider` interface, `ado/` (real REST), `mock/` (in-memory + disk)
- `git/` — `GitService` interface, real git CLI + simulated mock
- `ai/` — `AIProvider` interface + deterministic mock generator
- `store/` — file-backed state, append-only audit, approval requests
- `cli/` — command wiring, rendering, comment parser/dispatcher
- `demo/` — self-contained end-to-end walkthrough

---

## Quick start

```bash
npm install
npm run build

# See the whole workflow end-to-end, offline:
npm run demo
```

### Use the CLI (offline mock)

```bash
node dist/index.js init --provider mock --trunk main
node dist/index.js create auth-feature feature/auth-schema
node dist/index.js push   auth-feature feature/auth-service
node dist/index.js push   auth-feature feature/auth-api

node dist/index.js submit   auth-feature          # preview linked PR submission
node dist/index.js submit   auth-feature --apply  # execute/request approval
node dist/index.js describe auth-feature --show    # AI descriptions
node dist/index.js review   auth-feature           # stack-aware review
node dist/index.js status   auth-feature
node dist/index.js status   auth-feature --json    # machine-readable stack status
node dist/index.js top      auth-feature           # switch between stack branches
node dist/index.js down     auth-feature
node dist/index.js trunk    auth-feature
node dist/index.js checkout feature/auth-service   # find a local stack by branch
node dist/index.js checkout 102                    # or by PR ID
node dist/index.js validate auth-feature           # check local stack safety

node dist/index.js sync  auth-feature --dry-run     # explain the rebase plan
node dist/index.js sync  auth-feature --apply       # execute/request approval
node dist/index.js approvals --pending
node dist/index.js approve <id>

node dist/index.js merge auth-feature --apply       # merge bottom + restack
node dist/index.js audit auth-feature
```

`submit` is idempotent: it reuses active PRs, fixes their target branches and
dependency markers when needed, and creates only missing PRs.

`status --json` outputs branches from bottom to top with their PR IDs, target
branches, dependency IDs, and current status for scripts and CI.

> Tip: the `stackpilot` and `sp` bin names are available after `npm link`.

### Comment-based commands

The same commands work as PR comments (simulated here; wire `dispatchComment` to
an ADO service hook for the real thing):

```bash
node dist/index.js comment auth-feature "/stackpilot status"
node dist/index.js comment auth-feature "/stackpilot review"
node dist/index.js comment auth-feature "/stackpilot sync" --apply
```

Triggers: `/stackpilot`, `/sp`, `@stackpilot`. Try `/stackpilot help`.

---

## Connecting to real Azure DevOps

```bash
$env:AZURE_DEVOPS_PAT = "<your PAT>"     # PowerShell
node dist/index.js init `
  --provider ado `
  --org https://dev.azure.com/<org> `
  --project <project> `
  --repo <repository> `
  --trunk main
```

With `--provider ado` and a PAT set, StackPilot creates/updates real PRs, posts
comments, and completes PRs via the Azure DevOps REST API
(`azure-devops-node-api`). Git rebase/push operations run against your local clone
through the real `git` CLI. Without a PAT it transparently falls back to the mock
so the tool always runs.

Azure DevOps has no native PR-to-PR dependency, so StackPilot encodes the stack
relationship in a hidden marker in the PR description
(`<!-- stackpilot:depends-on=101 -->`) plus a human-readable comment.

---

## Safety model

- **Dry-run by default** — mutating commands print a plan; nothing runs without `--apply`.
- **Explicit approval** — with `requireApproval` (default on), even `--apply` only
  queues an `ApprovalRequest`; the operations execute after `approve <id>`.
- **Force pushes** use `--force-with-lease`.
- **Audit trail** — every planned and applied action is recorded in
  `.stackpilot/state.json`.

---

## Tests

```bash
npm test
```

Covers dependency-link round-tripping, comment parsing, bottom-up PR creation,
merge + restack, and the approval gate.

---

## Roadmap (beyond the prototype)

- Real LLM `AIProvider` (Azure OpenAI / OpenAI) behind the existing interface
- Azure DevOps Service Hook receiver so comment commands fire from real PR threads
- Conflict-aware restack with interactive resolution
- Stack visualization in an ADO dashboard extension
