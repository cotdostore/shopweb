const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const period = 30_000;
const site = 'https://cotdostore.github.io';
const encoder = new TextEncoder();

function decodeBase32(value) {
  const secret = value.replace(/\s/g, '').replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]+$/.test(secret) || ![0, 2, 4, 5, 7].includes(secret.length % 8)) {
    throw new Error('Invalid Base32 setup key');
  }

  const bytes = new Uint8Array(Math.floor(secret.length * 5 / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >>> bits) & 255;
    }
  }
  return bytes;
}

export async function generateCode(secret, time) {
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(time / period)));
  const key = await crypto.subtle.importKey(
    'raw', decodeBase32(secret), {name: 'HMAC', hash: 'SHA-1'}, false, ['sign']
  );
  const digest = new DataView(await crypto.subtle.sign('HMAC', key, counter.buffer));
  const offset = digest.getUint8(digest.byteLength - 1) & 15;
  const truncated = digest.getUint32(offset) & 0x7fffffff;
  return String(truncated % 1_000_000).padStart(6, '0');
}

function hash(value) {
  return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

export default {
  async fetch(request, env) {
    const headers = {
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Origin',
    };
    if (request.headers.get('Origin') === site) headers['Access-Control-Allow-Origin'] = site;
    const json = (data, status = 200) => Response.json(data, {status, headers});
    if (new URL(request.url).pathname !== '/code') return json({error: 'Không tìm thấy.'}, 404);

    if (request.method === 'OPTIONS' && headers['Access-Control-Allow-Origin']) {
      return new Response(null, {status: 204, headers: {
        ...headers,
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Authorization',
      }});
    }
    if (request.method !== 'GET') return json({error: 'Yêu cầu không hợp lệ.'}, 405);

    const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
    if (!token) return json({error: 'Link 2FA không hợp lệ hoặc đã bị thu hồi.'}, 401);
    if (!env.TOTP_ACCESS_TOKEN || !env.TOTP_SETUP_KEY) {
      return json({error: 'Chưa cấu hình mã 2FA.'}, 503);
    }
    const [provided, expected] = await Promise.all([hash(token), hash(env.TOTP_ACCESS_TOKEN)]);
    if (!crypto.subtle.timingSafeEqual(provided, expected)) {
      return json({error: 'Link 2FA không hợp lệ hoặc đã bị thu hồi.'}, 401);
    }

    try {
      const time = Date.now();
      const code = await generateCode(env.TOTP_SETUP_KEY, time);
      const expiresIn = Math.max(0, time - time % period + period - Date.now());
      return json({code, expiresIn});
    } catch {
      return json({error: 'Chưa tạo được mã 2FA.'}, 503);
    }
  },
};
