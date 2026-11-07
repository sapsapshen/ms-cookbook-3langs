"""构建期尺寸解析必须与真实图片头部一致——这是 CLS 修复的地基。"""
import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
# scripts/ must be importable: build-content.py itself does
# `from chapter_markdown import to_markdown` at module level.
sys.path.insert(0, str(ROOT / 'scripts'))
image_size = importlib.import_module('build-content').image_size


@pytest.fixture
def tmp_write(tmp_path):
    """Write synthetic header bytes to a file and return its Path.

    Built from `bytes` only: CI installs requirements.txt, which has no Pillow,
    so these branches must be reachable without generating a real image.
    """
    def write(payload, name='synthetic.webp'):
        path = tmp_path / name
        path.write_bytes(payload)
        return path
    return write


def _riff(chunk, fourcc):
    """Wrap a WebP chunk in a RIFF container; the container fourcc IS chunk[:4]."""
    assert chunk[:4] == fourcc, 'synthetic fixture disagrees with its own RIFF header'
    return b'RIFF' + (4 + len(chunk)).to_bytes(4, 'little') + b'WEBP' + chunk


def _vp8l(width, height):
    # VP8L packs width-1 and height-1 as 14 consecutive bits after the 0x2F
    # signature byte, so the size fields live in head[21:25].
    bits = ((height - 1) << 14) | (width - 1)
    return (b'VP8L' + (12).to_bytes(4, 'little') + b'\x2f'
            + bits.to_bytes(4, 'little') + b'\x00' * 8)


def test_reads_a_real_webp():
    target = ROOT / 'assets' / 'manuscript-20260914' / 'c01-065d3d9ab0de58.webp'
    assert image_size(target) == (1880, 1090)


def test_reads_a_real_png():
    target = ROOT / 'assets' / 'reading-dada-illustrations' / '01-reading-v2.png'
    assert image_size(target) == (1672, 941)


def test_reads_a_real_extended_webp():
    # 11 of the corpus images are VP8X; pinned against a real encoder so the
    # canvas-minus-one layout cannot drift into a self-consistent fiction.
    target = ROOT / 'assets' / 'manuscript-20260914' / 'c24-72e3e81141b366.webp'
    assert image_size(target) == (2400, 1134)


def test_vp8l_uses_fourteen_bit_fields(tmp_write):
    assert image_size(tmp_write(_riff(_vp8l(3000, 4000), b'VP8L'))) == (3000, 4000)


def test_vp8l_survives_both_twelve_bit_failure_modes(tmp_write):
    # What the shipped 12-bit mask did to real files: a 1000x700 lossless WebP
    # read back as 1000x2797 (any height under 4096 inflated four times) and a
    # 5000x4000 one as 904x3710 (width wrapped past 4096).
    for width, height in ((1000, 700), (5000, 4000)):
        path = tmp_write(_riff(_vp8l(width, height), b'VP8L'))
        assert image_size(path) == (width, height), f'{width}x{height} lossless WebP'


def test_vp8x_reads_canvas_minus_one(tmp_write):
    chunk = (b'VP8X' + (10).to_bytes(4, 'little') + b'\x00' * 4
             + (1023).to_bytes(3, 'little') + (767).to_bytes(3, 'little') + b'\x00' * 4)
    assert image_size(tmp_write(_riff(chunk, b'VP8X'))) == (1024, 768)


def test_vp8_lossy_reads_the_frame_dimensions(tmp_write):
    # head[20:23] is the frame tag, 0x9d 0x01 0x2a the start code at head[23:26],
    # then width and height as 14-bit fields: bytes 26-27 and 28-29.
    chunk = (b'VP8 ' + (18).to_bytes(4, 'little') + b'\x00' * 3 + b'\x9d\x01\x2a'
             + (1024).to_bytes(2, 'little') + (768).to_bytes(2, 'little') + b'\x00' * 8)
    assert image_size(tmp_write(_riff(chunk, b'VP8 '))) == (1024, 768)


def test_truncated_chunk_returns_none_not_a_guess(tmp_write):
    assert image_size(tmp_write(b'RIFF\x10\x00\x00\x00WEBPVP8 ')) is None


@pytest.mark.parametrize('kind,payload,limit', [
    ('png', b'\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR' + b'\x00' * 7, 24),
    ('vp8', b'RIFF\x10\x00\x00\x00WEBPVP8 ' + b'\x00' * 13, 30),
    ('vp8x', b'RIFF\x10\x00\x00\x00WEBPVP8X' + b'\x00' * 13, 30),
    ('vp8l', b'RIFF\x10\x00\x00\x00WEBPVP8L\x0c\x00\x00\x00/' + b'\x00' * 3, 25),
], ids=['png', 'vp8', 'vp8x', 'vp8l'])
def test_header_one_byte_short_of_its_own_guard_returns_none(tmp_write, kind, payload, limit):
    # The length is asserted, not assumed: a fixture that grew a byte would stop
    # testing truncation and quietly test the unknown-subtype fallthrough again.
    assert len(payload) == limit - 1
    assert image_size(tmp_write(payload, f'truncated.{kind}')) is None


def test_returns_none_for_a_vector_file():
    # None, not a guess: check-site.mjs turns a None into a reported gap.
    assert image_size(ROOT / 'assets' / 'brand' / 'book-mark.svg') is None


@pytest.mark.parametrize('payload', [
    b'RIFF\x00\x00\x00\x00WEBP',                # RIFF/WEBP with no chunk fourcc at all
    b'RIFF\x10\x00\x00\x00WEBPVP8?',            # a WebP subtype this parser does not know
], ids=['no-subtype', 'unknown-subtype'])
def test_returns_none_for_an_unrecognised_subtype(tmp_write, payload):
    assert image_size(tmp_write(payload)) is None
