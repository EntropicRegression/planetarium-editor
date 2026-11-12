// Interface language. The editor is written in Traditional Chinese; js/i18n-en.js maps each
// Chinese string to English. Loaded before every other script.
//
//   t`已開啟「${name}」`     in scripts: a tagged template; the lookup key is the text with each
//                           value replaced by {} ("已開啟「{}」").
//   translatePage()         for index.html: replaces text and title / placeholder / aria-label
//                           attributes that have a translation.
//
// A string without a translation is shown in Chinese rather than left blank.
(function () {
  'use strict';

  const STORE = 'spatialEditor.lang';
  let lang = 'zh';
  try {
    lang = localStorage.getItem(STORE) || '';
  } catch (error) {
    lang = '';
  }
  if (lang !== 'zh' && lang !== 'en') {
    lang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  const dictionary = () => (lang === 'en' && window.WallI18nEn) || null;

  function t(strings, ...values) {
    // Also callable as t('text').
    if (typeof strings === 'string') {
      const table = dictionary();
      return (table && table[strings]) || strings;
    }
    const table = dictionary();
    const pattern = table && table[strings.join('{}')];
    if (!pattern) return strings.reduce((out, part, i) => out + part + (i < values.length ? values[i] : ''), '');
    let i = 0;
    return pattern.replace(/\{\}/g, () => (i < values.length ? values[i++] : ''));
  }

  function translatePage() {
    const table = dictionary();
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
    if (!table) return;
    const lookup = (text) => table[text.trim().replace(/\s+/g, ' ')];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!node.nodeValue.trim() || node.parentElement.closest('script, style')) continue;
      const translated = lookup(node.nodeValue);
      // Leading and trailing spaces separate the text from neighbouring controls; keep them.
      if (translated) node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), translated);
    }
    for (const el of document.querySelectorAll('[title], [placeholder], [aria-label], [data-suggest]')) {
      for (const name of ['title', 'placeholder', 'aria-label', 'data-suggest']) {
        const value = el.getAttribute(name);
        const translated = value && lookup(value);
        if (translated) el.setAttribute(name, translated);
      }
    }
  }

  window.WallI18n = {
    t,
    translatePage,
    get lang() {
      return lang;
    },
    /** Switches language. Strings are resolved as the scripts start, so the page reloads. */
    setLang(next) {
      try {
        localStorage.setItem(STORE, next);
      } catch (error) {
        // Without storage the choice cannot outlive the reload; nothing else to do.
      }
      location.reload();
    },
  };
})();
