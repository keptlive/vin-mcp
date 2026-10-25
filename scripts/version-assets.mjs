/** Keep long-lived browser caches tied to the exact released file contents. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../public/',import.meta.url);
const digest=async path=>createHash('sha256').update(await readFile(new URL(path,root))).digest('hex').slice(0,12);
const research=new URL('research/research.js',root);
await writeFile(research,(await readFile(research,'utf8')).replace(/from '\/client\.mjs(?:\?v=[^']+)?'/,`from '/client.mjs?v=${await digest('client.mjs')}'`));
for(const page of ['index.html','research/index.html']) {
 let text=await readFile(new URL(page,root),'utf8');
 const links=[...text.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(m=>m[1]);
 for(const link of new Set(links)) {
  if(/^(?:https?:|\/\/|#|data:)/.test(link))continue;
  const url=new URL(link,'https://local.invalid/'+page);
  if(!/\.(?:css|js|mjs|pdf)$/.test(url.pathname))continue;
  url.searchParams.set('v',await digest(url.pathname.slice(1)));
  const updated=link.split('?')[0]+url.search+url.hash;
  text=text.replaceAll('"'+link+'"','"'+updated+'"').replaceAll("'"+link+"'","'"+updated+"'");
 }
 await writeFile(new URL(page,root),text);
}
