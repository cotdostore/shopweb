// Canonical command names appear once in the menu. Older names remain aliases.
const aliases={khoa:'block',sendpayment:'help',access:'admin'};
const commands=new Set(['admin','check','discount','time','sendprice','rs','sendmenu','help','bc','bccode','bcstat','bcstop','boton','botoff','botstatus','id','cap','block','unblock','taikhoan']);
export function parseAdminCommand(text){
 const match=String(text??'').trim().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
 if(!match)return null;
 const name=match[1].toLowerCase(),command=Object.hasOwn(aliases,name)?aliases[name]:name;
 return commands.has(command)?{command,caption:(match[2]??'').trim()}:null;
}
