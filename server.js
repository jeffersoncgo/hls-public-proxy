'use strict';

const express = require('express');
const { URL } = require('url');
const path = require('path');
const { Readable } = require('stream');
const { LRUCache } = require('lru-cache');
const nodeFetch = require('node-fetch');

const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch : nodeFetch;

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL || '64', 10);
const DEFAULT_REFERER = process.env.DEFAULT_REFERER || 'https://example.com/';
const PROXY_BASE = process.env.PROXY_BASE || '';
const ENABLE_FLARESOLVERR = process.env.ENABLE_FLARESOLVERR === '1';
const FLARESOLVERR = process.env.FLARESOLVERR || 'http://flaresolverr:8191';
const SEGMENT_CACHE_MAX = parseInt(process.env.SEGMENT_CACHE_MAX || '500', 10);
const SEGMENT_CACHE_TTL_MS = parseInt(process.env.SEGMENT_CACHE_TTL_MS || '90000', 10);
const MANIFEST_CACHE_MAX = parseInt(process.env.MANIFEST_CACHE_MAX || '200', 10);
const MANIFEST_CACHE_TTL_MS = parseInt(process.env.MANIFEST_CACHE_TTL_MS || '4000', 10);
const SEGMENT_CACHE_MAX_BYTES = parseInt(process.env.SEGMENT_CACHE_MAX_BYTES || '2000000', 10);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const segmentCache = new LRUCache({
  max: SEGMENT_CACHE_MAX,
  ttl: SEGMENT_CACHE_TTL_MS,
  allowStale: false,
});

const manifestCache = new LRUCache({
  max: MANIFEST_CACHE_MAX,
  ttl: MANIFEST_CACHE_TTL_MS,
  allowStale: false,
});

const flareCache = new LRUCache({
  max: 50,
  ttl: 2 * 60_000,
  allowStale: false,
});

let activeCount = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchLimited(url, opts = {}) {
  while (activeCount >= MAX_PARALLEL) {
    await delay(15);
  }
  activeCount += 1;
  try {
    return await fetchFn(url, { ...opts, redirect: 'follow' });
  } finally {
    activeCount -= 1;
  }
}

function browserHeaders(referer) {
  const ref = referer || DEFAULT_REFERER;
  let origin = ref;
  try {
    origin = new URL(ref).origin;
  } catch {}

  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': ref,
    'Origin': origin,
    'Connection': 'keep-alive',
  };
}

async function getFlareCookies(targetUrl, referer) {
  if (!ENABLE_FLARESOLVERR) return '';

  const cacheKey = `${referer || ''}|${targetUrl}`;
  const cached = flareCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const res = await fetchFn(`${FLARESOLVERR.replace(/\/$/, '')}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.get',
        url: referer || targetUrl,
        maxTimeout: 60000,
      }),
    });

    if (!res.ok) {
      flareCache.set(cacheKey, '');
      return '';
    }

    const json = await res.json().catch(() => null);
    const cookies = json?.solution?.cookies || json?.cookies || [];

    const cookieStr = Array.isArray(cookies)
      ? cookies
          .map(c => (typeof c === 'string' ? c.split(';')[0] : c?.name && c?.value ? `${c.name}=${c.value}` : ''))
          .filter(Boolean)
          .join('; ')
      : '';

    flareCache.set(cacheKey, cookieStr);
    return cookieStr;
  } catch {
    flareCache.set(cacheKey, '');
    return '';
  }
}

function decodeUrl(req) {
  if (req.query.url) {
    try {
      return decodeURIComponent(req.query.url);
    } catch {
      return req.query.url;
    }
  }

  if (req.query.u) {
    try {
      return Buffer.from(req.query.u, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  return null;
}

function decodeKnownOrigins(req, fallbackUrl) {
  let list = req.query.known_origins
    ? (Array.isArray(req.query.known_origins) ? req.query.known_origins : [req.query.known_origins])
    : [];

  list = list
    .map(item => {
      try {
        return decodeURIComponent(item);
      } catch {
        return item;
      }
    })
    .filter(Boolean);

  if (list.length === 0 && fallbackUrl) {
    try {
      list = [new URL(fallbackUrl).origin];
    } catch {}
  }

  return list;
}

function decodePreferredReferer(req, fallbackUrl) {
  if (req.query.preferred_referer) {
    try {
      return decodeURIComponent(req.query.preferred_referer);
    } catch {
      return req.query.preferred_referer;
    }
  }

  if (fallbackUrl) {
    try {
      return `${new URL(fallbackUrl).origin}/`;
    } catch {}
  }

  return DEFAULT_REFERER;
}

function toNodeStream(body) {
  if (!body) return null;
  if (typeof body.pipe === 'function') return body;
  if (typeof Readable?.fromWeb === 'function') {
    try {
      return Readable.fromWeb(body);
    } catch {}
  }
  return null;
}

function proxyOriginFromReq(req) {
  if (PROXY_BASE) return PROXY_BASE.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`.replace(/\/$/, '');
}

function rewriteManifest(text, baseUrl, proxyOrigin, knownOrigins, prefReferer) {
  const base = new URL(baseUrl);
  const encOrigins = (knownOrigins || [])
    .map(origin => `known_origins=${encodeURIComponent(origin)}`)
    .join('&');
  const encRef = prefReferer ? `preferred_referer=${encodeURIComponent(prefReferer)}` : '';
  const common = [encOrigins, encRef].filter(Boolean).join('&');
  const suffix = common ? `&${common}` : '';

  return text
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return trimmed;
      if (trimmed.includes('/proxy/manifest?') || trimmed.includes('/proxy/segment?')) return trimmed;

      let absoluteUrl;
      try {
        absoluteUrl = new URL(trimmed, base).href;
      } catch {
        return trimmed;
      }

      const lower = absoluteUrl.split('?')[0].toLowerCase();

      if (lower.endsWith('.m3u8') || lower.endsWith('.m3u') || lower.endsWith('.txt')) {
        return `${proxyOrigin}/proxy/manifest?url=${encodeURIComponent(absoluteUrl)}${suffix}`;
      }

      if (
        lower.endsWith('.ts') ||
        lower.endsWith('.m4s') ||
        lower.endsWith('.mp4') ||
        lower.endsWith('.mp2t') ||
        lower.endsWith('.aac') ||
        lower.endsWith('.mp3') ||
        lower.endsWith('.vtt') ||
        lower.endsWith('.webvtt') ||
        lower.endsWith('.key') ||
        lower.endsWith('.m4a')
      ) {
        return `${proxyOrigin}/proxy/segment?url=${encodeURIComponent(absoluteUrl)}${suffix}`;
      }

      return `${proxyOrigin}/proxy/segment?url=${encodeURIComponent(absoluteUrl)}${suffix}`;
    })
    .join('\n');
}

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Cache-Control, ETag, Last-Modified, X-Proxy-Cache, X-Detected-As');
  res.set('Timing-Allow-Origin', '*');
}

function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    activeRequests: activeCount,
    manifestCacheEntries: manifestCache.size,
    segmentCacheEntries: segmentCache.size,
  });
});

app.get('/proxy/manifest', async (req, res) => {
  const url = decodeUrl(req);
  if (!url || !isSafeHttpUrl(url)) {
    return res.status(400).send('Parâmetro ?url= ou ?u= (base64) com http/https é obrigatório.');
  }

  const knownOrigins = decodeKnownOrigins(req, url);
  const prefReferer = decodePreferredReferer(req, url);
  const cacheKey = `${url}|${prefReferer}`;
  const cached = manifestCache.get(cacheKey);

  if (cached) {
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store');
    res.set('X-Proxy-Cache', 'HIT');
    return res.send(cached);
  }

  try {
    const headers = browserHeaders(prefReferer);
    const cookies = await getFlareCookies(url, prefReferer);
    if (cookies) headers.Cookie = cookies;

    const upstream = await fetchLimited(url, { method: 'GET', headers });
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream returned ${upstream.status} for ${url}`);
    }

    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || '';
    const looksLikeHls = text.trimStart().startsWith('#EXTM3U') || text.includes('#EXT-X-');
    const urlLower = url.split('?')[0].toLowerCase();
    const isHlsExt = urlLower.endsWith('.m3u8') || urlLower.endsWith('.m3u') || urlLower.endsWith('.txt');

    if (!looksLikeHls && !isHlsExt && !/mpegurl|m3u/i.test(contentType)) {
      return res.status(400).send(`URL does not look like HLS manifest (content-type: ${contentType})`);
    }

    const rewritten = rewriteManifest(text, url, proxyOriginFromReq(req), knownOrigins, prefReferer);
    manifestCache.set(cacheKey, rewritten);

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store');
    res.set('X-Proxy-Cache', 'MISS');
    if (urlLower.endsWith('.txt')) res.set('X-Detected-As', 'hls-disguised-txt');
    return res.send(rewritten);
  } catch (error) {
    return res.status(502).send(`Error fetching manifest: ${error?.message || String(error)}`);
  }
});

app.get('/proxy/segment', async (req, res) => {
  const url = decodeUrl(req);
  if (!url || !isSafeHttpUrl(url)) {
    return res.status(400).send('Parâmetro ?url= ou ?u= (base64) com http/https é obrigatório.');
  }

  const knownOrigins = decodeKnownOrigins(req, url);
  const prefReferer = decodePreferredReferer(req, url);
  const cached = segmentCache.get(url);

  if (cached) {
    Object.entries(cached.headers).forEach(([key, value]) => {
      if (value) res.set(key, value);
    });
    res.set('X-Proxy-Cache', 'HIT');
    return res.status(200).send(cached.body);
  }

  const headers = browserHeaders(prefReferer);

  try {
    const parsed = new URL(url);
    const known = knownOrigins.some(origin => {
      try {
        const candidate = new URL(origin);
        return parsed.origin === candidate.origin || parsed.host === candidate.host;
      } catch {
        return false;
      }
    });

    if (known) {
      headers.Referer = prefReferer;
    }
  } catch {}

  if (req.headers.range) headers.Range = req.headers.range;

  try {
    const cookies = await getFlareCookies(url, prefReferer);
    if (cookies) headers.Cookie = cookies;

    const upstream = await fetchLimited(url, { method: 'GET', headers });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
    }

    const passthroughHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'etag',
      'last-modified',
      'content-disposition',
    ];

    upstream.headers.forEach((value, key) => {
      if (passthroughHeaders.includes(key.toLowerCase())) {
        res.set(key, value);
      }
    });

    res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.set('X-Proxy-Cache', 'MISS');

    const contentLength = parseInt(upstream.headers.get('content-length') || '0', 10);
    if (upstream.ok && contentLength > 0 && contentLength <= SEGMENT_CACHE_MAX_BYTES) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      const cacheHeaders = {};
      passthroughHeaders.forEach(key => {
        const value = upstream.headers.get(key);
        if (value) cacheHeaders[key] = value;
      });
      segmentCache.set(url, { body: buf, headers: cacheHeaders });
      return res.status(upstream.status).send(buf);
    }

    const nodeBody = toNodeStream(upstream.body);
    if (!nodeBody) {
      return res.status(502).send('Could not stream upstream segment body.');
    }

    res.status(upstream.status);
    nodeBody.pipe(res);

    nodeBody.on('error', () => {
      res.end();
    });

    req.on('close', () => {
      if (typeof nodeBody.destroy === 'function') nodeBody.destroy();
    });
  } catch (error) {
    return res.status(502).send(`Error fetching segment: ${error?.message || String(error)}`);
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`HLS public proxy listening on ${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
