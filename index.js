import "dotenv/config";
import { Bot, InlineKeyboard, Keyboard, InputFile } from "grammy";
import { existsSync } from "fs";
import { createReadStream } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
import OpenAI from "openai";
import crypto from "crypto";
import { connectDB } from "./src/db/connection.js";
import User from "./src/models/User.js";
import Wish from "./src/models/Wish.js";
import Binding from "./src/models/Binding.js";
import SavedButton from "./src/models/SavedButton.js";
import Review from "./src/models/Review.js";
import { t, detectLang } from "./src/i18n/index.js";

// ─── OpenAI ───────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Bot ──────────────────────────────────────────────────────────────────
const bot = new Bot(process.env.BOT_TOKEN);

// ─── Constants ────────────────────────────────────────────────────────────
const ADMIN_ID = "458227557";
const SEARCH_ALLOWED = new Set(["458227557", "739105994"]);
const HOLIDAYS = ["birthday", "march8", "newyear", "valentine"];
let BOT_USERNAME = "";

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

// ─── Language helpers ─────────────────────────────────────────────────────
function getLang(userId) {
  return getState(String(userId)).lang ?? "ru";
}

async function fetchUserLang(userId) {
  const user = await User.findOne({ userId: String(userId) });
  return user?.lang ?? "ru";
}

// ─── User helpers ─────────────────────────────────────────────────────────
async function ensureUser(ctx) {
  const userId = String(ctx.from.id);
  // If lang already loaded this session — skip DB call
  if (getState(userId).lang) {
    User.updateOne({ userId }, { $set: { firstName: ctx.from.first_name || "Unknown" } }).catch(() => {});
    return;
  }
  const firstName = ctx.from.first_name || "Unknown";
  const autoLang = detectLang(ctx.from.language_code);
  const doc = await User.findOneAndUpdate(
    { userId },
    {
      $set: { firstName },
      $setOnInsert: {
        lang: autoLang,  // auto-detect only for brand-new users
        langSet: false,
        role: "owner",
        partnerIds: [],
        createdAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );
  // Use saved lang for existing users; auto-detect only for new users (via $setOnInsert)
  const lang = doc.lang ?? autoLang;
  setState(userId, { lang });
}

async function updateUserRole(userId) {
  const uid = String(userId);
  const hasAssignedBuyer = await Binding.exists({ ownerId: uid });
  const isBuyer = await Binding.exists({ viewerId: uid });
  let role = "owner";
  if (hasAssignedBuyer && isBuyer) role = "both";
  else if (isBuyer) role = "buyer";
  await User.updateOne({ userId: uid }, { role });
}

async function getBuyerId(ownerId) {
  const binding = await Binding.findOne({ ownerId: String(ownerId) });
  return binding?.viewerId ?? null;
}

async function getOwnerId(buyerId) {
  const binding = await Binding.findOne({ viewerId: String(buyerId) });
  return binding?.ownerId ?? null;
}

async function isBuyerUser(userId) {
  return (await Binding.exists({ viewerId: String(userId) })) !== null;
}

// ─── Keyboards ───────────────────────────────────────────────────────────
async function getMainKeyboard(userId) {
  const lang = getLang(userId);
  const buyer = await isBuyerUser(String(userId));
  const rows = [
    [t(lang, "btn.addProduct"), t(lang, "btn.findProduct")],
    [t(lang, "btn.myWishes"), t(lang, "btn.giftIdea")],
  ];
  if (buyer) rows.push([t(lang, "btn.partnerWishes"), t(lang, "btn.history")]);
  rows.push([t(lang, "btn.myPledges")]);
  rows.push([t(lang, "btn.moreMenu")]);
  return Keyboard.from(rows).resized();
}

function getSecondaryKeyboard(userId) {
  const lang = getLang(String(userId));
  const rows = [
    [t(lang, "btn.holidays")],
    [t(lang, "btn.chat"), t(lang, "btn.settings")],
    [t(lang, "btn.langSettings"), t(lang, "btn.donate")],
    [t(lang, "btn.mainMenu")],
  ];
  if (String(userId) === ADMIN_ID) rows.push([t(lang, "btn.admin")]);
  return Keyboard.from(rows).resized();
}

function getSettingsKeyboard(lang, notifsEnabled = false, pledgeNotifsEnabled = true) {
  const notifsBtn = notifsEnabled ? t(lang, "btn.notifsOn") : t(lang, "btn.notifsOff");
  const pledgeBtn = pledgeNotifsEnabled ? t(lang, "btn.pledgeNotifsOn") : t(lang, "btn.pledgeNotifsOff");
  return Keyboard.from([
    [t(lang, "btn.bindBuyer"), t(lang, "btn.unbindBuyer")],
    [t(lang, "btn.myId"), t(lang, "btn.langSettings")],
    [notifsBtn],
    [pledgeBtn],
    [t(lang, "btn.back")],
  ]).resized();
}

function getLangKeyboard() {
  return new InlineKeyboard()
    .text("🇷🇺 Русский", "setlang:ru")
    .text("🇺🇦 Українська", "setlang:uk")
    .text("🇬🇧 English", "setlang:en");
}

function getAdminKeyboard(lang) {
  return Keyboard.from([
    [t(lang, "btn.broadcast"), t(lang, "btn.stats")],
    [t(lang, "btn.donateBroadcast"), t(lang, "btn.savedButtons")],
    [t(lang, "btn.reviewBroadcast"), t(lang, "btn.adminReviews")],
    [t(lang, "btn.back")],
  ]).resized();
}

// Build inline keyboard from SavedButton array
function buildSavedButtonsInline(buttons) {
  const kb = new InlineKeyboard();
  for (const btn of buttons) {
    kb.url(btn.label, btn.url).row();
  }
  return kb;
}

// AI button generation
async function generateButtonViaAI(description) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "You are a Telegram bot button designer. The user describes a button they want. Return ONLY a valid JSON object with exactly two fields: \"label\" (button text with a relevant emoji, max 30 chars) and \"url\" (full https URL). No markdown, no explanation — just raw JSON.",
      },
      { role: "user", content: description },
    ],
    temperature: 0.4,
    max_tokens: 100,
  });
  const raw = resp.choices[0].message.content.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response");
  const parsed = JSON.parse(match[0]);
  if (!parsed.label || !parsed.url || !parsed.url.startsWith("http")) throw new Error("Invalid fields");
  return parsed;
}

function getAddMethodKeyboard(lang) {
  return new InlineKeyboard()
    .text(t(lang, "ibtn.addManual"), "add_method:manual")
    .row()
    .text(t(lang, "ibtn.addByLink"), "add_method:link")
    .row()
    .text(t(lang, "ibtn.addBySearch"), "add_method:search");
}

function getPriorityKeyboard(lang) {
  return new InlineKeyboard()
    .text(t(lang, "ibtn.priority1"), "priority_1")
    .text(t(lang, "ibtn.priority2"), "priority_2")
    .text(t(lang, "ibtn.priority3"), "priority_3");
}

function getConfirmKeyboard(lang) {
  return new InlineKeyboard()
    .text(t(lang, "ibtn.confirmAdd"), "confirm_add")
    .text(t(lang, "ibtn.editAdd"), "edit_add")
    .row()
    .text(t(lang, "ibtn.cancelAdd"), "cancel_add");
}

function getHolidayName(lang, holiday) {
  return t(lang, `holiday.name.${holiday}`);
}

function getHolidaySelectionKeyboard(lang) {
  return new InlineKeyboard()
    .text(t(lang, "btn.holiday.birthday"),  "hw:page:birthday").row()
    .text(t(lang, "btn.holiday.march8"),    "hw:page:march8").row()
    .text(t(lang, "btn.holiday.newyear"),   "hw:page:newyear").row()
    .text(t(lang, "btn.holiday.valentine"), "hw:page:valentine");
}

function getHolidayPageKeyboard(lang, holiday) {
  return new InlineKeyboard()
    .text(t(lang, "ibtn.holiday.view"),  `hw:view:${holiday}`).row()
    .text(t(lang, "ibtn.holiday.add"),   `hw:add:${holiday}`).row()
    .text(t(lang, "ibtn.holiday.share"), `hw:share:${holiday}`).row()
    .text(t(lang, "ibtn.holiday.back"),  "hw:menu");
}

function getAddMoreKeyboard(lang, holiday) {
  return new InlineKeyboard()
    .text(t(lang, "ibtn.holiday.addMore"), `hw:more:${holiday}`).row()
    .text(t(lang, "ibtn.holiday.done"),    `hw:done:${holiday}`);
}

function getHolidayWishGuestKeyboard(wish, viewerId, lang) {
  const kb = new InlineKeyboard();
  if (wish.pledgedBy === viewerId) {
    kb.text(t(lang, "ibtn.unpledge"), `unpledge:${wish.id}`).row();
  } else if (wish.pledgedBy) {
    kb.text(t(lang, "ibtn.pledgeTaken"), `pledge_confirm:${wish.id}`).row();
  } else {
    kb.text(t(lang, "ibtn.pledge"), `pledge:${wish.id}`).row();
  }
  kb.text(t(lang, "ibtn.hwCopy"), `hwcopy:${wish.id}`);
  return kb;
}

function getBuyerWishKeyboard(wishId, lang) {
  return new InlineKeyboard()
    .text(t(lang, "ibtn.markBought"), `mark_bought:${wishId}`)
    .text(t(lang, "ibtn.markPlanned"), `mark_planned:${wishId}`)
    .row()
    .text(t(lang, "ibtn.markArchived"), `mark_archived:${wishId}`)
    .text(t(lang, "ibtn.addNote"), `note:${wishId}`);
}

// ─── Caption builder ──────────────────────────────────────────────────────
function wishCaption(wish, lang, forBuyer = false) {
  const stars = "⭐".repeat(wish.priority || 1);
  const statusMap = {
    new:      t(lang, "status.new"),
    planned:  t(lang, "status.planned"),
    bought:   t(lang, "status.bought"),
    archived: t(lang, "status.archived"),
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

// ─── Send wish card helper ────────────────────────────────────────────────
async function sendWishCard(target, chatId, wish, keyboard, lang, forBuyer = false) {
  const caption = wishCaption(wish, lang, forBuyer);
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
async function sendConfirmPreview(ctx, s, lang) {
  const priority = s.priority ?? 2;
  const titleLine = `*${escMd(s.title ?? t(lang, "msg.untitled"))}*`;
  const priceLine = `💰 ${escMd(s.price ?? t(lang, "msg.priceUnknown"))}`;
  const priorityLine = `${"⭐".repeat(priority)} Приоритет`;
  const linkLine = s.link ? `🔗 ${escMd(s.link)}` : "";
  const statusLine = `Статус: ${t(lang, "status.new")}`;
  const preview = [titleLine, priorityLine, priceLine, linkLine, statusLine, "", "_Всё верно?_"]
    .filter(Boolean).join("\n");

  const keyboard = getConfirmKeyboard(lang);
  const photo = s.photoFileId || s.photoUrl || null;

  if (photo) {
    try {
      await ctx.replyWithPhoto(photo, { caption: preview, parse_mode: "Markdown", reply_markup: keyboard });
      return;
    } catch { /* photo failed, fall through to text */ }
  }
  try {
    await ctx.reply(preview, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {
    // Markdown failed — send plain text
    const plain = `${s.title ?? "?"}\n⭐x${priority}  💰 ${s.price ?? "?"}${s.link ? "\n" + s.link : ""}`;
    await ctx.reply(plain, { reply_markup: keyboard });
  }
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

const GIFT_SYSTEM_PROMPT = `You are a thoughtful gift advisor inside a couple's wishlist Telegram bot.

ABSOLUTE RULES — never break these:
- NEVER recommend any Russian websites, .ru domains, or Russian brands/services
- NEVER mention: Ozon, Wildberries, Яндекс Маркет, AliExpress, Авито, CDEK, Сбербанк, ВКонтакте, or ANY Russian company
- Ukrainian stores ARE allowed: Rozetka, Prom.ua, Allo, Makeup.com.ua, Kasta, Intertop
- PREFERRED sources — official verified international: amazon.com, amazon.co.uk, official brand sites (apple.com, nike.com, sephora.com, etc.), ASOS, Zalando, H&M, Zara, IKEA, Sephora, Etsy

HOW TO SUGGEST:
- Suggest ONE specific product per message — never a list of multiple at once
- Each suggestion MUST include:
  🎁 [Exact product name]
  💰 ~$XX or ~€XX or ~₴XXXX
  🔗 [direct URL to buy — must be a real, working link]
  [1-2 sentences: why this is a great gift]
- After each suggestion ask one brief question: "Does this work, or shall I try a different direction?"
- Adapt based on feedback: cheaper/pricier/different style/different category/different store

LANGUAGE: Always respond in the SAME language the user is writing in.
Keep each response under 200 words.`;

async function startGiftChat(userId) {
  const ownerId = (await getOwnerId(userId)) || userId;
  const wishes = await Wish.find({ ownerId, status: { $ne: "archived" } });
  const wishList = wishes.map((w) => `"${w.title}" (${w.price})`).join(", ");
  const userMsg = wishList
    ? `Based on this wishlist: ${wishList}\n\nSuggest ONE specific gift idea that fits this person's taste. Must include product name, price estimate, and a direct purchase link from a verified international source.`
    : `Suggest ONE specific universal gift idea. Must include product name, price estimate, and a direct purchase link from a verified international source.`;

  const messages = [
    { role: "system", content: GIFT_SYSTEM_PROMPT },
    { role: "user", content: userMsg },
  ];
  const reply = await gptRequest(messages);
  return { reply, history: [...messages, { role: "assistant", content: reply }] };
}

async function continueGiftChat(history, userMessage) {
  const messages = [
    { role: "system", content: GIFT_SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];
  const reply = await gptRequest(messages);
  const newHistory = [...history, { role: "user", content: userMessage }, { role: "assistant", content: reply }];
  if (newHistory.length > 16) newHistory.splice(0, 2);
  return { reply, history: newHistory };
}

async function extractGiftProduct(aiMessage) {
  const raw = await gptRequest([
    {
      role: "system",
      content: 'Extract the gift suggestion from this message. Return ONLY valid JSON (no markdown): {"title":"product name","url":"https://...","price":"~$XX"}. If no clear URL, use empty string for url.',
    },
    { role: "user", content: aiMessage },
  ]);
  try {
    const match = raw.match(/\{[\s\S]*?\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch { return null; }
}

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

// ─── Scraper ──────────────────────────────────────────────────────────────
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
    const fast = parseProductFromHtml(html, url);
    if (fast && fast.title && fast.image) return fast;
    return await gptExtractProduct(html, url);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function parseProductFromHtml(html, sourceUrl) {
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
    } catch { /* skip */ }
  }

  const nextDataM = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataM) {
    try {
      const nd = JSON.parse(nextDataM[1]);
      const product = findProductInObj(nd, 0);
      if (product) return { ...product, link: sourceUrl, source: "nextdata" };
    } catch { /* skip */ }
  }

  const ogTitle = ogMeta(html, "og:title") || htmlTitle(html);
  const ogImage = ogMeta(html, "og:image");
  const ogPrice =
    ogMeta(html, "product:price:amount") ||
    ogMeta(html, "og:price:amount") ||
    ogMeta(html, "product:price");

  if (ogTitle && ogImage) {
    return { title: ogTitle, image: ogImage, price: ogPrice, link: sourceUrl, source: "og" };
  }

  const title = htmlTitle(html);
  const imgM = html.match(/<img[^>]+src=["']([^"']{10,})["'][^>]*/i);
  if (imgM) {
    let img = imgM[1];
    if (!img.startsWith("http")) {
      try { img = new URL(img, sourceUrl).href; } catch { img = null; }
    }
    if (title && img) return { title, image: img, price: null, link: sourceUrl, source: "fallback" };
  }
  return null;
}

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
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const el of val) { const r = findProductInLd(el); if (r) return r; }
    } else if (val && typeof val === "object") {
      const r = findProductInLd(val); if (r) return r;
    }
  }
  return null;
}

function findProductInObj(obj, depth) {
  if (depth > 6 || !obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);
  const hasName  = keys.some((k) => k === "name" || k === "title" || k === "productName");
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
      for (const el of val) { const r = findProductInObj(el, depth + 1); if (r) return r; }
    } else if (val && typeof val === "object") {
      const r = findProductInObj(val, depth + 1); if (r) return r;
    }
  }
  return null;
}

function extractRelevantHtml(html) {
  const parts = [];
  const titleM = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  if (titleM) parts.push(titleM[0]);
  const metas = [...html.matchAll(/<meta[^>]+>/gi)].map((m) => m[0]);
  parts.push(...metas.slice(0, 30));
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi)) {
    parts.push(m[0].slice(0, 2000));
  }
  const nd = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>[\s\S]{0,6000}/i);
  if (nd) parts.push(nd[0]);
  return parts.join("\n").slice(0, 8000);
}

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
          "Якщо поле не знайдено — null.",
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
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${prop}["']`, "i"),
  ];
  for (const re of patterns) { const m = html.match(re); if (m) return m[1].trim(); }
  return null;
}

function htmlTitle(html) {
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return m ? m[1].trim() : null;
}

// ─── SerpAPI ──────────────────────────────────────────────────────────────
const TRUSTED_GLOBAL = [
  "asos", "zalando", "farfetch", "amazon", "ebay", "ssense", "mytheresa",
  "net-a-porter", "matchesfashion", "zara.com", "bershka.com", "mango.com",
  "hm.com", "uniqlo.com", "reserved.com", "sinsay.com", "cropp.com",
  "pullandbear.com", "massimodutti.com", "guess.com", "calzedonia.com",
  "intimissimi.com", "mohito.com", "parfois.com", "terranova.com",
  "lc-waikiki.com", "tommy.com", "calvinklein.com", "lacoste.com", "polo.com",
  "nike.com", "adidas.com", "puma.com", "newbalance.com", "reebok.com",
  "converse.com", "underarmour.com", "asics.com", "skechers.com", "vans.com",
  "timberland.com", "apple.com", "samsung.com", "sony.com", "dyson.com",
  "philips.com", "xiaomi.com", "lg.com", "sephora.com", "lookfantastic.com",
  "douglas.ua", "mac-cosmetics.com", "nars.com", "lancome.com",
  "theordinary.com", "ikea.com", "leroy-merlin", "decathlon",
];
const UA_STORES = [
  "rozetka", "prom.ua", "allo", "epicentrk", "kasta", "comfy", "foxtrot",
  "citrus", "stylus", "brain.com.ua", "makeup.com.ua", "makeup", "parfums",
  "prostor", "brocard", "intertop", "answear", "lamoda.ua", "modna",
  "leboutique", "shafa", "maudau", "sportmaster", "intersport", "yakaboo",
  "bodo", "antoshka",
];

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
  url.searchParams.set("hl", "ru");
  url.searchParams.set("num", "20");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const all = data.shopping_results || [];
    const ranked = [...all].sort((a, b) => rankResult(a) - rankResult(b));
    return ranked.filter((r) => r.title && (r.source || r.link)).slice(0, 5);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── Business logic ───────────────────────────────────────────────────────
async function showOwnerWishes(ctx, lang) {
  const ownerId = String(ctx.from.id);
  const wishes = await Wish.find({ ownerId, status: { $ne: "archived" } }).sort({ createdAt: 1 });
  if (wishes.length === 0) {
    await ctx.reply(t(lang, "msg.noWishes"));
    return;
  }
  const slice = wishes.slice(-10);
  await ctx.reply(t(lang, "msg.myWishesHeader", { count: slice.length }), { parse_mode: "Markdown" });
  for (const wish of slice) await sendWishCard(ctx, ownerId, wish, undefined, lang, false);
}

async function showPartnerWishes(ctx, lang) {
  const buyerId = String(ctx.from.id);
  const ownerId = await getOwnerId(buyerId);
  if (!ownerId) {
    await ctx.reply(t(lang, "msg.notBoundAsBuyer"));
    return;
  }
  const wishes = await Wish.find({ ownerId, status: { $ne: "archived" } }).sort({ createdAt: 1 });
  if (wishes.length === 0) {
    await ctx.reply(t(lang, "msg.noPartnerWishes"));
    return;
  }
  const slice = wishes.slice(-10);
  await ctx.reply(t(lang, "msg.partnerWishesHeader", { count: slice.length }), { parse_mode: "Markdown" });
  for (const wish of slice) await sendWishCard(ctx, buyerId, wish, getBuyerWishKeyboard(wish.id, lang), lang, true);
}

async function showBuyerHistory(ctx, lang) {
  const buyerId = String(ctx.from.id);
  const ownerId = await getOwnerId(buyerId);
  if (!ownerId) {
    await ctx.reply(t(lang, "msg.notBoundSimple"));
    return;
  }
  const wishes = await Wish.find({ ownerId, status: "bought" }).sort({ updatedAt: -1 });
  if (wishes.length === 0) {
    await ctx.reply(t(lang, "msg.noBought"));
    return;
  }
  const slice = wishes.slice(0, 10);
  await ctx.reply(t(lang, "msg.boughtHeader", { count: slice.length }), { parse_mode: "Markdown" });
  for (const wish of slice) await sendWishCard(ctx, buyerId, wish, undefined, lang, true);
}

async function updateWishStatus(ctx, buyerId, wishId, status, lang) {
  const wish = await Wish.findOneAndUpdate(
    { id: wishId },
    { status, updatedAt: new Date() },
    { new: true }
  );
  if (!wish) { await ctx.reply(t(lang, "msg.wishNotFound")); return; }

  const statusLabel = {
    bought:   t(lang, "status.bought"),
    planned:  t(lang, "status.planned"),
    archived: t(lang, "status.archived"),
  };
  await ctx.reply(
    `${statusLabel[status] ?? status}: *${escMd(wish.title)}*`,
    { parse_mode: "Markdown" }
  );

  const buyer = await User.findOne({ userId: buyerId });
  const buyerName = buyer?.firstName ?? "Покупатель";
  const owner = await User.findOne({ userId: wish.ownerId });
  if (owner?.receiveGiftNotifs) {
    const ownerLang = owner.lang ?? "ru";
    try {
      await bot.api.sendMessage(
        wish.ownerId,
        t(ownerLang, "msg.buyerAction", {
          buyerName: escMd(buyerName),
          action: t(ownerLang, `action.${status}`),
          title: escMd(wish.title),
        }),
        { parse_mode: "Markdown" }
      );
    } catch { /* owner may be unreachable */ }
  }
}

async function finalizeWish(ctx, userId, s, lang, opts = {}) {
  const buyerId = await getBuyerId(userId);
  const wish = new Wish({
    id: generateId(),
    ownerId: userId,
    buyerId: buyerId ?? null,
    title: s.title ?? t(lang, "msg.untitled"),
    link: s.link ?? "",
    price: s.price ?? t(lang, "msg.priceUnknown"),
    photoFileId: s.photoFileId ?? null,
    photoUrl: s.photoUrl ?? null,
    priority: s.priority ?? 2,
    status: "new",
    noteFromBuyer: "",
    holiday: s.holidayContext ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  try {
    await wish.save();
  } catch (e) {
    const errText = e.message ?? String(e);
    console.error("wish.save() error:", errText);
    try { await bot.api.sendMessage(ADMIN_ID, `⚠️ wish.save() error (user ${userId}):\n${errText}`); } catch {}
    await ctx.reply(t(lang, "msg.error"));
    return;
  }
  clearState(userId);

  if (!opts.skipSavedMsg) {
    let gptComment = "";
    try { gptComment = await gptWishComment(wish.title); } catch {}
    await ctx.reply(t(lang, "msg.wishSaved", { comment: gptComment }), {
      reply_markup: await getMainKeyboard(userId),
    });
  }

  if (buyerId) {
    const buyerLang = await fetchUserLang(buyerId);
    const caption = wishCaption(wish, buyerLang, true) + `\n\n${t(buyerLang, "msg.newWishFor")}`;
    const photo = wish.photoFileId || wish.photoUrl;
    try {
      if (photo) {
        await bot.api.sendPhoto(buyerId, photo, {
          caption,
          parse_mode: "Markdown",
          reply_markup: getBuyerWishKeyboard(wish.id, buyerLang),
        });
      } else {
        await bot.api.sendMessage(buyerId, caption, {
          parse_mode: "Markdown",
          reply_markup: getBuyerWishKeyboard(wish.id, buyerLang),
        });
      }
    } catch (e) {
      const errCode = e?.error_code ?? e?.payload?.error_code;
      const errDesc = String(e?.description ?? e?.message ?? "");
      const isBlocked = errCode === 403 || errDesc.includes("blocked") || errDesc.includes("bot was blocked");
      if (isBlocked) {
        await ctx.reply(t(lang, "msg.cantNotifyBuyer"));
      } else {
        console.error("notify buyer error:", e.message ?? e);
      }
    }
  }
}

// ─── Register bot commands ─────────────────────────────────────────────────
await bot.api.setMyCommands([
  { command: "start",   description: "Запуск бота / главное меню" },
  { command: "menu",    description: "Показать меню" },
  { command: "myid",    description: "Показать мой Telegram ID" },
  { command: "bind",    description: "Привязать покупателя" },
  { command: "unbind",  description: "Отвязать покупателя" },
  { command: "wishes",  description: "Мои хотелки" },
  { command: "partner", description: "Хотелки партнёра" },
  { command: "cancel",  description: "Отмена текущего действия" },
  { command: "help",    description: "Справка" },
]);

// ─── /start ───────────────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  try {
    await ensureUser(ctx);
    const userId = String(ctx.from.id);
    clearState(userId);
    const lang = getLang(userId);

    // ─── Holiday referral deep link: ?start=hw_birthday_123456 ──────────
    const payload = ctx.match;
    if (payload?.startsWith("hw_")) {
      const parts = payload.split("_");
      const holiday = parts[1];
      const targetId = parts[2];
      if (HOLIDAYS.includes(holiday) && targetId) {
        const targetUser = await User.findOne({ userId: targetId });
        const ownerName = escMd(targetUser?.firstName || "Пользователь");
        const holidayName = getHolidayName(lang, holiday);
        const wishes = await Wish.find({ ownerId: targetId, holiday, status: { $ne: "archived" } });
        const mainKb = await getMainKeyboard(userId);
        if (!wishes.length) {
          await ctx.reply(
            `🎉 Список *${ownerName}* на *${holidayName}* пока пуст.`,
            { parse_mode: "Markdown", reply_markup: mainKb }
          );
        } else {
          await ctx.reply(
            t(lang, "msg.holiday.viewTitle", { owner: ownerName, holiday: holidayName }),
            { parse_mode: "Markdown", reply_markup: mainKb }
          );
          for (const w of wishes) {
            const guestKb = getHolidayWishGuestKeyboard(w, userId, lang);
            await sendWishCard(ctx, null, w, guestKb, lang, false);
          }
        }
        return;
      }
    }

    const name = ctx.from.first_name || "друг";
    const caption = t(lang, "msg.start", { name: escMd(name) });
    const keyboard = await getMainKeyboard(userId);

    // Try to send logo if present
    const logoCandidates = ["logo.png", "logo.jpg", "logo.jpeg", "logo.webp"].map(f => resolve(__dirname, f));
    const logoPath = logoCandidates.find(p => existsSync(p));
    if (logoPath) {
      await ctx.replyWithPhoto(new InputFile(createReadStream(logoPath)), {
        caption,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } else {
      await ctx.reply(caption, { parse_mode: "Markdown", reply_markup: keyboard });
    }
  } catch (e) { console.error("/start error:", e); }
});

// ─── /menu ────────────────────────────────────────────────────────────────
bot.command("menu", async (ctx) => {
  try {
    await ensureUser(ctx);
    const userId = String(ctx.from.id);
    const lang = getLang(userId);
    await ctx.reply(t(lang, "msg.menu"), { reply_markup: await getMainKeyboard(userId) });
  } catch (e) { console.error("/menu error:", e); }
});

// ─── /myid ────────────────────────────────────────────────────────────────
bot.command("myid", async (ctx) => {
  try {
    await ensureUser(ctx);
    const lang = getLang(String(ctx.from.id));
    await ctx.reply(t(lang, "msg.myId", { id: ctx.from.id }), {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .copyText(t(lang, "ibtn.copyId"), String(ctx.from.id)).row()
        .text(t(lang, "ibtn.bindBuyer"), "do_bind"),
    });
  } catch (e) { console.error("/myid error:", e); }
});

// ─── /help ────────────────────────────────────────────────────────────────
bot.command("help", async (ctx) => {
  try {
    await ensureUser(ctx);
    const lang = getLang(String(ctx.from.id));
    await ctx.reply(t(lang, "msg.help"), { parse_mode: "Markdown" });
  } catch (e) { console.error("/help error:", e); }
});

// ─── /cancel ──────────────────────────────────────────────────────────────
bot.command("cancel", async (ctx) => {
  try {
    await ensureUser(ctx);
    const userId = String(ctx.from.id);
    const lang = getLang(userId);
    clearState(userId);
    setState(userId, { lang });
    await ctx.reply(t(lang, "msg.cancelled"), { reply_markup: await getMainKeyboard(userId) });
  } catch (e) { console.error("/cancel error:", e); }
});

// ─── /bind ────────────────────────────────────────────────────────────────
bot.command("bind", async (ctx) => {
  try {
    await ensureUser(ctx);
    const userId = String(ctx.from.id);
    const lang = getLang(userId);
    setState(userId, { mode: "bind" });
    await ctx.reply(t(lang, "msg.enterBuyerIdFull"));
  } catch (e) { console.error("/bind error:", e); }
});

// ─── /unbind ──────────────────────────────────────────────────────────────
bot.command("unbind", async (ctx) => {
  try {
    await ensureUser(ctx);
    const userId = String(ctx.from.id);
    const lang = getLang(userId);
    const binding = await Binding.findOne({ ownerId: userId });
    if (binding) {
      const oldBuyerId = binding.viewerId;
      await Binding.deleteOne({ ownerId: userId });
      await updateUserRole(userId);
      await updateUserRole(oldBuyerId);
      await ctx.reply(t(lang, "msg.buyerUnbound"), { reply_markup: await getMainKeyboard(userId) });
    } else {
      await ctx.reply(t(lang, "msg.noBuyer"));
    }
  } catch (e) { console.error("/unbind error:", e); }
});

// ─── /wishes & /partner ───────────────────────────────────────────────────
bot.command("wishes", async (ctx) => {
  try {
    await ensureUser(ctx);
    await showOwnerWishes(ctx, getLang(String(ctx.from.id)));
  } catch (e) { console.error("/wishes error:", e); }
});

bot.command("partner", async (ctx) => {
  try {
    await ensureUser(ctx);
    await showPartnerWishes(ctx, getLang(String(ctx.from.id)));
  } catch (e) { console.error("/partner error:", e); }
});

// ─── Text message handler ─────────────────────────────────────────────────
bot.on("message:text", async (ctx) => {
  try {
    await ensureUser(ctx);
    const text = ctx.message.text;
    const userId = String(ctx.from.id);
    const lang = getLang(userId);
    const s = getState(userId);

    // ── Admin panel ───────────────────────────────────────────────────────
    if (text === t(lang, "btn.admin") && userId === ADMIN_ID) {
      await ctx.reply(t(lang, "msg.adminPanel"), {
        parse_mode: "Markdown",
        reply_markup: getAdminKeyboard(lang),
      });
      return;
    }

    if (text === t(lang, "btn.stats") && userId === ADMIN_ID) {
      const usersCount = await User.countDocuments();
      const wishesCount = await Wish.countDocuments({ status: { $ne: "archived" } });
      await ctx.reply(
        t(lang, "msg.stats", { users: usersCount, wishes: wishesCount }),
        { parse_mode: "Markdown", reply_markup: getAdminKeyboard(lang) }
      );
      return;
    }

    if (text === t(lang, "btn.adminReviews") && userId === ADMIN_ID) {
      const count = await Review.countDocuments();
      const kb = new InlineKeyboard()
        .text(t(lang, "ibtn.reviewsAll"),   "admin_reviews:all").row()
        .text(t(lang, "ibtn.reviewsLast5"), "admin_reviews:last5");
      await ctx.reply(
        t(lang, "msg.adminReviewsMenu", { count }),
        { parse_mode: "Markdown", reply_markup: kb }
      );
      return;
    }

    if (text === t(lang, "btn.broadcast") && userId === ADMIN_ID) {
      setState(userId, { mode: "broadcast", step: "text" });
      await ctx.reply(t(lang, "msg.broadcastPrompt"));
      return;
    }

    if (text === t(lang, "btn.donateBroadcast") && userId === ADMIN_ID) {
      setState(userId, { mode: "donate_broadcast" });
      await ctx.reply(t(lang, "msg.donateAskAmount"), { parse_mode: "Markdown" });
      return;
    }

    if (text === t(lang, "btn.reviewBroadcast") && userId === ADMIN_ID) {
      const users = await User.find({}, "userId lang");
      let sent = 0;
      for (const user of users) {
        try {
          const uLang = user.lang ?? "ru";
          await bot.api.sendMessage(
            user.userId,
            t(uLang, "msg.reviewBroadcastText"),
            {
              reply_markup: new InlineKeyboard()
                .text(t(uLang, "ibtn.writeReview"), "review:start"),
            }
          );
          sent++;
        } catch { /* skip blocked users */ }
      }
      await ctx.reply(
        t(lang, "msg.reviewBroadcastSent", { count: sent }),
        { reply_markup: getAdminKeyboard(lang) }
      );
      return;
    }

    if (text === t(lang, "btn.savedButtons") && userId === ADMIN_ID) {
      const buttons = await SavedButton.find().sort({ createdAt: -1 });
      const kb = new InlineKeyboard();
      for (const btn of buttons) {
        kb.text(`${btn.label}`, `sbtn:view:${btn.id}`).row();
      }
      kb.text(t(lang, "ibtn.savedBtns.addManual"), "sbtn:add_manual").row()
        .text(t(lang, "ibtn.savedBtns.genAI"), "sbtn:gen_ai");
      const msg = buttons.length
        ? t(lang, "msg.savedBtns.list", { count: buttons.length })
        : t(lang, "msg.savedBtns.empty");
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
      return;
    }

    // ── Reply keyboard buttons ────────────────────────────────────────────
    if (text === t(lang, "btn.addProduct")) {
      clearState(userId);
      setState(userId, { mode: "add_method", lang });
      await ctx.reply(t(lang, "msg.addMethod"), { reply_markup: getAddMethodKeyboard(lang) });
      return;
    }

    if (text === t(lang, "btn.myWishes"))      { await showOwnerWishes(ctx, lang); return; }
    if (text === t(lang, "btn.partnerWishes")) { await showPartnerWishes(ctx, lang); return; }
    if (text === t(lang, "btn.history"))       { await showBuyerHistory(ctx, lang); return; }

    if (text === t(lang, "btn.findProduct")) {
      if (!SEARCH_ALLOWED.has(userId)) {
        await ctx.reply(t(lang, "msg.searchAccess"));
        return;
      }
      if (!process.env.SERPAPI_KEY) {
        await ctx.reply(t(lang, "msg.searchNoKey"));
        return;
      }
      clearState(userId);
      setState(userId, { mode: "add_search", step: "query", lang });
      await ctx.reply(t(lang, "msg.searchQuery"));
      return;
    }

    if (text === t(lang, "btn.giftIdea")) {
      clearState(userId);
      setState(userId, { mode: "gift_chat", giftHistory: [], lang });
      await ctx.reply(t(lang, "msg.giftChatStart"), {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text(t(lang, "ibtn.gift.auto"), "gift:auto"),
      });
      return;
    }

    if (text === t(lang, "btn.chat")) {
      clearState(userId);
      setState(userId, { mode: "talk", chatHistory: [], lang });
      await ctx.reply(t(lang, "msg.chatMode"));
      return;
    }

    if (text === t(lang, "btn.settings")) {
      const userDoc = await User.findOne({ userId });
      const notifsEnabled = userDoc?.receiveGiftNotifs ?? false;
      const pledgeNotifsEnabled = userDoc?.receivePledgeNotifs ?? true;
      await ctx.reply(t(lang, "msg.settings"), { reply_markup: getSettingsKeyboard(lang, notifsEnabled, pledgeNotifsEnabled) });
      return;
    }

    if (
      text === t(lang, "btn.notifsOn") ||
      text === t(lang, "btn.notifsOff")
    ) {
      const userDoc = await User.findOne({ userId });
      const current = userDoc?.receiveGiftNotifs ?? false;
      const next = !current;
      const pledgeNotifsEnabled = userDoc?.receivePledgeNotifs ?? true;
      await User.findOneAndUpdate({ userId }, { receiveGiftNotifs: next });
      const msgKey = next ? "msg.notifsEnabled" : "msg.notifsDisabled";
      await ctx.reply(t(lang, msgKey), {
        parse_mode: "Markdown",
        reply_markup: getSettingsKeyboard(lang, next, pledgeNotifsEnabled),
      });
      return;
    }

    if (
      text === t(lang, "btn.pledgeNotifsOn") ||
      text === t(lang, "btn.pledgeNotifsOff")
    ) {
      const userDoc = await User.findOne({ userId });
      const current = userDoc?.receivePledgeNotifs ?? true;
      const next = !current;
      const notifsEnabled = userDoc?.receiveGiftNotifs ?? false;
      await User.findOneAndUpdate({ userId }, { receivePledgeNotifs: next });
      const msgKey = next ? "msg.pledgeNotifsEnabled" : "msg.pledgeNotifsDisabled";
      await ctx.reply(t(lang, msgKey), {
        parse_mode: "Markdown",
        reply_markup: getSettingsKeyboard(lang, notifsEnabled, next),
      });
      return;
    }

    if (text === t(lang, "btn.langSettings")) {
      await ctx.reply(t(lang, "msg.chooseLang"), { reply_markup: getLangKeyboard() });
      return;
    }

    if (text === t(lang, "btn.moreMenu")) {
      await ctx.reply(t(lang, "msg.secondaryMenu"), { reply_markup: getSecondaryKeyboard(userId) });
      return;
    }

    if (text === t(lang, "btn.mainMenu")) {
      await ctx.reply(t(lang, "msg.menu"), { reply_markup: await getMainKeyboard(userId) });
      return;
    }

    if (text === t(lang, "btn.myPledges")) {
      const total = await Wish.countDocuments({ pledgedBy: userId });
      if (!total) {
        await ctx.reply(t(lang, "msg.noPledges"), { parse_mode: "Markdown" });
        return;
      }
      const kb = new InlineKeyboard()
        .text(t(lang, "ibtn.pledges.planned"), "mygifts:planned").row()
        .text(t(lang, "ibtn.pledges.bought"),   "mygifts:bought").row()
        .text(t(lang, "ibtn.pledges.deferred"), "mygifts:deferred");
      await ctx.reply(t(lang, "msg.pledgesMenu"), { parse_mode: "Markdown", reply_markup: kb });
      return;
    }

    if (text === t(lang, "btn.holidays")) {
      clearState(userId);
      await ctx.reply(t(lang, "msg.holiday.select"), {
        reply_markup: getHolidaySelectionKeyboard(lang),
      });
      return;
    }

    if (text === t(lang, "btn.donate")) {
      setState(userId, { mode: "user_donate" });
      await ctx.reply(t(lang, "msg.donateUserAsk"), { parse_mode: "Markdown" });
      return;
    }

    if (text === t(lang, "btn.review")) {
      setState(userId, { mode: "review" });
      await ctx.reply(t(lang, "msg.reviewPrompt"), { parse_mode: "Markdown" });
      return;
    }

    if (text === t(lang, "btn.bindBuyer")) {
      setState(userId, { mode: "bind" });
      await ctx.reply(t(lang, "msg.enterBuyerId"));
      return;
    }

    if (text === t(lang, "btn.unbindBuyer")) {
      const binding = await Binding.findOne({ ownerId: userId });
      if (binding) {
        const oldBuyerId = binding.viewerId;
        await Binding.deleteOne({ ownerId: userId });
        await updateUserRole(userId);
        await updateUserRole(oldBuyerId);
        await ctx.reply(t(lang, "msg.buyerUnbound"), { reply_markup: await getMainKeyboard(userId) });
      } else {
        await ctx.reply(t(lang, "msg.noBuyer"));
      }
      return;
    }

    if (text === t(lang, "btn.myId")) {
      await ctx.reply(t(lang, "msg.myId", { id: ctx.from.id }), {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .copyText(t(lang, "ibtn.copyId"), String(ctx.from.id)).row()
          .text(t(lang, "ibtn.bindBuyer"), "do_bind"),
      });
      return;
    }

    if (text === t(lang, "btn.back")) {
      clearState(userId);
      setState(userId, { lang });
      await ctx.reply(t(lang, "msg.menu"), { reply_markup: await getMainKeyboard(userId) });
      return;
    }

    // ── State: broadcast ──────────────────────────────────────────────────
    if (s.mode === "broadcast" && userId === ADMIN_ID) {
      if (s.step === "text") {
        setState(userId, { broadcastText: text.trim(), step: "after_text" });
        const savedCount = await SavedButton.countDocuments();
        const kb = new InlineKeyboard()
          .text(t(lang, "ibtn.bcast.addBtns"), "bcast:add_btns").row()
          .text(t(lang, "ibtn.bcast.genAI"), "bcast:gen_ai");
        if (savedCount > 0) kb.row().text(t(lang, "ibtn.bcast.fromSaved"), "bcast:from_saved");
        kb.row().text(t(lang, "ibtn.bcast.sendNow"), "bcast:send_now");
        await ctx.reply(t(lang, "msg.broadcastTextSaved"), { reply_markup: kb });
        return;
      }

      if (s.step === "gen_btn") {
        await ctx.reply(t(lang, "msg.savedBtns.genThink"));
        try {
          const generated = await generateButtonViaAI(text.trim());
          const bcastBtns = [...(s.broadcastButtons ?? []), { text: generated.label, url: generated.url }];
          setState(userId, { broadcastButtons: bcastBtns, step: "confirm" });
          const previewKb = new InlineKeyboard();
          bcastBtns.forEach(b => { previewKb.url(b.text, b.url); previewKb.row(); });
          await ctx.reply(t(lang, "msg.broadcastPreview"), { parse_mode: "Markdown" });
          await ctx.reply(s.broadcastText, { reply_markup: previewKb });
          await ctx.reply(t(lang, "msg.broadcastConfirm"), {
            reply_markup: new InlineKeyboard()
              .text(t(lang, "ibtn.bcast.confirm"), "bcast:confirm").row()
              .text(t(lang, "ibtn.bcast.editBtns"), "bcast:edit_btns")
              .text(t(lang, "ibtn.bcast.cancel"), "bcast:cancel"),
          });
        } catch {
          await ctx.reply(t(lang, "msg.savedBtns.genError"));
        }
        return;
      }
      if (s.step === "buttons") {
        const lines = text.trim().split("\n").filter(l => l.includes("|"));
        const buttons = lines
          .map(line => {
            const sep = line.indexOf("|");
            return { text: line.slice(0, sep).trim(), url: line.slice(sep + 1).trim() };
          })
          .filter(b => b.text && b.url.startsWith("http"));
        if (!buttons.length) {
          await ctx.reply(t(lang, "msg.broadcastBadBtns"), { parse_mode: "Markdown" });
          return;
        }
        setState(userId, { broadcastButtons: buttons, step: "confirm" });
        const previewKb = new InlineKeyboard();
        buttons.forEach(b => { previewKb.url(b.text, b.url); previewKb.row(); });
        await ctx.reply(t(lang, "msg.broadcastPreview"), { parse_mode: "Markdown" });
        await ctx.reply(s.broadcastText, { reply_markup: previewKb });
        await ctx.reply(t(lang, "msg.broadcastConfirm"), {
          reply_markup: new InlineKeyboard()
            .text(t(lang, "ibtn.bcast.confirm"), "bcast:confirm").row()
            .text(t(lang, "ibtn.bcast.editBtns"), "bcast:edit_btns")
            .text(t(lang, "ibtn.bcast.cancel"), "bcast:cancel"),
        });
        return;
      }
      return;
    }

    // ── State: btn_add (manual saved button creation) ─────────────────────
    if (s.mode === "btn_add" && userId === ADMIN_ID) {
      const input = text.trim();
      const sep = input.indexOf("|");
      if (sep === -1) { await ctx.reply(t(lang, "msg.savedBtns.badFormat"), { parse_mode: "Markdown" }); return; }
      const label = input.slice(0, sep).trim();
      const url = input.slice(sep + 1).trim();
      if (!label || !url.startsWith("http")) { await ctx.reply(t(lang, "msg.savedBtns.badFormat"), { parse_mode: "Markdown" }); return; }
      setState(userId, { pendingBtn: { label, url }, step: "confirm" });
      await ctx.reply(
        t(lang, "msg.savedBtns.preview", { label, url }),
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text(t(lang, "ibtn.savedBtns.save"), "sbtn:save")
            .text(t(lang, "ibtn.savedBtns.discard"), "sbtn:discard"),
        }
      );
      return;
    }

    // ── State: btn_gen (AI saved button generation) ────────────────────────
    if (s.mode === "btn_gen" && userId === ADMIN_ID) {
      await ctx.reply(t(lang, "msg.savedBtns.genThink"));
      try {
        const generated = await generateButtonViaAI(text.trim());
        setState(userId, { pendingBtn: generated, step: "confirm" });
        await ctx.reply(
          t(lang, "msg.savedBtns.preview", { label: generated.label, url: generated.url }),
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard()
              .text(t(lang, "ibtn.savedBtns.save"), "sbtn:save")
              .text(t(lang, "ibtn.savedBtns.discard"), "sbtn:discard"),
          }
        );
      } catch {
        await ctx.reply(t(lang, "msg.savedBtns.genError"));
      }
      return;
    }

    // ── State: review ─────────────────────────────────────────────────────
    if (s.mode === "review") {
      const reviewText = text.trim();
      if (!reviewText) { await ctx.reply(t(lang, "msg.reviewPrompt"), { parse_mode: "Markdown" }); return; }
      clearState(userId);
      setState(userId, { lang });
      await ctx.reply(t(lang, "msg.reviewSent"), { reply_markup: await getMainKeyboard(userId) });
      // Save to DB
      await new Review({
        userId,
        userName: ctx.from.first_name || "Unknown",
        text: reviewText,
      }).save();
      try {
        await bot.api.sendMessage(
          ADMIN_ID,
          t("ru", "msg.reviewReceived", {
            name: escMd(ctx.from.first_name || "Unknown"),
            id: ctx.from.id,
            text: escMd(reviewText),
          }),
          { parse_mode: "Markdown" }
        );
      } catch (e) { console.error("review notify admin error:", e.message); }
      return;
    }

    // ── State: donate_broadcast ───────────────────────────────────────────
    if (s.mode === "donate_broadcast" && userId === ADMIN_ID) {
      const stars = parseInt(text.trim(), 10);
      if (!stars || stars < 1) {
        await ctx.reply(t(lang, "msg.donateInvalidAmount"));
        return;
      }
      const users = await User.find({}, "userId lang");
      let sent = 0;
      for (const user of users) {
        try {
          const uLang = user.lang ?? "ru";
          await bot.api.sendInvoice(
            user.userId,
            t(uLang, "msg.donateInvoiceTitle"),
            t(uLang, "msg.donateInvoiceDesc"),
            "donate",
            "XTR",
            [{ label: t(uLang, "msg.donateInvoiceLabel"), amount: stars }]
          );
          sent++;
        } catch { /* skip blocked/inactive users */ }
      }
      clearState(userId);
      setState(userId, { lang });
      await ctx.reply(
        t(lang, "msg.donateSent", { count: sent, stars }),
        { reply_markup: getAdminKeyboard(lang) }
      );
      return;
    }

    // ── State: user_donate ────────────────────────────────────────────────
    if (s.mode === "user_donate") {
      const stars = parseInt(text.trim(), 10);
      if (!stars || stars < 1) {
        await ctx.reply(t(lang, "msg.donateUserInvalid"));
        return;
      }
      clearState(userId);
      setState(userId, { lang });
      await bot.api.sendInvoice(
        userId,
        t(lang, "msg.donateInvoiceTitle"),
        t(lang, "msg.donateInvoiceDesc"),
        "donate",
        "XTR",
        [{ label: t(lang, "msg.donateInvoiceLabel"), amount: stars }]
      );
      return;
    }

    // ── State: bind ───────────────────────────────────────────────────────
    if (s.mode === "bind") {
      const input = text.trim();
      if (!/^\d+$/.test(input)) {
        await ctx.reply(t(lang, "msg.idDigitsOnly"));
        return;
      }
      if (input === userId) {
        await ctx.reply(t(lang, "msg.cantBindSelf"));
        return;
      }
      await Binding.findOneAndUpdate({ ownerId: userId }, { viewerId: input }, { upsert: true });
      await updateUserRole(userId);
      await updateUserRole(input);
      clearState(userId);
      setState(userId, { lang });

      const owner = await User.findOne({ userId });
      const ownerName = owner?.firstName ?? "Партнёр";

      await ctx.reply(
        t(lang, "msg.buyerBound", { id: input }),
        { parse_mode: "Markdown", reply_markup: await getMainKeyboard(userId) }
      );
      // Connection tips for the owner
      await ctx.reply(t(lang, "msg.connectionTips"), { parse_mode: "Markdown" });

      const buyerLang = await fetchUserLang(input);
      try {
        // Enhanced welcome for the buyer with instructions
        await bot.api.sendMessage(
          input,
          t(buyerLang, "msg.buyerConnected", { ownerName: escMd(ownerName) }),
          { parse_mode: "Markdown", reply_markup: await getMainKeyboard(input) }
        );
      } catch { /* buyer hasn't started bot yet */ }
      return;
    }

    // ── State: add (manual flow) ──────────────────────────────────────────
    if (s.mode === "add") {
      if (s.step === "photo") {
        await ctx.reply(t(lang, "msg.waitPhoto"));
        return;
      }
      if (s.step === "title") {
        const title = text.trim();
        if (!title) { await ctx.reply(t(lang, "msg.emptyTitle")); return; }
        setState(userId, { title, step: "link" });
        await ctx.reply(t(lang, "msg.enterLink"));
        return;
      }
      if (s.step === "link") {
        let link = text.trim();
        const langSkip = t(lang, "linkSkip");
        const skip = langSkip.includes(link.toLowerCase());
        if (!skip) {
          const hasProto = /^https?:\/\//i.test(link);
          const hasDomain = /\.\w{2,}/i.test(link);
          if (!hasProto && !hasDomain) { await ctx.reply(t(lang, "msg.invalidLink")); return; }
          if (!hasProto) link = "https://" + link;
        } else {
          link = "";
        }
        setState(userId, { link, step: "price" });
        await ctx.reply(t(lang, "msg.enterPrice"));
        return;
      }
      if (s.step === "price") {
        setState(userId, { price: text.trim() || t(lang, "msg.priceUnknown"), step: "priority" });
        await ctx.reply(t(lang, "msg.choosePriority"), { reply_markup: getPriorityKeyboard(lang) });
        return;
      }
      return;
    }

    // ── State: add_link ───────────────────────────────────────────────────
    if (s.mode === "add_link") {
      if (s.step === "url") {
        let url = text.trim();
        if (!url.startsWith("http")) url = "https://" + url;
        await ctx.reply(t(lang, "msg.loadingPage"));
        try {
          const product = await fetchProductData(url);
          if (!product || !product.title || !product.image) {
            await ctx.reply(t(lang, "msg.cantRecognize"), { reply_markup: getAddMethodKeyboard(lang) });
            clearState(userId);
            setState(userId, { mode: "add_method", lang });
            return;
          }
          setState(userId, {
            mode: "add", step: "confirm",
            title: product.title,
            price: product.price || t(lang, "msg.priceUnknown"),
            link: product.link || url,
            photoUrl: product.image, photoFileId: null, priority: 2,
            holidayContext: s.holidayContext ?? null,
          });
          await sendConfirmPreview(ctx, getState(userId), lang);
        } catch (e) {
          console.error("fetchProductData error:", e.message);
          await ctx.reply(t(lang, "msg.loadError"));
        }
        return;
      }
    }

    // ── State: add_search ─────────────────────────────────────────────────
    if (s.mode === "add_search") {
      if (s.step === "query") {
        const query = text.trim();
        const isUrl =
          /^https?:\/\//i.test(query) ||
          (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(query) && !query.includes(" "));

        if (isUrl) {
          let url = query;
          if (!/^https?:\/\//i.test(url)) url = "https://" + url;
          await ctx.reply(t(lang, "msg.loadingPage"));
          try {
            const product = await fetchProductData(url);
            if (!product || !product.title) {
              await ctx.reply(t(lang, "msg.cantRecognize"), { reply_markup: getAddMethodKeyboard(lang) });
              clearState(userId);
              setState(userId, { mode: "add_method", lang });
              return;
            }
            setState(userId, {
              mode: "add", step: "confirm",
              title: product.title,
              price: product.price || t(lang, "msg.priceUnknown"),
              link: product.link || url,
              photoUrl: product.image, photoFileId: null, priority: 2,
              holidayContext: s.holidayContext ?? null,
            });
            await sendConfirmPreview(ctx, getState(userId), lang);
          } catch (e) {
            console.error("fetchProductData error:", e.message);
            await ctx.reply(t(lang, "msg.loadError"));
          }
          return;
        }

        await ctx.reply(t(lang, "msg.searching"));
        try {
          const { query: searchQ } = await gptBuildSearchQuery(query);
          const results = await searchGoogleShopping(searchQ);

          if (!results || results.length === 0) {
            await ctx.reply(t(lang, "msg.noResults"), { reply_markup: getAddMethodKeyboard(lang) });
            clearState(userId);
            setState(userId, { mode: "add_method", lang });
            return;
          }

          setState(userId, { mode: "add_search", step: "results", searchResults: results, lang });
          await ctx.reply(t(lang, "msg.foundResults", { count: results.length, query: searchQ }));

          for (let i = 0; i < results.length; i++) {
            const item = results[i];
            const caption =
              `*${escMd(item.title || "Товар")}*\n` +
              `💰 ${escMd(item.price || "—")}\n` +
              `🏪 ${escMd(item.source || "")}\n` +
              (item.link ? `🔗 [Страница товара](${item.link})` : "");
            const kb = new InlineKeyboard().text(t(lang, "ibtn.addToWishlist"), `pick:${i}`);
            if (item.thumbnail) {
              try {
                await ctx.replyWithPhoto(item.thumbnail, { caption, parse_mode: "Markdown", reply_markup: kb });
                continue;
              } catch { /* fall through */ }
            }
            await ctx.reply(caption, { parse_mode: "Markdown", reply_markup: kb });
          }
        } catch (e) {
          console.error("search error:", e.message);
          const msg = e.message?.includes("SERPAPI_KEY")
            ? t(lang, "msg.searchNoKey")
            : `⚠️ ${e.message}`;
          await ctx.reply(msg, { reply_markup: await getMainKeyboard(userId) });
          clearState(userId);
          setState(userId, { lang });
        }
        return;
      }
    }

    // ── State: note ───────────────────────────────────────────────────────
    if (s.mode === "note" && s.wishId) {
      const note = text.trim();
      if (!note) { await ctx.reply(t(lang, "msg.emptyNote")); return; }
      const wish = await Wish.findOneAndUpdate(
        { id: s.wishId },
        { noteFromBuyer: note, updatedAt: new Date() },
        { new: true }
      );
      if (!wish) { await ctx.reply(t(lang, "msg.wishNotFound")); clearState(userId); return; }
      clearState(userId);
      setState(userId, { lang });
      await ctx.reply(t(lang, "msg.noteSaved"), { reply_markup: await getMainKeyboard(userId) });

      const buyer = await User.findOne({ userId });
      const buyerName = buyer?.firstName ?? "Покупатель";
      const ownerLang = await fetchUserLang(wish.ownerId);
      try {
        await bot.api.sendMessage(
          wish.ownerId,
          t(ownerLang, "msg.noteNotification", {
            buyerName: escMd(buyerName),
            title: escMd(wish.title),
            note: escMd(note),
          }),
          { parse_mode: "Markdown" }
        );
      } catch { /* owner may be unreachable */ }
      return;
    }

    // ── State: gift_chat ──────────────────────────────────────────────────
    if (s.mode === "gift_chat") {
      await ctx.reply(t(lang, "msg.giftChatThink"));
      try {
        const history = s.giftHistory ?? [];
        const { reply, history: newHistory } = await continueGiftChat(history, text);
        setState(userId, { giftHistory: newHistory, lastGiftMsg: reply });
        await ctx.reply(reply, {
          reply_markup: new InlineKeyboard()
            .text(t(lang, "ibtn.gift.another"), "gift:another").row()
            .text(t(lang, "ibtn.gift.save"), "gift:save")
            .text(t(lang, "ibtn.gift.close"), "gift:close"),
        });
      } catch (e) {
        console.error("gift_chat error:", e.message);
        await ctx.reply(t(lang, "msg.giftChatError"));
      }
      return;
    }

    // ── State: talk ───────────────────────────────────────────────────────
    if (s.mode === "talk") {
      const reply = await gptTalk(userId, text);
      await ctx.reply(reply);
      return;
    }

    // ── Default ───────────────────────────────────────────────────────────
    await ctx.reply(t(lang, "msg.useMenu"), { reply_markup: await getMainKeyboard(userId) });
  } catch (e) {
    console.error("message:text error:", e);
    try {
      const errLang = getLang(String(ctx.from.id));
      await ctx.reply(t(errLang, "msg.error"), { reply_markup: await getMainKeyboard(String(ctx.from.id)) });
    } catch {}
  }
});

// ─── Photo handler ────────────────────────────────────────────────────────
bot.on("message:photo", async (ctx) => {
  try {
    await ensureUser(ctx);
    const userId = String(ctx.from.id);
    const lang = getLang(userId);
    const s = getState(userId);

    if (s.mode === "add" && s.step === "photo") {
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      setState(userId, { photoFileId: best.file_id, photoUrl: null, step: "title" });
      await ctx.reply(t(lang, "msg.enterTitle"));
      return;
    }

    await ctx.reply(t(lang, "msg.photoUnexpected"), { reply_markup: await getMainKeyboard(userId) });
  } catch (e) { console.error("message:photo error:", e); }
});

// ─── Callback query handler ───────────────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ensureUser(ctx);
    const userId = String(ctx.from.id);
    const lang = getLang(userId);
    const data = ctx.callbackQuery.data;
    const s = getState(userId);

    // ─── Pledge handlers ───────────────────────────────────────────────────
    if (data.startsWith("pledge:")) {
      const wishId = data.split(":")[1];
      const wish = await Wish.findOne({ id: wishId });
      if (!wish) { await ctx.reply(t(lang, "msg.wishNotFound")); return; }
      if (wish.pledgedBy && wish.pledgedBy !== userId) {
        await ctx.reply(
          t(lang, "msg.pledgeAlready", { name: escMd(wish.pledgedByName || "Кто-то") }),
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard()
              .text(t(lang, "ibtn.pledgeConfirm"), `pledge_confirm:${wishId}`).row()
              .text(t(lang, "ibtn.hwCopy"), `hwcopy:${wishId}`),
          }
        );
        return;
      }
      const ownerUser = await User.findOne({ userId: wish.ownerId });
      await Wish.findOneAndUpdate(
        { id: wishId },
        { pledgedBy: userId, pledgedByName: ctx.from.first_name || "Гость", pledgeStatus: "planned" }
      );
      const holidayName = getHolidayName(lang, wish.holiday ?? "birthday");
      await ctx.reply(
        t(lang, "msg.pledgeDone", {
          title: escMd(wish.title),
          owner: escMd(ownerUser?.firstName || "Пользователь"),
          holiday: holidayName,
        }),
        { parse_mode: "Markdown" }
      );
      // Notify wish owner (if they have pledge notifications enabled)
      try {
        const ownerDoc = await User.findOne({ userId: wish.ownerId });
        if (ownerDoc?.receivePledgeNotifs !== false) {
          const ownerLang = ownerDoc?.lang ?? "ru";
          await bot.api.sendMessage(
            wish.ownerId,
            t(ownerLang, "msg.pledgeOwnerNotify", {
              name: escMd(ctx.from.first_name || "Кто-то"),
              title: escMd(wish.title),
              holiday: getHolidayName(ownerLang, wish.holiday ?? "birthday"),
            }),
            { parse_mode: "Markdown" }
          );
        }
      } catch { /* owner may be unreachable */ }
      return;
    }

    if (data.startsWith("pledge_confirm:")) {
      const wishId = data.split(":")[1];
      const wish = await Wish.findOneAndUpdate(
        { id: wishId },
        { pledgedBy: userId, pledgedByName: ctx.from.first_name || "Гость", pledgeStatus: "planned" },
        { new: true }
      );
      if (!wish) { await ctx.reply(t(lang, "msg.wishNotFound")); return; }
      await ctx.reply(
        t(lang, "msg.pledgeTaken", { title: escMd(wish.title) }),
        { parse_mode: "Markdown" }
      );
      // Notify wish owner (if they have pledge notifications enabled)
      try {
        const ownerDoc = await User.findOne({ userId: wish.ownerId });
        if (ownerDoc?.receivePledgeNotifs !== false) {
          const ownerLang = ownerDoc?.lang ?? "ru";
          await bot.api.sendMessage(
            wish.ownerId,
            t(ownerLang, "msg.pledgeOwnerNotify", {
              name: escMd(ctx.from.first_name || "Кто-то"),
              title: escMd(wish.title),
              holiday: getHolidayName(ownerLang, wish.holiday ?? "birthday"),
            }),
            { parse_mode: "Markdown" }
          );
        }
      } catch { /* owner may be unreachable */ }
      return;
    }

    if (data.startsWith("unpledge:")) {
      const wishId = data.split(":")[1];
      await Wish.findOneAndUpdate(
        { id: wishId, pledgedBy: userId },
        { pledgedBy: null, pledgedByName: null }
      );
      await ctx.reply(t(lang, "msg.pledgeCancelled"), { parse_mode: "Markdown" });
      return;
    }

    if (data.startsWith("hwcopy:")) {
      const wishId = data.split(":")[1];
      const wish = await Wish.findOne({ id: wishId });
      if (!wish) { await ctx.reply(t(lang, "msg.wishNotFound")); return; }
      const copy = new Wish({
        id: generateId(),
        ownerId: userId,
        buyerId: await getBuyerId(userId),
        title: wish.title,
        link: wish.link,
        price: wish.price,
        photoUrl: wish.photoUrl,
        photoFileId: null,
        priority: wish.priority ?? 2,
        status: "new",
        holiday: wish.holiday ?? null,
      });
      await copy.save();
      await ctx.reply(t(lang, "msg.wishCopied"), { parse_mode: "Markdown" });
      return;
    }

    // ─── My Gifts category navigation ─────────────────────────────────────
    if (data.startsWith("mygifts:")) {
      const category = data.split(":")[1]; // "planned" | "bought" | "deferred"
      const statusQuery = category === "planned"
        ? { $in: ["planned", null] }
        : category;
      const wishes = await Wish.find({ pledgedBy: userId, pledgeStatus: statusQuery });
      if (!wishes.length) {
        await ctx.reply(t(lang, "msg.pledges.empty"));
        return;
      }
      const ownerIds = [...new Set(wishes.map((w) => w.ownerId))];
      const owners = await User.find({ userId: { $in: ownerIds } });
      const ownerMap = Object.fromEntries(owners.map((u) => [u.userId, u.firstName]));
      const headerKey = `msg.pledges.${category}`;
      await ctx.reply(t(lang, headerKey, { count: wishes.length }), { parse_mode: "Markdown" });
      for (const w of wishes) {
        const ownerName = escMd(ownerMap[w.ownerId] || "—");
        const holidayName = w.holiday ? getHolidayName(lang, w.holiday) : "—";
        const caption = `🎁 *${escMd(w.title)}*\n👤 Для: *${ownerName}*\n🎉 Повод: ${holidayName}`;
        const kb = new InlineKeyboard()
          .text(t(lang, "ibtn.pledges.moveTo"), `mygift_move:${w.id}`).row()
          .text(t(lang, "ibtn.unpledge"), `unpledge:${w.id}`);
        if (w.photoFileId || w.photoUrl) {
          await ctx.replyWithPhoto(w.photoFileId || w.photoUrl, {
            caption, parse_mode: "Markdown", reply_markup: kb,
          });
        } else {
          await ctx.reply(caption, { parse_mode: "Markdown", reply_markup: kb });
        }
      }
      return;
    }

    // ─── Show move options for a pledged wish ──────────────────────────────
    if (data.startsWith("mygift_move:")) {
      const wishId = data.split(":")[1];
      const wish = await Wish.findOne({ id: wishId, pledgedBy: userId });
      if (!wish) { await ctx.reply(t(lang, "msg.wishNotFound")); return; }
      const kb = new InlineKeyboard();
      if (wish.pledgeStatus !== "planned")  kb.text(t(lang, "ibtn.pledges.toPlanned"),  `mygift_set:${wishId}:planned`).row();
      if (wish.pledgeStatus !== "bought")   kb.text(t(lang, "ibtn.pledges.toBought"),   `mygift_set:${wishId}:bought`).row();
      if (wish.pledgeStatus !== "deferred") kb.text(t(lang, "ibtn.pledges.toDeferred"), `mygift_set:${wishId}:deferred`);
      await ctx.reply(`📦 *${escMd(wish.title)}*`, { parse_mode: "Markdown", reply_markup: kb });
      return;
    }

    // ─── Move pledged wish to a category ──────────────────────────────────
    if (data.startsWith("mygift_set:")) {
      const parts = data.split(":");
      const wishId = parts[1];
      const newStatus = parts[2]; // "planned" | "bought" | "deferred"
      await Wish.findOneAndUpdate({ id: wishId, pledgedBy: userId }, { pledgeStatus: newStatus });
      await ctx.reply(t(lang, "msg.pledges.moved"));
      return;
    }

    // ─── Holiday wishlist handlers ─────────────────────────────────────────
    if (data.startsWith("hw:")) {
      const [, action, holiday] = data.split(":");

      if (action === "menu") {
        await ctx.editMessageText(t(lang, "msg.holiday.select"), {
          parse_mode: "Markdown",
          reply_markup: getHolidaySelectionKeyboard(lang),
        });
        return;
      }

      if (action === "page") {
        await ctx.editMessageText(
          t(lang, "msg.holiday.page", { name: getHolidayName(lang, holiday) }),
          { parse_mode: "Markdown", reply_markup: getHolidayPageKeyboard(lang, holiday) }
        );
        return;
      }

      if (action === "view") {
        const wishes = await Wish.find({ ownerId: userId, holiday, status: { $ne: "archived" } });
        if (!wishes.length) {
          await ctx.reply(t(lang, "msg.holiday.noWishes"), {
            reply_markup: getHolidayPageKeyboard(lang, holiday),
          });
          return;
        }
        let text = t(lang, "msg.holiday.header", { name: getHolidayName(lang, holiday) });
        for (const w of wishes) {
          text += `• *${escMd(w.title)}*`;
          if (w.price) text += ` — ${escMd(w.price)}`;
          text += "\n";
        }
        await ctx.reply(text, {
          parse_mode: "Markdown",
          reply_markup: getHolidayPageKeyboard(lang, holiday),
        });
        return;
      }

      if (action === "add" || action === "more") {
        clearState(userId);
        setState(userId, { mode: "add", step: "photo", holidayContext: holiday, lang });
        await ctx.reply(t(lang, "msg.addMethod"), { reply_markup: getAddMethodKeyboard(lang) });
        return;
      }

      if (action === "share" || action === "done") {
        await ctx.reply(t(lang, "msg.holiday.generating"));
        const wishes = await Wish.find({ ownerId: userId, holiday, status: { $ne: "archived" } });
        const name = getHolidayName(lang, holiday);
        const refLink = `https://t.me/${BOT_USERNAME}?start=hw_${holiday}_${userId}`;
        let aiMsg = "";
        try {
          const wishList = wishes.map((w) => w.title).join(", ");
          const langPrompts = { ru: "русском", uk: "украинском", en: "English" };
          const res = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
              role: "user",
              content: `Напиши тёплое праздничное сообщение (2-3 предложения) на ${langPrompts[lang] ?? "русском"} языке. Повод: "${name}". Пользователь делится вишлистом с друзьями. Желания: ${wishList || "список пуст"}. Призови друзей помочь исполнить мечты.`,
            }],
            max_tokens: 200,
          });
          aiMsg = res.choices[0].message.content.trim();
        } catch {
          aiMsg = `🎉 Мой список желаний на ${name}!`;
        }
        await ctx.reply(`${aiMsg}\n\n${t(lang, "msg.holiday.copyLink")}`, {
          reply_markup: new InlineKeyboard().copyText("📋 Скопировать ссылку", refLink),
        });
        return;
      }

      return;
    }

    if (data === "do_bind") {
      clearState(userId);
      setState(userId, { mode: "bind", lang });
      await ctx.reply(t(lang, "msg.enterBuyerIdFull"));
      return;
    }

    if (data === "add_method:manual") {
      const hCtx = s.holidayContext ?? null;
      clearState(userId);
      setState(userId, { mode: "add", step: "photo", lang, holidayContext: hCtx });
      await ctx.reply(t(lang, "msg.sendPhoto"));
      return;
    }

    if (data === "add_method:link") {
      const hCtx = s.holidayContext ?? null;
      clearState(userId);
      setState(userId, { mode: "add_link", step: "url", lang, holidayContext: hCtx });
      await ctx.reply(t(lang, "msg.sendLink"));
      return;
    }

    if (data === "add_method:search") {
      if (!SEARCH_ALLOWED.has(userId)) {
        await ctx.answerCallbackQuery(t(lang, "msg.searchAccess"));
        return;
      }
      if (!process.env.SERPAPI_KEY) {
        await ctx.reply(t(lang, "msg.searchNoKeyInline"));
        return;
      }
      const hCtx = s.holidayContext ?? null;
      clearState(userId);
      setState(userId, { mode: "add_search", step: "query", lang, holidayContext: hCtx });
      await ctx.reply(t(lang, "msg.searchQuery"));
      return;
    }

    if (/^priority_[123]$/.test(data)) {
      if (s.mode !== "add" || s.step !== "priority") return;
      const priority = parseInt(data.split("_")[1]);
      setState(userId, { priority, step: "confirm" });
      await sendConfirmPreview(ctx, getState(userId), lang);
      return;
    }

    if (data === "confirm_add") {
      if (s.mode !== "add") {
        await ctx.reply(t(lang, "msg.cancelled"), { reply_markup: await getMainKeyboard(userId) });
        return;
      }
      const hCtx = s.holidayContext;
      await finalizeWish(ctx, userId, s, lang, { skipSavedMsg: !!hCtx });
      if (hCtx) {
        setState(userId, { holidayContext: hCtx, lang });
        await ctx.reply(t(lang, "msg.holiday.addedAsk"), {
          reply_markup: getAddMoreKeyboard(lang, hCtx),
        });
      }
      return;
    }

    if (data === "edit_add") {
      setState(userId, { mode: "add", step: "title" });
      await ctx.reply(t(lang, "msg.editAdd"));
      return;
    }

    if (data === "cancel_add") {
      clearState(userId);
      setState(userId, { lang });
      await ctx.reply(t(lang, "msg.cancelAdd"), { reply_markup: await getMainKeyboard(userId) });
      return;
    }

    if (data.startsWith("pick:")) {
      const idx = parseInt(data.split(":")[1]);
      const results = s.searchResults;
      if (!Array.isArray(results) || idx < 0 || idx >= results.length) {
        await ctx.reply(t(lang, "msg.searchItemNotFound"));
        return;
      }
      const item = results[idx];
      setState(userId, {
        mode: "add", step: "confirm",
        title: item.title || t(lang, "msg.untitled"),
        price: item.price || t(lang, "msg.priceUnknown"),
        link: item.link || item.product_link || "",
        photoUrl: item.thumbnail || null, photoFileId: null, priority: 2,
        holidayContext: s.holidayContext ?? null,
      });
      await ctx.reply(t(lang, "msg.productCard"));
      await sendConfirmPreview(ctx, getState(userId), lang);
      return;
    }

    if (data.startsWith("mark_bought:"))   { await updateWishStatus(ctx, userId, data.split(":")[1], "bought",   lang); return; }
    if (data.startsWith("mark_planned:"))  { await updateWishStatus(ctx, userId, data.split(":")[1], "planned",  lang); return; }
    if (data.startsWith("mark_archived:")) { await updateWishStatus(ctx, userId, data.split(":")[1], "archived", lang); return; }

    if (data.startsWith("note:")) {
      setState(userId, { mode: "note", wishId: data.split(":")[1] });
      await ctx.reply(t(lang, "msg.writeNote"));
      return;
    }

    // ── Saved buttons management ──────────────────────────────────────────
    if (data.startsWith("sbtn:") && userId === ADMIN_ID) {
      const parts = data.split(":");
      const action = parts[1];

      if (action === "add_manual") {
        clearState(userId);
        setState(userId, { mode: "btn_add", lang });
        await ctx.reply(t(lang, "msg.savedBtns.addManual"), { parse_mode: "Markdown" });
        return;
      }

      if (action === "gen_ai") {
        clearState(userId);
        setState(userId, { mode: "btn_gen", lang });
        await ctx.reply(t(lang, "msg.savedBtns.genPrompt"), { parse_mode: "Markdown" });
        return;
      }

      if (action === "view") {
        const btnId = parts[2];
        const btn = await SavedButton.findOne({ id: btnId });
        if (!btn) { await ctx.reply(t(lang, "msg.wishNotFound")); return; }
        await ctx.reply(
          `*${btn.label}*\n\`${btn.url}\``,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard()
              .url("🔗 Открыть", btn.url).row()
              .text(t(lang, "ibtn.savedBtns.delete"), `sbtn:del:${btn.id}`)
              .text(t(lang, "ibtn.savedBtns.back"), "sbtn:list"),
          }
        );
        return;
      }

      if (action === "del") {
        await SavedButton.deleteOne({ id: parts[2] });
        await ctx.reply(t(lang, "msg.savedBtns.deleted"));
        // Refresh list
        const buttons = await SavedButton.find().sort({ createdAt: -1 });
        const kb = new InlineKeyboard();
        for (const btn of buttons) kb.text(btn.label, `sbtn:view:${btn.id}`).row();
        kb.text(t(lang, "ibtn.savedBtns.addManual"), "sbtn:add_manual").row()
          .text(t(lang, "ibtn.savedBtns.genAI"), "sbtn:gen_ai");
        const msg = buttons.length ? t(lang, "msg.savedBtns.list", { count: buttons.length }) : t(lang, "msg.savedBtns.empty");
        await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
        return;
      }

      if (action === "list") {
        const buttons = await SavedButton.find().sort({ createdAt: -1 });
        const kb = new InlineKeyboard();
        for (const btn of buttons) kb.text(btn.label, `sbtn:view:${btn.id}`).row();
        kb.text(t(lang, "ibtn.savedBtns.addManual"), "sbtn:add_manual").row()
          .text(t(lang, "ibtn.savedBtns.genAI"), "sbtn:gen_ai");
        const msg = buttons.length ? t(lang, "msg.savedBtns.list", { count: buttons.length }) : t(lang, "msg.savedBtns.empty");
        await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
        return;
      }

      if (action === "save") {
        const pending = s.pendingBtn;
        if (!pending) { await ctx.reply(t(lang, "msg.cancelled"), { reply_markup: getAdminKeyboard(lang) }); return; }
        await SavedButton.create({ id: crypto.randomUUID(), label: pending.label, url: pending.url });
        clearState(userId);
        setState(userId, { lang });
        await ctx.reply(t(lang, "msg.savedBtns.saved"), { reply_markup: getAdminKeyboard(lang) });
        return;
      }

      if (action === "discard") {
        clearState(userId);
        setState(userId, { lang });
        await ctx.reply(t(lang, "msg.cancelled"), { reply_markup: getAdminKeyboard(lang) });
        return;
      }

      // ── Pick saved button for broadcast ────────────────────────────────
      if (action === "pick") {
        const btnId = parts[2];
        const btn = await SavedButton.findOne({ id: btnId });
        if (!btn) return;
        const current = s.broadcastButtons ?? [];
        const already = current.find(b => b.url === btn.url);
        if (!already) {
          const updated = [...current, { text: btn.label, url: btn.url }];
          setState(userId, { broadcastButtons: updated });
        }
        // Show updated selection
        const selected = getState(userId).broadcastButtons ?? [];
        const allBtns = await SavedButton.find().sort({ createdAt: -1 });
        const kb = new InlineKeyboard();
        for (const b of allBtns) {
          const picked = selected.find(x => x.url === b.url);
          kb.text(`${picked ? "✅ " : ""}${b.label}`, `sbtn:pick:${b.id}`).row();
        }
        kb.text(t(lang, "ibtn.bcast.done"), "bcast:from_saved_done")
          .text(t(lang, "ibtn.bcast.cancel"), "bcast:cancel");
        await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
        return;
      }

      return;
    }

    if (data.startsWith("bcast:") && userId === ADMIN_ID) {
      const action = data.split(":")[1];

      if (action === "add_btns") {
        setState(userId, { step: "buttons" });
        await ctx.reply(t(lang, "msg.broadcastAddBtns"), { parse_mode: "Markdown" });
        return;
      }

      if (action === "gen_ai") {
        setState(userId, { step: "gen_btn" });
        await ctx.reply(t(lang, "msg.savedBtns.genPrompt"), { parse_mode: "Markdown" });
        return;
      }

      if (action === "from_saved") {
        const allBtns = await SavedButton.find().sort({ createdAt: -1 });
        if (!allBtns.length) {
          await ctx.reply(t(lang, "msg.savedBtns.empty"), { parse_mode: "Markdown" });
          return;
        }
        const kb = new InlineKeyboard();
        for (const b of allBtns) kb.text(b.label, `sbtn:pick:${b.id}`).row();
        kb.text(t(lang, "ibtn.bcast.done"), "bcast:from_saved_done")
          .text(t(lang, "ibtn.bcast.cancel"), "bcast:cancel");
        await ctx.reply(t(lang, "msg.bcast.pickSaved"), { reply_markup: kb });
        return;
      }

      if (action === "from_saved_done") {
        const buttons = s.broadcastButtons ?? [];
        if (!buttons.length) {
          await ctx.reply(t(lang, "msg.broadcastBadBtns"), { parse_mode: "Markdown" });
          return;
        }
        setState(userId, { step: "confirm" });
        const previewKb = new InlineKeyboard();
        buttons.forEach(b => { previewKb.url(b.text, b.url); previewKb.row(); });
        await ctx.reply(t(lang, "msg.broadcastPreview"), { parse_mode: "Markdown" });
        await ctx.reply(s.broadcastText, { reply_markup: previewKb });
        await ctx.reply(t(lang, "msg.broadcastConfirm"), {
          reply_markup: new InlineKeyboard()
            .text(t(lang, "ibtn.bcast.confirm"), "bcast:confirm").row()
            .text(t(lang, "ibtn.bcast.editBtns"), "bcast:edit_btns")
            .text(t(lang, "ibtn.bcast.cancel"), "bcast:cancel"),
        });
        return;
      }

      if (action === "send_now") {
        const message = s.broadcastText;
        if (!message) { await ctx.reply(t(lang, "msg.cancelled"), { reply_markup: getAdminKeyboard(lang) }); return; }
        const users = await User.find({}, "userId");
        let sent = 0;
        for (const user of users) {
          try { await bot.api.sendMessage(user.userId, message); sent++; } catch {}
        }
        clearState(userId);
        setState(userId, { lang });
        await ctx.reply(t(lang, "msg.broadcastSent", { count: sent }), { reply_markup: getAdminKeyboard(lang) });
        return;
      }

      if (action === "confirm") {
        const message = s.broadcastText;
        const buttons = s.broadcastButtons;
        if (!message) { await ctx.reply(t(lang, "msg.cancelled"), { reply_markup: getAdminKeyboard(lang) }); return; }
        const bcastKb = buttons?.length ? new InlineKeyboard() : null;
        if (bcastKb) buttons.forEach(b => { bcastKb.url(b.text, b.url); bcastKb.row(); });
        const users = await User.find({}, "userId");
        let sent = 0;
        for (const user of users) {
          try {
            await bot.api.sendMessage(user.userId, message, bcastKb ? { reply_markup: bcastKb } : {});
            sent++;
          } catch {}
        }
        clearState(userId);
        setState(userId, { lang });
        await ctx.reply(t(lang, "msg.broadcastSent", { count: sent }), { reply_markup: getAdminKeyboard(lang) });
        return;
      }

      if (action === "edit_btns") {
        setState(userId, { step: "buttons" });
        await ctx.reply(t(lang, "msg.broadcastAddBtns"), { parse_mode: "Markdown" });
        return;
      }

      if (action === "cancel") {
        clearState(userId);
        setState(userId, { lang });
        await ctx.reply(t(lang, "msg.cancelled"), { reply_markup: getAdminKeyboard(lang) });
        return;
      }
      return;
    }

    if (data.startsWith("setlang:")) {
      const newLang = data.split(":")[1];
      if (!["ru", "uk", "en"].includes(newLang)) return;
      setState(userId, { lang: newLang });
      await User.updateOne({ userId }, { $set: { lang: newLang, langSet: true } });
      try { await ctx.editMessageReplyMarkup(); } catch {}
      await ctx.reply(t(newLang, "msg.langChanged"), { reply_markup: getSettingsKeyboard(newLang) });
      return;
    }

    // ── Review callbacks ──────────────────────────────────────────────────
    if (data === "review:start") {
      setState(userId, { mode: "review" });
      await ctx.reply(t(lang, "msg.reviewPrompt"), { parse_mode: "Markdown" });
      return;
    }

    // ── Admin: view reviews ────────────────────────────────────────────────
    if (data.startsWith("admin_reviews:") && userId === ADMIN_ID) {
      const mode = data.split(":")[1]; // "all" | "last5"
      const reviews = mode === "last5"
        ? await Review.find().sort({ createdAt: -1 }).limit(5)
        : await Review.find().sort({ createdAt: -1 });

      if (!reviews.length) {
        await ctx.reply(t(lang, "msg.reviewsEmpty"));
        return;
      }

      // Split into chunks to avoid Telegram message length limit
      const CHUNK = 10;
      for (let i = 0; i < reviews.length; i += CHUNK) {
        const chunk = reviews.slice(i, i + CHUNK);
        let text = i === 0 ? t(lang, "msg.reviewsHeader", { count: reviews.length }) : "";
        for (const r of chunk) {
          const date = new Date(r.createdAt).toLocaleDateString("ru-RU");
          text += t(lang, "msg.reviewItem", {
            name: escMd(r.userName),
            id: r.userId,
            date,
            text: escMd(r.text),
          }) + "\n\n";
        }
        await ctx.reply(text.trim(), { parse_mode: "Markdown" });
      }
      return;
    }

    // ── Gift chat callbacks ────────────────────────────────────────────────
    if (data.startsWith("gift:")) {
      const action = data.split(":")[1];

      if (action === "auto") {
        await ctx.reply(t(lang, "msg.giftChatThink"));
        try {
          const { reply, history } = await startGiftChat(userId);
          setState(userId, { mode: "gift_chat", giftHistory: history, lastGiftMsg: reply });
          await ctx.reply(reply, {
            reply_markup: new InlineKeyboard()
              .text(t(lang, "ibtn.gift.another"), "gift:another").row()
              .text(t(lang, "ibtn.gift.save"), "gift:save")
              .text(t(lang, "ibtn.gift.close"), "gift:close"),
          });
        } catch (e) {
          console.error("gift:auto error:", e.message);
          await ctx.reply(t(lang, "msg.giftChatError"));
        }
        return;
      }

      if (action === "another") {
        await ctx.reply(t(lang, "msg.giftChatThink"));
        try {
          const history = s.giftHistory ?? [];
          const { reply, history: newHistory } = await continueGiftChat(history, "Please suggest a completely different gift option.");
          setState(userId, { giftHistory: newHistory, lastGiftMsg: reply });
          await ctx.reply(reply, {
            reply_markup: new InlineKeyboard()
              .text(t(lang, "ibtn.gift.another"), "gift:another").row()
              .text(t(lang, "ibtn.gift.save"), "gift:save")
              .text(t(lang, "ibtn.gift.close"), "gift:close"),
          });
        } catch (e) {
          console.error("gift:another error:", e.message);
          await ctx.reply(t(lang, "msg.giftChatError"));
        }
        return;
      }

      if (action === "save") {
        const lastMsg = s.lastGiftMsg;
        if (!lastMsg) { await ctx.reply(t(lang, "msg.error")); return; }
        try {
          const product = await extractGiftProduct(lastMsg);
          if (!product || !product.title) { await ctx.reply(t(lang, "msg.giftChatError")); return; }
          const buyerId = await getBuyerId(userId);
          const wish = new Wish({
            id: generateId(),
            ownerId: userId,
            buyerId: buyerId ?? null,
            title: product.title,
            link: product.url ?? "",
            price: product.price ?? t(lang, "msg.priceUnknown"),
            photoFileId: null,
            photoUrl: null,
            priority: 2,
            status: "new",
            noteFromBuyer: "",
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          await wish.save();
          clearState(userId);
          setState(userId, { lang });
          await ctx.reply(t(lang, "msg.gift.saved"), { reply_markup: await getMainKeyboard(userId) });
        } catch (e) {
          console.error("gift:save error:", e.message);
          await ctx.reply(t(lang, "msg.error"));
        }
        return;
      }

      if (action === "close") {
        clearState(userId);
        setState(userId, { lang });
        await ctx.reply(t(lang, "msg.menu"), { reply_markup: await getMainKeyboard(userId) });
        return;
      }
      return;
    }
  } catch (e) {
    console.error("callback_query error:", e.message ?? e);
    try {
      const errLang = getLang(String(ctx.from.id));
      await ctx.reply(t(errLang, "msg.buttonError"), { reply_markup: await getMainKeyboard(String(ctx.from.id)) });
    } catch {}
  }
});

// ─── Global error handler ────────────────────────────────────────────────
// ─── Telegram Stars payments ──────────────────────────────────────────────
bot.on("pre_checkout_query", async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on("message:successful_payment", async (ctx) => {
  const lang = getLang(String(ctx.from.id));
  const stars = ctx.message.successful_payment.total_amount;
  await ctx.reply(t(lang, "msg.donateThankYou", { stars }));
});

bot.catch((err) => {
  console.error("=== BOT ERROR ===", err.error);
});

// ─── Start ────────────────────────────────────────────────────────────────
console.log("Wishlist bot starting...");
await connectDB();

async function startBot(attempt = 1) {
  try {
    await bot.start({
      onStart: (info) => { BOT_USERNAME = info.username; console.log(`Bot @${info.username} is running!`); },
      drop_pending_updates: true,
    });
  } catch (e) {
    if (e.error_code === 409) {
      const delay = Math.min(attempt * 5000, 30000);
      console.log(`409 Conflict (attempt ${attempt}), retrying in ${delay / 1000}s...`);
      setTimeout(() => startBot(attempt + 1), delay);
    } else {
      console.error("Fatal bot error:", e);
      process.exit(1);
    }
  }
}
startBot();
