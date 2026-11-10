// Repeatable CPU comparison against the deployed pre-optimization Git revision.
// Uses local public prices; sends no Messenger messages and makes no network calls.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {loadBot} from './load-bot.mjs';
const baseline=await loadBot(execFileSync('git',['show',(process.argv[2]||'be2f0ce')+':cloudflare/bot/worker.js'],{encoding:'utf8',maxBuffer:1000000}));
const optimized=await loadBot();
const data=JSON.parse(readFileSync(new URL('../../prices.json',import.meta.url),'utf8'));
const catalog=data.groups.flatMap(group=>group.items.filter(item=>item.available).map(item=>({product:group.product,variant:group.variant,term:item.term,price:String(item.price/1000)+'K'+item.priceSuffix})));
const queries=['mua chatgpt plus 1 tháng','gpt go 12 tháng','mua claude','mua studocu 1 thang','youtube 1 năm','netflix','internet','quizlet 3month','mua 50k',...catalog.flatMap(item=>[item.product,item.product+' '+item.term,item.product+' '+item.variant+' '+item.term,item.product+' '+item.price])];
for(const query of queries){
 assert.deepEqual(optimized.findProduct(catalog,query),baseline.findProduct(catalog,query),query);
 assert.deepEqual(optimized.refineOptions(catalog,query),baseline.refineOptions(catalog,query),query);
}
function measure(bot){
 for(const query of queries)bot.findProduct(catalog,query);
 const samples=[];for(let sample=0;sample<5;sample++){
  const start=performance.now();for(let repeat=0;repeat<4;repeat++)for(const query of queries)bot.findProduct(catalog,query);
  samples.push((performance.now()-start)/(4*queries.length));
 }
 return samples.sort((a,b)=>a-b)[2];
}
const before=measure(baseline),after=measure(optimized);
console.log(JSON.stringify({differentialQueries:queries.length,algorithmsCompared:2,catalogItems:catalog.length,medianCpuMsPerMatch:{before:+before.toFixed(3),after:+after.toFixed(3)},speedup:+(before/after).toFixed(2),note:'Local Node CPU only; not production network latency.'},null,2));
