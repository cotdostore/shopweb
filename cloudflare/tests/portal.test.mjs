import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {grantExpiry} from '../portal/duration.mjs';
import {parseCredentials,fromGoogleDocument} from '../portal/parser.mjs';
import {seal,unseal,digest,base64} from '../portal/crypto.mjs';
globalThis.crypto=webcrypto;
const {handlePortal,portalCommand,createCustomer,updateFromDoc}=await import('../portal/index.mjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const key=base64(new Uint8Array(32).fill(42)),origin='https://portal.example';
function database(){
 const directory=mkdtempSync(path.join(tmpdir(),'cotdo-test-'));
 const filename=path.join(directory,'data.sqlite');
 function run(statements=[],schema){const result=spawnSync('python',[path.join(root,'tests/sqlite.py')],{input:JSON.stringify({database:filename,statements,schema}),encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);return JSON.parse(result.stdout);}
 run([],readFileSync(path.join(root,'portal/schema.sql'),'utf8'));
 const stats={roundTrips:0,statements:0};
 const db={prepare(sql){const statement={sql,params:[],bind(...params){return {...statement,params};},async run(){stats.roundTrips++;stats.statements++;return run([this])[0];},async all(){return this.run();},async first(){return (await this.run()).results[0]??null;}};return statement;},async batch(statements){stats.roundTrips++;stats.statements+=statements.length;return run(statements);}};
 return {env:{PORTAL_DB:db,PORTAL_KEY:key},stats,dispose:()=>{assert(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'cotdo-test-'));rmSync(directory,{recursive:true,force:true});}};
}
function request(pathname,method='GET',data,cookie,ip='1.1.1.1'){
 const headers={'CF-Connecting-IP':ip};if(data!==undefined){headers['Content-Type']='application/json';headers.Origin=origin;}if(cookie)headers.Cookie=cookie;
 return new Request(origin+'/portal/api'+pathname,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
}
async function call(env,route,method,data,cookie,ip){const r=await handlePortal(request(route,method,data,cookie,ip),env);return {status:r.status,data:await r.json(),cookie:r.headers.get('Set-Cookie')?.split(';')[0],response:r};}
async function seedAccount(env,id='account-one',service='chatgpt',source='document-source-123'){
 await env.PORTAL_DB.prepare('INSERT INTO portal_accounts(id,service,label,source_id) VALUES(?,?,?,?)').bind(id,service,'ChatGPT Plus',source).run();
 await updateFromDoc(env,source,[{text:'test@example.invalid'},{text:'synthetic-password'},{text:'LẤY MÃ XÁC MINH',links:[{url:'https://example.invalid/2fa?s=synthetic'}]}]);return id;
}
test('calendar expiry preserves time and clamps end-of-month/leap years',()=>{
 const start=Date.parse('2026-01-31T07:15:03.000Z');
 assert.equal(new Date(grantExpiry('3month',start).expiresAt).toISOString(),'2026-04-30T07:15:03.000Z');
 assert.equal(new Date(grantExpiry('1year',Date.parse('2024-02-29T00:00:00Z')).expiresAt).toISOString(),'2025-02-28T00:00:00.000Z');
 assert.equal(grantExpiry('7day',start).expiresAt,start+7*86400000);
 assert.equal(new Date(grantExpiry('1month',Date.parse('2026-03-30T17:15:00Z')).expiresAt).toISOString(),'2026-04-29T17:15:00.000Z');
 assert.throws(()=>grantExpiry('0month'));assert.throws(()=>grantExpiry('3'));assert.throws(()=>grantExpiry('999year'));
});
test('Docs parser reads hidden hyperlink and rejects ambiguous/unsafe input',()=>{
 const doc={tabs:[{documentTab:{body:{content:[{paragraph:{elements:[{textRun:{content:'test@example.invalid\n'}}]}},{paragraph:{elements:[{textRun:{content:'synthetic-password\n'}}]}},{paragraph:{elements:[{textRun:{content:'LẤY MÃ XÁC MINH: '}},{textRun:{content:'BẤM VÀO ĐÂY',textStyle:{link:{url:'https://example.invalid/2fa?s=synthetic'}}}}]}}]}}}]};
 assert.equal(parseCredentials(fromGoogleDocument(doc)).twoFactorUrl,'https://example.invalid/2fa?s=synthetic');
 assert.throws(()=>parseCredentials([{text:'test@example.invalid'},{text:'other@example.invalid'}]));
 assert.throws(()=>parseCredentials([{text:'test@example.invalid'},{text:'password'},{text:'2fa',links:[{url:'javascript:alert(1)'}]}]));
});
test('encrypted payload is bound to the account ID',async()=>{const box=await seal({password:'synthetic'},key,'account:1');assert(!box.includes('synthetic'));assert.equal((await unseal(box,key,'account:1')).password,'synthetic');await assert.rejects(()=>unseal(box,key,'account:2'));});
test('one ID login, SQL-enforced duplicates, isolated grants, block and expiry',async()=>{
 const {env,dispose}=database();try{
  const account=await seedAccount(env);
  const customer=await createCustomer(env,'linhhuynh01','Linh','psid-one');
  await assert.rejects(()=>createCustomer(env,'LINHHUYNH01','Duplicate','psid-two'),/Đã có ID/);
  await assert.rejects(()=>createCustomer(env,'linhhuynh02','Duplicate','psid-one'),/cuộc chat/);
  assert.equal((await call(env,'/login','POST',{accessId:'unknown123'})).status,401);
  const login=await call(env,'/login','POST',{accessId:'LINHHUYNH01'});assert.equal(login.status,200);assert(login.response.headers.get('set-cookie').includes('HttpOnly; Secure; SameSite=Strict'));
  assert.equal((await call(env,'/account/'+account,'GET',undefined,login.cookie)).status,403);
  const grant=await portalCommand('cap','linhhuynh01 gpt 3month','psid-one',env);assert.match(grant,/3 tháng/);
  const detail=await call(env,'/account/'+account,'GET',undefined,login.cookie);assert.equal(detail.status,200);assert.equal(detail.data.password,'synthetic-password');
  assert.equal((await call(env,'/me','GET',undefined,login.cookie)).data.accounts.length,1);
  const wrongChat=await portalCommand('block','linhhuynh01','psid-two',env);assert.match(wrongChat,/cuộc chat khác/);
  await portalCommand('block','linhhuynh01','psid-one',env);
  assert.equal((await call(env,'/me','GET',undefined,login.cookie)).status,401);
  assert.equal((await call(env,'/login','POST',{accessId:'linhhuynh01'})).status,401);
  await portalCommand('unblock','linhhuynh01','psid-one',env);
  assert.equal((await call(env,'/me','GET',undefined,login.cookie)).status,401,'unblock does not resurrect revoked sessions');
  const login2=await call(env,'/login','POST',{accessId:'linhhuynh01'});
  await env.PORTAL_DB.prepare('UPDATE portal_grants SET expires_at=? WHERE customer_id=?').bind(Date.now()-1,customer.id).run();
  assert.equal((await call(env,'/account/'+account,'GET',undefined,login2.cookie)).status,403);
  assert.equal((await call(env,'/me','GET',undefined,login2.cookie)).data.accounts.length,0);
  const row=await env.PORTAL_DB.prepare('SELECT * FROM portal_customers WHERE id=?').bind(customer.id).first();assert(!row.access_encrypted.includes('linhhuynh01'));assert(!row.access_hash.includes('linhhuynh01'));
 }finally{dispose();}
});
test('admin customer deletion revokes sessions and grants atomically, preserves shared accounts, and frees the ID',async()=>{
 const {env,stats,dispose}=database();try{
  const account=await seedAccount(env);
  const target=await createCustomer(env,'deleteuser01','Delete test','delete-psid');
  const kept=await createCustomer(env,'keptuser01','Keep test','keep-psid');
  await portalCommand('cap','deleteuser01 gpt 3month','delete-psid',env);
  await portalCommand('cap','keptuser01 gpt 3month','keep-psid',env);
  const first=await call(env,'/login','POST',{accessId:'deleteuser01'});
  const second=await call(env,'/login','POST',{accessId:'deleteuser01'});
  const keptLogin=await call(env,'/login','POST',{accessId:'keptuser01'});
  const token='delete-id-admin-bootstrap';
  await env.PORTAL_DB.prepare('INSERT INTO portal_config(key,value) VALUES(?,?)').bind('bootstrap:'+await digest(token),String(Date.now()+60000)).run();
  const admin=await call(env,'/admin/bootstrap','POST',{token});
  assert.equal((await call(env,'/admin/customer','DELETE',{id:target.id})).status,401);
  assert.equal((await call(env,'/admin/customer','DELETE',{id:target.id},first.cookie)).status,401);
  const evil=request('/admin/customer','DELETE',{id:target.id},admin.cookie);evil.headers.set('Origin','https://evil.invalid');assert.equal((await handlePortal(evil,env)).status,403);
  const github=request('/admin/customer','DELETE',{id:target.id},admin.cookie);github.headers.set('Origin','https://cotdostore.github.io');assert.equal((await handlePortal(github,env)).status,401);
  assert.equal((await call(env,'/admin/customer','DELETE',{id:''},admin.cookie)).status,400);
  // Exercise rollback after the two dependent DELETE statements have executed.
  await env.PORTAL_DB.prepare("CREATE TRIGGER reject_customer_delete BEFORE DELETE ON portal_customers BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
  assert.equal((await call(env,'/admin/customer','DELETE',{id:target.id},admin.cookie)).status,500);
  assert.equal((await call(env,'/snapshot','GET',undefined,first.cookie)).data.details.id,account);
  assert.equal((await env.PORTAL_DB.prepare('SELECT COUNT(*) AS count FROM portal_sessions WHERE customer_id=?').bind(target.id).first()).count,2);
  await env.PORTAL_DB.prepare('DROP TRIGGER reject_customer_delete').run();
  const before=stats.roundTrips;
  assert.equal((await call(env,'/admin/customer','DELETE',{id:target.id},admin.cookie)).status,200);
  assert.equal(stats.roundTrips-before,2,'admin authentication plus one transaction batch');
  assert.equal(await env.PORTAL_DB.prepare('SELECT id FROM portal_customers WHERE id=?').bind(target.id).first(),null);
  assert.equal((await env.PORTAL_DB.prepare('SELECT COUNT(*) AS count FROM portal_grants WHERE customer_id=?').bind(target.id).first()).count,0);
  assert.equal((await env.PORTAL_DB.prepare('SELECT COUNT(*) AS count FROM portal_sessions WHERE customer_id=?').bind(target.id).first()).count,0);
  for(const cookie of [first.cookie,second.cookie])assert.equal((await call(env,'/snapshot','GET',undefined,cookie)).status,401);
  assert.equal((await call(env,'/login','POST',{accessId:'deleteuser01'})).status,401);
  assert.equal((await call(env,'/snapshot','GET',undefined,keptLogin.cookie)).data.details.id,account);
  const state=(await call(env,'/admin/state','GET',undefined,admin.cookie)).data;
  assert.equal(state.customers.length,1);assert.equal(state.customers[0].id,kept.id);assert.equal(state.accounts[0].id,account);
  assert.equal((await call(env,'/admin/customer','DELETE',{id:target.id},admin.cookie)).status,404);
  const replacement=await createCustomer(env,'deleteuser01','New customer','delete-psid');assert.notEqual(replacement.id,target.id);
  const replacementLogin=await call(env,'/login','POST',{accessId:'deleteuser01'});
  assert.deepEqual((await call(env,'/snapshot','GET',undefined,replacementLogin.cookie)).data.accounts,[]);
  assert.equal((await call(env,'/snapshot','GET',undefined,first.cookie)).status,401);
 }finally{dispose();}
});
test('sync is authorized, ordered, rejects invalid data and recovers without leaking secrets',async()=>{
 const {env,dispose}=database();try{
  await seedAccount(env);const observed=Date.now()+1;
  const paragraphs=[{text:'new@example.invalid'},{text:'new-synthetic-password'},{text:'2fa',links:[{url:'https://example.invalid/new2fa'}]}];
  assert.equal((await call(env,'/sync','POST',{sourceId:'document-source-123',paragraphs,observedAt:observed})).status,401);
  await env.PORTAL_DB.prepare("INSERT INTO portal_config(key,value) VALUES('sync_token_hash',?)").bind(await digest('synthetic-sync-token')).run();
  const r=request('/sync','POST',{sourceId:'document-source-123',paragraphs,observedAt:observed});r.headers.set('Authorization','Bearer synthetic-sync-token');assert.equal((await handlePortal(r,env)).status,200);
  assert((await updateFromDoc(env,'document-source-123',paragraphs,observed-1)).ignored);
  await assert.rejects(()=>updateFromDoc(env,'document-source-123',[],observed+1),/email/);
  let row=await env.PORTAL_DB.prepare('SELECT * FROM portal_accounts').first();assert(row.sync_error);assert(!row.secret.includes('new-synthetic-password'));
  await updateFromDoc(env,'document-source-123',paragraphs,observed+2);row=await env.PORTAL_DB.prepare('SELECT * FROM portal_accounts').first();assert.equal(row.sync_error,null);
 }finally{dispose();}
});
test('CSRF, brute force, customer/admin separation and admin owner authentication',async()=>{
 const {env,dispose}=database();const oldFetch=globalThis.fetch;try{
  const csrf=request('/login','POST',{accessId:'linhhuynh01'});csrf.headers.set('Origin','https://evil.invalid');assert.equal((await handlePortal(csrf,env)).status,403);
  for(let i=0;i<20;i++)assert.equal((await call(env,'/login','POST',{accessId:'unknown123'},undefined,'abusive')).status,401);
  assert.equal((await call(env,'/login','POST',{accessId:'unknown123'},undefined,'abusive')).status,429);
  const user=await createCustomer(env,'linhhuynh01');const login=await call(env,'/login','POST',{accessId:'linhhuynh01'});assert.equal((await call(env,'/admin/state','GET',undefined,login.cookie)).status,401);
  globalThis.fetch=async()=>Response.json({permissions:{push:true,admin:false}});assert.equal((await call(env,'/admin/login','POST',{token:'synthetic-github-token-only'})).status,403);
  globalThis.fetch=async url=>{assert.equal(url,'https://api.github.com/repos/cotdostore/shopweb');return Response.json({permissions:{admin:true}});};const admin=await call(env,'/admin/login','POST',{token:'synthetic-github-token-only'});assert.equal(admin.status,200);
  const state=await call(env,'/admin/state','GET',undefined,admin.cookie);assert.equal(state.data.customers[0].accessId,'linhhuynh01');
  await call(env,'/admin/customer','PUT',{id:user.id,active:false},admin.cookie);assert.equal((await call(env,'/me','GET',undefined,login.cookie)).status,401);
 }finally{globalThis.fetch=oldFetch;dispose();}
});
test('bot Page echo commands require verification and customer text cannot invoke admin commands',async()=>{
 const {env,dispose}=database();const oldFetch=globalThis.fetch;const store=new Map(),sent=[];
 const source=readFileSync(path.join(root,'bot/worker.js'),'utf8')
 .replace('import { DurableObject } from "cloudflare:workers";','class DurableObject {}')
 .replace("from '../portal/index.mjs'","from '"+pathToFileURL(path.join(root,'portal/index.mjs')).href+"'")
 .replace("from './commands.mjs'","from '"+pathToFileURL(path.join(root,'bot/commands.mjs')).href+"'")
 .replace("from '../shared/prices-core.mjs'","from '"+pathToFileURL(path.join(root,'shared/prices-core.mjs')).href+"'")+'\nexport {handlePageAdminCommand,handleCustomerText};';
 const bot=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const page='1375397785649301',recipient='synthetic-recipient';
 env.SESSION_KV={get:async key=>store.get(key),put:async(key,value)=>store.set(key,value),delete:async key=>store.delete(key)};
 env.PAGE_ACCESS_TOKEN='synthetic-page-token';
 function event(text,mid='synthetic-mid'){return {sender:{id:page},recipient:{id:recipient},message:{is_echo:true,text,mid}};}
 try{
  globalThis.fetch=async()=>Response.json({error:'not a real page message'},{status:404});await bot.handlePageAdminCommand(event('/id linhhuynh01'),page,env);
  assert.equal((await env.PORTAL_DB.prepare('SELECT * FROM portal_customers').all()).results.length,0);
  globalThis.fetch=async(url,options)=>{if(options?.method==='POST'){sent.push(JSON.parse(options.body));return Response.json({message_id:'synthetic-outbound'});}return Response.json({from:{id:page},to:{data:[{id:recipient}]},message:'/id linhhuynh01',created_time:new Date().toISOString()});};
  await bot.handlePageAdminCommand(event('/id linhhuynh01'),page,env);assert.equal(sent.length,1);assert.match(sent[0].message.text,/Đã tạo ID/);assert(sent[0].message.text.includes('https://cotdostore.github.io/shopweb/chatgpt/'));
  globalThis.fetch=async()=>{throw new Error('duplicate must not call Meta Graph');};
  await bot.handlePageAdminCommand(event('/id linhhuynh01'),page,env);assert.equal(sent.length,1,'duplicate webhook does not resend or reverify via Graph');
  await bot.handleCustomerText(recipient,'/block linhhuynh01','/block linhhuynh01',env);assert.equal(sent.length,1);
 }finally{globalThis.fetch=oldFetch;dispose();}
});
test('bootstrap admin link is one use, cannot be used cross-origin or after expiry',async()=>{
 const {env,dispose}=database();try{
  const token='synthetic-bootstrap-token';
  await env.PORTAL_DB.prepare('INSERT INTO portal_config(key,value) VALUES(?,?)').bind('bootstrap:'+await digest(token),String(Date.now()+60000)).run();
  const cross=request('/admin/bootstrap','POST',{token});cross.headers.set('Origin','https://evil.invalid');assert.equal((await handlePortal(cross,env)).status,403);
  const first=await call(env,'/admin/bootstrap','POST',{token});assert.equal(first.status,200);assert.equal((await call(env,'/admin/state','GET',undefined,first.cookie)).status,200);
  assert.equal((await call(env,'/admin/bootstrap','POST',{token})).status,401);
  const expired='synthetic-expired-token';await env.PORTAL_DB.prepare('INSERT INTO portal_config(key,value) VALUES(?,?)').bind('bootstrap:'+await digest(expired),String(Date.now()-1)).run();assert.equal((await call(env,'/admin/bootstrap','POST',{token:expired})).status,401);
 }finally{dispose();}
});
test('Apps Script reads Docs with readonly service, preserves hyperlink and installs timer only after success',()=>{
 const code=readFileSync(path.join(root,'portal/apps-script/Code.gs'),'utf8');
 const manifest=JSON.parse(readFileSync(path.join(root,'portal/apps-script/appsscript.json'),'utf8'));
 assert(manifest.oauthScopes.includes('https://www.googleapis.com/auth/documents.readonly'));
 assert(!manifest.oauthScopes.includes('https://www.googleapis.com/auth/documents'));
 assert.equal(manifest.dependencies.enabledAdvancedServices[0].userSymbol,'Docs');
 let status=200,installed=0,unlocked=0,payload;
 const doc={tabs:[{documentTab:{body:{content:[{paragraph:{elements:[{textRun:{content:'test@example.invalid\n'}}]}},{paragraph:{elements:[{textRun:{content:'synthetic-password\n'}}]}},{table:{tableRows:[{tableCells:[{content:[{paragraph:{elements:[{textRun:{content:'2fa',textStyle:{link:{url:'https://example.invalid/2fa'}}}}]}}]}]}]}}]}}}]};
 const properties={PORTAL_SYNC_URL:'https://portal.example/portal/api/sync',PORTAL_SYNC_TOKEN:'synthetic',PORTAL_DOC_IDS:'["synthetic-doc"]'};
 const trigger={timeBased(){return this;},everyMinutes(value){assert.equal(value,1);return this;},create(){installed++;}};
 const context={console:{error(){}},PropertiesService:{getScriptProperties:()=>({getProperty:key=>properties[key]})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>unlocked++})},Docs:{Documents:{get:(id,options)=>{assert.equal(id,'synthetic-doc');assert(options.includeTabsContent);return doc;}}},UrlFetchApp:{fetch:(url,options)=>{payload=JSON.parse(options.payload);return {getResponseCode:()=>status};}},ScriptApp:{getProjectTriggers:()=>[],newTrigger:name=>{assert.equal(name,'syncPortal');return trigger;}}};
 vm.createContext(context);vm.runInContext(code,context);context.installSync();assert.equal(installed,1);assert.equal(parseCredentials(payload.paragraphs).twoFactorUrl,'https://example.invalid/2fa');
 status=401;assert.throws(()=>context.installSync(),/could not sync/);assert.equal(installed,1);assert.equal(unlocked,2);
});
test('GitHub Pages customer login uses scoped CORS and an in-memory bearer session',async()=>{
 const {env,dispose}=database();try{
  const account=await seedAccount(env);await createCustomer(env,'githubuser01','Khách GitHub','github-psid');
  await portalCommand('cap','githubuser01 gpt 3month','github-psid',env);
  const github='https://cotdostore.github.io';
  const githubRequest=(route,method='GET',data,token)=>{
   const r=request(route,method,data);r.headers.set('Origin',github);if(token)r.headers.set('Authorization','Bearer '+token);return r;
  };
  const preflight=await handlePortal(githubRequest('/login','OPTIONS'),env);assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),github);assert(!preflight.headers.has('Access-Control-Allow-Credentials'));
  const login=await handlePortal(githubRequest('/login','POST',{accessId:'githubuser01'}),env);assert.equal(login.status,200);assert.equal(login.headers.get('Access-Control-Allow-Origin'),github);assert(!login.headers.has('Set-Cookie'));const {token}=await login.json();assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  const detail=await handlePortal(githubRequest('/account/'+account,'GET',undefined,token),env);assert.equal(detail.status,200);assert.equal((await detail.json()).password,'synthetic-password');
  assert.equal((await handlePortal(githubRequest('/admin/state','GET',undefined,token),env)).status,401);
  assert.equal((await handlePortal(githubRequest('/admin/bootstrap','POST',{token}),env)).status,401);
  assert.equal((await handlePortal(githubRequest('/me'),env)).status,401);
  const evil=githubRequest('/me','GET',undefined,token);evil.headers.set('Origin','https://evil.invalid');const rejected=await handlePortal(evil,env);assert.equal(rejected.status,403);assert(!rejected.headers.has('Access-Control-Allow-Origin'));
  await handlePortal(githubRequest('/logout','POST',{},token),env);assert.equal((await handlePortal(githubRequest('/me','GET',undefined,token),env)).status,401);
  const second=await handlePortal(githubRequest('/login','POST',{accessId:'githubuser01'}),env);const token2=(await second.json()).token;
  await portalCommand('block','githubuser01','github-psid',env);assert.equal((await handlePortal(githubRequest('/me','GET',undefined,token2),env)).status,401);
 }finally{dispose();}
});
test('snapshot uses one DB round trip and rechecks active grants, account changes, block and sessions',async()=>{
 const {env,stats,dispose}=database();try{
  const account=await seedAccount(env);const other=await seedAccount(env,'account-two','canva','document-source-456');
  const customer=await createCustomer(env,'snapshot01','Snapshot','snapshot-psid');
  await portalCommand('cap','snapshot01 gpt 3month','snapshot-psid',env);
  const login=await call(env,'/login','POST',{accessId:'snapshot01'});
  let before=stats.roundTrips;
  let snapshot=await call(env,'/snapshot','GET',undefined,login.cookie);
  assert.equal(stats.roundTrips-before,1);assert.equal(snapshot.data.details.id,account);
  assert.equal(snapshot.data.details.password,'synthetic-password');
  assert(!JSON.stringify(snapshot.data.accounts).includes('secret'));
  snapshot=await call(env,'/snapshot?account='+other,'GET',undefined,login.cookie);
  assert.equal(snapshot.data.details,null);assert.equal(snapshot.data.accounts.length,1);
  const future=Date.now()+60000;
  await env.PORTAL_DB.prepare('INSERT INTO portal_grants(customer_id,account_id,expires_at) VALUES(?,?,?)').bind(customer.id,other,future).run();
  snapshot=await call(env,'/snapshot','GET',undefined,login.cookie);assert.equal(snapshot.data.accounts.length,2);assert.equal(snapshot.data.details,null);
  snapshot=await call(env,'/snapshot?account='+other,'GET',undefined,login.cookie);assert.equal(snapshot.data.details.id,other);
  await env.PORTAL_DB.prepare('UPDATE portal_accounts SET active=0 WHERE id=?').bind(other).run();
  snapshot=await call(env,'/snapshot?account='+other,'GET',undefined,login.cookie);assert.equal(snapshot.data.details,null);assert.equal(snapshot.data.accounts.length,1);
  await env.PORTAL_DB.prepare('UPDATE portal_grants SET expires_at=? WHERE customer_id=?').bind(Date.now()-1,customer.id).run();
  before=stats.roundTrips;snapshot=await call(env,'/snapshot','GET',undefined,login.cookie);
  assert.equal(snapshot.status,200);assert.equal(stats.roundTrips-before,1);assert.deepEqual(snapshot.data.accounts,[]);assert.equal(snapshot.data.details,null);
  await env.PORTAL_DB.prepare('UPDATE portal_customers SET active=0 WHERE id=?').bind(customer.id).run();
  assert.equal((await call(env,'/snapshot','GET',undefined,login.cookie)).status,401);
  await env.PORTAL_DB.prepare('UPDATE portal_customers SET active=1 WHERE id=?').bind(customer.id).run();
  await env.PORTAL_DB.prepare('UPDATE portal_sessions SET expires_at=? WHERE customer_id=?').bind(Date.now()-1,customer.id).run();
  assert.equal((await call(env,'/snapshot','GET',undefined,login.cookie)).status,401);
 }finally{dispose();}
});
test('unchanged Docs heartbeat retains ciphertext and invalid newer input cannot be overwritten by older sync',async()=>{
 const {env,dispose}=database();try{
  await seedAccount(env);const before=await env.PORTAL_DB.prepare('SELECT * FROM portal_accounts').first();
  const paragraphs=[{text:'test@example.invalid'},{text:'synthetic-password'},{text:'2fa',links:[{url:'https://example.invalid/2fa?s=synthetic'}]}];
  const observed=Date.now()+10;
  assert.equal((await updateFromDoc(env,before.source_id,paragraphs,observed)).changed,false);
  const after=await env.PORTAL_DB.prepare('SELECT * FROM portal_accounts').first();
  assert.equal(after.secret,before.secret);assert.equal(after.updated_at,before.updated_at);assert(after.checked_at>=before.checked_at);
  await assert.rejects(()=>updateFromDoc(env,before.source_id,[],observed+2));
  assert((await updateFromDoc(env,before.source_id,paragraphs,observed+1)).ignored);
  assert((await env.PORTAL_DB.prepare('SELECT sync_error FROM portal_accounts').first()).sync_error);
  await updateFromDoc(env,before.source_id,paragraphs,observed+3);
  assert.equal((await env.PORTAL_DB.prepare('SELECT sync_error FROM portal_accounts').first()).sync_error,null);
 }finally{dispose();}
});
test('admin state batches reads and grants are validated atomically',async()=>{
 const {env,stats,dispose}=database();try{
  const token='synthetic-perf-bootstrap';
  await env.PORTAL_DB.prepare('INSERT INTO portal_config(key,value) VALUES(?,?)').bind('bootstrap:'+await digest(token),String(Date.now()+60000)).run();
  const admin=await call(env,'/admin/bootstrap','POST',{token});
  const customer=await createCustomer(env,'grantuser01');const account=await seedAccount(env);
  let before=stats.roundTrips;const state=await call(env,'/admin/state','GET',undefined,admin.cookie);
  assert.equal(state.status,200);assert.equal(stats.roundTrips-before,2,'auth + batched state');
  before=stats.roundTrips;
  assert.equal((await call(env,'/admin/grant','POST',{customerId:customer.id,accountId:account,duration:'3month'},admin.cookie)).status,200);
  assert.equal(stats.roundTrips-before,2,'auth + atomic grant');
  await env.PORTAL_DB.prepare('UPDATE portal_accounts SET active=0 WHERE id=?').bind(account).run();
  assert.equal((await call(env,'/admin/grant','POST',{customerId:customer.id,accountId:account,duration:'3month'},admin.cookie)).status,400);
 }finally{dispose();}
});
test('GitHub admin uses a separate in-memory bearer role, supports deletion, and preserves bootstrap/logout boundaries',async()=>{
 const {env,dispose}=database();const oldFetch=globalThis.fetch;
 const gh=(route,method='GET',data,token)=>{const req=request(route,method,data);req.headers.set('Origin','https://cotdostore.github.io');if(token)req.headers.set('Authorization','Bearer '+token);return req;};
 try{
  const user=await createCustomer(env,'githubadmin01','Test admin boundary','gh-admin-psid');
  const customerToken=(await (await handlePortal(gh('/login','POST',{accessId:'githubadmin01'}),env)).json()).token;
  const preflight=await handlePortal(gh('/admin/customer','OPTIONS'),env);assert.equal(preflight.status,204);assert.match(preflight.headers.get('Access-Control-Allow-Methods'),/DELETE/);assert(!preflight.headers.has('Access-Control-Allow-Credentials'));
  globalThis.fetch=async url=>{assert.equal(url,'https://api.github.com/repos/cotdostore/shopweb');return Response.json({permissions:{admin:true}});};
  const adminResponse=await handlePortal(gh('/admin/login','POST',{token:'synthetic-github-admin-token'}),env);
  assert.equal(adminResponse.status,200);assert(!adminResponse.headers.has('Set-Cookie'));assert.equal(adminResponse.headers.get('Access-Control-Allow-Origin'),'https://cotdostore.github.io');
  const adminToken=(await adminResponse.json()).token;assert.match(adminToken,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await handlePortal(gh('/admin/state','GET',undefined,adminToken),env)).status,200);
  assert.equal((await handlePortal(gh('/admin/state','GET',undefined,customerToken),env)).status,401);
  assert.equal((await handlePortal(gh('/snapshot','GET',undefined,adminToken),env)).status,401);
  assert.equal((await handlePortal(gh('/admin/customer','DELETE',{id:user.id},customerToken),env)).status,401);
  await handlePortal(gh('/logout','POST',{admin:true},customerToken),env);
  assert.equal((await handlePortal(gh('/admin/state','GET',undefined,adminToken),env)).status,200,'customer logout cannot revoke an admin session');
  assert.equal((await handlePortal(gh('/snapshot','GET',undefined,customerToken),env)).status,200,'wrong-role logout does not revoke the customer session either');
  assert.equal((await handlePortal(gh('/admin/customer','DELETE',{id:user.id},adminToken),env)).status,200);
  assert.equal((await handlePortal(gh('/snapshot','GET',undefined,customerToken),env)).status,401);
  const evil=gh('/admin/state','GET',undefined,adminToken);evil.headers.set('Origin','https://evil.invalid');assert.equal((await handlePortal(evil,env)).status,403);
  await handlePortal(gh('/logout','POST',{admin:true},adminToken),env);
  assert.equal((await handlePortal(gh('/admin/state','GET',undefined,adminToken),env)).status,401);
  const setup='synthetic-github-setup-token';
  await env.PORTAL_DB.prepare('INSERT INTO portal_config(key,value) VALUES(?,?)').bind('bootstrap:'+await digest(setup),String(Date.now()+60000)).run();
  const bootstrap=await handlePortal(gh('/admin/bootstrap','POST',{token:setup}),env);assert.equal(bootstrap.status,200);assert(!bootstrap.headers.has('Set-Cookie'));
  const setupToken=(await bootstrap.json()).token;assert.equal((await handlePortal(gh('/admin/state','GET',undefined,setupToken),env)).status,200);
  assert.equal((await handlePortal(gh('/admin/bootstrap','POST',{token:setup}),env)).status,401);
 }finally{globalThis.fetch=oldFetch;dispose();}
});
