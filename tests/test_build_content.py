"""构建期尺寸解析必须与真实图片头部一致——这是 CLS 修复的地基。"""
import importlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# scripts/ must be importable: build-content.py itself does
# `from chapter_markdown import to_markdown` at module level.
sys.path.insert(0, str(ROOT / 'scripts'))
image_size = importlib.import_module('build-content').image_size


def test_reads_a_real_webp():
    target = ROOT / 'assets' / 'manuscript-20260914' / 'c01-065d3d9ab0de58.webp'
    assert image_size(target) == (1880, 1090)


def test_reads_a_real_png():
    target = ROOT / 'assets' / 'reading-dada-illustrations' / '01-reading-v2.png'
    assert image_size(target) == (1672, 941)


def test_returns_none_for_a_vector_file():
    # None, not a guess: check-site.mjs turns a None into a reported gap.
    assert image_size(ROOT / 'assets' / 'brand' / 'book-mark.svg') is None


def test_returns_none_for_a_truncated_header(tmp_path):
    broken = tmp_path / 'x.webp'
    broken.write_bytes(b'RIFF\x00\x00\x00\x00WEBP')
    assert image_size(broken) is None
