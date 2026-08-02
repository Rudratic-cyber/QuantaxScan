# Docker usage

This setup runs the QuantaXscan frontend locally while calling the Replit-hosted API and database.

## Prereqs
- Docker Desktop (or Docker Engine + Compose)

## Configure API base URL
Create a `.env` file in the repo root with the Replit backend base URL:

```
API_BASE_URL=https://YOUR-REPLIT-APP.replit.app
```

## Configure API authentication (required)

The API server refuses to start without `QUANTAXSCAN_API_KEYS`, so that a deployment
can never serve an unauthenticated API. Generate a key and export it before starting:

```
export QUANTAXSCAN_API_KEYS="$(openssl rand -base64 32)"
export CORS_ALLOWED_ORIGINS=http://localhost:5173
```

**Do not put the key in `.env`** — that file is tracked in git (see G-13 in
`docs/Claude/09-open-gaps.md`). Export it in your shell or use a secret store.

Callers send it as `Authorization: Bearer <key>` or `X-API-Key: <key>`:

```
curl -H "X-API-Key: $QUANTAXSCAN_API_KEYS" http://localhost:5000/api/projects
```

The browser frontend does **not** hold a key, so pages backed by protected routes
(dashboard, scan, reports) return 401 until per-user auth (F1) lands. `/api/healthz`,
`/api/demo/*`, community reads and report share links stay public.

## Start
```
docker compose up -d --build
```

## Check status
```
docker compose ps
```

## View logs
```
docker compose logs -f quantaxscan
```

## Restart
```
docker compose restart quantaxscan
```

## Stop and remove container
```
docker compose down
```
