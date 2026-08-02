# Docker usage

This setup runs the QuantaXscan frontend locally while calling the Replit-hosted API and database.

## Prereqs
- Docker Desktop (or Docker Engine + Compose)

## Configure API base URL
Create a `.env` file in the repo root with the Replit backend base URL:

```
API_BASE_URL=https://YOUR-REPLIT-APP.replit.app
```

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
