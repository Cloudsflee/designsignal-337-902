# DesignSignal 337/902

DesignSignal is a private, evidence-first daily research briefing for Zhejiang University 337/902 preparation. It runs on Node.js 24 with no runtime dependencies. Live reports contain exactly two papers, one image-backed product case, one image-backed UI/interaction case, and two frontier articles; a report fails visibly when validated supply cannot satisfy that quota.

## Quick start

```sh
node src/cli.mjs doctor
node src/cli.mjs daily --fixture --dry-run --json
node src/cli.mjs daily
node src/cli.mjs serve
```

Open `http://127.0.0.1:3379`. The five primary commands are `collect`, `daily`, `serve`, `doctor`, and `schedule`. `node src/cli.mjs push retry` retries the durable delivery outbox. Use `--config /absolute/path/config.json` for an explicit private config. Values are read into process memory only; credentials are never written to reports, caches, logs, or outbox jobs.

Live bilingual enrichment requires an OpenAI-compatible Responses API:

```sh
export OPENAI_MODEL=your-model
export OPENAI_API_KEY=your-token
export OPENAI_BASE_URL=https://api.openai.com/v1
node src/cli.mjs daily
```

The fixture is synthetic, offline test material and is always labeled `fixture: true`; it is not a live intelligence report. `--dry-run` performs no writes. Live output is stored under `data/reports/YYYY-MM-DD/`, with an append-only `data/manifest.ndjson`, per-date locks, source health, rejection audit, and pending push jobs.

## Commands

- `collect [--dry-run]`: collect bounded raw public metadata/feed candidates and source degradation records.
- `daily [--date YYYY-MM-DD]`: collect, select, enrich, validate, atomically publish, and queue/retry pushes.
- `serve`: run the responsive dashboard and JSON APIs (`/healthz`, `/api/report`, `/api/evidence`, `/api/source-health`, `/api/outbox`).
- `doctor`: verify Node, evidence integrity, offline quota validation, and data directory access.
- `schedule`: resilient foreground scheduler for 23:50 `Asia/Shanghai`; failed runs are logged and the loop continues.

See [source policy](docs/SOURCE_POLICY.md), [operations](docs/OPERATIONS.md), and [calibration](docs/CALIBRATION.md). No generated live data or secrets belong in Git.
