const endpoint = 'https://cotdo-two-factor.kazuto121100.workers.dev/code';
const accessToken = location.hash.slice(1);
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const code = document.querySelector('#code');
const copy = document.querySelector('#copy');
const remaining = document.querySelector('#remaining');
let timer;
let expiresAt = 0;
let pending;

function showStatus(message, error = false) {
  result.hidden = true;
  code.value = '';
  status.textContent = message;
  status.classList.toggle('error', error);
  status.hidden = false;
}

function tick() {
  const milliseconds = expiresAt - performance.now();
  if (milliseconds <= 0) {
    showStatus('Đang lấy mã mới…');
    timer = setTimeout(refresh, 0);
    return;
  }
  remaining.textContent = `Đổi mã sau ${Math.ceil(milliseconds / 1000)} giây`;
  timer = setTimeout(tick, Math.min(250, milliseconds));
}

async function refresh() {
  if (pending || document.hidden) return;
  const controller = new AbortController();
  pending = controller;
  const started = performance.now();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(endpoint, {
      headers: {Authorization: `Bearer ${accessToken}`},
      cache: 'no-store',
      signal: controller.signal,
    });
    if (pending !== controller) return;
    if (response.status === 401) {
      showStatus('Link 2FA không hợp lệ hoặc đã bị thu hồi.', true);
      return;
    }
    if (!response.ok) throw new Error('Không lấy được mã.');

    const data = await response.json();
    if (pending !== controller) return;
    if (!/^\d{6}$/.test(data.code) || !Number.isFinite(data.expiresIn)) throw new Error('Mã không hợp lệ.');
    expiresAt = started + data.expiresIn;
    if (expiresAt <= performance.now()) {
      timer = setTimeout(refresh, 1000);
      return;
    }
    code.value = data.code;
    copy.textContent = 'Sao chép';
    status.hidden = true;
    result.hidden = false;
    tick();
  } catch {
    if (pending !== controller) return;
    showStatus('Chưa lấy được mã. Đang thử lại…', true);
    timer = setTimeout(refresh, 5000);
  } finally {
    clearTimeout(timeout);
    if (pending === controller) pending = undefined;
  }
}

copy.addEventListener('click', async () => {
  if (performance.now() >= expiresAt) return;
  const current = code.value;
  try {
    await navigator.clipboard.writeText(current);
    if (code.value === current) copy.textContent = 'Đã chép';
  } catch {
    if (code.value === current) code.select();
  }
});

if (/^[0-9a-f]{64}$/.test(accessToken)) {
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.hidden) {
      pending?.abort();
      pending = undefined;
      showStatus('Đang lấy mã…');
    } else {
      refresh();
    }
  });
  refresh();
} else {
  showStatus('Mở link 2FA đầy đủ mà shop đã gửi.', true);
}
