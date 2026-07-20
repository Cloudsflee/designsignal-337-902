# Operations

## Local production

Run `node src/cli.mjs doctor`, provide model credentials through the process environment or a protected explicit config, then keep `node src/cli.mjs schedule` under systemd, launchd, Docker Compose, or another restart supervisor. Run `node src/cli.mjs serve` separately. Back up `data/`; it contains reports, the append-only manifest, feedback, cache metadata, and the durable outbox.

Set `DESIGNSIGNAL_MODEL_CONCURRENCY` to an integer from 1 through 4 (default 2), `DESIGNSIGNAL_MODEL_TIMEOUT_MS` to an integer from 10000 through 600000 (default 180000), and `DESIGNSIGNAL_MODEL_MAX_OUTPUT_TOKENS` to an integer from 256 through 32768 (default 6000). The model timeout is independent of public-source network timeouts. Each live run analyzes six items with bounded concurrency while preserving selection order, then starts one separate synthesis call only after all six succeed. Timeout and network failures, HTTP 429, and HTTP 5xx are attempted at most three times with capped exponential backoff; numeric `Retry-After` values are honored up to 30 seconds, while other HTTP 4xx responses stop immediately. The synthesis call receives clipped item analysis, the allowed official exam taxonomy and links, a whitelisted optional study profile, and only the recent bounded feedback window. Malformed output or invented IDs, topics, or citations is retried three times and then fails the run with redacted errors. Model requests disable provider storage with `store: false`.

For a native CLI process, `DESIGNSIGNAL_STUDY_PROFILE_FILE` may point to a protected JSON file containing the profile schema described under Docker below. Keep the profile outside version control. Feedback is appended with mode `0600` to `data/feedback.ndjson`; invalid dates, score ranges, minutes, oversized notes, and excessive weak-point lists are rejected with HTTP 400.

Missing webhook endpoints are normal: the report remains published and each generic/Feishu/WeCom delivery stays pending with `missing-secret-or-endpoint`. Add the endpoint to the environment and run `node src/cli.mjs push retry`. Failures use capped exponential retry timestamps and never store the endpoint or secret in job files.

The local scheduler computes the next 23:50 in `Asia/Shanghai` with `Intl`, so host timezone does not matter. It catches failed daily runs and schedules the next day. Use an external service supervisor for process crashes or host restarts.

## GitHub Actions

The workflow uses `50 15 * * *` because 15:50 UTC is 23:50 Shanghai. GitHub explicitly does not guarantee exact cron start times; congestion can delay a hosted run. Manual dispatch is available. Per-date concurrency prevents overlapping runs, and report/outbox artifacts are retained for 30 days. Configure `OPENAI_MODEL`, `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, and webhook URLs as Actions secrets/variables.

## Docker

Compose uses the fixed project `designsignal`, image `designsignal-337-902:1.0.0`, containers `designsignal-dashboard` and `designsignal-scheduler`, and volume `designsignal-data`. Both containers have a read-only root, a writable shared `/data` volume, an isolated `/tmp`, dropped capabilities, `no-new-privileges`, restart supervision, and service-appropriate health checks. Only the dashboard is published, at `http://127.0.0.1:3379`.

The scheduler receives one file-backed Compose secret at `/run/secrets/codex_config` and sets `CODEX_CONFIG_FILE` to that in-container path. Its host source is `DESIGNSIGNAL_CODEX_CONFIG_FILE` when set, otherwise `${USERPROFILE}/.codex/config.toml`. Compose never mounts `CODEX_HOME` and never renders the TOML contents. The source file must exist before Compose starts.

On Windows PowerShell, start from the repository root. `USERPROFILE` is already set by Windows:

```powershell
Test-Path "$env:USERPROFILE\.codex\config.toml"
docker compose config --quiet
docker compose up --detach --build
docker compose ps
```

To use a different protected file for that session, set it before the same commands:

```powershell
$env:DESIGNSIGNAL_CODEX_CONFIG_FILE = "C:\protected\codex\config.toml"
```

On POSIX, map the Windows-style fallback variable to the home directory, or set the explicit override:

```sh
cd /path/to/DesignSignal
export USERPROFILE="${USERPROFILE:-$HOME}"
test -r "${DESIGNSIGNAL_CODEX_CONFIG_FILE:-$USERPROFILE/.codex/config.toml}"
docker compose config --quiet
docker compose up --detach --build
docker compose ps
```

### Optional study profile

The base `compose.yaml` runs without a study profile and does not pass a host profile path into the container. To opt in, add `compose.study-profile.yaml` and set the host-only `DESIGNSIGNAL_STUDY_PROFILE_HOST_FILE`. The override mounts that JSON file alone as a read-only Compose secret at `/run/secrets/designsignal_study_profile`; it does not mount the parent directory. Inside the scheduler, `DESIGNSIGNAL_STUDY_PROFILE_FILE` is always that fixed Linux path. The host-only variable is intentionally different from the native CLI variable, whose semantics remain unchanged.

The profile must be a JSON object no larger than 16 KiB by default. `directions` and `weaknesses` are optional arrays with at most 12 non-empty strings each and at most 240 characters per string. `dailyMinutes` is required and must be an integer from 10 through 720. Only those three fields enter model context; unknown fields are discarded. Keep the file private and outside the repository and image.

On Windows PowerShell, set an absolute host file and start with both Compose files:

```powershell
$env:DESIGNSIGNAL_STUDY_PROFILE_HOST_FILE = (Resolve-Path "C:\protected\designsignal\study-profile.json").Path
if (-not (Test-Path $env:DESIGNSIGNAL_STUDY_PROFILE_HOST_FILE -PathType Leaf)) { throw "Study profile file not found" }
docker compose -f compose.yaml -f compose.study-profile.yaml config --quiet
docker compose -f compose.yaml -f compose.study-profile.yaml up --detach --build
docker compose -f compose.yaml -f compose.study-profile.yaml ps
```

After changing the path or file, recreate the scheduler with both files:

```powershell
docker compose -f compose.yaml -f compose.study-profile.yaml up --detach --force-recreate scheduler
```

On POSIX, use the same two-file startup and recreation flow:

```sh
export DESIGNSIGNAL_STUDY_PROFILE_HOST_FILE=/absolute/protected/path/study-profile.json
test -f "$DESIGNSIGNAL_STUDY_PROFILE_HOST_FILE"
docker compose -f compose.yaml -f compose.study-profile.yaml config --quiet
docker compose -f compose.yaml -f compose.study-profile.yaml up --detach --build
docker compose -f compose.yaml -f compose.study-profile.yaml ps
```

```sh
docker compose -f compose.yaml -f compose.study-profile.yaml up --detach --force-recreate scheduler
```

The profile is independent of provider selection. The existing `/run/secrets/codex_config` secret and the `OPENAI_*` precedence described below continue to work with the override; the profile adds synthesis context but no model URL or credential.

To return to no-profile mode, recreate only the scheduler from base Compose. This preserves the stable `designsignal-data` volume and all reports, feedback, cache, and outbox state. PowerShell:

```powershell
Remove-Item Env:DESIGNSIGNAL_STUDY_PROFILE_HOST_FILE -ErrorAction SilentlyContinue
docker compose -f compose.yaml up --detach --force-recreate scheduler
docker compose -f compose.yaml ps
```

POSIX:

```sh
unset DESIGNSIGNAL_STUDY_PROFILE_HOST_FILE
docker compose -f compose.yaml up --detach --force-recreate scheduler
docker compose -f compose.yaml ps
```

Verify the selected provider without printing its model URL or credential. The output contains only the provider name and booleans; with Codex TOML it should show that TOML's `model_provider`, `modelConfigured: true`, and `responsesApi: true`:

```sh
docker compose run --rm --no-deps scheduler node --input-type=module --eval "const {loadConfig}=await import('./src/lib/config.mjs');const c=await loadConfig();console.log(JSON.stringify({provider:c.model.provider,modelConfigured:Boolean(c.model.model&&c.model.token),responsesApi:c.model.wireApi==='responses'}))"
```

`OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_API_KEY` are pass-through overrides and have no Compose defaults. When all are unset or empty, Codex TOML selects the model and custom provider. Each non-empty `OPENAI_*` value takes precedence over the corresponding TOML value; setting any one selects the `openai-env` Responses provider, so set all three together for an intentional full override, then recreate the scheduler:

```sh
export OPENAI_BASE_URL='your-provider-base-url'
export OPENAI_MODEL='your-model-id'
read -rs OPENAI_API_KEY && export OPENAI_API_KEY
docker compose up --detach --force-recreate scheduler
```

PowerShell uses the same precedence:

```powershell
$env:OPENAI_BASE_URL = Read-Host "Provider base URL"
$env:OPENAI_MODEL = Read-Host "Model ID"
$secureKey = Read-Host "API key" -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
docker compose up --detach --force-recreate scheduler
```

The scheduler logs its next run as structured JSON. Check it after startup and after the daily boundary:

```sh
docker compose logs --since 48h scheduler | grep -E '"event":"scheduled"|"event":"daily-failed"'
```

```powershell
docker compose logs --since 48h scheduler | Select-String '"event":"scheduled"|"event":"daily-failed"'
```

A healthy schedule record contains `"timezone":"Asia/Shanghai"`; its `at` value ends in `T15:50:00.000Z`, which is 23:50 in Shanghai. After a successful run the scheduler emits the next day's `scheduled` record. A `daily-failed` record means the loop survived but that day's report needs investigation. `docker compose ps` must report both containers healthy.

Back up the volume only while both services are stopped so the manifest, report tree, feedback, cache, and outbox are a consistent set. POSIX:

```sh
docker compose stop
docker compose run --rm --no-deps --volume "${PWD}:/backup" dashboard tar -czf /backup/designsignal-data.tgz -C /data .
docker compose start
```

Windows PowerShell:

```powershell
$BackupDir = (Resolve-Path .).Path
docker compose stop
docker compose run --rm --no-deps --volume "${BackupDir}:/backup" dashboard tar -czf /backup/designsignal-data.tgz -C /data .
docker compose start
```

Restore replaces the entire stable volume. Keep the archive outside the volume, verify it is the intended backup, then run from the directory containing `designsignal-data.tgz`. POSIX:

```sh
docker compose down --volumes
docker compose run --rm --no-deps --volume "${PWD}:/backup:ro" dashboard tar -xzf /backup/designsignal-data.tgz -C /data
docker compose up --detach
```

Windows PowerShell:

```powershell
$BackupDir = (Resolve-Path .).Path
docker compose down --volumes
docker compose run --rm --no-deps --volume "${BackupDir}:/backup:ro" dashboard tar -xzf /backup/designsignal-data.tgz -C /data
docker compose up --detach
```

Supply `OPENALEX_*`, optional RSSHub feeds, and webhook values through the process environment or a local untracked `.env`. Do not bake credentials into the image or commit `.env`.

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
