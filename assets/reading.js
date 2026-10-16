(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const t = window.MSI18N.t;
  const chapters = new Map(window.BOOK_DATA.chapters.map(c => [c.id, c]));
  const storageKey = 'ms-cookbook.reading.v1';
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch {}
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) preferences = {};
  function persist() { try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch {} }
  function search() { $('#readerSearchButton').click(); }
  document.querySelectorAll('[data-reader-search]').forEach(button => button.addEventListener('click', search));
  const size = [17, 19, 21].includes(Number(preferences.size)) ? Number(preferences.size) : 19;
  $('#readingSize').value = String(size);
  document.documentElement.style.setProperty('--reading-size', size + 'px');
  $('#readingSize').addEventListener('change', event => {
    preferences.size = Number(event.target.value);
    document.documentElement.style.setProperty('--reading-size', preferences.size + 'px');
    persist();
  });
  function setFocus(enabled) {
    document.body.dataset.focus = String(enabled);
    $('#focusReading').setAttribute('aria-pressed', String(enabled));
    $('#focusReading').textContent = enabled ? t('reader.exitFocus') : t('reader.focus');
  }
  setFocus(preferences.focus === true);
  $('#focusReading').addEventListener('click', () => {
    preferences.focus = document.body.dataset.focus !== 'true';
    setFocus(preferences.focus); persist();
  });
  window.MSI18N.on(() => setFocus(document.body.dataset.focus === 'true'));
  function savePosition() {
    if (document.body.dataset.view !== 'reader') return;
    const chapter = chapters.get(location.hash.slice(1).split('?')[0].split('/')[0]);
    if (!chapter || chapter.status === 'pending') return;
    let heading = '';
    chapter.headings.forEach(item => {
      const el = document.getElementById(item.id);
      if (el && el.getBoundingClientRect().top <= window.innerHeight * .24) heading = item.id;
    });
    preferences.last = { chapter: chapter.id, heading };
    persist();
    const percent = Math.round(parseFloat($('#readingProgress').style.width) || 0);
    $('#readingPercent').textContent = percent + '%';
  }
  let timer;
  window.addEventListener('scroll', () => {
    clearTimeout(timer); timer = setTimeout(savePosition, 180);
  }, { passive: true });
  window.addEventListener('hashchange', () => {
    clearTimeout(timer);
    requestAnimationFrame(savePosition);
  });
  window.addEventListener('pagehide', savePosition);
  requestAnimationFrame(savePosition);
})();
