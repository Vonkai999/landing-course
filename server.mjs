import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(fileURLToPath(import.meta.url));
const courseId = "highheels_5day_v1";
const coursePrice = 39000; // 390 UAH, expressed in kopiykas for Stripe.
const claimLifetimeMs = 24 * 60 * 60 * 1000;

// Read a local .env without adding dependencies. On a hosting service, set these
// as environment variables in its dashboard instead.
try {
  const envText = await readFile(join(projectDir, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^("|')(.*)\1$/, "$2");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const port = Number(process.env.PORT || 4242);
const baseUrl = process.env.PUBLIC_BASE_URL;
const secretKey = process.env.STRIPE_SECRET_KEY;
const sendPulseBotUsername = process.env.SENDPULSE_BOT_USERNAME || "HighHeelsHome_bot";
const sendPulsePaidFlowId = process.env.SENDPULSE_PAID_FLOW_ID;
const claimStoreDir = join(projectDir, ".private");
const claimStorePath = join(claimStoreDir, "telegram-claims.json");
const publicFiles = new Set([
  "/", "/index.html", "/offer.html", "/privacy.html", "/style.css", "/script.js",
  "/IMG_2914.PNG", "/IMG_3957.PNG", "/IMG_3958.PNG", "/IMG_3959.PNG",
  "/IMG_3960.PNG", "/IMG_3961.PNG", "/IMG_3972.PNG", "/IMG_3973.mp4",
  "/IMG_4038.mp4", "/IMG_4055.PNG", "/IMG_4061.JPG", "/IMG_4064.JPG",
  "/IMG_4068.PNG", "/IMG_4073.JPG", "/IMG_4076.JPG", "/karina-review-avatar.jpg",
  "/14D5118F-14E4-4857-9E24-E08A1B7F3FB4.JPG",
  "/IMG_4094.PNG", "/IMG_4095.PNG", "/IMG_4096.PNG", "/IMG_4097.PNG"
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4"
};

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function stripeIsConfigured() {
  return Boolean(baseUrl && secretKey &&
    (secretKey.startsWith("sk_test_") || secretKey.startsWith("sk_live_")));
}

function stripeIsTestMode() {
  return Boolean(secretKey?.startsWith("sk_test_"));
}

function telegramHandoffIsConfigured() {
  return Boolean(
    sendPulseBotUsername && /^[A-Za-z0-9_]{5,32}$/.test(sendPulseBotUsername) &&
    sendPulsePaidFlowId && /^[A-Za-z0-9_-]{1,100}$/.test(sendPulsePaidFlowId)
  );
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8192) throw new Error("Request body is too large.");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON.");
  }
}

async function getStripeSession(sessionId) {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId || "")) return null;

  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { "Authorization": `Bearer ${secretKey}` }
  });
  const result = await response.json();
  if (!response.ok) {
    console.error("Stripe session lookup failed:", response.status, result.error?.type || "unknown error");
    throw new Error("Stripe could not verify this Checkout Session.");
  }
  return result;
}

function isPaidCourseSession(session) {
  return Boolean(
    session && session.mode === "payment" && session.payment_status === "paid" &&
    session.currency === "uah" && session.amount_total === coursePrice &&
    session.metadata?.course_id === courseId
  );
}

async function readClaimStore() {
  try {
    const saved = JSON.parse(await readFile(claimStorePath, "utf8"));
    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

let claimStoreQueue = Promise.resolve();
function withClaimStoreLock(operation) {
  const result = claimStoreQueue.then(operation);
  claimStoreQueue = result.catch(() => {});
  return result;
}

async function writeClaimStore(claims) {
  await mkdir(claimStoreDir, { recursive: true });
  const temporaryPath = `${claimStorePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(claims), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, claimStorePath);
}

async function createRecoveryToken(sessionId) {
  return withClaimStoreLock(async () => {
    const claims = await readClaimStore();
    const existing = claims.find(claim => claim.sessionId === sessionId);
    if (existing?.recoveryToken) return existing.recoveryToken;

    const recoveryToken = randomBytes(24).toString("base64url");
    if (existing) existing.recoveryToken = recoveryToken;
    else claims.push({ sessionId, recoveryToken, token: null, expiresAt: 0, claimedBy: null });
    await writeClaimStore(claims);
    return recoveryToken;
  });
}

async function getOrCreateClaimToken(sessionId) {
  return withClaimStoreLock(async () => {
    const now = Date.now();
    const claims = await readClaimStore();
    let existing = claims.find(claim => claim.sessionId === sessionId);
    if (existing?.claimedBy && existing.token) return existing.token;
    if (existing?.token && existing.expiresAt > now) return existing.token;
    if (existing?.claimedBy) return null;

    const token = randomBytes(24).toString("base64url");
    if (existing) {
      existing.token = token;
      existing.expiresAt = now + claimLifetimeMs;
    } else {
      existing = { sessionId, recoveryToken: null, token, expiresAt: now + claimLifetimeMs, claimedBy: null };
      claims.push(existing);
    }
    await writeClaimStore(claims);
    return token;
  });
}

async function redeemClaimToken(token, subscriberId) {
  return withClaimStoreLock(async () => {
    const now = Date.now();
    const claims = await readClaimStore();
    const claim = claims.find(item => item.token === token);
    if (!claim) return false;
    if (claim.claimedBy) return claim.claimedBy === subscriberId;
    if (claim.expiresAt <= now) return false;
    claim.claimedBy = subscriberId;
    claim.claimedAt = now;
    await writeClaimStore(claims);
    return true;
  });
}

async function createCheckoutSession() {
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "uah",
    "line_items[0][price_data][unit_amount]": String(coursePrice),
    "line_items[0][price_data][product_data][name]": "Онлайн-курс High Heels дома",
    "line_items[0][quantity]": "1",
    "metadata[course_id]": courseId,
    success_url: `${baseUrl}/?checkout=complete&session_id={CHECKOUT_SESSION_ID}#buy`,
    cancel_url: `${baseUrl}/#buy`
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });
  const result = await response.json();
  if (!response.ok) {
    // Do not send Stripe's raw response or account details to the visitor.
    console.error("Stripe could not create a Checkout Session:", response.status, result.error?.type || "unknown error");
    throw new Error("Stripe rejected the checkout request.");
  }
  return { id: result.id, url: result.url };
}

function isSameSiteRequest(request) {
  if (!request.headers.origin) return true;
  try {
    return new URL(request.headers.origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  } catch {
    return sendJson(response, 400, { error: "Некорректный запрос." });
  }
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  if (request.method === "POST" && requestUrl.pathname === "/api/create-checkout-session") {
    if (!stripeIsConfigured()) {
      return sendJson(response, 503, { error: "Добавь Stripe-ключ и адрес сайта в .env." });
    }
    if (!telegramHandoffIsConfigured() && !stripeIsTestMode()) {
      return sendJson(response, 503, { error: "Сначала подключим SendPulse к оплате, чтобы покупатель не остался без доступа." });
    }
    if (!isSameSiteRequest(request)) return sendJson(response, 403, { error: "Запрос оплаты отклонён." });

    try {
      const session = await createCheckoutSession();
      const recoveryToken = await createRecoveryToken(session.id);
      return sendJson(response, 200, {
        url: session.url,
        session_id: session.id,
        recovery_token: recoveryToken
      });
    } catch {
      return sendJson(response, 502, { error: "Stripe пока не создал страницу оплаты. Попробуй ещё раз позже." });
    }
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/recover-purchase") {
    if (!stripeIsConfigured()) return sendJson(response, 503, { error: "Проверка оплаты пока недоступна." });
    if (!isSameSiteRequest(request)) return sendJson(response, 403, { error: "Запрос отклонён." });

    try {
      const body = await readJsonBody(request);
      const recoveryToken = typeof body.recovery_token === "string" ? body.recovery_token : "";
      if (!/^[A-Za-z0-9_-]{32}$/.test(recoveryToken)) {
        return sendJson(response, 200, { paid: false });
      }

      const claims = await readClaimStore();
      const order = claims.find(item => item.recoveryToken === recoveryToken);
      if (!order) return sendJson(response, 200, { paid: false });

      const session = await getStripeSession(order.sessionId);
      if (!isPaidCourseSession(session)) return sendJson(response, 200, { paid: false });

      if (!telegramHandoffIsConfigured() && stripeIsTestMode()) {
        const telegramUrl = new URL(`https://t.me/${sendPulseBotUsername}`);
        return sendJson(response, 200, { paid: true, telegram_url: telegramUrl.toString(), preview_only: true });
      }
      if (!telegramHandoffIsConfigured()) {
        return sendJson(response, 503, { error: "Переход в бот ещё не настроен." });
      }

      const token = await getOrCreateClaimToken(session.id);
      if (!token) return sendJson(response, 200, { paid: true, already_claimed: true });
      const telegramUrl = new URL(`https://tg.pulse.is/${sendPulseBotUsername}`);
      telegramUrl.searchParams.set("start", sendPulsePaidFlowId);
      telegramUrl.searchParams.set("claim_token", token);
      return sendJson(response, 200, { paid: true, telegram_url: telegramUrl.toString() });
    } catch (error) {
      console.error("Could not recover purchase:", error.message);
      return sendJson(response, 502, { error: "Не удалось проверить оплату. Попробуй обновить страницу." });
    }
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/create-telegram-claim") {
    if (!stripeIsConfigured()) {
      return sendJson(response, 503, { error: "Переход в бот ещё не настроен. Не закрывай страницу и обратись за помощью." });
    }
    if (!isSameSiteRequest(request)) return sendJson(response, 403, { error: "Запрос отклонён." });

    try {
      const body = await readJsonBody(request);
      const session = await getStripeSession(body.session_id);
      if (!isPaidCourseSession(session)) {
        return sendJson(response, 402, { error: "Stripe пока не подтвердил оплату этого курса." });
      }

      // In Stripe test mode only, allow a simple redirect to the bot so we can
      // preview the return journey before the SendPulse paid flow is configured.
      // This never grants a production entitlement.
      if (!telegramHandoffIsConfigured() && stripeIsTestMode()) {
        const telegramUrl = new URL(`https://t.me/${sendPulseBotUsername}`);
        return sendJson(response, 200, { telegram_url: telegramUrl.toString(), preview_only: true });
      }
      if (!telegramHandoffIsConfigured()) {
        return sendJson(response, 503, { error: "Переход в бот ещё не настроен." });
      }

      const token = await getOrCreateClaimToken(session.id);
      if (!token) return sendJson(response, 409, { error: "Этот код доступа уже использован." });
      const telegramUrl = new URL(`https://tg.pulse.is/${sendPulseBotUsername}`);
      telegramUrl.searchParams.set("start", sendPulsePaidFlowId);
      telegramUrl.searchParams.set("claim_token", token);
      return sendJson(response, 200, { telegram_url: telegramUrl.toString() });
    } catch (error) {
      console.error("Could not prepare Telegram handoff:", error.message);
      return sendJson(response, 502, { error: "Не удалось подготовить переход в Telegram. Попробуй обновить страницу." });
    }
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/redeem-telegram-claim") {
    if (!stripeIsConfigured()) return sendJson(response, 503, { error: "Проверка Stripe ещё не настроена." });

    try {
      const body = await readJsonBody(request);
      const token = typeof body.claim_token === "string" ? body.claim_token : "";
      const subscriberId = typeof body.subscriber_id === "string" ? body.subscriber_id.trim() : "";
      if (!/^[A-Za-z0-9_-]{32}$/.test(token) || !subscriberId || subscriberId.length > 128) {
        return sendJson(response, 200, { authorized: false });
      }

      const claims = await readClaimStore();
      const claim = claims.find(item => item.token === token && item.expiresAt > Date.now());
      if (!claim) return sendJson(response, 200, { authorized: false });
      const session = await getStripeSession(claim.sessionId);
      if (!isPaidCourseSession(session)) return sendJson(response, 200, { authorized: false });

      const authorized = await redeemClaimToken(token, subscriberId);
      return sendJson(response, 200, { authorized });
    } catch (error) {
      console.error("Could not verify Telegram claim:", error.message);
      return sendJson(response, 502, { error: "Не удалось проверить оплату. Попробуй ещё раз." });
    }
  }

  if (request.method !== "GET" || !publicFiles.has(requestUrl.pathname)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("Not found");
  }

  const filePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  try {
    if (extname(filePath).toLowerCase() === ".mp4") {
      const absolutePath = join(projectDir, filePath);
      const { size } = await stat(absolutePath);
      const rangeHeader = request.headers.range;
      const rangeMatch = typeof rangeHeader === "string"
        ? rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
        : null;

      if (rangeMatch && size > 0) {
        let start;
        let end;
        if (rangeMatch[1] === "") {
          const suffixLength = Number(rangeMatch[2]);
          if (suffixLength <= 0) {
            response.writeHead(416, { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
            return response.end();
          }
          start = Math.max(size - suffixLength, 0);
          end = size - 1;
        } else {
          start = Number(rangeMatch[1]);
          end = rangeMatch[2] === "" ? size - 1 : Number(rangeMatch[2]);
        }

        if (start >= size || start > end) {
          response.writeHead(416, { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
          return response.end();
        }

        end = Math.min(end, size - 1);
        response.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=3600"
        });
        if (request.method === "HEAD") return response.end();
        return createReadStream(absolutePath, { start, end }).pipe(response);
      }

      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600"
      });
      if (request.method === "HEAD") return response.end();
      return createReadStream(absolutePath).pipe(response);
    }

    const file = await readFile(join(projectDir, filePath));
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": filePath.endsWith(".html") || filePath.endsWith(".js") ? "no-cache" : "public, max-age=3600"
    });
    response.end(file);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`High Heels site is running on port ${port}`);
});
