const encoder = new TextEncoder();
// Bound cache: retain only the current deployment key, never account plaintext.
let imported;
function keyFor(secret,kind) {
 if(imported?.secret!==secret)imported={secret,keys:{}};
 const entry=imported;
 return entry.keys[kind]??=(kind==='hmac'
  ? crypto.subtle.importKey('raw',unbase64(secret),{name:'HMAC',hash:'SHA-256'},false,['sign'])
  : crypto.subtle.importKey('raw',unbase64(secret),'AES-GCM',false,['encrypt','decrypt']))
  .catch(error=>{delete entry.keys[kind];throw error;});
}
export const bytes = value => encoder.encode(value);
export function base64(data) { return btoa(Array.from(new Uint8Array(data), b => String.fromCharCode(b)).join('')); }
export function unbase64(data) { return Uint8Array.from(atob(data), c => c.charCodeAt(0)); }
export function randomToken() { return base64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''); }
export async function digest(value) { return base64(await crypto.subtle.digest('SHA-256', bytes(value))); }
export async function accessHash(value, secret) {
 const key = await keyFor(secret,'hmac');
 return base64(await crypto.subtle.sign('HMAC', key, bytes(value)));
}
export async function seal(value, secret, context) {
 const iv = crypto.getRandomValues(new Uint8Array(12));
 const key = await keyFor(secret,'aes');
 const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:bytes(context)}, key, bytes(JSON.stringify(value)));
 return JSON.stringify({v:1,iv:base64(iv),data:base64(encrypted)});
}
export async function unseal(value, secret, context) {
 const box = JSON.parse(value);
 if (box.v !== 1) throw new Error('Unsupported encryption version');
 const key = await keyFor(secret,'aes');
 const data = await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(box.iv),additionalData:bytes(context)}, key, unbase64(box.data));
 return JSON.parse(new TextDecoder().decode(data));
}
