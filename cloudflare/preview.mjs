import http from 'node:http';
import assets from './portal/assets.mjs';
import {readFileSync} from 'node:fs';
const customer={};
for(const [route,file,type] of [['/chatgpt','index.html','text/html; charset=utf-8'],['/chatgpt/customer.js','customer.js','text/javascript; charset=utf-8'],['/chatgpt/portal.css','portal.css','text/css; charset=utf-8']])customer[route]={body:readFileSync(new URL('../chatgpt/'+file,import.meta.url),'utf8'),type};
const server=http.createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname.replace(/\/$/,'');
 const asset=customer[path]??assets[path];
 if(asset){res.writeHead(200,{'Content-Type':asset.type});return res.end(asset.body);}
 if(req.url.startsWith('/portal/api/')){res.writeHead(401,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'Đăng nhập tại bản Cloudflare sau khi triển khai.'}));}
 res.writeHead(404);res.end('Not Found');
});
server.listen(4173,'127.0.0.1',()=>console.log('Local preview: http://127.0.0.1:4173/chatgpt'));
