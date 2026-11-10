export function validatePriceData(data) {
  if (!data || data.version !== 1 || data.currency !== 'VND' || !Array.isArray(data.groups) || data.groups.length < 1 || data.groups.length > 100) throw new Error('Dữ liệu bảng giá không hợp lệ.');
  const ids = new Set(); let count = 0;
  const id = value => { if (typeof value !== 'string' || !/^[a-z0-9-]{1,100}$/.test(value) || ids.has(value)) throw new Error('Mã gói trùng hoặc không hợp lệ.'); ids.add(value); };
  const text = (value, max, empty = false) => { if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error('Tên sản phẩm hoặc thời hạn không hợp lệ.'); };
  const price = value => { if (!Number.isSafeInteger(value) || value < 1000 || value > 1000000000) throw new Error('Giá phải là số nguyên VND, từ 1.000 đến 1 tỷ.'); };
  for (const group of data.groups) {
    id(group.id); text(group.product, 120); text(group.variant, 160, true);
    if (!Array.isArray(group.items)) throw new Error('Danh sách gói không hợp lệ.');
    for (const item of group.items) {
      id(item.id); text(item.term, 100); price(item.price);
      if (item.oldPrice !== null) { price(item.oldPrice); if (item.oldPrice <= item.price) throw new Error('Giá gốc phải cao hơn giá bán; để trống nếu không sale.'); }
      if (!['', '/THÁNG', '/NĂM'].includes(item.priceSuffix) || typeof item.available !== 'boolean') throw new Error('Trạng thái hoặc đơn vị giá không hợp lệ.');
      if (++count > 500) throw new Error('Tối đa 500 gói.');
    }
  }
  return data;
}
export function priceDisplay(value, suffix = '') {
  return String(Number((value / 1000).toFixed(3))) + 'K' + suffix;
}
