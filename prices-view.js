import {validatePriceData, priceDisplay} from './prices-core.js';

export function createPriceRow(item, doc = document) {
  const row = doc.createElement('p'); row.className = 'row price-row';
  const fields = [['b','red price-term',item.term],['span','old-price',item.oldPrice === null ? '' : priceDisplay(item.oldPrice)],['b','green discount-label',item.oldPrice === null ? '' : 'GIẢM CÒN'],['b','final-price',priceDisplay(item.price,item.priceSuffix)]];
  for (const [tag,cls,text] of fields) { const el = doc.createElement(tag); el.className = cls; el.textContent = text; row.append(el); }
  return row;
}
export function renderPrices(data, doc = document) {
  validatePriceData(data);
  const groups = new Map(data.groups.map(group => [group.id,group]));
  for (const anchor of doc.querySelectorAll('template[data-price-group]')) {
    const group = groups.get(anchor.dataset.priceGroup);
    if (!group) throw new Error('Thiếu nhóm giá: ' + anchor.dataset.priceGroup);
    for (const item of group.items.filter(item => item.available)) anchor.before(createPriceRow(item,doc));
  }
}
if (typeof document !== 'undefined') {
  const status = document.getElementById('price-status');
  fetch('./prices.json?t=' + Date.now(), {cache:'no-store'})
    .then(response => {if (!response.ok) throw new Error('Không tải được giá'); return response.json();})
    .then(data => {renderPrices(data); status.remove(); window.dispatchEvent(new Event('prices-ready'));})
    .catch(() => {status.textContent = 'Bảng giá đang cập nhật. Vui lòng tải lại hoặc nhắn sốp để kiểm tra giá.'; window.dispatchEvent(new Event('prices-ready'));});
}
