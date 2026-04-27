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

// Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

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
   GEMINI AI
========================= */

// Son N mesajı örnek olarak context'e ekle
function buildContextSamples(n = 30) {
  if (memory.length === 0) return "";
  const usable = memory.slice(Math.max(0, memory.length - RECENT_EXCLUDE - 1), memory.length - RECENT_EXCLUDE);
  if (usable.length === 0) return "";
  const sample = usable.slice(-n);
  return sample.join("\n");
}

/**
 * Gemini'ye istek at.
 * @param {string} userMessage  - kullanıcının mesajı (mention/reply için)
 * @param {boolean} isRandom    - true ise rastgele mesaj üret (mention yok)
 * @returns {Promise<string|null>}
 */
async function askGemini(userMessage = null, isRandom = false) {
  if (!GEMINI_API_KEY) return null;

  const contextSamples = buildContextSamples(300);

  // System talimatı: sunucunun tonunu öğret
  const systemInstruction = `Sen bir Discord sunucusunda konuşan bir Türk gençsin. 
Sunucunun genel konuşma tarzını benimsiyorsun: kısa, samimi, bazen argo, internet slang kullanıyorsun.
Emoji kullanabilirsin ama abartma. Çok uzun cevaplar verme (1-3 cümle yeterli).
Dini hakaretler veya ırk ayrımcılığı içeren hiçbir şey söyleme.
Markdown kullanma (bold, italik, kod bloğu yok).
Aşağıda sunucudan örnek mesajlar var, bu tona yakın konuş:

--- ÖRNEK MESAJLAR ---
${contextSamples || "(henüz yok)"}
--- /ÖRNEK MESAJLAR ---`;

  let prompt;
  if (isRandom) {
    prompt = "Sunucuya kısa, random bir şey yaz. Kendi kendine bir şey söyle, soru sorma.";
  } else {
    prompt = userMessage || "Merhaba";
  }

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 120,
      temperature: 0.95,
      topP: 0.9,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ],
  };

  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      15000
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[GEMINI] HTTP ${res.status}:`, errText.slice(0, 200));
      return null;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;

    // Dini hakaret filtrele
    if (containsReligiousAbuse(text)) return null;

    return text;
  } catch (e) {
    console.error("[GEMINI] Error:", e?.name, e?.message?.slice(0, 100));
    return null;
  }
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
function handleSimpleChoiceQuestion(text) {
  const cleanText = text.replace(/<@!?(\d+)>/g, "").trim();
  if (!cleanText) return null;

  const match = cleanText.match(/(.+?)\s+(m[ıiuü])\s+(.+?)\s+(m[ıiuü])/i);
  if (match) {
    return Math.random() < 0.5 ? match[1].trim() : match[3].trim();
  }

  const match2 = cleanText.match(/(.+?)\s+yoksa\s+(.+?)\s*[?]*$/i);
  if (match2) {
    return Math.random() < 0.5 ? match2[1].trim() : match2[2].trim();
  }

  const match3 = cleanText.match(/(.+?)\s+veya\s+(.+?)\s*[?]*$/i);
  if (match3) {
    return Math.random() < 0.5 ? match3[1].trim() : match3[2].trim();
  }

  if (cleanText.match(/evet\s+(m[ıiuü])\s+hayır\s+(m[ıiuü])/i)) {
    return Math.random() < 0.5 ? "evet" : "hayır";
  }

  return null;
}

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
  if (!GEMINI_API_KEY) {
    console.warn("[GEMINI] UYARI: GEMINI_API_KEY tanımlı değil! Fallback kullanılacak.");
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

    // === DM → admin mesajını kanala yönlendir ===
    if (message.guild === null && message.author.id === ADMIN_USER_ID) {
      console.log(`DM from admin: ${content}`);
      const targetChannel = await client.channels.fetch(SEED_CHANNEL_ID);
      if (targetChannel?.isTextBased()) await targetChannel.send(content);
      return;
    }

    const lower = content.toLowerCase();

    // === *gökhan (Roblox status) ===
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

    // === *gökhanraw (admin debug) ===
    if ((lower === "*gökhanraw" || lower === "*gokhanraw") && message.author.id === ADMIN_USER_ID) {
      const status = await fetchRobloxStatus();
      await message.reply("```json\n" + JSON.stringify(status?.raw ?? null, null, 2).slice(0, 1800) + "\n```");
      return;
    }

    // === ADMIN KOMUTLARI ===
    if (message.author.id === ADMIN_USER_ID) {
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

      // Gemini test komutu
      if (lower === "*gemini test") {
        const out = await askGemini("Merhaba, nasılsın?", false);
        await message.reply(out ? `✅ Gemini: ${out}` : "❌ Gemini yanıt vermedi (key kontrol et)");
        return;
      }
    }

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
      // Seçim sorusu var mı?
      const choiceAnswer = handleSimpleChoiceQuestion(content);
      if (choiceAnswer) { await message.reply(choiceAnswer); return; }

      // Gemini ile cevapla
      const cleanContent = content.replace(/<@!?\d+>/g, "").trim();
      const out = await askGemini(cleanContent || "ne düşünüyorsun", false) || randomSentence();
      await message.reply(out);
      return;
    }

    // === BOT MESAJINA REPLY ===
    if (
      message.reference &&
      message.mentions.repliedUser?.id === client.user.id &&
      Math.random() < REPLY_RESPONSE_CHANCE
    ) {
      const choiceAnswer = handleSimpleChoiceQuestion(content);
      if (choiceAnswer) { await message.reply(choiceAnswer); return; }

      const out = await askGemini(content, false) || randomSentence();
      await message.reply(out);
      return;
    }

    // === RASTGELE MESAJ ===
    messageCounter++;
    if (messageCounter >= nextMessageTarget) {
      messageCounter = 0;
      nextMessageTarget = Math.floor(Math.random() * 31) + 20;

      const out = await askGemini(null, true) || randomSentence();
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
