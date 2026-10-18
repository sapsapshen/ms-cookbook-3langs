"""Vendor integrity check for the Pyodide runtime.

Two directions, both required:

  1. Every file this module's authority table names must exist, be the right
     size, and hash to the recorded sha256.
  2. The vendor directory must contain NOTHING ELSE. A one-way check cannot
     see a manifest that forgot a file, which is how `pyodide.asm.js` went
     missing in the first place: the downloader listed 4 files and the checker
     inherited the same 4, so both agreed the vendor tree was complete while
     `pyodide.js` went on calling
     `loadScript(indexURL + 'pyodide.asm.js')` — every first run in a real
     browser died before a line of learner code executed.

The authority table below is written HERE, not imported from
scripts/vendor-pyodide.mjs. Sharing the downloader's list is what made the old
check blind: one omission, two agreeing files, no failure. This module instead
declares the list independently and then asserts the downloader's FILES agrees
with it, so editing either file without the other is a test failure rather than
a silently incomplete vendor tree.

The sha256 digests catch truncation and partial downloads, which the old
size-only assertions let through whenever a file stayed above the threshold.

Usage:
    python scripts/test_pyodide_vendor.py
    pytest scripts/test_pyodide_vendor.py
"""
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'assets' / 'vendor' / 'pyodide'
DOWNLOADER = ROOT / 'scripts' / 'vendor-pyodide.mjs'
PYODIDE_VERSION = '0.26.4'

# name -> (sha256, minimum size in bytes). `pyodide.asm.js` is the wasm glue
# module pyodide.js importScripts/loads before it can instantiate the wasm
# module; without it the runtime never starts, in a browser or in node.
AUTHORITY = {
    'pyodide.js': ('c0069107621d5b942a659e737a12e774cc0451feaa2256f475d72e071d844ec7', 10_000),
    'pyodide.asm.js': ('919560652ed3dad3707cb3a394785da1e046fb13dc0defa162058ff230cb7eed', 500_000),
    'pyodide.asm.wasm': ('b7e66a19427a55010ac3367c1b6c64b893f9826f783412945fdf0c3337f3bc94', 1_000_000),
    'python_stdlib.zip': ('72894522b791858b9d613ac786b951d8b5094035dcf376313ea24a466810f336', 1_000_000),
    'pyodide-lock.json': ('cd50b49de944c579045e122fe8628b31f9ce446379f032f36c05e273d38766e0', 50_000),
    'VERSION': ('826f965a3a4e4242df08f18895837c35c28bbf33bf7e8fa5d187781a764b1325', 1),
}


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def test_authority_files_present_and_intact():
    for name, (digest, floor) in AUTHORITY.items():
        path = VENDOR / name
        assert path.exists(), f'missing vendor file {name}'
        size = path.stat().st_size
        assert size >= floor, f'{name} is truncated ({size} bytes, expected >= {floor})'
        actual = _sha256(path)
        assert actual == digest, f'{name} content does not match its recorded sha256 ({actual})'
    assert (VENDOR / 'VERSION').read_text(encoding='utf-8').strip() == PYODIDE_VERSION


def test_no_unexpected_files_in_vendor_dir():
    """The other direction: an unlisted file means the authority is stale.

    Deliberately fails on strays rather than tolerating them. A tolerated
    "pyodide.asm.js.1" or an editor swap file would sit here forever while
    pretending the tree was reviewed.
    """
    present = {entry.name for entry in VENDOR.iterdir() if entry.is_file()}
    expected = set(AUTHORITY)
    extra = present - expected
    assert not extra, (
        f'unexpected files in assets/vendor/pyodide/: {sorted(extra)} — the vendor '
        f'authority list is stale, or something was added by hand')
    missing = expected - present
    assert not missing, f'missing vendor files: {sorted(missing)}'


def test_downloader_manifest_matches_authority():
    """The downloader and this checker must agree, or one of them is a lie."""
    source = DOWNLOADER.read_text(encoding='utf-8')
    match = re.search(r'const FILES = \[(.*?)\];', source, re.DOTALL)
    assert match, 'cannot read FILES from scripts/vendor-pyodide.mjs'
    listed = set(re.findall(r"'([^']+)'", match.group(1)))
    expected = set(AUTHORITY) - {'VERSION'}
    assert listed == expected, (
        f'downloader lists {sorted(listed)} but the vendor authority requires '
        f'{sorted(expected)}; a file missing from either one is a runtime that '
        f'cannot start')


def main():
    test_authority_files_present_and_intact()
    test_no_unexpected_files_in_vendor_dir()
    test_downloader_manifest_matches_authority()
    total = sum((VENDOR / name).stat().st_size for name in AUTHORITY)
    print(f'PASS: Pyodide {PYODIDE_VERSION} vendor complete — '
          f'{len(AUTHORITY)} files, {total / 1048576:.1f} MB, all sha256 verified')


if __name__ == '__main__':
    main()
