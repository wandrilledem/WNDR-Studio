'use strict';
// WDNR Studio: serves the website, stores quote and call requests, and runs the admin page.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, nothing to compile
const nodemailer = require('nodemailer');

// ---------- settings (from environment variables, see .env.example) ----------
loadDotEnv(path.join(__dirname, '.env'));
const env = process.env;
const PORT = Number(env.PORT) || 3000;
const PROD = env.NODE_ENV === 'production';
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
const SESSION_SECRET = env.SESSION_SECRET || '';
const NOTIFY_TO = env.NOTIFY_TO || 'demoulin.wand@gmail.com';

if (ADMIN_PASSWORD.length < 10) {
  console.error('ADMIN_PASSWORD is missing or shorter than 10 characters. Set it in .env or in your host settings.');
  process.exit(1);
}
if (SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET is missing or shorter than 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// ---------- database ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'requests.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    kind       TEXT NOT NULL CHECK (kind IN ('quote','call')),
    name       TEXT NOT NULL,
    contact    TEXT NOT NULL,
    best_time  TEXT NOT NULL DEFAULT '',
    message    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'new',
    notes      TEXT NOT NULL DEFAULT '',
    updated_at TEXT
  );
`);
const STATUSES = ['new', 'contacted', 'quote_sent', 'won', 'lost'];
const q = {
  insert: db.prepare('INSERT INTO requests (kind,name,contact,best_time,message) VALUES (@kind,@name,@contact,@best_time,@message)'),
  list: db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 2000'),
  get: db.prepare('SELECT * FROM requests WHERE id = ?'),
  update: db.prepare("UPDATE requests SET status=@status, notes=@notes, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=@id"),
  remove: db.prepare('DELETE FROM requests WHERE id = ?'),
};

// ---------- email alert (optional) ----------
const mailer = env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT) || 465,
      secure: (Number(env.SMTP_PORT) || 465) === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    })
  : null;

async function notify(r) {
  if (!mailer) return;
  const kind = r.kind === 'call' ? 'free call' : 'free quote';
  const lines = [
    `New ${kind} request on WDNR Studio`,
    '',
    `Name: ${r.name}`,
    `Contact: ${r.contact}`,
    r.best_time ? `Best time to call: ${r.best_time}` : '',
    '',
    r.message || '(no project description)',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  try {
    await mailer.sendMail({
      from: env.NOTIFY_FROM || env.SMTP_USER,
      to: NOTIFY_TO,
      replyTo: EMAIL_RE.test(r.contact) ? r.contact : undefined,
      subject: `New ${kind} request: ${r.name}`,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.error('Email alert failed:', err.message);
  }
}

// ---------- helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const multiLine = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max);

function rateLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, t] of hits) if (t.every(x => now - x > windowMs)) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const t = (hits.get(req.ip) || []).filter(x => now - x < windowMs);
    if (t.length >= max) return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
    t.push(now);
    hits.set(req.ip, t);
    next();
  };
}

const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const COOKIE = 'wdnr_admin';
const SESSION_DAYS = 7;

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function isAdmin(req) {
  const [exp, mac] = readCookie(req, COOKIE).split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  return safeEqual(mac, sign(exp));
}
function setSession(res, on) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const value = on ? `${exp}.${sign(String(exp))}` : '';
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', on ? `Max-Age=${SESSION_DAYS * 86400}` : 'Max-Age=0'];
  if (PROD) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; ${flags.join('; ')}`);
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Please log in.' });
  // changes must be sent as JSON, which other websites cannot do with your cookie
  if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'JSON only.' });
  next();
}

// ---------- app ----------
const app = express();
const trust = env.TRUST_PROXY;
app.set('trust proxy', trust === undefined ? (PROD ? 1 : false) : (/^\d+$/.test(trust) ? Number(trust) : trust === 'true'));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.use(express.json({ limit: '20kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// the website form sends requests here
app.post('/api/requests', rateLimiter(5, 15 * 60e3), (req, res) => {
  const b = req.body || {};
  if (oneLine(b.website, 200)) return res.json({ ok: true }); // hidden field: only bots fill it
  const r = {
    kind: b.want === 'call' ? 'call' : 'quote',
    name: oneLine(b.name, 100),
    contact: oneLine(b.contact, 150),
    best_time: b.want === 'call' ? oneLine(b.time, 100) : '',
    message: multiLine(b.message, 3000),
  };
  if (!r.name || !r.contact) return res.status(400).json({ error: 'Please add your name and an email or phone number.' });
  const { lastInsertRowid } = q.insert.run(r);
  notify(r);
  res.status(201).json({ ok: true, id: Number(lastInsertRowid) });
});

// ---------- admin ----------
const adminHeaders = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
};
app.get(['/admin', '/admin/'], adminHeaders, (req, res) => res.sendFile(path.join(__dirname, 'admin', 'admin.html')));
app.get('/admin/admin.js', adminHeaders, (req, res) => res.sendFile(path.join(__dirname, 'admin', 'admin.js')));
app.get('/admin/admin.css', adminHeaders, (req, res) => res.sendFile(path.join(__dirname, 'admin', 'admin.css')));

app.use('/api/admin', adminHeaders);
app.post('/api/admin/login', rateLimiter(10, 15 * 60e3), (req, res) => {
  if (!req.is('application/json') || !safeEqual((req.body || {}).password || '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  setSession(res, true);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { setSession(res, false); res.json({ ok: true }); });
app.get('/api/admin/requests', requireAdmin, (req, res) => res.json({ requests: q.list.all() }));
app.patch('/api/admin/requests/:id', requireAdmin, (req, res) => {
  const row = q.get.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  const status = STATUSES.includes(b.status) ? b.status : row.status;
  const notes = b.notes === undefined ? row.notes : multiLine(b.notes, 5000);
  q.update.run({ id: row.id, status, notes });
  res.json({ request: q.get.get(row.id) });
});
app.delete('/api/admin/requests/:id', requireAdmin, (req, res) => {
  const { changes } = q.remove.run(Number(req.params.id));
  res.status(changes ? 200 : 404).json({ ok: !!changes });
});
app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const cols = ['id', 'created_at', 'kind', 'status', 'name', 'contact', 'best_time', 'message', 'notes'];
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formulas
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const csv = [cols.join(','), ...q.list.all().map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wdnr-requests.csv"');
  res.send('﻿' + csv);
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------- the website ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`WDNR Studio running on http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin`);
  console.log(mailer ? `Email alerts go to ${NOTIFY_TO}` : 'Email alerts are off (no SMTP settings).');
});

// tiny .env reader so no extra package is needed
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
