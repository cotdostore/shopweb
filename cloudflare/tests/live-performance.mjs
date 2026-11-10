// Explicit production smoke/latency check with synthetic records only.
// Hidden stdin: bootstrap configuration first, then "after" following deployment.
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');let buffer='',resolveLine;const lines=[];
process.stdin.on('data',part=>{buffer+=part;let end;while((end=buffer.search(/[\r\n]/))!==-1){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;if(resolveLine){const resolve=resolveLine;resolveLine=null;resolve(line);}else lines.push(line);}});
const line=()=>lines.length?Promise.resolve(lines.shift()):new Promise(resolve=>resolveLine=resolve);
console.log('Ready for hidden live test configuration.');
const config=JSON.parse(await line()),origin='https://cotdo-messenger-bot.kazuto121100.workers.dev';
let adminCookie;
async function api(path,method='GET',data,cookie=adminCookie,extra={}){
 const r=await fetch(origin+'/portal/api'+path,{method,signal:AbortSignal.timeout(12000),headers:{...(data?{'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...extra},body:data?JSON.stringify(data):undefined});
 const result=await r.json();assert(r.ok,'Live API '+path+' failed: '+r.status);
 return {data:result,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
adminCookie=(await api('/admin/bootstrap','POST',{token:config.token})).cookie;
const accessId='perf-'+randomBytes(12).toString('hex');
const customer=(await api('/admin/customers','POST',{accessId,name:'Performance QA synthetic'})).data;
const account=(await api('/admin/account','POST',{service:'qa',label:'Performance QA synthetic',credentials:{username:'performance@example.invalid',password:'synthetic-performance-only',twoFactorUrl:'https://example.invalid/2fa'}})).data;
console.log(JSON.stringify({fixture:{customerId:customer.id,accountId:account.id}}));
await api('/admin/grant','POST',{customerId:customer.id,accountId:account.id,duration:'7day'});
const login=await api('/login','POST',{accessId},'');
async function measure(mode){
 const samples=[];for(let i=0;i<7;i++){
  const start=performance.now();let details;
  if(mode==='before'){await api('/me','GET',undefined,login.cookie);details=(await api('/account/'+account.id,'GET',undefined,login.cookie)).data;}
  else details=(await api('/snapshot?account='+account.id,'GET',undefined,login.cookie)).data.details;
  assert.equal(details.password,'synthetic-performance-only');if(i)samples.push(performance.now()-start);
 }
 samples.sort((a,b)=>a-b);return {samples:samples.length,medianMs:Math.round((samples[2]+samples[3])/2),minMs:Math.round(samples[0]),maxMs:Math.round(samples.at(-1))};
}
const before=await measure('before');console.log(JSON.stringify({before,waitingForDeployment:true}));
assert.equal(await line(),'after');
const after=await measure('after');
const gh='https://cotdostore.github.io';
const token=(await api('/login','POST',{accessId},'',{Origin:gh})).data.token;
assert.equal((await api('/snapshot','GET',undefined,'',{Origin:gh,Authorization:'Bearer '+token})).data.details.id,account.id);
const preflight=await fetch(origin+'/portal/api/snapshot',{method:'OPTIONS',headers:{Origin:gh,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Max-Age'),'600');
for(const path of ['/chatgpt','/chatgpt/access','/portal/assets/customer.js'])assert.equal((await fetch(origin+path)).status,404);
await api('/admin/customer','PUT',{id:customer.id,active:false});
const blocked=await fetch(origin+'/portal/api/snapshot',{headers:{Origin:gh,Authorization:'Bearer '+token}});assert.equal(blocked.status,401);
await api('/logout','POST',{admin:true});
console.log(JSON.stringify({ok:true,before,after,customerPageRemoved:true,githubCors:true,blockVerified:true,cleanup:{customerId:customer.id,accountId:account.id},note:'Six sequential samples from this machine; includes network variation, not production p95.'}));
process.exit(0);
