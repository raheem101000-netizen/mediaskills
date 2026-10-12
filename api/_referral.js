const { randomInt } = require('crypto');

// Creator referral codes: 6 characters, uppercase letters and digits. New codes
// skip look-alike characters (0/O, 1/I) so they're easy to read out and type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// A ref code as sent by the page or the cookie, or null if it isn't one.
function normalizeRefCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

function generateReferralCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

module.exports = { normalizeRefCode, generateReferralCode };
