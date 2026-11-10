import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
test('customer polling uses one request, keeps unchanged cards, masks updates and rejects late responses',async()=>{
 class Element{
  constructor(){this.hidden=false;this.value='';this.children=[];this.dataset={};this.listeners={};this.type='password';this.rebuilds=0;this.classList={toggle(){}};}
  addEventListener(name,callback){this.listeners[name]=callback;}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.rebuilds++;this.children=items.flatMap(item=>item.fragment?item.children:[item]);}
  setAttribute(name,value){this[name]=value;}
  removeAttribute(name){delete this[name];}
  scrollIntoView(){}
  closest(){return this;}
 }
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 get('dashboard').hidden=true;get('logout').hidden=true;
 const events={},timers=new Map(),requests=[];let nextTimer=0;
 const document={hidden:false,readyState:'complete',getElementById:get,querySelector:()=>({content:'https://api.example/portal/api'}),createElement:()=>new Element(),createDocumentFragment:()=>Object.assign(new Element(),{fragment:true}),addEventListener:(name,fn)=>events[name]=fn};
 const location={href:'https://cotdostore.github.io/shopweb-test1.1/chatgpt/',pathname:'/shopweb-test1.1/chatgpt/',hash:''};
 const context={document,location,URL,Intl,AbortController,console,window:{addEventListener:(name,fn)=>events[name]=fn},history:{replaceState:(_a,_b,url)=>{const parsed=new URL(url,location.href);location.pathname=parsed.pathname;location.hash=parsed.hash;}},setTimeout:(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})),navigator:{}};
 vm.createContext(context);vm.runInContext(readFileSync(new URL('../portal/web/customer.js',import.meta.url),'utf8'),context);
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 async function respond(index,data,status=200){requests[index].resolve(Response.json(data,{status}));await flush();}
 assert.equal(requests.length,1);await respond(0,{error:'login'},401);
 get('access-id').value='synthetic01';const login=get('login-form').listeners.submit({preventDefault(){}});
 await respond(1,{token:'synthetic-token'});assert.match(requests[2].url,/\/snapshot$/);
 const snapshot={accounts:[{id:'one',service:'chatgpt',label:'Plus',expires_at:null}],details:{id:'one',service:'chatgpt',label:'Plus',username:'preview@example.invalid',password:'synthetic-one',twoFactorUrl:'https://example.invalid/2fa',updatedAt:1,expiresAt:null}};
 await respond(2,snapshot);await login;assert.equal(get('password').value,'synthetic-one');assert.equal(get('dashboard').hidden,false);
 const rebuilt=get('services').rebuilds;
 async function poll(){const entry=[...timers].find(([,timer])=>timer.delay===15000);assert(entry);timers.delete(entry[0]);entry[1].fn();await flush();}
 await poll();assert.equal(requests.length,4);assert.match(requests[3].url,/snapshot\?account=one$/);
 await respond(3,snapshot);assert.equal(get('services').rebuilds,rebuilt);
 get('show-password').listeners.click();assert.equal(get('password').type,'text');
 await poll();await respond(4,{...snapshot,details:{...snapshot.details,password:'synthetic-two'}});assert.equal(get('password').type,'password');assert.equal(get('password').value,'synthetic-two');
 await poll();document.hidden=true;events.visibilitychange();assert.equal(requests[5].options.signal.aborted,true);assert.equal(get('password').value,'');
 await respond(5,snapshot);assert.equal(get('details').hidden,true,'late response cannot repopulate hidden credentials');assert(![...timers.values()].some(timer=>timer.delay===15000));
 document.hidden=false;events.visibilitychange();await respond(6,snapshot);
 await poll();const logout=get('logout').listeners.click();assert.equal(requests[7].options.signal.aborted,true);
 await respond(8,{ok:true});await logout;await respond(7,snapshot);
 assert.equal(get('dashboard').hidden,true);assert.equal(get('password').value,'');assert(![...timers.values()].some(timer=>timer.delay===15000));
});
