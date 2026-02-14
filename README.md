# CORSproxy

CORSproxy is a lightweight CORS proxy with a simple and modern web UI.

**Demo:** https://corsproxy.nl

- **Proxy public URLs** with permissive CORS headers (`Access-Control-Allow-Origin: *`).
- **Modern web UI** to quickly fetch and inspect responses.
- **Quick test endpoint** for checking status/CORS/content preview from the browser.
- **Persistent stats storage** in a JSON file (not memory-only).
- **Stats ignore list** via `data/ignorelist.txt` (optionally extended with `STATS_IGNORE`).
- **Relative path support** using `Referer` host mapping.

## Start CORSproxy

### Option 1: Docker Compose (recommended)

```yaml
services:
  corsproxy:
    image: ghcr.io/r0gger/corsproxy:latest
    ports:
      - "3080:3080"
    volumes:
      - ./data:/app/data
    environment:
      - PORT=3080
      - STATS_FILE=/app/data/stats.json
      #- STATS_IGNORE=favicon.ico,apple-touch-icon.png,robots.txt
      # Optional: public URL (e.g. behind reverse proxy with HTTPS)
      #- BASE_URL=https://corsproxy.nl
    restart: unless-stopped
```

Start:
```bash
docker compose up -d
```

Stop:
```bash
docker compose down
```

Default URL:
- `http://localhost:3080`

### Option 2: Plain Docker

```bash
docker pull ghcr.io/r0gger/corsproxy:latest
docker run -d --name corsproxy -p 3080:3080 ghcr.io/r0gger/corsproxy:latest
```

Stop and remove:

```bash
docker rm -f corsproxy
```

## Docker environment variables

Use these in Docker or `docker-compose.yml`:

- `PORT` (default: `3080`)
- `BASE_URL` (optional public base URL, e.g. `https://cors.hibbit.cloud`)
- `STATS_MAX_ENTRIES` (default: `5000`, set `0` to disable stats)
- `STATS_IGNORE` (optional comma-separated extra substrings to ignore in stats)
- `STATS_FILE` (default: `/app/data/stats.json` in Docker Compose)
- `STATS_IGNORE_FILE` (default: `/app/data/ignorelist.txt` in Docker Compose)

## Persistent stats file in Docker

The provided `docker-compose.yml` mounts:

- `./data:/app/data`

This keeps `stats.json` on your host machine so stats survive container restarts and rebuilds.

Default ignore list file:

- `data/ignorelist.txt`

Enviroment variable via `docker-compose.yml` (optional):

- `STATS_IGNORE=favicon.ico,apple-touch-icon.png,robots.txt`

So ignore rules come from both:

- `data/ignorelist.txt`
- `STATS_IGNORE` (extra patterns from environment)

## URL endpoints

### 1) Simple and modern frontend:
- enter a target URL,
- fetch through proxy,
- view status/headers/body preview,
- copy the full proxy URL.

### 2) Proxy endpoint

Use path-style proxying:

- `GET /<host>/<path>` (defaults to `https`)
- `GET /https/<host>/<path>`
- `GET /http/<host>/<path>`

Examples:

- Target: `https://feeds.nos.nl/nosnieuwsalgemeen`  
  Proxy: `http://localhost:3080/feeds.nos.nl/nosnieuwsalgemeen`

- Target: `http://example.com/page`  
  Proxy: `http://localhost:3080/http/example.com/page`

Query strings are forwarded automatically.

### 3) Browser test endpoint

- `GET /?test=<host/path>`
- Optional: `&format=json`

Example:
- `http://localhost:3080/?test=feeds.nos.nl/nosnieuwsalgemeen`

Returns test diagnostics such as:
- status,
- CORS presence,
- feed/XML detection,
- response length,
- first 600 characters.

### 4) Statistics endpoint

- `GET /stats`
- `GET /?stats`
- Optional: `?format=json`

Shows:
- total stored requests,
- recent requests,
- counts by country,
- counts by OS,
- top target URLs.