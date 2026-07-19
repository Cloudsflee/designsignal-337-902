# DesignSignal 337/902

DesignSignal is a private, evidence-first daily research briefing for Zhejiang University 337/902 preparation. It runs on Node.js 24 with no runtime dependencies. Live reports contain exactly two papers, one image-backed product case, one image-backed UI/interaction case, and two frontier articles; a report fails visibly when validated supply cannot satisfy that quota.

## Quick start

```sh
node src/cli.mjs doctor
node src/cli.mjs daily --fixture --dry-run --json
node src/cli.mjs daily
node src/cli.mjs serve
```

Open `http://127.0.0.1:3379`. The five primary commands are `collect`, `daily`, `serve`, `doctor`, and `schedule`. `node src/cli.mjs push retry` retries the durable delivery outbox. Use `--config /absolute/path/config.json` for an explicit private DesignSignal config. Model settings can also come from `CODEX_CONFIG_FILE`, falling back to `$CODEX_HOME/config.toml`; the selected top-level `model`/`model_provider` and provider `base_url`, `wire_api`, and `experimental_bearer_token` are read with `OPENAI_*` taking precedence. `OPENALEX_API_KEY` and `OPENALEX_MAILTO` are read only from the process environment and appended to OpenAlex requests at request time. Values remain in process memory and credentials are never written to reports, caches, health records, logs, or outbox jobs.

Live bilingual enrichment requires an OpenAI-compatible Responses API:

```sh
export OPENAI_MODEL=your-model
export OPENAI_API_KEY=your-token
export OPENAI_BASE_URL=https://api.openai.com/v1
node src/cli.mjs daily
```

Optional public RSSHub feeds can be supplied with `DESIGNSIGNAL_RSSHUB_FEEDS`, `DESIGNSIGNAL_RSSHUB_WECHAT_FEEDS`, or `DESIGNSIGNAL_RSSHUB_ZHIHU_FEEDS` as comma-separated URLs. They are always treated as optional public sources; login, CAPTCHA, paywall, and private-content access are never attempted, and failures are reported as optional degradation.

The fixture is synthetic, offline test material and is always labeled `fixture: true`; fixture runs and every `--dry-run` perform no writes. Live output is stored under `data/reports/YYYY-MM-DD/`, with an append-only `data/manifest.ndjson`, per-date locks, source health, rejection and asset audits, bounded public/OA assets, and pending push jobs. Cached images are served from hash-only `/assets/<sha256>` routes.

## Commands

- `collect [--dry-run]`: collect bounded raw public metadata/feed candidates and source degradation records.
- `daily [--date YYYY-MM-DD]`: collect, select, enrich, validate, atomically publish, and queue/retry pushes.
- `serve`: run the responsive dashboard and JSON APIs (`/healthz`, `/api/report`, `/api/evidence`, `/api/source-health`, `/api/outbox`).
- `doctor`: verify Node, evidence integrity, offline quota validation, and data directory access.
- `schedule`: resilient foreground scheduler for 23:50 `Asia/Shanghai`; failed runs are logged and the loop continues.

See [source policy](docs/SOURCE_POLICY.md), [operations](docs/OPERATIONS.md), and [calibration](docs/CALIBRATION.md). No generated live data or secrets belong in Git.
