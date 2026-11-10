import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
const names=['bot/worker.js','bot/commands.mjs','portal/index.mjs','portal/crypto.mjs','portal/parser.mjs'];
const modules=Object.fromEntries(await Promise.all(names.map(async name=>{
 let source=await readFile(path.join(root,name),'utf8');
 // Keep the deployed Worker module layout while sharing the browser's canonical file.
 if(name==='portal/index.mjs')source=source.replace("from '../../portal-assets/duration.mjs'","from './duration.mjs'");
 if(name==='bot/worker.js')source=source.replace("from '../../prices-core.js'","from '../shared/prices-core.mjs'");
 return [name,source];
})));
modules['portal/duration.mjs']=await readFile(path.join(root,'../portal-assets/duration.mjs'),'utf8');
modules['shared/prices-core.mjs']=await readFile(path.join(root,'../prices-core.js'),'utf8');
await mkdir(path.join(root,'dist'),{recursive:true});
await writeFile(path.join(root,'dist/modules.json'),JSON.stringify(modules));
console.log('Packaged 7 backend modules. Public pages are edited directly; no duplicate files generated.');
