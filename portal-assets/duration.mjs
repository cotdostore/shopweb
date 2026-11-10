// Calendar months/years, clamped to the last day of the destination month.
export function grantExpiry(input,start=Date.now()) {
 const value=String(input??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s/g,'');
 const match=value.match(/^([1-9]\d{0,2})(month|months|thang|m|day|days|ngay|d|week|weeks|tuan|w|year|years|nam|y)$/);
 if(!match)throw new Error('Dùng /cap ID gpt 3month (hoặc 7day, 2week, 1year).');
 const n=Number(match[1]),unit=match[2];
 if(n>120)throw new Error('Thời hạn tối đa 120 đơn vị.');
 // Shop calendar: Vietnam (UTC+7), with no daylight-saving changes.
 const offset=7*3600000,date=new Date(start+offset);
 let label;
 if(/^(month|months|thang|m|year|years|nam|y)$/.test(unit)) {
  const isYear=/^(year|years|nam|y)$/.test(unit),day=date.getUTCDate();
  date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+n*(isYear?12:1));
  const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  date.setUTCDate(Math.min(day,last));label=n+(isYear?' năm':' tháng');
 }else{const weeks=/^(week|weeks|tuan|w)$/.test(unit);date.setTime(start+offset+n*(weeks?7:1)*86400000);label=n+(weeks?' tuần':' ngày');}
 return {startsAt:start,expiresAt:date.getTime()-offset,label};
}
