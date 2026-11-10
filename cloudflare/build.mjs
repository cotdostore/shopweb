import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
const site=path.resolve(root,'..');
const api='https://cotdo-messenger-bot.kazuto121100.workers.dev/portal/api';
const meta='<meta name="portal-api" content="'+api+'"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; connect-src https://cotdo-messenger-bot.kazuto121100.workers.dev; img-src \'self\' data:; base-uri \'none\'; form-action \'self\'">';
for(const directory of ['chatgpt','admin','portal-assets'])await mkdir(path.join(site,directory),{recursive:true});
for(const [directory,page] of [['chatgpt','customer'],['admin','admin']]){
 const html=(await readFile(path.join(root,'portal/web',page+'.html'),'utf8'))
  .replace('<head>','<head>'+meta);
 await writeFile(path.join(site,directory,'index.html'),html);
 await writeFile(path.join(site,directory,page+'.js'),await readFile(path.join(root,'portal/web',page+'.js'),'utf8'));
}
for(const [file,source] of [['portal.css','web/portal.css'],['duration.mjs','duration.mjs'],['Code.gs','apps-script/Code.gs'],['appsscript.json','apps-script/appsscript.json']])
 await writeFile(path.join(site,'portal-assets',file),await readFile(path.join(root,'portal',source),'utf8'));
// A tiny compatibility link keeps cached older HTML working without duplicating CSS.
await writeFile(path.join(site,'chatgpt/portal.css'),"/* Compatibility for older cached customer HTML. */\n@import url('../portal-assets/portal.css');\n");
await rm(path.join(root,'portal/assets.mjs'),{force:true});
const names=['bot/worker.js','bot/commands.mjs','shared/prices-core.mjs','portal/index.mjs','portal/crypto.mjs','portal/parser.mjs','portal/duration.mjs'];
const modules=Object.fromEntries(await Promise.all(names.map(async name=>[name,await readFile(path.join(root,name),'utf8')])));
await mkdir(path.join(root,'dist'),{recursive:true});
await writeFile(path.join(root,'dist/modules.json'),JSON.stringify(modules));
console.log('Built '+names.length+' backend modules; customer/admin pages share GitHub assets.');
