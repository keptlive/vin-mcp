import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {yearValue,textValue,InputError} from './research.mjs';

const file=fileURLToPath(new URL('../data/investigations.db',import.meta.url));
export function investigations(query) {
  const args=[textValue(query.make,'make'),textValue(query.model,'model'),Number(yearValue(query.year))];
  const limit=Number(query.limit??20),offset=Number(query.offset??0);
  if(!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0||offset>100000)throw new InputError('Invalid pagination (limit 1–50)');
  const info={scope:'NHTSA model-year defect investigations; not proof of an individual vehicle defect',reference_url:'https://www.nhtsa.gov/nhtsa-datasets-and-apis',note:'Closing an investigation is not a statement that a vehicle is safe. A missing closing date means only that this snapshot records no closing date. Source report variants are retained.'};
  if(!existsSync(file))return {...info,available:false,reason:'dataset_not_indexed',data:null};
  const db=new Database(file,{readonly:true,fileMustExist:true});
  try {
    const from=' FROM applicability a JOIN reports r ON r.hash=a.hash WHERE a.make=? COLLATE NOCASE AND a.model=? COLLATE NOCASE AND a.year=?';
    const total=db.prepare('SELECT count(DISTINCT r.id) AS n'+from).get(...args).n;
    const ids=db.prepare('SELECT r.id,max(r.opened) AS opened'+from+' GROUP BY r.id ORDER BY opened DESC,r.id DESC LIMIT ? OFFSET ?').all(...args,limit,offset);
    const data=ids.map(({id})=>({id,reports:db.prepare('SELECT r.manufacturer,r.opened,r.closed,r.subject,r.summary,group_concat(DISTINCT a.component) AS components,group_concat(DISTINCT nullif(a.campaign,\'\')) AS recall_campaigns'+from+' AND r.id=? GROUP BY r.hash ORDER BY r.opened DESC,r.hash').all(...args,id)}));
    const source={provider:'NHTSA Office of Defects Investigation',...JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='source'").get().value)};
    return {...info,available:true,total,limit,offset,next_offset:offset+data.length<total?offset+data.length:null,data,source};
  }finally{db.close();}
}
