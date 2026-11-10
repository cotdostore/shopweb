import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {grantExpiry} from '../portal/duration.mjs';
test('admin delete button requires confirmation, sends the internal customer ID and reloads the list',async()=>{
 class Element{
  constructor(){this.children=[];this.listeners={};this.value='';this.classList={toggle(){}};}
  get childNodes(){return this.children;}
  append(...items){this.children.push(...items);}
  replaceChildren(){this.children=[];}
  addEventListener(name,fn){this.listeners[name]=fn;}
  reset(){}
 }
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const state={customers:[{id:'internal-customer-id',accessId:'synthetic01',name:'Test',active:true}],accounts:[],grants:[],syncConfigured:true};
 const requests=[],confirmations=[];let confirmed=false;
 const adminToken='a'.repeat(43),api='https://worker.example/portal/api';
 const context={console,Intl,URLSearchParams,AbortSignal,grantExpiry,window:{addEventListener(){}},location:{hash:''},document:{getElementById:get,querySelector:()=>({content:api}),createElement:()=>new Element()},confirm:message=>{confirmations.push(message);return confirmed;},fetch:async(url,options)=>{
  requests.push({url,...options});
  assert.equal(options.credentials,'omit');
  if(url===api+'/admin/login')return Response.json({token:adminToken});
  assert.equal(options.headers.Authorization,'Bearer '+adminToken);
  if(options.method==='DELETE'){assert.deepEqual(JSON.parse(options.body),{id:'internal-customer-id'});state.customers=[];return Response.json({ok:true});}
  if(url===api+'/admin/sync-token')return Response.json({token:'synthetic-sync-token',endpoint:api+'/sync'});
  assert.equal(url,api+'/admin/state');return Response.json(state);
 }};
 vm.createContext(context);const code=readFileSync(new URL('../portal/web/admin.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');vm.runInContext(code,context);assert.equal(requests.length,0,'logged-out page makes no API calls');
 get('github-token').value='synthetic-login-token';get('admin-login').listeners.submit({preventDefault(){},submitter:new Element()});await new Promise(resolve=>setImmediate(resolve));
 function find(node){if(node.textContent==='Xóa ID')return node;for(const child of node.children){const result=find(child);if(result)return result;}}
 const button=find(get('customers'));assert(button);
 await button.listeners.click();assert.equal(requests.length,2);assert.equal(button.disabled,false);assert.match(confirmations[0],/synthetic01/);
 confirmed=true;await button.listeners.click();assert.equal(requests.length,4);assert.equal(requests[2].method,'DELETE');assert.equal(requests[2].url,api+'/admin/customer');assert.equal(get('customers').children.length,0);assert.match(get('status').textContent,/Đã xóa ID synthetic01/);
 await get('sync-token').listeners.click();assert.equal(requests.length,6);assert.equal(requests[5].headers.Authorization,'Bearer '+adminToken,'sync token must not replace the admin session token');
});
