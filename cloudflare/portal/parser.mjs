export function normalizeId(value) {
 if (typeof value !== 'string') throw new Error('ID không hợp lệ.');
 const id=value.trim().toLowerCase();
 if (!/^[a-z0-9][a-z0-9_-]{5,63}$/.test(id)) throw new Error('ID cần 6–64 ký tự: chữ không dấu, số, _ hoặc -.');
 return id;
}
export function safeUrl(value) {
 try { const url=new URL(value); return url.protocol==='https:'&&!url.username&&!url.password ? url.href : null; } catch { return null; }
}
// Source paragraphs are data only. No source text is evaluated or used as commands.
export function parseCredentials(paragraphs) {
 if (!Array.isArray(paragraphs)||paragraphs.length>5000) throw new Error('Cấu trúc tài liệu không hợp lệ.');
 const rows=paragraphs.map(p=>({text:typeof p.text==='string'?p.text.trim():'',links:Array.isArray(p.links)?p.links:[]}));
 const emails=rows.flatMap((p,i)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.text)?[{i,value:p.text}]:[]);
 if(emails.length!==1) throw new Error('Cần đúng một dòng email tài khoản trong Docs.');
 const email=emails[0];
 const password=rows.slice(email.i+1).find(p=>p.text)?.text;
 if(!password||password.length>1000||/^(?:\(|lấy mã|lay ma|https?:)/i.test(password)) throw new Error('Chưa xác định được dòng mật khẩu ngay sau email.');
 const candidates=rows.filter(p=>/xác minh|xac minh|2fa|bấm vào đây|bam vao day/i.test(p.text))
 .flatMap(p=>p.links.map(l=>safeUrl(l.url)).filter(Boolean));
 const urls=[...new Set(candidates)];
 if(urls.length!==1) throw new Error('Cần đúng một link HTTPS lấy mã 2FA trong Docs.');
 return {username:email.value,password,twoFactorUrl:urls[0]};
}
export function fromGoogleDocument(doc) {
 const paragraphs=[];
 function content(items) {
  for(const item of items??[]) {
   if(item.paragraph) { const runs=(item.paragraph.elements??[]).map(e=>e.textRun).filter(Boolean);
    paragraphs.push({text:runs.map(r=>r.content??'').join(''),links:runs.filter(r=>r.textStyle?.link?.url).map(r=>({url:r.textStyle.link.url}))}); }
   for(const row of item.table?.tableRows??[]) for(const cell of row.tableCells??[]) content(cell.content);
  }
 }
 function tabs(items) {for(const tab of items??[]){content(tab.documentTab?.body?.content??tab.body?.content);tabs(tab.childTabs);}}
 if(doc.tabs?.length) tabs(doc.tabs); else content(doc.body?.content);
 return paragraphs;
}
