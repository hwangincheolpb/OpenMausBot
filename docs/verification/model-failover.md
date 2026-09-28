# Automatic model failover

## User path

A configured bot can retry an authentication, quota, model-availability or
provider-outage failure using an explicitly configured, ready alternate model.
The same user message stays in its conversation once. The final successful or
failed attempt settles the logical turn, including a scheduled routine run.
The affected direct task keeps its selected fallback for future turns and
resets to Ask, clearing its previous automatic and always-allow grants. The
bot default and sibling tasks retain their saved model and approval settings.
Rooms use the alternate and Ask for that retry without changing the bot's
saved model or approval default.

Failover is opt-in through `modelFailover` in the application configuration:

```json
{
  "modelFailover": {
    "enabled": true,
    "maxAttempts": 2,
    "candidates": [
      { "instanceId": "configured-ready-account", "model": "catalog-model-id" }
    ]
  }
}
```

`maxAttempts` counts the original attempt and is capped at three. An unavailable,
signed-out, disabled or managed provider is not an eligible alternate. Neither
is a model missing from that provider's catalog. Installation alone does not
establish an account's readiness.

After actual response text, reasoning, a tool call or an approval request,
failure stays visible rather than replaying possibly completed work. Policy
refusals and cancellation cannot trigger a switch. Stop must also cancel a
retry whose alternate readiness check is still pending.

## Driving it

Run the isolated workflow regression:

```sh
pnpm exec vitest run server/model-failover.e2e.test.ts
```

The test uses `launchVerificationServer` from the shared `control-omb` surface.
All named accounts and executable wrappers are synthetic and confined to its
temporary home. Wrappers import only the repository's fake Claude or Codex CLI;
no real provider, user credential directory or live app endpoint is used.
Account and routine setup use their normal Settings APIs. Bot creation, model
selection, sends, waits, transcripts and Stop use `runControlOmb` with the
fixture's explicit URL and an explicit task destination.

The assertions cover:

- A direct authentication failure followed by one successful alternate,
  exactly one stored user message and one terminal runtime event.
- Provider-reported spend on the failed attempt retained in the usage ledger
  under its original engine, alongside the successful alternate's spend.
- A routine completing through the alternate while retaining its run record.
- Saved model/approval settings and an untouched sibling task.
- Claude quota/outage failures crossing to the fake Codex driver with one
  fresh native turn and no reused Claude session or widened approval policy.
- Disabled failover and exhausted candidates retaining a terminal error.
- Missing engines, unknown models and signed-out candidates being skipped.
- Text, tool activity and a real approval-broker request preventing replay.
- Stop while the candidate's synthetic readiness probe is pending.
- A concurrency-limit change rejecting the alternate at admission, with one
  failure receipt, no alternate prompt and the other active task preserved.
- Group-member failover and the same partial-output replay guard.

## Evidence and limits

Each case prints its server log path and a retained
`.log.model-failover.json` receipt containing setup actions, exact control
commands, wait results and bounded transcripts. Temporary homes are removed
on completion, including failure. Raw fake-engine dumps and capability tokens
are not copied into the retained receipt.

This proves server behavior with synthetic provider failures. It does not
establish that a real fallback subscription has remaining quota, repair an
expired credential, or prove a desktop permission prompt was granted.

## Last exercised

2026-09-23 on macOS with Node 24.13.1: all 13 workflow cases passed. After
adding failed-attempt usage accounting, the direct/routine case was rerun and
passed with two attributed ledger rows totaling the two provider-reported
amounts, while retaining one logical conversation completion. Server TypeScript
checking and the test file's lint check also passed. All fixture homes were
removed; per-case logs and JSON receipts remain in the launcher's evidence
directory.
