# Cốt Đờ Store — backend

- Trang khách: https://cotdostore.github.io/shopweb/customer-portal/
- Trang quản trị: https://cotdostore.github.io/shopweb/admin/
- API/bot: https://cotdo-messenger-bot.kazuto121100.workers.dev

Sửa giao diện trực tiếp trong `admin/`, `customer-portal/` và `portal-assets/`.
GitHub Pages chuyển link `/chatgpt/` cũ sang `/customer-portal/`; repo không giữ bản sao giao diện ở thư mục cũ.
`prices-core.js` là nguồn duy nhất của logic giá dùng chung cho web và bot.
`portal-assets/duration.mjs` là nguồn duy nhất của cách tính hạn dùng.
Thư mục `cloudflare/` chỉ giữ backend, schema và công cụ triển khai.

## Đóng gói và triển khai

Cần Node.js 18 trở lên:

```powershell
node cloudflare/build.mjs
```

Kết quả nằm trong `dist/modules.json`, được Git bỏ qua. Build không sinh file web.
Cấu hình Worker và D1 nằm trong `deployment.json`; schema nằm trong `portal/schema.sql`.

Upload các module bằng Cloudflare API dạng multipart, main module `bot/worker.js`.
Kế thừa toàn bộ bindings hiện có với `bindings_inherit=strict`, giữ Durable Object và cron.
Giữ các secret `PAGE_ACCESS_TOKEN`, `VERIFY_TOKEN`, `PORTAL_KEY`; không ghi secret vào repo.
Không đổi `PORTAL_KEY` khi dữ liệu D1 vẫn dùng khóa cũ.

## Đồng bộ Docs và quản lý khách

File Apps Script duy nhất nằm tại `portal-assets/Code.gs` và `portal-assets/appsscript.json`.
Script properties: `PORTAL_SYNC_URL`, `PORTAL_SYNC_TOKEN`.
Mỗi lượt chạy, script gọi GET `/portal/api/sync` bằng sync token để lấy các Docs của tài khoản đang bật trên web, rồi POST nội dung về cùng endpoint. Không trả thông tin khách hay mật khẩu trong danh sách.
Thêm, đổi hoặc tắt Docs ngay trên trang quản trị; không cần sửa Script properties hay tạo lại token. `PORTAL_DOC_IDS` cũ được bỏ qua.
Google account chạy script vẫn cần quyền đọc từng Docs. Nếu Docs chưa được chia sẻ cho account đó, script không thể đọc.
Nâng cấp bản cũ: triển khai backend mới trước, thay `Code.gs` trong dự án Apps Script hiện có. Giữ nguyên hai properties và trigger `syncPortal`; không cần cấp thêm scope.
Chạy `installSync` một lần để đọc Docs mỗi phút; trang khách kiểm tra lại mỗi 15 giây.
Token GitHub quản trị phải có quyền Admin đối với `cotdostore/shopweb`.
Phiên quản trị chỉ giữ trong bộ nhớ tab và hết hạn sau hai giờ.

Lệnh Page: `/id ID`, `/cap ID gpt 3month`, `/block ID`, `/unblock ID`, `/taikhoan ID`, `/xoa ID`.
`/admin` mở menu; `/xoa` chỉ xử lý ID thuộc cuộc chat hiện tại.
Nút Xóa ID trên web và lệnh `/xoa` dùng chung transaction xóa khách, quyền và phiên;
tài khoản dịch vụ dùng chung vẫn giữ nguyên.
