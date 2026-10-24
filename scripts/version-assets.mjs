/** Keep long-lived browser caches tied to the exact released file contents. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../public/',import.meta.url);
const digest=async path=>createHash('sha256').update(await readFile(new URL(path,root))).digest('hex').slice(0,12);
const research=new URL('research/research.js',root);
await writeFile(research,(await readFile(research,'utf8')).replace(/from '\/client\.mjs(?:\?v=[^']+)?'/,`from '/client.mjs?v=${await digest('client.mjs')}'`));
for(const page of ['index.html','research/index.html']) {
 let text=await readFile(new URL(page,root),'utf8');
 for(const path of ['app.js','research/research.js','research/research.css','research/sheets/professional-brief.pdf','research/sheets/capability-comparison.pdf','research/sheets/data-and-methodology.pdf']) {
  const link=page==='index.html'?path:'/'+path;
  const escaped=link.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  text=text.replace(new RegExp(`(["'])${escaped}(?:\\?v=[^"']+)?(["'])`,'g'),`$1${link}?v=${await digest(path)}$2`);
 }
 await writeFile(new URL(page,root),text);
}
