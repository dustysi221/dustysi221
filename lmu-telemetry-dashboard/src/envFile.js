'use strict';

/**
 * Small, careful .env editor used by the Control Panel: changes or adds
 * KEY=value lines and leaves every other line (comments, other settings,
 * blank lines) exactly as it was.
 */

const fs = require('fs');

/**
 * @param {string} text     current file contents
 * @param {object} updates  { KEY: value }; null/undefined removes the line
 * @returns {string} new file contents
 */
function applyEnvUpdates(text, updates) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid setting name: ${key}`);
    const matcher = new RegExp(`^\\s*${key}\\s*=`);
    const index = lines.findIndex((l) => matcher.test(l));
    if (value === null || value === undefined) {
      if (index >= 0) lines.splice(index, 1);
      continue;
    }
    const clean = String(value).replace(/[\r\n]/g, '');
    const line = `${key}=${clean}`;
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  }
  return lines.join(eol) + eol;
}

/** Apply updates to the .env file at `filePath` (created if missing). */
function updateEnvFile(filePath, updates) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // Strip a UTF-8 byte order mark that some editors add
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  fs.writeFileSync(filePath, applyEnvUpdates(text, updates), 'utf8');
}

module.exports = { applyEnvUpdates, updateEnvFile };
