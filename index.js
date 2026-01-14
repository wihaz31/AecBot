require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

/* =========================
   AYARLAR
========================= */

// === SEED KANALI ===
const SEED_CHANNEL_ID = "705537838770421761";

// === Seed parametreleri ===
const SEED_DAYS = 180;      // son 180 gün
const SEED_MAX = 40000;     // en fazla 40k mesaj çek

// === Hafıza (canlı güncellenir) ===
const MAX_MEMORY_MESSAGES = 40000;

// === Üretimde yakın geçmişi hariç tut ===
const RECENT_EXCLUDE = 100; // son 100 mesajı modele dahil etme

// === Rastgele mesaj aralığı (5–20) ===
let messageCounter = 0;
let nextMessageTarget = Math.floor(Math.random() * 16) + 5; // 5–20

// === Bot mesajına reply gelince cevap ihtimali ===
const REPLY_RESPONSE_CHANCE = 0.75;

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

/* =========================
   FALLBACK WORD POOL (Markov yeterli olmazsa)
========================= */
const WORD_POOL = [
  "aga","kanka","bro","reis","moruk","abi","hocam","hırt","excel mühendisi",
  "sal","boşver","takıl","trip","cringe","based","aşkım çok pardon don",
  "random","kaos","aşırı","efsane","rezalet","offfff",
  "net","aynen","ayniyiz","yokartık","şaka mı","benim kafam felaket",
  "low","high","kopuyorum","patladım","susuyorum","oldu aşkımmm",
  "niye böyle","noluyo","ne alaka","ciddiyim","düşük anahtar rastgele",

  // === İNGİLİZCE / GLOBAL SLANG ===
  "bro","dude","bruh","lol","lmao","wtf","idk","imo",
  "fr","no cap","cap","sheesh","mid","npc","lowkey",
  "main character","skill issue","touch grass",
  "gg","ez","ff","go next","tryhard","toxic",
  "hardstuck","smurf","boosted","nerf","buff",

  // === LEAGUE OF LEGENDS TERİMLERİ ===
  "yasuo","yone","zed","akali","lee sin","viego",
  "ahri","jinx","caitlyn","thresh","lux","riven",
  "faker","keria","gumayusi","derken orda kulenin altına atıyor hahaaa",
  "soloQ","ranked","normal","aram","pankyyyy",
  "midlane","toplane","botlane","jungle","support",
  "gank","counter","outplay","int","feed","carry",
  "snowball","oneshot","burst","kite","peel","rakiplerinin ekmeğine yağğğğ sürüyor",
  "macro","micro","mechanic","draft","meta",
  "bronze","silver","gold","plat","emerald","diamond",
  "master","grandmaster","challenger","THE UNKILLABLE DEMON KING",

  // === LOL + SLANG KARIŞIK ===
  "yasuo","faker","mid diff","jg diff",
  "bot gap","report mid","open mid","ff15",
  "1v9","hard carry","int","mental boom",
  "tilt","rank","lp gitti",
  "smurf oe","boostlanmış","off meta",
  "düşünüyor","bekliyor","anlamıyor","soruyor","unutuyor","hatırlıyor",
  "karışıyor","yaklaşıyor","kaçıyor","izliyor","bozuluyor","süzülüyor",
  "dağılıyor","toplanıyor","yoruluyor","çözülüyor","kapanıyor","açılıyor",
  "sallanıyor","kayboluyor","beliriyor","sürükleniyor","çarpıyor","dokunuyor",
  "duraksıyor","akıyor","titreşiyor","blitzcrank",

  // isimler
  "zaman","duvar","ışık","ses","gece","gölge","masa","düşünce","kapı","yol",
  "rüya","kelime","boşluk","his","an","yasuo","porno","iz","bakış","adım","parça","ayna",
  "çizgi","nokta","hava","taş","su","cam","koridor","faker","soru","cevap","yankı",

  // sıfatlar
  "garip","sessiz","yansız","bulanık","eski","yeni","kırık","The UNKILLABLE DEMONKING","uzak","yakın",
  "belirsiz","rastgele","soğuk","sıcak","yavaş","ani","derin","yüzeysel",
  "karanlık","aydınlık","eksik","fazla","gizli","açık",

  // zarflar/bağlaçlar
  "birden","sanki","hala","aslında","belki","nedense","şu an","orada","burada",
  "bazen","sessizce","yavaşça","aniden","uzaktan","yakından","kendi kendine",

  // duygular/durumlar
  "yalnızlık","merak","şaşkınlık","kararsızlık","Makinalaşmak","huzur","gerilim","sıkıntı",
  "rahatlık","boşvermişlik","acele","duraksama","çelişki","uyumsuzluk","pencizorno","Arena ne amq",

  // zaman/mekan kırıntıları
  "bugün","yarın","şimdi","önce","sonra","içeride","dışarıda","Oral Mühendisi","arada","üstünde","altında",
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

function markovSentence() {
  if (memory.length < 60) return randomSentence();

  const usable =
    memory.length > RECENT_EXCLUDE ? memory.slice(0, memory.length - RECENT_EXCLUDE) : memory;

  const model = buildMarkov3(usable);
  const keys = Array.from(model.keys());
  if (!keys.length) return randomSentence();

  const targetLen = Math.floor(Math.random() * 6) + 5;
  const start = randomFrom(keys).split("|");
  const out = [...start];

  while (out.length < targetLen) {
    const key = `${out[out.length - 3]}|${out[out.length - 2]}|${out[out.length - 1]}`;
    const nexts = model.get(key);
    if (!nexts || nexts.length === 0) break;
    out.push(randomFrom(nexts));
  }

  let s = out.join(" ");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  s += Math.random() < 0.2 ? "..." : ".";
  return s;
}

/* =========================
   SEED: SON 180 GÜN (MAX 40K) + PROGRESS + RATE LIMIT
========================= */
async function seedByDays(channel, days = 180, maxMessages = 40000) {
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
      `Seed progress: ${collected.length}/${maxMessages} msgs | fetch=${seedState.fetchCount} | ${formatDuration(elapsedMs)} | ~${rate} msg/sn`
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
      const retryAfter =
        (e?.data && e.data.retry_after) ||
        e?.retry_after ||
        null;

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
      console.log("Seed: cutoff tarihine ulaşıldı (180 gün sınırı).");
      break;
    }

    beforeId = msgs.last().id;
  }

  memory.length = 0;
  memory.push(...collected);

  while (memory.length > MAX_MEMORY_MESSAGES) memory.shift();

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
    // sadece insan mesajları
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

        const now = Date.now();
        const elapsed = now - seedState.startedAt;
        const status = seedState.running
          ? "⏳ ÇALIŞIYOR"
          : seedState.done
          ? "✅ TAMAMLANDI"
          : seedState.error
          ? "❌ HATA"
          : "⏸️ DURDU";

        const rate =
          Math.round(seedState.collected / Math.max(1, Math.floor(elapsed / 1000)));

        await message.reply(
          [
            `Seed durumu: ${status}`,
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
      memory.push(content);
      if (memory.length > MAX_MEMORY_MESSAGES) memory.shift();
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
