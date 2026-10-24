import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { yearValue, textValue, InputError } from './research.mjs';
const file=fileURLToPath(new URL('../data/communications.db',import.meta.url));
export function communications(query) {
 const year=Number(yearValue(query.year)),make=textValue(query.make,'make'),model=textValue(query.model,'model');
 const offset=Number(query.offset??0),limit=Number(query.limit??20);
 if(!Number.isInteger(offset)||offset<0||offset>100000||!Number.isInteger(limit)||limit<1||limit>50)throw new InputError('Invalid pagination (limit 1–50)');
 const info={scope:'manufacturer communications for make/model/year; not VIN applicability or repair status',source:'NHTSA manufacturer communications',reference_url:'https://www.nhtsa.gov/nhtsa-datasets-and-apis',note:'A bulletin is not a recall or proof that this vehicle has a defect. Results cover the indexed received-date archives, not all possible communications.'};
 if(!existsSync(file))return {...info,available:false,reason:'dataset_not_indexed',data:null};
 const db=new Database(file,{readonly:true,fileMustExist:true});
 try{
  const where='make = ? COLLATE NOCASE AND model = ? COLLATE NOCASE AND year = ?';
  const total=db.prepare('SELECT count(DISTINCT id) AS n FROM communications WHERE '+where).get(make,model,year).n;
  const data=db.prepare('SELECT id,bulletin,received,issued,kind,make,model,year,group_concat(DISTINCT component) AS components,summary,archive FROM communications WHERE '+where+' GROUP BY id ORDER BY received DESC,id DESC LIMIT ? OFFSET ?').all(make,model,year,limit,offset);
  const meta=Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(x=>[x.key,x.value]));
  return {...info,available:true,total,offset,limit,next_offset:offset+data.length<total?offset+data.length:null,data,indexed_at:meta.indexed_at,archives:JSON.parse(meta.sources)};
 }finally{db.close();}
}
