# Cổng truy cập Cốt Đờ Store

Nguồn bot Messenger đang chạy được đưa vào `bot/worker.js`, sau đó mở rộng thêm module `portal/`. Phần bảng giá và các lệnh bot hiện có được giữ nguyên.

- Khách: https://cotdostore.github.io/shopweb/chatgpt/
- Quản trị: https://cotdostore.github.io/shopweb/admin/
- Trang khách GitHub Pages: `chatgpt/index.html`, `chatgpt/customer.js`, `chatgpt/portal.css`. Đây là trang thật, không chuyển hướng sang Worker.

## Lệnh Messenger

Admin gõ lệnh trong cuộc chat với đúng khách bằng tài khoản Page. Bot xác minh chính xác nội dung tin nhắn và người gửi qua Meta Graph trước khi thực hiện. Tin nhắn của khách không được gọi lệnh quản trị.

| Lệnh | Tác dụng |
| --- | --- |
| `/admin` | Menu chung cho quản trị và truy cập. `/access` vẫn là alias. |
| `/id linhhuynh01` | Tạo ID; báo trùng và không ghi đè. Gắn với cuộc chat hiện tại. |
| `/cap linhhuynh01 gpt 3month` | Cấp ChatGPT ba tháng từ lúc xử lý lệnh thành công. |
| `/block linhhuynh01` | Khóa ID và hủy mọi phiên hiện có. |
| `/unblock linhhuynh01` | Mở ID, không kéo dài hạn. Khách đăng nhập lại. |
| `/taikhoan linhhuynh01` | Gửi ID và link đăng nhập cho khách. |

`gpt` là tên tắt của `chatgpt`. Thời hạn nhận `7day`, `2week`, `3month`, `1year`, hoặc `7ngay`, `2tuan`, `3thang`, `1nam`. Cấp lại đặt hạn mới tính từ hiện tại. Tháng/năm theo lịch Việt Nam (UTC+7); ngày cuối tháng được chặn về ngày cuối hợp lệ của tháng đích. Khi dịch vụ có nhiều tài khoản, dùng trang quản trị để chọn đúng tài khoản thay vì bot tự chọn.

Hết hạn chỉ thu hồi quyền xem thông tin trên cổng này. Hệ thống không tự đăng xuất khách khỏi dịch vụ bên thứ ba hay đổi mật khẩu tài khoản dùng chung. Admin cần xử lý phiên/tài khoản tại dịch vụ nếu muốn thu hồi quyền đã đăng nhập ở đó.

## Truy cập và dữ liệu

Khách chỉ nhập một ID, theo yêu cầu của shop. ID được chuẩn hóa chữ thường; tối thiểu 6 ký tự. Đây cũng là mật khẩu truy cập, nên không công khai ID. Server lưu mã HMAC để tra cứu và bản mã AES-GCM để admin gửi lại; không có danh sách ID công khai. API đăng nhập giới hạn 20 lần/10 phút/IP. Phiên khách tồn tại tối đa 12 giờ. Mọi lần lấy thông tin đều kiểm tra quyền và hạn dùng trên server. Giao diện kiểm tra lại mỗi 15 giây khi mở và xóa thông tin khi ẩn trang hoặc lỗi xác minh quyền.

Cả trang khách và admin dùng GitHub Pages. Phiên bearer chỉ giữ trong bộ nhớ tab; không lưu ID, mật khẩu hay token vào localStorage/sessionStorage. Tải lại trang cần đăng nhập lại. API chỉ cho origin `https://cotdostore.github.io` và các request cùng origin Worker truy cập; mọi thao tác quản trị vẫn phải có phiên role admin riêng. Token khách không thể gọi chức năng quản trị. CORS không mở wildcard và không dùng cookie bên thứ ba. Trình duyệt có thể tái sử dụng kết quả preflight trong 600 giây; dữ liệu API luôn no-store.

Tài khoản, mật khẩu và URL 2FA được mã hóa AES-GCM bằng secret `PORTAL_KEY` của Worker, không lưu trong mã nguồn hoặc GitHub Pages. `PORTAL_DB` là D1 riêng. Đổi khóa cần di chuyển lại dữ liệu mã hóa; không ghi đè khóa khi triển khai lại.

Trang quản trị xác minh token GitHub có quyền admin repo `cotdostore/shopweb`, không lưu token. Phiên admin 2 giờ. Có thể cấp link khởi tạo admin một lần qua hash URL, hết hạn sau 24 giờ; token chỉ lưu dạng hash trong D1. Không gửi link khởi tạo cho khách. Link không được tạo bởi API công khai.

Nút **Xóa ID** trong danh sách khách yêu cầu xác nhận trước khi xóa vĩnh viễn khách, toàn bộ quyền dịch vụ và phiên đăng nhập của ID đó trong một transaction. Tài khoản dịch vụ dùng chung và các khách khác vẫn giữ nguyên. Sau khi xóa có thể tạo lại ID, nhưng cần cấp quyền mới; phiên cũ không được phục hồi.

## Google Docs → Cloudflare

Trong trang quản trị, tạo token đồng bộ và tải `Code.gs` cùng `appsscript.json`. Tạo Apps Script bằng tài khoản đọc được các Docs, dán hai file, rồi đặt Script properties:

```
PORTAL_SYNC_URL = https://cotdo-messenger-bot.kazuto121100.workers.dev/portal/api/sync
PORTAL_SYNC_TOKEN = <token tạo tại trang quản trị>
PORTAL_DOC_IDS = ["<id tài liệu>"]
```

Chạy `installSync`, cấp quyền Google một lần. Script đồng bộ lần đầu, sau đó cài trigger mỗi phút. `stopSync` gỡ trigger. Mỗi tài liệu phải được gắn với một tài khoản trong trang quản trị trước khi đồng bộ. Khi thêm Docs mới, cập nhật cả nguồn tài khoản và `PORTAL_DOC_IDS`.

Manifest bật Advanced Docs service v1 với scope `documents.readonly`, không xin quyền sửa Docs. Dự án Apps Script mặc định tự bật Docs API khi thêm service. Nếu dùng Google Cloud project tự quản lý, cần bật Google Docs API trong project đó.

Cấu trúc được hỗ trợ: đúng một đoạn chỉ chứa email tài khoản; đoạn không rỗng ngay sau đó là mật khẩu; một hyperlink HTTPS trên đoạn có nhãn “LẤY MÃ XÁC MINH”, “2FA” hoặc “BẤM VÀO ĐÂY”. Script đọc URL thật của hyperlink. Nhiều email/link hoặc dữ liệu thiếu sẽ báo lỗi, không thay thế bản hợp lệ. Các đoạn trong Docs chỉ được đọc như dữ liệu. Tài liệu gốc và quyền chia sẻ không bị sửa.

Docs không có trigger mỗi lần sửa như Sheets. Đây là đồng bộ gần thời gian thực: trigger khoảng mỗi phút và web tải lại mỗi 15 giây, phụ thuộc lịch chạy Google và kết nối. Quản trị có thể cập nhật thủ công trực tiếp trên web để áp dụng ngay; nếu cùng tài khoản còn nguồn Docs, lần đồng bộ kế tiếp sẽ lấy lại giá trị trong Docs. Nếu quá 5 phút chưa xác nhận nguồn, trang khách hiện cảnh báo bản gần nhất.

## Build và kiểm tra

Yêu cầu Node 18+ và Python 3 (chỉ phục vụ test SQLite, không dùng trong production).

```powershell
node cloudflare/build.mjs
node --test cloudflare/tests/admin.test.mjs cloudflare/tests/bot.test.mjs cloudflare/tests/customer.test.mjs cloudflare/tests/portal.test.mjs
node cloudflare/preview.mjs
```

Build xuất `chatgpt/`, `admin/` và thư mục `portal-assets/` dùng chung CSS, duration và file tải xuống cho Apps Script. Source giao diện chỉ sửa tại `portal/web/`, sau đó chạy build để cập nhật các file GitHub Pages. `_config.yml` loại source backend/giao diện gốc khỏi tài sản Pages; module giá dùng chung vẫn được xuất. Worker chỉ đóng gói 7 module backend trong `dist/modules.json` (được ignore), không chứa HTML/CSS/JS giao diện. `preview.mjs` chỉ kiểm tra bố cục; xác thực thực tế chạy trên GitHub Pages và Worker.

Worker giữ API, webhook Messenger và đồng bộ Docs. `/portal/admin` cũ chỉ chuyển sang trang admin GitHub; không chứa giao diện riêng. Các URL `/chatgpt`, `/chatgpt/access` và `/portal/assets/*` cũ trả 404. CSS không còn được sao chép riêng cho trang khách. Trang admin chưa đăng nhập không gọi API; đăng nhập vẫn xác minh quyền admin repo tại GitHub.

Chi tiết tối ưu, cách đo và giới hạn cache: [PERFORMANCE.md](PERFORMANCE.md).

## Triển khai qua Cloudflare connector

Upload module ES dạng multipart bằng API `PUT /accounts/{account_id}/workers/scripts/cotdo-messenger-bot` sau khi build. Main module là `bot/worker.js`. Upload toàn bộ module trong `dist/modules.json`. Metadata giữ `compatibility_date`, các bindings và Durable Object hiện có; thêm D1 `PORTAL_DB`. Hai secret cũ `PAGE_ACCESS_TOKEN`, `VERIFY_TOKEN` và secret mới `PORTAL_KEY` phải được kế thừa, không thay bằng chuỗi rỗng. Dùng `bindings_inherit=strict` để không âm thầm mất binding. Không thay cron Messenger hay migration của Durable Object. Bật logs và traces; không ghi ID truy cập, mật khẩu, link 2FA hay sync token vào logs.

Database/schema mới nằm ở `portal/schema.sql`. Cấu hình công khai trong `deployment.json`. Nội dung Docs được nhập vào D1 sau mã hóa, ngoài Git. Không publish thư mục `cloudflare/` như tài sản tĩnh của một host mới.

## Giới hạn cần biết

- Chưa cấu hình domain tùy chỉnh. Link chạy trên workers.dev; GitHub Pages có đường dẫn chuyển tiếp.
- ID là bearer secret: ai có ID còn hiệu lực có thể đăng nhập. Không phải xác minh danh tính người dùng.
- `/block` và hết hạn thu hồi việc lấy dữ liệu mới; không thể xóa thông tin khách đã nhìn thấy hoặc sao chép.
- Không có tin Messenger thử nghiệm hay broadcast nào được gửi khi triển khai. Các test dùng Meta Graph giả lập.
