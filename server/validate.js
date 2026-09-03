// Minimal hand-rolled validation, matching Cambio's dependency-light style.
const L = require('./limits');

// Thrown by the helpers below; server/index.js turns this into a JSON 4xx response.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bad(message) {
  return new HttpError(400, message);
}

// Requires a non-empty string no longer than max, and trims it.
function reqString(value, field, max) {
  if (typeof value !== 'string') throw bad(`${field} is required.`);
  const trimmed = value.trim();
  if (!trimmed) throw bad(`${field} is required.`);
  if (trimmed.length > max) throw bad(`${field} must be ${max} characters or fewer.`);
  return trimmed;
}

// Same, but an absent or blank value becomes ''.
function optString(value, field, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw bad(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw bad(`${field} must be ${max} characters or fewer.`);
  return trimmed;
}

// Deliberately narrow: no spaces or symbols that are easy to mistype or that look
// different across fonts, so a username can be read aloud and typed back reliably.
const USERNAME_RE = /^[a-zA-Z0-9._-]+$/;

function reqUsername(value) {
  const username = reqString(value, 'Username', L.MAX_USERNAME_LEN);
  if (username.length < L.MIN_USERNAME_LEN) {
    throw bad(`Username must be at least ${L.MIN_USERNAME_LEN} characters.`);
  }
  if (!USERNAME_RE.test(username)) {
    throw bad('Username can use letters, numbers, dots, hyphens and underscores only.');
  }
  return username;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Route params are user input; reject non-UUIDs before they reach Postgres,
// which would otherwise raise a 500 on a malformed uuid cast.
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

module.exports = { HttpError, bad, reqString, optString, reqUsername, isUuid };
