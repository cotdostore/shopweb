import {digest,accessHash,seal,unseal,randomToken} from './crypto.mjs';
import {normalizeId,parseCredentials,safeUrl} from './parser.mjs';
import {grantExpiry} from '../../portal-assets/duration.mjs';

const API='/portal/api', HOUR=3600000;
const GITHUB_ORIGIN='https://cotdostore.github.io';
const CUSTOMER_URL=GITHUB_ORIGIN+'/shopweb/chatgpt/';
const ADMIN_URL=GITHUB_ORIGIN+'/shopweb/admin/';
const customerCookie='__Host-cotdo_customer', adminCookie='__Host-cotdo_admin';
const headers={
 'Cache-Control':'no-store, private', 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
class Problem extends Error {constructor(message,status=400){super(message);this.status=status;}}
const reply=(data,status=200,extra={})=>Response.json(data,{status,headers:{...headers,...extra}});
const query=(env,sql,...params)=>env.PORTAL_DB.prepare(sql).bind(...params);
const now=()=>Date.now();
const cookie=(name,value,maxAge)=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
async function body(request,max=250000) {
 if(!request.headers.get('Content-Type')?.startsWith('application/json')) throw new Problem('Cần gửi JSON.',415);
 if(Number(request.headers.get('Content-Length')??0)>max) throw new Problem('Dữ liệu quá lớn.',413);
 const reader=request.body?.getReader(); if(!reader)throw new Problem('Thiếu dữ liệu.');
 const chunks=[];let size=0;
 try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new Problem('Dữ liệu quá lớn.',413);}chunks.push(value);}}
 finally{reader.releaseLock();}
 const data=new Uint8Array(size);let offset=0;for(const part of chunks){data.set(part,offset);offset+=part.length;}
 try{return JSON.parse(new TextDecoder().decode(data));}catch{throw new Problem('JSON không hợp lệ.');}
}
async function limit(env,key,maximum=20,period=600000) {
 const start=Math.floor(now()/period)*period;
 const bucket=await digest(key+':'+start);
 const row=await query(env,'INSERT INTO portal_rate_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count',bucket,start+period).first();
 if(row.count>maximum)throw new Problem('Bạn đã thử quá nhiều lần. Vui lòng thử lại sau 10 phút.',429);
}
async function adminSession(request,env) {
 const role='admin';
 const token=sessionToken(request,role);
 if(!token||token.length>100)throw new Problem('Vui lòng đăng nhập lại.',401);
 const row=await query(env,'SELECT * FROM portal_sessions WHERE token_hash=? AND role=? AND expires_at>?',await digest(token),role,now()).first();
 if(!row)throw new Problem('Phiên đăng nhập đã hết hạn.',401);
 return row;
}
function sessionToken(request,role) {
 if(request.headers.get('Origin')===GITHUB_ORIGIN) {
  const auth=request.headers.get('Authorization')??'';
  return /^Bearer [A-Za-z0-9_-]{43}$/.test(auth)?auth.slice(7):null;
 }
 const name=role==='admin'?adminCookie:customerCookie;
 return request.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);
}
async function newSession(env,role,id=null,bearer=false) {
 const token=randomToken(),ttl=role==='admin'?2*HOUR:12*HOUR;
 await query(env,'INSERT INTO portal_sessions(token_hash,customer_id,role,expires_at) VALUES(?,?,?,?)',await digest(token),id,role,now()+ttl).run();
 return bearer?token:cookie(role==='admin'?adminCookie:customerCookie,token,ttl/1000);
}
async function sessionReply(request,env,role,id=null) {
 if(request.headers.get('Origin')===GITHUB_ORIGIN)return reply({ok:true,token:await newSession(env,role,id,true)});
 return reply({ok:true},200,{'Set-Cookie':await newSession(env,role,id)});
}
async function adminLogin(request,env) {
 await limit(env,'admin:'+request.headers.get('CF-Connecting-IP'),10);
 const data=await body(request,2000),token=data.token;
 if(typeof token!=='string'||!/^\S{20,255}$/.test(token))throw new Problem('Nhập token GitHub của chủ repo.',401);
 const githubHeaders={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'CotDo-Portal'};
 const response=await fetch('https://api.github.com/repos/cotdostore/shopweb',{headers:githubHeaders,signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Problem('GitHub từ chối token hoặc token chưa có quyền đọc repo.',403);
 const repo=await body(response,50000);
 if(!repo.permissions?.admin)throw new Problem('Cần token có quyền quản trị repo cotdostore/shopweb.',403);
 return sessionReply(request,env,'admin');
}
export async function createCustomer(env,rawId,displayName='',messengerId=null) {
 const accessId=normalizeId(rawId),hash=await accessHash(accessId,env.PORTAL_KEY);
 const id=crypto.randomUUID();
 // Uniqueness is enforced by SQL, including concurrent /id requests.
 const result=await query(env,'INSERT INTO portal_customers(id,access_hash,access_encrypted,display_name,messenger_id,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id',
  id,hash,await seal(accessId,env.PORTAL_KEY,'customer:'+id),String(displayName||accessId).slice(0,100),messengerId,now()).first();
 if(!result) {
  const duplicate=await query(env,'SELECT id FROM portal_customers WHERE access_hash=?',hash).first();
  throw new Problem(duplicate?'Đã có ID này. Hãy chọn ID khác.':'Khách trong cuộc chat này đã có ID. Quản lý tại trang quản trị.',409);
 }
 return {id,accessId};
}
async function getCustomer(env,accessId){return query(env,'SELECT * FROM portal_customers WHERE access_hash=?',await accessHash(normalizeId(accessId),env.PORTAL_KEY)).first();}
async function decryptAccount(env,row) {
 const secret=await unseal(row.secret,env.PORTAL_KEY,'account:'+row.id);
 return {id:row.id,label:row.label,service:row.service,updatedAt:row.updated_at,checkedAt:row.checked_at,
  syncError:!!row.sync_error,stale:!row.checked_at||now()-row.checked_at>5*60000,expiresAt:row.expires_at,...secret};
}
// Authorization and current grants share one database snapshot; no permission cache.
async function customerSnapshot(request,env,selected,includeDetails=true) {
 const token=sessionToken(request,'customer');
 if(!token||token.length>100)throw new Problem('Vui lòng đăng nhập lại.',401);
 const rows=(await query(env,`SELECT c.display_name,a.id,a.service,a.label,a.updated_at,a.checked_at,a.sync_error,
 CASE WHEN ?=1 AND (a.id=? OR ? IS NULL) THEN a.secret END AS secret,g.expires_at
 FROM portal_sessions s JOIN portal_customers c ON c.id=s.customer_id AND c.active=1
 LEFT JOIN portal_grants g ON g.customer_id=c.id AND (g.expires_at IS NULL OR g.expires_at>?)
 LEFT JOIN portal_accounts a ON a.id=g.account_id AND a.active=1
 WHERE s.token_hash=? AND s.role='customer' AND s.expires_at>?
 ORDER BY a.service,a.label,a.id`,Number(includeDetails),selected,selected,now(),await digest(token),now()).all()).results;
 if(!rows.length)throw new Problem('Phiên đăng nhập đã hết hạn hoặc quyền truy cập đã bị khóa.',401);
 const available=rows.filter(row=>row.id);
 const account=selected?available.find(row=>row.id===selected):(available.length===1?available[0]:null);
 const accounts=available.map(({secret,display_name,...row})=>row);
 return {name:rows[0].display_name,accounts,details:includeDetails&&account?.secret?await decryptAccount(env,account):null};
}
export async function updateFromDoc(env,sourceId,paragraphs,observedAt=now()) {
 const row=await query(env,'SELECT * FROM portal_accounts WHERE source_id=?',sourceId).first();
 if(!row)throw new Problem('Docs chưa được gắn với dịch vụ.',404);
 if(!Number.isSafeInteger(observedAt)||observedAt>now()+60000||observedAt<now()-10*60000)throw new Problem('Mốc đồng bộ không hợp lệ.');
 if(observedAt<=row.observed_at)return {ok:true,ignored:true};
 let credentials;
 try {credentials=parseCredentials(paragraphs);}catch(error){
  await query(env,'UPDATE portal_accounts SET sync_error=?,observed_at=? WHERE id=? AND observed_at<?',error.message,observedAt,row.id,observedAt).run();
  throw new Problem(error.message,422);
 }
 const previous=row.secret?await unseal(row.secret,env.PORTAL_KEY,'account:'+row.id):null;
 const changed=JSON.stringify(previous)!==JSON.stringify(credentials);
 const updated=await query(env,`UPDATE portal_accounts SET secret=?,checked_at=?,updated_at=?,observed_at=?,sync_error=NULL WHERE id=? AND observed_at<? RETURNING id`,
  changed?await seal(credentials,env.PORTAL_KEY,'account:'+row.id):row.secret,now(),changed?now():row.updated_at,observedAt,row.id,observedAt).first();
 return {ok:true,changed:!!updated&&changed,ignored:!updated};
}
async function sync(request,env) {
 const auth=request.headers.get('Authorization')??'';
 if(!auth.startsWith('Bearer ')||auth.length>120)throw new Problem('Không được phép.',401);
 const tokenHash=await digest(auth.slice(7));
 const config=await query(env,"SELECT value FROM portal_config WHERE key='sync_token_hash' AND value=?",tokenHash).first();
 if(!config)throw new Problem('Sync token không hợp lệ.',401);
 const data=await body(request);
 return reply(await updateFromDoc(env,String(data.sourceId??''),data.paragraphs,data.observedAt));
}
async function adminRoute(request,env,path) {
 await adminSession(request,env);
 if(path==='/admin/state'&&request.method==='GET') {
  const [customerRows,accountRows,grantRows,configRows]=await env.PORTAL_DB.batch([
   query(env,'SELECT * FROM portal_customers ORDER BY created_at DESC LIMIT 1000'),
   query(env,'SELECT id,service,label,source_id,updated_at,checked_at,sync_error,active FROM portal_accounts ORDER BY service,label LIMIT 1000'),
   query(env,'SELECT * FROM portal_grants LIMIT 5000'),
   query(env,"SELECT key FROM portal_config WHERE key='sync_token_hash'")]);
  const customers=customerRows.results;
  const users=await Promise.all(customers.map(async row=>({id:row.id,accessId:await unseal(row.access_encrypted,env.PORTAL_KEY,'customer:'+row.id),name:row.display_name,active:!!row.active,messengerId:row.messenger_id})));
  return reply({customers:users,accounts:accountRows.results,grants:grantRows.results,syncConfigured:configRows.results.length>0});
 }
 const data=await body(request);
 if(path==='/admin/customers'&&request.method==='POST')return reply(await createCustomer(env,data.accessId,data.name),201);
 if(path==='/admin/customer'&&request.method==='DELETE') {
  if(typeof data.id!=='string'||!data.id.trim()||data.id.length>100)throw new Problem('Thiếu ID khách cần xóa.');
  if(!await deleteCustomer(env,data.id))throw new Problem('Không tìm thấy khách.',404);
  return reply({ok:true});
 }
 if(path==='/admin/customer'&&request.method==='PUT') {
  if(typeof data.active!=='boolean'||typeof data.id!=='string')throw new Problem('Thiếu ID/trạng thái khách.');
  const result=await query(env,'UPDATE portal_customers SET active=? WHERE id=? RETURNING id',Number(data.active),data.id).first();
  if(!result)throw new Problem('Không tìm thấy khách.',404);
  if(!data.active)await query(env,'DELETE FROM portal_sessions WHERE customer_id=?',data.id).run();
  return reply({ok:true});
 }
 if(path==='/admin/grant'&&['POST','DELETE'].includes(request.method)) {
  if(typeof data.customerId!=='string'||typeof data.accountId!=='string')throw new Problem('Chọn khách và tài khoản.');
  if(request.method==='DELETE')await query(env,'DELETE FROM portal_grants WHERE customer_id=? AND account_id=?',data.customerId,data.accountId).run();
  else {
   let expiry=data.expiresAt==null?null:Number(data.expiresAt);
   if(data.duration){try{expiry=grantExpiry(data.duration).expiresAt;}catch(error){throw new Problem(error.message);}}
   if(expiry!==null&&(!Number.isSafeInteger(expiry)||expiry<=now()))throw new Problem('Hạn dùng phải ở tương lai.');
   const granted=await query(env,`INSERT INTO portal_grants(customer_id,account_id,expires_at)
    SELECT c.id,a.id,? FROM portal_customers c JOIN portal_accounts a ON a.id=? AND a.active=1
    WHERE c.id=? AND c.active=1
    ON CONFLICT(customer_id,account_id) DO UPDATE SET expires_at=excluded.expires_at RETURNING customer_id`,expiry,data.accountId,data.customerId).first();
   if(!granted)throw new Problem('Khách hoặc tài khoản không khả dụng.');
  }
  return reply({ok:true});
 }
 if(path==='/admin/account'&&['POST','PUT'].includes(request.method)) {
  const id=request.method==='POST'?crypto.randomUUID():String(data.id??'');
  const service=String(data.service??'').trim().toLowerCase(),label=String(data.label??'').trim();
  if(!/^[a-z0-9-]{2,40}$/.test(service)||!label||label.length>100)throw new Problem('Nhập mã dịch vụ và tên tài khoản hợp lệ.');
  const source=data.sourceId?String(data.sourceId).trim():null;
  if(source&&!/^[a-zA-Z0-9_-]{10,200}$/.test(source))throw new Problem('ID Google Docs không hợp lệ.');
  const current=await query(env,'SELECT * FROM portal_accounts WHERE id=?',id).first();
  if(request.method==='PUT'&&!current)throw new Problem('Không tìm thấy tài khoản.',404);
  let secret=current?.secret??null;
  let updatedAt=current?.updated_at??null,checkedAt=current?.checked_at??null;
  if(data.credentials) {
   const value=data.credentials;
   if(typeof value.username!=='string'||!value.username.trim()||value.username.length>500||typeof value.password!=='string'||!value.password||value.password.length>1000||!safeUrl(value.twoFactorUrl))throw new Problem('Cần tài khoản, mật khẩu và link HTTPS 2FA hợp lệ.');
   secret=await seal({username:value.username.trim(),password:value.password,twoFactorUrl:safeUrl(value.twoFactorUrl)},env.PORTAL_KEY,'account:'+id);
   updatedAt=checkedAt=now();
  }
  try {
   if(request.method==='POST')await query(env,'INSERT INTO portal_accounts(id,service,label,source_id,secret,updated_at,checked_at,active) VALUES(?,?,?,?,?,?,?,?)',id,service,label,source,secret,updatedAt,checkedAt,data.active===false?0:1).run();
   else await query(env,'UPDATE portal_accounts SET service=?,label=?,source_id=?,secret=?,updated_at=?,checked_at=?,active=?,sync_error=NULL WHERE id=?',service,label,source,secret,updatedAt,checkedAt,data.active===false?0:1,id).run();
  }catch(error){if(String(error.message).includes('UNIQUE'))throw new Problem('Docs này đã được gắn với một tài khoản khác.',409);throw error;}
  return reply({ok:true,id});
 }
 if(path==='/admin/sync-token'&&request.method==='POST') {
  const token=randomToken();
  await query(env,"INSERT INTO portal_config(key,value) VALUES('sync_token_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",await digest(token)).run();
  return reply({token,endpoint:new URL(API+'/sync',request.url).href});
 }
 throw new Problem('Không tìm thấy API.',404);
}
const customerApi=route=>['/login','/logout','/me','/snapshot'].includes(route)||route.startsWith('/account/');
const githubApi=route=>customerApi(route)||['/admin/login','/admin/bootstrap','/admin/state','/admin/customers','/admin/customer','/admin/grant','/admin/account','/admin/sync-token'].includes(route);
export async function handlePortal(request,env) {
 const url=new URL(request.url),origin=request.headers.get('Origin');
 // The Apps Script integration authenticates with its own sync token.
 if(url.pathname===API+'/sync')return routePortal(request,env);
 if(url.pathname.startsWith(API+'/')&&origin&&origin!==url.origin) {
  const route=url.pathname.slice(API.length);
  if(origin!==GITHUB_ORIGIN||!githubApi(route))return reply({error:'Nguồn truy cập không được phép.'},403);
  const cors={'Access-Control-Allow-Origin':GITHUB_ORIGIN,'Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Vary':'Origin'};
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,...cors,'Access-Control-Max-Age':'600'}});
  const response=await routePortal(request,env);
  return new Response(response.body,{status:response.status,headers:{...Object.fromEntries(response.headers),...cors}});
 }
 return routePortal(request,env);
}
async function routePortal(request,env) {
 const url=new URL(request.url),path=url.pathname;
 if(path.replace(/\/$/,'')==='/portal/admin'&&request.method==='GET')return new Response(null,{status:302,headers:{...headers,Location:ADMIN_URL+url.search}});
 if(!path.startsWith(API+'/'))return null;
 if(!env.PORTAL_DB||!env.PORTAL_KEY)return reply({error:'Cổng dịch vụ chưa được cấu hình.'},503);
 try {
  const route=path.slice(API.length);
  if(route==='/sync'&&request.method==='POST')return await sync(request,env);
  const github=request.headers.get('Origin')===GITHUB_ORIGIN&&githubApi(route);
  if(!['GET','HEAD'].includes(request.method)&&request.headers.get('Origin')!==url.origin&&!github)throw new Problem('Nguồn truy cập không được phép.',403);
  if(route==='/login'&&request.method==='POST') {
   await limit(env,'login:'+request.headers.get('CF-Connecting-IP'));
   const data=await body(request,2000);let id;
   try{id=normalizeId(data.accessId);}catch{throw new Problem('ID không đúng hoặc đã bị khóa.',401);}
   // No endpoint exposes customer ID existence to unauthenticated visitors.
   const user=await getCustomer(env,id);
   if(!user?.active)throw new Problem('ID không đúng hoặc đã bị khóa.',401);
   return sessionReply(request,env,'customer',user.id);
  }
 if(route==='/admin/login'&&request.method==='POST')return await adminLogin(request,env);
 if(route==='/admin/bootstrap'&&request.method==='POST') {
  await limit(env,'bootstrap:'+request.headers.get('CF-Connecting-IP'),10);
  const data=await body(request,2000);
  if(typeof data.token!=='string'||data.token.length>100)throw new Problem('Link quản trị không hợp lệ.',401);
  const key='bootstrap:'+await digest(data.token);
  const result=await query(env,'DELETE FROM portal_config WHERE key=? AND CAST(value AS INTEGER)>? RETURNING key',key,now()).first();
  if(!result)throw new Problem('Link quản trị đã dùng hoặc hết hạn. Dùng token GitHub để kết nối lại.',401);
  return sessionReply(request,env,'admin');
 }
  if(route==='/logout'&&request.method==='POST') {
   const data=await body(request,1000),role=data.admin?'admin':'customer',name=data.admin?adminCookie:customerCookie;
   const token=sessionToken(request,role);
   if(token)await query(env,'DELETE FROM portal_sessions WHERE token_hash=? AND role=?',await digest(token),role).run();
   return github?reply({ok:true}):reply({ok:true},200,{'Set-Cookie':cookie(name,'',0)});
  }
  if(route.startsWith('/admin/'))return await adminRoute(request,env,route);
  if(request.method==='GET'&&['/me','/snapshot'].includes(route))return reply(await customerSnapshot(request,env,url.searchParams.get('account'),route==='/snapshot'));
  if(route.startsWith('/account/')&&request.method==='GET') {
   const snapshot=await customerSnapshot(request,env,decodeURIComponent(route.slice(9)));
   if(!snapshot.accounts.some(a=>a.id===decodeURIComponent(route.slice(9))))throw new Problem('Bạn chưa được cấp quyền dịch vụ này hoặc quyền đã hết hạn.',403);
   if(!snapshot.details)throw new Problem('Dịch vụ chưa có thông tin tài khoản.',503);
   return reply(snapshot.details);
  }
  throw new Problem('Không tìm thấy API.',404);
 }catch(error){
  if(error instanceof Problem)return reply({error:error.message},error.status);
  console.error(JSON.stringify({event:'portal_error',path,status:500}));
  return reply({error:'Chưa thể xử lý. Vui lòng thử lại sau.'},500);
 }
}

async function deleteCustomer(env,id) {
 // One transaction shared by web and Messenger; service accounts are preserved.
 const results=await env.PORTAL_DB.batch([
  query(env,'DELETE FROM portal_grants WHERE customer_id=?',id),
  query(env,'DELETE FROM portal_sessions WHERE customer_id=?',id),
  query(env,'DELETE FROM portal_customers WHERE id=? RETURNING id',id)]);
 return results[2].results.length>0;
}
// Called only after the existing bot verifies the exact Page message via Meta Graph.
export async function portalCommand(command,argument,recipient,env) {
 if(!env.PORTAL_DB||!env.PORTAL_KEY)return 'Cổng truy cập chưa được cấu hình.';
 const link=CUSTOMER_URL;
 try {
  const parts=argument.trim().split(/\s+/);
  if(command==='xoa'&&(parts.length!==1||!parts[0]))throw new Problem('Dùng /xoa ID để xóa một ID.');
  const accessId=normalizeId(parts[0]);
  if(command==='id') {
   await createCustomer(env,accessId,accessId,recipient);
   return `Đã tạo ID: ${accessId}\nNhập ID tại: ${link}\nShop sẽ cấp dịch vụ cho bạn sau khi xác nhận đơn.`;
  }
  const user=await getCustomer(env,accessId);
  if(!user)throw new Problem('Chưa có ID này. Dùng /id để tạo trước.');
  if(user.messenger_id!==recipient)throw new Problem('ID thuộc cuộc chat khác. Kiểm tra tại trang quản trị.');
  if(command==='xoa') {
   if(!await deleteCustomer(env,user.id))throw new Problem('Không tìm thấy khách.',404);
   return `Đã xóa ID: ${accessId}. Quyền truy cập và phiên đăng nhập đã được hủy.`;
  }
  if(command==='khoa'||command==='block') {
   await env.PORTAL_DB.batch([query(env,'UPDATE portal_customers SET active=0 WHERE id=?',user.id),query(env,'DELETE FROM portal_sessions WHERE customer_id=?',user.id)]);
   return 'Đã khóa quyền truy cập của ID này.';
  }
  if(command==='unblock') {
   await query(env,'UPDATE portal_customers SET active=1 WHERE id=?',user.id).run();
   return 'Đã mở khóa ID. Thời hạn dịch vụ giữ nguyên; khách cần đăng nhập lại.';
  }
  if(!user.active)throw new Problem('ID này đang bị khóa. Mở lại ở trang quản trị.');
  if(command==='cap') {
   const service=parts[1]?.toLowerCase()==='gpt'?'chatgpt':String(parts[1]??'').toLowerCase();
   let term;try{term=grantExpiry(parts[2]);}catch(error){throw new Problem(error.message);}
   const accounts=(await query(env,'SELECT id,label FROM portal_accounts WHERE service=? AND active=1',service).all()).results;
   if(accounts.length!==1)throw new Problem(accounts.length?'Dịch vụ có nhiều tài khoản. Chọn đúng tài khoản tại trang quản trị.':'Chưa có dịch vụ. Dùng /cap ID chatgpt hoặc cấp tại trang quản trị.');
   await query(env,'INSERT INTO portal_grants(customer_id,account_id,expires_at) VALUES(?,?,?) ON CONFLICT(customer_id,account_id) DO UPDATE SET expires_at=excluded.expires_at',user.id,accounts[0].id,term.expiresAt).run();
   const expiry=new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Ho_Chi_Minh'}).format(term.expiresAt);
   return `Đã cấp ${accounts[0].label} trong ${term.label}.\nHết hạn: ${expiry} (giờ Việt Nam).\nID truy cập: ${accessId}\n${link}\nNhập ID để xem tài khoản, mật khẩu và link 2FA mới nhất.`;
  }
  return `ID truy cập: ${accessId}\n${link}\nNhập ID để xem các dịch vụ đã được cấp.`;
 }catch(error){return error instanceof Problem||/ID/.test(error.message)?error.message:'Chưa thể cập nhật quyền. Vui lòng thử lại sau.';}
}
export async function cleanupPortal(env) {
 if(!env.PORTAL_DB)return;
 await env.PORTAL_DB.batch([query(env,'DELETE FROM portal_sessions WHERE expires_at<?',now()),query(env,'DELETE FROM portal_rate_limits WHERE expires_at<?',now())]);
}
