import { DurableObject } from "cloudflare:workers";
import {handlePortal, portalCommand, cleanupPortal} from '../portal/index.mjs';
import {parseAdminCommand} from './commands.mjs';
import {validatePriceData,priceDisplay} from '../shared/prices-core.mjs';

// One durable inbox per customer: message IDs, timers and session guards share
// the same strongly consistent storage across webhook requests and restarts.
export class CustomerInbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Cancel legacy reminders already queued before this version.
    this.ctx.storage.kv.delete("reminder");
    this.busy = false;
    this.processingVersion = null;
    const remoteKV = env.SESSION_KV;
    this.flowEnv = {
      ...env,
      CUSTOMER_COORDINATOR: this,
      SESSION_KV: {
        get: async (key, type) => {
          if (!this.isCustomerKey(key)) return remoteKV.get(key, type);
          const local = this.ctx.storage.kv.get("flow:" + key);
          if (local !== undefined) {
            if (local.deleted || (local.expiresAt && local.expiresAt <= Date.now())) return null;
            return type === "json" ? JSON.parse(local.value) : local.value;
          }
          // Existing customer sessions/support expiry remain available in KV.
          return remoteKV.get(key, type);
        },
        put: async (key, value, options = {}) => {
          if (!this.isCustomerKey(key)) return remoteKV.put(key, value, options);
          this.ctx.storage.kv.put("flow:" + key, {
            value: String(value),
            expiresAt: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : 0
          });
        },
        delete: async key => {
          if (!this.isCustomerKey(key)) return remoteKV.delete(key);
          // Tombstones prevent an old KV value from returning after reset.
          this.ctx.storage.kv.put("flow:" + key, { deleted: true });
        }
      }
    };
  }

  isCustomerKey(key) {
    const customer = this.ctx.storage.kv.get("customer");
    return customer && key.endsWith(":" + customer);
  }

  isOwnEcho(event) {
    if (event.message?.metadata === BOT_MESSAGE_METADATA) return true;
    const sent = this.ctx.storage.kv.get("outbound_ids") ?? [];
    return sent.some(item => item.mid === event.message?.mid);
  }

  recordOutbound(mid) {
    if (!mid) return;
    const now = Date.now();
    const sent = (this.ctx.storage.kv.get("outbound_ids") ?? [])
      .filter(item => now - item.at < 86400000);
    this.ctx.storage.kv.put("outbound_ids", [...sent, { mid, at: now }].slice(-1024));
  }

  canSendAutomaticReply() {
    return this.processingVersion === null ||
      this.processingVersion === this.ctx.storage.kv.get("version");
  }

  trackCustomerActivity(event) {
    const kv = this.ctx.storage.kv;
    const state = kv.get("sales_followup") ?? {checked:false};
    const eventAt = Math.min(Number(event.timestamp) || Date.now(), Date.now());
    const lastCustomerAt = Math.max(state.lastCustomerAt ?? 0, eventAt);
    if (lastCustomerAt === state.lastCustomerAt) return;
    kv.put("sales_followup", {
      ...state, lastCustomerAt,
      dueAt:state.checked ? 0 : lastCustomerAt + SALES_FOLLOWUP_MS,
      outcome:null
    });
  }

  async markChecked() {
    const kv = this.ctx.storage.kv;
    const state = kv.get("sales_followup") ?? {};
    kv.put("sales_followup", {...state,checked:true,label:"đã check",checkedAt:Date.now(),dueAt:0});
    await this.flowEnv.SESSION_KV.put("order_checked:" + kv.get("customer"), "đã check");
    await this.arm();
  }

  async beginNewOrder() {
    const kv = this.ctx.storage.kv;
    const state = kv.get("sales_followup") ?? {};
    if (!state.checked) return;
    await this.flowEnv.SESSION_KV.delete("order_checked:" + kv.get("customer"));
    kv.put("sales_followup", {
      ...state,checked:false,label:null,checkedAt:null,
      dueAt:state.lastCustomerAt ? state.lastCustomerAt + SALES_FOLLOWUP_MS : 0,
      outcome:null
    });
    await this.arm();
  }

  async sendSalesFollowupIfDue(senderId) {
    const kv = this.ctx.storage.kv;
    const state = kv.get("sales_followup");
    if (!state || state.checked || !state.dueAt || state.dueAt > Date.now()) return;
    this.processingVersion = kv.get("version");
    const enabled = await isBotEnabled(this.flowEnv);
    const adminSupportActive = !!await this.flowEnv.SESSION_KV.get("human_support:" + senderId);
    const current = kv.get("sales_followup");
    if (current?.checked || current?.lastCustomerAt !== state.lastCustomerAt ||
        !this.canSendAutomaticReply()) return;
    // Consume before sending so alarm retries and uncertain network results
    // cannot send the same reminder repeatedly.
    const token = crypto.randomUUID();
    const insideResponseWindow = Date.now() - state.lastCustomerAt < 24 * 60 * 60 * 1000 - 60000;
    kv.put("sales_followup", {
      ...current,dueAt:0,attemptToken:token,
      outcome:enabled && insideResponseWindow && !adminSupportActive ? "reserved" : "skipped"
    });
    if (!enabled || !insideResponseWindow || adminSupportActive) return;
    const response = await sendText(senderId, SALES_FOLLOWUP_TEXT, this.flowEnv);
    const latest = kv.get("sales_followup");
    if (latest?.attemptToken === token && latest.lastCustomerAt === state.lastCustomerAt) {
      kv.put("sales_followup", {
        ...latest,outcome:response.ok ? "sent" : "failed",
        sentAt:response.ok ? Date.now() : null
      });
    }
  }

  async receive(event, pageId, admin = false) {
    if (admin && this.isOwnEcho(event)) return;
    const customer = String(admin ? event.recipient?.id : event.sender?.id);
    const id = event.message?.mid || event.postback?.mid ||
      JSON.stringify([event.timestamp, admin, event.postback?.payload, event.message]);
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    const seen = (kv.get("seen") ?? []).filter(item => now - item.at < 86400000);
    if (seen.some(item => item.id === id)) {
      // Repair a timer if an earlier invocation failed after storing the event.
      await this.arm();
      return;
    }
    kv.put("customer", customer);
    kv.put("seen", [...seen, { id, at: now }].slice(-1024));
    const isReset = String(event.message?.text ?? "").trim().toLowerCase() === "/rs";
    const control = admin || event.postback?.payload || isReset;
    if (!admin && event.postback?.payload) {
      const previous = kv.get("last_button");
      if (previous?.payload === event.postback.payload && now - previous.at < 1500) return;
      kv.put("last_button", { payload: event.postback.payload, at: now });
    }
    if (!admin) this.trackCustomerActivity(event);
    const version = (kv.get("version") ?? 0) + 1;
    kv.put("version", version);
    if (control) {
      // A button or reset supersedes unprocessed text and the greeting reminder.
      if (!admin) {
        kv.delete("pending");
        kv.delete("reminder");
      }
      kv.put("controls", [...(kv.get("controls") ?? []), { event, pageId, admin }]);
    } else {
      const pending = kv.get("pending") ?? { events: [] };
      pending.events.push({
        text: event.message?.text ?? "",
        hasAttachment: !!event.message?.attachments?.length,
        at: Number(event.timestamp) || now
      });
      pending.dueAt = now + CUSTOMER_DEBOUNCE_MS;
      kv.put("pending", pending);
      if (!isGreetingOnly(normalizeText(event.message?.text ?? ""))) kv.delete("reminder");
    }
    await this.arm();
  }

  async arm() {
    const kv = this.ctx.storage.kv;
    const controls = kv.get("controls") ?? [];
    const due = [
      controls.length ? Date.now() : null,
      kv.get("pending")?.dueAt,
      kv.get("sales_followup")?.checked ? null : kv.get("sales_followup")?.dueAt || null
    ].filter(value => value != null);
    if (due.length) await this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...due)));
    else await this.ctx.storage.deleteAlarm();
  }

  async cancelPending() {
    this.ctx.storage.kv.delete("pending");
    this.ctx.storage.kv.delete("reminder");
    await this.arm();
  }

  async alarm() {
    if (this.busy) return;
    this.busy = true;
    const kv = this.ctx.storage.kv;
    const senderId = kv.get("customer");
    try {
      const controls = kv.get("controls") ?? [];
      if (controls.length) {
        // Consume before external sends. Alarm retries must not resend a batch.
        const [job, ...remaining] = controls;
        kv.put("controls", remaining);
        this.processingVersion = kv.get("version");
        if (job.admin) {
          await handlePageEcho(job.event, job.pageId, this.flowEnv);
        } else if (await isBotEnabled(this.flowEnv)) {
          await ensureCustomerMenu(senderId, this.flowEnv);
          if (job.event.postback?.payload) {
            await handlePostback(senderId, job.event.postback.payload, this.flowEnv);
          } else {
            await handleCustomerText(senderId, "/rs", "/rs", this.flowEnv);
          }
        }
        return;
      }
      const pending = kv.get("pending");
      if (pending) {
        if (pending.dueAt > Date.now()) return;
        kv.delete("pending");
        this.processingVersion = kv.get("version");
        if (!await isBotEnabled(this.flowEnv)) {
          kv.delete("reminder");
          return;
        }
        const lines = pending.events.sort((a, b) => a.at - b.at)
          .map(item => item.text.trim()).filter(Boolean);
        const nonGreetings = lines.filter(line => !isGreetingOnly(normalizeText(line)));
        const original = (nonGreetings.length ? nonGreetings : lines.slice(-1)).join("\n");
        await ensureCustomerMenu(senderId, this.flowEnv);
        // Gate each customer batch once. Reset controls are handled separately.
        if (await this.flowEnv.SESSION_KV.get("human_support:" + senderId)) return;
        const introSeen = await this.flowEnv.SESSION_KV.get("intro_price_seen:" + senderId);
        if (!this.canSendAutomaticReply()) return;
        if (!introSeen) {
          await sendPriceButton(senderId, this.flowEnv, {reason:"initial"});
          return;
        }
        if (pending.events.some(item => item.hasAttachment)) {
          await enterHumanSupport(senderId, this.flowEnv, {
            reason: "attachment",
            notice: "Sốp đã nhận thông tin nha. Admin sẽ xem và trả lời bạn sớm nha."
          });
        } else if (original) {
          await handleCustomerText(senderId, original, normalizeText(original), this.flowEnv);
        } else {
          await enterHumanSupport(senderId, this.flowEnv, {
            reason: "attachment",
            notice: "Sốp đã nhận thông tin nha. Admin sẽ xem và trả lời bạn sớm nha."
          });
        }
        return;
      }
      kv.delete("reminder");
      await this.sendSalesFollowupIfDue(senderId);
    } catch (error) {
      console.error("Customer inbox processing failed", error);
    } finally {
      this.processingVersion = null;
      this.busy = false;
      await this.arm();
    }
  }
}

const PRICE_URL =
  "https://cotdostore.github.io/shopweb/bang-gia.html";
const CATALOG_URL =
  "https://raw.githubusercontent.com/cotdostore/shopweb/main/prices.json";
const PAYMENT_IMAGE_URL =
  "https://raw.githubusercontent.com/cotdostore/shopweb/main/assets/anh-momo.jpg";
const GRAPH_API =
  "https://graph.facebook.com/v26.0/me/messages";
const SESSION_TTL = 1800; // 30 minutes
const PRICE_COOLDOWN_SECONDS = 3600;
const CUSTOMER_DEBOUNCE_MS = 0;
const HUMAN_SUPPORT_TTL = 21600;
const SALES_FOLLOWUP_MS = 12 * 60 * 60 * 1000;
const SALES_FOLLOWUP_TEXT = "Vậy không biết là bạn đang có nhu cầu muốn sử dụng dịch vụ nào để sốp tư vấn thêm cho ạ ❤️";
const BOT_MESSAGE_METADATA = "cotdo_bot:v2";
const HUMAN_SUPPORT_NOTICE = "Cảm ơn bạn đã nhắn cho sốp. Bot sẽ chuyển thông tin qua cho admin nha.";
const PRODUCT_ALIASES = {
  youtube: [
    "youtube premium",
    "youtube pre",
    "youtube",
    "ytb premium",
    "ytb pre",
    "ytb",
    "yt",
  ],
  netflix: [
    "netflix premium",
    "netflix pre",
    "netflix",
    "nflx",
    "net",
  ],
  capcut: ["capcut pro", "capcut", "cap cut", "capcu"],
  chatgpt: [
    "chatgpt plus",
    "chat gpt plus",
    "chatgpt",
    "chat gpt",
    "gpt plus",
    "gpt",
  ],
  canva: [
    "canva business",
    "canva pro",
    "canva edu",
    "canva",
  ],
  studocu: [
    "studocu",
    "stu docu",
  ],
  quizlet: [
    "quizlet",
  ],
  apple: [
    "apple one",
  ],
  google: [
    "google one",
    "gg one",
  ],
};
const PRODUCT_MATCHERS=Object.entries(PRODUCT_ALIASES).map(([name,aliases])=>[name,aliases.map(alias=>new RegExp("(^|\\s)"+escapeRegex(normalizeText(alias))+"(?=\\s|$|[?!.,])","i"))]);
export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runBroadcastTick(env));
    ctx.waitUntil(cleanupPortal(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const portal = await handlePortal(request, env);
    if (portal) return portal;
    if (url.pathname === "/price-admin/api") return handlePriceAdminAPI(request);
    if (
      request.method === "GET" &&
      url.pathname === "/webhook"
    ) {
      const mode =
        url.searchParams.get("hub.mode");
      const token =
        url.searchParams.get("hub.verify_token");
      const challenge =
        url.searchParams.get("hub.challenge");
      if (
        mode === "subscribe" &&
        token === env.VERIFY_TOKEN
      ) {
        return new Response(
          challenge,
          { status: 200 }
        );
      }
      return new Response(
        "Forbidden",
        { status: 403 }
      );
    }
    if (
      request.method === "POST" &&
      url.pathname === "/webhook"
    ) {
      let body;
      try {
        body =
          await request.json();
      }
      catch (error) {
        console.error(
          "Invalid webhook JSON:",
          error
        );
        return new Response(
          "EVENT_RECEIVED",
          { status: 200 }
        );
      }
      // Always process Page echoes so admins can turn the bot back on.
      try {
        // Acknowledge only after events are durably queued. Meta retries failures.
        await processWebhook(body, env);
      } catch (error) {
        console.error("Webhook enqueue failed", error);
        return new Response("RETRY", { status: 503 });
      }
      return new Response(
        "EVENT_RECEIVED",
        { status: 200 }
      );
    }
    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      const botEnabled = await isBotEnabled(env);
      return new Response(
        botEnabled
          ? "CotDo Messenger Bot is running."
          : "CotDo Messenger Bot is paused."
      );
    }
    return new Response(
      "Not Found",
      { status: 404 }
    );
  },
};
async function processWebhook(body, env) {
  if (body.object !== "page") return;
  const groups=new Map();
  for (const entry of body.entry ?? []) {
    const pageId = String(entry.id ?? "");
    for (const event of entry.messaging ?? []) {
      const echo = event.message?.is_echo === true || String(event.sender?.id) === pageId;
      const senderId = String(echo ? event.recipient?.id ?? "" : event.sender?.id ?? "");
      if (!senderId || event.delivery || event.read || event.reaction || event.optin) continue;
      if (echo && event.message?.metadata === BOT_MESSAGE_METADATA) continue;
      if (echo && event.message?.app_id && !/^\/[a-z]+(?:\s|$)/i.test(String(event.message?.text ?? "").trim())) continue;
      if (!echo && !(event.message || event.postback?.payload)) continue;
      if (!env.CUSTOMER_INBOX) throw new Error("CUSTOMER_INBOX binding missing");
      const key=pageId+":"+senderId;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push({event,pageId,echo});
    }
  }
  // Keep each customer's event order; independent customers can enqueue in parallel.
  const queues=[...groups];
  for(let offset=0;offset<queues.length;offset+=8){
    const results=await Promise.allSettled(queues.slice(offset,offset+8).map(async([key,events])=>{
      const inbox=env.CUSTOMER_INBOX.getByName(key);
      for(const {event,pageId,echo} of events)await inbox.receive(event,pageId,echo);
    }));
    const failure=results.find(result=>result.status==='rejected');
    if(failure)throw failure.reason;
  }
}

async function handleCustomerText(senderId, originalText, text, env) {
  if (originalText.trim().toLowerCase() === "/rs") {
    const menuUpdated = await resetConversation(senderId, env);
    await sendText(senderId, menuUpdated
      ? "Đã reset bot và cập nhật lại menu. Bạn có thể nhắn lại để bắt đầu từ đầu."
      : "Đã reset bot. Bạn có thể nhắn lại sản phẩm muốn mua nha.", env);
    return;
  }
  if (parseAdminCommand(originalText)) return;
  // The inbox has already checked support and the initial welcome for this batch.
  const session = await getSession(senderId, env);
  if (env.CUSTOMER_COORDINATOR && !env.CUSTOMER_COORDINATOR.canSendAutomaticReply()) return;
  const clean = normalizeText(originalText.replace(/https?:\/\/\S+|www\.\S+/gi, " "));
  const documentRequest = /\b(file|pdf|tai lieu|document|download)\b/.test(clean) ||
    /https?:\/\/\S*(studocu|quizlet)\S*\/(document|vn|flash)/i.test(originalText);
  const declinedAccount = /\b(khong|ko|k|hong|khum)\s+(can|mua|lay|muon)\s+(acc|account|tai khoan)\b/.test(clean);
  if (documentRequest || declinedAccount) {
    await enterHumanSupport(senderId, env, {
      reason: "document",
      notice: documentRequest
        ? "Sốp đã nhận yêu cầu file của bạn. Admin sẽ kiểm tra và trả lời bạn nha."
        : "Sốp chuyển yêu cầu của bạn cho admin để tư vấn đúng nhu cầu nha."
    });
    return;
  }
  if (isPaymentCompleted(clean)) {
    await enterHumanSupport(senderId, env, {
      reason: "payment_check",
      notice: "Sốp đã nhận thông tin bạn báo thanh toán. Admin sẽ kiểm tra và xử lý đơn cho bạn nha."
    });
    return;
  }
  if (isClosingMessage(clean)) {
    // A closing message ends selection, without another sales prompt.
    await clearSession(senderId, env);
    return;
  }
  if (/^(huy|huy don|huy goi|khong mua nua|ko mua nua|thoi khong mua)[.!\s]*$/.test(clean)) {
    if (session) {
      await clearSession(senderId, env);
      await sendText(senderId, "Sốp đã hủy lựa chọn này nha.", env);
    }
    return;
  }
  if (session?.type === "confirm" && /^(xac nhan|dung|dung roi|chot|chot goi|ok|oke|okee|okay)[.!\s]*$/.test(clean)) {
    await handlePostback(senderId, "CONFIRM_ORDER", env);
    return;
  }
  if (isAcknowledgment(clean) && !getProductFromText(clean) && !getDuration(clean)) {
    if (session?.type === "confirm" && !await env.SESSION_KV.get("confirm_sent:" + senderId)) {
      await sendPurchaseConfirmation(senderId, session.item, env);
    }
    return;
  }
  if (!clean && /https?:\/\//i.test(originalText)) {
    await enterHumanSupport(senderId, env, {
      reason: "link",
      notice: "Sốp đã nhận link bạn gửi. Admin sẽ xem và trả lời bạn nha."
    });
    return;
  }
  if ((!session || session.type === "awaiting_product") && isGreetingRequest(clean)) {
    if (session) await clearSession(senderId, env);
    await sendGreeting(senderId, env);
    return;
  }
  if (isGreetingOnly(clean)) {
    // Do not restart a purchase already in progress.
    if (!session) await sendGreeting(senderId, env);
    return;
  }
  const product = getProductFromText(clean);
  const duration = getDuration(clean);
  const paymentIntent = isPaymentIntent(clean);
  const explicitPaymentRequest = /^(thanh toan|chuyen khoan|ck|stk|momo|payment|pay|ma qr)[.!\s]*$/.test(clean) ||
    /\b(gui|cho|xin|lay)\b.*\b(stk|qr|ma ck|thong tin (ck|chuyen khoan|thanh toan))\b/.test(clean);
  if (paymentIntent && explicitPaymentRequest) {
    await sendPaymentInfo(senderId, env);
    return;
  }
  const supportQuestion = isHelpIntent(clean) ||
    /\b(bao hanh|loi|khong dang nhap|ko dang nhap|chinh chu|mat khau|hoan tien|khieu nai)\b/.test(clean);
  if (supportQuestion || (paymentIntent && !explicitPaymentRequest)) {
    await enterHumanSupport(senderId, env, {
      reason: "question",
      notice: HUMAN_SUPPORT_NOTICE
    });
    return;
  }
  const explicitPurchase = isPurchaseIntent(clean);
  if (product) {
    await handlePurchaseRequest(senderId, clean, env);
    return;
  }
  if (!session && /^(bang gia|gia|gia ca|gia bao nhieu|gia nhiu|xem gia|bao gia)[?!.,\s]*$/.test(clean)) {
    await saveFlowSession(senderId, {type:"awaiting_product"}, env);
    await sendText(senderId, "Bạn muốn xem giá sản phẩm nào? Bạn ghi tên sản phẩm giúp sốp nha.", env);
    return;
  }
  if (session?.type === "selection") {
    const choice = getSelectionChoice(session.options, clean);
    const selectionSignal = duration || getRequestedPrice(clean) || choice ||
      filterNamedVariants(session.options, clean);
    if (!selectionSignal) {
      await enterHumanSupport(senderId, env, {
        reason: "question",
        notice: HUMAN_SUPPORT_NOTICE
      });
      return;
    }
    if (duration && !session.options.some(item => getDuration(item.term) === duration)) {
      await sendSelectionGuidanceOnce(senderId, session.options, env);
      return;
    }
    const refined = choice ? {status:"found",item:choice} : refineOptions(session.options, clean);
    if (refined.status === "found") {
      await sendPurchaseConfirmation(senderId, refined.item, env);
    } else if (refined.status === "ambiguous") {
      await saveSelectionSession(senderId, refined.options, env);
      await sendAmbiguousOptions(senderId, refined.options, env);
    } else {
      await sendSelectionGuidanceOnce(senderId, session.options, env);
    }
    return;
  }
  if (session?.type === "confirm" && duration && session.item) {
    await handlePurchaseRequest(senderId, session.item.product + " " + clean, env);
    return;
  }
  if (explicitPurchase || /\bclaude\b|\btool hack\b|\btool hac\b/.test(clean)) {
    if (isNamedPurchaseRequest(clean)) {
      await handlePurchaseRequest(senderId, clean, env);
    } else {
      if (session?.type !== "awaiting_product") {
        await saveFlowSession(senderId, {type:"awaiting_product"}, env);
        await sendText(senderId, "Bạn muốn mua sản phẩm nào? Bạn ghi tên sản phẩm + thời hạn giúp sốp nha.", env);
      }
    }
    return;
  }
  await sendUnknownMessage(senderId, env);
}

function isAcknowledgment(text) {
  return /\b(cam on|thanks|thank you|thank|thx|thankyou)\b/.test(text) &&
    !/[?]/.test(text) && !isPurchaseIntent(text) ||
    /^(ok|oke|okee|okay|oki|d[a]?|vang|ua|uh|um|yes|👍|❤️|♥️|🙏|😊|🙂)[.!\s]*$/.test(text) ||
    (!/[a-z0-9]/.test(text) && text.length < 30);
}
function isClosingMessage(text) {
  return /\b(khi nao.*ung ho|se ung ho.*(tiep|tip)|hen lan sau|lan sau.*ung ho|de lan sau|tam biet|bye)\b/.test(text);
}
function isPaymentCompleted(text) {
  return /\b(da|vua|roi|xong)\b.*\b(thanh toan|chuyen khoan|ck|tra tien)\b|\b(thanh toan|chuyen khoan|ck)\b.*\b(roi|xong)\b|\bpaid\b/.test(text);
}
function getSelectionChoice(options, text) {
  const match = text.match(/^(?:goi\s*)?(\d{1,2})(?:\s*(?:nha|nhe|a))?[.!\s]*$/);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return options[index] ?? null;
}
async function saveFlowSession(senderId, session, env) {
  await env.SESSION_KV.put(getSessionKey(senderId), JSON.stringify(session), {expirationTtl:SESSION_TTL});
}
async function sendSelectionGuidanceOnce(senderId, options, env) {
  const key = "selection_guidance:" + senderId;
  if (await env.SESSION_KV.get(key)) {
    await enterHumanSupport(senderId, env, {
      reason: "selection_failed",
      notice: "Sốp chuyển phần chọn gói cho admin hỗ trợ bạn nha."
    });
    return;
  }
  await env.SESSION_KV.put(key, "1", {expirationTtl:SESSION_TTL});
  await sendUnavailableDuration(senderId, options, env);
}
async function enterHumanSupport(senderId, env, options = {}) {
  const active = await env.SESSION_KV.get("human_support:" + senderId);
  await clearSession(senderId, env);
  if (env.CUSTOMER_COORDINATOR) await env.CUSTOMER_COORDINATOR.cancelPending();
  await env.SESSION_KV.put("human_support:" + senderId, "1", {expirationTtl:HUMAN_SUPPORT_TTL});
  await env.SESSION_KV.put("human_support_reason:" + senderId, options.reason || "question", {expirationTtl:HUMAN_SUPPORT_TTL});
  if (options.silent || active) return;
  const key = "handoff_notice:" + senderId;
  if (await env.SESSION_KV.get(key)) return;
  await env.SESSION_KV.put(key, "1", {expirationTtl:HUMAN_SUPPORT_TTL});
  await sendText(senderId, options.notice || HUMAN_SUPPORT_NOTICE, env);
}
function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .replace(
      /đ/g,
      "d"
    )
    .replace(
      /\s+/g,
      " "
    );
}
function isNamedPurchaseRequest(text) {
  if (!isPurchaseIntent(text)) return false;
  const name = normalizeText(text)
    .replace(/\d+\s*(ngay|tuan|thang|nam)\b/g, " ")
    .replace(/\d+\s*(k|nghin|ngan)\b/g, " ")
    .replace(/\b(mua|muon|can|chot|lay|goi|minh|em|toi|tui|cho|order|dat|dang|ky|ban|nha|nhe|voi|sop|shop|giup|mot|cai|nay|acc|account|tai|khoan|hello|hi|hey|alo|xin|chao|oi|a|ah|nua)\b/g, " ")
    .replace(/[^a-z0-9]/g, "").trim();
  return name.length > 0;
}
async function sendUnavailableDuration(senderId, options, env) {
  const terms = [...new Set(options.map(item => item.term))];
  await sendText(senderId,
    `Thời hạn bạn chọn chưa có trong bảng giá của gói này nha. Các thời hạn hiện có: ${terms.join(", ")}. Bạn nhập lại thời hạn muốn mua giúp sốp nha.`, env);
}
async function sendAdminHandoff(senderId, env) {
  await enterHumanSupport(senderId, env, {
    reason: "unlisted_product",
    notice: "Gói bạn hỏi chưa có trong bảng giá của bot. Admin sẽ kiểm tra và báo lại bạn nha."
  });
}
function escapeRegex(text) {
  return String(text)
    .replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
}
function containsPhrase(text, phrase) {
  const escaped = normalizeText(phrase).replace(/[.*+?^\u0024{}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|\\s)" + escaped + "(?=\\s|$|[?!.,])", "i").test(normalizeText(text));
}

function getProductFromText(text) {
  const normalized=normalizeText(text);
  for (const [product,patterns] of PRODUCT_MATCHERS) {
    if (patterns.some(pattern=>pattern.test(normalized))) return product;
  }
  return null;
}
function isPaymentIntent(text) {
  const patterns = [
    /\bthanh toan\b/,
    /\bchuyen khoan\b/,
    /(^|\s)ck($|\s|[?!.,])/,
    /\bbank\b/,
    /\bbanking\b/,
    /\bbank transfer\b/,
    /\bmomo\b/,
    /\bpayment\b/,
    /\bpay\b/,
    /\btra tien\b/,
    /\bgui tien\b/,
    /\bstk\b/,
    /\bso tai khoan\b/,
    /\bma ck\b/,
    /\bma qr\b/,
    /\bqr\b/,
  ];
  return patterns.some(
    pattern =>
      pattern.test(text)
  );
}
function isPurchaseIntent(text) {
  if (/^(mua|chot|order|dat mua|muon mua|can mua)[.!\s]*$/.test(text)) return true;
  const keywords = [
    "mua ",
    "muon mua",
    "can mua",
    "chot ",
    "chot goi",
    "lay goi",
    "minh lay",
    "em lay",
    "toi lay",
    "tui lay",
    "cho minh mua",
    "cho em mua",
    "cho toi mua",
    "cho tui mua",
    "order ",
    "dat mua",
    "dang ky ",
  ];
  return keywords.some(
    keyword =>
      text.includes(keyword)
  );
}
async function sendPaymentInfo(
  senderId,
  env
) {
  const key = "payment_info_sent:" + senderId;
  if (await env.SESSION_KV.get(key)) return;
  await env.SESSION_KV.put(key, "1", {expirationTtl:60});
  await sendAction(
    senderId,
    "mark_seen",
    env
  );
  await sendAction(
    senderId,
    "typing_on",
    env
  );
  await sendText(
    senderId,
    "Sốp gửi bạn mã ck nha.\n\nBẠN VUI LÒNG GHI NỘI DUNG CHUYỂN KHOẢN LÀ TÊN FB CỦA BẠN GIÚP SỐP.",
    env
  );
  await sendImage(
    senderId,
    PAYMENT_IMAGE_URL,
    env
  );
  await sendAction(
    senderId,
    "typing_off",
    env
  );
}
async function sendPriceButton(senderId, env, options = {}) {
  // Only greeting, explicit menu clicks and manual admin sends can send this.
  if (!["initial", "greeting", "menu", "admin"].includes(options.reason)) return "ignored";
  if (!env.SESSION_KV) return "failed";
  const key = "price_sent:" + senderId;
  const sentAt = Number(await env.SESSION_KV.get(key));
  const now = Date.now();
  const activeCooldown = sentAt > 0 && now - sentAt < PRICE_COOLDOWN_SECONDS * 1000;
  // Preserve the original deadline when adopting a legacy 10-minute KV guard.
  if (activeCooldown) {
    await env.SESSION_KV.put(key, String(sentAt), {
      expirationTtl: Math.ceil((PRICE_COOLDOWN_SECONDS * 1000 - (now - sentAt)) / 1000)
    });
  }
  if (options.reason === "greeting" && activeCooldown) return "cooldown";
  // Menu remains available without extending the greeting cooldown.
  if (!activeCooldown) {
    await env.SESSION_KV.put(key, String(now), { expirationTtl: PRICE_COOLDOWN_SECONDS });
  }
  try {
    await sendAction(senderId, "mark_seen", env);
    const response = await sendButtons(senderId, options.caption || "Xem bảng giá ở đây nhaaaa", [{
      type: "web_url", title: "XEM BẢNG GIÁ", url: PRICE_URL,
      messenger_extensions: true, webview_height_ratio: "full"
    }, {
      type: "postback", title: "Mua hàng", payload: "START_PURCHASE"
    }], env);
    if (!response.ok) {
      if (!activeCooldown) await env.SESSION_KV.delete(key);
      return "failed";
    }
    await env.SESSION_KV.put("intro_price_seen:" + senderId, "1");
    if (options.reason !== "menu") {
      try {
        await sendText(senderId, "Bạn có thể xem lại bảng giá bằng cách nhấn icon 3 dấu gạch ngang ở bên phải ô nhập tin nhắn nha.", env);
      } catch (error) {
        console.error("Price menu guide delivery uncertain", error);
      }
    }
    return "sent";
  } catch (error) {
    // Reserve uncertain network outcomes to avoid sending the same card twice.
    console.error("Price message delivery uncertain", error);
    return "failed";
  }
}
async function sendUnknownMessage(senderId, env) {
  await enterHumanSupport(senderId, env, {
    reason: "unrecognized",
    notice: HUMAN_SUPPORT_NOTICE
  });
}
async function handlePurchaseRequest(
  senderId,
  originalText,
  env
) {
  if (await isDuplicatePurchaseRequest(senderId, originalText, env)) return;
  if (env.CUSTOMER_COORDINATOR) await env.CUSTOMER_COORDINATOR.beginNewOrder();
  await clearSession(
    senderId,
    env
  );
  await sendAction(
    senderId,
    "mark_seen",
    env
  );
  await sendAction(
    senderId,
    "typing_on",
    env
  );
  try {
    const catalog =
      await fetchCatalog();
    const result =
      findProduct(
        catalog,
        originalText
      );
    if (
      result.status === "not_found"
    ) {
      const product = getProductFromText(originalText);
      const productOptions = product ? catalog.filter(item => getProductFromText(item.product) === product) : [];
      if (productOptions.length && getDuration(originalText) && !productOptions.some(item => getDuration(item.term) === getDuration(originalText))) {
        await saveSelectionSession(senderId, productOptions, env);
        await sendSelectionGuidanceOnce(senderId, productOptions, env);
        return;
      }
      if (!productOptions.length && (isNamedPurchaseRequest(normalizeText(originalText)) || /\bclaude\b|\btool hack\b|\btool hac\b/.test(normalizeText(originalText)))) {
        await sendAdminHandoff(senderId, env);
        return;
      }
      await sendText(
        senderId,
        'Bot chưa tìm được chính xác món bạn muốn mua trong bảng giá. Bạn ghi giúp sốp tên sản phẩm + thời hạn nha. Ví dụ: "mua studocu 1 tháng".',
        env
      );
      return;
    }
    if (
      result.status === "ambiguous"
    ) {
      await saveSelectionSession(
        senderId,
        result.options,
        env
      );
      const response = await sendAmbiguousOptions(
        senderId,
        result.options,
        env
      );
      await rememberPurchaseRequest(senderId, originalText, response, env);
      return;
    }
    const response = await sendPurchaseConfirmation(
      senderId,
      result.item,
      env
    );
    await rememberPurchaseRequest(senderId, originalText, response, env);
  }
  catch (error) {
    console.error(
      "Catalog error:",
      error
    );
    await enterHumanSupport(senderId, env, {
      reason:"catalog_error",
      notice:"Bot chưa đọc được giá hiện tại. Admin sẽ kiểm tra và báo lại bạn nha."
    });
  }
  finally {
    await sendAction(
      senderId,
      "typing_off",
      env
    );
  }
}
function purchaseRequestQuery(text) {
  return normalizeText(text).replace(/[?!.,]+$/g, "").trim();
}
function purchaseSessionSignature(session) {
  if (session?.type === "selection") return JSON.stringify({options:session.options});
  if (["confirm", "payment"].includes(session?.type) && session.item) {
    return JSON.stringify({item:session.item});
  }
  return null;
}
async function isDuplicatePurchaseRequest(senderId, text, env) {
  const previous = await env.SESSION_KV.get("purchase_request:" + senderId, "json");
  if (!previous || previous.query !== purchaseRequestQuery(text)) return false;
  const signature = purchaseSessionSignature(await getSession(senderId, env));
  return signature !== null && signature === previous.signature;
}
async function rememberPurchaseRequest(senderId, text, response, env) {
  // Only successful replies can suppress a repeated purchase request.
  if (!response?.ok) return;
  const signature = purchaseSessionSignature(await getSession(senderId, env));
  if (!signature || env.CUSTOMER_COORDINATOR && !env.CUSTOMER_COORDINATOR.canSendAutomaticReply()) return;
  await env.SESSION_KV.put("purchase_request:" + senderId, JSON.stringify({
    query:purchaseRequestQuery(text), signature
  }), {expirationTtl:SESSION_TTL});
}
async function sendAmbiguousOptions(senderId, options, env) {
  const discount = await readCustomerDiscount(senderId, env);
  const key = "options_sent:" + senderId;
  const signature = JSON.stringify({options, discount});
  if (await env.SESSION_KV.get(key) === signature) return;
  await env.SESSION_KV.put(key, signature, {expirationTtl:SESSION_TTL});
  const optionText = options.slice(0,8).map((item,index) => {
    const pricing = calculateOrderPricing(item, discount);
    return (index + 1) + ". " + formatItemName(item) + " - " + pricing.finalPrice;
  }).join("\n");
  const discountNotice = discount.kind !== "none"
    ? "\n\n🎁 Giá trên đã được giảm " + formatDiscountRule(discount) + " dành riêng cho bạn."
    : "";
  const response = await sendText(senderId,
    "Các gói hiện có:\n\n" + optionText + discountNotice +
    "\n\nBạn chọn số thứ tự hoặc ghi thời hạn/loại gói muốn mua nha.", env);
  if (response.status === 409) await env.SESSION_KV.delete(key);
  return response;
}

// A short public-price cache, shared by simultaneous requests in this isolate.
// No stale fallback: a failed refresh must not quote an expired price.
const CATALOG_TTL_MS = 30000;
let catalogCache=null,catalogPending=null;
async function fetchCatalog() {
  if (catalogCache && Date.now() < catalogCache.expiresAt) return catalogCache.items;
  if (catalogPending) return catalogPending;
  catalogPending=(async()=>{
    const response=await fetch(CATALOG_URL+"?t="+Date.now(),{cache:"no-store",
      headers:{"User-Agent":"CotDo-Messenger-Bot"},signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error("Cannot fetch catalog: "+response.status);
    const data=validatePriceData(await readPriceBody(response));
    const items=data.groups.flatMap(group=>group.items.filter(item=>item.available).map(item=>({
      product:group.product,variant:group.variant,term:item.term,price:priceDisplay(item.price,item.priceSuffix)
    })));
    catalogCache={items,expiresAt:Date.now()+CATALOG_TTL_MS};
    return items;
  })();
  try {return await catalogPending;} finally {catalogPending=null;}
}
const searchFields=new WeakMap();
function itemSearchFields(item){
  let fields=searchFields.get(item);
  if(!fields){
    const product=normalizeText(item.product),variant=normalizeText(item.variant),term=normalizeText(item.term);
    fields={product,variant,term,price:normalizePrice(item.price),duration:getDuration(term),
      description:[variant,term,item.price].filter(Boolean).join(" "),
      fullDescription:normalizeText([item.product,item.variant,item.term,item.price].filter(Boolean).join(" "))};
    searchFields.set(item,fields);
  }
  return fields;
}
function findProduct(
  catalog,
  originalText
) {
  const query =
    normalizeText(
      originalText
    );
  const requestedDuration =
    getDuration(
      query
    );
  const requestedPrice =
    getRequestedPrice(
      query
    );
  const candidates = [], productScores=new Map();
  for (
    const item
    of catalog
  ) {
    if (!matchesChatGPTPlan(query, item)) continue;
    const fields=itemSearchFields(item);
    const product=fields.product,itemPrice=fields.price;
    if(!productScores.has(product))productScores.set(product,getProductScore(query,product));
    const productScore=productScores.get(product);
    if (
      productScore <= 0
    ) {
      continue;
    }
    const itemDuration = fields.duration;
    if (
      requestedDuration &&
      itemDuration &&
      requestedDuration !==
      itemDuration
    ) {
      continue;
    }
    if (
      requestedPrice &&
      itemPrice !==
      requestedPrice
    ) {
      continue;
    }
    let score =
      productScore;
    if (
      requestedDuration &&
      requestedDuration ===
      itemDuration
    ) {
      score += 100;
    }
    if (
      requestedPrice &&
      itemPrice ===
      requestedPrice
    ) {
      score += 500;
    }
    const description = fields.description;
    score +=
      getDescriptionScore(
        query,
        description
      );
    candidates.push({
      item,
      score,
    });
  }
  return chooseCandidates(
    candidates
  );
}
function getProductScore(
  query,
  product
) {
  const normalizedQuery =
    normalizeText(
      query
    );
  const normalizedProduct =
    normalizeText(
      product
    );
  if (
    normalizedQuery.includes(
      normalizedProduct
    )
  ) {
    return 300;
  }
  for (
    const [canonical, aliases]
    of Object.entries(
      PRODUCT_ALIASES
    )
  ) {
    if (
      !normalizedProduct.includes(
        normalizeText(
          canonical
        )
      )
    ) {
      continue;
    }
    for (
      const alias
      of aliases
    ) {
      if (
        containsPhrase(
          normalizedQuery,
          alias
        )
      ) {
        return 250;
      }
    }
  }
  let score = 0;
  const words =
    normalizedProduct
      .replace(
        /[^a-z0-9\s]/g,
        " "
      )
      .split(/\s+/)
      .filter(
        word =>
          word.length >= 3 &&
          !IGNORED_WORDS.has(
            word
          )
      );
  for (
    const word
    of words
  ) {
    if (
      normalizedQuery.includes(
        word
      )
    ) {
      score += 50;
    }
  }
  return score;
}
function refineOptions(
  options,
  originalText
) {
  const query =
    normalizeText(
      originalText
    );
  const requestedDuration =
    getDuration(
      query
    );
  const requestedPrice =
    getRequestedPrice(
      query
    );
  const namedOptions = filterNamedVariants(options, originalText);
  const candidates = [];
  for (
    const item
    of (namedOptions ?? options)
  ) {
    if (!matchesChatGPTPlan(query, item)) continue;
    const term =
      normalizeText(
        item.term
      );
    const itemDuration =
      getDuration(
        term
      );
    const itemPrice =
      normalizePrice(
        item.price
      );
    if (
      requestedDuration &&
      itemDuration &&
      requestedDuration !==
      itemDuration
    ) {
      continue;
    }
    if (
      requestedPrice &&
      itemPrice !==
      requestedPrice
    ) {
      continue;
    }
    const description =
      normalizeText(
        [
          item.product,
          item.variant,
          item.term,
          item.price,
        ]
          .filter(Boolean)
          .join(" ")
      );
    let score = 0;
    if (
      requestedPrice &&
      itemPrice ===
      requestedPrice
    ) {
      score += 500;
    }
    if (
      requestedDuration &&
      requestedDuration ===
      itemDuration
    ) {
      score += 100;
    }
    score +=
      getDescriptionScore(
        query,
        description
      );
    candidates.push({
      item,
      score,
    });
  }
  if (
    candidates.length === 0
  ) {
    return {
      status:
        "not_found",
    };
  }
  if (!requestedDuration && !requestedPrice && candidates.every(candidate => candidate.score === 0)) {
    return { status: "not_found" };
  }
  if (
    candidates.length === 1
  ) {
    return {
      status:
        "found",
      item:
        candidates[0].item,
    };
  }
  return chooseCandidates(candidates);
}
function chooseCandidates(candidates) {
  if (!candidates.length) return {status:"not_found"};
  let bestScore = -Infinity, best = [];
  for (const candidate of candidates) {
    if (candidate.score > bestScore) {bestScore=candidate.score;best=[candidate.item];}
    else if (candidate.score === bestScore) best.push(candidate.item);
  }
  return best.length === 1 ? {status:"found",item:best[0]} : {status:"ambiguous",options:best};
}
function getDescriptionScore(
  query,
  description
) {
  const normalizedDescription =
    normalizeText(
      description
    );
  let score = 0;
  const words =
    normalizeText(
      query
    )
      .split(/\s+/)
      .filter(
        word =>
          word.length >= 3 &&
          !IGNORED_WORDS.has(
            word
          ) &&
          !/^\d+$/.test(
            word
          ) &&
          !/^\d+k$/.test(
            word
          )
      );
  for (
    const word
    of words
  ) {
    if (
      normalizedDescription.includes(
        word
      )
    ) {
      score += 20;
    }
  }
  return score;
}
const IGNORED_WORDS =
  new Set([
    "mua",
    "muon",
    "can",
    "minh",
    "toi",
    "tui",
    "em",
    "cho",
    "lay",
    "goi",
    "chot",
    "order",
    "dang",
    "thang",
    "nam",
    "ngay",
    "tuan",
    "premium",
    "plus",
    "gia",
    "ban",
    "nha",
    "nhe",
    "cai",
    "nay",
    "kia",
    "do",
    "voi",
    "sop",
    "shop",
    "sao",
    "co",
    "khong",
  ]);
function getDuration(text) {
  const match =
    normalizeText(
      text
    )
      .match(
        /(\d+)\s*(ngay|tuan|thang|nam)\b/
      );
  if (!match) {
    return null;
  }
  return (
    match[1] +
    " " +
    match[2]
  );
}
function normalizePrice(price) {
  const text =
    normalizeText(
      price
    );
  let match =
    text.match(
      /(\d+)\s*k\b/
    );
  if (match) {
    return Number(
      match[1]
    );
  }
  match =
    text.match(
      /(\d+)\s*(nghin|ngan)\b/
    );
  if (match) {
    return Number(
      match[1]
    );
  }
  return null;
}
function getRequestedPrice(text) {
  const normalized =
    normalizeText(
      text
    );
  let match =
    normalized.match(
      /(\d+)\s*k\b/
    );
  if (match) {
    return Number(
      match[1]
    );
  }
  match =
    normalized.match(
      /(\d+)\s*(nghin|ngan)\b/
    );
  if (match) {
    return Number(
      match[1]
    );
  }
  return null;
}
async function sendPurchaseConfirmation(
  senderId,
  item,
  env
) {
  const pricing = await getOrderPricing(senderId, item, env);
  await saveConfirmSession(
    senderId,
    item,
    pricing,
    env
  );
  const key = "confirm_sent:" + senderId;
  const signature = JSON.stringify({item, pricing});
  if (await env.SESSION_KV.get(key) === signature) return;
  await env.SESSION_KV.put(key, signature, {expirationTtl:60});
  const response = await sendButtons(
    senderId,
    `Sốp confirm hàng bạn mua là ${formatItemName(item)} giá ${formatOrderPrice(pricing)} nha. Nếu đúng thì bạn nhấn xác nhận, còn cần chỉnh sửa thì nhấn nút hủy nha.`,
    [
      {
        type:
          "postback",
        title:
          "Xác nhận",
        payload:
          "CONFIRM_ORDER",
      },
      {
        type:
          "postback",
        title:
          "Hủy",
        payload:
          "CANCEL_ORDER",
      },
    ],
    env
  );
  if (response.status === 409) await env.SESSION_KV.delete(key);
  return response;
}
function formatItemName(item) {
  return [
    item.product,
    item.variant,
    item.term,
  ]
    .filter(Boolean)
    .join(" - ");
}

function parseItemPriceVnd(price) {
  const match = String(price ?? "").trim().match(/^(\d+(?:[.,]\d+)?)\s*k(.*)$/i);
  if (!match) return null;
  const amountVnd = Math.round(Number(match[1].replace(",", ".")) * 1000);
  if (!Number.isSafeInteger(amountVnd) || amountVnd < 0) return null;
  return { amountVnd, suffix: match[2] ?? "" };
}
function calculateOrderPricing(item, discount) {
  const parsed = parseItemPriceVnd(item.price);
  if (!parsed || !discount || discount.kind === "none") {
    return {
      originalPrice: item.price,
      finalPrice: item.price,
      discountLabel: "",
      appliedVnd: 0
    };
  }
  let finalVnd;
  if (discount.kind === "percent") {
    const rawFinalVnd = parsed.amountVnd * (100 - discount.percent) / 100;
    finalVnd = Math.min(parsed.amountVnd, Math.ceil(rawFinalVnd / 1000) * 1000);
  } else {
    finalVnd = Math.max(0, parsed.amountVnd - discount.amountVnd);
  }
  return {
    originalPrice: item.price,
    finalPrice: priceDisplay(finalVnd, parsed.suffix),
    discountLabel: formatDiscountRule(discount),
    appliedVnd: parsed.amountVnd - finalVnd
  };
}
async function getOrderPricing(senderId, item, env) {
  const discount = await readCustomerDiscount(senderId, env);
  return calculateOrderPricing(item, discount);
}
function formatOrderPrice(pricing) {
  if (!pricing?.appliedVnd) return pricing?.finalPrice ?? "";
  return pricing.finalPrice + " (đã giảm " + pricing.discountLabel +
    " từ " + pricing.originalPrice + ")";
}

async function handlePostback(senderId, payload, env) {
  if (payload === "SHOW_PRICE") {
    await sendPriceButton(senderId, env, {reason:"menu"});
    return;
  }
  if (payload === "START_PURCHASE") {
    const session = await getSession(senderId, env);
    if (session?.type === "awaiting_product") return;
    if (env.CUSTOMER_COORDINATOR) await env.CUSTOMER_COORDINATOR.beginNewOrder();
    await clearSession(senderId, env);
    for (const prefix of ["human_support:", "human_support_reason:", "handoff_notice:", "selection_guidance:", "options_sent:", "confirm_sent:", "payment_info_sent:"]) {
      await env.SESSION_KV.delete(prefix + senderId);
    }
    await saveFlowSession(senderId, {type:"awaiting_product"}, env);
    await env.SESSION_KV.put("intro_price_seen:" + senderId, "1");
    await sendText(senderId, "Bạn viết tên sản phẩm + gói muốn mua nha, ví dụ: Studocu 1 tháng. Sốp sẽ kiểm tra giá rồi gửi xác nhận cho bạn.", env);
    return;
  }
  if (payload === "PAY_ORDER") {
    await sendPaymentInfo(senderId, env);
    return;
  }
  if (payload === "REQUEST_SUPPORT") {
    await requestHumanSupport(senderId, env);
    return;
  }
  if (await env.SESSION_KV.get("human_support:" + senderId)) return;
  const session = await getSession(senderId, env);
  if (payload === "GET_STARTED") {
    if (!session) await sendGreeting(senderId, env);
    return;
  }
  if (payload === "CONFIRM_ORDER") {
    if (session?.type !== "confirm" || !session.item) return;
    const item = session.item;
    const pricing = session.pricing ?? await getOrderPricing(senderId, item, env);
    await saveFlowSession(senderId, {type:"payment",item,pricing}, env);
    await sendButtons(senderId,
      "Sốp đã nhận xác nhận " + formatItemName(item) + " giá " + formatOrderPrice(pricing) +
      " nha. Sốp bảo hành full thời gian gói bạn mua. Nếu bạn thấy oke thì nhấn Thanh toán để nhận thông tin chuyển khoản; nếu còn thắc mắc thì nhấn Hỗ trợ để admin tư vấn nha.",
      [{type:"postback",title:"Thanh toán",payload:"PAY_ORDER"},{type:"postback",title:"Hỗ trợ",payload:"REQUEST_SUPPORT"}], env);
    return;
  }
  if (payload === "CANCEL_ORDER" && session) {
    await clearSession(senderId, env);
    await env.SESSION_KV.delete("confirm_sent:" + senderId);
    await sendText(senderId, "Sốp đã hủy lựa chọn này. Bạn có thể nhắn lại sản phẩm và gói muốn mua nha.", env);
  }
}

function getSessionKey(
  senderId
) {
  return (
    "session:" +
    senderId
  );
}
async function getSession(
  senderId,
  env
) {
  if (
    !env.SESSION_KV
  ) {
    console.error(
      "SESSION_KV binding missing"
    );
    return null;
  }
  try {
    return await env
      .SESSION_KV
      .get(
        getSessionKey(
          senderId
        ),
        "json"
      );
  }
  catch (error) {
    console.error(
      "KV get error:",
      error
    );
    return null;
  }
}
async function saveSelectionSession(
  senderId,
  options,
  env
) {
  await env
    .SESSION_KV
    .put(
      getSessionKey(
        senderId
      ),
      JSON.stringify({
        type:
          "selection",
        options,
      }),
      {
        expirationTtl:
          SESSION_TTL,
      }
    );
}
async function saveConfirmSession(
  senderId,
  item,
  pricing,
  env
) {
  await env
    .SESSION_KV
    .put(
      getSessionKey(
        senderId
      ),
      JSON.stringify({
        type:
          "confirm",
        item,
        pricing,
      }),
      {
        expirationTtl:
          SESSION_TTL,
      }
    );
}
async function clearSession(
  senderId,
  env
) {
  if (
    !env.SESSION_KV
  ) {
    return;
  }
  try {
    await env.SESSION_KV.delete("purchase_request:" + senderId);
    await env
      .SESSION_KV
      .delete(
        getSessionKey(
          senderId
        )
      );
  }
  catch (error) {
    console.error(
      "KV delete error:",
      error
    );
  }
}
async function sendText(
  recipientId,
  text,
  env
) {
  return callMessengerAPI(
    {
      recipient: {
        id:
          recipientId,
      },
      messaging_type:
        "RESPONSE",
      message: {
        text,
      },
    },
    env
  );
}
async function sendImage(
  recipientId,
  imageUrl,
  env
) {
  return callMessengerAPI(
    {
      recipient: {
        id:
          recipientId,
      },
      messaging_type:
        "RESPONSE",
      message: {
        attachment: {
          type:
            "image",
          payload: {
            url:
              imageUrl,
            is_reusable:
              true,
          },
        },
      },
    },
    env
  );
}
async function sendButtons(
  recipientId,
  text,
  buttons,
  env
) {
  return callMessengerAPI(
    {
      recipient: {
        id:
          recipientId,
      },
      messaging_type:
        "RESPONSE",
      message: {
        attachment: {
          type:
            "template",
          payload: {
            template_type:
              "button",
            text,
            buttons,
          },
        },
      },
    },
    env
  );
}
async function sendAction(
  recipientId,
  action,
  env
) {
  return callMessengerAPI(
    {
      recipient: {
        id:
          recipientId,
      },
      sender_action:
        action,
    },
    env
  );
}
async function callMessengerAPI(
  payload,
  env
) {
  if (payload.message) {
    if (env.CUSTOMER_COORDINATOR && !env.CUSTOMER_COORDINATOR.canSendAutomaticReply()) {
      return new Response("Superseded by a newer customer/admin event", {status:409});
    }
    payload = {...payload, message:{...payload.message, metadata:BOT_MESSAGE_METADATA}};
  }
  const response =
    await fetch(
      GRAPH_API,
      {
        method:
          "POST",
        headers: {
          "Content-Type":
            "application/json",
          Authorization:
            `Bearer ${env.PAGE_ACCESS_TOKEN}`,
        },
        signal: AbortSignal.timeout(10000),
        body:
          JSON.stringify(
            payload
          ),
      }
    );
  const result =
    await response.text();
  if (!response.ok) {
    console.error(
      "Messenger API Error:",
      response.status,
      result
    );
  }
  else {
    if (payload.message && env.CUSTOMER_COORDINATOR) {
      try { env.CUSTOMER_COORDINATOR.recordOutbound(JSON.parse(result).message_id); } catch {}
    }
    console.log(
      "Messenger API Success:",
      result
    );
  }
  return response;
}
function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function messengerMenuProfile() {
  return {
    get_started: { payload: "GET_STARTED" },
    persistent_menu: [{
      locale: "default",
      composer_input_disabled: false,
      call_to_actions: [{
        type: "web_url",
        title: "XEM BẢNG GIÁ",
        url: PRICE_URL,
        webview_height_ratio: "full"
      }, {
        type: "postback",
        title: "BẢNG GIÁ NHƯNG GỬI TIN NHẮN",
        payload: "SHOW_PRICE"
      }, {
        type: "postback",
        title: "THANH TOÁN",
        payload: "PAY_ORDER"
      }]
    }]
  };
}
async function configureMessengerMenu(env) {
  const endpoint = "https://graph.facebook.com/v26.0/me/messenger_profile";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${env.PAGE_ACCESS_TOKEN}` };
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(messengerMenuProfile()) });
  const result = await response.json();
  if (!response.ok || result.success !== true && result.result !== "success") {
    return Response.json({ configured: false, error: result.error?.message ?? "Menu setup failed", code: result.error?.code }, { status: 502 });
  }
  const check = await fetch(endpoint + "?fields=persistent_menu,get_started", { headers });
  const profile = await check.json();
  return Response.json({ configured: true, verified: check.ok, profile }, { status: check.ok ? 200 : 502 });
}

const CUSTOMER_MENU_VERSION = "price-menu-v10";
async function ensureCustomerMenu(senderId, env, force = false) {
  if (!env.SESSION_KV || !env.PAGE_ACCESS_TOKEN) return false;
  const key = "menu_sync:" + CUSTOMER_MENU_VERSION + ":" + senderId;
  try {
    const menuState = await env.SESSION_KV.get(key);
    if (menuState === "configured" && !force) return true;
    if (menuState === "retry") return false;
    // Reserve a short retry window so API errors cannot trigger a request per message.
    await env.SESSION_KV.put(key, "retry", { expirationTtl: 600 });
    const response = await fetch("https://graph.facebook.com/v26.0/me/custom_user_settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.PAGE_ACCESS_TOKEN}` },
      body: JSON.stringify({
        psid: senderId,
        persistent_menu: messengerMenuProfile().persistent_menu
      })
    });
    const result = await response.json();
    if (!response.ok || (result.success !== true && result.result !== "success")) {
      console.error("Customer menu sync failed", JSON.stringify({ status: response.status, code: result.error?.code, message: result.error?.message }));
      return false;
    }
    console.log("Customer menu sync configured", CUSTOMER_MENU_VERSION);
    await env.SESSION_KV.put(key, "configured");
    return true;
  } catch (error) {
    console.error("Customer menu sync unavailable");
    return false;
  }
}

function isGreetingOnly(text) {
  return /^(?:(hi|hello|hey|alo|lo|chao|xin chao)(\s+(sop|shop|bot|oi|nha|a))*|(sop|shop|bot)(\s+o+i+)?)[!?.,]*$/.test(normalizeText(text));
}
function isGreetingRequest(text) {
  if (isGreetingOnly(text)) return true;
  const greeting = /^(?:hi+|hello+|hey+|alo+|lo+|chao|xin chao)(?=\s|[!?.,]|$)/;
  const normalized = normalizeText(text);
  if (!greeting.test(normalized)) return false;
  // A greeting plus a generic shopping request still opens the price card.
  // Specific products, document requests and support questions keep their flow.
  const remainder = normalized.replace(greeting, "")
    .replace(/\b(hi|hello|hey|shop|sop|bot|oi|minh|em|toi|tui|t|muon|can|mua|acc|account|tai|khoan|goi|san|pham|cho|xin|xem|gia|bang|bao|hoi|ben|o|cua|nha|nhe|voi|a|ah)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
  return remainder.length === 0;
}
async function sendGreeting(senderId, env, kind = "greeting") {
  if (kind === "help") {
    const key = "help_reply_sent:" + senderId;
    if (await env.SESSION_KV.get(key)) return;
    await env.SESSION_KV.put(key, "1", { expirationTtl: 60 });
    await sendText(senderId, "Cảm ơn bạn đã nhắn tin cho sốp nha, bạn muốn mua sản phẩm nào?", env);
    return;
  }
  await sendPriceButton(senderId, env, { reason: "greeting" });
}

function isHelpIntent(text) {
  return /\btu van\b|\bcan ho tro\b|\bho tro giup\b|\bco ai (khong|k|ko|hong|khum)\b|\brep (minh|em|toi|tui|di)\b|\b(cho (minh|em|tui|toi) hoi|hoi (ti|chut|xiu))\b|\b(sop|shop)\b.*\b(tra loi|rep)\b/.test(text);
}

async function resetConversation(senderId, env) {
  if (env.CUSTOMER_COORDINATOR) await env.CUSTOMER_COORDINATOR.cancelPending();
  if (env.CUSTOMER_COORDINATOR) await env.CUSTOMER_COORDINATOR.beginNewOrder();
  if (!env.SESSION_KV) throw new Error("SESSION_KV missing");
  const prefixes = ["intro_price_seen:", "human_support:", "human_support_reason:", "handoff_notice:", "selection_guidance:", "options_sent:", "payment_info_sent:", "confirm_sent:", "purchase_request:", "session:", "purchase_intro_seen:", "price_sent:", "unknown_sent:", "greeting_sent:", "help_reply_sent:", "admin_handoff_sent:"];
  await Promise.all(prefixes.map(prefix => env.SESSION_KV.delete(prefix + senderId)));
  await env.SESSION_KV.delete("menu_sync:" + CUSTOMER_MENU_VERSION + ":" + senderId);
  return await ensureCustomerMenu(senderId, env, true);
}


const CUSTOMER_DISCOUNT_PREFIX = "customer_discount:";
const DISCOUNT_LABEL_PREFIX = "DISCOUNT ";
function parseDiscountRule(value) {
  const text = normalizeText(String(value ?? "")).trim().replace(/\s+/g, "");
  if (/^(0|off|remove|xoa|bo)$/.test(text)) return { kind: "none" };
  const percent = text.match(/^(\d+(?:[.,]\d+)?)%$/);
  if (percent) {
    const value = Number(percent[1].replace(",", "."));
    return Number.isFinite(value) && value > 0 && value <= 100
      ? { kind: "percent", percent: Number(value.toFixed(2)) }
      : null;
  }
  const k = text.match(/^(\d+(?:[.,]\d+)?)k$/);
  let amountVnd;
  if (k) {
    amountVnd = Math.round(Number(k[1].replace(",", ".")) * 1000);
  } else {
    let plain = text.replace(/(vnd|d)$/g, "");
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(plain)) plain = plain.replace(/[.,]/g, "");
    if (!/^\d+$/.test(plain)) return null;
    amountVnd = Number(plain);
    if (amountVnd > 0 && amountVnd < 1000) amountVnd *= 1000;
  }
  return Number.isSafeInteger(amountVnd) && amountVnd > 0 && amountVnd <= 1000000000
    ? { kind: "fixed", amountVnd }
    : null;
}
function formatDiscountRule(discount) {
  if (discount?.kind === "percent") return String(discount.percent) + "%";
  if (discount?.kind === "fixed") return priceDisplay(discount.amountVnd);
  return "0";
}
async function readCustomerDiscount(senderId, env) {
  try {
    const record = await env.SESSION_KV.get(CUSTOMER_DISCOUNT_PREFIX + senderId, "json");
    if (record?.kind === "percent") {
      const percent = Number(record.percent);
      if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
        return { kind: "percent", percent, updatedAt: record.updatedAt ?? null };
      }
    }
    const amountVnd = Number(record?.amountVnd);
    if (Number.isSafeInteger(amountVnd) && amountVnd > 0) {
      return { kind: "fixed", amountVnd, updatedAt: record.updatedAt ?? null };
    }
    return { kind: "none", updatedAt: null };
  } catch (error) {
    console.error("Discount read failed", error);
    return { kind: "none", updatedAt: null };
  }
}
async function discountGraph(path, options, env) {
  const headers = { Authorization: "Bearer " + env.PAGE_ACCESS_TOKEN };
  if (options?.body) headers["Content-Type"] = "application/json";
  const response = await fetch("https://graph.facebook.com/v26.0" + path, {
    method: options?.method ?? "GET",
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok || result.error) {
    throw new Error("Messenger label API failed: " + response.status + " " +
      String(result.error?.message ?? "unknown error"));
  }
  return result;
}
async function syncDiscountLabel(recipient, discount, env) {
  const stateKey = "discount_label_state:" + recipient;
  const previous = await env.SESSION_KV.get(stateKey, "json");
  const normalizeLabel = value => ({
    id: String(value?.id || ""),
    name: String(value?.name || value?.page_label_name || "")
  });
  // Reading labels from a user PSID is not supported for every Messenger account.
  let current = [];
  try {
    const associated = await discountGraph(
      "/" + encodeURIComponent(recipient) + "/custom_labels", null, env
    );
    current = (associated.data || []).map(normalizeLabel).filter(label => label.id);
  } catch (error) {
    console.warn("PSID custom label lookup failed; falling back to Page labels", String(error));
  }
  const targetName = discount?.kind !== "none"
    ? DISCOUNT_LABEL_PREFIX + formatDiscountRule(discount) : null;
  const pageLabels = await discountGraph(
    "/" + encodeURIComponent(ADMIN_PAGE_ID) + "/custom_labels?limit=100",
    null, env
  );
  const allLabels = (pageLabels.data || []).map(normalizeLabel).filter(label => label.id);
  let target = targetName ? allLabels.find(label => label.name === targetName) : null;
  if (targetName && !target) {
    const created = await discountGraph(
      "/" + encodeURIComponent(ADMIN_PAGE_ID) + "/custom_labels",
      { method:"POST", body:{page_label_name:targetName} }, env
    );
    if (!created.id) throw new Error("Meta did not return a label ID");
    target = { id:String(created.id), name:targetName };
  }
  if (target && !current.some(label => label.id === target.id)) {
    await discountGraph(
      "/" + encodeURIComponent(target.id) + "/label",
      { method:"POST", body:{user:recipient} }, env
    );
  }
  const obsolete = new Map();
  for (const label of current) {
    if (label.name.startsWith(DISCOUNT_LABEL_PREFIX) && label.name !== targetName) {
      obsolete.set(label.id, label);
    }
  }
  if (previous?.id && previous?.name?.startsWith(DISCOUNT_LABEL_PREFIX) &&
      previous.name !== targetName) {
    obsolete.set(previous.id, previous);
  }
  for (const label of obsolete.values()) {
    await discountGraph(
      "/" + encodeURIComponent(label.id) + "/label?user=" + encodeURIComponent(recipient),
      {method:"DELETE"}, env
    );
  }
  if (target) {
    await env.SESSION_KV.put(stateKey, JSON.stringify(target));
  } else {
    await env.SESSION_KV.delete(stateKey);
  }
  return targetName;
}

const CUSTOMER_TIME_LABEL_STATE_PREFIX = "customer_time_label:";
function parseTimeLabel(value) {
  const normalized = normalizeText(String(value ?? "")).trim();
  if (/^(0|off|remove|xoa|bo)$/.test(normalized)) return { name: null };
  const match = normalized.match(/^(\d{1,4})\s*(ngay|tuan|thang|nam)$/);
  if (!match) return null;
  const count = Number(match[1]);
  const max = { ngay: 3650, tuan: 520, thang: 120, nam: 10 };
  if (!Number.isSafeInteger(count) || count < 1 || count > max[match[2]]) return null;
  const units = { ngay: "ngày", tuan: "tuần", thang: "tháng", nam: "năm" };
  return { name: count + " " + units[match[2]] };
}
function isDurationLabel(value) {
  return /^\d{1,4}\s*(ngay|tuan|thang|nam)$/.test(normalizeText(String(value ?? "")));
}
async function syncCustomerTimeLabel(recipient, labelName, env) {
  const key = CUSTOMER_TIME_LABEL_STATE_PREFIX + recipient;
  const previous = await env.SESSION_KV.get(key, "json");
  const toLabel = value => ({
    id: String(value?.id ?? ""),
    name: String(value?.name ?? value?.page_label_name ?? "")
  });
  let current = [];
  try {
    const result = await discountGraph(
      "/" + encodeURIComponent(recipient) + "/custom_labels", null, env
    );
    current = (result.data ?? []).map(toLabel).filter(item => item.id);
  } catch (error) {
    console.warn("Could not read customer's existing labels", String(error));
  }
  let target = null;
  if (labelName) {
    const pageResult = await discountGraph(
      "/" + encodeURIComponent(ADMIN_PAGE_ID) + "/custom_labels?limit=100", null, env
    );
    const labels = (pageResult.data ?? []).map(toLabel).filter(item => item.id);
    target = labels.find(item => item.name === labelName);
    if (!target) {
      const created = await discountGraph(
        "/" + encodeURIComponent(ADMIN_PAGE_ID) + "/custom_labels",
        { method: "POST", body: { page_label_name: labelName } }, env
      );
      if (!created.id) throw new Error("Meta did not return a label ID");
      target = { id: String(created.id), name: labelName };
    }
    if (!current.some(item => item.id === target.id)) {
      await discountGraph(
        "/" + encodeURIComponent(target.id) + "/label",
        { method: "POST", body: { user: recipient } }, env
      );
    }
  }
  const obsolete = new Map();
  for (const item of current) {
    if (item.id !== target?.id && isDurationLabel(item.name)) obsolete.set(item.id, item);
  }
  if (previous?.id && previous.id !== target?.id) obsolete.set(previous.id, previous);
  for (const item of obsolete.values()) {
    await discountGraph(
      "/" + encodeURIComponent(item.id) + "/label?user=" + encodeURIComponent(recipient),
      { method: "DELETE" }, env
    );
  }
  if (target) {
    await env.SESSION_KV.put(key, JSON.stringify({ ...target, updatedAt: Date.now() }));
  } else {
    await env.SESSION_KV.delete(key);
  }
  return target?.name ?? null;
}

const ADMIN_PAGE_ID = "1375397785649301";
async function verifyPageAdminMessage(event, pageId, env) {
  const mid = event.message?.mid;
  const recipient = String(event.recipient?.id ?? "");
  if (pageId !== ADMIN_PAGE_ID || String(event.sender?.id) !== ADMIN_PAGE_ID ||
    event.message?.is_echo !== true || !mid || !recipient || recipient === ADMIN_PAGE_ID) return false;
  try {
    const url = "https://graph.facebook.com/v26.0/" + encodeURIComponent(mid) + "?fields=id,message,from,to,created_time,attachments";
    const response = await fetch(url, { headers: { Authorization: `Bearer ${env.PAGE_ACCESS_TOKEN}` }, signal:AbortSignal.timeout(8000) });
    const message = await response.json();
    const createdAt = Date.parse(message.created_time);
    return response.ok && String(message.from?.id) === ADMIN_PAGE_ID &&
      message.to?.data?.some(person => String(person.id) === recipient) &&
      (typeof event.message.text === "string" ? message.message === event.message.text : !!message.attachments?.data?.length) &&
      Number.isFinite(createdAt) && Math.abs(Date.now() - createdAt) < 600000;
  } catch { return false; }
}
async function handlePageEcho(event, pageId, env) {
  if (parseAdminCommand(event.message?.text)) {
    await handlePageAdminCommand(event, pageId, env);
    return;
  }
  if (env.CUSTOMER_COORDINATOR?.isOwnEcho(event) || event.message?.app_id) return;
  if (!await verifyPageAdminMessage(event, pageId, env)) return;
  await enterHumanSupport(String(event.recipient.id), env, {reason:"admin_active",silent:true});
}
async function handlePageAdminCommand(event, pageId, env) {
  const parsed = parseAdminCommand(event.message?.text);
  if (!parsed || !env.SESSION_KV) return;
  const {command,caption} = parsed;
  if (caption.length > (command === "bc" ? 1500 : 600)) { console.error("Admin command caption too long"); return; }
  const key = "admin_command_done:" + event.message.mid;
  if (await env.SESSION_KV.get(key)) return;
  if (!await verifyPageAdminMessage(event, pageId, env)) {
    console.error("Admin command rejected: Page message could not be verified");
    return;
  }
  await env.SESSION_KV.put(key, "pending", { expirationTtl: 86400 });
  const recipient = String(event.recipient.id);
  try {
    if (["id", "cap", "block", "unblock", "taikhoan"].includes(command)) {
      const message = await portalCommand(command, caption, recipient, env);
      const response = await sendText(recipient, message, env);
      if (!response.ok) throw new Error("Portal command reply failed");
    } else if (command === "check") {
      if (!env.CUSTOMER_COORDINATOR) throw new Error("Customer coordinator missing");
      await env.CUSTOMER_COORDINATOR.markChecked();
      await clearSession(recipient, env);
      const response = await sendText(recipient, "Đã check.", env);
      if (!response.ok) throw new Error("Check confirmation failed");
      console.log("Conversation marked", "đã check");
    } else if (command === "discount") {
      const discount = parseDiscountRule(caption);
      let message;
      if (discount === null) {
        message = "Sai discount. Dùng /discount 10k hoặc /discount 30%. Dùng /discount 0 để gỡ.";
      } else {
        if (discount.kind === "none") {
          await env.SESSION_KV.delete(CUSTOMER_DISCOUNT_PREFIX + recipient);
        } else {
          await env.SESSION_KV.put(CUSTOMER_DISCOUNT_PREFIX + recipient, JSON.stringify({
            ...discount,
            updatedAt: Date.now()
          }));
        }
        let labelNote;
        try {
          const labelName = await syncDiscountLabel(recipient, discount, env);
          labelNote = labelName ? "\nLabel: " + labelName : "\nĐã gỡ label discount.";
        } catch (error) {
          console.error("Discount label sync failed", error);
          labelNote = "\nĐã lưu discount nhưng chưa đồng bộ được label Messenger. Lỗi Meta: " + String(error?.message || "unknown").slice(0, 220);
        }
        message = discount.kind !== "none"
          ? "Đã áp dụng discount " + formatDiscountRule(discount) +
            " cho khách này. Danh sách gói và các tin xác nhận mua sau này sẽ dùng giá đã giảm."
          : "Đã gỡ discount của khách này. Giá trở về bình thường.";
      }
      const response = await sendText(recipient, message, env);
      if (!response.ok) throw new Error("Discount confirmation failed");
    } else if (command === "time") {
      const duration = parseTimeLabel(caption);
      let message;
      if (!duration) {
        message = "Sai thời hạn. Dùng /time 4 tháng, /time 1 năm hoặc /time 0 để gỡ.";
      } else {
        try {
          const applied = await syncCustomerTimeLabel(recipient, duration.name, env);
          message = applied
            ? "Đã thêm label " + applied + " cho khách này."
            : "Đã gỡ label thời hạn của khách này.";
        } catch (error) {
          console.error("Time label sync failed", error);
          message = "Chưa thể đồng bộ label thời hạn trên Messenger. Lỗi Meta: " +
            String(error?.message || "unknown").slice(0, 220);
        }
      }
      const response = await sendText(recipient, message, env);
      if (!response.ok) throw new Error("Time label confirmation failed");
    } else if (["boton", "botoff", "botstatus"].includes(command)) {
      if (command !== "botstatus") {
        await env.SESSION_KV.put("bot:enabled_override", command === "boton" ? "true" : "false");
      }
      const enabled = await isBotEnabled(env);
      const response = await sendText(recipient, "BOT: " + (enabled ? "ĐANG BẬT" : "ĐANG TẮT") +
        "\nÁp dụng toàn Page.\n/boton - Bật\n/botoff - Tắt\n/botstatus - Xem trạng thái", env);
      if (!response.ok) throw new Error("Bot status reply failed");
    } else if (["bc", "bccode", "bcstop", "bcstat"].includes(command)) {
      await handleBroadcastCommand(command, caption, recipient, env);
    } else if (command === "admin") {
      const response = await sendText(recipient, "ADMIN COMMANDS\n\n/admin - Xem danh sách lệnh\n/id ID - Tạo ID, báo nếu trùng\n/cap ID gpt 3month - Cấp hạn từ hiện tại\n/block ID - Khóa và hủy phiên\n/unblock ID - Mở khóa, giữ hạn cũ\n/taikhoan ID - Gửi ID và link truy cập\nThời hạn: 7day, 2week, 3month, 1year\nQuản lý: https://cotdo-messenger-bot.kazuto121100.workers.dev/portal/admin\n/check - Đánh dấu chat đã check, hủy tin nhắc sau 12 tiếng\n/discount [amount] - Giảm riêng theo tiền hoặc % (vd: 10k, 30%); /discount 0 để gỡ\n/time [thời hạn] - Gắn label thời gian (vd: 4 tháng, 1 năm); /time 0 để gỡ\n/sendprice - Gửi bảng giá ngay\n/sendprice Nội dung tùy ý - Gửi bảng giá với lời dẫn riêng\n/rs - Reset phiên bot của khách hiện tại\n/sendmenu - Đồng bộ lại menu 3 gạch\n/help - Gửi thông tin chuyển khoản + QR\n/boton - Bật bot toàn Page\n/botoff - Tắt bot toàn Page\n/botstatus - Xem trạng thái bot\n/bc Nội dung - Soạn tin gửi hàng loạt\n/bccode MÃ - Xác nhận gửi\n/bcstat MÃ - Xem tiến độ\n/bcstop MÃ - Dừng phần chưa gửi", env);
      if (!response.ok) throw new Error("Admin command list failed");
    } else if (command === "sendprice") {
      const outcome = await sendPriceButton(recipient, env, { reason: "admin", caption });
      if (outcome !== "sent") throw new Error("Price message failed");
      await ensureCustomerMenu(recipient, env, true);
    } else if (command === "rs") {
      const menuUpdated = await resetConversation(recipient, env);
      const response = await sendText(recipient, menuUpdated
        ? "Đã reset bot và cập nhật lại menu. Bạn có thể nhắn lại để bắt đầu từ đầu."
        : "Đã reset bot. Menu chưa cập nhật được, bạn nhắn /rs lại sau nha.", env);
      if (!response.ok) throw new Error("Reset confirmation failed");
    } else if (command === "sendmenu") {
      await ensureCustomerMenu(recipient, env, true);
    } else if (command === "help") {
      await sendPaymentInfo(recipient, env);
    }
    await env.SESSION_KV.put(key, "done", { expirationTtl: 86400 });
    console.log("Admin command completed", command);
  } catch (error) {
    await env.SESSION_KV.delete(key);
    console.error("Admin command failed", command);
  }
}


// Campaigns are processed in bounded Cron batches. No automatic send before confirmation.
const BROADCAST_WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
const BROADCAST_TTL = 7 * 86400;
const BROADCAST_TERMINAL = new Set(["done", "cancelled", "failed"]);
async function readBroadcast(env, id) {
  if (!/^[a-f0-9]{12}$/.test(id)) return null;
  const raw = await env.SESSION_KV.get("broadcast:job:" + id);
  return raw ? JSON.parse(raw) : null;
}
async function saveBroadcast(env, job) {
  await env.SESSION_KV.put("broadcast:job:" + job.id, JSON.stringify(job), { expirationTtl: BROADCAST_TTL });
}
function broadcastStatus(job) {
  const labels = { scanning: "ĐANG LỌC KHÁCH", ready: "CHỜ XÁC NHẬN", sending: "ĐANG GỬI", done: "HOÀN TẤT", cancelled: "ĐÃ DỪNG", failed: "LỖI" };
  return "BROADCAST " + job.id + "\n" + labels[job.status] +
    "\nĐủ điều kiện: " + job.recipients.length + "\nĐã gửi: " + job.sent +
    "\nBỏ qua: " + job.skipped + "\nLỗi/không rõ kết quả: " + job.failed;
}
async function broadcastReply(recipient, text, env) {
  const response = await sendText(recipient, text, env);
  if (!response.ok) console.error("Broadcast admin response failed", response.status);
}
async function handleBroadcastCommand(command, argument, recipient, env) {
  if (command === "bc") {
    if (!argument) {
      await broadcastReply(recipient, "Dùng /bc Nội dung m muốn gửi (tối đa 1500 ký tự). Bot tạo bản nháp trước, chưa gửi khách.", env);
      return;
    }
    const activeId = await env.SESSION_KV.get("broadcast:active");
    const active = activeId ? await readBroadcast(env, activeId) : null;
    if (active && !BROADCAST_TERMINAL.has(active.status)) {
      await broadcastReply(recipient, "Đang có broadcast " + active.id + ". Dùng /bcstat " + active.id + " hoặc /bcstop " + active.id + " trước.", env);
      return;
    }
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const job = { id, text: argument, origin: recipient, createdAt: Date.now(), status: "scanning", recipients: [], scanned: 0, cursor: 0, sent: 0, skipped: 0, failed: 0,
      next: "https://graph.facebook.com/v26.0/" + ADMIN_PAGE_ID + "/conversations?platform=messenger&fields=messages.limit(50){from,created_time}&limit=25" };
    await saveBroadcast(env, job);
    await env.SESSION_KV.put("broadcast:active", id, { expirationTtl: BROADCAST_TTL });
    await broadcastReply(recipient, "Đã tạo bản nháp " + id + ". Bot đang lọc khách từng nhắn Page và còn trong 24 giờ; sẽ gửi bản xem trước và số người nhận khi lọc xong.\n/bcstat " + id + "\n/bcstop " + id, env);
    return;
  }
  const id = argument.toLowerCase();
  const job = await readBroadcast(env, id);
  if (!job) {
    await broadcastReply(recipient, "Không tìm thấy mã broadcast. Dùng /" + command + " MÃ.", env);
    return;
  }
  if (command === "bcstat") {
    await broadcastReply(recipient, broadcastStatus(job), env);
    return;
  }
  if (command === "bcstop") {
    if (!BROADCAST_TERMINAL.has(job.status)) {
      await env.SESSION_KV.put("broadcast:cancel:" + id, "1", { expirationTtl: BROADCAST_TTL });
      job.status = "cancelled";
      await saveBroadcast(env, job);
    }
    await broadcastReply(recipient, "Đã dừng phần chưa gửi của broadcast " + id + ". Tin đã gửi không thu hồi; tin đang gửi có thể hoàn tất.", env);
    return;
  }
  if (command === "bccode") {
    if (job.status !== "ready" || await env.SESSION_KV.get("broadcast:cancel:" + id)) {
      await broadcastReply(recipient, "Chưa thể xác nhận: " + broadcastStatus(job), env);
      return;
    }
    job.status = "sending";
    job.confirmedAt = Date.now();
    await saveBroadcast(env, job);
    await broadcastReply(recipient, "Đã xác nhận broadcast " + id + ". Bot gửi từng đợt; xem /bcstat " + id + " hoặc dừng /bcstop " + id, env);
  }
}
async function runBroadcastTick(env) {
  if (!env.SESSION_KV || !await isBotEnabled(env)) return;
  const id = await env.SESSION_KV.get("broadcast:active");
  if (!id) return;
  const job = await readBroadcast(env, id);
  if (!job || BROADCAST_TERMINAL.has(job.status) || job.status === "ready") return;
  const cancelled = async () => !!await env.SESSION_KV.get("broadcast:cancel:" + id);
  try {
    if (await cancelled()) { job.status = "cancelled"; await saveBroadcast(env, job); return; }
    if (Date.now() - job.createdAt > 24 * 60 * 60 * 1000) throw new Error("Campaign expired");
    if (job.status === "scanning") {
      const recipients = new Map(job.recipients.map(person => [person.id, person.lastAt]));
      for (let page = 0; page < 3 && job.next; page++) {
        if (!await isBotEnabled(env)) {
          job.recipients = Array.from(recipients, ([id, lastAt]) => ({ id, lastAt }));
          await saveBroadcast(env, job);
          return;
        }
        if (await cancelled()) { job.status = "cancelled"; await saveBroadcast(env, job); return; }
        const url = new URL(job.next);
        if (url.protocol !== "https:" || url.hostname !== "graph.facebook.com") throw new Error("Invalid pagination URL");
        const response = await fetch(url.toString(), { headers: { Authorization: "Bearer " + env.PAGE_ACCESS_TOKEN } });
        const body = await response.json();
        if (!response.ok || body.error || !Array.isArray(body.data)) throw new Error("Conversation scan failed");
        for (const conversation of body.data) {
          job.scanned++;
          for (const message of conversation.messages?.data ?? []) {
            const psid = String(message.from?.id ?? "");
            const lastAt = Date.parse(message.created_time);
            if (!/^\d+$/.test(psid) || psid === ADMIN_PAGE_ID || !Number.isFinite(lastAt) ||
              lastAt > Date.now() || Date.now() - lastAt >= BROADCAST_WINDOW_MS) continue;
            if (lastAt > (recipients.get(psid) ?? 0)) recipients.set(psid, lastAt);
          }
        }
        job.next = body.paging?.next ?? null;
      }
      job.recipients = Array.from(recipients, ([id, lastAt]) => ({ id, lastAt }));
      if (!job.next) {
        // Freeze the preview audience and remove anybody who expired during scanning.
        job.recipients = job.recipients.filter(person => Date.now() - person.lastAt < BROADCAST_WINDOW_MS);
        job.status = job.recipients.length ? "ready" : "done";
      }
      if (await cancelled()) job.status = "cancelled";
      await saveBroadcast(env, job);
      if (job.status === "ready") {
        await broadcastReply(job.origin, "BẢN NHÁP " + id + "\nNgười nhận đủ điều kiện: " + job.recipients.length +
          "\n\nNỘI DUNG:\n" + job.text + "\n\nGửi: /bccode " + id + "\nHủy: /bcstop " + id, env);
      } else if (job.status === "done") await broadcastReply(job.origin, "Broadcast " + id + ": không có khách đủ điều kiện trong 24 giờ. Chưa gửi tin hàng loạt.", env);
      return;
    }
    if (job.status === "sending") {
      for (let count = 0; count < 15 && job.cursor < job.recipients.length; count++) {
        if (!await isBotEnabled(env)) { await saveBroadcast(env, job); return; }
        if (await cancelled()) { job.status = "cancelled"; break; }
        const person = job.recipients[job.cursor++];
        if (Date.now() - person.lastAt >= BROADCAST_WINDOW_MS) {
          job.skipped++;
          await saveBroadcast(env, job);
          continue;
        }
        const key = "broadcast:recipient:" + id + ":" + person.id;
        const prior = await env.SESSION_KV.get(key);
        if (prior) {
          if (prior === "sent") job.sent++;
          else job.failed++;
          await saveBroadcast(env, job);
          continue;
        }
        // Reserve before sending; ambiguous network outcomes are not retried automatically.
        await env.SESSION_KV.put(key, "reserved", { expirationTtl: BROADCAST_TTL });
        try {
          const response = await sendText(person.id, job.text, env);
          if (response.ok) {
            await env.SESSION_KV.put(key, "sent", { expirationTtl: BROADCAST_TTL });
            job.sent++;
          } else {
            await env.SESSION_KV.put(key, "failed", { expirationTtl: BROADCAST_TTL });
            job.failed++;
          }
        } catch {
          job.failed++;
        }
        await saveBroadcast(env, job);
      }
      if (await cancelled()) job.status = "cancelled";
      else if (job.cursor >= job.recipients.length) job.status = "done";
      await saveBroadcast(env, job);
      if (BROADCAST_TERMINAL.has(job.status)) await broadcastReply(job.origin, broadcastStatus(job), env);
    }
  } catch {
    job.status = "failed";
    await saveBroadcast(env, job);
    console.error("Broadcast processing failed", id);
    await broadcastReply(job.origin, "Broadcast " + id + " bị lỗi khi xử lý. Dùng /bcstat " + id + " để xem kết quả; bot không tự gửi lại các tin không rõ kết quả.", env);
  }
}

async function isBotEnabled(env) {
  const override = env.SESSION_KV ? await env.SESSION_KV.get("bot:enabled_override") : null;
  if (override === "true" || override === "false") return override === "true";
  return String(env.BOT_ENABLED ?? "").toLowerCase() === "true";
}
const PRICE_ADMIN_ORIGIN = "https://cotdostore.github.io";
const PRICE_GITHUB_API = "https://api.github.com/repos/cotdostore/shopweb/contents/prices.json";
async function readPriceBody(response, max = 150000) {
  if (!response.body) throw new Error("Empty body");
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) { const {value, done} = await reader.read(); if (done) break;
      length += value.byteLength; if (length > max) { await reader.cancel(); throw new Error("Body too large"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function handlePriceAdminAPI(request) {
  const origin = request.headers.get("Origin");
  const headers = { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", "Vary":"Origin",
    "Access-Control-Allow-Origin":PRICE_ADMIN_ORIGIN, "Access-Control-Allow-Methods":"GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers":"Authorization, Content-Type", "X-Content-Type-Options":"nosniff" };
  const reply = (body, status = 200) => Response.json(body, {status, headers});
  if (origin !== PRICE_ADMIN_ORIGIN) return reply({error:"Origin không được phép."},403);
  if (request.method === "OPTIONS") return new Response(null,{status:204,headers});
  if (!["GET","PUT"].includes(request.method)) return reply({error:"Method không được phép."},405);
  const authorization = request.headers.get("Authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9_]{20,255}$/.test(authorization)) return reply({error:"Cần kết nối bằng token GitHub hợp lệ."},401);
  const ghHeaders = { Authorization:authorization, Accept:"application/vnd.github+json", "User-Agent":"CotDo-Price-Admin", "X-GitHub-Api-Version":"2022-11-28" };
  // Credentials remain request-scoped; they are never stored in KV, source, or logs.
  try {
    if (request.method === "GET") {
      const response = await fetch(PRICE_GITHUB_API+"?ref=main", {headers:ghHeaders,signal:AbortSignal.timeout(15000)});
      const file = await readPriceBody(response);
      if (!response.ok) return reply({error:"GitHub từ chối kết nối. Kiểm tra tài khoản, repo và quyền Contents của token."},response.status===401?401:403);
      if (file.encoding !== "base64" || !file.content) return reply({error:"Không đọc được prices.json."},502);
      const bytes = Uint8Array.from(atob(file.content.replace(/\s/g,"")), c=>c.charCodeAt(0));
      const data = validatePriceData(JSON.parse(new TextDecoder().decode(bytes)));
      return reply({data,sha:file.sha});
    }
    const body = await readPriceBody(request);
    if (!/^[a-f0-9]{40}$/.test(body.sha ?? "")) return reply({error:"Thiếu phiên bản bảng giá. Hãy kết nối lại GitHub."},400);
    let data;
    try { data = validatePriceData(body.data); } catch(error) { return reply({error:error.message},400); }
    const bytes = new TextEncoder().encode(JSON.stringify(data,null,2)+"\n");
    const content = btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(""));
    const response = await fetch(PRICE_GITHUB_API, {
      method:"PUT", headers:{...ghHeaders,"Content-Type":"application/json"},signal:AbortSignal.timeout(15000),
      body:JSON.stringify({message:"Update store prices from price manager",branch:"main",sha:body.sha,content})
    });
    const result = await readPriceBody(response);
    if (response.status === 409 || response.status === 422) return reply({error:"Giá đã thay đổi ở nơi khác hoặc phiên bản không hợp lệ. Tải file JSON để giữ bản đang sửa, rồi tải lại giá mới nhất."},409);
    if (!response.ok) return reply({error:"GitHub chưa cho lưu. Kiểm tra token có Contents: Read and write cho đúng repo."},response.status===401?401:403);
    if (!result.content?.sha) return reply({error:"GitHub chưa xác nhận phiên bản mới. Tải lại giá để kiểm tra trước khi lưu tiếp."},502);
    return reply({sha:result.content.sha,commit:result.commit?.sha});
  } catch {
    return reply({error:"Kết nối lỗi hoặc dữ liệu quá lớn. Nếu vừa lưu, hãy kiểm tra lại giá trên GitHub trước khi thử tiếp."},502);
  }
}
function matchesChatGPTPlan(query, item) {
  const fields=itemSearchFields(item);
  if (!fields.product.includes("chatgpt")) return true;
  const description = fields.fullDescription;
  if (/\bgo\b/.test(query)) return /\bgo\b/.test(description);
  if (/\bplus\b/.test(query)) return /\bplus\b/.test(description);
  return true;
}


async function requestHumanSupport(senderId, env) {
  await enterHumanSupport(senderId, env, {
    reason: "requested",
    notice: "Sốp đã nhận yêu cầu hỗ trợ của bạn. Bạn nhắn thắc mắc vào đây, admin sẽ đọc và trả lời sớm nha."
  });
}
function filterNamedVariants(options, originalText) {
  const words = normalizeText(originalText).replace(/\d+\s*(ngay|tuan|thang|nam)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(word => word.length >= 2 && !IGNORED_WORDS.has(word) && !["loai", "tai", "khoan", "la", "chon", "nhe", "nha"].includes(word) && !/^\d+k?$/.test(word));
  const variantWords = new Set(options.flatMap(item => normalizeText(item.variant).replace(/[^a-z0-9\s]/g, " ").split(/\s+/)));
  const requested = words.filter(word => variantWords.has(word));
  if (!requested.length) return null;
  return options.filter(item => {
    const itemWords = new Set(normalizeText(item.variant).replace(/[^a-z0-9\s]/g, " ").split(/\s+/));
    return requested.every(word => itemWords.has(word));
  });
}
