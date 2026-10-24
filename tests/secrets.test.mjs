import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRuntimeSecrets } from '../lib/secrets.mjs';
test('fallback secrets persist across loads and remain private',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vin-secrets-'));
 try{const first=loadRuntimeSecrets(dir,{}),second=loadRuntimeSecrets(dir,{});assert.deepEqual(first,second);assert.notEqual(first.JWT_SECRET,first.ADMIN_KEY);assert.equal(fs.statSync(path.join(dir,'runtime-secrets.json')).mode&0o777,0o600);
 assert.equal(loadRuntimeSecrets(dir,{JWT_SECRET:'configured'}).JWT_SECRET,'configured');assert.equal(loadRuntimeSecrets(dir,{JWT_SECRET:'configured'}).ADMIN_KEY,first.ADMIN_KEY);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('configured secrets need no fallback file',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vin-secrets-'));
 try{assert.deepEqual(loadRuntimeSecrets(dir,{JWT_SECRET:'jwt',ADMIN_KEY:'admin'}),{JWT_SECRET:'jwt',ADMIN_KEY:'admin'});assert.equal(fs.existsSync(path.join(dir,'runtime-secrets.json')),false);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('malformed persisted secrets fail closed instead of silently invalidating sessions',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vin-secrets-'));
 try{fs.writeFileSync(path.join(dir,'runtime-secrets.json'),'{}');assert.throws(()=>loadRuntimeSecrets(dir,{}),/Invalid runtime/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
