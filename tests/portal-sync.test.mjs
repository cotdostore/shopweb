import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {handlePortal} from '../cloudflare/portal/index.mjs';
import {digest} from '../cloudflare/portal/crypto.mjs';
globalThis.crypto ??= webcrypto;

test('sync discovery requires a token and returns current active sources only',async()=>{
 const hash=await digest('test-sync-token');
 let accounts=[{source_id:'document_first',active:1},{source_id:'document_disabled',active:0},{source_id:null,active:1}];
 const env={PORTAL_KEY:'test',PORTAL_DB:{prepare(sql){return {bind(...args){return {
  async first(){assert.match(sql,/sync_token_hash/);return args[0]===hash?{value:hash}:null;},
  async all(){assert.match(sql,/active=1 AND source_id IS NOT NULL/);return {results:accounts.filter(a=>a.active&&a.source_id).map(a=>({source_id:a.source_id}))};}
 };}};}}};
 const request=token=>new Request('https://worker.example/portal/api/sync',{headers:token?{Authorization:'Bearer '+token}:{}});
 assert.equal((await handlePortal(request(),env)).status,401);
 assert.equal((await handlePortal(request('wrong'),env)).status,401);
 let response=await handlePortal(request('test-sync-token'),env);
 assert.match(response.headers.get('Cache-Control'),/no-store/);
 assert.deepEqual(await response.json(),{sourceIds:['document_first']});
 accounts=[{source_id:'document_new',active:1}];
 assert.deepEqual(await (await handlePortal(request('test-sync-token'),env)).json(),{sourceIds:['document_new']});
 accounts=[];
 assert.deepEqual(await (await handlePortal(request('test-sync-token'),env)).json(),{sourceIds:[]});
});

const script=await readFile(new URL('../portal-assets/Code.gs',import.meta.url),'utf8');
function harness(){
 let ids=['document_first'],read=[],sent=[],released=0,status=200;
 const context=vm.createContext({console:{error(){}},PropertiesService:{getScriptProperties:()=>({getProperty:key=>({PORTAL_SYNC_URL:'https://worker.example/portal/api/sync',PORTAL_SYNC_TOKEN:'test-token',PORTAL_DOC_IDS:'invalid old value'})[key]})},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){released++;}})},
  Docs:{Documents:{get(id){read.push(id);if(id==='document_broken')throw new Error('no access');return {body:{content:[{paragraph:{elements:[{textRun:{content:'test'}}]}}]}};}}},
  UrlFetchApp:{fetch(url,options){assert.equal(options.headers.Authorization,'Bearer test-token');assert.equal(options.followRedirects,false);if(options.method==='get')return {getResponseCode:()=>status,getContentText:()=>JSON.stringify({sourceIds:ids})};sent.push(JSON.parse(options.payload));return {getResponseCode:()=>200};}}});
 vm.runInContext(script,context);
 return {run:()=>context.syncPortal(),setIds:value=>ids=value,setStatus:value=>status=value,read,sent,released:()=>released};
}
test('Apps Script discovers added/changed Docs on each run and supports an empty list',()=>{
 const h=harness();h.run();h.setIds(['document_new']);h.run();h.setIds([]);h.run();
 assert.deepEqual(h.read,['document_first','document_new']);
 assert.deepEqual(h.sent.map(p=>p.sourceId),h.read);assert.equal(h.released(),3);
});
test('discovery failure releases lock without using stale local IDs',()=>{
 const h=harness();h.setStatus(401);assert.throws(h.run,/Cannot load portal documents/);
 assert.deepEqual(h.read,[]);assert.equal(h.released(),1);
});
test('an inaccessible Doc does not prevent the remaining Docs from syncing',()=>{
 const h=harness();h.setIds(['document_broken','document_new']);assert.throws(h.run,/1 document/);
 assert.deepEqual(h.sent.map(p=>p.sourceId),['document_new']);assert.equal(h.released(),1);
});
