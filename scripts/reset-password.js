// Sets a new password for an account. There is no self-serve reset by email, so this
// is the recovery path when someone is locked out.
//
//   npm run reset-password -- mia
//
// The password is read without echoing it, so it does not land in the terminal
// scrollback, and it is never passed as an argument, so it stays out of shell history.
require('dotenv').config();
const { pool, query } = require('../server/db');
const { promptPassword } = require('./prompt-password');
const { hashPassword } = require('../server/password');
const L = require('../server/limits');

async function main() {
  const username = (process.argv[2] || '').trim();
  if (!username) throw new Error('Usage: npm run reset-password -- <username>');

  const { rows } = await query(
    'select id, username from users where lower(username) = lower($1)', [username]
  );
  if (rows.length === 0) {
    const { rows: all } = await query('select username from users order by created_at');
    const known = all.length > 0 ? '\nKnown accounts: ' + all.map(r => r.username).join(', ') : '';
    throw new Error(`No account found for "${username}".${known}`);
  }

  const user = rows[0];
  console.log(`Resetting the password for ${user.username}.`);

  const password = await promptPassword('New password: ');
  if (password.length < L.MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${L.MIN_PASSWORD_LEN} characters. Nothing was changed.`);
  }
  if (password.length > L.MAX_PASSWORD_LEN) {
    throw new Error(`Password must be ${L.MAX_PASSWORD_LEN} characters or fewer. Nothing was changed.`);
  }

  const again = await promptPassword('Confirm password: ');
  if (password !== again) {
    throw new Error('Those did not match. Nothing was changed.');
  }

  const passwordHash = await hashPassword(password);
  await query('update users set password_hash = $1 where id = $2', [passwordHash, user.id]);

  // Sign out everywhere. If the lockout happened because someone else had the account,
  // leaving their existing sessions alive would defeat the point of the reset.
  const { rowCount } = await query('delete from sessions where user_id = $1', [user.id]);

  console.log(`Password updated. ${rowCount} existing session(s) signed out.`);
}

main()
  .then(() => pool.end())
  .catch(async err => {
    console.error(err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
