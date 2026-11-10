import http from 'node:http';
import {readFileSync} from 'node:fs';
const assets=new Map();
for(const [route,file,type] of [
 ['/chatgpt','chatgpt/index.html','text/html'],
 ['/chatgpt/customer.js','chatgpt/customer.js','text/javascript'],
 ['/admin','admin/index.html','text/html'],
 ['/admin/admin.js','admin/admin.js','text/javascript'],
 ['/portal-assets/portal.css','portal-assets/portal.css','text/css'],
 ['/portal-assets/duration.mjs','portal-assets/duration.mjs','text/javascript'],
 ['/portal-assets/Code.gs','portal-assets/Code.gs','text/plain'],
 ['/portal-assets/appsscript.json','portal-assets/appsscript.json','application/json']
])assets.set(route,{body:readFileSync(new URL('../'+file,import.meta.url),'utf8'),type});
http.createServer((req,res)=>{
 const asset=assets.get(new URL(req.url,'http://localhost').pathname.replace(/\/$/,''));
 if(!asset){res.writeHead(404);return res.end('Not Found');}
 res.writeHead(200,{'Content-Type':asset.type+'; charset=utf-8'});res.end(asset.body);
}).listen(4173,'127.0.0.1',()=>console.log('Static preview: http://127.0.0.1:4173/admin/'));
