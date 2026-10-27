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

  /* ------------------------------------------------------------------ *
   * Word-pool source & share                                           *
   * ------------------------------------------------------------------ */
  // 'mix'      -> built-in pool + custom words, biased by the custom share
  // 'exclusive'-> custom words only (falls back to built-in if the list is empty)
  function source() {
    var el = document.getElementById('cw-source');
    return el ? el.value : 'mix';
  }
  function freq() {
    var el = document.getElementById('cw-freq');
    return el ? Number(el.value) : 50;
  }
  /*
   * Build the audio pool the block hook draws from, honouring the chosen
   * source and the custom share percentage. genSequence() still receives a
   * flat index pool, so the target/lure structure is preserved by
   * construction; only which word values can land at each index changes.
   */
  function buildPool() {
    var general = (AFFECTIVE_AUDIO_WORDS || []).slice();
    var mode = source();
    var f = freq();
    if (mode === 'exclusive') {
      return list.length ? list.slice() : general;
    }
    if (f <= 0) return general;
    if (f >= 100) return list.length ? list.slice() : general;
    // Bias the pool so custom words occupy roughly `f` percent of it.
    var targetCustom = Math.max(1, Math.round(general.length * f / (100 - f)));
    var reps = Math.max(1, Math.ceil(targetCustom / Math.max(1, list.length)));
    reps = Math.min(reps, 60);
    var weighted = [];
    list.forEach(function (w) { for (var r = 0; r < reps; r++) weighted.push(w); });
    return general.concat(weighted);
  }

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

  /* ------------------------------------------------------------------ *
   * Persistence (IndexedDB, same 'ewmturp' DB as the custom image decks) *
   * ------------------------------------------------------------------ */
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open('ewmturp', 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('custom-images')) db.createObjectStore('custom-images');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function loadPool() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('custom-images', 'readonly');
        var req = tx.objectStore('custom-images').get('custom-words-v1');
        req.onsuccess = function () {
          var data = req.result || {};
          list = Array.isArray(data.words) ? data.words.slice() : [];
          var modeSel = document.getElementById('cw-source');
          var freqSel = document.getElementById('cw-freq');
          var freqDisp = document.getElementById('cw-freq-disp');
          if (modeSel) modeSel.value = data.mode === 'exclusive' ? 'exclusive' : 'mix';
          if (freqSel) freqSel.value = Number.isFinite(data.freq) ? data.freq : 50;
          if (freqDisp) freqDisp.textContent = ((freqSel && freqSel.value) || 50) + '%';
          resolve();
        };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function (e) {
      list = [];
      console.warn('[CustomWords] could not load saved pool:', e);
    });
  }
  function savePool() {
    var modeSel = document.getElementById('cw-source');
    var freqSel = document.getElementById('cw-freq');
    var data = {
      words: list.slice(),
      mode: (modeSel && modeSel.value) ? modeSel.value : 'mix',
      freq: (freqSel && freqSel.value != null) ? Number(freqSel.value) : 50
    };
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('custom-images', 'readwrite');
        tx.objectStore('custom-images').put(data, 'custom-words-v1');
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function (e) {
      console.warn('[CustomWords] could not save pool:', e);
    });
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
    savePool();
    return true;
  }

  function remove(word) {
    var i = list.indexOf(word);
    if (i !== -1) list.splice(i, 1);
    render();
    savePool();
  }

  function clear() {
    list = [];
    render();
    savePool();
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
    var sourceSel = document.getElementById('cw-source');
    var freqSel = document.getElementById('cw-freq');
    var freqDisp = document.getElementById('cw-freq-disp');
    if (sourceSel) sourceSel.addEventListener('change', function () { render(); savePool(); });
    if (freqSel) {
      freqSel.addEventListener('input', function () { if (freqDisp) freqDisp.textContent = freqSel.value + '%'; });
      freqSel.addEventListener('change', function () { render(); savePool(); });
    }
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
        var mode = source();
        var pool = buildPool();
        var seq = this.genSequence(pool.length, this.kSeq, s.matchRate, s.interference / 100);
        for (var i = 0; i < this.trials.length && i < seq.length; i++) {
          this.trials[i].aud = seq[i];
          this.trials[i].audWord = pool[seq[i]];
          // Session custom words may also surface as passive interference
          // distractors while Word Interference is on. Passive only: it never
          // creates a response target (render path unchanged).
          if (s.wordInterference && this.trials[i].wordInterference) {
            var dPool = (mode === 'exclusive' && list.length) ? list : (AFFECTIVE_AUDIO_WORDS || []).concat(list);
            if (dPool.length && Math.random() < 0.5) {
              this.trials[i].wordInterference = dPool[Math.floor(Math.random() * dPool.length)];
            }
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

  function start() {
    installHook();
    loadPool().then(bindUI, bindUI);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
