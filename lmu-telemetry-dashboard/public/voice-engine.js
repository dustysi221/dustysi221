/**
 * Push-to-talk voice for the dashboard using only the browser's built-in Web
 * Speech API: SpeechRecognition for speech-to-text and speechSynthesis for
 * text-to-speech. No external or paid services.
 *
 *   const voice = new VoiceEngine({ lang: 'en-US' });
 *   await voice.enable();            // once, from a click: mic permission + unlocks audio
 *   voice.startListening();          // push-to-talk down
 *   voice.stopListening();           // push-to-talk up -> 'final' event with the transcript
 *   voice.speak('Copy that, box this lap.');
 *
 * Events (CustomEvent.detail):
 *   'state'   { state: 'idle' | 'listening' | 'processing' | 'speaking' }
 *   'interim' { text }            live transcript while talking
 *   'final'   { text, alternatives }  what was heard once the button is released ('' if nothing),
 *                                     plus the recognizer's other guesses
 *   'error'   { code, message }
 *
 * Browser notes: Chrome and Edge support SpeechRecognition (they send the audio
 * to their own free speech service, so it needs an internet connection).
 * Firefox has no SpeechRecognition. Browsers only allow speech output after the
 * page has been clicked once, which is what enable() is for.
 */
(function (global) {
  'use strict';

  const Recognition = global.SpeechRecognition || global.webkitSpeechRecognition;
  const MIN_PRESS_MS = 250; // shorter presses are treated as accidental
  const MAX_LISTEN_MS = 20000; // stop automatically if the button is held too long

  const ERROR_MESSAGES = {
    'not-allowed': 'Microphone blocked. Allow microphone access for this page in the browser.',
    'service-not-allowed': 'Speech recognition is blocked in this browser.',
    'audio-capture': 'No microphone found.',
    network: 'Speech recognition needs an internet connection.',
    'no-speech': 'Didn’t catch that.',
    'language-not-supported': 'Speech recognition doesn’t support this language.',
  };

  class VoiceEngine extends EventTarget {
    constructor({ lang, voiceName = null, rate = 1.1, volume = 1 } = {}) {
      super();
      this.lang = lang || navigator.language || 'en-US';
      this.voiceName = voiceName;
      this.rate = rate;
      this.volume = volume;
      this.sttSupported = Boolean(Recognition);
      this.ttsSupported = 'speechSynthesis' in global;
      this.enabled = false;
      this.state = 'idle';

      this.rec = null;
      this.finalText = '';
      this.finalSegments = []; // per final result: [best guess, alternative, ...]
      this.interimText = '';
      this.listenStartedAt = 0;
      this.discard = false;
      this.maxTimer = null;

      if (this.ttsSupported) {
        // Voices load asynchronously in Chrome
        speechSynthesis.addEventListener?.('voiceschanged', () => this.#emit('voices', {}));
      }
    }

    /** Call from a click: asks for the microphone and unlocks speech output. */
    async enable() {
      if (navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
        } catch (err) {
          this.#error('not-allowed');
          throw err;
        }
      }
      if (this.ttsSupported) {
        // A silent utterance inside the click counts as the user's permission to speak
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      }
      this.enabled = true;
      this.#emit('enabled', {});
    }

    // ---------------------------------------------------------------- STT

    startListening() {
      if (!this.sttSupported) {
        this.#error('unsupported', 'This browser has no speech recognition. Use Chrome or Edge.');
        return;
      }
      if (this.state === 'speaking') this.stopSpeaking();
      if (this.rec) {
        // A previous recognition is still finishing; drop it
        this.rec.onend = null;
        this.rec.onresult = null;
        this.rec.onerror = null;
        try {
          this.rec.abort();
        } catch {}
        this.rec = null;
      }

      const rec = new Recognition();
      rec.lang = this.lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 3; // other guesses help the engineer decode misheard words

      this.finalText = '';
      this.finalSegments = [];
      this.interimText = '';
      this.discard = false;
      this.listenStartedAt = Date.now();

      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) {
            this.finalText += r[0].transcript;
            this.finalSegments.push(Array.from({ length: r.length }, (_, j) => r[j].transcript));
          } else {
            interim += r[0].transcript;
          }
        }
        this.interimText = interim;
        this.#emit('interim', { text: (this.finalText + ' ' + interim).trim() });
      };
      rec.onerror = (e) => {
        if (e.error === 'aborted') return;
        if (e.error === 'no-speech') return; // reported as an empty 'final' on end
        this.discard = true;
        this.#error(e.error);
      };
      rec.onend = () => {
        clearTimeout(this.maxTimer);
        this.rec = null;
        const text = (this.finalText + ' ' + this.interimText).replace(/\s+/g, ' ').trim();
        if (this.discard) {
          this.#setState('idle');
          return;
        }
        this.#setState('idle');
        this.#emit('final', { text, alternatives: this.#alternatives(text) });
      };

      try {
        rec.start();
      } catch (err) {
        this.#error('start-failed', `Couldn’t start the microphone: ${err.message}`);
        return;
      }
      this.rec = rec;
      this.#setState('listening');
      this.maxTimer = setTimeout(() => this.stopListening(), MAX_LISTEN_MS);
    }

    /** Full-sentence alternatives built from each final result's other guesses. */
    #alternatives(best) {
      const out = [];
      for (let k = 1; k < 3; k++) {
        if (!this.finalSegments.some((seg) => seg[k])) continue;
        const alt = (this.finalSegments.map((seg) => seg[k] || seg[0]).join(' ') + ' ' + this.interimText)
          .replace(/\s+/g, ' ')
          .trim();
        if (alt && alt !== best && !out.includes(alt)) out.push(alt);
      }
      return out;
    }

    /** Stop recording; the transcript arrives as a 'final' event shortly after. */
    stopListening() {
      if (!this.rec) return;
      clearTimeout(this.maxTimer);
      if (Date.now() - this.listenStartedAt < MIN_PRESS_MS) {
        this.discard = true;
        try {
          this.rec.abort();
        } catch {}
        return;
      }
      this.#setState('processing');
      try {
        this.rec.stop();
      } catch {}
    }

    get listening() {
      return this.state === 'listening';
    }

    // ---------------------------------------------------------------- TTS

    voices() {
      if (!this.ttsSupported) return [];
      return speechSynthesis.getVoices();
    }

    /** The saved voice, else a natural-sounding voice in the dashboard's language. */
    pickVoice() {
      const voices = this.voices();
      if (!voices.length) return null;
      if (this.voiceName) {
        const saved = voices.find((v) => v.name === this.voiceName);
        if (saved) return saved;
      }
      const base = this.lang.split('-')[0].toLowerCase();
      const same = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(base));
      const pool = same.length ? same : voices;
      return (
        pool.find((v) => /natural|online/i.test(v.name)) || // Edge's free neural voices
        pool.find((v) => /google/i.test(v.name)) ||
        pool.find((v) => v.default) ||
        pool[0]
      );
    }

    /** Speak `text`, interrupting anything already being said. */
    speak(text) {
      if (!this.ttsSupported || !text) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(speakable(text));
      u.lang = this.lang;
      const v = this.pickVoice();
      if (v) {
        try {
          u.voice = v;
          u.lang = v.lang;
        } catch {
          // not a usable voice object; fall back to the browser default
        }
      }
      u.rate = this.rate;
      u.volume = this.volume;
      u.onstart = () => this.#setState('speaking');
      u.onend = () => {
        if (this.state === 'speaking') this.#setState('idle');
      };
      u.onerror = (e) => {
        if (this.state === 'speaking') this.#setState('idle');
        if (e.error === 'not-allowed') this.#error('tts-blocked', 'Click “Enable voice” once so the browser allows speech.');
      };
      try {
        speechSynthesis.speak(u);
      } catch (err) {
        this.#error('tts-failed', `Couldn’t play the reply: ${err.message}`);
      }
    }

    stopSpeaking() {
      if (this.ttsSupported) speechSynthesis.cancel();
      if (this.state === 'speaking') this.#setState('idle');
    }

    // ---------------------------------------------------------------- helpers

    #setState(state) {
      if (this.state === state) return;
      this.state = state;
      this.#emit('state', { state });
    }

    #error(code, message) {
      this.#emit('error', { code, message: message || ERROR_MESSAGES[code] || `Voice error: ${code}` });
    }

    #emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }

  /** Make engineer text read naturally: expand units and tire codes. */
  function speakable(text) {
    return String(text)
      .replace(/(\d)\s*°\s*C\b/g, '$1 degrees')
      .replace(/°/g, ' degrees')
      .replace(/(\d)\s*%/g, '$1 percent')
      .replace(/\bL\/lap\b/gi, 'liters a lap')
      .replace(/(\d)\s*L\b/g, '$1 liters')
      .replace(/\bPSI\b/g, 'P S I')
      .replace(/\bFL\b/g, 'front left')
      .replace(/\bFR\b/g, 'front right')
      .replace(/\bRL\b/g, 'rear left')
      .replace(/\bRR\b/g, 'rear right')
      .replace(/\bP(\d+)\b/g, 'P $1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  VoiceEngine.speakable = speakable;
  global.VoiceEngine = VoiceEngine;
})(window);
