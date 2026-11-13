import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const pages=['../index.html','../assets/analytics.html','../login.html'];
const scripts=['../assets/i18n.js','../assets/paper.js'];
const stamp=contents=>contents.replace(/(href|src)="(\/?assets\/[^"?]+\.(?:css|js))(?:\?[^" ]*)?"/g,(_,attr,path)=>
  `${attr}="${path}?v=${hash(path)}"`);
const hash=path=>createHash('sha256').update(readFileSync(new URL('../'+path.replace(/^\//,''),import.meta.url))).digest('hex').slice(0,12);
/* Injected paths live inside JS string arrays. Without a hash they would get no
   Cache-Control from the immutable rule, which keys off the ?v= parameter.
   Scripts FIRST: stamping them rewrites their own content, so a page stamped
   before this loop would pin i18n.js to a hash the very next write destroys. */
for(const filename of scripts){
 const file=new URL(filename,import.meta.url);
 const content=readFileSync(file,'utf8').replace(/'(assets\/[^'?]+\.(?:js|css))(?:\?v=[0-9a-f]{12})?'/g,(_,path)=>
  `'${path}?v=${hash(path)}'`);
 writeFileSync(file,content);
}
for(const filename of pages){
 const page=new URL(filename,import.meta.url);
 writeFileSync(page,stamp(readFileSync(page,'utf8')));
}
