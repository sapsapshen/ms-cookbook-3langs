/* Builds the Chinese / English / Spanish selector mounted on every page. */
(() => {
  'use strict';
  const NAMES = {zh: '简体中文', en: 'English', es: 'Español'};
  const $ = selector => document.querySelector(selector);

  function buildPicker() {
    const wrapper = document.createElement('label');
    wrapper.className = 'language-picker';
    wrapper.setAttribute('data-i18n-attr', 'title:common.language');

    const select = document.createElement('select');
    select.className = 'language-select';
    select.setAttribute('data-i18n-attr', 'aria-label:common.language');
    for (const code of window.MSI18N.codes) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = NAMES[code];
      select.append(option);
    }
    select.value = window.MSI18N.lang;
    select.addEventListener('change', () => window.MSI18N.set(select.value));
    wrapper.append(select);
    return wrapper;
  }

  function mount() {
    document.querySelectorAll('[data-language-switcher]:not([data-language-ready])').forEach(target => {
      target.dataset.languageReady = 'true';
      target.classList.add('language-switcher');
      target.append(buildPicker());
    });
    // Every mounted copy stays in sync with the shared language state.
    window.MSI18N.on(() => {
      $$('.language-select').forEach(select => {
        if (select.value !== window.MSI18N.lang) select.value = window.MSI18N.lang;
      });
    });
  }

  const $$ = selector => [...document.querySelectorAll(selector)];
  mount();
})();