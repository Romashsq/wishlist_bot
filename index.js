import "dotenv/config";
import { Bot, InlineKeyboard, Keyboard } from "grammy";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── OpenAI ───────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Bot ──────────────────────────────────────────────────────────────────
const bot = new Bot(process.env.BOT_TOKEN);

// ─── Доступ к поиску ──────────────────────────────────────────────────────
const SEARCH_ALLOWED = new Set([458227557, 739105994]);

// ─── JSON helpers ─────────────────────────────────────────────────────────
function readJsonSafe(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("writeJsonSafe error:", filePath, e.message);
  }
}

const WISHES_FILE = path.join(__dirname, "wishes.json");
const BINDINGS_FILE = path.join(__dirname, "bindings.json");
const USERS_FILE = path.join(__dirname, "users.json");

const getWishes = () => readJsonSafe(WISHES_FILE, []);
const saveWishes = (d) => writeJsonSafe(WISHES_FILE, d);
const getBindings = () => readJsonSafe(BINDINGS_FILE, {});
const saveBindings = (d) => writeJsonSafe(BINDINGS_FILE, d);
const getUsers = () => readJsonSafe(USERS_FILE, {});
const saveUsers = (d) => writeJsonSafe(USERS_FILE, d);

// ─── State machine ────────────────────────────────────────────────────────
/** @type {Map<string, object>} */
const userState = new Map();

const getState = (userId) => userState.get(String(userId)) ?? {};
const setState = (userId, data) =>
  userState.set(String(userId), { ...getState(userId), ...data });
const clearState = (userId) => userState.delete(String(userId));

// ─── ID generator ─────────────────────────────────────────────────────────
const generateId = () =>
  crypto.randomBytes(6).toString("hex") + "_" + Date.now();

// ─── User helpers ─────────────────────────────────────────────────────────
function ensureUser(ctx) {
  const users = getUsers();
  const userId = String(ctx.from.id);
  if (!users[userId]) {
    users[userId] = {
      userId,
      firstName: ctx.from.first_name || "Unknown",
      role: "owner",
      partnerIds: [],
      createdAt: new Date().toISOString(),
    };
    saveUsers(users);
  }
  return users[userId];
}

function updateUserRole(userId) {
  const users = getUsers();
  const bindings = getBindings();
  const uid = String(userId);
  if (!users[uid]) return;
  const isOwner = uid in bindings;
  const isBuyerFlag = Object.values(bindings).includes(uid);
  if (isOwner && isBuyerFlag) users[uid].role = "both";
  else if (isBuyerFlag) users[uid].role = "buyer";
  else users[uid].role = "owner";
  saveUsers(users);
}

function getBuyerId(ownerId) {
  return getBindings()[String(ownerId)] ?? null;
}

function getOwnerId(buyerId) {
  const bindings = getBindings();
  const bid = String(buyerId);
  return Object.keys(bindings).find((k) => bindings[k] === bid) ?? null;
}

const isBuyerUser = (userId) => getOwnerId(String(userId)) !== null;

// ─── Keyboards ───────────────────────────────────────────────────────────
function getMainKeyboard(userId) {
  const buyer = isBuyerUser(String(userId));
  const rows = [
    ["➕ Добавить товар", "🔍 Найти товар"],
    ["📋 Мои хотелки", "🎁 Идея подарка"],
  ];
  if (buyer) rows.push(["💝 Что хочет мой партнёр", "🧾 Куплено / История"]);
  rows.push(["💬 Поболтать", "⚙️ Настройки"]);
  return Keyboard.from(rows).resized();
}

function getSettingsKeyboard() {
  return Keyboard.from([
    ["🔗 Привязать покупателя", "🔓 Отвязать покупателя"],
    ["👤 Мой ID"],
    ["⬅️ Назад"],
  ]).resized();
}

function getAddMethodKeyboard() {
  return new InlineKeyboard()
    .text("📝 Вручную", "add_method:manual")
    .row()
    .text("🔗 По ссылке", "add_method:link")
    .row()
    .text("🔍 Найти в интернете", "add_method:search");
}

function getPriorityKeyboard() {
  return new InlineKeyboard()
    .text("⭐ 1", "priority_1")
    .text("⭐⭐ 2", "priority_2")
    .text("⭐⭐⭐ 3", "priority_3");
}

function getConfirmKeyboard() {
  return new InlineKeyboard()
    .text("✅ Всё верно", "confirm_add")
    .text("✏️ Редактировать", "edit_add")
    .row()
    .text("❌ Отмена", "cancel_add");
}

function getBuyerWishKeyboard(wishId) {
  return new InlineKeyboard()
    .text("✅ Куплено", `mark_bought:${wishId}`)
    .text("🛒 Возьму", `mark_planned:${wishId}`)
    .row()
    .text("💤 Отложить", `mark_archived:${wishId}`)
    .text("📝 Заметка", `note:${wishId}`);
}

// ─── Caption builder ──────────────────────────────────────────────────────
function wishCaption(wish, forBuyer = false) {
  const stars = "⭐".repeat(wish.priority || 1);
  const statusMap = {
    new: "🆕 Новое",
    planned: "🛒 Планируется",
    bought: "✅ Куплено",
    archived: "💤 Отложено",
  };
  let text = `*${escMd(wish.title)}*\n`;
  text += `${stars} Приоритет\n`;
  text += `💰 ${escMd(wish.price)}\n`;
  if (wish.link) text += `🔗 [Ссылка](${wish.link})\n`;
  text += `Статус: ${statusMap[wish.status] ?? wish.status}`;
  if (forBuyer && wish.noteFromBuyer)
    text += `\n📝 Заметка: _${escMd(wish.noteFromBuyer)}_`;
  return text;
}

function escMd(str) {
  return String(str ?? "").replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// ─── Send wish card helper (supports both photoFileId and photoUrl) ────────
async function sendWishCard(target, chatId, wish, keyboard, forBuyer = false) {
  const caption = wishCaption(wish, forBuyer);
  const msgOpts = { parse_mode: "Markdown", ...(keyboard ? { reply_markup: keyboard } : {}) };
  const photo = wish.photoFileId || wish.photoUrl || null;

  if (photo) {
    try {
      if (typeof target.replyWithPhoto === "function") {
        await target.replyWithPhoto(photo, { caption, ...msgOpts });
      } else {
        await target.api.sendPhoto(chatId, photo, { caption, ...msgOpts });
      }
      return;
    } catch {
      // fall through to text
    }
  }

  if (typeof target.reply === "function") {
    await target.reply(caption, msgOpts);
  } else {
    await target.api.sendMessage(chatId, caption, msgOpts);
  }
}

// ─── Build & send confirm preview ────────────────────────────────────────
async function sendConfirmPreview(ctx, s) {
  const priority = s.priority ?? 2;
  const preview =
    `*${escMd(s.title ?? "Без названия")}*\n` +
    `${"⭐".repeat(priority)} Приоритет\n` +
    `💰 ${escMd(s.price ?? "Не указана")}\n` +
    (s.link ? `🔗 [Ссылка](${s.link})\n` : "") +
    `Статус: 🆕 Новое\n\n_Всё верно?_`;

  const photo = s.photoFileId || s.photoUrl || null;
  if (photo) {
    try {
      await ctx.replyWithPhoto(photo, {
        caption: preview,
        parse_mode: "Markdown",
        reply_markup: getConfirmKeyboard(),
      });
      return;
    } catch {
      // fall through
    }
  }
  await ctx.reply(preview, {
    parse_mode: "Markdown",
    reply_markup: getConfirmKeyboard(),
  });
}

// ─── GPT helpers ─────────────────────────────────────────────────────────
async function gptRequest(messages) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 300,
      temperature: 0.9,
    });
    return res.choices[0].message.content.trim();
  } catch (e) {
    console.error("GPT error:", e.message);
    return "Ой, у меня сейчас мозговой туман 🌫️";
  }
}

async function gptWishComment(title) {
  return gptRequest([
    {
      role: "system",
      content:
        "Ты романтичный и смешной помощник для влюблённой пары. Пиши коротко — 1-2 предложения, мило и с лёгким юмором. Без токсика. На русском языке.",
    },
    {
      role: "user",
      content: `Партнёр добавила новую хотелку: «${title}». Скажи что-нибудь смешное и доброе об этом.`,
    },
  ]);
}

async function gptTalk(userId, userMessage) {
  const s = getState(userId);
  const history = Array.isArray(s.chatHistory) ? s.chatHistory : [];
  const messages = [
    {
      role: "system",
      content:
        `You are a smart assistant in a "Couple's Wishlist" Telegram bot. The app helps couples share and track gift wishlists.

YOUR TASKS:
- Help find specific products or gift ideas (mention brands, specs, price ranges)
- Recommend where to buy in Ukraine: Rozetka, Prom.ua, Allo, Makeup.com.ua, Epicentr, Intertop, Kasta, Comfy, Foxtrot, Citrus etc.
- Show prices in UAH (₴) when possible
- Help choose between options (concrete pros/cons)
- Support casual conversation on any topic

LANGUAGE RULE (CRITICAL):
- Detect the language of the user's message and ALWAYS reply in the SAME language
- Supported: Ukrainian, Russian, English, Polish, German, French, Spanish, or any other language the user writes in
- Never switch languages mid-conversation unless the user does

STYLE RULES:
- Keep replies short: 2-4 sentences
- Be friendly and slightly witty, but ABOVE ALL useful and specific
- If asked about a product — name specific models/brands and where to buy in Ukraine
- NEVER give vague advice like "go to a store" or "hug your partner"
- If unsure — be honest and suggest an alternative`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];
  const reply = await gptRequest(messages);
  const newHistory = [
    ...history,
    { role: "user", content: userMessage },
    { role: "assistant", content: reply },
  ];
  if (newHistory.length > 20) newHistory.splice(0, 2);
  setState(userId, { chatHistory: newHistory });
  return reply;
}

/** GPT: запропонуй ідею подарунка з урахуванням вишліста */
async function gptGiftIdea(userId) {
  const ownerId = getOwnerId(userId) || userId;
  const wishes = getWishes().filter((w) => w.ownerId === ownerId && w.status !== "archived");
  const wishList = wishes.map((w) => `«${w.title}» (${w.price})`).join(", ");

  return gptRequest([
    {
      role: "system",
      content:
        `Ти експерт з подарунків для українського ринку. Пропонуй конкретні ідеї — з назвами товарів, де купити (Rozetka, Prom.ua, Allo, Makeup, Epicentr тощо) і орієнтовними цінами в гривнях (₴). Відповідай українською або російською, коротко і по суті.`,
    },
    {
      role: "user",
      content: wishList
        ? `У вишліст вже є: ${wishList}.\n\nЗапропонуй 3 ідеї подарунків у схожому стилі або як доповнення. Для кожної — конкретна назва + де купити + орієнтовна ціна в ₴.`
        : `Запропонуй 5 універсальних ідей для подарунка. Для кожної — конкретна назва товару + де купити в Україні + орієнтовна ціна в ₴.`,
    },
  ]);
}

/** GPT → {query} для пошуку товару на Google Shopping */
async function gptBuildSearchQuery(userInput) {
  const raw = await gptRequest([
    {
      role: "system",
      content:
        'Ти помічник для пошуку товарів. Користувач описує товар своїми словами.\n' +
        'Склади короткий точний пошуковий запит для Google Shopping — так, щоб знайти товар на офіційних сайтах брендів або великих маркетплейсах (ASOS, Zalando, Zara, Nike, Adidas, Rozetka тощо).\n' +
        'Якщо є конкретний бренд — обов\'язково включи його. Додай ключові характеристики.\n' +
        'Верни ТІЛЬКИ JSON (без markdown): {"query":"пошуковий рядок"}\n' +
        'Запит пиши англійською або мовою бренду — це дає кращі результати на Google Shopping.',
    },
    { role: "user", content: userInput },
  ]);
  try {
    const cleaned = raw.replace(/```[\w]*|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { query: userInput };
  }
}

// ─── Scraper: extract product from URL ───────────────────────────────────
async function fetchProductData(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "uk-UA,uk;q=0.9,ru-RU;q=0.8,en-US;q=0.7",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // Try fast HTML parsing first
    const fast = parseProductFromHtml(html, url);
    if (fast && fast.title && fast.image) return fast;

    // GPT fallback for JS-heavy sites (Zara, Bershka, etc.)
    return await gptExtractProduct(html, url);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function parseProductFromHtml(html, sourceUrl) {
  // A) JSON-LD schema.org Product
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRe.exec(html)) !== null) {
    try {
      const obj = JSON.parse(ldMatch[1]);
      const items = Array.isArray(obj) ? obj : [obj];
      for (const item of items) {
        const product = findProductInLd(item);
        if (product) return { ...product, link: sourceUrl, source: "jsonld" };
      }
    } catch {
      /* skip malformed JSON-LD */
    }
  }

  // B) __NEXT_DATA__ (Next.js: Zara, Bershka, Reserved, etc.)
  const nextDataM = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataM) {
    try {
      const nd = JSON.parse(nextDataM[1]);
      const product = findProductInObj(nd, 0);
      if (product) return { ...product, link: sourceUrl, source: "nextdata" };
    } catch { /* skip */ }
  }

  // C) OpenGraph
  const ogTitle = ogMeta(html, "og:title") || htmlTitle(html);
  const ogImage = ogMeta(html, "og:image");
  const ogPrice =
    ogMeta(html, "product:price:amount") ||
    ogMeta(html, "og:price:amount") ||
    ogMeta(html, "product:price");

  if (ogTitle && ogImage) {
    return { title: ogTitle, image: ogImage, price: ogPrice, link: sourceUrl, source: "og" };
  }

  // D) Fallback: <title> + first img src
  const title = htmlTitle(html);
  const imgM = html.match(/<img[^>]+src=["']([^"']{10,})["'][^>]*/i);
  if (imgM) {
    let img = imgM[1];
    if (!img.startsWith("http")) {
      try { img = new URL(img, sourceUrl).href; } catch { img = null; }
    }
    if (title && img) {
      return { title, image: img, price: null, link: sourceUrl, source: "fallback" };
    }
  }

  return null;
}

/** Рекурсивний пошук продукту в JSON-LD об'єкті (вкладені @graph тощо) */
function findProductInLd(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj["@type"] === "Product" || (Array.isArray(obj["@type"]) && obj["@type"].includes("Product"))) {
    const title = obj.name;
    const imageRaw = obj.image;
    let image = Array.isArray(imageRaw) ? imageRaw[0] : imageRaw;
    if (image && typeof image === "object") image = image.url || null;
    let price = null;
    if (obj.offers) {
      const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
      if (offer.price != null) price = `${offer.price} ${offer.priceCurrency ?? ""}`.trim();
    }
    if (title && image) return { title, image: String(image), price };
  }
  // Recurse into arrays and nested objects
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const el of val) {
        const r = findProductInLd(el);
        if (r) return r;
      }
    } else if (val && typeof val === "object") {
      const r = findProductInLd(val);
      if (r) return r;
    }
  }
  return null;
}

/** Шукає name/price/image в довільному JSON об'єкті (Next.js pageProps) */
function findProductInObj(obj, depth) {
  if (depth > 6 || !obj || typeof obj !== "object") return null;
  // Look for an object that has name + (price or offers) + image
  const keys = Object.keys(obj);
  const hasName = keys.some((k) => k === "name" || k === "title" || k === "productName");
  const hasPrice = keys.some((k) => ["price", "salePrice", "currentPrice", "offers"].includes(k));
  const hasImage = keys.some((k) => ["image", "images", "thumbnail", "photo", "mediaSet"].includes(k));
  if (hasName && (hasPrice || hasImage)) {
    const title = obj.name || obj.title || obj.productName;
    let price = null;
    if (obj.price != null) price = String(obj.price);
    else if (obj.salePrice != null) price = String(obj.salePrice);
    else if (obj.currentPrice != null) price = String(obj.currentPrice);
    let image = null;
    if (typeof obj.image === "string") image = obj.image;
    else if (Array.isArray(obj.images) && obj.images[0]) {
      image = typeof obj.images[0] === "string" ? obj.images[0] : obj.images[0].url || obj.images[0].src || null;
    } else if (Array.isArray(obj.mediaSet) && obj.mediaSet[0]) {
      image = obj.mediaSet[0].url || obj.mediaSet[0].src || null;
    }
    if (title && image) return { title: String(title), image: String(image), price };
  }
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const el of val) {
        const r = findProductInObj(el, depth + 1);
        if (r) return r;
      }
    } else if (val && typeof val === "object") {
      const r = findProductInObj(val, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** Витягує найбільш релевантну частину HTML для GPT */
function extractRelevantHtml(html) {
  const parts = [];
  const titleM = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  if (titleM) parts.push(titleM[0]);
  // Meta tags
  const metas = [...html.matchAll(/<meta[^>]+>/gi)].map((m) => m[0]);
  parts.push(...metas.slice(0, 30));
  // JSON-LD scripts
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi)) {
    parts.push(m[0].slice(0, 2000));
  }
  // __NEXT_DATA__
  const nd = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>[\s\S]{0,6000}/i);
  if (nd) parts.push(nd[0]);
  return parts.join("\n").slice(0, 8000);
}

/** GPT витягує назву/ціну/зображення коли HTML-парсинг не спрацював */
async function gptExtractProduct(html, url) {
  try {
    const relevant = extractRelevantHtml(html);
    if (!relevant || relevant.length < 50) return null;
    const raw = await gptRequest([
      {
        role: "system",
        content:
          "Ти парсер товарних сторінок. З наданого HTML витягни інформацію про товар.\n" +
          "Верни ТІЛЬКИ JSON (без markdown): {\"title\":\"назва\",\"price\":\"ціна з валютою\",\"image\":\"https://...\"}\n" +
          "Якщо поле не знайдено — null. Ціну пиши як є (наприклад: 1299 UAH або 49.99 EUR).\n" +
          "image має бути повним URL зображення товару.",
      },
      { role: "user", content: `URL: ${url}\n\nHTML:\n${relevant}` },
    ]);
    const cleaned = raw.replace(/```[\w]*|```/g, "").trim();
    const obj = JSON.parse(cleaned);
    if (obj && obj.title) {
      return { title: obj.title, price: obj.price || null, image: obj.image || null, link: url, source: "gpt" };
    }
  } catch { /* ignore */ }
  return null;
}

function ogMeta(html, prop) {
  // property="..." content="..." OR content="..." property="..."
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${prop}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function htmlTitle(html) {
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return m ? m[1].trim() : null;
}

// ─── SerpAPI Google Shopping ──────────────────────────────────────────────

// Офіційні бренди та великі маркетплейси — найвищий пріоритет
const TRUSTED_GLOBAL = [
  // Великі міжнародні маркетплейси
  "asos", "zalando", "farfetch", "amazon", "ebay",
  "ssense", "mytheresa", "net-a-porter", "matchesfashion",
  // Офіційні сайти брендів одягу
  "zara.com", "bershka.com", "mango.com", "hm.com", "uniqlo.com",
  "reserved.com", "sinsay.com", "cropp.com", "pullandbear.com",
  "massimodutti.com", "guess.com", "calzedonia.com", "intimissimi.com",
  "mohito.com", "parfois.com", "terranova.com", "lc-waikiki.com",
  "tommy.com", "calvinklein.com", "lacoste.com", "polo.com",
  // Спорт (офіційні)
  "nike.com", "adidas.com", "puma.com", "newbalance.com",
  "reebok.com", "converse.com", "underarmour.com", "asics.com",
  "skechers.com", "vans.com", "timberland.com",
  // Техніка (офіційні)
  "apple.com", "samsung.com", "sony.com", "dyson.com",
  "philips.com", "xiaomi.com", "lg.com",
  // Краса (офіційні + великі мережі)
  "sephora.com", "lookfantastic.com", "douglas.ua",
  "mac-cosmetics.com", "nars.com", "lancome.com", "theordinary.com",
  // Дім / Меблі
  "ikea.com", "leroy-merlin",
  // Спортивні магазини
  "decathlon",
];

// Українські магазини — другий пріоритет
const UA_STORES = [
  "rozetka", "prom.ua", "allo", "epicentrk", "kasta",
  "comfy", "foxtrot", "citrus", "stylus", "brain.com.ua",
  "makeup.com.ua", "makeup", "parfums", "prostor", "brocard",
  "intertop", "answear", "lamoda.ua", "modna", "leboutique",
  "shafa", "maudau", "sportmaster", "intersport",
  "yakaboo", "bodo", "antoshka",
];

/** Ранжування результату: 0 = trusted global, 1 = Ukrainian, 2 = other */
function rankResult(item) {
  const src = (item.source || "").toLowerCase();
  const lnk = (item.link || "").toLowerCase();
  if (TRUSTED_GLOBAL.some((s) => src.includes(s) || lnk.includes(s))) return 0;
  if (UA_STORES.some((s) => src.includes(s) || lnk.includes(s)) || lnk.includes(".ua/")) return 1;
  return 2;
}

async function searchGoogleShopping(query) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY не задан в .env");

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", key);
  url.searchParams.set("hl", "ru");  // мова інтерфейсу
  url.searchParams.set("num", "20"); // беремо 20, фільтруємо найкращі

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const all = data.shopping_results || [];

    // Сортуємо: офіційні сайти → українські → решта
    const ranked = [...all].sort((a, b) => rankResult(a) - rankResult(b));

    // Відфільтровуємо очевидний мотлох (немає назви або джерела)
    const filtered = ranked.filter((r) => r.title && (r.source || r.link));

    return filtered.slice(0, 5);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── Business logic helpers ───────────────────────────────────────────────
async function showOwnerWishes(ctx) {
  const ownerId = String(ctx.from.id);
  const wishes = getWishes().filter(
    (w) => w.ownerId === ownerId && w.status !== "archived"
  );
  if (wishes.length === 0) {
    await ctx.reply("У тебя пока нет хотелок. Добавь первую! ➕");
    return;
  }
  const slice = wishes.slice(-10);
  await ctx.reply(`📋 *Твои хотелки* (${slice.length}):`, { parse_mode: "Markdown" });
  for (const wish of slice) {
    await sendWishCard(ctx, ownerId, wish, undefined, false);
  }
}

async function showPartnerWishes(ctx) {
  const buyerId = String(ctx.from.id);
  const ownerId = getOwnerId(buyerId);
  if (!ownerId) {
    await ctx.reply(
      "Тебя ещё никто не привязал как покупателя 😔\nПопроси партнёра выполнить /bind и ввести твой ID."
    );
    return;
  }
  const wishes = getWishes().filter(
    (w) => w.ownerId === ownerId && w.status !== "archived"
  );
  if (wishes.length === 0) {
    await ctx.reply("У партнёра пока нет активных хотелок 🎉");
    return;
  }
  const slice = wishes.slice(-10);
  await ctx.reply(`💝 *Хотелки партнёра* (${slice.length}):`, { parse_mode: "Markdown" });
  for (const wish of slice) {
    await sendWishCard(ctx, buyerId, wish, getBuyerWishKeyboard(wish.id), true);
  }
}

async function showBuyerHistory(ctx) {
  const buyerId = String(ctx.from.id);
  const ownerId = getOwnerId(buyerId);
  if (!ownerId) {
    await ctx.reply("Тебя ещё никто не привязал как покупателя.");
    return;
  }
  const wishes = getWishes().filter(
    (w) => w.ownerId === ownerId && w.status === "bought"
  );
  if (wishes.length === 0) {
    await ctx.reply("Ещё ничего не куплено. Держись! 💪");
    return;
  }
  const slice = wishes.slice(-10);
  await ctx.reply(`🧾 *Куплено* (${slice.length}):`, { parse_mode: "Markdown" });
  for (const wish of slice) {
    await sendWishCard(ctx, buyerId, wish, undefined, true);
  }
}

async function updateWishStatus(ctx, buyerId, wishId, status) {
  const wishes = getWishes();
  const idx = wishes.findIndex((w) => w.id === wishId);
  if (idx === -1) {
    await ctx.reply("Хотелка не найдена.");
    return;
  }
  wishes[idx].status = status;
  wishes[idx].updatedAt = new Date().toISOString();
  saveWishes(wishes);

  const statusLabel = { bought: "✅ Куплено", planned: "🛒 Планируется", archived: "💤 Отложено" };
  await ctx.reply(
    `${statusLabel[status] ?? status}: *${escMd(wishes[idx].title)}*`,
    { parse_mode: "Markdown" }
  );

  const ownerId = wishes[idx].ownerId;
  const users = getUsers();
  const buyerName = users[buyerId]?.firstName ?? "Покупатель";
  const actionLabel = { bought: "купил(а)", planned: "планирует купить", archived: "отложил(а)" };
  try {
    await bot.api.sendMessage(
      ownerId,
      `💝 *${escMd(buyerName)}* ${actionLabel[status] ?? "обновил(а) статус"} хотелки *${escMd(wishes[idx].title)}*`,
      { parse_mode: "Markdown" }
    );
  } catch {
    // owner may be unreachable
  }
}

/** Finalize and persist a wish from state, notify buyer */
async function finalizeWish(ctx, userId, s) {
  const buyerId = getBuyerId(userId);
  const wish = {
    id: generateId(),
    ownerId: userId,
    buyerId: buyerId ?? null,
    title: s.title ?? "Без названия",
    link: s.link ?? "",
    price: s.price ?? "Не указана",
    photoFileId: s.photoFileId ?? null,
    photoUrl: s.photoUrl ?? null,
    priority: s.priority ?? 2,
    status: "new",
    noteFromBuyer: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const wishes = getWishes();
  wishes.push(wish);
  saveWishes(wishes);
  clearState(userId);

  const gptComment = await gptWishComment(wish.title);
  await ctx.reply(`✅ Хотелка сохранена!\n\n${gptComment}`, {
    reply_markup: getMainKeyboard(userId),
  });

  if (buyerId) {
    const caption = wishCaption(wish, true) + "\n\n✨ *Новая хотелка от партнёра!*";
    const photo = wish.photoFileId || wish.photoUrl;
    try {
      if (photo) {
        await bot.api.sendPhoto(buyerId, photo, {
          caption,
          parse_mode: "Markdown",
          reply_markup: getBuyerWishKeyboard(wish.id),
        });
      } else {
        await bot.api.sendMessage(buyerId, caption, {
          parse_mode: "Markdown",
          reply_markup: getBuyerWishKeyboard(wish.id),
        });
      }
    } catch (e) {
      const errCode = e?.error_code ?? e?.payload?.error_code;
      const errDesc = String(e?.description ?? e?.message ?? "");
      const isBlocked =
        errCode === 403 ||
        errDesc.includes("blocked") ||
        errDesc.includes("bot was blocked");
      if (isBlocked) {
        await ctx.reply(
          "⚠️ Не смог отправить уведомление покупателю.\n" +
            "Пусть он нажмёт /start у бота, чтобы активировать его."
        );
      } else {
        console.error("notify buyer error:", e.message ?? e);
      }
    }
  }
}

// ─── Register bot commands ─────────────────────────────────────────────────
await bot.api.setMyCommands([
  { command: "start", description: "Запуск бота / главное меню" },
  { command: "menu", description: "Показать меню" },
  { command: "myid", description: "Показать мой Telegram ID" },
  { command: "bind", description: "Привязать покупателя" },
  { command: "unbind", description: "Отвязать покупателя" },
  { command: "wishes", description: "Мои хотелки" },
  { command: "partner", description: "Хотелки партнёра" },
  { command: "cancel", description: "Отмена текущего действия" },
  { command: "help", description: "Справка" },
]);

// ─── /start ───────────────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  try {
    ensureUser(ctx);
    clearState(ctx.from.id);
    const name = ctx.from.first_name || "друг";
    await ctx.reply(
      `Привет, *${escMd(name)}*! 💕\n\nЯ — бот-вишлист для вашей пары.\n` +
        `Добавляй хотелки, а партнёр будет знать, что тебе подарить 🎁\n\n` +
        `Используй меню ниже 👇`,
      { parse_mode: "Markdown", reply_markup: getMainKeyboard(ctx.from.id) }
    );
  } catch (e) {
    console.error("/start error:", e);
  }
});

// ─── /menu ────────────────────────────────────────────────────────────────
bot.command("menu", async (ctx) => {
  try {
    ensureUser(ctx);
    await ctx.reply("Главное меню:", { reply_markup: getMainKeyboard(ctx.from.id) });
  } catch (e) {
    console.error("/menu error:", e);
  }
});

// ─── /myid ────────────────────────────────────────────────────────────────
bot.command("myid", async (ctx) => {
  try {
    await ctx.reply(`Твой Telegram ID: \`${ctx.from.id}\``, { parse_mode: "Markdown" });
  } catch (e) {
    console.error("/myid error:", e);
  }
});

// ─── /help ────────────────────────────────────────────────────────────────
bot.command("help", async (ctx) => {
  try {
    await ctx.reply(
      `*Справка — Wishlist для пары 💝*\n\n` +
        `*Для создателя:*\n` +
        `➕ Добавить товар:\n` +
        `  📝 Вручную — фото → название → ссылка → цена → приоритет\n` +
        `  🔗 По ссылке — вставь URL, бот извлечёт данные сам\n` +
        `  🔍 Найти в интернете — опиши товар, бот найдёт варианты\n` +
        `📋 Мои хотелки — список желаний\n\n` +
        `*Для покупателя:*\n` +
        `💝 Что хочет мой партнёр — активные хотелки\n` +
        `🧾 Куплено / История — купленные товары\n\n` +
        `*Команды:*\n` +
        `/myid — узнать свой ID\n` +
        `/bind — привязать покупателя\n` +
        `/unbind — отвязать покупателя\n` +
        `/cancel — отмена текущего действия\n` +
        `/wishes — мои хотелки\n` +
        `/partner — хотелки партнёра`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.error("/help error:", e);
  }
});

// ─── /cancel ──────────────────────────────────────────────────────────────
bot.command("cancel", async (ctx) => {
  try {
    clearState(ctx.from.id);
    await ctx.reply("Действие отменено.", { reply_markup: getMainKeyboard(ctx.from.id) });
  } catch (e) {
    console.error("/cancel error:", e);
  }
});

// ─── /bind ────────────────────────────────────────────────────────────────
bot.command("bind", async (ctx) => {
  try {
    ensureUser(ctx);
    setState(ctx.from.id, { mode: "bind" });
    await ctx.reply(
      "Введи Telegram ID покупателя (только цифры).\n\n" +
        "Чтобы узнать ID — пусть партнёр напишет /myid боту."
    );
  } catch (e) {
    console.error("/bind error:", e);
  }
});

// ─── /unbind ──────────────────────────────────────────────────────────────
bot.command("unbind", async (ctx) => {
  try {
    const ownerId = String(ctx.from.id);
    const bindings = getBindings();
    if (bindings[ownerId]) {
      const oldBuyerId = bindings[ownerId];
      delete bindings[ownerId];
      saveBindings(bindings);
      updateUserRole(ownerId);
      updateUserRole(oldBuyerId);
      await ctx.reply("Покупатель отвязан. 👋", { reply_markup: getMainKeyboard(ctx.from.id) });
    } else {
      await ctx.reply("У тебя нет привязанного покупателя.");
    }
  } catch (e) {
    console.error("/unbind error:", e);
  }
});

// ─── /wishes & /partner ───────────────────────────────────────────────────
bot.command("wishes", async (ctx) => {
  try { await showOwnerWishes(ctx); } catch (e) { console.error("/wishes error:", e); }
});

bot.command("partner", async (ctx) => {
  try { await showPartnerWishes(ctx); } catch (e) { console.error("/partner error:", e); }
});

// ─── Text message handler ─────────────────────────────────────────────────
bot.on("message:text", async (ctx) => {
  try {
    ensureUser(ctx);
    const text = ctx.message.text;
    const userId = String(ctx.from.id);
    const s = getState(userId);

    // ── Reply keyboard buttons ─────────────────────────────────────────
    if (text === "➕ Добавить товар") {
      clearState(userId);
      setState(userId, { mode: "add_method" });
      await ctx.reply("Как добавим хотелку? 🛍️", {
        reply_markup: getAddMethodKeyboard(),
      });
      return;
    }

    if (text === "📋 Мои хотелки") { await showOwnerWishes(ctx); return; }
    if (text === "💝 Что хочет мой партнёр") { await showPartnerWishes(ctx); return; }
    if (text === "🧾 Куплено / История") { await showBuyerHistory(ctx); return; }

    if (text === "🔍 Найти товар") {
      if (!SEARCH_ALLOWED.has(userId)) {
        await ctx.reply("⛔ У вас нет доступа к поиску.");
        return;
      }
      if (!process.env.SERPAPI_KEY) {
        await ctx.reply(
          "⚠️ Поиск недоступен — не задан SERPAPI_KEY в .env\n" +
            "Получи ключ на serpapi.com и добавь в .env: SERPAPI_KEY=..."
        );
        return;
      }
      clearState(userId);
      setState(userId, { mode: "add_search", step: "query" });
      await ctx.reply(
        "🔍 Что ищем? Опиши товар своими словами:\n" +
          "Например: «беспроводные наушники», «крем для рук с лавандой»\n\n/cancel — отмена"
      );
      return;
    }

    if (text === "🎁 Идея подарка") {
      await ctx.reply("🤔 Думаю над идеями...");
      try {
        const idea = await gptGiftIdea(userId);
        await ctx.reply(idea, { reply_markup: getMainKeyboard(userId) });
      } catch (e) {
        console.error("gptGiftIdea error:", e.message);
        await ctx.reply("Не смог придумать идею, попробуй ещё раз 🙈");
      }
      return;
    }

    if (text === "💬 Поболтать") {
      clearState(userId);
      setState(userId, { mode: "talk", chatHistory: [] });
      await ctx.reply("Привет! Поговорим? 💬\nПиши что хочешь, а /cancel выйдет из режима болтовни.");
      return;
    }

    if (text === "⚙️ Настройки") {
      await ctx.reply("Настройки:", { reply_markup: getSettingsKeyboard() });
      return;
    }

    if (text === "🔗 Привязать покупателя") {
      setState(userId, { mode: "bind" });
      await ctx.reply(
        "Введи Telegram ID покупателя (только цифры).\n" +
          "Чтобы узнать ID — пусть партнёр напишет /myid боту."
      );
      return;
    }

    if (text === "🔓 Отвязать покупателя") {
      const bindings = getBindings();
      if (bindings[userId]) {
        const oldBuyerId = bindings[userId];
        delete bindings[userId];
        saveBindings(bindings);
        updateUserRole(userId);
        updateUserRole(oldBuyerId);
        await ctx.reply("Покупатель отвязан. 👋", { reply_markup: getMainKeyboard(userId) });
      } else {
        await ctx.reply("У тебя нет привязанного покупателя.");
      }
      return;
    }

    if (text === "👤 Мой ID") {
      await ctx.reply(`Твой Telegram ID: \`${ctx.from.id}\``, { parse_mode: "Markdown" });
      return;
    }

    if (text === "⬅️ Назад") {
      clearState(userId);
      await ctx.reply("Главное меню:", { reply_markup: getMainKeyboard(userId) });
      return;
    }

    // ── State: bind ──────────────────────────────────────────────────────
    if (s.mode === "bind") {
      const input = text.trim();
      if (!/^\d+$/.test(input)) {
        await ctx.reply("ID должен содержать только цифры. Попробуй ещё раз.\n(или /cancel)");
        return;
      }
      if (input === userId) {
        await ctx.reply("Нельзя привязать самого себя 😄");
        return;
      }
      const bindings = getBindings();
      bindings[userId] = input;
      saveBindings(bindings);
      updateUserRole(userId);
      updateUserRole(input);
      clearState(userId);

      await ctx.reply(
        `Покупатель привязан! 🎉\nID: \`${input}\`\n\nТеперь он будет получать уведомления о новых хотелках.`,
        { parse_mode: "Markdown", reply_markup: getMainKeyboard(userId) }
      );

      const users = getUsers();
      const ownerName = users[userId]?.firstName ?? "Партнёр";
      try {
        await bot.api.sendMessage(
          input,
          `💝 *${escMd(ownerName)}* привязал(а) тебя как покупателя!\n\n` +
            `Теперь ты будешь получать уведомления о новых хотелках.\n` +
            `Нажми /menu чтобы увидеть обновлённое меню.`,
          { parse_mode: "Markdown", reply_markup: getMainKeyboard(input) }
        );
      } catch { /* buyer hasn't started bot yet */ }
      return;
    }

    // ── State: add (manual flow) ─────────────────────────────────────────
    if (s.mode === "add") {
      if (s.step === "photo") {
        await ctx.reply("Сначала отправь фото 📸\n(или /cancel)");
        return;
      }
      if (s.step === "title") {
        const title = text.trim();
        if (!title) { await ctx.reply("Название не может быть пустым. Введи ещё раз:"); return; }
        setState(userId, { title, step: "link" });
        await ctx.reply("Отлично! Теперь отправь ссылку на товар.\n(или напиши «нет» если ссылки нет)");
        return;
      }
      if (s.step === "link") {
        let link = text.trim();
        const skip = ["нет", "no", "-"].includes(link.toLowerCase());
        if (!skip) {
          const hasProto = /^https?:\/\//i.test(link);
          const hasDomain = /\.\w{2,}/i.test(link);
          if (!hasProto && !hasDomain) {
            await ctx.reply("Ссылка выглядит неправильно. Введи URL или напиши «нет»:");
            return;
          }
          if (!hasProto) link = "https://" + link;
        } else {
          link = "";
        }
        setState(userId, { link, step: "price" });
        await ctx.reply("Сколько стоит? (1500₽, $50, ~2000, «не знаю»):");
        return;
      }
      if (s.step === "price") {
        setState(userId, { price: text.trim() || "Не указана", step: "priority" });
        await ctx.reply("Выбери приоритет:", { reply_markup: getPriorityKeyboard() });
        return;
      }
      // confirm/other steps — ignore text, wait for callback
      return;
    }

    // ── State: add_link ───────────────────────────────────────────────────
    if (s.mode === "add_link") {
      if (s.step === "url") {
        let url = text.trim();
        if (!url.startsWith("http")) url = "https://" + url;
        await ctx.reply("⏳ Загружаю страницу и ищу товар...");
        try {
          const product = await fetchProductData(url);
          if (!product || !product.title || !product.image) {
            await ctx.reply(
              "😔 Не удалось распознать товар по этой ссылке.\n" +
                "Попробуй другую ссылку или добавь вручную.",
              { reply_markup: getAddMethodKeyboard() }
            );
            clearState(userId);
            setState(userId, { mode: "add_method" });
            return;
          }
          setState(userId, {
            mode: "add",
            step: "confirm",
            title: product.title,
            price: product.price || "Не указана",
            link: product.link || url,
            photoUrl: product.image,
            photoFileId: null,
            priority: 2,
          });
          await sendConfirmPreview(ctx, getState(userId));
        } catch (e) {
          console.error("fetchProductData error:", e.message);
          await ctx.reply(
            "⚠️ Не смог загрузить страницу. Проверь ссылку или добавь товар вручную.\n/cancel — отмена",
          );
        }
        return;
      }
    }

    // ── State: add_search ─────────────────────────────────────────────────
    if (s.mode === "add_search") {
      if (s.step === "query") {
        const query = text.trim();

        // Якщо введено посилання — завантажуємо товар одразу (без пошуку)
        const isUrl =
          /^https?:\/\//i.test(query) ||
          (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(query) && !query.includes(" "));
        if (isUrl) {
          let url = query;
          if (!/^https?:\/\//i.test(url)) url = "https://" + url;
          await ctx.reply("⏳ Завантажую сторінку, шукаю товар...");
          try {
            const product = await fetchProductData(url);
            if (!product || !product.title) {
              await ctx.reply(
                "😔 Не вдалося розпізнати товар за цим посиланням.\nСпробуй інше або добавь вручну.",
                { reply_markup: getAddMethodKeyboard() }
              );
              clearState(userId);
              setState(userId, { mode: "add_method" });
              return;
            }
            setState(userId, {
              mode: "add",
              step: "confirm",
              title: product.title,
              price: product.price || "Не вказана",
              link: product.link || url,
              photoUrl: product.image,
              photoFileId: null,
              priority: 2,
            });
            await sendConfirmPreview(ctx, getState(userId));
          } catch (e) {
            console.error("fetchProductData error:", e.message);
            await ctx.reply(
              "⚠️ Не вдалося завантажити сторінку. Перевір посилання або добавь товар вручну.\n/cancel — скасувати"
            );
          }
          return;
        }

        await ctx.reply("🔍 Ищу товары, подожди секунду...");
        try {
          const { query: searchQ } = await gptBuildSearchQuery(query);
          const results = await searchGoogleShopping(searchQ);

          if (!results || results.length === 0) {
            await ctx.reply(
              "😔 По этому запросу ничего не нашлось. Попробуй другие слова или добавь вручную.",
              { reply_markup: getAddMethodKeyboard() }
            );
            clearState(userId);
            setState(userId, { mode: "add_method" });
            return;
          }

          setState(userId, { mode: "add_search", step: "results", searchResults: results });
          await ctx.reply(`Нашёл ${results.length} вариант(а) по запросу «${searchQ}»:`);

          for (let i = 0; i < results.length; i++) {
            const item = results[i];
            const caption =
              `*${escMd(item.title || "Товар")}*\n` +
              `💰 ${escMd(item.price || "Цена не указана")}\n` +
              `🏪 ${escMd(item.source || "")}\n` +
              (item.link ? `🔗 [Страница товара](${item.link})` : "");
            const kb = new InlineKeyboard().text("✅ Добавить в хотелки", `pick:${i}`);

            if (item.thumbnail) {
              try {
                await ctx.replyWithPhoto(item.thumbnail, {
                  caption,
                  parse_mode: "Markdown",
                  reply_markup: kb,
                });
                continue;
              } catch { /* fall through */ }
            }
            await ctx.reply(caption, { parse_mode: "Markdown", reply_markup: kb });
          }
        } catch (e) {
          console.error("search error:", e.message);
          const msg = e.message?.includes("SERPAPI_KEY")
            ? "⚠️ SerpAPI ключ не настроен. Добавь SERPAPI_KEY в .env"
            : `⚠️ Ошибка поиска: ${e.message}\nПопробуй ещё раз или добавь вручную.`;
          await ctx.reply(msg, { reply_markup: getMainKeyboard(userId) });
          clearState(userId);
        }
        return;
      }
    }

    // ── State: note ──────────────────────────────────────────────────────
    if (s.mode === "note" && s.wishId) {
      const note = text.trim();
      if (!note) { await ctx.reply("Заметка не может быть пустой. Напиши что-нибудь:"); return; }
      const wishes = getWishes();
      const idx = wishes.findIndex((w) => w.id === s.wishId);
      if (idx === -1) {
        await ctx.reply("Хотелка не найдена.");
        clearState(userId);
        return;
      }
      wishes[idx].noteFromBuyer = note;
      wishes[idx].updatedAt = new Date().toISOString();
      saveWishes(wishes);
      clearState(userId);

      await ctx.reply("Заметка сохранена! 📝", { reply_markup: getMainKeyboard(userId) });

      const ownerId = wishes[idx].ownerId;
      const users = getUsers();
      const buyerName = users[userId]?.firstName ?? "Покупатель";
      try {
        await bot.api.sendMessage(
          ownerId,
          `📝 *${escMd(buyerName)}* оставил(а) заметку к хотелке *${escMd(wishes[idx].title)}*:\n_${escMd(note)}_`,
          { parse_mode: "Markdown" }
        );
      } catch { /* owner may be unreachable */ }
      return;
    }

    // ── State: talk ──────────────────────────────────────────────────────
    if (s.mode === "talk") {
      const reply = await gptTalk(userId, text);
      await ctx.reply(reply);
      return;
    }

    // ── Default ───────────────────────────────────────────────────────────
    await ctx.reply("Используй меню 👇", { reply_markup: getMainKeyboard(userId) });
  } catch (e) {
    console.error("message:text error:", e);
    try { await ctx.reply("Что-то пошло не так. Попробуй ещё раз или /cancel"); } catch {}
  }
});

// ─── Photo handler ────────────────────────────────────────────────────────
bot.on("message:photo", async (ctx) => {
  try {
    ensureUser(ctx);
    const userId = String(ctx.from.id);
    const s = getState(userId);

    if (s.mode === "add" && s.step === "photo") {
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      setState(userId, { photoFileId: best.file_id, photoUrl: null, step: "title" });
      await ctx.reply("Отлично! Теперь напиши название товара:");
      return;
    }

    await ctx.reply("Фото получено, но сейчас я его не ожидаю.\nИспользуй меню 👇", {
      reply_markup: getMainKeyboard(userId),
    });
  } catch (e) {
    console.error("message:photo error:", e);
  }
});

// ─── Callback query handler ───────────────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  // ALWAYS answer callback query first
  await ctx.answerCallbackQuery();

  try {
    const userId = String(ctx.from.id);
    const data = ctx.callbackQuery.data;
    const s = getState(userId);

    // ── Add method selection ───────────────────────────────────────────
    if (data === "add_method:manual") {
      clearState(userId);
      setState(userId, { mode: "add", step: "photo" });
      await ctx.reply("Отправь фото товара 📸\n(или /cancel для отмены)");
      return;
    }

    if (data === "add_method:link") {
      clearState(userId);
      setState(userId, { mode: "add_link", step: "url" });
      await ctx.reply(
        "Отправь ссылку на товар 🔗\n" +
          "Например: https://www.ozon.ru/product/...\n(или /cancel для отмены)"
      );
      return;
    }

    if (data === "add_method:search") {
      if (!SEARCH_ALLOWED.has(userId)) {
        await ctx.answerCallbackQuery("⛔ У вас нет доступа к поиску.");
        return;
      }
      if (!process.env.SERPAPI_KEY) {
        await ctx.reply(
          "⚠️ Поиск в интернете недоступен — не задан SERPAPI_KEY в .env\n\n" +
            "Получи ключ на serpapi.com и добавь в .env:\nSERPAPI_KEY=твой_ключ"
        );
        return;
      }
      clearState(userId);
      setState(userId, { mode: "add_search", step: "query" });
      await ctx.reply(
        "🔍 Что ищем? Опиши товар своими словами:\n" +
          "Например: «беспроводные наушники для спорта», «крем для рук с лавандой»\n(или /cancel)"
      );
      return;
    }

    // ── Priority selection ─────────────────────────────────────────────
    if (/^priority_[123]$/.test(data)) {
      if (s.mode !== "add" || s.step !== "priority") return;
      const priority = parseInt(data.split("_")[1]);
      setState(userId, { priority, step: "confirm" });
      await sendConfirmPreview(ctx, getState(userId));
      return;
    }

    // ── Confirm add ───────────────────────────────────────────────────
    if (data === "confirm_add") {
      if (s.mode !== "add") return;
      await finalizeWish(ctx, userId, s);
      return;
    }

    // ── Edit add (restart from title, keep photo) ─────────────────────
    if (data === "edit_add") {
      setState(userId, { mode: "add", step: "title" });
      await ctx.reply("Хорошо, отредактируем! Введи название товара заново:");
      return;
    }

    // ── Cancel add ─────────────────────────────────────────────────────
    if (data === "cancel_add") {
      clearState(userId);
      await ctx.reply("Добавление отменено.", { reply_markup: getMainKeyboard(userId) });
      return;
    }

    // ── Search: pick result ────────────────────────────────────────────
    if (data.startsWith("pick:")) {
      const idx = parseInt(data.split(":")[1]);
      const results = s.searchResults;

      if (!Array.isArray(results) || idx < 0 || idx >= results.length) {
        await ctx.reply("Не смог найти выбранный товар. Попробуй поиск ещё раз.");
        return;
      }

      const item = results[idx];
      setState(userId, {
        mode: "add",
        step: "confirm",
        title: item.title || "Товар",
        price: item.price || "Не указана",
        link: item.link || item.product_link || "",
        photoUrl: item.thumbnail || null,
        photoFileId: null,
        priority: 2,
      });

      await ctx.reply("Отлично! Вот карточка товара:");
      await sendConfirmPreview(ctx, getState(userId));
      return;
    }

    // ── Buyer: mark status ─────────────────────────────────────────────
    if (data.startsWith("mark_bought:")) {
      await updateWishStatus(ctx, userId, data.split(":")[1], "bought");
      return;
    }
    if (data.startsWith("mark_planned:")) {
      await updateWishStatus(ctx, userId, data.split(":")[1], "planned");
      return;
    }
    if (data.startsWith("mark_archived:")) {
      await updateWishStatus(ctx, userId, data.split(":")[1], "archived");
      return;
    }

    // ── Buyer: note ────────────────────────────────────────────────────
    if (data.startsWith("note:")) {
      setState(userId, { mode: "note", wishId: data.split(":")[1] });
      await ctx.reply("Напиши заметку для этой хотелки:\n(или /cancel для отмены)");
      return;
    }
  } catch (e) {
    console.error("callback_query error:", e);
    try { await ctx.reply("Ошибка при обработке кнопки. Попробуй ещё раз или /cancel"); } catch {}
  }
});

// ─── Global error handler ────────────────────────────────────────────────
bot.catch((err) => {
  console.error("=== BOT ERROR ===");
  console.error("Inner error:", err.error);
  if (err.ctx?.update) {
    console.error("Update:", JSON.stringify(err.ctx.update, null, 2));
  }
});

// ─── Start ────────────────────────────────────────────────────────────────
console.log("🤖 Wishlist bot starting...");
bot.start({
  onStart: (info) => console.log(`Bot @${info.username} is running!`),
});
