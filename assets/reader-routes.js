(function (root) {
  'use strict';
  function pathStep(paths, key, chapterNumber) {
    if (!Object.hasOwn(paths, key)) return null;
    const path = paths[key];
    const index = path.chapters.indexOf(chapterNumber);
    if (index < 0) return null;
    return {key, name:path.name, index, total:path.chapters.length,
      previous:path.chapters[index - 1] ?? null, next:path.chapters[index + 1] ?? null};
  }
  function chapterHash(chapterId, headingId = '', pathKey = '') {
    return `#${chapterId}${headingId ? '/' + headingId : ''}${pathKey ? '?path=' + encodeURIComponent(pathKey) : ''}`;
  }
  function parseHash(hash, paths) {
    const [route, query = ''] = hash.replace(/^#/, '').split('?');
    const [name = 'home', sub = ''] = (route || 'home').split('/');
    const requested = new URLSearchParams(query).get('path') || '';
    const number = /^chapter-\d+$/.test(name) ? Number(name.slice(8)) : NaN;
    return {name, sub, pathKey:pathStep(paths, requested, number) ? requested : ''};
  }
  const api = {parseHash, chapterHash, pathStep};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReaderRoutes = api;
})(typeof window !== 'undefined' ? window : globalThis);
