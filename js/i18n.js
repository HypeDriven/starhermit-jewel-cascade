/* Jewel Cascade — localization runtime (classic script, window.JCI18N).
 *
 * Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
 * English source strings are the keys; js/strings.js holds the tables (en-GB,
 * es-ES and fr-CA carry only their differences from en-US, es-419 and fr-FR).
 * The locale comes from the game's Language setting through sh-language.js
 * (explicit choice → StarHermit account preference → navigator.languages →
 * en-US); ?lang= forces one for the page load (QA links) and hides the selector.
 *
 * Static markup in index.html is translated in place: text nodes and
 * aria-label/title/placeholder whose English text is a key. Code uses T() for
 * text it shows once and L()/bindText() for text that must follow a later
 * language change (bound nodes re-render in place; nothing is rebuilt).
 * `jc-language` fires on document after every change.
 */
(function (root) {
  'use strict';

  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  var TABLES = root.JC_STRINGS || {};
  var ATTRS = ['aria-label', 'title', 'placeholder'];
  var hasOwn = Object.prototype.hasOwnProperty;
  var lang = 'en-US';

  function lookup(key) {
    for (var l = lang; l; l = PARENT[l]) {
      var t = TABLES[l];
      if (t && hasOwn.call(t, key)) return t[key];
    }
    return key;
  }
  function text(x) { return x == null ? '' : typeof x === 'function' ? text(x()) : String(x); }
  /** Translate an English source string; {name} placeholders come from vars (messages render too). */
  function T(key, vars) {
    var s = lookup(String(key));
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return hasOwn.call(vars, k) ? text(vars[k]) : m; });
    return s;
  }
  /** A deferred message: renders in the current language whenever it is shown. */
  function L(key, vars) { return function () { return T(key, vars); }; }

  function paint(node, slot, x) {
    var v = text(x);
    if (slot === 'text') { if (node.textContent !== v) node.textContent = v; }
    else if (node.getAttribute(slot) !== v) node.setAttribute(slot, v);
  }
  /** Set a node's text (or an attribute); a message (function) keeps following the language. */
  function bindText(node, x, slot) {
    slot = slot || 'text';
    if (typeof x === 'function') {
      if (!node.__jcI18n) { node.__jcI18n = {}; node.setAttribute('data-jc-i18n', ''); }
      node.__jcI18n[slot] = x;
    } else if (node.__jcI18n) delete node.__jcI18n[slot];
    paint(node, slot, x);
  }

  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function known(key) { return hasOwn.call(TABLES['es-419'] || {}, key); }

  // ---- static markup -------------------------------------------------------
  var texts = [], attrs = [], scanned = false;
  function skipped(el) {
    for (var n = el; n && n !== document.body; n = n.parentNode) {
      if (n.nodeType === 1 && (n.hasAttribute('data-i18n-skip') || n.hasAttribute('data-jc-i18n') || (n.classList && n.classList.contains('game-options-controls')) || n.tagName === 'SCRIPT' || n.tagName === 'STYLE' || n.tagName === 'NOSCRIPT' || n.tagName === 'KBD')) return true;
    }
    return false;
  }
  function scan() {
    if (scanned || !document.body) return;
    scanned = true;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var key = norm(node.nodeValue);
      if (!/[A-Za-z]/.test(key) || !known(key) || skipped(node.parentNode)) continue;
      var m = /^(\s*)[\s\S]*?(\s*)$/.exec(node.nodeValue);
      texts.push({ node: node, key: key, pre: m[1], post: m[2], last: node.nodeValue });
    }
    var els = document.body.querySelectorAll('[' + ATTRS.join('],[') + ']');
    for (var j = 0; j < els.length; j++) {
      if (skipped(els[j])) continue;
      for (var a = 0; a < ATTRS.length; a++) {
        var v = els[j].getAttribute(ATTRS[a]);
        if (v && /[A-Za-z]/.test(v) && known(norm(v))) attrs.push({ el: els[j], attr: ATTRS[a], key: norm(v), last: v });
      }
    }
  }
  /** Re-apply the language to static markup (text the game has since replaced is skipped) and bound nodes. */
  function relabel() {
    if (typeof document === 'undefined' || !document.body) return;
    scan();
    texts.forEach(function (t) {
      if (!t.node.parentNode || t.node.nodeValue !== t.last) return;
      t.last = t.node.nodeValue = t.pre + T(t.key) + t.post;
    });
    attrs.forEach(function (a) {
      if (a.el.getAttribute(a.attr) !== a.last) return;
      a.last = T(a.key);
      a.el.setAttribute(a.attr, a.last);
    });
    var nodes = document.querySelectorAll('[data-jc-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var map = nodes[i].__jcI18n;
      if (map) for (var slot in map) paint(nodes[i], slot, map[slot]);
    }
  }

  function setLocale(next) {
    lang = LOCALES.indexOf(next) >= 0 ? next : 'en-US';
    if (typeof document === 'undefined') return;
    document.documentElement.lang = lang;
    relabel();
    document.dispatchEvent(new CustomEvent('jc-language', { detail: { lang: lang } }));
  }

  var forced = null;
  try { forced = new URLSearchParams(root.location.search).get('lang'); } catch (e) { /* opaque origin */ }
  var SL = root.StarHermitLanguage;
  var forcedLocale = forced && SL ? SL.match(forced, LOCALES) : null;
  var language = SL ? SL.create({
    game: 'jewel-cascade', supported: LOCALES, panel: !forcedLocale,
    apply: function (locale) { setLocale(forcedLocale || locale); }
  }) : null;
  if (!language) setLocale('en-US');
  if (typeof document !== 'undefined' && !document.body) document.addEventListener('DOMContentLoaded', relabel);

  root.JCI18N = {
    T: T, L: L, text: text, bindText: bindText, relabel: relabel,
    get lang() { return lang; },
    locales: LOCALES, language: language, tables: TABLES
  };
})(typeof self !== 'undefined' ? self : this);
