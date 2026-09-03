const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { query } = require('./db');
const { hashPassword, verifyPassword, DUMMY_HASH } = require('./password');
const { HttpError, bad, reqUsername } = require('./validate');
const { withDefaults, validatePatch } = require('./settings');
const L = require('./limits');

const COOKIE_NAME = 'sid';
const SESSION_DAYS = 30;

// ── Session helpers ───────────────────────────────────────────────────────────

// The cookie carries 32 random bytes; the database stores only its sha256.
// A database leak therefore yields no usable sessions.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function expiryDate() {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    'insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)',
    [hashToken(token), userId, expiryDate()]
  );
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

async function destroySession(req, res) {
  const token = req.cookies[COOKIE_NAME];
  if (token) {
    await query('delete from sessions where token_hash = $1', [hashToken(token)]);
  }
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Populates req.user when a valid session cookie is present. Never rejects, so
// public routes can tell signed-in from anonymous without branching on errors.
async function loadUser(req, res, next) {
  req.user = null;
  const token = req.cookies[COOKIE_NAME];
  if (!token) return next();

  try {
    const { rows } = await query(
      `select u.id, u.username, u.settings, s.expires_at
         from sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now()`,
      [hashToken(token)]
    );
    if (rows.length === 0) {
      // Expired or revoked. Clear the stale cookie so the browser stops sending it.
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return next();
    }

    const row = rows[0];
    req.user = { id: row.id, username: row.username, settings: withDefaults(row.settings) };

    // Slide the expiry forward, but only once a day, to avoid a write on every request.
    const remainingMs = new Date(row.expires_at).getTime() - Date.now();
    if (remainingMs < (SESSION_DAYS - 1) * 24 * 60 * 60 * 1000) {
      await query('update sessions set expires_at = $1 where token_hash = $2',
        [expiryDate(), hashToken(token)]);
      res.cookie(COOKIE_NAME, token, cookieOptions());
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  next();
}

function publicUser(user) {
  return { id: user.id, username: user.username, settings: withDefaults(user.settings) };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Password endpoints are the expensive, guessable ones. Limit by IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

const router = express.Router();

router.post('/signup', authLimiter, async (req, res, next) => {
  try {
    const username = reqUsername(req.body.username);
    const password = req.body.password;

    if (typeof password !== 'string' || password.length < L.MIN_PASSWORD_LEN) {
      throw bad(`Password must be at least ${L.MIN_PASSWORD_LEN} characters.`);
    }
    if (password.length > L.MAX_PASSWORD_LEN) {
      throw bad(`Password must be ${L.MAX_PASSWORD_LEN} characters or fewer.`);
    }

    const passwordHash = await hashPassword(password);

    let rows;
    try {
      ({ rows } = await query(
        `insert into users (username, password_hash)
         values ($1, $2)
         returning id, username, settings`,
        [username, passwordHash]
      ));
    } catch (err) {
      // 23505 = unique_violation on the case-insensitive username index. Signup is
      // open, so saying the name is taken reveals nothing that trying it would not.
      if (err.code === '23505') throw new HttpError(409, 'That username is already taken.');
      throw err;
    }

    const user = { id: rows[0].id, username: rows[0].username, settings: rows[0].settings };
    await createSession(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    // Not reqUsername(): a rejected format here would tell an attacker the name cannot
    // exist. Take the raw value and let it simply fail to match.
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    const { rows } = await query(
      'select id, username, password_hash, settings from users where lower(username) = lower($1)',
      [username]
    );

    // Verify against a dummy hash when the account is missing, so a wrong username and
    // a wrong password take the same time and cannot be told apart by response timing.
    const hash = rows.length > 0 ? rows[0].password_hash : DUMMY_HASH;
    const ok = await verifyPassword(password, hash);

    if (rows.length === 0 || !ok) {
      throw new HttpError(401, 'Username or password is incorrect.');
    }

    const user = { id: rows[0].id, username: rows[0].username, settings: rows[0].settings };
    await createSession(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await destroySession(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Not signed in.'));
  res.json({ user: publicUser(req.user) });
});

// Updates one or more preferences. Merging server-side rather than having the client
// send the whole object means two devices changing different settings do not clobber
// each other.
router.patch('/settings', requireAuth, async (req, res, next) => {
  try {
    const patch = validatePatch(req.body, bad);
    const { rows } = await query(
      `update users set settings = coalesce(settings, '{}'::jsonb) || $2::jsonb
        where id = $1
        returning settings`,
      [req.user.id, JSON.stringify(patch)]
    );
    res.json({ settings: withDefaults(rows[0].settings) });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, loadUser, requireAuth, hashToken };
