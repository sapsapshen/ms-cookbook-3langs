"""产物不变量：正文图必须带内蕴尺寸，且每章只有首图抢占加载优先级。

这里守的是构建脚本真正写出的 `assets/content.js`，不是再解析一遍图片文件。
`check-site.mjs` 当然也核对尺寸，但它用同一族解析器读取同一批文件——构建脚本
回归时两侧会一起错；评审用变异回放证明「第二张图丢掉 lazy」时 check-site 静默
通过。这几条是那条 spec 约束（其余正文图保持 lazy）目前在 CI 里的唯一守卫。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ARTICLE_IMAGE = re.compile(r'<img\b[^>]*class="article-image"[^>]*>')
ANY_IMAGE = re.compile(r'<img\b[^>]*>')


def book_data():
    raw = (ROOT / 'assets' / 'content.js').read_text(encoding='utf-8')
    return json.loads(raw.split('=', 1)[1].strip().rstrip(';'))


def chapters_with_images():
    """[(chapter_number, [article-image tag, ...])] in document order."""
    chapters = []
    for chapter in book_data()['chapters']:
        tags = ARTICLE_IMAGE.findall(chapter['html'])
        # Tie the regex output to the count the build itself recorded: a pattern
        # that stopped matching would otherwise make every rule below vacuous.
        assert len(tags) == chapter['imageCount'], (
            f'chapter-{chapter["number"]}: matched {len(tags)} article images, '
            f'the build reports {chapter["imageCount"]}')
        assert len(ANY_IMAGE.findall(chapter['html'])) == len(tags), (
            f'chapter-{chapter["number"]}: an <img> carries no class="article-image", '
            'so these rules no longer cover every article image')
        chapters.append((chapter['number'], tags))
    return chapters


def test_every_article_image_carries_a_positive_intrinsic_size():
    # width/height are what reserves the box before the bytes arrive (CLS).
    # The positivity check is the artifact-side guard for the build's
    # `size[0] > 0 and size[1] > 0` test: a header masking to 0 must never ship.
    images = [(number, tag) for number, tags in chapters_with_images() for tag in tags]
    # Floor on the population: a pattern that stopped matching would otherwise
    # let every rule here pass while checking nothing.
    assert len(images) >= 300, (
        f'only {len(images)} article images found -- the payload or the pattern is broken')
    for number, tag in images:
        width = re.search(r'\swidth="(\d+)"', tag)
        height = re.search(r'\sheight="(\d+)"', tag)
        assert width and height, f'chapter-{number} image without intrinsic size: {tag}'
        assert int(width.group(1)) > 0 and int(height.group(1)) > 0, (
            f'chapter-{number} image with a zero intrinsic size: {tag}')


def test_each_chapter_makes_exactly_one_image_eager_and_it_is_the_first():
    # The first image is the chapter's LCP element; lazy-loading it is the
    # measured 245ms load delay. Chapters without images must stay untouched.
    for number, tags in chapters_with_images():
        eager = [index for index, tag in enumerate(tags) if 'loading="lazy"' not in tag]
        if not tags:
            assert eager == [], f'chapter-{number} has no image to prioritise'
            continue
        assert eager == [0], (
            f'chapter-{number}: expected only the first image eager, got indexes {eager}')
        assert 'fetchpriority="high"' in tags[0], (
            f'chapter-{number} first image lost fetchpriority="high": {tags[0]}')


def test_every_image_after_the_first_stays_lazy():
    followers = [(number, tag) for number, tags in chapters_with_images() for tag in tags[1:]]
    # Floor on the population: with none, this rule would pass without testing
    # anything, which is exactly how the shipped build script regression hid.
    assert len(followers) >= 300, f'only {len(followers)} non-first images -- parser broken'
    for number, tag in followers:
        assert 'loading="lazy"' in tag, (
            f'chapter-{number}: image after the first lost loading="lazy": {tag}')
