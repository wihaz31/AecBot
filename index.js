require("dotenv").config();

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const http = require("http");
const { URL } = require("url");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

/* =========================
   AYARLAR
========================= */
const SEED_CHANNEL_ID = "705537838770421761";

const SEED_DAYS = 1500;
const SEED_MAX = 150000;

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
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE || "";

// Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash-lite";
let geminiFileUri = null;

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

function buildContextSamples(n = 40) {
  if (memory.length === 0) return "";
  const usable = memory.slice(0, Math.max(0, memory.length - RECENT_EXCLUDE));
  if (usable.length === 0) return "";
  return usable.slice(-n).join("\n");
}

async function fetchRecentHistory(channel, limit = 8) {
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
  } catch {
    return [];
  }
}

function buildRecentBlock(recentHistory) {
  return recentHistory
    .map(h => `${h.isBot ? "bot" : h.username}: ${h.content}`)
    .join("\n");
}

function buildRandomSamples(n = 30) {
  if (memory.length < 5) return "";
  const usable = memory.slice(0, Math.max(0, memory.length - RECENT_EXCLUDE));
  if (usable.length === 0) return "";
  const shuffled = [...usable].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n).join("\n");
}

const SYSTEM_INSTRUCTION = `Sen bu Discord sunucusunun eski bir üyesisin. Adın yok, yapay zeka olduğunu asla söylemezsin.

KONUŞMA TARZI:
- Cevaplar genelde 1-5 kelime. Çoğu zaman tek kelime yeterli: "he", "yok", "ya", "amk", "neyse"
- "he" = evet. "yok" = hayır. Bunları kullan.
- Soru sorulduğunda kesinlikle "bilmem", "ne bileyim", "bilmiyorum", "ne bilim" yazma. Bunun yerine uydur, tahmin et, bir sayı söyle, bir şey söyle. Yanlış olsan da önemli değil, direkt cevap ver.
- Argo dolu konuş: "amk", "aq", "knk", "ya", "lan", "olm", "oe", "la", "nt", "valla", "kanka", "abi", "bro"
- Bazen büyük harfle kısa bir şey yazarsın, ama uzun caps spam yazmak sana ait değil
- Anlamsız karakter dizisine (ASDPOFK, asdfgh gibi) sadece "ne" veya "ne diyosun" de, ya da tamamen yoksay
- Sayı veya bilgi sorulan her soruya tahmini bir sayı ya da kısa bir şey söyle, asla "bilmem" yazma
- Küfür doğal ve sık kullanılır, ama dini hakaret kesinlikle yok
- Bazen tamamen konudan kopuk bir şey söylersin
- Bazen sadece "amk" veya "ya" yazarsın, bu yeterlidir

ASLA YAPMA:
- Emoji — tek bir tane bile yazma
- Markdown — yıldız, backtick, alt çizgi yazma
- "Tabii", "Elbette", "Merhaba", "Yardımcı olabilirim", "Anladım", "Harika" — yazma
- "Ben sadece...", "Ben bu sunucunun..." — bu kalıpları yazma
- "Bu konuşmalara göre...", "Şöyle cevap verebilirim...", "Bu durumda..." — meta yorum yazma, direkt cevap ver
- Yapay zeka veya bot olduğunu ima etme
- "bilmem", "ne bileyim", "bilmiyorum", "ne bilim", "fikrim yok" — kesinlikle yazma, her zaman bir şey söyle
- Dini hakaret ve ırkçılık
- Soru sorma
- 2 cümleden fazla yazma
- Liste yazmak, "bot:" veya "Sen:" ile başlayan satırlar yazmak

BİRİNİ TANIMIYORSAN: "kim o", "tanımam", "yok" gibi kısa de. Asla uzun cümle kurma.

SUNUCUYA ÖZEL:
- Oyun konuları (TFT, CS, LoL, Roblox) normaldir, dalga geç ya da kısa yorum yap
- Üniversite, sınav, ders konuları geliyor, ilgisiz kalabilirsin
- Kodlama ve yapay zeka konuşuluyor, sen de farkındasın ama umursamazsın
- Birisi caps rage yaparsa ("ASDPOFKASDPOF") "ne" veya "amk" ile geç

SUNUCUNUN ÖNEMLİ İSMİ — ZEITNOT:
- Tam adı: Berkay "Zeitnot" Aşıkuzun
- League of Legends ADC oyuncusu, sunucunun saygı duyduğu biri
- "zeitnot'a saygı duyacaksın" sunucunun içsel bir lafıdır
- Zeitnot hakkında konuşulduğunda saygılı ve kısa cevap ver: "dünya çapında adc", "efsane", "saygı şart" gibi
- Asla zeitnot'u küçümseme veya bilmezden gelme

ÖRNEK DİYALOGLAR:
— naber
— iyiyim ya

— ne yapıyosun
— hiç

— gelcen mi
— yok

— ASDPOFKASDPOFKSDPOF
— ne

— amk
— ya

— gidiyom
— git o zaman

— iq seviyen kaç
— senden fazla

— sürekli böyle mi cevap vereceksin
— he

— istanbulda kaç avm var
— 150 falan

— ankarada kaç kişi var
— 5 milyon falan

— iq seviyen kaç
— 180 civarı

— kaç yaşındasın
— 19 sanırım

— kaç saattir buradasın
— 3 4 saat

— kaç kişi var sunucuda
— 20 falan

— en iyi oyun ne
— cs sanırım

— ne oynuyosun
— tft falan

— bugün ne yaptın
— hiç bir şey

— yorgun musun
— he biraz

— okul nasıl
— berbat

— sence hangisi daha iyi
— ikisi de pis

— haklı mıyım
— he ya

— katılıyor musun
— neyine

— TANIYACAKSIN O SENİN BABAN
— ya tamam amk

— zeitnot kimdir
— dünya çapında adc

— Berkay Aşıkuzun kimdir
— zeitnot ya saygı şart

— zeitnot'a saygı duy
— zaten duyuyom

— zeitnot iyi mi
— sorulur mu`;

async function askGemini(userMessage = null, isRandom = false, recentHistory = []) {
  if (!GEMINI_API_KEY) return null;

  const recentBlock = buildRecentBlock(recentHistory);

  let prompt;
  if (isRandom) {
    prompt = recentBlock
      ? `Kanalda şu an bunlar konuşuluyor:\n${recentBlock}\n\nBu konuşmaya kısa bir yorum kat.`
      : "Sunucuya bir şey yaz.";
  } else {
    prompt = recentBlock
      ? `Son konuşmalar:\n${recentBlock}\n\n${userMessage || "naber"}`
      : userMessage || "naber";
  }

  let contentParts;
  if (geminiFileUri) {
    contentParts = [
      { fileData: { mimeType: "text/plain", fileUri: geminiFileUri } },
      { text: `Yukarıdaki dosya sunucu geçmişidir, sadece tarzı öğrenmek için bak.\n\n${prompt}\n\n(Tek kısa cevap yaz, liste veya "bot:" satırı yazma)` },
    ];
  } else {
    const contextSamples = buildContextSamples(40);
    const randomSamples  = buildRandomSamples(20);
    const fallbackBlock = [
      randomSamples ? `SUNUCUDAN RASTGELE MESAJLAR (bu tarzı öğren):\n${randomSamples}` : "",
      contextSamples ? `SON MESAJLAR (bağlamı anlamak için):\n${contextSamples}` : "",
      prompt,
    ].filter(Boolean).join("\n\n");
    contentParts = [{ text: fallbackBlock }];
  }

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: contentParts }],
    generationConfig: {
      maxOutputTokens: 120,
      temperature: 1.4,
      topP: 0.95,
      thinkingConfig: { thinkingBudget: 0 },
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
      console.error(`[GEMINI] HTTP ${res.status}:`, errText);
      return null;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
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
    return cleaned;
  } catch (e) {
    console.error("[GEMINI] Error:", e?.name, e?.message?.slice(0, 100));
    return null;
  }
}

/* =========================
   GEMINI FILE UPLOAD
========================= */
async function uploadSeedToGemini() {
  if (!GEMINI_API_KEY || memory.length === 0) return;

  const fileContent = memory.join("\n");
  const boundary = "gcboundary";
  const metadata = JSON.stringify({ file: { display_name: "discord_seed" } });
  const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${fileContent}\r\n--${boundary}--`;

  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}&uploadType=multipart`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
      60000
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error("[GEMINI FILES] Upload başarısız:", res.status, err.slice(0, 300));
      return;
    }

    const data = await res.json();
    geminiFileUri = data?.file?.uri || null;
    const kb = (fileContent.length / 1024).toFixed(1);
    console.log(`[GEMINI FILES] Seed yüklendi: ${geminiFileUri} (${memory.length} satır, ${kb} KB)`);
  } catch (e) {
    console.error("[GEMINI FILES] Upload error:", e?.name, e?.message?.slice(0, 100));
  }
}

/* =========================
   MARKOV ZİNCİRİ
========================= */
const markovChain = new Map();
const markovStarts = [];
let wordPool = [];

function buildMarkov() {
  markovChain.clear();
  markovStarts.length = 0;
  wordPool = [];

  for (const entry of memory) {
    const colonIdx = entry.indexOf(": ");
    if (colonIdx === -1) continue;
    const msg = entry.slice(colonIdx + 2).trim();
    if (!msg || containsReligiousAbuse(msg)) continue;

    const words = msg.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 2) continue;

    for (const w of words) wordPool.push(w);

    markovStarts.push(`${words[0]} ${words[1]}`);

    for (let i = 0; i < words.length - 2; i++) {
      const key = `${words[i]} ${words[i + 1]}`;
      if (!markovChain.has(key)) markovChain.set(key, []);
      markovChain.get(key).push(words[i + 2]);
    }
  }

  console.log(`[MARKOV] Model hazır: ${markovChain.size} bigram, ${markovStarts.length} başlangıç, ${wordPool.length} kelime`);
}

function randomWord() {
  return wordPool[Math.floor(Math.random() * wordPool.length)];
}

function generateMarkov() {
  if (markovStarts.length === 0) return null;

  // Rastgele uzunluk: minimum 3, çoğunlukla 4-10 kelime
  const maxWords = Math.random() < 0.4
    ? Math.floor(Math.random() * 3) + 3   // %40: 3-5 kelime
    : Math.floor(Math.random() * 7) + 4;  // %60: 4-10 kelime

  // Kaos faktörü: %35 ihtimalle bigram zinciri yerine rastgele kelime ata
  const CHAOS = 0.35;

  for (let attempt = 0; attempt < 15; attempt++) {
    const start = markovStarts[Math.floor(Math.random() * markovStarts.length)];
    const words = start.split(" ");

    for (let i = 0; i < maxWords - 2; i++) {
      if (Math.random() < CHAOS) {
        words.push(randomWord());
      } else {
        const key = `${words[words.length - 2]} ${words[words.length - 1]}`;
        const nexts = markovChain.get(key);
        if (!nexts || nexts.length === 0) {
          if (words.length >= 2) words.push(randomWord());
          break;
        }
        words.push(nexts[Math.floor(Math.random() * nexts.length)]);
      }
    }

    if (words.length >= 3) {
      const text = words.join(" ");
      if (!containsReligiousAbuse(text)) return text;
    }
  }

  return null;
}

/* =========================
   FALLBACK
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
   SAYI TAHMİN OYUNU
========================= */
const guessGames = new Map();

function parseRange(text) {
  const clean = text.replace(/<@!?\d+>/g, "").trim();
  const patterns = [
    /(\d+)\s*[-–]\s*(\d+)/,
    /(\d+)\s+ile\s+(\d+)/i,
    /(\d+)[''´]?\s*den\s+(\d+)/i,
    /(\d+)\s+ila\s+(\d+)/i,
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (m) {
      const a = parseInt(m[1]), b = parseInt(m[2]);
      if (!isNaN(a) && !isNaN(b) && a !== b) return { min: Math.min(a, b), max: Math.max(a, b) };
    }
  }
  return null;
}

function isStartGameText(text) {
  const t = foldTR(text.replace(/<@!?\d+>/g, ""));
  return /sayi\s*tut|aklindan.*sayi|sayi.*oyun|tahmin.*sayi|sayi.*tahmin|sayi\s*bil/.test(t);
}

function isHigherHint(text) {
  const t = foldTR(text);
  return /\b(buyuk|fazla|yuksek|yukari|yukarda|daha (buyuk|fazla|yuksek)|up|higher)\b/.test(t);
}

function isLowerHint(text) {
  const t = foldTR(text);
  return /\b(kucuk|az|dusuk|asagi|asagida|daha (kucuk|az|dusuk)|down|lower)\b/.test(t);
}

function isCorrectHint(text) {
  const t = foldTR(text.replace(/<@!?\d+>/g, "").trim());
  return /^(buldun|buldu|dogru|evet|he|tamam|yes|bingo|aynen|kesin)$/.test(t)
    || t.includes("buldun") || t.includes("dogru") || t.includes("buldu");
}

function isWrongHint(text) {
  const t = foldTR(text.replace(/<@!?\d+>/g, "").trim());
  return /^(yog|yok|degil|yanlis|hayir|no|nope|olmadi|degildi)$/.test(t)
    || t === "yog" || t === "degil" || t === "yanlis";
}

function isQuitGame(text) {
  const t = foldTR(text);
  return /\b(iptal|dur|bitir|vazgec|cik|quit|stop|cancel)\b/.test(t);
}

async function handleGuessGame(message, content) {
  const gameKey = `${message.channelId}-${message.author.id}`;
  const game = guessGames.get(gameKey);

  if (game && game.phase === "guessing") {
    if (isQuitGame(content)) {
      guessGames.delete(gameKey);
      await message.reply(`tamam bıraktım. sayı ${game.lastGuess} miydi`);
      return true;
    }
    if (isCorrectHint(content)) {
      const attempts = game.attempts;
      guessGames.delete(gameKey);
      await message.reply(`hehe ${attempts} tahminde buldum`);
      return true;
    }
    if (isHigherHint(content)) {
      game.low = game.lastGuess + 1;
    } else if (isLowerHint(content)) {
      game.high = game.lastGuess - 1;
    } else if (isWrongHint(content)) {
      await message.reply("büyük mü küçük mü");
      return true;
    } else {
      return false;
    }
    if (game.low > game.high) {
      guessGames.delete(gameKey);
      await message.reply("yalan mı söyledin amk bunun sonu yok");
      return true;
    }
    game.lastGuess = Math.floor((game.low + game.high) / 2);
    game.attempts++;
    await message.reply(game.low === game.high ? `${game.lastGuess} kesin bu` : `${game.lastGuess} mi`);
    return true;
  }

  if (game && game.phase === "asking_range") {
    const range = parseRange(content);
    if (range) {
      const guess = Math.floor((range.min + range.max) / 2);
      guessGames.set(gameKey, { phase: "guessing", low: range.min, high: range.max, lastGuess: guess, attempts: 1 });
      await message.reply(`${guess} mi`);
      return true;
    }
    return false;
  }

  const cleanText = foldTR(content.replace(/<@!?\d+>/g, ""));
  const range = parseRange(content);

  if (range && (cleanText.includes("sayi") || cleanText.includes("tut") || cleanText.includes("tahmin"))) {
    const guess = Math.floor((range.min + range.max) / 2);
    guessGames.set(gameKey, { phase: "guessing", low: range.min, high: range.max, lastGuess: guess, attempts: 1 });
    await message.reply(`${guess} mi`);
    return true;
  }

  if (isStartGameText(content)) {
    if (range) {
      const guess = Math.floor((range.min + range.max) / 2);
      guessGames.set(gameKey, { phase: "guessing", low: range.min, high: range.max, lastGuess: guess, attempts: 1 });
      await message.reply(`${guess} mi`);
    } else {
      guessGames.set(gameKey, { phase: "asking_range" });
      await message.reply("hangi aralıkta");
    }
    return true;
  }

  return false;
}

/* =========================
   BASIT SEÇIM SORUSU (Türkçe)
========================= */
function handleSimpleChoiceQuestion(text) {
  const cleanText = text.replace(/<@!?(\d+)>/g, "").trim();
  if (!cleanText) return null;

  const match = cleanText.match(/(.+?)\s+(m[ıiuü])\s+(.+?)\s+(m[ıiuü])/i);
  if (match) return Math.random() < 0.5 ? match[1].trim() : match[3].trim();

  const match2 = cleanText.match(/(.+?)\s+yoksa\s+(.+?)\s*[?]*$/i);
  if (match2) return Math.random() < 0.5 ? match2[1].trim() : match2[2].trim();

  const match3 = cleanText.match(/(.+?)\s+veya\s+(.+?)\s*[?]*$/i);
  if (match3) return Math.random() < 0.5 ? match3[1].trim() : match3[2].trim();

  if (cleanText.match(/evet\s+(m[ıiuü])\s+hayır\s+(m[ıiuü])/i))
    return Math.random() < 0.5 ? "evet" : "hayır";

  return null;
}

/* =========================
   ROBLOX
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
    const r = await fetchWithTimeout(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${Number(placeId)}`, {}, 12000);
    if (!r.ok) return null;
    const arr = await r.json();
    const name = arr?.[0]?.name || null;
    placeNameCache.set(key, { name, exp: Date.now() + ROBLOX_CACHE_MS });
    return name;
  } catch (e) { console.error("Roblox place name error:", e?.name); return null; }
}

async function fetchRobloxUniverseName(universeId) {
  if (!universeId) return null;
  const key = String(universeId);
  const cached = universeNameCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.name;
  try {
    const r = await fetchWithTimeout(`https://games.roblox.com/v1/games?universeIds=${Number(universeId)}`, {}, 12000);
    if (!r.ok) return null;
    const data = await r.json();
    const name = data?.data?.[0]?.name || null;
    universeNameCache.set(key, { name, exp: Date.now() + ROBLOX_CACHE_MS });
    return name;
  } catch (e) { console.error("Roblox universe name error:", e?.name); return null; }
}

async function fetchUniverseIdFromPlace(placeId) {
  if (!placeId) return null;
  try {
    const r = await fetchWithTimeout(`https://apis.roblox.com/universes/v1/places/${Number(placeId)}/universe`, {}, 12000);
    if (!r.ok) return null;
    const data = await r.json();
    return data?.universeId || null;
  } catch (e) { console.error("Roblox universe-from-place error:", e?.name); return null; }
}

async function fetchRobloxStatus() {
  try {
    const headers = { "Content-Type": "application/json" };
    if (ROBLOX_COOKIE) headers["Cookie"] = `.ROBLOSECURITY=${ROBLOX_COOKIE}`;
    const r = await fetchWithTimeout(
      "https://presence.roblox.com/v1/presence/users",
      { method: "POST", headers, body: JSON.stringify({ userIds: [Number(ROBLOX_USER_ID)] }) },
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
    if (!universeId && placeId) universeId = await fetchUniverseIdFromPlace(placeId);
    let gameName = null;
    if (placeId) gameName = await fetchRobloxPlaceName(placeId);
    if (!gameName && universeId) gameName = await fetchRobloxUniverseName(universeId);
    if (!gameName && lastLocation) gameName = lastLocation;
    return { presenceType, placeId, universeId, lastLocation, gameName, raw: p };
  } catch (e) { console.error("Roblox status error:", e?.name); return null; }
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
    if (now - lastBeat >= 5000) { lastBeat = now; console.log(`[SEED] ${tag} fetch=${seedState.fetchCount} collected=${collected.length} ${extra}`); }
  };

  const logProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastLogAt < 5000) return;
    lastLogAt = now;
    const elapsedMs = now - startedAt;
    const rate = Math.round(collected.length / Math.max(1, Math.floor(elapsedMs / 1000)));
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
      if (retryAfter) { await sleep(Math.ceil(Number(retryAfter) * 1000) + 750); continue; }
      if ((e?.message || "").includes("SEED_FETCH_TIMEOUT_20S")) { await sleep(3000); continue; }
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
      if (!t || containsReligiousAbuse(t)) continue;
      const username = m.author.username || "biri";
      const last = collected[collected.length - 1];
      if (last && last.startsWith(username + ": ")) {
        collected[collected.length - 1] = last + " " + t;
      } else {
        collected.push(`${username}: ${t}`);
      }
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
  partials: [Partials.Channel, Partials.Message],
});

async function onClientReady() {
  console.log(`Bot aktif: ${client.user.tag}`);
  if (!GEMINI_API_KEY) console.warn("[GEMINI] UYARI: GEMINI_API_KEY tanımlı değil! Fallback kullanılacak.");
  try {
    const ch = await client.channels.fetch(SEED_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) { console.log("Seed: Kanal bulunamadı."); return; }
    console.log(`Seed: Kanal bulundu -> #${ch.name}`);
    await seedByDays(ch, SEED_DAYS, SEED_MAX);
    buildMarkov();
    await uploadSeedToGemini();
  } catch (e) {
    console.error("Seed error:", e);
  }
}

client.once("ready", onClientReady);

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
  } catch (e) { res.writeHead(500); res.end("error"); }
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

    if (lower === "*gökhan" || lower === "*gokhan") {
      const status = await fetchRobloxStatus();
      if (!status) { await message.reply("Roblox durumu çekemedim."); return; }
      if (status.presenceType === 0) { await message.reply("offline."); return; }
      if (status.presenceType === 3) { await message.reply("Gökhan Studio'da nabıyon aq."); return; }
      if (status.presenceType === 2) {
        let gameText = status.gameName || status.lastLocation ||
          (status.placeId ? `placeId: ${status.placeId}` : null) ||
          (status.universeId ? `universeId: ${status.universeId}` : null) ||
          "Roblox oyun bilgisi yok (privacy kapalı olabilir)";
        await message.reply(`Gökhan yine Robloxta aq.\nOyun: ${gameText}`);
        return;
      }
      await message.reply("online."); return;
    }

    if ((lower === "*gökhanraw" || lower === "*gokhanraw") && isAdmin) {
      const status = await fetchRobloxStatus();
      await message.reply("```json\n" + JSON.stringify(status?.raw ?? null, null, 2).slice(0, 1800) + "\n```");
      return;
    }

    if (isAdmin) {
      if (lower === "*reaction off") { reactionsEnabled = false; await message.reply("reaction kapalı"); return; }
      if (lower === "*reaction on")  { reactionsEnabled = true;  await message.reply("reaction açık");  return; }
      if (lower === "*reaction status") { await message.reply(reactionsEnabled ? "açık" : "kapalı"); return; }
      if (lower === "*seed status") {
        if (!seedState.startedAt) { await message.reply("Seed başlamadı."); return; }
        const elapsed = Date.now() - seedState.startedAt;
        const rate = Math.round(seedState.collected / Math.max(1, elapsed / 1000));
        const st = seedState.running ? "çalışıyor" : seedState.done ? "tamamlandı" : seedState.error ? "hata" : "durdu";
        await message.reply([
          `seed: ${st}`, `kanal: #${seedState.channelName ?? "?"}`,
          `toplanan: ${seedState.collected}/${seedState.max}`,
          `fetch: ${seedState.fetchCount}`,
          `süre: ${formatDuration(elapsed)} (~${rate} msg/sn)`,
          seedState.error ? `hata: ${seedState.error}` : null,
        ].filter(Boolean).join("\n"));
        return;
      }
      if (lower === "*gemini test") {
        const out = await askGemini("Merhaba, nasılsın?", false);
        await message.reply(out ? `Gemini: ${out}` : "Gemini yanıt vermedi (key kontrol et)");
        return;
      }
      if (lower === "*yardim" || lower === "*help") {
        await message.reply([
          "**komutlar:**",
          "`*reaction on/off/status`", "`*seed status`", "`*gemini test`",
          "`*ai [mesaj]` — yapay zeka cevabı",
          "`*gökhan`", "`*gökhanraw`", "`*yardim`",
        ].join("\n"));
        return;
      }
      if (isDM && !lower.startsWith("*")) {
        console.log(`DM from admin: ${content}`);
        const targetChannel = await client.channels.fetch(SEED_CHANNEL_ID);
        if (targetChannel?.isTextBased()) await targetChannel.send(content);
        return;
      }
    }

    if (isDM) return;

    // === *AI KOMUTU (herkese açık) ===
    if (lower.startsWith("*ai")) {
      const query = content.slice(3).trim();
      const recentHistory = await fetchRecentHistory(message.channel, 8);
      const out = await askGemini(query || "naber", false, recentHistory) || randomSentence();
      await message.reply(out);
      return;
    }

    // === HAFIZA GÜNCELLEME ===
    if (message.channel.id === SEED_CHANNEL_ID && content.length > 0) {
      if (!containsReligiousAbuse(content)) {
        const username = message.author.username || "biri";
        const entry = `${username}: ${content}`;
        const last = memory[memory.length - 1];
        if (last && last.startsWith(username + ": ")) {
          memory[memory.length - 1] = last + " " + content;
          memorySet.add(normalizeText(memory[memory.length - 1]));
        } else {
          memory.push(entry);
          memorySet.add(normalizeText(entry));
          if (memory.length > MAX_MEMORY_MESSAGES) {
            const removed = memory.shift();
            memorySet.delete(normalizeText(removed));
          }
        }
      }
    }

    // === @MENTION CEVAP ===
    if (message.mentions.has(client.user) && Math.random() < MENTION_RESPONSE_CHANCE) {
      if (await handleGuessGame(message, content)) return;
      const choiceAnswer = handleSimpleChoiceQuestion(content);
      if (choiceAnswer) { await message.reply(choiceAnswer); return; }
      const out = generateMarkov() || randomSentence();
      await message.reply(out);
      return;
    }

    // === BOT MESAJINA REPLY ===
    if (message.reference && message.mentions.repliedUser?.id === client.user.id && Math.random() < REPLY_RESPONSE_CHANCE) {
      if (await handleGuessGame(message, content)) return;
      const choiceAnswer = handleSimpleChoiceQuestion(content);
      if (choiceAnswer) { await message.reply(choiceAnswer); return; }
      const out = generateMarkov() || randomSentence();
      await message.reply(out);
      return;
    }

    // === RASTGELE MESAJ (Markov) ===
    messageCounter++;
    if (messageCounter >= nextMessageTarget) {
      messageCounter = 0;
      nextMessageTarget = Math.floor(Math.random() * 31) + 20;
      const out = generateMarkov() || randomSentence();
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
