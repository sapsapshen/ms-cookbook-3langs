import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
for(const filename of ['../index.html','../assets/analytics.html']){
 const page=new URL(filename,import.meta.url);
 const html=readFileSync(page,'utf8').replace(/(href|src)="(assets\/[^"?]+\.(?:css|js))(?:\?[^" ]*)?"/g,(_,attr,path)=>{
  const version=createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex').slice(0,12);
  return `${attr}="${path}?v=${version}"`;
 });
 writeFileSync(page,html);
}
