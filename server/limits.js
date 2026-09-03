// Storage caps, sized to stay well inside Neon's free 0.5 GB.
module.exports = {
  MAX_SETS_PER_USER: 500,
  MAX_CARDS_PER_SET: 2000,
  MAX_TEXT_LEN: 2000,       // per term or definition
  MAX_TITLE_LEN: 200,
  MAX_DESCRIPTION_LEN: 2000,
  MIN_USERNAME_LEN: 3,
  MAX_USERNAME_LEN: 30,
  MAX_UPLOAD_BYTES: 2 * 1024 * 1024,
  MAX_UPLOAD_ROWS: 5000,
  MIN_PASSWORD_LEN: 8,
  MAX_PASSWORD_LEN: 72,     // bcrypt ignores bytes past 72; cap here rather than truncate silently
};
