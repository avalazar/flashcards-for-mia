// The complete set of user preferences. Anything not listed here is rejected, which
// keeps unknown keys out of the column and bounds how much a user can store.
//
// `values`, where present, restricts a string setting to a fixed list. A stored value
// outside that list falls back to the default, so removing a theme later cannot leave
// an account stuck on something that no longer exists.
const SETTING_SPEC = {
  // Whether a correct answer moves on by itself, or waits for a press.
  autoAdvance: { type: 'boolean', default: true },

  // Colour scheme. "garden" is the cream and green default; "night" is the original
  // dark scheme, kept as an option.
  theme: { type: 'string', default: 'garden', values: ['garden', 'night'] },
};

function isAllowed(spec, value) {
  if (typeof value !== spec.type) return false;
  if (spec.values && !spec.values.includes(value)) return false;
  return true;
}

// Stored settings merged over the defaults, so a user created before a setting existed
// still gets a complete object and the client never has to guess.
function withDefaults(stored) {
  const settings = {};
  for (const [key, spec] of Object.entries(SETTING_SPEC)) {
    const value = stored && typeof stored === 'object' ? stored[key] : undefined;
    settings[key] = isAllowed(spec, value) ? value : spec.default;
  }
  return settings;
}

// Validates a patch body into a partial settings object. Throws for an unknown key or
// an unacceptable value rather than silently dropping it, so a client bug is visible.
function validatePatch(body, bad) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('Settings must be an object.');
  }
  const keys = Object.keys(body);
  if (keys.length === 0) throw bad('No settings were given.');

  const patch = {};
  for (const key of keys) {
    const spec = SETTING_SPEC[key];
    if (!spec) throw bad(`Unknown setting "${key}".`);
    if (typeof body[key] !== spec.type) throw bad(`Setting "${key}" must be a ${spec.type}.`);
    if (spec.values && !spec.values.includes(body[key])) {
      throw bad(`Setting "${key}" must be one of: ${spec.values.join(', ')}.`);
    }
    patch[key] = body[key];
  }
  return patch;
}

module.exports = { SETTING_SPEC, withDefaults, validatePatch };
