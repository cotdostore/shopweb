import {grantExpiry} from '/portal/assets/duration.mjs';
const $=id=>document.getElementById(id);let state=null;
const formatter=new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Ho_Chi_Minh'});
const date=value=>value?formatter.format(value):'—';
function notice(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);$('status').hidden=!text;}
async function api(path,method='GET',data){const response=await fetch('/portal/api'+path,{method,cache:'no-store',credentials:'same-origin',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const result=await response.json();if(!response.ok){const error=new Error(result.error||'Kết nối lỗi.');error.status=response.status;throw error;}return result;}
async function action(fn){try{await fn();}catch(error){notice(error.message,true);}}
function node(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function button(text,fn,cls='secondary'){const el=node('button',text,cls);el.type='button';el.addEventListener('click',()=>action(async()=>{el.disabled=true;try{await fn();}finally{el.disabled=false;}}));return el;}
function options(id,items,label){const select=$(id),previous=select.value;select.replaceChildren();for(const item of items){const option=node('option',label(item));option.value=item.id;select.append(option);}if(items.some(x=>x.id===previous))select.value=previous;}
function render(){
 const accountsById=new Map(state.accounts.map(account=>[account.id,account]));
 const grantsByCustomer=new Map();
 for(const grant of state.grants){const list=grantsByCustomer.get(grant.customer_id);if(list)list.push(grant);else grantsByCustomer.set(grant.customer_id,[grant]);}
 $('stats').textContent=state.customers.length+' khách · '+state.accounts.length+' tài khoản dịch vụ';
 options('grant-customer',state.customers.filter(c=>c.active),c=>c.accessId+' · '+c.name);
 options('grant-account',state.accounts.filter(a=>a.active),a=>a.label+' / '+a.service);
 $('sync-state').textContent=state.syncConfigured?'Đã tạo token đồng bộ. Kiểm tra trạng thái từng tài khoản bên trên để xác nhận script đang chạy.':'Chưa tạo token đồng bộ. Hoàn tất các bước dưới để bật tự động.';
 $('customers').replaceChildren();const search=$('search').value.toLowerCase();
 for(const user of state.customers.filter(c=>(c.accessId+' '+c.name).toLowerCase().includes(search))){
  const row=node('tr'),name=node('td');name.append(node('strong',user.accessId),node('small',user.name+(user.messengerId?' · Messenger':'')));row.append(name);
  const status=node('td');status.append(node('span',user.active?'Đang mở':'Đã khóa','tag'+(user.active?'':' blocked')));row.append(status);
  const list=node('td');for(const grant of grantsByCustomer.get(user.id)??[]){
   const account=accountsById.get(grant.account_id),line=node('div');
   const expired=grant.expires_at&&grant.expires_at<=Date.now();line.append(node('span',(account?.label??'Tài khoản')+' · '+(expired?'Hết hạn ':grant.expires_at?'Đến ':'Không giới hạn ')+(grant.expires_at?date(grant.expires_at):'')));
   line.append(button('Thu hồi',async()=>{await api('/admin/grant','DELETE',{customerId:user.id,accountId:grant.account_id});await load();} ,'ghost'));list.append(line);
  }if(!list.childNodes.length)list.textContent='Chưa cấp dịch vụ';row.append(list);
  const tools=node('td'),wrap=node('div',null,'table-actions');
  wrap.append(button(user.active?'Khóa':'Mở lại',async()=>{await api('/admin/customer','PUT',{id:user.id,active:!user.active});await load();notice(user.active?'Đã khóa ID và hủy phiên truy cập.':'Đã mở lại ID. Hạn dùng dịch vụ giữ nguyên.');},user.active?'secondary danger':'secondary'));
  wrap.append(button('Chép tin nhắn',async()=>{await navigator.clipboard.writeText('ID truy cập của bạn: '+user.accessId+'\nhttps://cotdostore.github.io/shopweb/chatgpt/\nNhập ID để xem dịch vụ đã được cấp và thông tin mới nhất.');notice('Đã chép tin nhắn để gửi khách.');}));tools.append(wrap);row.append(tools);$('customers').append(row);
 }
 $('accounts').replaceChildren();
 for(const account of state.accounts){
  const row=node('tr'),name=node('td');name.append(node('strong',account.label),node('small',account.service+(!account.active?' · Đã tắt':'')));row.append(name);
  const source=node('td',account.source_id?'Google Docs':'Thủ công');if(account.source_id){const a=node('a','Mở Docs ↗');a.href='https://docs.google.com/document/d/'+encodeURIComponent(account.source_id)+'/edit';a.target='_blank';a.rel='noopener noreferrer';source.append(node('br'),a);}row.append(source);
  const sync=node('td');sync.append(node('span',account.sync_error?'Đồng bộ lỗi':!account.checked_at?'Chưa đồng bộ':Date.now()-account.checked_at>300000?'Chưa xác nhận gần đây':'Đã cập nhật','tag'+(account.sync_error?' blocked':'')),node('small',date(account.checked_at)));if(account.sync_error)sync.append(node('small',account.sync_error));row.append(sync);
  const edit=node('td');edit.append(button('Chỉnh sửa',()=>openAccount(account)));row.append(edit);$('accounts').append(row);
 }
}
async function load(){state=await api('/admin/state');$('login').hidden=true;$('admin').hidden=false;$('logout').hidden=false;render();}
function openAccount(account){$('account-form').reset();$('account-form').hidden=false;$('manual-fields').hidden=true;$('account-id').value=account?.id??'';$('account-service').value=account?.service??'chatgpt';$('account-label').value=account?.label??'';$('account-source').value=account?.source_id??'';$('account-active').checked=account?!!account.active:true;$('account-form-title').textContent=account?'Chỉnh sửa tài khoản':'Thêm tài khoản';$('account-form').scrollIntoView({behavior:'smooth'});}
$('admin-login').addEventListener('submit',event=>{event.preventDefault();const submit=event.submitter;action(async()=>{submit.disabled=true;try{await api('/admin/login','POST',{token:$('github-token').value.trim()});$('github-token').value='';await load();notice('Đã kết nối quản trị.');}finally{submit.disabled=false;}});});
$('customer-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{await api('/admin/customers','POST',{accessId:$('customer-id').value,name:$('customer-name').value});$('customer-form').reset();await load();notice('Đã tạo ID. Cấp tài khoản dịch vụ cho khách ở phần bên cạnh.');});});
$('grant-duration').addEventListener('change',()=>{$('custom-expiry').hidden=$('grant-duration').value!=='custom';$('grant-expiry').required=$('grant-duration').value==='custom';});
$('grant-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const duration=$('grant-duration').value,expiresAt=duration==='custom'?new Date($('grant-expiry').value).getTime():grantExpiry(duration).expiresAt;await api('/admin/grant','POST',{customerId:$('grant-customer').value,accountId:$('grant-account').value,...(duration==='custom'?{expiresAt}:{duration})});await load();notice('Đã cấp quyền đến '+date(expiresAt)+' (giờ VN).');});});
$('account-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const source=$('account-source').value.trim();let sourceId=source;const match=source.match(/^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);if(match)sourceId=match[1];const id=$('account-id').value,data={id,service:$('account-service').value,label:$('account-label').value,sourceId,active:$('account-active').checked};if($('manual-toggle').checked)data.credentials={username:$('account-user').value,password:$('account-password').value,twoFactorUrl:$('account-2fa').value};await api('/admin/account',id?'PUT':'POST',data);$('account-form').reset();$('account-form').hidden=true;await load();notice('Đã lưu tài khoản.');});});
$('manual-toggle').addEventListener('change',()=>{$('manual-fields').hidden=!$('manual-toggle').checked;for(const id of ['account-user','account-password','account-2fa'])$(id).required=$('manual-toggle').checked;});
$('sync-token').addEventListener('click',()=>action(async()=>{if(state.syncConfigured&&!confirm('Thay token sẽ ngắt script đang dùng token cũ. Tiếp tục?'))return;const data=await api('/admin/sync-token','POST',{});$('sync-config').textContent='PORTAL_SYNC_URL = '+data.endpoint+'\nPORTAL_SYNC_TOKEN = '+data.token+'\nPORTAL_DOC_IDS = '+JSON.stringify(state.accounts.map(a=>a.source_id).filter(Boolean))+'\n\nLưu các giá trị này vào Script properties. Token chỉ hiển thị ở lần tạo này.';$('sync-config').hidden=false;await load();notice('Đã tạo token mới. Cập nhật Script properties rồi chạy installSync.');}));
$('new-account').addEventListener('click',()=>openAccount(null));$('cancel-account').addEventListener('click',()=>{$('account-form').reset();$('account-form').hidden=true;});$('search').addEventListener('input',()=>state&&render());$('reload').addEventListener('click',()=>action(load));
$('logout').addEventListener('click',()=>action(async()=>{await api('/logout','POST',{admin:true});state=null;$('admin').hidden=true;$('login').hidden=false;$('logout').hidden=true;$('sync-config').textContent='';$('sync-config').hidden=true;$('account-form').reset();notice('Đã đăng xuất.');}));
const setup=new URLSearchParams(location.hash.slice(1)).get('setup');
if(setup){history.replaceState(null,'',location.pathname);action(async()=>{await api('/admin/bootstrap','POST',{token:setup});await load();notice('Đã mở phiên quản trị riêng. Link khởi tạo đã được sử dụng.');});}
else load().catch(error=>{if(error.status!==401)notice(error.message,true);});
