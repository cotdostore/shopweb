// Explicit live smoke check using temporary synthetic records. Not run by default.
// Bootstrap token arrives through hidden stdin, never command arguments or files.
import {randomBytes} from 'node:crypto';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('Ready for live test configuration on stdin (input is hidden).\n');
let input='';
const config=await new Promise((resolve,reject)=>{
 process.stdin.on('data',part=>{input+=part;if(input.includes('\n')||input.includes('\r')){process.stdin.pause();try{resolve(JSON.parse(input.trim()));}catch(error){reject(error);}}});
});
const origin='https://cotdo-messenger-bot.kazuto121100.workers.dev';let adminCookie;
async function api(route,method='GET',data,cookie=adminCookie){
 const r=await fetch(origin+'/portal/api'+route,{method,headers:{...(data?{'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{})},body:data?JSON.stringify(data):undefined});
 return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const admin=await api('/admin/bootstrap','POST',{token:config.token});
if(admin.status!==200)throw new Error('Admin test bootstrap failed: '+admin.status);adminCookie=admin.cookie;
const accessId='qa-'+randomBytes(12).toString('hex');
const customer=await api('/admin/customers','POST',{accessId,name:'Kiểm tra giao diện'});
if(customer.status!==201)throw new Error('Synthetic customer failed: '+customer.status);
const account=await api('/admin/account','POST',{service:'qa',label:'Dịch vụ kiểm thử',credentials:{username:'preview@example.invalid',password:'synthetic-preview-only',twoFactorUrl:'https://example.invalid/2fa'}});
if(account.status!==200)throw new Error('Synthetic account failed: '+account.status);
const grant=await api('/admin/grant','POST',{customerId:customer.data.id,accountId:account.data.id,duration:'7day'});
const login=await api('/login','POST',{accessId},'');
const detail=await api('/account/'+account.data.id,'GET',undefined,login.cookie);
if(grant.status!==200||login.status!==200||detail.status!==200||detail.data.password!=='synthetic-preview-only')throw new Error('Live permission/encryption test failed.');
console.log(JSON.stringify({ok:true,testAccessId:accessId,customerId:customer.data.id,accountId:account.data.id,decryptionVerified:true}));
process.exit(0);
