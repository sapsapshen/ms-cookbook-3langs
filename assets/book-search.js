(function (root) {
  'use strict';
  const normalize = value => String(value || '').normalize('NFKC').toLowerCase();
  const cache = new WeakMap();
  function fields(document) {
    if (!cache.has(document)) {
      const text = document.text.replace(/\s+/g, ' ').trim();
      cache.set(document, {
        title: normalize(document.title), heading: normalize(document.heading),
        body: normalize(text), text,
        number: `第${document.number}章 第 ${document.number} 章 chapter-${document.number}`
      });
    }
    return cache.get(document);
  }
  function search(documents, query, limit = 40) {
    const tokens = [...new Set(normalize(query).trim().split(/\s+/).filter(Boolean))];
    if (!tokens.length) return {results: [], total: 0};
    const matches = [];
    for (const document of documents) {
      const f = fields(document);
      const all = `${f.title} ${f.heading} ${f.body} ${f.number}`;
      if (!tokens.every(token => all.includes(token))) continue;
      // A chapter-title match should not flood results with every section in that chapter.
      if (document.headingId && !tokens.some(token => `${f.heading} ${f.body}`.includes(token))) continue;
      const score = tokens.reduce((sum, token) => sum +
        (!document.headingId && f.title.includes(token) ? 100 : 0) +
        (f.heading.includes(token) ? 40 : 0) + (f.body.includes(token) ? 5 : 0), 0);
      const positions = tokens.map(token => f.body.indexOf(token)).filter(position => position >= 0);
      const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 36);
      const snippet = (start ? '…' : '') + f.text.slice(start, start + 150) + (f.text.length > start + 150 ? '…' : '');
      matches.push({...document, snippet, score});
    }
    matches.sort((a, b) => b.score - a.score || a.number - b.number);
    return {results: matches.slice(0, limit), total: matches.length};
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {search};
  else root.BookSearch = {search};
})(typeof window !== 'undefined' ? window : globalThis);
