"""Build the translated editions of the article prose.

Chinese is the source of truth for every chapter; the translated prose lives in
content/i18n/<language>/<chapter>.json keyed by the index of the translatable block
inside that chapter. Blocks are extracted from assets/content.js with the same rules
the reader uses at runtime (leaf blocks, never inside <pre>), so a translation can
never shift an anchor, a code block or a table cell.

Usage:
    python3 scripts/build-i18n.py            # regenerate assets/content-i18n/*.js
    python3 scripts/build-i18n.py --extract  # dump the indexed source blocks
    python3 scripts/build-i18n.py --check    # verify the generated files are current
"""
from __future__ import annotations
import argparse
import html
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / 'content' / 'i18n'
OUTPUT = ROOT / 'assets' / 'content-i18n'
LANGUAGES = ('en', 'es')
BLOCKS = {'p', 'li', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'td', 'th', 'figcaption', 'dt', 'dd'}
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
SPACE = re.compile(r'\s+')


class Node:
    """An element whose content keeps text and child elements in document order."""

    __slots__ = ('tag', 'content', 'inner')

    def __init__(self, tag):
        self.tag = tag
        self.content = []
        self.inner = ''


class Tree(HTMLParser):
    """Collects elements and, for --extract, the raw inner markup of each block."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node('#root')
        self.stack = [self.root]
        self.opens = []          # offset just after each open tag
        self.src = ''

    def feed(self, data):
        self.src = data
        self._line_starts = [0]
        for index, char in enumerate(data):
            if char == '\n':
                self._line_starts.append(index + 1)
        super().feed(data)

    def position(self):
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def tag_end(self, start):
        quote = ''
        index = start
        while index < len(self.src):
            char = self.src[index]
            if quote:
                if char == quote:
                    quote = ''
            elif char in '"\'':
                quote = char
            elif char == '>':
                return index
            index += 1
        return len(self.src) - 1

    def handle_starttag(self, tag, attrs):
        start = self.position()
        node = Node(tag)
        self.stack[-1].content.append(node)
        if tag not in VOID:
            self.stack.append(node)
            self.opens.append(self.tag_end(start))

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].content.append(Node(tag))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                if len(self.opens) >= index:
                    node = self.stack[index]
                    node.inner = self.src[self.opens[index - 1] + 1:self.position()]
                    del self.opens[index - 1:]
                del self.stack[index:]
                return

    def handle_data(self, data):
        self.stack[-1].content.append(data)


def elements(node):
    return [item for item in node.content if isinstance(item, Node)]


def text_of(node):
    return ''.join(item if isinstance(item, str) else text_of(item) for item in node.content)


def has_block_child(node):
    return any(item.tag in BLOCKS or has_block_child(item) for item in elements(node))


def extract(markup):
    parser = Tree()
    parser.feed(markup)
    parser.close()
    rows = []
    seen = set()

    def add(tag, node):
        key = SPACE.sub(' ', text_of(node)).strip()
        if not key or key in seen:
            return
        seen.add(key)
        row = {'tag': tag, 'key': key, 'markup': bool(elements(node))}
        if row['markup']:
            row['html'] = node.inner
        rows.append(row)

    def walk(node, in_pre, in_block):
        for child in elements(node):
            if child.tag == 'pre':
                continue
            structural = child.tag in BLOCKS
            # A standalone attachment link sits directly under <figure>, outside any block.
            standalone_link = child.tag == 'a' and not in_block
            if not in_pre and not has_block_child(child) and (structural or standalone_link):
                add(child.tag, child)
                continue
            walk(child, in_pre or child.tag == 'pre', in_block or structural)

    walk(parser.root, False, False)
    return rows


def read_book():
    raw = (ROOT / 'assets' / 'content.js').read_text(encoding='utf-8')
    payload = raw.split('=', 1)[1].strip().rstrip(';')
    return json.loads(payload)


def translations_for(language, chapter_id, headings, rows):
    """Merge section-heading translations with the per-block prose translations."""
    values = {}
    folder = CONTENT / language
    heading_file = folder / 'headings.json'
    if heading_file.exists():
        catalog = json.loads(heading_file.read_text(encoding='utf-8'))
        for heading in headings:
            value = catalog.get(heading['id'])
            if value is None:
                continue
            key = SPACE.sub(' ', heading['text']).strip()
            if key:
                values[key] = value
    chapter_file = folder / f'{chapter_id}.json'
    if chapter_file.exists():
        authored = json.loads(chapter_file.read_text(encoding='utf-8'))
        for index, value in authored.items():
            if value is None:
                continue
            position = int(index)
            if position < 0 or position >= len(rows):
                raise SystemExit(f'{chapter_file}: index {index} is out of range for {chapter_id}')
            values[rows[position]['key']] = value
    return values


def build(check=False):
    book = read_book()
    rendered = {}
    coverage = {}
    for language in LANGUAGES:
        chapters = {}
        report = {}
        for chapter in book['chapters']:
            rows = extract(chapter['html'])
            values = translations_for(language, chapter['id'], chapter['headings'], rows)
            if not values:
                continue
            if len(values) >= len(rows):
                values = {**values, '__complete': True}
            chapters[chapter['id']] = values
            report[chapter['id']] = f'{len(values)}/{len(rows)}'
        body = json.dumps(chapters, ensure_ascii=False, indent=0, separators=(',', ':'))
        rendered[language] = (
            '/* Generated by scripts/build-i18n.py. Do not edit by hand; edit content/i18n/ instead.\n'
            f'   Translated prose for the {language} edition, keyed by chapter and by the exact Chinese\n'
            '   source block, so anchors, code blocks and markup stay identical to the published source. */\n'
            'window.MS_ARTICLE = window.MS_ARTICLE || {};\n'
            f'window.MS_ARTICLE.{language} = ' + body + ';\n'
        )
        coverage[language] = report
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for language in LANGUAGES:
        target = OUTPUT / f'{language}.js'
        if check:
            if not target.exists() or target.read_text(encoding='utf-8') != rendered[language]:
                raise SystemExit(f'{target.relative_to(ROOT)} is out of date. Run python3 scripts/build-i18n.py.')
        else:
            target.write_text(rendered[language], encoding='utf-8')
    blocks = 0
    done = 0
    for chapter in book['chapters']:
        rows = extract(chapter['html'])
        blocks += len(rows)
        if coverage['en'].get(chapter['id'], '0/0') == f'{len(rows)}/{len(rows)}':
            done += len(rows)
    print(f'blocks={blocks}; fully translated in en={done}; chapters touched: en={len(coverage["en"])} es={len(coverage["es"])}')
    return coverage



def extract_dump():
    book = read_book()
    target = ROOT / '.i18n-source'
    target.mkdir(exist_ok=True)
    total = 0
    for chapter in book['chapters']:
        rows = extract(chapter['html'])
        total += len(rows)
        lines = []
        for index, row in enumerate(rows):
            lines.append(f"{index}\t{row['tag']}\t{row['key']}\t{row.get('html', '-')}")
        (target / f"{chapter['id']}.tsv").write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'{len(book["chapters"])} chapters, {total} translatable blocks -> {target}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--extract', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.extract:
        extract_dump()
    else:
        build(check=args.check)
