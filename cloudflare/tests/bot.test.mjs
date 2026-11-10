import test from 'node:test';
import assert from 'node:assert/strict';
import {loadBot} from './load-bot.mjs';
import {parseAdminCommand} from '../bot/commands.mjs';
const prices={version:1,currency:'VND',groups:[{id:'test',product:'ChatGPT',variant:'Plus',items:[{id:'one-month',term:'1 tháng',price:100000,oldPrice:null,priceSuffix:'',available:true}]}]};
test('command aliases share canonical handlers without accepting unknown commands',()=>{
 for(const [alias,name] of [['khoa','block'],['access','admin'],['sendpayment','help']])assert.deepEqual(parseAdminCommand('/'+alias.toUpperCase()+' test'),{command:name,caption:'test'});
 assert.equal(parseAdminCommand('/constructor'),null);assert.equal(parseAdminCommand('/admin123'),null);assert.equal(parseAdminCommand('hi /admin'),null);
 assert.deepEqual(parseAdminCommand('/bc hello\nworld'),{command:'bc',caption:'hello\nworld'});
});
test('Worker serves admin tools and APIs but no duplicate customer website',async()=>{
 const bot=await loadBot(),env={PORTAL_DB:{},PORTAL_KEY:'synthetic'};
 for(const path of ['/chatgpt','/chatgpt/access','/portal/assets/customer.js'])assert.equal((await bot.default.fetch(new Request('https://portal.example'+path),env,{})).status,404);
 assert.equal((await bot.default.fetch(new Request('https://portal.example/portal/admin'),env,{})).status,200);
});
test('catalog burst shares one fetch, expires after 30 seconds, and does not serve stale data on failure',async()=>{
 const bot=await loadBot();const oldFetch=globalThis.fetch,oldNow=Date.now;let time=100000,calls=0,fail=false;
 Date.now=()=>time;
 globalThis.fetch=async()=>{calls++;await new Promise(resolve=>setImmediate(resolve));if(fail)throw new Error('upstream down');return Response.json(prices);};
 try{
  const burst=await Promise.all(Array.from({length:32},()=>bot.fetchCatalog()));assert.equal(calls,1);assert.equal(burst[0].length,1);
  await bot.fetchCatalog();assert.equal(calls,1);
  time+=30001;fail=true;await assert.rejects(()=>bot.fetchCatalog(),/upstream down/);assert.equal(calls,2);
  fail=false;await bot.fetchCatalog();assert.equal(calls,3,'rejected in-flight request must be cleared');
  time+=30001;await bot.fetchCatalog();assert.equal(calls,4);
 }finally{globalThis.fetch=oldFetch;Date.now=oldNow;}
});
test('linear best-match selection preserves ties and input order',async()=>{
 const {chooseCandidates,getProductFromText}=await loadBot();
 assert.equal(getProductFromText('mua chat gpt plus 1 tháng'),'chatgpt');assert.equal(getProductFromText('internet'),null);assert.equal(getProductFromText('cho mình net nhé'),'netflix');
 let seed=42;
 for(let size=0;size<500;size++){
  const input=Array.from({length:size},(_,item)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return {item,score:seed%20};});
  const original=input.map(x=>({...x})),sorted=[...input].sort((a,b)=>b.score-a.score);
  const top=sorted.filter(x=>x.score===sorted[0]?.score).map(x=>x.item);
  assert.deepEqual(chooseCandidates(input),!top.length?{status:'not_found'}:top.length===1?{status:'found',item:top[0]}:{status:'ambiguous',options:top});assert.deepEqual(input,original);
 }
});
test('webhook queues independent customers concurrently with a bound and preserves each customer order',async()=>{
 const {processWebhook}=await loadBot();let active=0,peak=0;const order=new Map();
 const env={CUSTOMER_INBOX:{getByName:key=>({receive:async event=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));const list=order.get(key)??[];list.push(event.message.text);order.set(key,list);active--;}})}};
 const messaging=[];for(let round=0;round<3;round++)for(let user=0;user<19;user++)messaging.push({sender:{id:'user-'+user},message:{text:String(round)}});
 await processWebhook({object:'page',entry:[{id:'page',messaging}]},env);
 assert(peak>1&&peak<=8);assert.equal(active,0);for(const list of order.values())assert.deepEqual(list,['0','1','2']);
 let completed=0;
 env.CUSTOMER_INBOX.getByName=key=>({receive:async()=>{await new Promise(resolve=>setTimeout(resolve,2));completed++;if(key==='page:user-0')throw new Error('retry');}});
 await assert.rejects(()=>processWebhook({object:'page',entry:[{id:'page',messaging:messaging.slice(0,8)}]},env),/retry/);assert.equal(completed,8,'all started durable writes finish before retry response');
});
