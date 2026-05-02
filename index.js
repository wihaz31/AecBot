require("dotenv").config();

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const http = require("http");
const { URL } = require("url");
const { Client, GatewayIntentBits } = require("discord.js");

/* =========================
   AYARLAR
========================= */
const SEED_CHANNEL_ID = "705537838770421761";

const SEED_DAYS = 240;
const SEED_MAX = 40000;

const MAX_MEMORY_MESSAGES = 40000;
const RECENT_EXCLUDE = 100;

let messageCounter = 0;
let nextMessageTarget = Math.floor(Math.random() * 31) + 20; // 20–50

const REPLY_RESPONSE_CHANCE = 1;
const MENTION_RESPONSE_CHANCE = 1;

// Reaction ayarları
let reactionsEnabled = false;
const ADMIN_USER_ID = "297433660553035778";
const TARGET_USER_ID = "403940186494599168";
const EMOJI_1 = "🪑";
const EMOJI_2 = "🪢";

// HTTP / CMD
const PORT = process.env.PORT || 8000;
const CMD_KEY = process.env.CMD_KEY || "";

// Roblox
const ROBLOX_USER_ID = "2575829815";

// Groq
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = "llama-3.3-70b-versatile";

/* =========================
   SEED DURUMU
========================= */
const seedState = {
  running: false,
  done: false,
  error: null,
  channelName: null,
  days: SEED_DAYS,
  max: SEED_MAX,
  collected: 0,
  fetchCount: 0,
  startedAt: null,
  lastUpdateAt: null,
};

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = s % 60;
  const mm = m % 60;
  if (h > 0) return `${h}saat ${mm}dk ${ss}sn`;
  if (m > 0) return `${m}dk ${ss}sn`;
  return `${ss}sn`;
}

/* =========================
   HAFIZA
========================= */
const memory = [];
const MAX_WORDS_PER_MESSAGE = 40;
const memorySet = new Set();
const botRecentSet = new Set();
const BOT_RECENT_LIMIT = 200;

// Botun kendi cevabını hem memory'ye hem context'e ekle
function rememberBotOutput(text) {
  if (!text || text.length < 3) return;

  // Ana hafızaya ekle — bağlantı kurabilsin diye
  memory.push(text);
  memorySet.add(normalizeText(text));
  if (memory.length > MAX_MEMORY_MESSAGES) {
    const removed = memory.shift();
    memorySet.delete(normalizeText(removed));
  }

  // Tekrar filtresi için ayrı set
  botRecentSet.add(normalizeText(text));
  if (botRecentSet.size > BOT_RECENT_LIMIT) {
    const first = botRecentSet.values().next().value;
    botRecentSet.delete(first);
  }
}

/* =========================
   FALLBACK WORD POOL
========================= */
const WORD_POOL = [
  "aga","kanka","bro","reis","moruk","abi","hocam","sal","boşver","takıl",
  "trip","cringe","based","random","kaos","efsane","rezalet","offfff",
  "aynen","yokartık","şaka mı","noluyo","ne alaka","ciddiyim",
  "lol","lmao","wtf","idk","imo","fr","no cap","cap","sheesh",
  "mid","npc","lowkey","skill issue","touch grass",
  "gg","ez","ff","go next","tryhard","toxic","hardstuck",
];

/* =========================
   DİN + KÜFÜR ENGELİ
========================= */
function foldTR(s) {
  return (s || "")
    .toLowerCase()
    .replace(/ı/g, "i").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ş/g, "s").replace(/ö/g, "o").replace(/ç/g, "c");
}

function squash(s) {
  return foldTR(s)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<@!?(\d+)>/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RELIGIOUS_TERMS = [
  "allah","tanri","peygamber","muhammed","4ll4h",
  "kuran","kur an","allanı","muhammedini","peygamberini",
].map(squash);

const SWEAR_TERMS = [
  "amk","aq","amq","o c","oc","sik","s1k","s*k","sikeyim","siktir",
  "orospu","pic","piç","anan","bacini","got","g0t","yarrak","yarak",
  "ibne","kahpe"
].map(squash);

function containsReligiousAbuse(text) {
  const t = squash(text);
  if (!t) return false;
  const hasRel = RELIGIOUS_TERMS.some((r) => t.includes(r));
  if (!hasRel) return false;
  return SWEAR_TERMS.some((w) => t.includes(w));
}

/* =========================
   FETCH TIMEOUT HELPER
========================= */
async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* =========================
   KANAL GEÇMİŞİ (son N mesaj)
========================= */
async function fetchRecentHistory(channel, limit = 10) {
  try {
    const msgs = await channel.messages.fetch({ limit: limit + 1 });
    return Array.from(msgs.values())
      .reverse()
      .slice(0, limit)
      .map(m => ({
        isBot: m.author.id === client.user?.id,
        username: m.author.username || "biri",
        content: (m.content || "").replace(/<@!?\d+>/g, "").trim(),
      }))
      .filter(m => m.content.length > 0);
  } catch (e) {
    console.warn("[HISTORY] fetch hatası:", e?.message?.slice(0, 60));
    return [];
  }
}

/* =========================
   GROQ AI
========================= */

function buildContextSamples(n = 300) {
  if (memory.length === 0) return "";
  const usable = memory.slice(Math.max(0, memory.length - RECENT_EXCLUDE - 1), memory.length - RECENT_EXCLUDE);
  if (usable.length === 0) return "";
  return usable.slice(-n).join("\n");
}

async function askAI(userMessage = null, isRandom = false, recentHistory = []) {
  if (!GROQ_API_KEY) return null;

  const contextSamples = buildContextSamples(300);

  const systemPrompt = `Sen bir Türk Discord sunucusunun sıradan bir üyesisin. Arkadaşlarınla sohbet ediyorsun.

ZORUNLU KURALLAR:
- Emoji YAZMA. Hiç. Bir tane bile.
- Yıldız, backtick, alt çizgi gibi markdown karakterleri YAZMA.
- Maksimum 1 cümle yaz. Uzun cevap verme.
- "Tabii", "Elbette", "Merhaba", "Yardımcı olabilirim" YAZMA.
- Dini hakaret ve ırkçılık YAZMA.
- Soru SORMA.
- Konuyla alakasız şey YAZMA. Ne sorulduysa ona cevap ver.
- Eğer mesaj anlamsız karakter dizisiyse (ASDFGH gibi) kısa ve alaycı bir şey söyle.

TON: Kısa, samimi, sokak dili, argo olabilir.

ÖRNEK KONUŞMALAR (bu tonda yaz):
${contextSamples || "(yok)"}`;

  const userPrompt = isRandom ? "Kanalda biri birşey yazdı, sen de kısa bir şey söyle." : (userMessage || "naber");

  // Son mesajları sohbet geçmişi olarak tek user mesajı şeklinde gönder
  // Groq'un kimin ne dediğini anlaması için isim ekle
  const historyText = recentHistory
    .map(h => `${h.isBot ? "Sen" : h.username}: ${h.content}`)
    .join("\n");
  const historyMessages = historyText
    ? [{ role: "user", content: `Son konuşmalar:\n${historyText}` },
       { role: "assistant", content: "tamam" }]
    : [];

  const body = {
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user", content: userPrompt },
    ],
    max_tokens: 120,
    temperature: 0.95,
    top_p: 0.9,
  };

  const RETRY_DELAYS = [2000, 4000];

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${GROQ_API_KEY}`,
          },
          body: JSON.stringify(body),
        },
        15000
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if ((res.status === 503 || res.status === 429) && attempt < RETRY_DELAYS.length) {
          console.warn(`[GROQ] ${res.status} - retry ${attempt + 1}`);
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        console.error(`[GROQ] HTTP ${res.status}:`, errText.slice(0, 200));
        return null;
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) return null;

      if (containsReligiousAbuse(text)) return null;

      const cleaned = text
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
        .replace(/[\u{2600}-\u{27BF}]/gu, "")
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, "")
        .replace(/\*+|`+|_{2,}/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();

      if (!cleaned) return null;

      // Sadece açık reddetme kalıpları — çok geniş tutma
      const refusalPatterns = [
        "cevap veremem", "cevap vermem",
        "bilgi bulunmuyor", "bilgi yok", "bilmiyorum",
        "i cannot", "i can't", "i'm unable", "i won't", "i will not",
        "as an ai", "as a language model",
      ];
      if (refusalPatterns.some(p => cleaned.toLowerCase().includes(p))) return null;

      return cleaned;

    } catch (e) {
      if (attempt < RETRY_DELAYS.length) {
        console.warn(`[GROQ] Hata, retry: ${e?.name}`);
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      console.error("[GROQ] Error:", e?.name, e?.message?.slice(0, 100));
      return null;
    }
  }

  return null;
}

/* =========================
   FALLBACK: basit kelime üret (Gemini çalışmazsa)
========================= */
function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomSentence() {
  const len = Math.floor(Math.random() * 4) + 3;
  const words = [];
  for (let i = 0; i < len; i++) words.push(randomFrom(WORD_POOL));
  return words.join(" ");
}

/* =========================
   BASIT SEÇIM SORUSU (Türkçe)
========================= */

/* =========================
   ROBLOX (cache + presence)
========================= */
const placeNameCache = new Map();
const universeNameCache = new Map();
const ROBLOX_CACHE_MS = 10 * 60 * 1000;

async function fetchRobloxPlaceName(placeId) {
  if (!placeId) return null;
  const key = String(placeId);
  const cached = placeNameCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.name;

  try {
    const r = await fetchWithTimeout(
      `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${Number(placeId)}`,
      {},
      12000
    );
    if (!r.ok) return null;
    const arr = await r.json();
    const name = arr?.[0]?.name || null;
    placeNameCache.set(key, { name, exp: Date.now() + ROBLOX_CACHE_MS });
    return name;
  } catch (e) {
    console.error("Roblox place name error:", e?.name);
    return null;
  }
}

async function fetchRobloxUniverseName(universeId) {
  if (!universeId) return null;
  const key = String(universeId);
  const cached = universeNameCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.name;

  try {
    const r = await fetchWithTimeout(
      `https://games.roblox.com/v1/games?universeIds=${Number(universeId)}`,
      {},
      12000
    );
    if (!r.ok) return null;
    const data = await r.json();
    const name = data?.data?.[0]?.name || null;
    universeNameCache.set(key, { name, exp: Date.now() + ROBLOX_CACHE_MS });
    return name;
  } catch (e) {
    console.error("Roblox universe name error:", e?.name);
    return null;
  }
}

// thumbnails API'si üzerinden universe ID çek (placeId'den)
async function fetchUniverseIdFromPlace(placeId) {
  if (!placeId) return null;
  try {
    const r = await fetchWithTimeout(
      `https://apis.roblox.com/universes/v1/places/${Number(placeId)}/universe`,
      {},
      12000
    );
    if (!r.ok) return null;
    const data = await r.json();
    return data?.universeId || null;
  } catch (e) {
    console.error("Roblox universe-from-place error:", e?.name);
    return null;
  }
}

async function fetchRobloxStatus() {
  try {
    const r = await fetchWithTimeout(
      "https://presence.roblox.com/v1/presence/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: [Number(ROBLOX_USER_ID)] }),
      },
      12000
    );

    if (!r.ok) return null;

    const data = await r.json();
    const p = data?.userPresences?.[0];
    if (!p) return null;

    const presenceType = p.userPresenceType;
    const placeId = p.placeId || null;
    let universeId = p.universeId || null;
    const lastLocation = (p.lastLocation || "").trim() || null;

    // universeId yoksa placeId'den türet
    if (!universeId && placeId) {
      universeId = await fetchUniverseIdFromPlace(placeId);
    }

    let gameName = null;
    if (placeId) gameName = await fetchRobloxPlaceName(placeId);
    if (!gameName && universeId) gameName = await fetchRobloxUniverseName(universeId);
    if (!gameName && lastLocation) gameName = lastLocation;

    return { presenceType, placeId, universeId, lastLocation, gameName, raw: p };
  } catch (e) {
    console.error("Roblox status error:", e?.name);
    return null;
  }
}

/* =========================
   SEED
========================= */
function normalizeText(s) {
  return (s || "").toLowerCase().trim().replace(/\s+/g, " ").replace(/[.?!…]+$/g, "");
}

async function seedByDays(channel, days = SEED_DAYS, maxMessages = SEED_MAX) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const collected = [];
  let beforeId = undefined;

  seedState.running = true;
  seedState.done = false;
  seedState.error = null;
  seedState.channelName = channel?.name || null;
  seedState.days = days;
  seedState.max = maxMessages;
  seedState.collected = 0;
  seedState.fetchCount = 0;
  seedState.startedAt = Date.now();
  seedState.lastUpdateAt = seedState.startedAt;

  const startedAt = seedState.startedAt;
  let lastLogAt = startedAt;
  let lastBeat = 0;

  const beat = (tag, extra = "") => {
    const now = Date.now();
    if (now - lastBeat >= 5000) {
      lastBeat = now;
      console.log(`[SEED] ${tag} fetch=${seedState.fetchCount} collected=${collected.length} ${extra}`);
    }
  };

  const logProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastLogAt < 5000) return;
    lastLogAt = now;
    const elapsedMs = now - startedAt;
    const elapsedSec = Math.max(1, Math.floor(elapsedMs / 1000));
    const rate = Math.round(collected.length / elapsedSec);
    console.log(`Seed progress: ${collected.length}/${maxMessages} | fetch=${seedState.fetchCount} | ${formatDuration(elapsedMs)} | ~${rate} msg/sn`);
    seedState.collected = collected.length;
    seedState.lastUpdateAt = now;
  };

  console.log(`Seed başladı: son ${days} gün, max ${maxMessages} mesaj (#${channel.name})`);

  while (collected.length < maxMessages) {
    await new Promise((r) => setImmediate(r));

    const batchSize = Math.min(100, maxMessages - collected.length);
    const opts = { limit: batchSize };
    if (beforeId) opts.before = beforeId;

    beat("before-fetch", `beforeId=${beforeId ?? "none"}`);

    let msgs;
    try {
      msgs = await Promise.race([
        channel.messages.fetch(opts),
        (async () => { await sleep(20000); throw new Error("SEED_FETCH_TIMEOUT_20S"); })(),
      ]);
    } catch (e) {
      const retryAfter = e?.data?.retry_after ?? e?.retry_after ?? e?.rawError?.retry_after ?? null;
      if (retryAfter) {
        const waitMs = Math.ceil(Number(retryAfter) * 1000) + 750;
        console.log(`[SEED] RATE LIMIT: ${retryAfter}s -> bekliyorum...`);
        await sleep(waitMs);
        continue;
      }
      if ((e?.message || "").includes("SEED_FETCH_TIMEOUT_20S")) {
        console.log("[SEED] timeout, retry...");
        await sleep(3000);
        continue;
      }
      seedState.error = e?.message || String(e);
      seedState.running = false;
      seedState.done = false;
      console.error("[SEED] FETCH ERROR:", e?.name, e?.message);
      return;
    }

    seedState.fetchCount++;
    beat("after-fetch", `size=${msgs?.size ?? 0}`);

    if (!msgs || msgs.size === 0) break;

    const arr = Array.from(msgs.values()).reverse();
    let reachedCutoff = false;

    for (const m of arr) {
      if (m.createdTimestamp < cutoff) { reachedCutoff = true; break; }
      if (m.author.bot) continue;
      const t = (m.content || "").trim();
      if (!t) continue;
      if (containsReligiousAbuse(t)) continue;
      collected.push(t);
      if (collected.length >= maxMessages) break;
    }

    if (seedState.fetchCount % 10 === 0) logProgress(true);
    else logProgress(false);

    if (reachedCutoff) break;

    beforeId = msgs.last().id;
    await sleep(350);
  }

  memory.length = 0;
  memory.push(...collected);
  while (memory.length > MAX_MEMORY_MESSAGES) memory.shift();

  memorySet.clear();
  for (const t of memory) memorySet.add(normalizeText(t));

  logProgress(true);
  seedState.running = false;
  seedState.done = true;
  seedState.error = null;

  console.log(`Seed tamam ✅ Hafıza: ${memory.length} mesaj (#${channel.name})`);
}

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

async function onClientReady() {
  console.log(`Bot aktif: ${client.user.tag}`);
  if (!GROQ_API_KEY) {
    console.warn("[GROQ] UYARI: GROQ_API_KEY tanımlı değil! Fallback kullanılacak.");
  }

  try {
    const ch = await client.channels.fetch(SEED_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) { console.log("Seed: Kanal bulunamadı."); return; }
    console.log(`Seed: Kanal bulundu -> #${ch.name}`);
    await seedByDays(ch, SEED_DAYS, SEED_MAX);
  } catch (e) {
    console.error("Seed error:", e);
  }
}

client.once("ready", onClientReady);
client.once("clientReady", onClientReady);

/* =========================
   HTTP SERVER
========================= */
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const path = u.pathname;

    if (path === "/") { res.writeHead(200); return res.end("OK"); }

    if (path === "/cmd") {
      const key = u.searchParams.get("key") || "";
      if (!CMD_KEY || key !== CMD_KEY) { res.writeHead(401); return res.end("unauthorized"); }

      const action = (u.searchParams.get("action") || "").toLowerCase();

      if (action === "reaction_off") { reactionsEnabled = false; res.writeHead(200); return res.end("ok"); }
      if (action === "reaction_on")  { reactionsEnabled = true;  res.writeHead(200); return res.end("ok"); }

      if (action === "say") {
        const text = u.searchParams.get("text") || "";
        if (!text.trim()) { res.writeHead(400); return res.end("missing text"); }
        if (!client?.isReady?.()) { res.writeHead(503); return res.end("not ready"); }
        const ch = await client.channels.fetch(SEED_CHANNEL_ID);
        if (!ch?.isTextBased()) { res.writeHead(404); return res.end("no channel"); }
        await ch.send(text);
        res.writeHead(200); return res.end("sent");
      }

      if (action === "seed_status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(seedState, null, 2));
      }

      res.writeHead(400); return res.end("unknown action");
    }

    res.writeHead(404); res.end("not found");
  } catch (e) {
    res.writeHead(500); res.end("error");
  }
}).listen(PORT, () => console.log(`HTTP server on ${PORT}`));

/* =========================
   MESSAGE HANDLER
========================= */
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const content = (message.content || "").trim();

    const lower = content.toLowerCase();
    const isDM = message.guild === null;
    const isAdmin = message.author.id === ADMIN_USER_ID;

    // === *gökhan (Roblox status) — DM veya sunucudan çalışır ===
    if (lower === "*gökhan" || lower === "*gokhan") {
      const status = await fetchRobloxStatus();
      if (!status) { await message.reply("Roblox durumu çekemedim."); return; }

      if (status.presenceType === 0) { await message.reply("offline."); return; }
      if (status.presenceType === 3) { await message.reply("Gökhan Studio'da nabıyon aq."); return; }

      if (status.presenceType === 2) {
        let gameText = status.gameName;
        if (!gameText) {
          gameText = status.lastLocation ||
            (status.placeId ? `placeId: ${status.placeId}` : null) ||
            (status.universeId ? `universeId: ${status.universeId}` : null) ||
            "Roblox oyun bilgisi yok (privacy kapalı olabilir)";
        }
        await message.reply(`Gökhan yine Robloxta aq.\nOyun: ${gameText}`);
        return;
      }

      await message.reply("online.");
      return;
    }

    // === *gökhanraw (admin debug) — DM veya sunucudan ===
    if ((lower === "*gökhanraw" || lower === "*gokhanraw") && isAdmin) {
      const status = await fetchRobloxStatus();
      await message.reply("```json\n" + JSON.stringify(status?.raw ?? null, null, 2).slice(0, 1800) + "\n```");
      return;
    }

    // === ADMIN KOMUTLARI — DM veya sunucudan çalışır ===
    if (isAdmin) {
      if (lower === "*reaction off") { reactionsEnabled = false; await message.reply("⛔ Reaction kapalı"); return; }
      if (lower === "*reaction on")  { reactionsEnabled = true;  await message.reply("✅ Reaction açık");  return; }
      if (lower === "*reaction status") { await message.reply(reactionsEnabled ? "✅ AÇIK" : "⛔ KAPALI"); return; }

      if (lower === "*seed status") {
        if (!seedState.startedAt) { await message.reply("Seed başlamadı."); return; }
        const elapsed = Date.now() - seedState.startedAt;
        const rate = Math.round(seedState.collected / Math.max(1, elapsed / 1000));
        const st = seedState.running ? "⏳ ÇALIŞIYOR" : seedState.done ? "✅ TAMAMLANDI" : seedState.error ? "❌ HATA" : "⏸️ DURDU";
        await message.reply([
          `Seed: ${st}`,
          `Kanal: #${seedState.channelName ?? "?"}`,
          `Toplandı: ${seedState.collected}/${seedState.max}`,
          `Fetch: ${seedState.fetchCount}`,
          `Süre: ${formatDuration(elapsed)} (~${rate} msg/sn)`,
          seedState.error ? `Hata: ${seedState.error}` : null,
        ].filter(Boolean).join("\n"));
        return;
      }

      if (lower === "*ai test") {
        const out = await askAI("Merhaba, nasılsın?", false);
        await message.reply(out ? `✅ Groq: ${out}` : "❌ Groq yanıt vermedi (key kontrol et)");
        return;
      }

      if (lower === "*yardim" || lower === "*help") {
        await message.reply([
          "**Admin Komutları:**",
          "`*reaction on/off/status` — reaction aç/kapat",
          "`*seed status` — seed durumu",
          "`*ai test` — Groq bağlantısını test et",
          "`*gökhan` — Roblox durumu",
          "`*gökhanraw` — Roblox ham veri",
          "`*yardim` — bu liste",
          "",
          "DM'den yazılan diğer mesajlar kanala yönlendirilir.",
        ].join("\n"));
        return;
      }

      // Komut değilse (* ile başlamıyorsa) → kanala yönlendir
      if (isDM && !lower.startsWith("*")) {
        console.log(`DM from admin: ${content}`);
        const targetChannel = await client.channels.fetch(SEED_CHANNEL_ID);
        if (targetChannel?.isTextBased()) await targetChannel.send(content);
        return;
      }
    }

    // Admin olmayan DM'leri yoksay
    if (isDM) return;

    // === HAFIZA GÜNCELLEME (seed kanalı) ===
    if (message.channel.id === SEED_CHANNEL_ID && content.length > 0) {
      if (!containsReligiousAbuse(content)) {
        memory.push(content);
        memorySet.add(normalizeText(content));
        if (memory.length > MAX_MEMORY_MESSAGES) {
          const removed = memory.shift();
          memorySet.delete(normalizeText(removed));
        }
      }
    }

    // === @MENTION CEVAP ===
    if (message.mentions.has(client.user) && Math.random() < MENTION_RESPONSE_CHANCE) {
      const cleanContent = content.replace(/<@!?\d+>/g, "").trim();
      const recentHistory = await fetchRecentHistory(message.channel, 10);
      const out = await askAI(cleanContent || "ne düşünüyorsun", false, recentHistory) || randomSentence();
      rememberBotOutput(out);
      await message.reply(out);
      return;
    }

    // === BOT MESAJINA REPLY ===
    if (
      message.reference &&
      message.mentions.repliedUser?.id === client.user.id &&
      Math.random() < REPLY_RESPONSE_CHANCE
    ) {
      const recentHistory = await fetchRecentHistory(message.channel, 10);
      const out = await askAI(content, false, recentHistory) || randomSentence();
      rememberBotOutput(out);
      await message.reply(out);
      return;
    }

    // === RASTGELE MESAJ ===
    messageCounter++;
    if (messageCounter >= nextMessageTarget) {
      messageCounter = 0;
      nextMessageTarget = Math.floor(Math.random() * 31) + 20;

      const out = await askAI(null, true) || randomSentence();
      rememberBotOutput(out);
      await message.channel.send(out);
    }

    // === REACTION ===
    if (!reactionsEnabled) return;
    if (message.author.id !== TARGET_USER_ID) return;

    const has1 = message.reactions.cache.some((r) => r.emoji.name === EMOJI_1);
    const has2 = message.reactions.cache.some((r) => r.emoji.name === EMOJI_2);
    if (!has1) await message.react(EMOJI_1);
    if (!has2) await message.react(EMOJI_2);

  } catch (e) {
    console.error(e);
  }
});

/* =========================
   LOGIN
========================= */
console.log("Discord login başlıyor... token var mı?", Boolean(process.env.DISCORD_TOKEN));

client.on("error",   (e) => console.error("Discord error:",  e));
client.on("shardError", (e) => console.error("Shard error:", e));
process.on("unhandledRejection", (e) => console.error("UnhandledRejection:", e));
process.on("uncaughtException",  (e) => console.error("UncaughtException:",  e));

client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log("Discord login OK"))
  .catch((e) => console.error("Discord login FAIL:", e));
