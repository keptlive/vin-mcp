import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('legacy research bookmarks retain their section and search context', () => {
  const html = readFileSync(new URL('../public/research/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const [search, hash, expected] of [
    ['?year=2015&make=NISSAN&model=ALTIMA', '#communications', '/?year=2015&make=NISSAN&model=ALTIMA#communications'],
    ['', '#compare', '/#compare'],
    ['', '', '/#catalog'],
    ['?year=2020', '#costs', '/?year=2020#costs'],
  ]) {
    let destination;
    vm.runInNewContext(script, {location:{search, hash, replace:value=>{destination=value;}}});
    assert.equal(destination, expected);
  }
});

function workspace(hash='#report') {
  const nodes=new Map(), events={};
  const node=key=>{if(!nodes.has(key))nodes.set(key,{hidden:false,value:'',textContent:'',handlers:{},classList:{remove(){},toggle(){return false;}},addEventListener(k,fn){this.handlers[k]=fn;},setAttribute(){},removeAttribute(){},focus(){this.focused=true;},contains(){return false;}});return nodes.get(key);};
  const sections=['report','compare','costs','saved'].map(id=>Object.assign(node('#'+id),{id}));
  const document={querySelector:node,querySelectorAll:s=>s==='#main > section'?sections:[],addEventListener(){}};
  const context={document,location:{hash},window:{},addEventListener:(key,fn)=>events[key]=fn};
  vm.runInNewContext(readFileSync(new URL('../public/workspace.js',import.meta.url),'utf8'),context);
  return {node,context,api:context.window.VinWorkspace,sections};
}

test('saved vehicles have a dedicated view and skip navigation preserves the active view',()=>{
  const {node,context,api,sections}=workspace('#saved');
  assert.equal(api.selected(),'saved');
  assert.deepEqual(sections.filter(s=>!s.hidden).map(s=>s.id),['saved']);
  assert.equal(node('#print-view').hidden,true);
  let prevented=false;node('.skip-link').handlers.click({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(node('#main').focused,true);assert.equal(context.location.hash,'#saved');
});

test('native printing rejects a report after its VIN input no longer matches',()=>{
  const {node,api}=workspace();
  const vin='1N4AL3APXFN868842';
  api.reportUpdated({vin,vehicle:{year:2015,make:'NISSAN',model:'Altima'}});
  node('#vin-input').value=vin;node('#results').hidden=false;
  assert.equal(api.canPrint('report'),true);
  node('#vin-input').value='4T1BF1FK0CU123456';
  assert.equal(api.canPrint('report'),false);
  assert.equal(node('#results').hidden,true);assert.equal(node('#vehicle-context').hidden,true);
  assert.match(node('#print-meta').textContent,/No current report/);
  assert.equal(api.canPrint('saved'),false);
});
