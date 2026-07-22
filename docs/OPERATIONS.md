# Operations

## Local production

Run `node src/cli.mjs doctor`, provide model credentials through the process environment or a protected explicit config, then keep `node src/cli.mjs schedule` under systemd, launchd, Docker Compose, or another restart supervisor. Run `node src/cli.mjs serve` separately. Back up `data/`; it contains reports, the append-only manifest, feedback, cache metadata, and the durable outbox.

Set `DESIGNSIGNAL_MODEL_CONCURRENCY` to an integer from 1 through 4 (default 2), `DESIGNSIGNAL_MODEL_TIMEOUT_MS` to an integer from 10000 through 600000 (default 180000), and `DESIGNSIGNAL_MODEL_MAX_OUTPUT_TOKENS` to an integer from 256 through 32768 (default 6000). The model timeout is independent of public-source network timeouts. Each live run analyzes six items with bounded concurrency while preserving selection order, then starts one separate synthesis call only after all six succeed. Timeout and network failures, HTTP 429, HTTP 5xx, and malformed or schema-invalid structured output are attempted at most three times with 1s/2s capped exponential backoff; numeric `Retry-After` values are honored up to 30 seconds, while other HTTP 4xx responses stop immediately. Once one item fails, in-flight calls are allowed to settle but no new item call is scheduled. The synthesis call receives clipped item analysis, the allowed official exam taxonomy and links, a whitelisted optional study profile, and only the recent bounded feedback window. Exhausted failures expose only redacted errors and the public item ID. Model requests disable provider storage with `store: false`. A provider base ending in `/responses` is not appended twice, while config loading rejects model URLs with credentials, query strings, or fragments.

For a native CLI process, `DESIGNSIGNAL_STUDY_PROFILE_FILE` may point to a protected JSON file containing the profile schema described under Docker below. Keep the profile outside version control. Feedback is appended with mode `0600` to `data/feedback.ndjson`; invalid dates, score ranges, minutes, oversized notes, and excessive weak-point lists are rejected with HTTP 400.

Missing delivery configuration is normal: the report remains published. The Feishu document job stays pending with `missing-feishu-document-config`, while each webhook job stays pending without being rewritten. Add the required values and run `node src/cli.mjs push retry`. Queue creation and every retry share `data/locks/outbox.lock`, so scheduled daily work and manual retry cannot mutate the outbox concurrently. Definite document API rejections and tenant-token failures use capped exponential backoff. In-flight create/write jobs and ambiguous side-effecting requests stop as `reconciliation-required` because creating a second document or duplicating root blocks would be unsafe. `/api/outbox` returns a fixed safe metadata projection and represents malformed JSON files as `invalid`; it never returns payloads, configured endpoints, or credentials.

## Execution DAG and recovery

Every live date persists `data/runs/YYYY-MM-DD/run.json` using `aiws.task_execution_context.v2`. Its six ordered stages are `evidence`, `constraints`, `decision`, `execution`, `acceptance`, and `integration`. Each stage records its contract v2 input slots, exact input snapshot hash, attempts, state, blocking dependencies, confirmed output binding, and direct `derived_from` versions. Output envelopes are content-addressed and immutable under `data/runs/YYYY-MM-DD/assets/av_<sha256>.json`; the public API and dashboard return only bindings and hashes, never asset payloads or captured private study context.

Inspect the latest run or a selected date without touching state:

```sh
node src/cli.mjs run show
node src/cli.mjs run show --date 2026-07-22
```

Verify a selected run and all currently bound immutable asset envelopes without touching state:

```sh
node src/cli.mjs run verify --date 2026-07-22 --json
```

`run verify` requires an explicit date. It validates the current run metadata and every content-addressed output binding, and it fails rather than fabricating stage records for legacy reports. `ok: true` means the recorded metadata and bound assets passed integrity checks; inspect `state`, `completed_stage_count`, and per-stage `state` to distinguish a complete run from an internally consistent incomplete run. Failures exit non-zero with a redacted stderr diagnostic, no stdout success body, and no repair or mutation.

A process restart verifies every completed output and resumes from the first unfinished stage. A stage left `running` is retried in place and increments its attempt count. If an immutable asset is missing, altered, or rebound, or if current run parameters no longer match the root snapshot, execution stops with `task_context_not_ready`. It does not overwrite an upstream version or silently regenerate dependent outputs. If the report was atomically published before the integration stage record was finalized, a normal `daily --date ...` recovery reconciles the manifest and finishes only the integration receipt.

For an incomplete run whose inputs intentionally changed, archive the old metadata and explicitly start a new revision:

```sh
node src/cli.mjs run restart --date 2026-07-22 --reason "approved source policy update"
node src/cli.mjs daily --date 2026-07-22
```

The archived run remains under `data/runs/YYYY-MM-DD/revisions/`, and content-addressed assets remain available for audit. `run restart` refuses completed runs and any date whose report has already been published. Old schema v2/v3/v4 reports without a run record stay readable and display `legacy_unverified`; do not create synthetic stage records for them.

## Webhook delivery

Set any combination of `DESIGNSIGNAL_WEBHOOK_URL`, `FEISHU_WEBHOOK_URL`, and `WECOM_WEBHOOK_URL` for generic JSON, Feishu text, and WeCom text delivery. Endpoints must be credential-free HTTPS URLs; query-string webhook keys are supported, remain in process memory, and are never written to an outbox file or report. Every send validates all DNS answers, blocks private and reserved addresses, and pins the validated address set into the TLS request to prevent rebinding between validation and connection. A job is posted once per due retry cycle with `Idempotency-Key: designsignal-<job-id>`. HTTP 408, 425, 429, and 5xx failures remain pending with capped exponential backoff; other 4xx responses also remain visible but are not replayed inside the same process attempt.

## Feishu document delivery

Create a self-built Feishu tenant application and enable tenant access-token authentication. Grant `docx:document:create` for document creation and `docx:document` for root-block writes (or the tenant's current least-privilege equivalents). Grant only the Drive access required for the destination, then add the application as a collaborator on that folder according to the tenant's security policy. Avoid broad `drive:drive` access unless the tenant cannot authorize the folder more narrowly. Verify the permission set in a non-production folder first.

Configure delivery only through the process environment:

```sh
export FEISHU_APP_ID='your-app-id'
read -rs FEISHU_APP_SECRET && export FEISHU_APP_SECRET
read -rs FEISHU_DOC_FOLDER_TOKEN && export FEISHU_DOC_FOLDER_TOKEN
# Optional tenant document-link origin (never an API override):
export FEISHU_TENANT_BASE_URL='https://feishu.cn'
```

Authentication, Docx creation, and block-write requests always use `https://open.feishu.cn`. `FEISHU_TENANT_BASE_URL` is used only to construct the delivered document link; it defaults to `https://feishu.cn` and cannot redirect API traffic.

The sender obtains a tenant token in memory, persists `creating` before the create request, and atomically stores the returned document ID and revision as `created` before attempting any block write. It appends root children in order using the official 1..50 child limit. Before every chunk it persists `writing`, the insertion cursor, revision, size, and a deterministic non-secret client token, then sends that same revision and token. A successful response atomically advances the confirmed cursor and revision. Confirmed chunks resume at the next cursor; an interrupted or ambiguous in-flight chunk stops for reconciliation, preventing duplication or reordering. Job files contain no request body, credential, tenant access token, folder token, or API origin. They retain report identity, safe document/progress metadata, and the SHA-256 render fingerprint. Delivered jobs returned by the CLI and `/api/outbox` include the safe tenant document URL.

A `created` job can resume at its stored confirmed cursor without recreating the document or resending earlier chunks. Tenant-token timeout and HTTP 5xx failures back off because token acquisition has no document side effect. Create/write timeout, HTTP 5xx, malformed success, and interrupted in-flight states require reconciliation. Do not manually change `creating`, `writing`, or `reconciliation-required` to pending. First inspect the Feishu folder/document and reconcile whether the create or write took effect. Preserve the job as incident evidence; after confirming the exact external state, use a separately reviewed manual recovery procedure. Automatic report recovery creates only missing delivery identities. Existing valid legacy webhook jobs retain their original ID, payload, and schema; malformed or unknown legacy files are left untouched.

The local scheduler validates its IANA timezone at configuration load and computes the next 23:50 in `Asia/Shanghai` with `Intl`, so host timezone does not matter. A live run holds `data/locks/YYYY-MM-DD.run.lock` from pre-collection recovery through collection, model calls, asset persistence, report publication, delivery queueing, and retry. Fixture and dry-run commands remain lock-free and side-effect free. The scheduler redacts caught error messages, records the failed day, and schedules the next run. Use an external service supervisor for process crashes or host restarts.

## GitHub Actions

The workflow uses `50 15 * * *` because 15:50 UTC is 23:50 Shanghai. GitHub explicitly does not guarantee exact cron start times; congestion can delay a hosted run. Manual dispatch is available. Per-date concurrency prevents overlapping runs, and report/outbox artifacts are retained for 30 days. Configure `OPENAI_MODEL`, `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, the required Feishu app/folder values, optional `FEISHU_TENANT_BASE_URL`, and any webhook endpoints as Actions secrets/variables when that runner performs delivery.

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

Supply `OPENALEX_*`, optional RSSHub feeds, webhook endpoints, and Feishu document values through the process environment or a local untracked `.env`. Do not bake credentials into the image or commit `.env`. Base Compose passes delivery values only to the scheduler; the dashboard never receives them.

## Windows Task Scheduler

Create a daily task at 23:50 with “Run whether user is logged on or not” and “Start the task as soon as possible after a scheduled start is missed”. Program: the absolute path to `node.exe`. Arguments: `src\cli.mjs daily`. Start in: the repository root. Put configuration in the task user’s environment or pass `--config C:\protected\designsignal.json`. Enable restart every 5 minutes for three attempts and prevent concurrent instances. A PowerShell registration example:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" -Argument "src\cli.mjs daily" -WorkingDirectory "C:\DesignSignal"
$trigger = New-ScheduledTaskTrigger -Daily -At 11:50PM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "DesignSignal Daily" -Action $action -Trigger $trigger -Settings $settings -User $env:USERNAME
```

## Recovery

An existing dated report makes a rerun idempotently return `exists`. Recovery accepts immutable schema v2 reports under their legacy audit contract and schema v3 reports with the complete priority-institution audit; it never upgrades or rewrites them, and manifest reconciliation uses the exact stored JSON bytes. New writes are schema v4. New manifest entries retain item source URLs; legacy entries without that list are backfilled only in memory from a schema-valid report whose bytes match the recorded SHA-256. Latest-report reads reject a noncanonical path, invalid calendar date, hash mismatch, or report-date mismatch. Recovery queues only a missing v1 Feishu document identity and leaves every legacy outbox file byte-for-byte untouched. A stale `.run.lock`, report lock, or `outbox.lock` indicates an interrupted process; confirm that no corresponding daily or push process is running, preserve the lock for incident evidence, then remove only that lock and rerun. If a report directory exists without a manifest entry, inspect its three files and hashes before manually appending a recovery record. Never overwrite an existing report silently.
