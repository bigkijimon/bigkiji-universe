'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCALE_DIR = path.join(ROOT, 'i18n', 'translations');
const DEFAULT_LANG = 'en';

let currentLang = DEFAULT_LANG;
let translations = {};

function loadTranslation(lang) {
  try {
    const filePath = path.join(LOCALE_DIR, `${lang}.json`);
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.warn(`[i18n] Failed to load ${lang} translations:`, error.message);
    return {};
  }
}

function loadAll() {
  try {
    for (const file of fs.readdirSync(LOCALE_DIR)) {
      if (file.endsWith('.json')) {
        const lang = file.replace('.json', '');
        translations[lang] = loadTranslation(lang);
      }
    }
  } catch (_) {}
}

function setLanguage(lang) {
  if (lang !== 'en' && lang !== 'ja') lang = DEFAULT_LANG;
  currentLang = lang;
  if (!translations[lang]) translations[lang] = loadTranslation(lang);
  return currentLang;
}

function t(key, fallback = '') {
  const value = translations[currentLang]?.[key];
  return value || fallback || key;
}

function translate(key, params = {}) {
  let text = t(key);
  for (const [key, value] of Object.entries(params)) {
    text = text.replace(new RegExp(`{${key}}`, 'g'), String(value));
  }
  return text;
}

function init({ defaultLang = DEFAULT_LANG } = {}) {
  currentLang = defaultLang;
  loadAll();
}

init();

module.exports = { t, translate, setLanguage, setLanguage, loadAll, currentLang: () => currentLang };