# Scenarios

A scenario is a named sequence of steps applied to a payment over virtual time.
Scenarios exist for the flows that are tedious to reproduce by hand and that
integrations most often get wrong.

```bash
paybox scenario list
paybox scenario run late-reversal pay_abc123
paybox time advance 5m
```

Each step is scheduled as a job, so a scenario survives a restart, appears in
`paybox jobs`, and fast-forwards under `time advance`. A 72-hour scenario runs
in a millisecond.

## Built in

| Name | What it exercises |
|---|---|
| `mobile-money-success` | Prompt → pause → customer approves |
| `mobile-money-timeout` | Prompt never answered; payment expires after 5m |
| `mobile-money-rejected` | Customer actively declines on their handset |
| `card-insufficient-funds` | Accepted, then declined during authorization |
| `card-3ds-success` | 3-D Secure step-up, then success |
| `slow-success` | 30 seconds in `processing` before settling |
| `late-reversal` | Fails, then the provider reverses itself two minutes later |

`late-reversal` is the one worth running first. Most integrations treat a
failure as final, write it off, and then quietly diverge from the provider when
the reversal arrives.

## Writing your own

```yaml
name: momo-slow-approval
description: Customer takes 40 seconds to find their phone.
steps:
  - status: pending
  - delay: 2s
    status: requires_action
    note: Awaiting customer authorization
  - delay: 40s
    outcome: success
```

Each step sets exactly one of:

- **`status`** — a canonical status to transition to
- **`outcome`** — a simulated outcome (`success`, `declined`,
  `insufficient_funds`, `expired_card`, `authentication_required`,
  `authentication_failed`, `timeout`, `processing_error`, `customer_rejected`,
  `network_error`)
- **`action`** — `cancel`, `expire`, `authorize`, `capture`, `approve`, `reject`

`delay` is relative to the previous step: `500ms`, `30s`, `5m`, `2h`, `1d`.

Register it:

```bash
curl -X POST localhost:8080/api/scenarios \
  -H 'content-type: application/json' \
  -d "{\"yaml\": $(jq -Rs . < momo-slow-approval.yml)}"
```

A step that lands on an already-terminal payment is skipped rather than
erroring — you may well have intervened from the dashboard mid-run.
