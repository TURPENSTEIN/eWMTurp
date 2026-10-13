'use strict';

/*
 * Custom Words for the session — purely additive, session-only feature.
 *
 * Design constraints (deliberate):
 * - NOTHING existing is modified: no built-in bank is mutated, no engine
 *   method is rewritten, no setting is persisted. This file only ADDS a new
 *   in-memory list plus a thin wrapper around block generation.
 * - Session-only: the list lives in this page's memory. It is never written
 *   to localStorage/IndexedDB, never added to App.getPersistentControlIds(),
 *   and starts empty on every reload.
 * - n-back integrity: audio matches are index-based, so the wrapper rebuilds
 *   ONLY the audio index sequence against an extended (built-in + custom)
 *   pool using the engine's own genSequence() with the session's live
 *   matchRate/interference settings. Target/lure structure is preserved by
 *   construction; only the surface words change.
 * - Custom words without MP3s fall through AudioEngine to speech synthesis,
 *   which is the existing recoverable path — no audio changes needed.
 */

(function () {
  var MAX_WORDS = 50;
  var MAX_LEN = 24;

  // The session list. Plain array in memory; nothing persists it.
  var list = [];

  function normalize(raw) {
    return String(raw == null ? '' : raw)
      .trim()
      .replace(/\s+/g, ' ')
      .toUpperCase()
      .slice(0, MAX_LEN);
  }

  function isValid(word) {
    return /^[A-Z0-9 '\-]{1,24}$/.test(word);
  }

  function builtInSet() {
    var set = Object.create(null);
    try {
      (AFFECTIVE_AUDIO_WORDS || []).forEach(function (w) {
        set[String(w).toUpperCase()] = true;
      });
    } catch (e) {}
    return set;
  }

  function isEnabled() {
    var el = document.getElementById('chk-custom-words');
    return !!(el && el.checked);
  }

  function getList() {
    return list.slice();
  }

  function render() {
    var box = document.getElementById('list-custom-words');
    var count = document.getElementById('custom-words-count');
    var note = document.getElementById('custom-words-note');
    if (box) {
      box.replaceChildren();
      list.forEach(function (word) {
        var chip = document.createElement('span');
        chip.className = 'custom-word-chip';
        chip.textContent = word;
        var x = document.createElement('button');
        x.type = 'button';
        x.textContent = '\u00D7';
        x.setAttribute('aria-label', 'Remove ' + word);
        x.addEventListener('click', function () { remove(word); });
        chip.appendChild(x);
        box.appendChild(chip);
      });
    }
    if (count) {
      count.textContent = list.length + (list.length === 1 ? ' word' : ' words') + ' for this session';
    }
    if (note) {
      if (!list.length) {
        note.textContent = 'Off until you enable the toggle above. Added words join the audio pool for blocks generated while enabled.';
      } else if (!isEnabled()) {
        note.textContent = list.length + ' word(s) ready, but the toggle is off — enable it before starting a session to use them.';
      } else {
        note.textContent = list.length + ' word(s) will join the audio pool for blocks generated while enabled. Session only — nothing is saved.';
      }
    }
  }

  function setNote(text) {
    var note = document.getElementById('custom-words-note');
    if (note && text) note.textContent = text;
  }

  function add(raw) {
    var word = normalize(raw);
    if (!word) { setNote('Type a word first.'); return false; }
    if (!isValid(word)) { setNote('Letters, numbers, spaces, apostrophes and hyphens only.'); return false; }
    if (list.indexOf(word) !== -1) { setNote('"' + word + '" is already in your session list.'); return false; }
    if (builtInSet()[word]) { setNote('"' + word + '" is already in the built-in pool — no need to add it.'); return false; }
    if (list.length >= MAX_WORDS) { setNote('Session list is full (' + MAX_WORDS + ' words).'); return false; }
    list.push(word);
    render();
    return true;
  }

  function remove(word) {
    var i = list.indexOf(word);
    if (i !== -1) list.splice(i, 1);
    render();
  }

  function clear() {
    list = [];
    render();
  }

  function bindUI() {
    var input = document.getElementById('inp-custom-word');
    var addBtn = document.getElementById('btn-add-custom-word');
    var clearBtn = document.getElementById('btn-clear-custom-words');
    var toggle = document.getElementById('chk-custom-words');
    if (addBtn) addBtn.addEventListener('click', function () {
      if (input) {
        if (add(input.value)) input.value = '';
        input.focus();
      }
    });
    if (input) input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (add(input.value)) input.value = '';
      }
    });
    if (clearBtn) clearBtn.addEventListener('click', function () { clear(); });
    if (toggle) toggle.addEventListener('change', function () { render(); });
    render();
  }

  /*
   * Additive hook: run the original block builder untouched, then rebuild
   * ONLY the audio index sequence against built-in + session-custom words.
   * Guarded so including this file twice still wraps exactly once.
   */
  function installHook() {
    if (typeof GameEngine === 'undefined') return false;
    var proto = GameEngine.prototype;
    if (!proto || typeof proto.generateBlock !== 'function') return false;
    if (proto.generateBlock.__sessionCustomWordsWrapped) return true;
    var original = proto.generateBlock;
    var wrapped = function () {
      var result = original.apply(this, arguments);
      try {
        if (!isEnabled() || !list.length) return result;
        var s = this.getSettings();
        var pool = (AFFECTIVE_AUDIO_WORDS || []).concat(list);
        var seq = this.genSequence(pool.length, this.kSeq, s.matchRate, s.interference / 100);
        for (var i = 0; i < this.trials.length && i < seq.length; i++) {
          this.trials[i].aud = seq[i];
          this.trials[i].audWord = pool[seq[i]];
          // Session custom words may also surface as passive interference
          // distractors while Word Interference is on. Passive only: it never
          // creates a response target (render path unchanged).
          if (s.wordInterference && this.trials[i].wordInterference && list.length && Math.random() < 0.5) {
            this.trials[i].wordInterference = list[Math.floor(Math.random() * list.length)];
          }
        }
      } catch (e) {
        console.warn('[CustomWords] session pool hook skipped a block:', e);
      }
      return result;
    };
    wrapped.__sessionCustomWordsWrapped = true;
    proto.generateBlock = wrapped;
    return true;
  }

  // Exposed for debugging; the list itself is intentionally not persisted.
  window.SessionCustomWords = {
    add: add,
    remove: remove,
    clear: clear,
    list: getList,
    isEnabled: isEnabled
  };

  if (!installHook()) {
    document.addEventListener('DOMContentLoaded', installHook, { once: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUI, { once: true });
  } else {
    bindUI();
  }
})();
