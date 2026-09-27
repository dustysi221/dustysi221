'use strict';

/**
 * Keeps engineer text glanceable. The prompts ask Claude for short answers;
 * this is the backstop when an answer still runs long.
 */

/**
 * Trim `text` to at most `maxWords` words. Prefers to stop at the end of a
 * sentence; otherwise cuts at the word limit and adds an ellipsis.
 */
function limitWords(text, maxWords) {
  if (typeof text !== 'string') return '';
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  const cut = words.slice(0, maxWords).join(' ');
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (cut.endsWith('.') || cut.endsWith('!') || cut.endsWith('?')) return cut;
  if (lastStop > cut.length / 3) return cut.slice(0, lastStop + 1);
  return cut.replace(/[,;:\-–]+$/, '') + '…';
}

module.exports = { limitWords };
