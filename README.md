# DesignSignal 337/902

DesignSignal is a private, evidence-first daily research briefing for Zhejiang University 337/902 preparation. It runs on Node.js 24 with no runtime dependencies. Schema v4 classifies each briefing into two papers, product plus UI, and two frontier items, then maps them to the official 337 75/75 and 902 50/50/50 structure and an ordered review route. A report fails visibly when validated supply cannot satisfy the quota or every official part cannot be referenced.

## Quick start

```sh
node src/cli.mjs doctor
node src/cli.mjs daily --fixture --dry-run --json
node src/cli.mjs daily
node src/cli.mjs serve
```

Open `http://127.0.0.1:3379`. The five primary commands are `collect`, `daily`, `serve`, `doctor`, and `schedule`. `node src/cli.mjs push retry` advances Feishu document plus generic, Feishu webhook, and WeCom jobs from the durable outbox. Use `--config /absolute/path/config.json` for an explicit private DesignSignal config. Model settings can also come from `CODEX_CONFIG_FILE`, falling back to `$CODEX_HOME/config.toml`; the selected top-level `model`/`model_provider` and provider `base_url`, `wire_api`, and `experimental_bearer_token` are read with `OPENAI_*` taking precedence. `OPENALEX_API_KEY` and `OPENALEX_MAILTO` are read only from the process environment and appended to OpenAlex requests at request time. Values remain in process memory and credentials, tokens, API endpoints, and folder tokens are never written to reports, caches, health records, logs, or outbox jobs.

Live bilingual enrichment requires an OpenAI-compatible Responses API. Each daily execution is a persisted six-stage DAG: evidence collection, constraint analysis, selection decision, analysis execution, synthesis acceptance, and publication integration. Every stage uses a `contract_schema_version: 2` typed contract, an immutable input snapshot, and a content-addressed output version linked to its direct inputs through `derived_from`. The analysis stage makes six item calls, validates all six items, then acceptance makes a separate seventh call for evidence-grounded synthesis. Static synthesis is restricted to the offline fixture path. Transient transport/status failures and malformed or schema-invalid structured output receive at most three attempts with 1s/2s bounded backoff. A base URL ending in `/responses` is used as-is; configured model URLs containing credentials, query strings, or fragments are rejected.

```sh
export OPENAI_MODEL=your-model
export OPENAI_API_KEY=your-token
export OPENAI_BASE_URL=https://api.openai.com/v1
export DESIGNSIGNAL_MODEL_CONCURRENCY=2
export DESIGNSIGNAL_MODEL_TIMEOUT_MS=180000
export DESIGNSIGNAL_MODEL_MAX_OUTPUT_TOKENS=6000
node src/cli.mjs daily
```

For a native CLI process, an optional private study profile can be supplied with `DESIGNSIGNAL_STUDY_PROFILE_FILE=/absolute/path/profile.json`. Docker uses the separate host variable and override described below. Only `directions`, `weaknesses`, and `dailyMinutes` are accepted into model context; unknown fields are discarded and the file is read with a 16 KiB default limit.

```json
{
  "directions": ["service systems", "inclusive AI"],
  "weaknesses": ["counterevidence", "measurable fallbacks"],
  "dailyMinutes": 90
}
```

The dashboard feedback form records a date, 0-100 comprehension/transfer/exercise scores, 0-720 study minutes, bounded weak points, and an optional note. Only the most recent bounded records are sent to synthesis. Defaults and limits can be changed through the `model` and `study` sections in an explicit config file.

Optional public RSSHub feeds can be supplied with `DESIGNSIGNAL_RSSHUB_FEEDS`, `DESIGNSIGNAL_RSSHUB_WECHAT_FEEDS`, or `DESIGNSIGNAL_RSSHUB_ZHIHU_FEEDS` as comma-separated URLs. They are always treated as optional public sources; login, CAPTCHA, paywall, and private-content access are never attempted, and failures are reported as optional degradation.

The fixture is synthetic, offline test material and is always labeled `fixture: true`; fixture runs and every `--dry-run` execute the same in-memory DAG but perform no writes. Live output is stored under `data/reports/YYYY-MM-DD/`; execution metadata is stored at `data/runs/YYYY-MM-DD/run.json`, while immutable typed outputs live under that run's `assets/` directory. The append-only `data/manifest.ndjson`, per-date locks, source health, rejection and asset audits, bounded public/OA assets, and four durable delivery identities use current versioned contracts. One live date lock covers collection through model work, atomic publication, delivery queueing, and retry; a separate outbox lock serializes manual and scheduled queue/retry operations. A restart resumes completed stages from verified asset versions and retries only the interrupted or failed stage. Missing, changed, or stale required inputs stop with `task_context_not_ready` instead of silently regenerating downstream work. Manifest entries retain bounded source URLs for canonical 60-day dedupe; incomplete entries are rejected. The dashboard verifies the latest manifest path, date, and report hash before serving it. `/api/run`, `/api/runs/YYYY-MM-DD`, and the execution-flow panel expose stage contracts and version lineage without exposing asset payloads; `/api/outbox` exposes only whitelisted progress metadata. Cached images are served from hash-only `/assets/<sha256>` routes. Historical v2/v3 reports, unversioned delivery jobs, and reports without run lineage must be upgraded explicitly with `data migrate` before normal reads.

Feishu document delivery is configured only from `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOC_FOLDER_TOKEN`, and optional `FEISHU_TENANT_BASE_URL`. API requests always use `https://open.feishu.cn`; the tenant base is only the safe document-link origin, defaults to `https://feishu.cn`, and must be a credential-free HTTPS origin. Missing values leave the job pending. Root blocks are appended in ordered chunks of at most 50 with durable confirmed progress. See [operations](docs/OPERATIONS.md#feishu-document-delivery) for app permissions and reconciliation.

Generic JSON, Feishu text webhook, and WeCom text webhook delivery use `DESIGNSIGNAL_WEBHOOK_URL`, `FEISHU_WEBHOOK_URL`, and `WECOM_WEBHOOK_URL`. Endpoints must be HTTPS and are never persisted. A missing endpoint leaves the corresponding versioned job byte-for-byte unchanged. Each due POST uses a stable `Idempotency-Key`, a DNS result pinned through the request, and capped durable backoff. Side-effecting requests are never replayed by the transport layer and never follow redirects.

## Commands

- `collect [--dry-run]`: collect bounded raw public metadata/feed candidates and source degradation records.
- `daily [--date YYYY-MM-DD]`: collect, select, enrich six items, synthesize through a seventh structured model call, strictly validate, atomically publish, and queue/advance all four delivery channels.
- `serve`: run the responsive dashboard and JSON APIs (`/healthz`, `/api/report`, `/api/evidence`, `/api/source-health`, `/api/outbox`).
- `run show [--date YYYY-MM-DD]`: inspect the latest or selected public run metadata, typed contracts, stage states, and asset lineage.
- `run restart --date YYYY-MM-DD [--reason TEXT]`: explicitly archive an incomplete stale run and allow the next `daily` invocation to create a new revision; published and completed runs cannot be replaced.
- `data migrate --dry-run|--apply`: plan or apply the current-contract migration for historical reports, manifests, delivery identities, and run lineage.
- `doctor`: verify Node, evidence integrity, offline quota validation, and data directory access.
- `schedule`: resilient foreground scheduler for 23:50 `Asia/Shanghai`; failed runs are logged and the loop continues.

See [source policy](docs/SOURCE_POLICY.md), [operations](docs/OPERATIONS.md), and [calibration](docs/CALIBRATION.md). No generated live data or secrets belong in Git.

The Docker Compose production baseline uses the host Codex TOML as a read-only scheduler secret, a stable persistent data volume, and a loopback-only dashboard. The optional private profile uses the focused `compose.study-profile.yaml` override and its host-only `DESIGNSIGNAL_STUDY_PROFILE_HOST_FILE`; base Compose remains the no-profile default. See [operations](docs/OPERATIONS.md#docker) for exact Windows/POSIX startup, profile removal, provider checks, scheduling verification, and backup/restore commands.
