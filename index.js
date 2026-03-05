require("dotenv").config();

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first"); // Discord WS için sık fix

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
const ROBLOX_USER_ID = "2575829815"; // sayı string de olur

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
   HAFIZA + BENZERLİK ENGELLEME
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
  "smurf","boosted","nerf","buff",
  "yasuo","yone","zed","akali","lee sin","viego","ahri","jinx","caitlyn",
  "thresh","lux","riven","faker","keria","gumayusi",
  "soloQ","ranked","normal","aram",
  "midlane","toplane","botlane","jungle","support",
  "gank","outplay","int","feed","carry","snowball","oneshot","burst",
  "kite","peel","macro","micro","meta",
  "bronze","silver","gold","emerald","diamond","master","challenger",
];

/* =========================
   SADECE "DİN + KÜFÜR" ENGELİ
========================= */
function foldTR(s) {
  return (s || "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
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
  "allah","tanri","peygamber","muhammed","4ll4h","4LLL4H12N1S1KEY1M",
  "kuran","kur an","allanı","muhammedini","peygamberini",
  "kitabını","kitabini","allahuınukşitabını","allahuinukşitabini",
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
  const hasSwear = SWEAR_TERMS.some((w) => t.includes(w));
  if (!hasSwear) return false;
  return true;
}

/* =========================
   FETCH TIMEOUT HELPER
========================= */
async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* =========================
   ROBLOX (cache + fallback)
========================= */
const placeNameCache = new Map(); // placeId -> { name, exp }
const universeNameCache = new Map(); // universeId -> { name, exp }
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
    console.error("Roblox place name error:", e?.name || e);
    return null;
  }
}

async function fetchRobloxUniverseName(universeId) {
  if (!universeId) return null;
  const key = String(universeId);
  const cached = universeNameCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.name;

  try {
    // games endpoint universeIds ile isim dönebiliyor
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
    console.error("Roblox universe name error:", e?.name || e);
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

    const presenceType = p.userPresenceType; // 0=offline,1=online,2=in game,3=in studio
    const placeId = p.placeId || null;
    const universeId = p.universeId || null;
    const lastLocation = (p.lastLocation || "").trim() || null;

    // Öncelik: placeId -> universeId -> lastLocation
    let gameName = null;
    if (placeId) gameName = await fetchRobloxPlaceName(placeId);
    if (!gameName && universeId) gameName = await fetchRobloxUniverseName(universeId);
    if (!gameName && lastLocation) gameName = lastLocation;

    return {
      presenceType,
      placeId,
      universeId,
      lastLocation,
      gameName,
      raw: p,
    };
  } catch (e) {
    console.error("Roblox status error:", e?.name || e);
    return null;
  }
}

/* =========================
   YARDIMCILAR
========================= */
function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomSentence() {
  const len = Math.floor(Math.random() * 6) + 5; // 5–10
  const words = [];
  for (let i = 0; i < len; i++) words.push(randomFrom(WORD_POOL));
  let s = words.join(" ");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  s += Math.random() < 0.2 ? "..." : ".";
  return s;
}

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.?!…]+$/g, "");
}

function rememberBotOutput(text) {
  const n = normalizeText(text);
  if (!n) return;

  botRecentSet.add(n);
  if (botRecentSet.size > BOT_RECENT_LIMIT) {
    const first = botRecentSet.values().next().value;
    botRecentSet.delete(first);
  }
}

function tooSimilar(candidate) {
  const cand = normalizeText(candidate);
  if (!cand) return true;

  if (memorySet.has(cand)) return true;
  if (botRecentSet.has(cand)) return true;

  const candWords = cand.split(" ").filter(Boolean);
  if (candWords.length < 4) return true;

  const candSet = new Set(candWords);

  const samples = Math.min(90, memory.length);
  for (let i = 0; i < samples; i++) {
    const m = normalizeText(memory[Math.floor(Math.random() * memory.length)]);
    if (!m) continue;

    if (m.slice(0, 22) === cand.slice(0, 22)) return true;

    const mWords = m.split(" ").filter(Boolean);
    const mSet = new Set(mWords);

    let inter = 0;
    for (const w of candSet) if (mSet.has(w)) inter++;

    const union = candSet.size + mSet.size - inter;
    const jacc = union ? inter / union : 0;

    const threshold = candWords.length <= 8 ? 0.50 : 0.62;
    if (jacc >= threshold) return true;
  }

  return false;
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<@!?(\d+)>/g, "")
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS_PER_MESSAGE);
}

/* =========================
   BASIT SEÇIM SORUSU TANIMA (TÜRKÇE TÜM EKLERLE)
   - mention'ları temizleyerek çalışır
========================= */
function handleSimpleChoiceQuestion(text) {
  // Önce mention'ları kaldır (botun kendi ID'si de dahil)
  const cleanText = text.replace(/<@!?(\d+)>/g, "").trim();
  if (!cleanText) return null;

  // "X mı/mi/mu/mü Y mı/mi/mu/mü" kalıbı (tüm ek varyasyonları)
  const match = cleanText.match(/(.+?)\s+(m[ıiuü])\s+(.+?)\s+(m[ıiuü])/i);
  if (match) {
    const secenek1 = match[1].trim();
    const secenek2 = match[3].trim();
    return Math.random() < 0.5 ? secenek1 : secenek2;
  }

  // "X yoksa Y" kalıbı
  const match2 = cleanText.match(/(.+?)\s+yoksa\s+(.+?)\s*[?]*$/i);
  if (match2) {
    const secenek1 = match2[1].trim();
    const secenek2 = match2[2].trim();
    return Math.random() < 0.5 ? secenek1 : secenek2;
  }

  // "X veya Y" kalıbı
  const match3 = cleanText.match(/(.+?)\s+veya\s+(.+?)\s*[?]*$/i);
  if (match3) {
    const secenek1 = match3[1].trim();
    const secenek2 = match3[2].trim();
    return Math.random() < 0.5 ? secenek1 : secenek2;
  }

  // "evet mi hayır mı" (ve diğer ikili özel durumlar)
  if (cleanText.match(/evet\s+(m[ıiuü])\s+hayır\s+(m[ıiuü])/i)) {
    return Math.random() < 0.5 ? "evet" : "hayır";
  }

  return null; // tanımlanamadı
}

/* =========================
   SMART REPLY (Sadece @mention için)
========================= */
function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const w of aSet) if (bSet.has(w)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union ? inter / union : 0;
}

function smartReplyFor(inputText) {
  if (!memory || memory.length < 200) return null;

  const inTok = tokenize(inputText);
  if (inTok.length < 2) return null;
  const inSet = new Set(inTok);

  const usableLen = Math.max(0, memory.length - RECENT_EXCLUDE);
  if (usableLen < 5) return null;

  const SAMPLE = Math.min(1500, usableLen - 1);
  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < SAMPLE; i++) {
    const idx = Math.floor(Math.random() * (usableLen - 1));
    const q = memory[idx];
    const a = memory[idx + 1];
    if (!q || !a) continue;
    if (containsReligiousAbuse(a)) continue;

    const qTok = tokenize(q);
    if (qTok.length < 2) continue;

    const score = jaccard(inSet, new Set(qTok));
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx + 1;
    }
  }

  if (bestIdx === -1 || bestScore < 0.18) return null;

  const candidate = memory[bestIdx];
  if (!candidate) return null;
  if (tooSimilar(candidate)) return null;
  if (containsReligiousAbuse(candidate)) return null;

  return candidate;
}

/* =========================
   MARKOV MODEL
========================= */
function buildMarkov3(messages) {
  const map = new Map();
  for (const msg of messages) {
    const w = tokenize(msg);
    if (w.length < 4) continue;
    for (let i = 0; i < w.length - 3; i++) {
      const key = `${w[i]}|${w[i + 1]}|${w[i + 2]}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(w[i + 3]);
    }
  }
  return map;
}

function randomChatWord() {
  if (memory.length === 0) return null;
  for (let i = 0; i < 12; i++) {
    const msg = randomFrom(memory);
    const words = tokenize(msg);
    if (words.length > 0) return randomFrom(words);
  }
  return null;
}

function injectNoiseFromChat(words) {
  if (Math.random() < 0.15) return words;

  const minReplace = 3;
  const extra = Math.floor(Math.random() * 4);
  const replaceCount = Math.min(words.length, minReplace + extra);

  const usedIdx = new Set();
  for (let i = 0; i < replaceCount; i++) {
    let idx = Math.floor(Math.random() * words.length);
    let guard = 0;
    while (usedIdx.has(idx) && guard++ < 10) idx = Math.floor(Math.random() * words.length);
    usedIdx.add(idx);

    const w = randomChatWord() ?? randomFrom(WORD_POOL);
    words[idx] = w;
  }

  if (Math.random() < 0.35 && words.length < 16) {
    const addCount = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < addCount; i++) {
      const idx = Math.floor(Math.random() * (words.length + 1));
      const w = randomChatWord() ?? randomFrom(WORD_POOL);
      words.splice(idx, 0, w);
    }
  }

  if (Math.random() < 0.2 && words.length > 6) {
    const idx = Math.floor(Math.random() * words.length);
    words.splice(idx, 1);
  }

  if (Math.random() < 0.35 && words.length >= 6) {
    for (let k = 0; k < 2; k++) {
      const i = Math.floor(Math.random() * words.length);
      const j = Math.floor(Math.random() * words.length);
      [words[i], words[j]] = [words[j], words[i]];
    }
  }

  return words;
}

function markovSentenceRaw() {
  if (memory.length < 60) {
    const fb = randomSentence();
    rememberBotOutput(fb);
    return fb;
  }

  const usable =
    memory.length > RECENT_EXCLUDE ? memory.slice(0, memory.length - RECENT_EXCLUDE) : memory;

  const model = buildMarkov3(usable);
  const keys = Array.from(model.keys());
  if (!keys.length) {
    const fb = randomSentence();
    rememberBotOutput(fb);
    return fb;
  }

  for (let attempt = 0; attempt < 25; attempt++) {
    const targetLen = Math.floor(Math.random() * 6) + 5;

    const start = randomFrom(keys).split("|");
    let out = [...start];

    while (out.length < targetLen) {
      const key = `${out[out.length - 3]}|${out[out.length - 2]}|${out[out.length - 1]}`;
      const nexts = model.get(key);
      if (!nexts || nexts.length === 0) break;
      out.push(randomFrom(nexts));
    }

    out = injectNoiseFromChat(out);

    let s = out.join(" ");
    s = s.charAt(0).toUpperCase() + s.slice(1);
    s += Math.random() < 0.2 ? "..." : ".";

    if (!tooSimilar(s)) {
      rememberBotOutput(s);
      return s;
    }
  }

  const fb = randomSentence();
  rememberBotOutput(fb);
  return fb;
}

function generateSafeSentence() {
  for (let tries = 0; tries < 80; tries++) {
    const s = markovSentenceRaw();
    if (!s) continue;
    if (containsReligiousAbuse(s)) continue;
    return s;
  }
  const fb = randomSentence();
  return containsReligiousAbuse(fb) ? "..." : fb;
}

/* =========================
   SEED (son X gün, max N) + progress + heartbeat + throttle + ratelimit
========================= */
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

    console.log(
      `Seed progress: ${collected.length}/${maxMessages} msgs | fetch=${seedState.fetchCount} | ${formatDuration(
        elapsedMs
      )} | ~${rate} msg/sn`
    );

    seedState.collected = collected.length;
    seedState.lastUpdateAt = now;
  };

  console.log(`Seed başladı: son ${days} gün, max ${maxMessages} mesaj (#${channel.name})`);

  while (collected.length < maxMessages) {
    // event loop'a nefes ver
    await new Promise((r) => setImmediate(r));

    const batchSize = Math.min(100, maxMessages - collected.length);
    const opts = { limit: batchSize };
    if (beforeId) opts.before = beforeId;

    beat("before-fetch", `beforeId=${beforeId ?? "none"}`);

    let msgs;
    try {
      // Discord fetch bazen network yüzünden takılı kalıyor gibi görünebilir.
      // O yüzden "soft timeout": 20sn sonra hata gibi yakalayıp retry yapacağız.
      msgs = await Promise.race([
        channel.messages.fetch(opts),
        (async () => {
          await sleep(20000);
          throw new Error("SEED_FETCH_TIMEOUT_20S");
        })(),
      ]);
    } catch (e) {
      // rate limit yakalama (discord.js farklı yerlere koyabiliyor)
      const retryAfter =
        e?.data?.retry_after ??
        e?.retry_after ??
        e?.rawError?.retry_after ??
        e?.response?.data?.retry_after ??
        null;

      if (retryAfter) {
        const waitMs = Math.ceil(Number(retryAfter) * 1000) + 750;
        console.log(`[SEED] RATE LIMIT: ${retryAfter}s -> ${waitMs}ms bekliyorum...`);
        await sleep(waitMs);
        continue;
      }

      // timeout ise biraz bekle retry
      if ((e?.message || "").includes("SEED_FETCH_TIMEOUT_20S")) {
        console.log("[SEED] fetch 20sn içinde dönmedi, 3sn bekleyip tekrar deniyorum...");
        await sleep(3000);
        continue;
      }

      seedState.error = e?.message || String(e);
      seedState.running = false;
      seedState.done = false;

      console.error("[SEED] FETCH ERROR:", {
        name: e?.name,
        code: e?.code,
        message: e?.message,
        status: e?.status,
      });
      return;
    }

    seedState.fetchCount++;
    beat("after-fetch", `size=${msgs?.size ?? 0}`);

    if (!msgs || msgs.size === 0) {
      console.log("Seed: fetch boş döndü, duruyor.");
      break;
    }

    const arr = Array.from(msgs.values()).reverse();
    let reachedCutoff = false;

    for (const m of arr) {
      if (m.createdTimestamp < cutoff) {
        reachedCutoff = true;
        break;
      }
      if (m.author.bot) continue;

      const t = (m.content || "").trim();
      if (!t) continue;
      if (containsReligiousAbuse(t)) continue;

      collected.push(t);
      if (collected.length >= maxMessages) break;
    }

    if (seedState.fetchCount % 10 === 0) logProgress(true);
    else logProgress(false);

    if (reachedCutoff) {
      console.log(`Seed: cutoff tarihine ulaşıldı (${days} gün sınırı).`);
      break;
    }

    beforeId = msgs.last().id;

    // throttle (rate-limit'i çok azaltır)
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
    GatewayIntentBits.DirectMessages, // DM mesajlarını almak için eklendi
  ],
});

// discord.js v15 için (ready -> clientReady)
async function onClientReady() {
  console.log(`Bot aktif: ${client.user.tag}`);

  try {
    const ch = await client.channels.fetch(SEED_CHANNEL_ID);
    if (!ch) {
      console.log("Seed: Kanal bulunamadı (ID yanlış olabilir).");
      return;
    }
    if (!ch.isTextBased()) {
      console.log("Seed: Kanal text değil.");
      return;
    }

    console.log(`Seed: Kanal bulundu -> #${ch.name}`);
    await seedByDays(ch, SEED_DAYS, SEED_MAX);
  } catch (e) {
    console.error("Seed error:", e);
  }
}

// Her iki event'e de bağla (v14/v15 farkı)
client.once("ready", onClientReady);
client.once("clientReady", onClientReady);

/* =========================
   HTTP SERVER (Koyeb healthcheck + cmd)
========================= */
http
  .createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const path = u.pathname;

      if (path === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("OK");
      }

      if (path === "/cmd") {
        const key = u.searchParams.get("key") || "";
        if (!CMD_KEY || key !== CMD_KEY) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          return res.end("unauthorized");
        }

        const action = (u.searchParams.get("action") || "").toLowerCase();

        if (action === "reaction_off") {
          reactionsEnabled = false;
          res.writeHead(200, { "Content-Type": "text/plain" });
          return res.end("sent");
        }

        if (action === "reaction_on") {
          reactionsEnabled = true;
          res.writeHead(200, { "Content-Type": "text/plain" });
          return res.end("sent");
        }

        if (action === "say") {
          const text = u.searchParams.get("text") || "";
          if (!text.trim()) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            return res.end("missing text");
          }

          if (!client?.isReady?.()) {
            res.writeHead(503, { "Content-Type": "text/plain" });
            return res.end("discord not ready");
          }

          const ch = await client.channels.fetch(SEED_CHANNEL_ID);
          if (!ch || !ch.isTextBased()) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            return res.end("channel not found");
          }

          await ch.send(text);
          res.writeHead(200, { "Content-Type": "text/plain" });
          return res.end("sent");
        }

        if (action === "seed_status") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(seedState, null, 2));
        }

        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("unknown action");
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("server error");
    }
  })
  .listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

/* =========================
   MESSAGE HANDLER
========================= */
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const content = (message.content || "").trim();

    // === DM'den admin mesajlarını hedef kanala yönlendir ===
    // (Sunucu dışı = DM, sadece admin)
    if (message.guild === null && message.author.id === ADMIN_USER_ID) {
      console.log(`DM from admin: ${content}`);
      const targetChannel = await client.channels.fetch(SEED_CHANNEL_ID);
      if (targetChannel && targetChannel.isTextBased()) {
        // İsterseniz ek bir önek ekleyebilirsiniz: `📨 ${content}`
        await targetChannel.send(content);
      } else {
        console.log("Hedef kanal bulunamadı veya text değil.");
      }
      return; // Mesajı tüket, başka işlem yapma
    }

    const lower = content.toLowerCase();

    // === *gökhan (Roblox status) ===
    if (lower === "*gökhan" || lower === "*gokhan") {
      const status = await fetchRobloxStatus();

      if (!status) {
        await message.reply("Roblox durumu çekemedim.");
        return;
      }

      if (status.presenceType === 0) {
        await message.reply("offline.");
        return;
      }

      if (status.presenceType === 3) {
        await message.reply("Gökhan Studio'da nabıyon aq.");
        return;
      }

      if (status.presenceType === 2) {
        // Roblox bazen hiçbir bilgi vermiyor (placeId=null lastLocation='' universeId=null)
        let gameText = status.gameName;

        if (!gameText) {
          if (!status.placeId && !status.universeId && !status.lastLocation) {
            gameText = "Roblox oyun bilgisini göndermiyor (placeId/universeId yok).";
          } else {
            gameText =
              status.lastLocation ||
              (status.placeId ? `placeId=${status.placeId}` : null) ||
              (status.universeId ? `universeId=${status.universeId}` : null) ||
              "Bilinmiyor";
          }
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
      await message.reply("Konsola raw bastım.");
      console.log("ROBLOX RAW:", status?.raw);
      return;
    }

    // === ADMIN KOMUTLARI ===
    if (message.author.id === ADMIN_USER_ID) {
      if (lower === "*reaction off") {
        reactionsEnabled = false;
        await message.reply("⛔ Reaction kapalı");
        return;
      }
      if (lower === "*reaction on") {
        reactionsEnabled = true;
        await message.reply("✅ Reaction açık");
        return;
      }
      if (lower === "*reaction status") {
        await message.reply(reactionsEnabled ? "✅ AÇIK" : "⛔ KAPALI");
        return;
      }

      if (lower === "*seed status") {
        if (!seedState.startedAt) {
          await message.reply("Seed daha başlamadı.");
          return;
        }

        const now = Date.now();
        const elapsed = now - seedState.startedAt;
        const st =
          seedState.running ? "⏳ ÇALIŞIYOR"
          : seedState.done ? "✅ TAMAMLANDI"
          : seedState.error ? "❌ HATA"
          : "⏸️ DURDU";

        const rate = Math.round(seedState.collected / Math.max(1, Math.floor(elapsed / 1000)));

        await message.reply(
          [
            `Seed durumu: ${st}`,
            `Kanal: #${seedState.channelName ?? "?"}`,
            `Toplandı: ${seedState.collected}/${seedState.max}`,
            `Fetch: ${seedState.fetchCount}`,
            `Süre: ${formatDuration(elapsed)} (~${rate} msg/sn)`,
            seedState.error ? `Hata: ${seedState.error}` : null,
          ].filter(Boolean).join("\n")
        );
        return;
      }
    }

    // === HAFIZA CANLI GÜNCELLEME (SADECE SEED KANALI) ===
    if (message.channel.id === SEED_CHANNEL_ID && content.length > 0) {
      if (!containsReligiousAbuse(content)) {
        const norm = normalizeText(content);

        memory.push(content);
        memorySet.add(norm);

        if (memory.length > MAX_MEMORY_MESSAGES) {
          const removed = memory.shift();
          memorySet.delete(normalizeText(removed));
        }
      }
    }

    // === @MENTION CEVAP (ÖNCE SEÇİM SORUSU, SONRA SMART REPLY) ===
    if (message.mentions.has(client.user) && Math.random() < MENTION_RESPONSE_CHANCE) {
      // Önce basit seçim sorusu kontrolü (mention'lar temizlenmiş halde)
      const choiceAnswer = handleSimpleChoiceQuestion(content);
      if (choiceAnswer) {
        await message.reply(choiceAnswer);
        return;
      }

      // Yoksa eski smart reply veya markov
      const smart = smartReplyFor(content);
      const out = smart || generateSafeSentence();
      await message.reply(out);
      return;
    }

    // === BOT MESAJINA REPLY (ÖNCE SEÇİM SORUSU) ===
    if (
      message.reference &&
      message.mentions.repliedUser?.id === client.user.id &&
      Math.random() < REPLY_RESPONSE_CHANCE
    ) {
      const choiceAnswer = handleSimpleChoiceQuestion(content);
      if (choiceAnswer) {
        await message.reply(choiceAnswer);
        return;
      }
      const out = generateSafeSentence();
      await message.reply(out);
      return;
    }

    // === RASTGELE ARALIKLA MESAJ AT ===
    messageCounter++;
    if (messageCounter >= nextMessageTarget) {
      messageCounter = 0;
      nextMessageTarget = Math.floor(Math.random() * 31) + 20;
      const out = generateSafeSentence();
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
   LOGIN + DEBUG
========================= */
console.log("Discord login başlıyor... token var mı?", Boolean(process.env.DISCORD_TOKEN));

client.on("error", (e) => console.error("Discord client error:", e));
client.on("shardError", (e) => console.error("Discord shard error:", e));
process.on("unhandledRejection", (e) => console.error("UnhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("UncaughtException:", e));

client
  .login(process.env.DISCORD_TOKEN)
  .then(() => console.log("Discord login OK (promise resolved)"))
  .catch((e) => console.error("Discord login FAIL:", e));
