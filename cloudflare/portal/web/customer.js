const $=id=>document.getElementById(id);
const remoteApi=document.querySelector('meta[name="portal-api"]')?.content;
const pageBase=new URL('./',location.href).pathname;
// Sessions stay in memory. Credentials and permissions are never cached across requests.
let accessToken=null,selected=null,details=null,timer=null,controller=null,generation=0,serviceVersion='';
const formatter=new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Ho_Chi_Minh'});
const date=value=>value?formatter.format(value):'—';
function notice(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);$('status').hidden=!text;}
async function api(path,method='GET',data,signal){
 const response=await fetch(remoteApi+path,{method,signal,credentials:'omit',cache:'no-store',headers:{...(data?{'Content-Type':'application/json'}:{}),...(accessToken?{Authorization:'Bearer '+accessToken}:{})},body:data?JSON.stringify(data):undefined});
 const result=await response.json();if(!response.ok){const error=new Error(result.error||'Chưa kết nối được.');error.status=response.status;throw error;}return result;
}
function viewUrl(access){return pageBase+(access?'#access':'');}
function clearDetails(){details=null;$('password').value='';$('username').value='';$('two-factor').removeAttribute('href');$('details').hidden=true;}
function cancelRefresh(){generation++;controller?.abort();controller=null;clearTimeout(timer);timer=null;}
function loggedOut(){cancelRefresh();accessToken=null;selected=null;serviceVersion='';clearDetails();$('login').hidden=false;$('dashboard').hidden=true;$('logout').hidden=true;$('services').replaceChildren();history.replaceState(null,'',viewUrl(false));}
function renderDetails(data){
 if(!data){clearDetails();return;}
 const previous=details;details=data;
 $('account-label').textContent=data.label;$('account-state').textContent=data.service==='chatgpt'?'ChatGPT':data.service;
 $('username').value=data.username;$('password').value=data.password;
 if(!previous||previous.password!==data.password){$('password').type='password';$('show-password').textContent='Hiện';$('show-password').setAttribute('aria-pressed','false');}
 $('two-factor').href=data.twoFactorUrl;$('sync-warning').hidden=!data.syncError&&!data.stale;
 $('updated').textContent='Cập nhật: '+date(data.updatedAt)+' · giờ VN';$('expiry').textContent=data.expiresAt?'Hết hạn: '+date(data.expiresAt):'Theo thời hạn shop cấp';$('details').hidden=false;
}
function renderServices(accounts){
 // Heartbeats change checked_at every minute; they do not require rebuilding cards.
 const version=JSON.stringify(accounts.map(a=>[a.id,a.service,a.label,a.expires_at]));
 if(version===serviceVersion)return;
 serviceVersion=version;const fragment=document.createDocumentFragment();
 for(const account of accounts){
  const button=document.createElement('button');button.className='service-card';button.dataset.id=account.id;
  const icon=document.createElement('span');icon.className='service-icon';icon.textContent=account.service==='chatgpt'?'✳':account.service.slice(0,1).toUpperCase();
  const title=document.createElement('strong');title.textContent=account.label;
  const caption=document.createElement('small');caption.textContent=account.expires_at?'Hết hạn '+date(account.expires_at):'Dịch vụ đang khả dụng';
  button.append(icon,title,caption);fragment.append(button);
 }
 $('services').replaceChildren(fragment);
}
async function refresh(scroll=false){
 cancelRefresh();if(document.hidden)return;
 const version=generation;const pending=new AbortController();controller=pending;
 const timeout=setTimeout(()=>pending.abort(new Error('Kết nối quá lâu.')),12000);
 try{
  const data=await api('/snapshot'+(selected?'?account='+encodeURIComponent(selected):''),'GET',undefined,pending.signal);
  if(version!==generation)return;
  $('login').hidden=true;$('dashboard').hidden=false;$('logout').hidden=false;
  const target=viewUrl(true);if(location.pathname+location.hash!==target)history.replaceState(null,'',target);
  $('greeting').textContent='Dịch vụ của bạn';$('empty').hidden=data.accounts.length>0;renderServices(data.accounts);
  if(selected&&!data.accounts.some(a=>a.id===selected))selected=null;
  if(data.details)selected=data.details.id;
  renderDetails(data.details);notice('');
  for(const card of $('services').children)card.classList.toggle('selected',card.dataset.id===selected);
  if(scroll&&data.details)$('details').scrollIntoView({behavior:'smooth',block:'nearest'});
 }catch(error){
  if(version!==generation||error.name==='AbortError')return;
  if(error.status===401){loggedOut();return;}
  clearDetails();notice('Chưa xác nhận được quyền truy cập. Đang thử kết nối lại.',true);
 }finally{
  clearTimeout(timeout);
  if(version===generation){controller=null;if(!$('dashboard').hidden&&!document.hidden)timer=setTimeout(refresh,15000);}
 }
}
$('services').addEventListener('click',event=>{const card=event.target.closest('button[data-id]');if(!card)return;if(selected!==card.dataset.id)clearDetails();selected=card.dataset.id;refresh(true);});
$('login-form').addEventListener('submit',async event=>{event.preventDefault();$('login-submit').disabled=true;cancelRefresh();notice('');try{const result=await api('/login','POST',{accessId:$('access-id').value});if(remoteApi)accessToken=result.token;$('access-id').value='';await refresh();}catch(error){notice(error.message,true);}finally{$('login-submit').disabled=false;}});
$('logout').addEventListener('click',async()=>{cancelRefresh();clearDetails();try{await api('/logout','POST',{});loggedOut();notice('Đã đăng xuất.');}catch(error){loggedOut();notice(error.message,true);}});
$('show-password').addEventListener('click',()=>{const show=$('password').type==='password';$('password').type=show?'text':'password';$('show-password').textContent=show?'Ẩn':'Hiện';$('show-password').setAttribute('aria-pressed',String(show));});
async function copy(id,button){try{await navigator.clipboard.writeText($(id).value);const old=button.textContent;button.textContent='Đã chép';setTimeout(()=>button.textContent=old,1500);}catch{$(id).select();notice('Chọn và sao chép trường thông tin này trên thiết bị của bạn.');}}
$('copy-user').addEventListener('click',event=>copy('username',event.currentTarget));$('copy-password').addEventListener('click',event=>copy('password',event.currentTarget));
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelRefresh();clearDetails();}else refresh();});
window.addEventListener('pagehide',()=>{cancelRefresh();clearDetails();});
window.addEventListener('pageshow',()=>refresh());
if(document.readyState==='complete')refresh();
