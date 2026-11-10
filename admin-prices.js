import {validatePriceData} from './prices-core.js';
const API = 'https://cotdo-messenger-bot.kazuto121100.workers.dev/price-admin/api';
let data, sha = null, token = '', dirty = false, busy = false;
const $ = id => document.getElementById(id);
const status = (text,error=false) => { $('status').textContent=text; $('status').classList.toggle('error',error); };
function controls() { $('save').disabled=!token||!data||busy||!dirty; $('download').disabled=!data||busy; $('connect').disabled=busy; $('reload').disabled=busy; $('disconnect').hidden=!token; $('stats').textContent= data ? data.groups.reduce((n,g)=>n+g.items.length,0)+' gói • '+(dirty?'Chưa lưu':'Đã đồng bộ') : ''; }
function changed() {dirty=true;controls();}
function input(type,value,onchange,cls='') {const el=document.createElement('input');el.type=type;el.className=cls;if(type==='checkbox')el.checked=value;else el.value=value??'';el.addEventListener('input',()=>{onchange(type==='checkbox'?el.checked:el.value);changed();});return el;}
function render() {
  $('groups').replaceChildren();
  for(const group of data.groups) {
    const section=document.createElement('section');section.dataset.search=(group.product+' '+group.variant).toLowerCase();
    const title=document.createElement('h2');title.textContent=group.product;section.append(title);
    const variant=document.createElement('p');variant.className='muted';variant.textContent=group.variant||'Các gói đang bán';section.append(variant);
    const overflow=document.createElement('div');overflow.className='overflow';const table=document.createElement('table');
    const head=document.createElement('tr');for(const text of ['THỜI HẠN / LOẠI GÓI','GIÁ BÁN (VND)','GIÁ GỐC (VND)','ĐƠN VỊ','ĐANG BÁN','']){const th=document.createElement('th');th.textContent=text;head.append(th);}table.append(head);
    for(const item of group.items) {
      const row=document.createElement('tr');const cells=[input('text',item.term,v=>item.term=v,'term'),input('number',item.price,v=>item.price=Number(v)),input('number',item.oldPrice,v=>item.oldPrice=v===''?null:Number(v)),null,input('checkbox',item.available,v=>item.available=v)];
      for(let i=1;i<=2;i++){cells[i].min='1000';cells[i].step='1000';}
      const suffix=document.createElement('select');for(const [value,text] of [['','Theo thời hạn'],['/THÁNG','Mỗi tháng'],['/NĂM','Mỗi năm']]){const option=document.createElement('option');option.value=value;option.textContent=text;suffix.append(option);}suffix.value=item.priceSuffix;suffix.addEventListener('change',()=>{item.priceSuffix=suffix.value;changed();});cells[3]=suffix;
      const remove=document.createElement('button');remove.className='danger';remove.textContent='XÓA';remove.addEventListener('click',()=>{if(!confirm('Xóa gói '+item.term+'?'))return;group.items=group.items.filter(x=>x.id!==item.id);changed();render();});cells.push(remove);
      for(let i=0;i<cells.length;i++){const cell=document.createElement('td');if(cells[i].tagName!=='BUTTON')cells[i].setAttribute('aria-label',group.product+' '+item.term+' '+head.children[i].textContent);cell.append(cells[i]);row.append(cell);}table.append(row);
    }
    overflow.append(table);section.append(overflow);
    const add=document.createElement('button');add.className='secondary';add.textContent='+ THÊM GÓI';add.addEventListener('click',()=>{group.items.push({id:'plan-'+crypto.randomUUID(),term:'1 THÁNG',price:10000,oldPrice:null,priceSuffix:'',available:true});changed();render();});section.append(add);$('groups').append(section);
  }
  filter();controls();
}
function filter(){const query=$('search').value.trim().toLowerCase();for(const section of $('groups').children)section.hidden=!section.dataset.search.includes(query);}
async function api(method,body) {
  const response=await fetch(API,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Không thể kết nối GitHub.');return result;
}
async function load(fromGitHub=!!token) {
  if(dirty&&!confirm('Bỏ các thay đổi chưa lưu và tải lại giá?'))return;
  busy=true;controls();try {
    const result=fromGitHub?await api('GET'):await fetch('./prices.json?t='+Date.now(),{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Không tải được bảng giá');return r.json();}).then(data=>({data}));
    data=validatePriceData(result.data);sha=result.sha??null;dirty=false;render();status(fromGitHub?'Đã kết nối GitHub. Sửa giá rồi nhấn LƯU VÀO GITHUB.':'Có thể sửa và tải JSON. Kết nối GitHub để lưu trực tiếp.');
  }catch(error){status(error.message,true);throw error;}finally{busy=false;controls();}
}
$('connect').addEventListener('click',async()=>{const value=$('github-token').value.trim();if(!value)return status('Nhập token GitHub để kết nối.',true);token=value;try{await load(true);$('github-token').value='';}catch{token='';sha=null;controls();}});
$('disconnect').addEventListener('click',()=>{token='';sha=null;$('github-token').value='';controls();status('Đã ngắt GitHub. Bản đang sửa vẫn ở trong tab này.');});
$('save').addEventListener('click',async()=>{
  try{validatePriceData(data);}catch(error){return status(error.message,true);}
  if(!sha)return status('Kết nối lại GitHub để lấy phiên bản mới nhất.',true);
  busy=true;controls();try{const result=await api('PUT',{sha,data});sha=result.sha;dirty=false;status('Đã lưu vào GitHub. Bảng giá web cần chờ GitHub Pages cập nhật; bot đọc cùng dữ liệu mới.');controls();}catch(error){status(error.message,true);}finally{busy=false;controls();}
});
$('download').addEventListener('click',()=>{try{validatePriceData(data);const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='prices.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){status(error.message,true);}});
$('reload').addEventListener('click',()=>load().catch(()=>{}));$('search').addEventListener('input',filter);
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
load(false).catch(()=>{});
