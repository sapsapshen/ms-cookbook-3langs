import {mkdirSync, existsSync, writeFileSync, statSync, readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'assets/vendor/pyodide');
const VERSION = '0.26.4';
const BASE = `https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/`;
/* pyodide.asm.js is NOT optional: pyodide.js calls
   `loadScript(indexURL + 'pyodide.asm.js')` before it can instantiate the wasm
   module, so omitting it makes every run die with ERR_MODULE_NOT_FOUND /
   a bare 404 before a single line of learner code runs. The authoritative
   list of what must be vendored lives in scripts/test_pyodide_vendor.py, not
   here — a downloader that checks its own manifest cannot notice the manifest
   itself is missing something, which is exactly how this file lost the wasm
   glue in the first place. */
const FILES = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

if (existsSync(resolve(target, 'VERSION')) && readFileSync(resolve(target, 'VERSION'), 'utf8').trim() === VERSION) {
  const complete = FILES.every(name => existsSync(resolve(target, name)));
  if (complete) {
    console.log(`Pyodide ${VERSION} already vendored.`);
    process.exit(0);
  }
}

mkdirSync(target, { recursive: true});
for (const name of FILES) {
  const response = await fetch(BASE + name);
  if (!response.ok) throw new Error(`download failed ${name}: ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length < 1024) throw new Error(`${name} is suspiciously small (${body.length} bytes)`);
  writeFileSync(resolve(target, name), body);
  console.log(`fetched ${name} (${(body.length / 1048576).toFixed(2)} MB)`);
}
writeFileSync(resolve(target, 'VERSION'), `${VERSION}\n`);
const wasm = statSync(resolve(target, 'pyodide.asm.wasm')).size;
if (wasm < 1_000_000) throw new Error(`pyodide.asm.wasm looks truncated (${wasm} bytes)`);
console.log(`Pyodide ${VERSION} vendored into assets/vendor/pyodide/`);
