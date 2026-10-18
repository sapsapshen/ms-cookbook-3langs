"""Vendor integrity check. Runs after scripts/vendor-pyodide.mjs has fetched."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'assets' / 'vendor' / 'pyodide'
PYODIDE_VERSION = '0.26.4'
VENDOR_FILES = ['pyodide.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json', 'VERSION']


def test_vendor_complete():
    for name in VENDOR_FILES:
        assert (VENDOR / name).exists(), f'missing vendor file {name}'
    assert (VENDOR / 'VERSION').read_text(encoding='utf-8').strip() == PYODIDE_VERSION
    assert (VENDOR / 'pyodide.asm.wasm').stat().st_size > 1_000_000


if __name__ == '__main__':
    test_vendor_complete()
    print(f'PASS: Pyodide {PYODIDE_VERSION} vendor complete')
