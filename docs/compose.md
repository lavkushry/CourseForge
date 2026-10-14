# Compose profiles

CourseForge consolidates legacy and rewrite containers through Compose
profiles. Service names, volume names, and published ports are unchanged from
the pre-consolidation `compose.yaml` / `compose.rewrite.yaml` split.

| File | Role |
| --- | --- |
| `compose.yaml` | Default entrypoint: Qdrant + includes rewrite services |
| `compose.rewrite.services.yaml` | Shared `postgres` / `api` / `media` / `web` definitions |
| `compose.rewrite.yaml` | Sets `name: courseforge-rewrite` and includes the rewrite services |

## Services

| Service | Profile(s) | Host port (default) | Volume |
| --- | --- | --- | --- |
| `qdrant` | _(none — default)_ | `127.0.0.1:6333` | `qdrant_storage` |
| `postgres` | `rewrite`, `app` | `127.0.0.1:15439` (`CF_REWRITE_DB_PORT`) | `rewrite_pg` |
| `api` | `app` | `127.0.0.1:18090` (`CF_REWRITE_API_PORT`) | — |
| `media` | `app` | internal `8091` only | — |
| `web` | `app` | `127.0.0.1:18096` (`CF_REWRITE_WEB_PORT`) | — |

Compose credentials are **local rewrite development only**.

## Commands

```bash
# Legacy Qdrant (unchanged)
docker compose up -d

# Rewrite DB only (use --profile rewrite; bare up no longer starts postgres)
docker compose -f compose.rewrite.yaml --profile rewrite up -d

# Full rewrite loopback stack
docker compose -f compose.rewrite.yaml --profile app up -d
```

Use `-f compose.rewrite.yaml` when you need the existing
`courseforge-rewrite-*` container name prefix. The same profiles work on
`compose.yaml`, but the project name then follows the directory.

## Web healthcheck

The `web` image listens on `COURSEFORGE_WEB_PORT` (default `8080`) with
`COURSEFORGE_WEB_SCHEME=http`. `HEALTHCHECK` probes
`http://127.0.0.1:8080/health`. Nginx returns `200` for `/health` with **no**
HTTP→HTTPS redirect so in-container probes do not fail when an edge proxy
forces HTTPS on other paths.

## Safety

- Do not run Compose against production databases or learner volumes from this
  guide.
- Cutover rules: [rewrite/DEPLOYMENT_CONTRACT.md](rewrite/DEPLOYMENT_CONTRACT.md).
