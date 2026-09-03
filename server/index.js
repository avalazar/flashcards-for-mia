require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const { router: authRouter, loadUser, requireAuth } = require('./auth');
const { router: setsRouter } = require('./sets');
const { router: importRouter } = require('./import');
const { router: progressRouter } = require('./progress');
const { HttpError } = require('./validate');
const L = require('./limits');

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS at its proxy, so trust it for req.secure and for the
// client IP that express-rate-limit keys on.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// CSP is off: the vanilla frontend uses inline event handlers, and enabling it would
// break the page for little gain on a single-origin app with no third-party scripts.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));   // an import of 5000 rows can be a few MB
app.use(cookieParser(process.env.SESSION_SECRET));

// ── Health check ──────────────────────────────────────────────────────────────
// Deliberately does NOT touch Postgres. An external pinger hits this every 10 minutes
// to stop Render's 15-minute spin-down; if it queried the database it would hold Neon's
// compute awake ~730 h/month against a 100 CU-hour (~400 h) free budget and exhaust it.
app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// ── API ───────────────────────────────────────────────────────────────────────
app.use('/api', loadUser);
app.use('/api/auth', authRouter);
app.use('/api/sets', requireAuth, setsRouter);
app.use('/api/import', requireAuth, importRouter);
app.use('/api/progress', requireAuth, progressRouter);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'No such endpoint.' });
});

// ── Static frontend ───────────────────────────────────────────────────────────
// Served from the same origin as the API, which keeps the session cookie first-party
// (Safari and iOS block third-party cookies) and means no CORS configuration at all.
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Errors ────────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `That file is larger than the ${Math.round(L.MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`
      : 'That file could not be uploaded.';
    return res.status(400).json({ error: message });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Malformed request.' });
  }
  // A very large import can exceed the JSON body limit. Without this the client would
  // get an opaque 413 with no explanation of what to do about it.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'That import is too large to send in one go. Try splitting the spreadsheet into smaller files.',
    });
  }

  // Anything else is a bug or a database outage. Log it, but do not leak internals.
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

const server = app.listen(PORT, () => {
  console.log(`Flashcards running on http://localhost:${PORT}`);
});

// Render sends SIGTERM on deploy and on spin-down; close cleanly so in-flight
// requests finish and Postgres connections are released.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      require('./db').pool.end().then(() => process.exit(0), () => process.exit(0));
    });
  });
}
