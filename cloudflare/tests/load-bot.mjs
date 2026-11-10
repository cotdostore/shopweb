import {readFileSync} from 'node:fs';
let version=0;
export async function loadBot(source=readFileSync(new URL('../bot/worker.js',import.meta.url),'utf8')){
 source=source.replace('import { DurableObject } from "cloudflare:workers";','class DurableObject {}');
 for(const [name,file] of [['../portal/index.mjs','../portal/index.mjs'],['./commands.mjs','../bot/commands.mjs'],['../shared/prices-core.mjs','../shared/prices-core.mjs']])source=source.replace("from '"+name+"'","from '"+new URL(file,import.meta.url).href+"'");
 source+='\nexport {fetchCatalog,findProduct,refineOptions,chooseCandidates,getProductFromText,processWebhook};\n// test instance '+version++;
 return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
