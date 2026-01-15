require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");



  console.log(`[CONSOLE CMD] ${cmd}`);

  // === REACTION ===
  if (cmd === "reaction off") {
    reactionsEnabled = false;
    console.log("⛔ Reaction kapatıldı (console)");
    return;
  }

  if (cmd === "reaction on") {
    reactionsEnabled = true;
    console.log("✅ Reaction açıldı (console)");
    return;
  }

  // === SEED ===
  if (cmd === "seed status") {
    console.log(seedState);
    return;
  }

  if (cmd === "seed start") {
    if (seedState.running) {
      console.log("Seed zaten çalışıyor.");
      return;
    }

    try {
      const ch = await client.channels.fetch(SEED_CHANNEL_ID);
      if (!ch || !ch.isTextBased()) {
        console.log("Seed kanalı bulunamadı.");
        return;
      }

      console.log("Seed başlatılıyor (console)...");
      seedByDays(ch, SEED_DAYS, SEED_MAX);
    } catch (e) {
      console.error("Seed başlatma hatası:", e.message);
    }
    return;
  }

  // === BOT MESAJ ATTIR ===
  if (cmd.startsWith("say ")) {
    const text = data.trim().slice(4);
    if (!text) {
      console.log("say <mesaj>");
      return;
    }

    try {
      const ch = await client.channels.fetch(SEED_CHANNEL_ID);
      if (ch?.isTextBased()) {
        await ch.send(text);
        console.log("📨 Mesaj gönderildi.");
      }
    } catch (e) {
      console.error("Mesaj gönderme hatası:", e.message);
    }
    return;
  }

  // === ÇIKIŞ ===
  if (cmd === "exit") {
    console.log("Bot kapatılıyor...");
    process.exit(0);
  }

  console.log("Bilinmeyen komut.");
});


// === KOYEB FREE HACK: BOŞ HTTP SERVER ===
const http = require("http");
const PORT = process.env.PORT || 8000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(PORT, () => {
    console.log(`HTTP server listening on ${PORT}`);
  });

/* =========================
   AYARLAR
========================= */

// === SEED KANALI ===
const SEED_CHANNEL_ID = "705537838770421761";

// === Seed parametreleri ===
const SEED_DAYS = 240; // son 240 gün
const SEED_MAX = 40000; // en fazla 40k mesaj çek

// === Hafıza (canlı güncellenir) ===
const MAX_MEMORY_MESSAGES = 40000;

// === Üretimde yakın geçmişi hariç tut ===
const RECENT_EXCLUDE = 100; // son 100 mesajı modele dahil etme

// === Rastgele mesaj aralığı (5–20) ===
let messageCounter = 0;
let nextMessageTarget = Math.floor(Math.random() * 16) + 5; // 5–20

// === Bot mesajına reply gelince cevap ihtimali ===
const REPLY_RESPONSE_CHANCE = 1;

// === Reaction ayarları ===
let reactionsEnabled = false;
const ADMIN_USER_ID = "297433660553035778";
const TARGET_USER_ID = "403940186494599168";
const EMOJI_1 = "🪑";
const EMOJI_2 = "🪢";

/* =========================
   SEED DURUMU (STATUS KOMUTU İÇİN)
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

// === KOPYA/ÇOK BENZER ENGELLEME ===
const memorySet = new Set(); // hafızadaki mesajların normalize edilmiş set'i
const botRecentSet = new Set(); // botun son attıklarını tut
const BOT_RECENT_LIMIT = 200; // botun son 200 çıktısını hatırla

/* =========================
   FALLBACK WORD POOL (Markov yeterli olmazsa)
========================= */
const WORD_POOL = [
  "aga",
  "kanka",
  "bro",
  "reis",
  "moruk",
  "abi",
  "hocam",
  "sal",
  "boşver",
  "takıl",
  "trip",
  "cringe",
  "based",
  "random",
  "kaos",
  "efsane",
  "rezalet",
  "offfff",
  "aynen",
  "yokartık",
  "şaka mı",
  "noluyo",
  "ne alaka",
  "ciddiyim",
  "bro",
  "dude",
  "bruh",
  "lol",
  "lmao",
  "wtf",
  "idk",
  "imo",
  "fr",
  "no cap",
  "cap",
  "sheesh",
  "mid",
  "npc",
  "lowkey",
  "skill issue",
  "touch grass",
  "gg",
  "ez",
  "ff",
  "go next",
  "tryhard",
  "toxic",
  "hardstuck",
  "smurf",
  "boosted",
  "nerf",
  "buff",
  "yasuo",
  "yone",
  "zed",
  "akali",
  "lee sin",
  "viego",
  "ahri",
  "jinx",
  "caitlyn",
  "thresh",
  "lux",
  "riven",
  "faker",
  "keria",
  "gumayusi",
  "soloQ",
  "ranked",
  "normal",
  "aram",
  "midlane",
  "toplane",
  "botlane",
  "jungle",
  "support",
  "gank",
  "outplay",
  "int",
  "feed",
  "carry",
  "snowball",
  "oneshot",
  "burst",
  "kite",
  "peel",
  "macro",
  "micro",
  "meta",
  "bronze",
  "silver",
  "gold",
  "emerald",
  "diamond",
  "master",
  "challenger",
];

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

// normalize: birebir/benzerlik kontrolü için
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.?!…]+$/g, "");
}

// Botun çıktısını yakın geçmişe yaz
function rememberBotOutput(text) {
  const n = normalizeText(text);
  if (!n) return;

  botRecentSet.add(n);
  if (botRecentSet.size > BOT_RECENT_LIMIT) {
    const first = botRecentSet.values().next().value;
    botRecentSet.delete(first);
  }
}

// Çok benzer mi? (birebir + jaccard benzerliği + kısa prefix)
function tooSimilar(candidate) {
  const cand = normalizeText(candidate);
  if (!cand) return true;

  // birebir hafızadaysa
  if (memorySet.has(cand)) return true;

  // bot yakın zamanda aynı şeyi attıysa
  if (botRecentSet.has(cand)) return true;

  const candWords = cand.split(" ").filter(Boolean);
  if (candWords.length < 4) return true;

  const candSet = new Set(candWords);

  // Performans: hafızadan rastgele örneklerle kıyasla
  const samples = Math.min(90, memory.length);
  for (let i = 0; i < samples; i++) {
    const m = normalizeText(memory[Math.floor(Math.random() * memory.length)]);
    if (!m) continue;

    // ilk 22 karakter aynıysa aşırı benzer
    if (m.slice(0, 22) === cand.slice(0, 22)) return true;

    const mWords = m.split(" ").filter(Boolean);
    const mSet = new Set(mWords);

    let inter = 0;
    for (const w of candSet) if (mSet.has(w)) inter++;

    const union = candSet.size + mSet.size - inter;
    const jacc = union ? inter / union : 0;

    // kısa cümlede daha sıkı, uzunda daha esnek
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
   CHAT'TEN KELİME ALMA (WORD_POOL YERİNE)
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

/* =========================
   NOISE: CHAT'TEN KELİMEYLE BOZMA (EKSTRA KELİME EKLEYEBİLİR)
========================= */
function injectNoiseFromChat(words) {
  // %15 hiç dokunma (tamamen bozmak istemezsen)
  if (Math.random() < 0.15) return words;

  // hedef: en az 3 kelime değişsin, bazen 4–6
  const minReplace = 3;
  const extra = Math.floor(Math.random() * 4); // 0..3
  const replaceCount = Math.min(words.length, minReplace + extra); // 3..6 (kelime sayısına göre)

  const usedIdx = new Set();
  for (let i = 0; i < replaceCount; i++) {
    let idx = Math.floor(Math.random() * words.length);
    let guard = 0;
    while (usedIdx.has(idx) && guard++ < 10) idx = Math.floor(Math.random() * words.length);
    usedIdx.add(idx);

    const w = randomChatWord() ?? randomFrom(WORD_POOL);
    words[idx] = w;
  }

  // %35 ihtimalle 1–2 kelime ekle
  if (Math.random() < 0.35 && words.length < 16) {
    const addCount = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < addCount; i++) {
      const idx = Math.floor(Math.random() * (words.length + 1));
      const w = randomChatWord() ?? randomFrom(WORD_POOL);
      words.splice(idx, 0, w);
    }
  }

  // %20 ihtimalle 1 kelime sil
  if (Math.random() < 0.2 && words.length > 6) {
    const idx = Math.floor(Math.random() * words.length);
    words.splice(idx, 1);
  }

  // %35 ihtimalle küçük karıştırma (2 swap)
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
   KOPYA/ÇOK BENZER ENGELLEMELİ MARKOV
========================= */
function markovSentence() {
  if (memory.length < 60) {
    const fb = randomSentence();
    rememberBotOutput(fb);
    return fb;
  }

  // yakın geçmişi modelden çıkar
  const usable =
    memory.length > RECENT_EXCLUDE ? memory.slice(0, memory.length - RECENT_EXCLUDE) : memory;

  const model = buildMarkov3(usable);
  const keys = Array.from(model.keys());
  if (!keys.length) {
    const fb = randomSentence();
    rememberBotOutput(fb);
    return fb;
  }

  // 25 deneme: benzer/kopyaysa yeniden üret
  for (let attempt = 0; attempt < 25; attempt++) {
    const targetLen = Math.floor(Math.random() * 6) + 5; // 5–10

    const start = randomFrom(keys).split("|");
    let out = [...start];

    while (out.length < targetLen) {
      const key = `${out[out.length - 3]}|${out[out.length - 2]}|${out[out.length - 1]}`;
      const nexts = model.get(key);
      if (!nexts || nexts.length === 0) break;
      out.push(randomFrom(nexts));
    }

    // Chat kelimeleriyle boz
    out = injectNoiseFromChat(out);

    // küçük bir karıştırma (%15)
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

  // Olmadıysa fallback
  const fb = randomSentence();
  rememberBotOutput(fb);
  return fb;
}

/* =========================
   SEED: SON 240 GÜN (MAX 40K) + PROGRESS + RATE LIMIT
========================= */
async function seedByDays(channel, days = 240, maxMessages = 40000) {
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
    if (!force && now - lastLogAt < 5000) return; // max 5sn'de bir log
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

      collected.push(t);
      if (collected.length >= maxMessages) break;
    }

    if (seedState.fetchCount % 10 === 0) logProgress(true);
    else logProgress(false);

    if (reachedCutoff) {
      console.log("Seed: cutoff tarihine ulaşıldı (240 gün sınırı).");
      break;
    }

    beforeId = msgs.last().id;
  }

  // memory doldur
  memory.length = 0;
  memory.push(...collected);

  while (memory.length > MAX_MEMORY_MESSAGES) memory.shift();

  // memorySet doldur (birebir engelleme için)
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
  // === CONSOLE KOMUTLARI ===
process.stdin.setEncoding("utf8");

process.stdin.on("data", async (data) => {
  const cmd = data.trim().toLowerCase();

  if (!cmd) return;
  }
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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
    // sadece insan mesajları
    if (message.author.bot) return;

    const content = (message.content || "").trim();
    // === MENTION'a cevap ===
if (message.mentions.has(client.user)) {
  // İstersen admin komutları çalışsın diye return etmeden önce cevap yazıyoruz
  await message.reply(markovSentence());
  return;

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
      const norm = normalizeText(content);

      memory.push(content);
      memorySet.add(norm);

      if (memory.length > MAX_MEMORY_MESSAGES) {
        const removed = memory.shift();
        memorySet.delete(normalizeText(removed));
      }
    }

    // === BOT MESAJINA REPLY ===
    if (
      message.reference &&
      message.mentions.repliedUser?.id === client.user.id &&
      Math.random() < REPLY_RESPONSE_CHANCE
    ) {
      await message.reply(markovSentence());
    }

    // === 5–20 ARASI RASTGELE ARALIKLA MESAJ AT ===
    messageCounter++;
    if (messageCounter >= nextMessageTarget) {
      messageCounter = 0;
      nextMessageTarget = Math.floor(Math.random() * 16) + 5; // 5–20
      await message.channel.send(markovSentence());
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

client.login(process.env.DISCORD_TOKEN);


