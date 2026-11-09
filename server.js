'use strict';
/**
 * DIRA Foundation website server
 *  - serves the existing static website
 *  - renders the public Articles pages (/articles and /articles/<slug>)
 *  - provides the password-protected admin API used by /admin.html
 *
 * Requires Node.js 18 or newer, MongoDB, and Cloudinary.
 * Configuration comes from the .env file next to this file (see .env.example).
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const cloudinary = require('cloudinary').v2;

const IN_NETLIFY_FUNCTION = path.basename(__dirname).toLowerCase() === 'functions' &&
  path.basename(path.dirname(__dirname)).toLowerCase() === 'netlify';
const IS_NETLIFY = process.env.NETLIFY === 'true' || !!process.env.AWS_LAMBDA_FUNCTION_NAME || IN_NETLIFY_FUNCTION;
const ROOT = IS_NETLIFY
  ? (IN_NETLIFY_FUNCTION ? path.resolve(__dirname, '..', '..') : process.cwd())
  : __dirname;

/* ------------------------------------------------------------------ .env */
function loadEnv(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(path.join(ROOT, '.env'));

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SITE_URL = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_API_KEY = (process.env.CLOUDINARY_API_KEY || '').trim();
const CLOUDINARY_API_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const RESEND_FROM_EMAIL = (process.env.RESEND_FROM_EMAIL || '').trim();
const VOLUNTEER_NOTIFICATION_EMAIL = 'diradigitalera@gmail.com';
const FAPSHI_API_USER = (process.env.FAPSHI_API_USER || '').trim();
const FAPSHI_API_KEY = (process.env.FAPSHI_API_KEY || '').trim();
const FAPSHI_ENVIRONMENT = (process.env.FAPSHI_ENVIRONMENT || 'sandbox').trim().toLowerCase();
const FAPSHI_BASE_URLS = {
  sandbox: 'https://sandbox.fapshi.com',
  live: 'https://live.fapshi.com'
};
const SESSION_HOURS = parseFloat(process.env.SESSION_HOURS) || 12;
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const FORCE_SECURE = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
const PLACEHOLDER_PASSWORD = 'change-me-to-a-strong-password';
const CREDS_OK = !!ADMIN_EMAIL && ADMIN_PASSWORD.length >= 8 && ADMIN_PASSWORD !== PLACEHOLDER_PASSWORD;

let SECRET = process.env.SESSION_SECRET || '';
if (SECRET.length < 16) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] SESSION_SECRET is missing or too short. Using a temporary one: admin sessions will end when the server restarts.');
}
if (!CREDS_OK) {
  console.warn('[warn] Admin login is DISABLED. Set ADMIN_EMAIL and a password of at least 8 characters in .env (not the example value).');
}

/* ------------------------------------------------------------------ storage */
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'articles.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
if (!IS_NETLIFY) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
let mongoClient;
let articleCollection;
let volunteerFormCollection;
let volunteerSubmissionCollection;
let volunteerFileCollection;

const IMG_RE = /^\/uploads\/[a-f0-9]{24}\.(jpg|png|webp)$/;
const ARTICLE_IMAGE_RE = /^!\[([^\]\r\n]*)\]\(([^)\s]+)\)$/gm;

function cloudinaryPublicId(imageUrl) {
  if (!CLOUDINARY_CLOUD_NAME || typeof imageUrl !== 'string') return '';
  let url;
  try { url = new URL(imageUrl); } catch (e) { return ''; }
  if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || url.username || url.password || url.search || url.hash) return '';
  const match = new RegExp('^/' + CLOUDINARY_CLOUD_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '/image/upload/v\\d+/(dira-articles/[a-f0-9]{24})\\.(?:jpg|png|webp)$').exec(url.pathname);
  return match ? match[1] : '';
}

function ensureCloudinaryConfigured() {
  const missing = [];
  if (!CLOUDINARY_CLOUD_NAME) missing.push('CLOUDINARY_CLOUD_NAME');
  if (!CLOUDINARY_API_KEY) missing.push('CLOUDINARY_API_KEY');
  if (!CLOUDINARY_API_SECRET) missing.push('CLOUDINARY_API_SECRET');
  if (missing.length) {
    throw Object.assign(new Error('Image uploads require Cloudinary configuration: ' + missing.join(', ')), { status: 503 });
  }
}

function isArticleImage(imageUrl) {
  if (IMG_RE.test(imageUrl)) return fs.existsSync(path.join(UPLOAD_DIR, path.basename(imageUrl)));
  return !!cloudinaryPublicId(imageUrl);
}

function articleImageRefs(article) {
  const refs = new Set(article.coverImage ? [article.coverImage] : []);
  for (const match of String(article.body || '').matchAll(ARTICLE_IMAGE_RE)) refs.add(match[2]);
  return refs;
}

async function removeUnusedImages(candidates) {
  const used = new Set();
  for await (const article of articleCollection.find({}, { projection: { coverImage: 1, body: 1 } })) {
    for (const image of articleImageRefs(article)) used.add(image);
  }
  for (const image of candidates) {
    if (used.has(image)) continue;
    const publicId = cloudinaryPublicId(image);
    if (publicId) {
      ensureCloudinaryConfigured();
      const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
      if (result.result !== 'ok' && result.result !== 'not found') throw new Error('Cloudinary could not remove an unused image.');
    } else if (IMG_RE.test(image)) {
      try { await fsp.unlink(path.join(UPLOAD_DIR, path.basename(image))); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
}

async function importLegacyArticles() {
  if (!fs.existsSync(DATA_FILE) || await articleCollection.countDocuments() > 0) return;
  let legacyArticles;
  try {
    legacyArticles = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
  } catch (e) {
    throw new Error('Could not read data/articles.json for migration: ' + e.message);
  }
  if (!Array.isArray(legacyArticles)) throw new Error('data/articles.json must contain a JSON array.');
  if (legacyArticles.length) {
    await articleCollection.insertMany(legacyArticles, { ordered: true });
    console.log('[info] Imported ' + legacyArticles.length + ' legacy article(s) into MongoDB.');
  }
}

async function cleanLocalOrphans() {
  if (IS_NETLIFY) return;
  const used = new Set();
  for await (const article of articleCollection.find({}, { projection: { coverImage: 1, body: 1 } })) {
    for (const image of articleImageRefs(article)) if (IMG_RE.test(image)) used.add(path.basename(image));
  }
  for (const file of await fsp.readdir(UPLOAD_DIR)) {
    if (file.startsWith('.') || used.has(file)) continue;
    const stat = await fsp.stat(path.join(UPLOAD_DIR, file));
    if (Date.now() - stat.mtimeMs > 24 * 3600 * 1000) await fsp.unlink(path.join(UPLOAD_DIR, file));
  }
}

/* ------------------------------------------------------------------ helpers */
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function slugify(t) {
  const s = String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return s || 'article';
}
async function uniqueSlug(title, ignoreId) {
  const base = slugify(title);
  let slug = base, n = 2;
  while (await articleCollection.findOne({ slug, ...(ignoreId ? { id: { $ne: ignoreId } } : {}) }, { projection: { _id: 1 } })) {
    slug = base + '-' + n++;
  }
  return slug;
}

function inline(text) {
  let s = esc(text);
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|\/)[^\s)]*)\)/g, (m, label, url) => {
    const ext = /^https?:/.test(url);
    return '<a href="' + url + '"' + (ext ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + label + '</a>';
  });
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

function renderBody(body) {
  const blocks = String(body).replace(/\r\n/g, '\n').split(/\n{2,}/);
  const out = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const lines = block.split('\n');
    const image = /^!\[([^\]\r\n]*)\]\(([^)\s]+)\)$/.exec(block);
    if (image && isArticleImage(image[2])) out.push('<figure class="art-inline-figure"><img class="art-inline-image" src="' + esc(image[2]) + '" alt="' + esc(image[1]) + '" loading="lazy"></figure>');
    else if (/^###\s+/.test(block) && lines.length === 1) out.push('<h3>' + inline(block.replace(/^###\s+/, '')) + '</h3>');
    else if (/^##\s+/.test(block) && lines.length === 1) out.push('<h2>' + inline(block.replace(/^##\s+/, '')) + '</h2>');
    else if (lines.every(l => /^[-*]\s+/.test(l))) out.push('<ul>' + lines.map(l => '<li>' + inline(l.replace(/^[-*]\s+/, '')) + '</li>').join('') + '</ul>');
    else if (lines.every(l => /^\d+[.)]\s+/.test(l))) out.push('<ol>' + lines.map(l => '<li>' + inline(l.replace(/^\d+[.)]\s+/, '')) + '</li>').join('') + '</ol>');
    else if (lines.every(l => /^>\s?/.test(l))) out.push('<blockquote>' + lines.map(l => inline(l.replace(/^>\s?/, ''))).join('<br>') + '</blockquote>');
    else out.push('<p>' + lines.map(inline).join('<br>') + '</p>');
  }
  return out.join('\n');
}

function plainText(body) {
  return String(body).replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*>_`]/g, '').replace(/^\s*[-\d.)]+\s+/gm, '').replace(/\s+/g, ' ').trim();
}
function excerpt(a, n) {
  const s = (a.summary && a.summary.trim()) || plainText(a.body);
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '\u2026' : s;
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); }
  catch (e) { return ''; }
}

/* ------------------------------------------------------------------ auth */
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const b64 = b => Buffer.from(b).toString('base64url');
const credVersion = () => sha(ADMIN_EMAIL + '\n' + ADMIN_PASSWORD).toString('hex').slice(0, 16);

function fapshiConfig() {
  const baseUrl = FAPSHI_BASE_URLS[FAPSHI_ENVIRONMENT];
  if (!FAPSHI_API_USER || !FAPSHI_API_KEY || !baseUrl) {
    throw Object.assign(new Error('Online donations are not configured. Please use the direct transfer option.'), { status: 503 });
  }
  return { baseUrl, apiUser: FAPSHI_API_USER, apiKey: FAPSHI_API_KEY };
}

async function fapshiRequest(endpoint, options) {
  const config = fapshiConfig();
  let response;
  try {
    response = await fetch(config.baseUrl + endpoint, Object.assign({}, options, {
      headers: Object.assign({
        apiuser: config.apiUser,
        apikey: config.apiKey,
        'Content-Type': 'application/json'
      }, options.headers || {}),
      signal: AbortSignal.timeout(15000)
    }));
  } catch (error) {
    console.error('[error] Could not reach Fapshi:', error.message);
    throw Object.assign(new Error('The payment service is temporarily unavailable. Please try again.'), { status: 502 });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    console.error('[error] Fapshi returned an invalid response.');
    throw Object.assign(new Error('The payment service returned an invalid response. Please try again.'), { status: 502 });
  }
  if (!response.ok) {
    console.error('[warn] Fapshi returned HTTP ' + response.status + ': ' + String(payload.message || 'unknown error'));
    throw Object.assign(new Error('Fapshi could not process the request. Please check your details or try again later.'), { status: 502 });
  }
  return payload;
}

function donationReturnUrl(req) {
  const hostHeader = String(req.headers.host || '').trim();
  if (!hostHeader || /[\s/@\\?#]/.test(hostHeader)) {
    throw Object.assign(new Error('Could not determine the website address for the payment return.'), { status: 400 });
  }

  let site;
  try { site = new URL('https://' + hostHeader); } catch (error) {
    throw Object.assign(new Error('The website address for the payment return is invalid.'), { status: 400 });
  }
  if (!site.hostname || site.username || site.password || site.pathname !== '/' || site.search || site.hash) {
    throw Object.assign(new Error('The website address for the payment return is invalid.'), { status: 400 });
  }

  let protocol = req.socket.encrypted ? 'https:' : 'http:';
  const forwardedProto = (IS_NETLIFY || TRUST_PROXY) && req.headers['x-forwarded-proto']
    ? String(req.headers['x-forwarded-proto']).split(',')[0].trim().toLowerCase()
    : '';
  if (forwardedProto) {
    if (forwardedProto !== 'http' && forwardedProto !== 'https') {
      throw Object.assign(new Error('The website protocol for the payment return is invalid.'), { status: 400 });
    }
    protocol = forwardedProto + ':';
  } else if (IS_NETLIFY) {
    protocol = 'https:';
  }

  if (protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(site.hostname)) {
    throw Object.assign(new Error('Payment return URLs must use HTTPS outside localhost.'), { status: 400 });
  }
  site.protocol = protocol;
  return new URL('/involve.html?payment=return', site).toString();
}

function makePaymentStatusToken(transId) {
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  const signature = crypto.createHmac('sha256', FAPSHI_API_KEY).update(transId + '\n' + expires).digest('base64url');
  return expires + '.' + signature;
}

function validPaymentStatusToken(transId, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !/^\d{13}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return false;
  const expires = Number(parts[0]);
  if (expires < Date.now() || expires > Date.now() + 24 * 60 * 60 * 1000 + 60 * 1000) return false;
  const expected = crypto.createHmac('sha256', FAPSHI_API_KEY).update(transId + '\n' + expires).digest('base64url');
  const actualBytes = Buffer.from(parts[1]);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function signToken() {
  const payload = b64(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600 * 1000, v: credVersion() }));
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function getCookie(req, name) {
  const c = req.headers.cookie || '';
  for (const part of c.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function isAdmin(req) {
  if (!CREDS_OK) return false;
  const tok = getCookie(req, 'dira_admin');
  const dot = tok.indexOf('.');
  if (dot < 1) return false;
  const payload = tok.slice(0, dot), sig = tok.slice(dot + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return d.exp > Date.now() && d.v === credVersion();
  } catch (e) { return false; }
}
function isSecure(req) {
  return FORCE_SECURE || IS_NETLIFY || !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
}
function setSession(req, res, token, maxAgeSec) {
  res.setHeader('Set-Cookie', 'dira_admin=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSec + (isSecure(req) ? '; Secure' : ''));
}
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
const attempts = new Map();
const MAX_FAILS = 5, WINDOW_MS = 15 * 60 * 1000;
function blocked(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW_MS) { attempts.delete(ip); return false; }
  return a.count >= MAX_FAILS;
}
function fail(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(ip, { count: 1, first: Date.now() });
  else a.count++;
}

/* ------------------------------------------------------------------ http utils */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json'
};
const BLOCKED_NAMES = new Set(['server.js', 'package.json', 'package-lock.json', 'readme.md', 'node_modules', 'data', '.env']);

function baseHeaders(extra) {
  return Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN'
  }, extra || {});
}
function send(res, status, body, headers) {
  res.writeHead(status, baseHeaders(headers));
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function readBody(req, limit) {
  return readBuffer(req, limit).then(buffer => buffer.toString('utf8'));
}
function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', c => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true; chunks.length = 0;
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        return; // keep draining (and discarding) so the client can receive our reply
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (e) { /* invalid */ }
    if (host !== req.headers.host) throw Object.assign(new Error('Cross-origin request refused'), { status: 403 });
  }
  const text = await readBody(req, limit);
  try { return JSON.parse(text || '{}'); } catch (e) { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
function verifySameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = '';
  try { host = new URL(origin).host; } catch (e) { /* rejected below */ }
  if (!host || host !== req.headers.host) throw Object.assign(new Error('Cross-origin request refused'), { status: 403 });
}
async function readMultipart(req, limit) {
  verifySameOrigin(req);
  const contentType = String(req.headers['content-type'] || '');
  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType) || !boundaryMatch) {
    throw Object.assign(new Error('Expected a multipart form submission.'), { status: 415 });
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2].trim();
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw Object.assign(new Error('Invalid multipart boundary.'), { status: 400 });
  }
  const body = await readBuffer(req, limit);
  const marker = Buffer.from('--' + boundary);
  const separator = Buffer.from('\r\n\r\n');
  const fields = new Map();
  const files = new Map();
  let cursor = 0;
  let closed = false;
  while (true) {
    const start = body.indexOf(marker, cursor);
    if (start < 0) break;
    let partStart = start + marker.length;
    if (body.slice(partStart, partStart + 2).toString() === '--') { closed = true; break; }
    if (body.slice(partStart, partStart + 2).toString() !== '\r\n') {
      throw Object.assign(new Error('Invalid multipart data.'), { status: 400 });
    }
    partStart += 2;
    const headerEnd = body.indexOf(separator, partStart);
    if (headerEnd < 0) throw Object.assign(new Error('Invalid multipart headers.'), { status: 400 });
    const headers = body.slice(partStart, headerEnd).toString('utf8');
    const disposition = /^content-disposition:\s*form-data;([^\r\n]*)/im.exec(headers);
    const nameMatch = disposition && /\bname="([^"]*)"/i.exec(disposition[1]);
    const filenameMatch = disposition && /\bfilename="([^"]*)"/i.exec(disposition[1]);
    if (!nameMatch || !nameMatch[1]) throw Object.assign(new Error('Invalid multipart field.'), { status: 400 });
    const name = nameMatch[1];
    if (fields.has(name) || files.has(name)) throw Object.assign(new Error('Duplicate multipart field.'), { status: 400 });
    const dataStart = headerEnd + separator.length;
    const partMarker = Buffer.concat([Buffer.from('\r\n'), marker]);
    let next = body.indexOf(partMarker, dataStart);
    while (next >= 0) {
      const suffix = body.slice(next + partMarker.length, next + partMarker.length + 2).toString();
      if (suffix === '--' || suffix === '\r\n') break;
      next = body.indexOf(partMarker, next + partMarker.length);
    }
    if (next < 0) throw Object.assign(new Error('Incomplete multipart field.'), { status: 400 });
    const value = body.slice(dataStart, next);
    if (filenameMatch) {
      const typeMatch = /^content-type:\s*([^\r\n]+)/im.exec(headers);
      files.set(name, {
        name: filenameMatch[1],
        type: typeMatch ? typeMatch[1].trim().toLowerCase() : 'application/octet-stream',
        data: value
      });
    } else {
      fields.set(name, value.toString('utf8'));
    }
    cursor = next + 2;
  }
  if (!closed) throw Object.assign(new Error('Incomplete multipart submission.'), { status: 400 });
  return { fields, files };
}

/* ------------------------------------------------------------------ templates */
const tplCache = new Map();
async function template(name) {
  const f = path.join(ROOT, name);
  const st = await fsp.stat(f);
  const c = tplCache.get(name);
  if (c && c.mtime === st.mtimeMs) return c.text;
  const text = await fsp.readFile(f, 'utf8');
  tplCache.set(name, { mtime: st.mtimeMs, text });
  return text;
}
const fill = (tpl, map) => tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (map[k] !== undefined ? map[k] : ''));

function publicSiteOrigin(req) {
  return SITE_URL ? new URL(SITE_URL).origin : getPublicSiteUrl(req);
}

function headMeta(o, siteOrigin) {
  const t = esc(o.title), d = esc(o.description);
  const pageUrl = new URL(o.path, siteOrigin).toString();
  const imageUrl = new URL(o.image || '/assets/logo.jpg', siteOrigin).toString();
  const imageAlt = esc(o.imageAlt || 'DIRA Foundation');
  let h = '<meta name="description" content="' + d + '">\n';
  h += '    <meta property="og:type" content="' + (o.article ? 'article' : 'website') + '">\n';
  h += '    <meta property="og:title" content="' + t + '">\n    <meta property="og:description" content="' + d + '">\n';
  h += '    <meta name="twitter:card" content="summary_large_image">\n';
  h += '    <meta name="twitter:title" content="' + t + '">\n    <meta name="twitter:description" content="' + d + '">\n';
  h += '    <link rel="canonical" href="' + esc(pageUrl) + '">\n';
  h += '    <meta property="og:url" content="' + esc(pageUrl) + '">\n';
  h += '    <meta property="og:image" content="' + esc(imageUrl) + '">\n';
  h += '    <meta property="og:image:secure_url" content="' + esc(imageUrl) + '">\n';
  h += '    <meta property="og:image:alt" content="' + imageAlt + '">\n';
  h += '    <meta name="twitter:image" content="' + esc(imageUrl) + '">\n';
  h += '    <meta name="twitter:image:alt" content="' + imageAlt + '">\n';
  h += '    <meta name="robots" content="' + (o.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large') + '">\n';
  return h;
}

/* ------------------------------------------------------------------ public pages */
const PER_PAGE = 9;

async function renderList(req, res, url) {
  const total = await articleCollection.countDocuments({ published: true });
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  let page = parseInt(url.searchParams.get('page'), 10);
  if (!(page >= 1)) page = 1;
  if (page > pages) page = pages;
  const slice = await articleCollection.find({ published: true }).sort({ publishedAt: -1 }).skip((page - 1) * PER_PAGE).limit(PER_PAGE).toArray();

  let list;
  if (!total) {
    list = '<div class="art-empty"><i class="fas fa-newspaper" aria-hidden="true"></i><h2>No articles yet</h2><p>New articles will appear here once they are published. Please check back soon.</p></div>';
  } else {
    list = '<div class="art-grid">' + slice.map(a => {
      const img = a.coverImage
        ? '<img class="art-card-img" src="' + esc(a.coverImage) + '" alt="' + esc(a.coverAlt || '') + '" loading="lazy">'
        : '<div class="art-card-placeholder" aria-hidden="true"><i class="fas fa-newspaper"></i></div>';
      return '<article class="art-card"><a class="art-card-media" href="/articles/' + esc(a.slug) + '" tabindex="-1" aria-hidden="true">' + img + '</a>' +
        '<div class="art-card-body"><p class="art-meta"><time datetime="' + esc(a.publishedAt) + '">' + esc(fmtDate(a.publishedAt)) + '</time> &middot; ' + esc(a.author) + '</p>' +
        '<h2 class="art-card-title"><a href="/articles/' + esc(a.slug) + '">' + esc(a.title) + '</a></h2>' +
        '<p class="art-summary">' + esc(excerpt(a, 160)) + '</p>' +
        '<a class="art-more" href="/articles/' + esc(a.slug) + '">Read article <i class="fas fa-arrow-right" aria-hidden="true"></i></a></div></article>';
    }).join('') + '</div>';
  }

  let pager = '';
  if (pages > 1) {
    pager = '<nav class="art-pager" aria-label="Articles pages">';
    if (page > 1) pager += '<a href="/articles?page=' + (page - 1) + '" rel="prev">&larr; Newer</a>';
    pager += '<span>Page ' + page + ' of ' + pages + '</span>';
    if (page < pages) pager += '<a href="/articles?page=' + (page + 1) + '" rel="next">Older &rarr;</a>';
    pager += '</nav>';
  }

  const title = 'Articles' + (page > 1 ? ' (page ' + page + ')' : '') + ' | DIRA Foundation';
  const description = 'News, updates and stories from DIRA Foundation, a non-profit association in Northwest Cameroon.';
  const siteOrigin = publicSiteOrigin(req);
  const html = fill(await template('articles.html'), {
    TITLE: esc(title),
    HEAD_META: headMeta({ title, description, path: '/articles' + (page > 1 ? '?page=' + page : '') }, siteOrigin),
    ARTICLE_LIST: list, PAGINATION: pager
  });
  send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
}

async function renderArticle(req, res, slug) {
  const a = await articleCollection.findOne({ slug });
  const preview = a && !a.published && isAdmin(req);
  if (!a || (!a.published && !preview)) return notFound(res);

  const title = a.title + ' | DIRA Foundation';
  const description = excerpt(a, 155);
  const siteOrigin = publicSiteOrigin(req);
  const ld = {
    '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description,
    datePublished: a.publishedAt || a.createdAt, dateModified: a.updatedAt || a.createdAt,
    author: a.author === 'DIRA Foundation' ? { '@type': 'Organization', name: 'DIRA Foundation' } : { '@type': 'Person', name: a.author },
    publisher: { '@type': 'Organization', name: 'DIRA Foundation' }
  };
  ld.mainEntityOfPage = siteOrigin + '/articles/' + a.slug;
  if (a.coverImage) ld.image = new URL(a.coverImage, siteOrigin).toString();
  const cover = a.coverImage
    ? '<img class="art-cover" src="' + esc(a.coverImage) + '" alt="' + esc(a.coverAlt || '') + '">' : '';
  const html = fill(await template('article.html'), {
    TITLE: esc(title),
    HEAD_META: headMeta({
      title,
      description,
      path: '/articles/' + a.slug,
      image: a.coverImage,
      imageAlt: a.coverAlt,
      article: true,
      noindex: preview
    }, siteOrigin) +
      (preview ? '' : '    <script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>\n'),
    ARTICLE_TITLE: esc(a.title),
    ARTICLE_META: '<time datetime="' + esc(a.publishedAt || a.createdAt) + '">' + esc(fmtDate(a.publishedAt || a.createdAt)) + '</time> &middot; ' + esc(a.author),
    ARTICLE_BANNER: preview ? '<p class="art-draft">Draft preview. This article is not published yet and only you can see it.</p>' : '',
    ARTICLE_COVER: cover,
    ARTICLE_BODY: renderBody(a.body)
  });
  send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
}

function getPublicSiteUrl(req) {
  if (SITE_URL) return new URL(SITE_URL).origin;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) throw new Error('Cannot determine the public site URL; set SITE_URL.');
  const protocol = isSecure(req) ? 'https:' : 'http:';
  return new URL(protocol + '//' + host).origin;
}

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  })[char]);
}

async function renderSitemap(req, res) {
  const baseUrl = getPublicSiteUrl(req);
  const pages = [
    '/',
    '/about.html',
    '/work.html',
    '/partner.html',
    '/involve.html',
    '/contact.html',
    '/startup-incubator.html',
    '/volunteer.html',
    '/terms-privacy.html',
    '/articles'
  ];
  const articles = await articleCollection.find({ published: true })
    .project({ _id: 0, slug: 1, updatedAt: 1, publishedAt: 1 })
    .toArray();
  const urls = pages.map(page => '<url><loc>' + xmlEscape(baseUrl + page) + '</loc></url>');
  for (const article of articles) {
    if (!/^[a-z0-9-]+$/.test(article.slug || '')) continue;
    const lastmod = article.updatedAt || article.publishedAt;
    const timestamp = lastmod && new Date(lastmod);
    const lastmodTag = timestamp && !Number.isNaN(timestamp.getTime())
      ? '<lastmod>' + timestamp.toISOString().slice(0, 10) + '</lastmod>'
      : '';
    urls.push('<url><loc>' + xmlEscape(baseUrl + '/articles/' + encodeURIComponent(article.slug)) + '</loc>' + lastmodTag + '</url>');
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(url => '  ' + url).join('\n') + '\n</urlset>\n';
  send(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
}

function renderRobots(req, res) {
  const baseUrl = getPublicSiteUrl(req);
  const text = 'User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /volunteer-admin.html\nDisallow: /api/\n\nSitemap: ' + baseUrl + '/sitemap.xml\n';
  send(res, 200, text, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
}

async function notFound(res) {
  try {
    const html = fill(await template('article.html'), {
      TITLE: 'Article not found | DIRA Foundation',
      HEAD_META: '<meta name="robots" content="noindex">\n',
      ARTICLE_TITLE: 'Article not found', ARTICLE_META: '', ARTICLE_BANNER: '', ARTICLE_COVER: '',
      ARTICLE_BODY: '<p>The article you are looking for does not exist or is no longer available.</p>'
    });
    send(res, 404, html, { 'Content-Type': MIME['.html'] });
  } catch (e) {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

/* ------------------------------------------------------------------ admin API */
function validateArticle(b, existing) {
  const title = String(b.title || '').trim();
  const body = String(b.body || '').replace(/\r\n/g, '\n').trim();
  const summary = String(b.summary || '').trim();
  const author = String(b.author || '').trim() || 'DIRA Foundation';
  const coverAlt = String(b.coverAlt || '').trim();
  let coverImage = String(b.coverImage || '').trim();
  const coverImagePublicId = cloudinaryPublicId(coverImage);
  if (title.length < 3 || title.length > 150) return { error: 'Title must be between 3 and 150 characters.' };
  if (!body) return { error: 'The article body cannot be empty.' };
  if (body.length > 60000) return { error: 'The article body is too long (60,000 characters maximum).' };
  if (summary.length > 300) return { error: 'The summary must be 300 characters or fewer.' };
  if (author.length > 80) return { error: 'The author name must be 80 characters or fewer.' };
  if (coverAlt.length > 200) return { error: 'The image description must be 200 characters or fewer.' };
  if (coverImage) {
    if (!isArticleImage(coverImage)) return { error: 'The header image is not valid. Please upload it again.' };
  }
  for (const match of body.matchAll(ARTICLE_IMAGE_RE)) {
    if (match[1].length > 200) return { error: 'Image descriptions in the article text must be 200 characters or fewer.' };
    if (!isArticleImage(match[2])) return { error: 'An image in the article text is not valid. Please upload it again.' };
  }
  return { value: { title, body, summary, author, coverAlt, coverImage, coverImagePublicId, published: !!b.published } };
}

const VOLUNTEER_TYPES = new Set([
  'short_text', 'long_text', 'email', 'phone', 'date',
  'single_choice', 'multi_choice', 'dropdown', 'file'
]);
function validateVolunteerForm(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'The volunteer form must be an object.' };
  const validText = (value, max, required) =>
    typeof value === 'string' && value.length <= max && (!required || !!value.trim());
  if (!validText(input.title, 120, true) ||
      !validText(input.subtitle || '', 160, false) ||
      !validText(input.intro || '', 5000, false) ||
      !validText(input.submitLabel || '', 80, false) ||
      !validText(input.notifyEmail || '', 254, false)) {
    return { error: 'Check the title, subtitle, introduction, submit label and notification email.' };
  }
  if (input.notifyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.notifyEmail)) {
    return { error: 'Enter a valid notification email address.' };
  }
  if (!Array.isArray(input.sections) || !input.sections.length || input.sections.length > 30 ||
      !Array.isArray(input.questions) || !input.questions.length || input.questions.length > 100) {
    return { error: 'The form needs between 1 and 30 sections and 1 and 100 questions.' };
  }
  const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
  const validId = value => idPattern.test(String(value || '')) &&
    !['__proto__', 'constructor', 'prototype'].includes(String(value));
  const sectionIds = new Set();
  const sections = [];
  for (const section of input.sections) {
    if (!section || typeof section !== 'object' || !validId(section.id) ||
        sectionIds.has(section.id) || !validText(section.title, 100, true) ||
        !validText(section.description || '', 200, false)) {
      return { error: 'A form section is invalid.' };
    }
    sectionIds.add(section.id);
    sections.push({ id: section.id, title: section.title, description: section.description || '' });
  }
  const questionIds = new Set();
  const questions = [];
  for (const question of input.questions) {
    if (!question || typeof question !== 'object' || !validId(question.id) ||
        questionIds.has(question.id) || !VOLUNTEER_TYPES.has(question.type) ||
        !sectionIds.has(question.sectionId) || !validText(question.label, 500, true)) {
      return { error: 'A form question is invalid.' };
    }
    questionIds.add(question.id);
    const q = { id: question.id, sectionId: question.sectionId, type: question.type, label: question.label, required: !!question.required };
    for (const key of ['helpText', 'placeholder']) {
      if (question[key] != null) {
        const max = key === 'helpText' ? 500 : 200;
        if (!validText(question[key], max, false)) return { error: 'Question ' + key + ' is invalid.' };
        q[key] = question[key];
      }
    }
    if (question.maxLength != null) {
      if (!Number.isInteger(question.maxLength) || question.maxLength < 1 || question.maxLength > 10000) return { error: 'A question character limit is invalid.' };
      q.maxLength = question.maxLength;
    }
    if (['name', 'email', 'phone'].includes(question.use)) q.use = question.use;
    if (['any', 'past', 'future'].includes(question.dateRule)) q.dateRule = question.dateRule;
    if (['single_choice', 'multi_choice', 'dropdown'].includes(question.type)) {
      if (!Array.isArray(question.options) || question.options.length > 100 ||
          question.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 200)) {
        return { error: 'The choices for a question are invalid.' };
      }
      q.options = question.options;
      if (question.allowOther) q.allowOther = true;
    }
    if (question.type === 'multi_choice' && question.proficiency) {
      if (!Array.isArray(question.levels) || !question.levels.length || question.levels.length > 20 ||
          question.levels.some(level => typeof level !== 'string' || !level.trim() || level.length > 80)) {
        return { error: 'The proficiency levels for a question are invalid.' };
      }
      q.proficiency = true;
      q.levels = question.levels;
    }
    if (question.type === 'file') {
      const allowed = ['.pdf', '.doc', '.docx', '.rtf'];
      if (!Array.isArray(question.accept) || !question.accept.length ||
          question.accept.some(ext => !allowed.includes(String(ext).toLowerCase()))) {
        return { error: 'The allowed file types for a question are invalid.' };
      }
      if (question.maxMB != null && (!Number.isFinite(question.maxMB) || question.maxMB < 1 || question.maxMB > 4)) {
        return { error: 'Volunteer file uploads cannot exceed 4 MB per file.' };
      }
      q.accept = question.accept.map(ext => String(ext).toLowerCase());
      q.maxMB = question.maxMB || 4;
    }
    questions.push(q);
  }
  return {
    value: {
      version: 1, title: input.title, subtitle: input.subtitle || '',
      intro: input.intro || '', submitLabel: input.submitLabel || 'Submit application',
      notifyEmail: input.notifyEmail || '', sections, questions
    }
  };
}
function safeVolunteerFilename(name) {
  return path.basename(String(name || '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f"]/g, '_').slice(0, 160) || 'volunteer-file';
}
function volunteerFileType(file) {
  const name = safeVolunteerFilename(file.name);
  const ext = path.extname(name).toLowerCase();
  const b = file.data;
  if (!b.length || b.length > 4 * 1024 * 1024) return null;
  if (ext === '.pdf' && b.slice(0, 5).toString() === '%PDF-') return { name, type: 'application/pdf' };
  if (ext === '.rtf' && /^\{\\rtf[0-9]/.test(b.slice(0, 16).toString('ascii'))) return { name, type: 'application/rtf' };
  if (ext === '.doc' && b.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return { name, type: 'application/msword' };
  }
  if (ext === '.docx' && b.length > 4 && b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return { name, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  return null;
}
function validateVolunteerSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !input.applicant || typeof input.applicant !== 'object' || Array.isArray(input.applicant) ||
      !Array.isArray(input.answers) || input.answers.length > 100) {
    return { error: 'The volunteer application is incomplete or invalid.' };
  }
  const applicant = {
    name: String(input.applicant.name || '').trim(),
    email: String(input.applicant.email || '').trim().toLowerCase(),
    phone: String(input.applicant.phone || '').trim()
  };
  if (!applicant.name || applicant.name.length > 120 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(applicant.email) || applicant.email.length > 254 ||
      applicant.phone.length > 30 || (applicant.phone && !/^[+0-9 ()\-]{6,30}$/.test(applicant.phone))) {
    return { error: 'Check the applicant name, email address and phone number.' };
  }
  const seen = new Set();
  const answers = [];
  for (const answer of input.answers) {
    if (!answer || typeof answer !== 'object' || !/^[A-Za-z0-9_-]{1,80}$/.test(String(answer.qid || '')) ||
        seen.has(answer.qid) || !VOLUNTEER_TYPES.has(answer.type) ||
        typeof answer.label !== 'string' || answer.label.length > 500 ||
        typeof answer.section !== 'string' || answer.section.length > 120) {
      return { error: 'An application answer is invalid.' };
    }
    seen.add(answer.qid);
    const value = answer.value == null ? '' : answer.value;
    if (['short_text', 'long_text', 'email', 'phone', 'date'].includes(answer.type) &&
        (typeof value !== 'string' || value.length > 10000)) return { error: 'An application answer is invalid or too long.' };
    if (['single_choice', 'dropdown'].includes(answer.type) &&
        (typeof value !== 'string' || value.length > 500)) return { error: 'A choice answer is invalid.' };
    if (answer.type === 'multi_choice' &&
        (!Array.isArray(value) || value.length > 100 || value.some(item =>
          !item || typeof item !== 'object' || typeof item.label !== 'string' || item.label.length > 300 ||
          (item.level != null && (typeof item.level !== 'string' || item.level.length > 80))))) {
      return { error: 'A multiple-choice answer is invalid.' };
    }
    if (answer.type === 'file' && value !== '' && value !== null &&
        (!value || typeof value !== 'object' || typeof value.name !== 'string' ||
          !Number.isInteger(value.size) || value.size < 0 || value.size > 4 * 1024 * 1024 ||
          typeof value.type !== 'string' || value.type.length > 150)) {
      return { error: 'A file answer is invalid.' };
    }
    if (JSON.stringify(value).length > 12000) return { error: 'An application answer is too long.' };
    answers.push({
      qid: answer.qid, label: answer.label, section: answer.section,
      type: answer.type, value
    });
  }
  return { value: { applicant, answers } };
}
function seenFileQuestion(answers, qid) {
  return answers.some(answer => answer.qid === qid && answer.type === 'file');
}
function validateSubmissionForForm(answers, form, uploadedFiles) {
  const submitted = new Map(answers.map(answer => [answer.qid, answer]));
  if (submitted.size !== form.questions.length) return 'The application does not match the current form.';
  for (const question of form.questions) {
    const answer = submitted.get(question.id);
    if (!answer || answer.type !== question.type || answer.label !== question.label) {
      return 'The application does not match the current form.';
    }
    const value = answer.value;
    if (question.required) {
      const empty = question.type === 'file'
        ? !uploadedFiles.has(question.id)
        : question.type === 'multi_choice'
          ? !Array.isArray(value) || !value.length
          : typeof value !== 'string' || !value.trim();
      if (empty) return 'Answer "' + question.label + '".';
    }
    if (['short_text', 'long_text', 'email', 'phone', 'date'].includes(question.type) && value) {
      const maxLength = question.maxLength || (question.type === 'long_text' ? 5000 : 300);
      if (value.length > maxLength) return 'The answer to "' + question.label + '" is too long.';
      if (question.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        return 'Enter a valid email address for "' + question.label + '".';
      }
      if (question.type === 'phone' && !/^[+0-9 ()\-]{6,30}$/.test(value)) {
        return 'Enter a valid phone number for "' + question.label + '".';
      }
      if (question.type === 'date' &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value)) ||
            (question.dateRule === 'past' && value > new Date().toISOString().slice(0, 10)) ||
            (question.dateRule === 'future' && value < new Date().toISOString().slice(0, 10)))) {
        return 'Enter a valid date for "' + question.label + '".';
      }
    }
    if (question.type === 'file' && uploadedFiles.has(question.id)) {
      const extension = path.extname(value.name).toLowerCase();
      if (!question.accept.includes(extension) || value.size > (question.maxMB || 4) * 1024 * 1024) {
        return 'Upload an allowed file type within the size limit for "' + question.label + '".';
      }
    }
    if (['single_choice', 'dropdown'].includes(question.type) && value) {
      const valid = question.options.includes(value) ||
        (question.allowOther && value.startsWith('Other: ') && value.length > 7);
      if (!valid) return 'Choose a valid answer for "' + question.label + '".';
    }
    if (question.type === 'multi_choice') {
      for (const item of value) {
        const valid = question.options.includes(item.label) ||
          (question.allowOther && item.label.startsWith('Other: ') && item.label.length > 7);
        if (!valid || (question.proficiency && !question.levels.includes(item.level))) {
          return 'Choose valid answers for "' + question.label + '".';
        }
      }
    }
  }
  return '';
}

async function sendVolunteerNotification(submission) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    console.error('[error] Volunteer application was saved, but Resend is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.');
    return { sent: false };
  }
  const senderMatch = RESEND_FROM_EMAIL.match(/<([^<>]+)>/);
  const senderAddress = senderMatch ? senderMatch[1] : RESEND_FROM_EMAIL;
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(senderAddress)) {
    console.error('[error] Volunteer application was saved, but RESEND_FROM_EMAIL must be a full email address verified with Resend.');
    return { sent: false };
  }
  const answers = submission.answers.map(answer => {
    let value;
    if (answer.type === 'file') value = answer.value && answer.value.name ? 'Uploaded: ' + answer.value.name : 'Not provided';
    else if (answer.type === 'multi_choice') {
      value = (answer.value || []).map(item => item.level ? item.label + ' (' + item.level + ')' : item.label).join('; ');
    } else value = String(answer.value == null ? '' : answer.value);
    return answer.section + '\n' + answer.label + ': ' + (value || 'Not provided');
  }).join('\n\n').slice(0, 40000);
  const applicantName = submission.applicant.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [VOLUNTEER_NOTIFICATION_EMAIL],
        reply_to: submission.applicant.email,
        subject: 'Volunteer application: ' + applicantName,
        text: [
          'A new volunteer application was submitted to the DIRA Foundation website.',
          '',
          'Applicant: ' + submission.applicant.name,
          'Email: ' + submission.applicant.email,
          'Phone: ' + (submission.applicant.phone || 'Not provided'),
          'Submitted: ' + submission.submittedAt,
          '',
          answers,
          '',
          'Uploaded files, if any, are available in the volunteer administration page.'
        ].join('\n')
      }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    console.error('[error] Volunteer application was saved, but the Resend request failed:', error.message);
    return { sent: false };
  }
  if (!response.ok) {
    let resendError;
    try { resendError = await response.json(); } catch (error) { resendError = null; }
    const detail = resendError && typeof resendError.message === 'string'
      ? ' ' + resendError.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
      : '';
    console.error('[error] Volunteer application was saved, but Resend returned HTTP ' + response.status + '.' + detail);
    return { sent: false };
  }
  return { sent: true };
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const m = req.method;
  res.setHeader('Cache-Control', 'no-store');

  if (route === '/api/volunteer-form' && m === 'GET') {
    const saved = await volunteerFormCollection.findOne({ _id: 'current' }, { projection: { _id: 0, form: 1 } });
    return json(res, 200, saved ? saved.form : {});
  }
  if (route === '/api/volunteer-submissions' && m === 'POST') {
    const multipart = await readMultipart(req, Math.floor(4.25 * 1024 * 1024));
    let input;
    try { input = JSON.parse(multipart.fields.get('data') || ''); }
    catch (e) { return json(res, 400, { error: 'The volunteer application data is invalid.' }); }
    const validated = validateVolunteerSubmission(input);
    if (validated.error) return json(res, 400, { error: validated.error });
    if (multipart.files.size > 10) return json(res, 400, { error: 'Too many files were uploaded.' });
    const id = crypto.randomBytes(16).toString('hex');
    const files = {};
    const fileDocs = [];
    for (const [field, file] of multipart.files) {
      const match = /^file_([A-Za-z0-9_-]{1,80})$/.exec(field);
      if (!match || !seenFileQuestion(validated.value.answers, match[1])) {
        return json(res, 400, { error: 'An uploaded file does not match an application question.' });
      }
      const details = volunteerFileType(file);
      if (!details) return json(res, 400, { error: 'Upload a valid PDF, Word or RTF file no larger than 4 MB.' });
      const qid = match[1];
      const metadata = { name: details.name, size: file.data.length, type: details.type };
      files[qid] = metadata;
      validated.value.answers.find(answer => answer.qid === qid).value = metadata;
      fileDocs.push({ submissionId: id, qid, ...metadata, data: file.data });
    }
    for (const answer of validated.value.answers) {
      if (answer.type === 'file' && !files[answer.qid]) answer.value = '';
    }
    const savedForm = await volunteerFormCollection.findOne({ _id: 'current' }, { projection: { _id: 0, form: 1 } });
    if (savedForm) {
      const formError = validateSubmissionForForm(validated.value.answers, savedForm.form, new Set(Object.keys(files)));
      if (formError) return json(res, 400, { error: formError });
    }
    const submission = {
      id, submittedAt: new Date().toISOString(),
      applicant: validated.value.applicant, answers: validated.value.answers, files
    };
    try {
      if (fileDocs.length) await volunteerFileCollection.insertMany(fileDocs, { ordered: true });
      await volunteerSubmissionCollection.insertOne(submission);
    } catch (error) {
      await volunteerFileCollection.deleteMany({ submissionId: id }).catch(() => {});
      throw error;
    }
    const notification = await sendVolunteerNotification(submission);
    try {
      await volunteerSubmissionCollection.updateOne(
        { id },
        { $set: { emailNotificationSent: notification.sent } }
      );
    } catch (error) {
      console.error('[error] Volunteer application was saved, but its email notification status could not be recorded:', error.message);
    }
    return json(res, 201, {
      id,
      submittedAt: submission.submittedAt,
      notificationSent: notification.sent
    });
  }

  if (route === '/api/articles' && m === 'GET') {
    const requestedLimit = parseInt(url.searchParams.get('limit'), 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 6) : 3;
    const articles = await articleCollection.find({ published: true })
      .sort({ publishedAt: -1 }).limit(limit)
      .project({ _id: 0, title: 1, slug: 1, summary: 1, body: 1, author: 1, publishedAt: 1, coverImage: 1, coverAlt: 1 })
      .toArray();
    return json(res, 200, {
      articles: articles.map(article => ({
        title: article.title,
        slug: article.slug,
        summary: excerpt(article, 160),
        author: article.author,
        publishedAt: article.publishedAt,
        coverImage: article.coverImage || '',
        coverAlt: article.coverAlt || ''
      }))
    });
  }

  if (route === '/api/payments/initiate' && m === 'POST') {
    const b = await readJson(req, 10 * 1024);
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      return json(res, 400, { error: 'Payment details must be sent as a JSON object.' });
    }
    const amount = b.amount;
    const email = String(b.email || '').trim();
    if (!Number.isSafeInteger(amount) || amount < 100) {
      return json(res, 400, { error: 'Enter a whole-number donation of at least 100 XAF.' });
    }
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return json(res, 400, { error: 'Enter a valid email address or leave the field blank.' });
    }
    const externalId = 'dira_' + crypto.randomBytes(12).toString('hex');
    const paymentRequest = {
      amount,
      redirectUrl: donationReturnUrl(req),
      userId: externalId,
      externalId,
      message: 'Donation to DIRA Foundation'
    };
    if (email) paymentRequest.email = email;

    const result = await fapshiRequest('/initiate-pay', {
      method: 'POST',
      body: JSON.stringify(paymentRequest)
    });
    if (!result || typeof result !== 'object') {
      throw Object.assign(new Error('Fapshi returned an invalid checkout response.'), { status: 502 });
    }
    let checkout;
    try { checkout = new URL(result.link); } catch (error) {
      throw Object.assign(new Error('Fapshi returned an invalid checkout link.'), { status: 502 });
    }
    if (checkout.protocol !== 'https:' || (checkout.hostname !== 'fapshi.com' && !checkout.hostname.endsWith('.fapshi.com')) ||
      typeof result.transId !== 'string' || !result.transId.trim() || result.transId.length > 200) {
      throw Object.assign(new Error('Fapshi returned an invalid checkout response.'), { status: 502 });
    }
    const transId = result.transId.trim();
    return json(res, 200, {
      link: checkout.toString(),
      transId,
      statusToken: makePaymentStatusToken(transId)
    });
  }

  if (route === '/api/payments/status' && m === 'POST') {
    const b = await readJson(req, 4 * 1024);
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      return json(res, 400, { error: 'Payment status details must be sent as a JSON object.' });
    }
    const transId = String(b.transId || '').trim();
    if (!transId || transId.length > 200 || !validPaymentStatusToken(transId, b.statusToken)) {
      return json(res, 403, { error: 'This payment status request is invalid or has expired.' });
    }
    const result = await fapshiRequest('/payment-status/' + encodeURIComponent(transId), { method: 'GET' });
    const allowedStatuses = new Set(['CREATED', 'PENDING', 'SUCCESSFUL', 'FAILED', 'EXPIRED']);
    if (!allowedStatuses.has(result.status)) {
      throw Object.assign(new Error('Fapshi returned an invalid payment status.'), { status: 502 });
    }
    return json(res, 200, { status: result.status });
  }

  if (route === '/api/admin/session' && m === 'GET') {
    return json(res, 200, { authenticated: isAdmin(req), configured: CREDS_OK });
  }
  if (route === '/api/admin/login' && m === 'POST') {
    if (!CREDS_OK) return json(res, 503, { error: 'Admin login is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD in the .env file and restart the server.' });
    const ip = clientIp(req);
    if (blocked(ip)) return json(res, 429, { error: 'Too many failed attempts. Please wait 15 minutes and try again.' });
    const b = await readJson(req, 10 * 1024);
    const okEmail = safeEqual(String(b.email || '').trim().toLowerCase(), ADMIN_EMAIL);
    const okPass = safeEqual(String(b.password || ''), ADMIN_PASSWORD);
    if (!(okEmail && okPass)) {
      fail(ip);
      await new Promise(r => setTimeout(r, 600));
      return json(res, 401, { error: 'Incorrect email or password.' });
    }
    attempts.delete(ip);
    setSession(req, res, signToken(), Math.floor(SESSION_HOURS * 3600));
    return json(res, 200, { ok: true });
  }
  if (route === '/api/admin/logout' && m === 'POST') {
    setSession(req, res, '', 0);
    return json(res, 200, { ok: true });
  }

  // everything below needs a valid session
  if (!isAdmin(req)) return json(res, 401, { error: 'Please sign in.' });

  if (route === '/api/volunteer-form' && m === 'PUT') {
    const form = validateVolunteerForm(await readJson(req, 200 * 1024));
    if (form.error) return json(res, 400, { error: form.error });
    const updatedAt = new Date().toISOString();
    await volunteerFormCollection.updateOne(
      { _id: 'current' },
      { $set: { form: form.value, updatedAt } },
      { upsert: true }
    );
    return json(res, 200, Object.assign({}, form.value, { updatedAt }));
  }
  if (route === '/api/volunteer-submissions' && m === 'GET') {
    const submissions = await volunteerSubmissionCollection.find({}, { projection: { _id: 0 } })
      .sort({ submittedAt: -1 }).toArray();
    return json(res, 200, { submissions });
  }
  if (route === '/api/volunteer-submissions' && m === 'DELETE') {
    verifySameOrigin(req);
    await volunteerFileCollection.deleteMany({});
    await volunteerSubmissionCollection.deleteMany({});
    return json(res, 200, { ok: true });
  }
  let volunteerMatch = route.match(/^\/api\/volunteer-submissions\/([a-f0-9]{32})$/);
  if (volunteerMatch && m === 'DELETE') {
    verifySameOrigin(req);
    const id = volunteerMatch[1];
    const deleted = await volunteerSubmissionCollection.deleteOne({ id });
    if (!deleted.deletedCount) return json(res, 404, { error: 'Registration not found.' });
    await volunteerFileCollection.deleteMany({ submissionId: id });
    return json(res, 200, { ok: true });
  }
  volunteerMatch = route.match(/^\/api\/volunteer-submissions\/([a-f0-9]{32})\/files\/([A-Za-z0-9_-]{1,80})$/);
  if (volunteerMatch && m === 'GET') {
    const file = await volunteerFileCollection.findOne(
      { submissionId: volunteerMatch[1], qid: volunteerMatch[2] },
      { projection: { _id: 0, name: 1, type: 1, data: 1 } }
    );
    if (!file) return json(res, 404, { error: 'The uploaded file was not found.' });
    const filename = safeVolunteerFilename(file.name).replace(/["\\]/g, '_');
    let fileData;
    if (Buffer.isBuffer(file.data)) fileData = file.data;
    else if (file.data && file.data.buffer) {
      const buffer = Buffer.from(file.data.buffer);
      const length = Number.isInteger(file.data.position) ? file.data.position : buffer.length;
      fileData = buffer.subarray(0, length);
    } else {
      fileData = Buffer.from(file.data || []);
    }
    res.writeHead(200, baseHeaders({
      'Content-Type': file.type,
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'Content-Length': fileData.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }));
    return res.end(fileData);
  }

  if (route === '/api/admin/articles' && m === 'GET') {
    const list = await articleCollection.find({}).sort({ createdAt: -1 }).toArray();
    return json(res, 200, { articles: list });
  }
  if (route === '/api/admin/articles' && m === 'POST') {
    const r = validateArticle(await readJson(req, 200 * 1024));
    if (r.error) return json(res, 400, { error: r.error });
    const now = new Date().toISOString();
    const a = Object.assign({ id: crypto.randomBytes(8).toString('hex'), slug: await uniqueSlug(r.value.title), createdAt: now, updatedAt: now,
      publishedAt: r.value.published ? now : null }, r.value);
    await articleCollection.insertOne(a);
    return json(res, 201, { article: a });
  }
  let mm = route.match(/^\/api\/admin\/articles\/([a-f0-9]{16})$/);
  if (mm) {
    const old = await articleCollection.findOne({ id: mm[1] });
    if (!old) return json(res, 404, { error: 'Article not found.' });
    if (m === 'PUT') {
      const r = validateArticle(await readJson(req, 200 * 1024), old);
      if (r.error) return json(res, 400, { error: r.error });
      const oldImages = articleImageRefs(old);
      const now = new Date().toISOString();
      const next = Object.assign({}, old, r.value, { updatedAt: now });
      // Keep the URL stable once an article has been published, so shared links never break.
      if (r.value.title !== old.title && !old.publishedAt) next.slug = await uniqueSlug(r.value.title, old.id);
      if (r.value.published && !old.publishedAt) next.publishedAt = now;
      delete next._id;
      const updated = await articleCollection.updateOne({ id: old.id }, { $set: next });
      if (!updated.matchedCount) return json(res, 404, { error: 'Article not found.' });
      let warning = '';
      try { await removeUnusedImages(oldImages); }
      catch (e) { console.error('[warn] Article saved, but old image cleanup failed:', e.message); warning = 'Article saved, but an unused image could not be removed from Cloudinary.'; }
      return json(res, 200, { article: next, warning });
    }
    if (m === 'DELETE') {
      const oldImages = articleImageRefs(old);
      const deleted = await articleCollection.deleteOne({ id: old.id });
      if (!deleted.deletedCount) return json(res, 404, { error: 'Article not found.' });
      let warning = '';
      try { await removeUnusedImages(oldImages); }
      catch (e) { console.error('[warn] Article deleted, but old image cleanup failed:', e.message); warning = 'Article deleted, but an unused image could not be removed from Cloudinary.'; }
      return json(res, 200, { ok: true, warning });
    }
  }
  if (route === '/api/admin/upload' && m === 'POST') {
    const b = await readJson(req, 8 * 1024 * 1024);
    const mt = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''));
    if (!mt) return json(res, 400, { error: 'Please choose a JPG, PNG or WebP image.' });
    const buf = Buffer.from(mt[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) return json(res, 413, { error: 'The image is larger than 5 MB.' });
    let ext = null;
    if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
    else if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
    else if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') ext = 'webp';
    if (!ext) return json(res, 400, { error: 'The file is not a valid JPG, PNG or WebP image.' });
    ensureCloudinaryConfigured();
    const uploaded = await cloudinary.uploader.upload(String(b.dataUrl), {
      public_id: 'dira-articles/' + crypto.randomBytes(12).toString('hex'),
      resource_type: 'image',
      allowed_formats: ['jpg', 'png', 'webp'],
      overwrite: false
    });
    if (!uploaded.secure_url || !uploaded.public_id || cloudinaryPublicId(uploaded.secure_url) !== uploaded.public_id) {
      if (uploaded.public_id) await cloudinary.uploader.destroy(uploaded.public_id, { resource_type: 'image' });
      throw new Error('Cloudinary returned an invalid image reference.');
    }
    return json(res, 201, { path: uploaded.secure_url, publicId: uploaded.public_id });
  }
  return json(res, 404, { error: 'Not found.' });
}

/* ------------------------------------------------------------------ static files */
async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }
  if (rel.includes('\0')) return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
  if (rel.endsWith('/')) rel += 'index.html';
  const parts = rel.split('/').filter(Boolean);
  if (parts.some(p => p.startsWith('.') || BLOCKED_NAMES.has(p.toLowerCase()))) return notFound(res);
  const file = path.join(ROOT, ...parts);
  if (!file.startsWith(ROOT + path.sep)) return notFound(res);
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) return notFound(res);
  let st;
  try { st = await fsp.stat(file); } catch (e) { return notFound(res); }
  if (!st.isFile()) return notFound(res);
  const headers = { 'Content-Type': MIME[ext], 'Content-Length': st.size };
  if (parts[0] === 'uploads') headers['Cache-Control'] = 'public, max-age=2592000, immutable';
  else if (ext === '.html') headers['Cache-Control'] = parts[0] === 'admin.html' ? 'no-store' : 'no-cache';
  else headers['Cache-Control'] = 'public, max-age=3600';
  if (parts[0] === 'admin.html' || parts[0] === 'volunteer-admin.html' || parts[0] === 'volunteer-login.html') headers['X-Frame-Options'] = 'DENY';
  res.writeHead(200, baseHeaders(headers));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function serveConceptNote(req, res) {
  const file = await fsp.readFile(path.join(ROOT, 'data', 'DSIP-Concept-Note-2027.docx'));
  res.writeHead(200, baseHeaders({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': 'attachment; filename="02_Concept_Note_DSIP.docx"',
    'Content-Length': file.length,
    'Cache-Control': 'public, max-age=3600'
  }));
  res.end(req.method === 'HEAD' ? undefined : file);
}

/* ------------------------------------------------------------------ router */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname;
    if (!IS_NETLIFY && p === '/.netlify/functions/server' && url.searchParams.has('__route')) {
      p = url.searchParams.get('__route');
      url.searchParams.delete('__route');
    }
    if (p.startsWith('/api/')) {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      return await handleApi(req, res, url);
    }
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
    if (p === '/articles' || p === '/articles/' || p === '/articles.html') return await renderList(req, res, url);
    const am = p.match(/^\/articles\/([a-z0-9-]+)\/?$/);
    if (am) return await renderArticle(req, res, am[1]);
    if (p === '/article.html') return notFound(res);
    if (p === '/admin') { res.writeHead(302, { Location: '/admin.html' }); return res.end(); }
    if (p === '/sitemap.xml') return await renderSitemap(req, res);
    if (p === '/robots.txt') return renderRobots(req, res);
    if (p === '/data/DSIP-Concept-Note-2027.docx') return await serveConceptNote(req, res);
    return await serveStatic(req, res, p);
  } catch (e) {
    const status = e.status || 500;
    if (status === 413 && !res.headersSent) res.setHeader('Connection', 'close');
    if (status === 500) console.error('[error]', e);
    if (req.url.startsWith('/api/')) {
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong on the server.' : e.message });
    } else if (!res.headersSent) {
      send(res, status, status === 500 ? 'Server error' : e.message, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  }
});

async function initializeBackend() {
  if (!MONGODB_URI) throw new Error('Set the required value in .env: MONGODB_URI');
  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    cloudinary.config({
      cloud_name: CLOUDINARY_CLOUD_NAME,
      api_key: CLOUDINARY_API_KEY,
      api_secret: CLOUDINARY_API_SECRET,
      secure: true
    });
  }
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  articleCollection = db.collection('articles');
  volunteerFormCollection = db.collection('volunteer_forms');
  volunteerSubmissionCollection = db.collection('volunteer_submissions');
  volunteerFileCollection = db.collection('volunteer_files');
  await articleCollection.createIndex({ id: 1 }, { unique: true });
  await articleCollection.createIndex({ slug: 1 }, { unique: true });
  await articleCollection.createIndex({ published: 1, publishedAt: -1 });
  await volunteerSubmissionCollection.createIndex({ id: 1 }, { unique: true });
  await volunteerSubmissionCollection.createIndex({ submittedAt: -1 });
  await volunteerFileCollection.createIndex({ submissionId: 1, qid: 1 }, { unique: true });
  await importLegacyArticles();
  await cleanLocalOrphans();
}

let backendReady;
function ensureBackend() {
  if (!backendReady) {
    backendReady = initializeBackend().catch(error => {
      backendReady = null;
      throw error;
    });
  }
  return backendReady;
}

if (require.main === module) {
  ensureBackend().then(() => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, () => {
      server.removeListener('error', reject);
      resolve();
    });
  })).then(() => {
    console.log('DIRA Foundation site running at http://localhost:' + PORT);
    console.log('Articles:  http://localhost:' + PORT + '/articles');
    console.log('Admin:     http://localhost:' + PORT + '/admin.html' + (CREDS_OK ? '' : '   (login disabled until .env is configured)'));
  }).catch(async error => {
    console.error('[error] Could not start the server:', error.message);
    if (mongoClient) await mongoClient.close().catch(() => {});
    process.exitCode = 1;
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(async () => {
        if (mongoClient) await mongoClient.close();
        process.exit(0);
      });
    });
  }
} else {
  const serverless = require('serverless-http');
  const serverlessHandler = serverless(server, {
    binary: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/pdf',
      'application/msword',
      'application/rtf'
    ]
  });
  module.exports.handler = async (event, context) => {
    const routedPath = event.queryStringParameters && event.queryStringParameters.__route;
    if (!routedPath || !/^\/(?:api\/|articles(?:\/|$)|sitemap\.xml$|robots\.txt$|data\/DSIP-Concept-Note-2027\.docx$)/.test(routedPath)) {
      return { statusCode: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' };
    }
    if (routedPath !== '/robots.txt' && routedPath !== '/data/DSIP-Concept-Note-2027.docx') await ensureBackend();
    const queryStringParameters = Object.assign({}, event.queryStringParameters);
    delete queryStringParameters.__route;
    event = Object.assign({}, event, {
      path: routedPath,
      rawPath: routedPath,
      queryStringParameters
    });
    delete event.rawUrl;
    return serverlessHandler(event, context);
  };
}
