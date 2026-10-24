import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {scenario} from '../lib/scenario.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const record={id:'18657',year:2003,make:'Honda',model:'Accord',fuelType1:'Regular Gasoline',comb08:22,city08:19,highway08:27,displ:3,cylinders:6};

// Execute the actual workspace handlers with a small DOM adapter. Network timing
// is controlled so stale completions are deterministic; browser QA covers layout.
function workspace(overrides={}){
 const elements=new Map(),events=new Map();let printCalls=0;
 class Element {
  constructor(){this.value='';this.disabled=false;this.hidden=false;this.children=[];this.innerHTML='';this.textContent='';this.firstChild={textContent:''};this.listeners=new Map();this.classList={toggle(){}};}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];this.innerHTML='';this.textContent='';}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn);}
  dispatch(type){const event={target:this};this['on'+type]?.(event);for(const fn of this.listeners.get(type)||[])fn(event);this.form?.dispatch(type);}
  querySelector(selector){if(selector==='h2')return {textContent:this.heading};return this.button;}
  focus(){this.focused=true;}
 }
 const get=s=>{if(!elements.has(s))elements.set(s,new Element());return elements.get(s);};
 const sections=['catalog','compare','communications','costs','coverage','developers'].map(id=>Object.assign(get('#'+id),{id,heading:id}));
 const document={
  querySelector:s=>s==='main>section:not([hidden])'?sections.find(s=>!s.hidden):get(s),
  querySelectorAll:s=>s==='main>section'?sections:[],
  createElement:()=>new Element()
 };
 const costForm=get('#cost-form'),catalogForm=get('#catalog-form');
 costForm.button=get('#cost-submit');catalogForm.button=get('#catalog-submit');
 elements.set('#catalog-form button[type=submit]',catalogForm.button);
 elements.set('#cost-form button:not([type])',costForm.button);
 costForm.fields={};
 const html=readFileSync(new URL('../public/research/index.html',import.meta.url),'utf8');
 const costHtml=html.split('<form id="cost-form">')[1].split('</form>')[0];
 for(const input of costHtml.matchAll(/<input\b[^>]*>/g)){
  const name=input[0].match(/name="([^"]+)"/)[1],value=input[0].match(/value="([^"]*)"/)[1];
  const field=get('#cost-form [name='+name+']');field.value=value;field.form=costForm;costForm.fields[name]=field;
 }
 const energy=get('#cost-form [name=energy_type]');energy.value='gas';energy.form=costForm;costForm.fields.energy_type=energy;
 const location={origin:'http://fixture.invalid',hash:'#costs',search:''};
 const api={catalog:async()=>({data:[]}),scenario:async input=>scenario(input),...overrides};
 const context={document,location,Intl,URL,URLSearchParams,Date,console,setTimeout,Blob,
  VinClient:class{constructor(){return api;}},
  FormData:class{constructor(form){this.form=form;}*[Symbol.iterator](){for(const [name,field] of Object.entries(this.form.fields))yield [name,field.value];}},
  addEventListener:(name,fn)=>events.set(name,fn),window:{print(){printCalls++;}}
 };
 vm.createContext(context);
 vm.runInContext(readFileSync(new URL('../public/research/research.js',import.meta.url),'utf8').replace(/^import .*\n/,''),context);
 return {get,api,location,sections,printCalls:()=>printCalls,beforePrint:()=>events.get('beforeprint')(),
  submitCost:()=>costForm.onsubmit({target:costForm,preventDefault(){},submitter:costForm.button}),
  submitCatalog:()=>catalogForm.onsubmit({target:catalogForm,preventDefault(){},submitter:catalogForm.button}),
  selectCatalog:()=>{for(const [id,value] of Object.entries({year:'2003',make:'Honda',model:'Accord',variant:'18657'}))get('#'+id).value=value;}
 };
}

test('editing assumptions clears the previous calculation and blocks toolbar printing until recalculated',async()=>{
 const w=workspace();await w.submitCost();assert.match(w.get('#cost-result').innerHTML,/396\.02/);
 const apr=w.get('#cost-form [name=apr]');apr.value='0';apr.dispatch('input');
 assert.equal(w.get('#cost-result').innerHTML,'');assert.equal(w.get('#cost-result').children.length,0);
 assert.match(w.get('#cost-status').textContent,/recalculat/i);
 w.get('#print-view').onclick();assert.equal(w.printCalls(),0);
 await w.submitCost();assert.match(w.get('#cost-result').innerHTML,/333\.33/);
 assert.match(w.get('#cost-result').innerHTML,/id="cost-print-assumptions"/);
 assert.match(w.get('#cost-result').innerHTML,/<th scope="row">APR<\/th><td>0%<\/td>/);
 w.get('#print-view').onclick();assert.equal(w.printCalls(),1);
});

test('native beforeprint detects unannounced edits and removes a stale calculation',async()=>{
 const w=workspace();await w.submitCost();w.get('#cost-form [name=apr]').value='0';
 w.beforePrint();assert.equal(w.get('#cost-result').innerHTML,'');
 assert.match(w.get('#print-meta').textContent,/no current calculation/i);
});

test('editing energy type retains label changes while invalidating the result',async()=>{
 const w=workspace();await w.submitCost();const energy=w.get('#cost-form [name=energy_type]');energy.value='electric';energy.dispatch('change');
 assert.match(w.get('#efficiency-label').firstChild.textContent,/kWh/);assert.equal(w.get('#cost-result').innerHTML,'');
});

test('a late cost response cannot replace a newer calculation or unlock its active request',async()=>{
 const pending=[];const w=workspace({scenario:input=>{const d=deferred();pending.push({...d,input});return d.promise;}});
 const first=w.submitCost();w.get('#cost-form [name=apr]').value='0';w.get('#cost-form [name=apr]').dispatch('input');
 const second=w.submitCost();pending[0].resolve(scenario(pending[0].input));await first;
 assert.equal(w.get('#cost-submit').disabled,true);assert.equal(w.get('#cost-result').innerHTML,'');
 pending[1].resolve(scenario(pending[1].input));await second;
 assert.match(w.get('#cost-result').innerHTML,/333\.33/);assert.equal(w.get('#cost-submit').disabled,false);
});

test('an older cost response arriving last cannot replace the completed current report',async()=>{
 const pending=[];const w=workspace({scenario:input=>{const d=deferred();pending.push({...d,input});return d.promise;}});
 const first=w.submitCost();w.get('#cost-form [name=apr]').value='0';w.get('#cost-form [name=apr]').dispatch('input');const second=w.submitCost();
 pending[1].resolve(scenario(pending[1].input));await second;pending[0].resolve(scenario(pending[0].input));await first;
 assert.match(w.get('#cost-result').innerHTML,/333\.33/);assert.doesNotMatch(w.get('#cost-result').innerHTML,/396\.02/);
 w.get('#print-view').onclick();assert.equal(w.printCalls(),1);
});

test('print assumptions preserve energy units and entered precision',async()=>{
 const w=workspace();w.get('#cost-form [name=energy_price]').value='4.123';await w.submitCost();
 assert.match(w.get('#cost-result').innerHTML,/\$4\.123 \/ gallon/);
 const energy=w.get('#cost-form [name=energy_type]');energy.value='electric';energy.dispatch('change');
 w.get('#cost-form [name=energy_price]').value='0.213';await w.submitCost();
 assert.match(w.get('#cost-result').innerHTML,/\$0\.213 \/ kWh/);assert.match(w.get('#cost-result').innerHTML,/30 kWh \/ 100 mi/);
});

for(const selector of ['#year','#make','#model','#variant'])test('changing '+selector+' prevents an old configuration response from rendering',async()=>{
 const d=deferred();const w=workspace({vehicle:()=>d.promise});w.selectCatalog();
 const request=w.submitCatalog();w.get(selector).value='changed';w.get(selector).onchange();
 d.resolve({data:record});await request;
 assert.equal(w.get('#catalog-result').innerHTML,'');assert.doesNotMatch(w.get('#catalog-status').textContent,/Loaded EPA/);
 assert.equal(w.get('#catalog-submit').disabled,false);
});

test('late catalog success and failure leave the newer request and its result intact',async()=>{
 const a=deferred(),b=deferred();let calls=0;
 const w=workspace({vehicle:()=>++calls===1?a.promise:b.promise});w.selectCatalog();
 const first=w.submitCatalog();w.get('#variant').value='18655';w.get('#variant').onchange();const second=w.submitCatalog();
 a.reject(new Error('old request failed'));await first;
 assert.equal(w.get('#catalog-submit').disabled,true);assert.doesNotMatch(w.get('#catalog-status').textContent,/old request failed/);
 b.resolve({data:{...record,id:'18655',displ:2.4,cylinders:4,comb08:25}});await second;
 assert.match(w.get('#catalog-result').innerHTML,/2\.4 L \/ 4 cylinders/);assert.match(w.get('#catalog-status').textContent,/18655/);
});

test('printing a different workspace section remains available without a cost calculation',()=>{
 const w=workspace();for(const s of w.sections)s.hidden=s.id!=='coverage';
 w.get('#print-view').onclick();assert.equal(w.printCalls(),1);assert.match(w.get('#print-meta').textContent,/coverage/);
});
