const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

let ip3country = null;
try {
  ip3country = require('ip3country');
  ip3country.init();
} catch {
  // optional: stats will show country as null if not installed
}

const PORT = process.env.PORT || 3080;
const BASE_URL = process.env.BASE_URL || process.env.PROXY_PUBLIC_URL || '';
const STATS_MAX_ENTRIES = Math.max(0, parseInt(process.env.STATS_MAX_ENTRIES || '5000', 10));
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'data', 'stats.json');
const STATS_IGNORE_FILE = process.env.STATS_IGNORE_FILE || path.join(path.dirname(STATS_FILE), 'ignorelist.txt');

function parseIgnoreList(text) {
  return String(text || '')
    .split(/\r?\n|,/)
    .map((s) => s.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#'));
}

function loadIgnoreListFromFile() {
  try {
    if (!fs.existsSync(STATS_IGNORE_FILE)) return [];
    const raw = fs.readFileSync(STATS_IGNORE_FILE, 'utf8');
    return parseIgnoreList(raw);
  } catch {
    return [];
  }
}

/** URL (or path) substrings to not record in stats. Loaded from ignorelist.txt + STATS_IGNORE env. */
const configuredIgnoreList = [...new Set([...loadIgnoreListFromFile(), ...parseIgnoreList(process.env.STATS_IGNORE)])];
const STATS_IGNORE = configuredIgnoreList.length > 0 ? configuredIgnoreList : ['favicon.ico'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function loadStatsFromFile() {
  try {
    if (!fs.existsSync(STATS_FILE)) return [];
    const raw = fs.readFileSync(STATS_FILE, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveStatsToFile(entries) {
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(entries, null, 2), 'utf8');
  } catch {
    // keep API responsive even when file writing fails
  }
}

let statsEntries = loadStatsFromFile();
if (STATS_MAX_ENTRIES > 0 && statsEntries.length > STATS_MAX_ENTRIES) {
  statsEntries = statsEntries.slice(-STATS_MAX_ENTRIES);
  saveStatsToFile(statsEntries);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = forwarded.split(',')[0];
    if (first) return first.trim();
  }
  return req.socket?.remoteAddress ?? '';
}

function getCountry(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1') return null;
  if (!ip3country) return null;
  return ip3country.lookupStr(ip) ?? null;
}

function parseOS(ua) {
  if (!ua || typeof ua !== 'string') return null;
  const s = ua.toLowerCase();
  if (s.includes('windows')) return 'Windows';
  if (s.includes('mac os') || s.includes('macintosh')) return 'macOS';
  if (s.includes('linux') && !s.includes('android')) return 'Linux';
  if (s.includes('android')) return 'Android';
  if (s.includes('iphone') || s.includes('ipad')) return 'iOS';
  if (s.includes('cros')) return 'Chrome OS';
  return null;
}

function recordStats(req, url, targetUrl) {
  if (STATS_MAX_ENTRIES <= 0) return;
  const u = (url || '').toLowerCase();
  const t = (targetUrl || '').toLowerCase();
  if (STATS_IGNORE.some((pattern) => u.includes(pattern) || t.includes(pattern))) return;
  const ip = getClientIp(req);
  const entry = {
    at: new Date().toISOString(),
    url: url || targetUrl || req.url || '',
    targetUrl: targetUrl || null,
    ip,
    country: getCountry(ip),
    os: parseOS(req.headers['user-agent']),
  };
  statsEntries.push(entry);
  if (statsEntries.length > STATS_MAX_ENTRIES) statsEntries.shift();
  saveStatsToFile(statsEntries);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function looksLikeHost(segment) {
  return segment && segment.includes('.');
}

function baseHostFromReferer(referer, proxyOrigin) {
  if (!referer || !proxyOrigin) return null;
  try {
    const ref = new URL(referer);
    const origin = new URL(proxyOrigin);
    if (ref.hostname !== origin.hostname) return null;
    const path = ref.pathname.startsWith('/') ? ref.pathname.slice(1) : ref.pathname;
    const first = path.split('/').filter(Boolean)[0];
    return looksLikeHost(first) ? first : null;
  } catch {
    return null;
  }
}

function parseTargetUrl(pathname, search, referer, proxyOrigin) {
  const path = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const query = search || '';
  const parts = path.split('/').filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  let protocol = 'https';
  let rest = path;

  const hasProtocolPrefix = parts[0] === 'https' || parts[0] === 'http';
  if (hasProtocolPrefix) {
    protocol = parts[0];
    rest = parts.slice(1).join('/');
  }

  // Relative path (no host in first segment) and Referer present → base host from Referer
  if (!hasProtocolPrefix && rest && !looksLikeHost(parts[0])) {
    const base = baseHostFromReferer(referer, proxyOrigin);
    if (base) {
      rest = base + '/' + rest;
    }
  }

  if (!rest) return null;

  return `${protocol}://${rest}${query}`;
}

function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const lib = targetUrl.startsWith('https') ? https : http;
    const req = lib.get(targetUrl, { timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function forwardContentType(headers) {
  const ct = headers['content-type'];
  if (ct) return { 'Content-Type': ct };
  return {};
}

function servePublicFile(res, fileName, contentType) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS_HEADERS });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { ...CORS_HEADERS });
    res.end(JSON.stringify({ error: 'Only GET and OPTIONS allowed' }));
    return;
  }

  const host = req.headers.host || `localhost:${PORT}`;
  const proxyOrigin = BASE_URL ? BASE_URL.replace(/\/$/, '') : `http://${host}`;
  const url = new URL(req.url || '/', proxyOrigin);
  const referer = req.headers.referer || req.headers.referrer;

  if ((url.pathname === '/' || url.pathname === '/ui') && url.search === '') {
    servePublicFile(res, 'index.html', 'text/html; charset=utf-8');
    return;
  }

  if (url.pathname === '/ui/styles.css') {
    servePublicFile(res, 'styles.css', 'text/css; charset=utf-8');
    return;
  }

  if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
    servePublicFile(res, 'favicon.svg', 'image/svg+xml');
    return;
  }

  // Stats endpoint: /stats or /?stats (JSON or HTML)
  if (url.pathname === '/stats' || url.searchParams.has('stats')) {
    const wantsJson = url.searchParams.get('format') === 'json' || req.headers.accept?.includes('application/json');
    const total = statsEntries.length;
    const byCountry = {};
    const byOs = {};
    const byUrl = {};
    for (const e of statsEntries) {
      byCountry[e.country ?? '(unknown)'] = (byCountry[e.country ?? '(unknown)'] || 0) + 1;
      byOs[e.os ?? '(unknown)'] = (byOs[e.os ?? '(unknown)'] || 0) + 1;
      const u = e.targetUrl || e.url;
      byUrl[u] = (byUrl[u] || 0) + 1;
    }
    const payload = {
      total,
      recent: statsEntries.slice(-100).reverse(),
      byCountry: Object.entries(byCountry).sort((a, b) => b[1] - a[1]),
      byOs: Object.entries(byOs).sort((a, b) => b[1] - a[1]),
      byUrl: Object.entries(byUrl)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50),
    };
    if (wantsJson) {
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }
    const rows = payload.recent
      .map(
        (e) =>
          `<tr><td>${escapeHtml(e.at)}</td><td>${escapeHtml(e.targetUrl || e.url)}</td><td>${escapeHtml(e.ip)}</td><td>${escapeHtml(e.country ?? '')}</td><td>${escapeHtml(e.os ?? '')}</td></tr>`
      )
      .join('');
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Proxy stats</title>
<style>body{font-family:system-ui,sans-serif;max-width:56rem;margin:2rem auto;padding:0 1rem;} table{width:100%;border-collapse:collapse;} th,td{border:1px solid #ccc;padding:0.35rem 0.5rem;text-align:left;} th{background:#f0f0f0;} pre{overflow:auto;background:#f5f5f5;padding:0.75rem;} h2{margin-top:1.5rem;}</style>
</head>
<body>
  <h1>Proxy statistics</h1>
  <p><strong>Total stored requests:</strong> ${total}</p>
  <h2>By country</h2>
  <pre>${JSON.stringify(Object.fromEntries(payload.byCountry), null, 2)}</pre>
  <h2>By OS</h2>
  <pre>${JSON.stringify(Object.fromEntries(payload.byOs), null, 2)}</pre>
  <h2>Top URLs</h2>
  <pre>${JSON.stringify(Object.fromEntries(payload.byUrl), null, 2)}</pre>
  <h2>Recent requests (when, url, ip, country, OS)</h2>
  <table><thead><tr><th>Time</th><th>URL</th><th>IP</th><th>Country</th><th>OS</th></tr></thead><tbody>${rows}</tbody></table>
  <p><a href="${escapeHtml(proxyOrigin + '/stats?format=json')}">View as JSON</a></p>
</body>
</html>`;
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Test URL: /?test=feeds.nos.nl/nosnieuwsalgemeen — run proxy checks and show result in browser
  const testPath = url.searchParams.get('test');
  if (url.searchParams.has('test') && (!testPath || testPath.trim() === '')) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Empty test value. Use ?test=host/path',
        example: `${proxyOrigin}/?test=feeds.nos.nl/nosnieuwsalgemeen`,
      })
    );
    return;
  }

  if (testPath != null && testPath.trim() !== '') {
    const raw = testPath.trim();
    const targetTestUrl = raw.includes('://') ? raw : `https://${raw}`;
    try {
      const { status, headers, body } = await fetchUrl(targetTestUrl);
      const text = body.toString();
      const hasCors = true; // proxy adds CORS headers
      const isXml = text.includes('<?xml') || text.includes('<rss');
      const preview = text.slice(0, 600).replace(/\n/g, ' ');
      const result = {
        proxy: proxyOrigin,
        getViaProxy: `${proxyOrigin}/${raw}`,
        targetUrl: targetTestUrl,
        status,
        corsHeaderPresent: hasCors,
        looksLikeFeedXml: isXml,
        responseLength: text.length,
        first600Chars: preview,
        success: status >= 200 && status < 300,
      };
      const wantsJson = url.searchParams.get('format') === 'json' || req.headers.accept?.includes('application/json');
      if (wantsJson) {
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
        return;
      }
      const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>CORS proxy test</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;} pre{overflow:auto;background:#f5f5f5;padding:0.75rem;} .ok{color:green;} .fail{color:#c00;}</style>
</head>
<body>
  <h1>CORS proxy test</h1>
  <p><strong>Proxy:</strong> ${escapeHtml(result.proxy)}</p>
  <p><strong>Fetched via proxy:</strong> <a href="${escapeHtml(result.getViaProxy)}">${escapeHtml(result.getViaProxy)}</a></p>
  <p><strong>Target URL:</strong> ${escapeHtml(result.targetUrl)}</p>
  <hr>
  <p><strong>Status:</strong> ${result.status}</p>
  <p><strong>CORS header present:</strong> ${result.corsHeaderPresent ? 'yes' : 'no'}</p>
  <p><strong>Looks like feed/XML:</strong> ${result.looksLikeFeedXml ? 'yes' : 'no'}</p>
  <p><strong>Response length:</strong> ${result.responseLength} bytes</p>
  <p><strong>First 600 characters:</strong></p>
  <pre>${escapeHtml(result.first600Chars)}</pre>
  <p class="${result.success ? 'ok' : 'fail'}">${result.success ? 'Test passed.' : 'Test failed (non-2xx).'}</p>
  <p><a href="${escapeHtml(proxyOrigin + '/?test=' + encodeURIComponent(raw))}">Test again</a> · <a href="${escapeHtml(proxyOrigin + '/?test=' + encodeURIComponent(raw) + '&format=json')}">JSON</a></p>
</body>
</html>`;
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (err) {
      const result = { error: err.message, targetUrl: targetTestUrl, success: false };
      const wantsJson = url.searchParams.get('format') === 'json' || req.headers.accept?.includes('application/json');
      if (wantsJson) {
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
        return;
      }
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Test error</title></head><body><h1>Test failed</h1><p>${escapeHtml(err.message)}</p><p><a href="${escapeHtml(proxyOrigin + '/')}">Back</a></p></body></html>`);
      return;
    }
  }

  const targetUrl = parseTargetUrl(url.pathname, url.search, referer, proxyOrigin);

  if (!targetUrl) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'No target URL. Use: /host/path or /https/host/path or /http/host/path',
        example: `${proxyOrigin}/feeds.nos.nl/nosnieuwsalgemeen`,
        test: `${proxyOrigin}/?test=feeds.nos.nl/nosnieuwsalgemeen`,
      })
    );
    return;
  }

  try {
    const { status, headers, body } = await fetchUrl(targetUrl);
    recordStats(req, url.pathname + url.search, targetUrl);
    res.writeHead(status, {
      ...CORS_HEADERS,
      ...forwardContentType(headers),
    });
    res.end(body);
  } catch (err) {
    recordStats(req, url.pathname + url.search, targetUrl);
    res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`CORS proxy: http://localhost:${PORT}`);
  console.log(`Example: http://localhost:${PORT}/feeds.nos.nl/nosnieuwsalgemeen`);
});
