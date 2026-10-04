require('dotenv').config();

const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Seconds a LEIA session, and everything the runner stores for it in Redis,
 * lives after its last activity. SESSION_TTL_SECONDS=0 disables expiration.
 * Read on every call so a change in the environment applies without restart.
 * @returns {number}
 */
function getSessionTtlSeconds() {
  const rawValue = process.env.SESSION_TTL_SECONDS;

  if (rawValue === undefined || rawValue.trim() === '') {
    return DEFAULT_SESSION_TTL_SECONDS;
  }

  const parsed = Number.parseInt(rawValue, 10);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SESSION_TTL_SECONDS;
}

module.exports = {
  DEFAULT_SESSION_TTL_SECONDS,
  getSessionTtlSeconds,
};
