// Password hashing with Node's built-in scrypt.
//
// Why not bcrypt: the pure-JS `bcryptjs` needs ~500ms per hash at cost 12 on a dev
// laptop, and Render's free instance has a fraction of a CPU, which would make signing
// in take seconds. The native `bcrypt` package is fast but needs a compile step that can
// break a deploy. Node's scrypt is native, memory-hard, and needs no dependency at all.
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// N=2^15 costs ~32 MB and ~100ms per hash. Sized to leave room for a few concurrent
// logins inside Render's 512 MB free instance.
const PARAMS = { N: 32768, r: 8, p: 1 };
const KEYLEN = 64;
const SALT_BYTES = 16;
const MAXMEM = 256 * 1024 * 1024;

// Stored as scrypt$N$r$p$<salt b64>$<hash b64> so the parameters can be raised later
// without invalidating existing passwords.
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const { N, r, p } = PARAMS;
  const key = await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt, expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }

  let actual;
  try {
    actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    // Absurd stored parameters would otherwise throw and 500 the request.
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

// A real hash in the stored format, used on the login path when no account matches so
// that a wrong email costs the same time as a wrong password and the two cannot be
// distinguished by response timing. Built once at boot.
const DUMMY_HASH = `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$` +
  `${crypto.randomBytes(SALT_BYTES).toString('base64')}$` +
  `${crypto.randomBytes(KEYLEN).toString('base64')}`;

module.exports = { hashPassword, verifyPassword, DUMMY_HASH };
