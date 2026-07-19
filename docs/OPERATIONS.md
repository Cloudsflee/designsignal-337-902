# Operations

## Local production

Run `node src/cli.mjs doctor`, provide model credentials through the process environment or a protected explicit config, then keep `node src/cli.mjs schedule` under systemd, launchd, Docker Compose, or another restart supervisor. Run `node src/cli.mjs serve` separately. Back up `data/`; it contains reports, the append-only manifest, feedback, cache metadata, and the durable outbox.

Set `DESIGNSIGNAL_MODEL_MAX_OUTPUT_TOKENS` to an integer from 256 through 32768 (default 6000). Each live run uses structured Responses API output for six items followed by one separate synthesis call. The synthesis call receives clipped item analysis, the allowed official exam taxonomy and links, a whitelisted optional study profile, and only the recent bounded feedback window. Malformed output or invented IDs, topics, or citations is retried three times and then fails the run with redacted errors.

`DESIGNSIGNAL_STUDY_PROFILE_FILE` may point to a protected JSON file containing only `directions` (string array), `weaknesses` (string array), and `dailyMinutes` (10-720). Keep the profile outside version control. Feedback is appended with mode `0600` to `data/feedback.ndjson`; invalid dates, score ranges, minutes, oversized notes, and excessive weak-point lists are rejected with HTTP 400.

Missing webhook endpoints are normal: the report remains published and each generic/Feishu/WeCom delivery stays pending with `missing-secret-or-endpoint`. Add the endpoint to the environment and run `node src/cli.mjs push retry`. Failures use capped exponential retry timestamps and never store the endpoint or secret in job files.

The local scheduler computes the next 23:50 in `Asia/Shanghai` with `Intl`, so host timezone does not matter. It catches failed daily runs and schedules the next day. Use an external service supervisor for process crashes or host restarts.

## GitHub Actions

The workflow uses `50 15 * * *` because 15:50 UTC is 23:50 Shanghai. GitHub explicitly does not guarantee exact cron start times; congestion can delay a hosted run. Manual dispatch is available. Per-date concurrency prevents overlapping runs, and report/outbox artifacts are retained for 30 days. Configure `OPENAI_MODEL`, `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, and webhook URLs as Actions secrets/variables.

## Docker

`docker compose up -d` starts the dashboard and scheduler with persistent `designsignal-data`, a read-only application/config filesystem, a writable data mount, and dashboard health check. Supply secrets through the deployment environment; do not bake them into an image or commit an `.env` file.

## Windows Task Scheduler

Create a daily task at 23:50 with “Run whether user is logged on or not” and “Start the task as soon as possible after a scheduled start is missed”. Program: the absolute path to `node.exe`. Arguments: `src\cli.mjs daily`. Start in: the repository root. Put configuration in the task user’s environment or pass `--config C:\protected\designsignal.json`. Enable restart every 5 minutes for three attempts and prevent concurrent instances. A PowerShell registration example:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" -Argument "src\cli.mjs daily" -WorkingDirectory "C:\DesignSignal"
$trigger = New-ScheduledTaskTrigger -Daily -At 11:50PM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "DesignSignal Daily" -Action $action -Trigger $trigger -Settings $settings -User $env:USERNAME
```

## Recovery

An existing dated report makes a rerun idempotently return `exists`. A stale lock indicates an interrupted process; confirm no daily process is running, preserve the lock for incident evidence, then remove only that date’s lock and rerun. If a report directory exists without a manifest entry, inspect its three files and hashes before manually appending a recovery record. Never overwrite an existing report silently.
