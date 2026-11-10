/* ============================================================
   AUTO-FIT — giữ các dòng giá .row nằm gọn 1 DÒNG
   ------------------------------------------------------------
   CSS đã đặt white-space:nowrap cho .row. Đoạn này đo bề ngang
   chữ THẬT trên chính máy đang xem; card nào có dòng dài quá thì hạ
   cỡ chữ của cả nhóm trong card đó cho vừa, thay vì để chữ xuống hàng.
     - Hạ theo TỪNG CARD, cả nhóm .row cùng một cỡ (nhìn đều, không
       dòng to dòng nhỏ). Cỡ .note được CSS chia 3 bậc riêng.
     - Card nào đã vừa thì giữ nguyên, không đụng tới.
     - Sàn: không dưới 72% cỡ gốc và không dưới 8.6px để còn đọc được.
     - Nếu xuống tới sàn mà VẪN không đủ chỗ (máy siêu nhỏ), dòng đó
       được cho xuống hàng lại — thà xuống hàng chứ không cắt mất chữ.
     - Tự chạy lại khi xoay máy / đổi cỡ cửa sổ / font tải xong.
   ============================================================ */
(function () {
  var MIN_RATIO = 0.72;

  function fitGroup(nodes, minPx) {
    if (!nodes.length) return;
    var i;
    for (i = 0; i < nodes.length; i++) {
      nodes[i].style.fontSize = '';
      nodes[i].style.whiteSpace = '';
    }

    var base = parseFloat(getComputedStyle(nodes[0]).fontSize);
    if (!base) return;

    var ratio = 1;
    for (i = 0; i < nodes.length; i++) {
      var avail = nodes[i].parentElement ? nodes[i].parentElement.clientWidth : nodes[i].clientWidth;
      if (avail && nodes[i].scrollWidth > avail + 0.5)
        ratio = Math.min(ratio, avail / nodes[i].scrollWidth);
    }
    if (ratio >= 1) return;

    var floor = Math.max(minPx, base * MIN_RATIO);
    var size  = Math.max(floor, Math.floor(base * ratio * 100) / 100 - 0.05);

    for (var pass = 0; pass < 8; pass++) {
      for (i = 0; i < nodes.length; i++) nodes[i].style.fontSize = size + 'px';
      var over = false;
      for (i = 0; i < nodes.length; i++) {
        var passAvail = nodes[i].parentElement ? nodes[i].parentElement.clientWidth : nodes[i].clientWidth;
        if (nodes[i].scrollWidth > passAvail + 0.5) { over = true; break; }
      }
      if (!over || size <= floor) break;
      size = Math.max(floor, size - 0.2);
    }

    /* chạm sàn mà vẫn không đủ chỗ -> cho xuống hàng, không cắt chữ */
    for (i = 0; i < nodes.length; i++) {
      var finalAvail = nodes[i].parentElement ? nodes[i].parentElement.clientWidth : nodes[i].clientWidth;
      if (nodes[i].scrollWidth > finalAvail + 0.5)
        nodes[i].style.whiteSpace = 'normal';
    }
  }

  /* Giữ đúng bậc chữ trong từng card: divider > row > lead.
     Khi auto-fit phải hạ .row xuống (card có dòng dài), thì .lead
     của card đó cũng hạ theo cho khỏi bị lớn hơn row. Chỉ hạ, không phóng to. */
  function capBelow(nodes, ceiling) {
    for (var i = 0; i < nodes.length; i++) {
      var cur = parseFloat(getComputedStyle(nodes[i]).fontSize);
      if (cur > ceiling) nodes[i].style.fontSize = (Math.round(ceiling * 100) / 100) + 'px';
    }
  }
  function minFont(nodes) {
    var m = Infinity;
    for (var i = 0; i < nodes.length; i++)
      m = Math.min(m, parseFloat(getComputedStyle(nodes[i]).fontSize));
    return m;
  }

  /* Chia row theo từng nhóm được ngăn bởi divider. Ví dụ ChatGPT có
     XÀI CHUNG và XÀI RIÊNG: nhóm sau tự fit, không kéo cỡ chữ nhóm trước. */
  function priceGroups(info) {
    var groups = [];
    var current = [];
    var children = info ? info.children : [];
    for (var i = 0; i < children.length; i++) {
      if (children[i].classList.contains('divider')) {
        if (current.length) groups.push(current);
        current = [];
      } else if (children[i].classList.contains('row')) {
        current.push(children[i]);
      }
    }
    if (current.length) groups.push(current);
    return groups;
  }

  /* Đo đúng phần chữ đang được vẽ, rồi dùng cùng một bộ độ rộng cột cho
     mọi dòng trong một nhóm giá. Cả bảng giá vẫn nằm giữa card, nhưng
     từng dòng luôn bắt đầu từ cùng mép trái (giống setw). */
  function paintedWidth(el) {
    if (!el || !el.textContent.trim()) return 0;
    var range = document.createRange();
    range.selectNodeContents(el);
    return Math.ceil(range.getBoundingClientRect().width);
  }

  function clearPriceColumns(card) {
    var rows = card.querySelectorAll('.price-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].style.removeProperty('grid-template-columns');
      rows[i].style.removeProperty('width');
      rows[i].style.removeProperty('--price-gap');
    }
  }

  function alignPriceGroups(card, groups) {
    /* Bốn card này được phép ôm và căn giữa từng dòng riêng. */
    if (card.classList.contains('card-lines-centered')) return;

    var info = card.querySelector('.info');
    var available = info ? info.clientWidth : 0;
    if (!available) return;

    for (var g = 0; g < groups.length; g++) {
      var rows = groups[g];
      var hasSale = false;
      var termW = 0, secondW = 0, labelW = 0, finalW = 0;

      for (var i = 0; i < rows.length; i++) {
        var term = rows[i].querySelector('.price-term');
        var old = rows[i].querySelector('.old-price');
        var label = rows[i].querySelector('.discount-label');
        var finalPrice = rows[i].querySelector('.final-price');
        var sale = !!(label && label.textContent.trim());

        hasSale = hasSale || sale;
        termW = Math.max(termW, paintedWidth(term));
        if (sale) {
          secondW = Math.max(secondW, paintedWidth(old));
          labelW = Math.max(labelW, paintedWidth(label));
          finalW = Math.max(finalW, paintedWidth(finalPrice));
        } else {
          /* Không giảm giá: giá hiện tại nằm ở cột giá gốc (cột 2). */
          secondW = Math.max(secondW, paintedWidth(finalPrice));
        }
      }

      var columns = hasSale
        ? [termW, secondW, labelW, finalW]
        : [termW, secondW];
      var gaps = columns.length - 1;
      var sample = rows[0];
      var preferredGap = parseFloat(getComputedStyle(sample).columnGap) || 5;
      var roomForGap = (available - columns.reduce(function (sum, n) { return sum + n; }, 0)) / gaps;
      /* Nếu dòng dài, thu gap trước; vẫn giữ tối thiểu 2px để chữ không dính. */
      var gap = Math.max(2, Math.min(preferredGap, roomForGap));
      var template = columns.map(function (n) { return n + 'px'; }).join(' ');

      for (var j = 0; j < rows.length; j++) {
        rows[j].style.gridTemplateColumns = template;
        rows[j].style.width = 'max-content';
        rows[j].style.setProperty('--price-gap', gap + 'px');
      }
    }
  }

  /* Masonry bằng CSS Grid: card ngắn không còn để lại một mảng trống
     bên dưới. Mỗi card chiếm đúng số hàng nhỏ theo chiều cao thật của nó. */
  function layoutMasonry() {
    var grid = document.querySelector('.grid');
    if (!grid) return;

    var cards = grid.querySelectorAll('.card');
    grid.classList.remove('masonry-ready');
    for (var i = 0; i < cards.length; i++) cards[i].style.gridRowEnd = 'auto';

    var style = getComputedStyle(grid);
    var rowHeight = parseFloat(style.getPropertyValue('--masonry-row'));
    var cardGap = parseFloat(style.getPropertyValue('--card-gap'));
    if (!rowHeight || isNaN(cardGap)) return;

    for (var j = 0; j < cards.length; j++) {
      var height = cards[j].getBoundingClientRect().height;
      var span = Math.ceil((height + cardGap) / rowHeight);
      cards[j].style.gridRowEnd = 'span ' + span;
    }
    grid.classList.add('masonry-ready');
  }

  function fitAll() {
    var cards = document.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var card  = cards[i];
      clearPriceColumns(card);
      var leads = card.querySelectorAll('.lead');
      for (var k = 0; k < leads.length; k++) leads[k].style.fontSize = '';   // về cỡ gốc

      var rows  = card.querySelectorAll('.info .row');
      var groups = priceGroups(card.querySelector('.info'));
      for (var g = 0; g < groups.length; g++) fitGroup(groups[g], 8.6);
      alignPriceGroups(card, groups);

      if (rows.length && leads.length) capBelow(leads, minFont(rows) * 0.95);
    }
    layoutMasonry();
  }

  var t;
  function fitLater() { clearTimeout(t); t = setTimeout(fitAll, 120); }

  window.addEventListener('prices-ready', fitAll);
  window.addEventListener('DOMContentLoaded', fitAll);
  window.addEventListener('load', fitAll);
  window.addEventListener('resize', fitLater);
  window.addEventListener('orientationchange', fitLater);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll);
})();

