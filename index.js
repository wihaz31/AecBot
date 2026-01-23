require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

/* =========================
   KOYEB FREE: BOŞ HTTP SERVER
========================= */
const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 8000;

// Koyeb'de Environment'a bunu ekle: CMD_KEY=....
const CMD_KEY = process.env.CMD_KEY || ""; 

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const path = u.pathname;

    // healthcheck
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }
   // === ROBLOX AYARLARI ===
  const ROBLOX_USER_ID = "2575829815"; // sadece sayı

    // command endpoint
    if (path === "/cmd") {
      const key = u.searchParams.get("key") || "";
      if (!CMD_KEY || key !== CMD_KEY) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        return res.end("unauthorized");
      }
     async function fetchRobloxStatus() {
  try {
    const res = await fetch("https://presence.roblox.com/v1/presence/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userIds: [Number(ROBLOX_USER_ID)],
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const p = data.userPresences?.[0];
    if (!p) return null;

    return {
      isOnline: p.userPresenceType !== 0,
      presenceType: p.userPresenceType, // 0=offline, 1=online, 2=in game, 3=in studio
      gameId: p.gameId || null,
      placeId: p.placeId || null,
      lastLocation: p.lastLocation || null,
    };
  } catch (e) {
    console.error("Roblox status error:", e);
    return null;
  }
}

      const action = (u.searchParams.get("action") || "").toLowerCase();

      // reaction off/on
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

      // say (seed kanalına yazar)
      if (action === "say") {
        const text = u.searchParams.get("text") || "";
        if (!text.trim()) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          return res.end("missing text");
        }

        // client ready değilse gönderemez
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

      // seed status
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
}).listen(PORT, () => {
  console.log(`HTTP server listening on ${PORT}`);
});

/* =========================
   AYARLAR
========================= */
const SEED_CHANNEL_ID = "705537838770421761";

const SEED_DAYS = 240;
const SEED_MAX = 40000;

const MAX_MEMORY_MESSAGES = 40000;
const RECENT_EXCLUDE = 100;

let messageCounter = 0;
let nextMessageTarget = Math.floor(Math.random() * 31) + 20; // 5–20

const REPLY_RESPONSE_CHANCE = 1;
const MENTION_RESPONSE_CHANCE = 1;

// Reaction ayarları
let reactionsEnabled = false;
const ADMIN_USER_ID = "297433660553035778";
const TARGET_USER_ID = "403940186494599168";
const EMOJI_1 = "🪑";
const EMOJI_2 = "🪢";

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
   Normal küfür serbest.
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

// dini kelimeler (istersen genişlet)
const RELIGIOUS_TERMS = [
  "allah","tanri","peygamber","muhammed","4ll4h","4LLL4H12N1S1KEY1M",
  "kuran","allanı","muhammedini","peygamberini",
  "allahuınukşitabını","kitabını",
].map(squash);

// küfür/hakaret kelimeleri: SADECE dini içerikle beraber yakalamak için
// (normal küfürlü cümleler engellenmeyecek)
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

  // sadece ikisi bir aradaysa TRUE
  return true;
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
   SMART REPLY (Sadece @mention için)
   - Eski chatte benzer "soru"yu bulur
   - Hemen ardından gelen mesajı "cevap" gibi döndürür
========================= */

// Basit Jaccard benzerliği
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

  // yakın geçmişten cevap seçmemek için (kopya riskini azaltır)
  const usableLen = Math.max(0, memory.length - RECENT_EXCLUDE);

  // performans için rastgele örnekleme
  const SAMPLE = Math.min(1500, usableLen - 1);
  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < SAMPLE; i++) {
    const idx = Math.floor(Math.random() * (usableLen - 1)); // idx+1 var olsun
    const q = memory[idx];
    const a = memory[idx + 1];

    if (!q || !a) continue;
    if (containsReligiousAbuse(a)) continue; // cevapta din+kufur olmasın

    const qTok = tokenize(q);
    if (qTok.length < 2) continue;

    const score = jaccard(inSet, new Set(qTok));

    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx + 1; // cevabın index'i
    }
  }
   

  // çok alakasızsa dönme
  if (bestIdx === -1 || bestScore < 0.18) return null;

  const candidate = memory[bestIdx];
  if (!candidate) return null;

  // kopya/benzerlik engeli (varsa)
  if (tooSimilar(candidate)) return null;

  if (containsReligiousAbuse(candidate)) return null;

  return candidate;
}


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

/* =========================
   CHAT'TEN KELİME + NOISE
========================= */
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

/* =========================
   ÜRETİM (Markov + anti-copy) + DİN+KÜFÜR ENGELİ
========================= */
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

    if (Math.random() < 0.15 && out.length >= 6) {
      const i = Math.floor(Math.random() * out.length);
      const j = Math.floor(Math.random() * out.length);
      [out[i], out[j]] = [out[j], out[i]];
    }

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
    if (containsReligiousAbuse(s)) continue; // SADECE din+küfür engeli
    return s;
  }
  // fallback
  const fb = randomSentence();
  return containsReligiousAbuse(fb) ? "..." : fb;
}

/* =========================
   SEED (son X gün, max N) + progress
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
    const batchSize = Math.min(100, maxMessages - collected.length);
    const opts = { limit: batchSize };
    if (beforeId) opts.before = beforeId;

    let msgs;
    try {
      msgs = await channel.messages.fetch(opts);
    } catch (e) {
      const retryAfter = (e?.data && e.data.retry_after) || e?.retry_after || null;
      if (retryAfter) {
        const waitMs = Math.ceil(retryAfter * 1000) + 200;
        console.log(`Seed rate limit: ${waitMs}ms bekleniyor...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      seedState.error = e?.message || String(e);
      seedState.running = false;
      seedState.done = false;
      console.error("Seed fetch error:", e);
      return;
    }

    seedState.fetchCount++;

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

      // ✅ SADECE din + küfür içeren mesajları seed'den dışarıda bırak (opsiyon)
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
  }

  // memory doldur
  memory.length = 0;
  memory.push(...collected);

  while (memory.length > MAX_MEMORY_MESSAGES) memory.shift();

  // memorySet doldur
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
  ],
});

client.once("ready", async () => {
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
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const content = (message.content || "").trim();

    // === ADMIN KOMUTLARI ===
    if (message.author.id === ADMIN_USER_ID) {
      const cmd = content.toLowerCase();

      if (cmd === "*reaction off") {
        reactionsEnabled = false;
        await message.reply("⛔ Reaction kapalı");
        return;
      }
      if (cmd === "*reaction on") {
        reactionsEnabled = true;
        await message.reply("✅ Reaction açık");
        return;
      }
      if (cmd === "*reaction status") {
        await message.reply(reactionsEnabled ? "✅ AÇIK" : "⛔ KAPALI");
        return;
      }

      if (cmd === "*seed status") {
        if (!seedState.startedAt) {
          await message.reply("Seed daha başlamadı.");
          return;
        }
// === *gökhan (Roblox status) ===
if (content.toLowerCase() === "*gökhan") {
  const status = await fetchRobloxStatus();

  if (!status) {
    await message.reply("NT olduk.");
    return;
  }

  if (!status.isOnline) {
    await message.reply("offline.");
    return;
  }

  if (status.presenceType === 2) {
    await message.reply(
      `Gökhan yine Robloxta aq.\nOyun: ${status.lastLocation || "Bilinmiyor"}`
    );
    return;
  }

  if (status.presenceType === 3) {
    await message.reply("Gökhan nabıyon aq.");
    return;
  }

  await message.reply("online sadece.");
  return;
}

        const now = Date.now();
        const elapsed = now - seedState.startedAt;
        const status = seedState.running
          ? "⏳ ÇALIŞIYOR"
          : seedState.done
          ? "✅ TAMAMLANDI"
          : seedState.error
          ? "❌ HATA"
          : "⏸️ DURDU";

        const rate = Math.round(seedState.collected / Math.max(1, Math.floor(elapsed / 1000)));

        await message.reply(
          [
            `Seed durumu: ${status}`,
            `Kanal: #${seedState.channelName ?? "?"}`,
            `Toplandı: ${seedState.collected}/${seedState.max}`,
            `Fetch: ${seedState.fetchCount}`,
            `Süre: ${formatDuration(elapsed)} (~${rate} msg/sn)`,
            seedState.error ? `Hata: ${seedState.error}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        );
        return;
      }
    }

    // === HAFIZA CANLI GÜNCELLEME (SADECE SEED KANALI) ===
    if (message.channel.id === SEED_CHANNEL_ID && content.length > 0) {
      // ✅ sadece din+küfür içerenleri hafızaya alma (opsiyon)
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

// === @MENTION CEVAP (SMART REPLY + fallback) ===
if (message.mentions.has(client.user) && Math.random() < MENTION_RESPONSE_CHANCE) {
  const smart = smartReplyFor(content);
  const out = smart || generateSafeSentence(); // bulamazsa eski sistem
  await message.reply(out);
  return;
}


    // === BOT MESAJINA REPLY ===
    if (
      message.reference &&
      message.mentions.repliedUser?.id === client.user.id &&
      Math.random() < REPLY_RESPONSE_CHANCE
    ) {
      const out = generateSafeSentence();
      await message.reply(out);
      return;
    }

    // === 5–20 ARASI RASTGELE ARALIKLA MESAJ AT ===
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

console.log("Discord login başlıyor... token var mı?", Boolean(process.env.DISCORD_TOKEN));

client.on("error", (e) => console.error("Discord client error:", e));
client.on("shardError", (e) => console.error("Discord shard error:", e));
process.on("unhandledRejection", (e) => console.error("UnhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("UncaughtException:", e));

client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log("Discord login OK (promise resolved)"))
  .catch((e) => console.error("Discord login FAIL:", e));












