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

const ROOT = process.env.NETLIFY === 'true' ? process.cwd() : __dirname;

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
if (process.env.NETLIFY !== 'true') {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
let mongoClient;
let articleCollection;

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
  if (process.env.NETLIFY === 'true') return;
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
  return FORCE_SECURE || process.env.NETLIFY === 'true' || !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
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
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
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

function headMeta(o) {
  const t = esc(o.title), d = esc(o.description);
  let h = '<meta name="description" content="' + d + '">\n';
  h += '    <meta property="og:type" content="' + (o.article ? 'article' : 'website') + '">\n';
  h += '    <meta property="og:title" content="' + t + '">\n    <meta property="og:description" content="' + d + '">\n';
  h += '    <meta name="twitter:card" content="' + (o.image ? 'summary_large_image' : 'summary') + '">\n';
  h += '    <meta name="twitter:title" content="' + t + '">\n    <meta name="twitter:description" content="' + d + '">\n';
  const imageUrl = o.image && (/^https:\/\//i.test(o.image) ? o.image : SITE_URL ? SITE_URL + o.image : '');
  if (SITE_URL) {
    h += '    <link rel="canonical" href="' + esc(SITE_URL + o.path) + '">\n    <meta property="og:url" content="' + esc(SITE_URL + o.path) + '">\n';
  }
  if (imageUrl) h += '    <meta property="og:image" content="' + esc(imageUrl) + '">\n    <meta name="twitter:image" content="' + esc(imageUrl) + '">\n';
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
  const html = fill(await template('articles.html'), {
    TITLE: esc(title),
    HEAD_META: headMeta({ title, description, path: '/articles' + (page > 1 ? '?page=' + page : '') }),
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
  const ld = {
    '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description,
    datePublished: a.publishedAt || a.createdAt, dateModified: a.updatedAt || a.createdAt,
    author: a.author === 'DIRA Foundation' ? { '@type': 'Organization', name: 'DIRA Foundation' } : { '@type': 'Person', name: a.author },
    publisher: { '@type': 'Organization', name: 'DIRA Foundation' }
  };
  if (SITE_URL) {
    ld.mainEntityOfPage = SITE_URL + '/articles/' + a.slug;
    if (a.coverImage) ld.image = /^https:\/\//i.test(a.coverImage) ? a.coverImage : SITE_URL + a.coverImage;
  } else if (a.coverImage && /^https:\/\//i.test(a.coverImage)) {
    ld.image = a.coverImage;
  }
  const cover = a.coverImage
    ? '<img class="art-cover" src="' + esc(a.coverImage) + '" alt="' + esc(a.coverAlt || '') + '">' : '';
  const html = fill(await template('article.html'), {
    TITLE: esc(title),
    HEAD_META: headMeta({ title, description, path: '/articles/' + a.slug, image: a.coverImage, article: true, noindex: preview }) +
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
  const pages = ['/', '/about.html', '/work.html', '/partner.html', '/involve.html', '/contact.html', '/articles'];
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
  const text = 'User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /api/\n\nSitemap: ' + baseUrl + '/sitemap.xml\n';
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

async function handleApi(req, res, url) {
  const route = url.pathname;
  const m = req.method;
  res.setHeader('Cache-Control', 'no-store');

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
  if (parts[0] === 'admin.html') headers['X-Frame-Options'] = 'DENY';
  res.writeHead(200, baseHeaders(headers));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ router */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname;
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
  articleCollection = mongoClient.db().collection('articles');
  await articleCollection.createIndex({ id: 1 }, { unique: true });
  await articleCollection.createIndex({ slug: 1 }, { unique: true });
  await articleCollection.createIndex({ published: 1, publishedAt: -1 });
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
  const serverlessHandler = serverless(server);
  module.exports.handler = async (event, context) => {
    const routedPath = event.queryStringParameters && event.queryStringParameters.__route;
    if (!routedPath || !/^\/(?:api\/|articles(?:\/|$)|sitemap\.xml$|robots\.txt$)/.test(routedPath)) {
      return { statusCode: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' };
    }
    if (routedPath !== '/robots.txt') await ensureBackend();
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
