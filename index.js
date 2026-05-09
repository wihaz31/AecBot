require("dotenv").config();

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const http = require("http");
const { URL } = require("url");
const { Client, GatewayIntentBits } = require("discord.js");

/* ── AYARLAR ──────────────────────────────────────── */
const SEED_CHANNEL_ID = "705537838770421761";
const SEED_DAYS       = 240;
const SEED_MAX        = 40000;
const MAX_MEMORY      = 40000;
const RECENT_EXCLUDE  = 100;
const REPLY_CHANCE    = 1;
const MENTION_CHANCE  = 1;
const ADMIN_USER_ID   = "297433660553035778";
const TARGET_USER_ID  = "403940186494599168";
const EMOJI_1         = "🪑";
const EMOJI_2         = "🪢";
const PORT            = process.env.PORT || 8000;
const CMD_KEY         = process.env.CMD_KEY || "";
const ROBLOX_USER_ID  = "2575829815";
const GROQ_API_KEY    = process.env.GROQ_API_KEY || "";
const GROQ_MODEL      = "llama-3.3-70b-versatile";
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL    = "gemini-2.0-flash";
const RETRY_DELAYS    = [2000, 4000];

let reactionsEnabled  = false;
let messageCounter    = 0;
let nextMessageTarget = randInt(20, 51);

/* ── SEED DURUMU ──────────────────────────────────── */
const seedState = {
  running: false, done: false, error: null, channelName: null,
  days: SEED_DAYS, max: SEED_MAX, collected: 0, fetchCount: 0,
  startedAt: null, lastUpdateAt: null,
};

/* ── YARDIMCI ─────────────────────────────────────── */
function randInt(min, max) { return Math.floor(Math.random() * (max - min)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomFrom(arr) { return arr[randInt(0, arr.length)]; }

function formatDuration(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return `${h}saat ${m % 60}dk ${s % 60}sn`;
  if (m > 0) return `${m}dk ${s % 60}sn`;
  return `${s}sn`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ── HAFIZA ───────────────────────────────────────── */
const memory       = [];
const memorySet    = new Set();
const botRecentSet = new Set();
const BOT_RECENT_LIMIT = 200;

function normalizeText(s) {
  return (s || "").toLowerCase().trim().replace(/\s+/g, " ").replace(/[.?!…]+$/g, "");
}

function addToMemory(text) {
  if (!text) return;
  memory.push(text);
  memorySet.add(normalizeText(text));
  if (memory.length > MAX_MEMORY) {
    const removed = memory.shift();
    memorySet.delete(normalizeText(removed));
  }
}

function rememberBotOutput(text) {
  if (!text || text.length < 3) return;
  addToMemory(text);
  botRecentSet.add(normalizeText(text));
  if (botRecentSet.size > BOT_RECENT_LIMIT) {
    botRecentSet.delete(botRecentSet.values().next().value);
  }
}

/* ── DİN + KÜFÜR ENGELİ ──────────────────────────── */
function foldTR(s) {
  return (s || "").toLowerCase()
    .replace(/ı/g, "i").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ş/g, "s")
    .replace(/ö/g, "o").replace(/ç/g, "c");
}

function squash(s) {
  return foldTR(s)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<@!?(\d+)>/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

const RELIGIOUS_TERMS = [
  "allah","tanri","peygamber","muhammed","4ll4h",
  "kuran","kur an","allanı","muhammedini","peygamberini",
].map(squash);

const SWEAR_TERMS = [
  "amk","aq","amq","o c","oc","sik","s1k","s*k","sikeyim","siktir",
  "orospu","pic","piç","anan","bacini","got","g0t","yarrak","yarak","ibne","kahpe",
].map(squash);

function containsReligiousAbuse(text) {
  const t = squash(text);
  if (!t) return false;
  return RELIGIOUS_TERMS.some(r => t.includes(r)) && SWEAR_TERMS.some(w => t.includes(w));
}

/* ── AI ÇIKTI TEMİZLEME ──────────────────────────── */
const EMOJI_RE    = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{1F300}-\u{1F9FF}]/gu;
const MARKDOWN_RE = /\*+|`+|_{2,}/g;

function cleanAIOutput(text) {
  if (!text) return null;
  const cleaned = text
    .replace(EMOJI_RE, "")
    .replace(MARKDOWN_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || null;
}

const REFUSAL_PATTERNS = [
  "cevap veremem","cevap vermem","bilgi bulunmuyor","bilgi yok",
  "boşuna konuşma","boş konuşma","boşuna konuşuyorsun",
  "i cannot","i can't","i'm unable","i won't","i will not",
  "as an ai","as a language model",
];

function isRefusal(text) {
  if (!text) return true;
  const lower = text.toLowerCase();
  return REFUSAL_PATTERNS.some(p => lower.includes(p));
}

/* ── FALLBACK WORD POOL ───────────────────────────── */
const WORD_POOL = [
  "aga","kanka","bro","reis","moruk","abi","hocam","sal","boşver","takıl",
  "trip","cringe","based","random","kaos","efsane","rezalet","offfff",
  "aynen","yokartık","şaka mı","noluyo","ne alaka","ciddiyim",
  "lol","lmao","wtf","idk","imo","fr","no cap","cap","sheesh",
  "mid","npc","lowkey","skill issue","touch grass",
  "gg","ez","ff","go next","tryhard","toxic","hardstuck",
];

function randomSentence() {
  const len = randInt(3, 7);
  return Array.from({ length: len }, () => randomFrom(WORD_POOL)).join(" ");
}

/* ── CONTEXT & FEW-SHOT ───────────────────────────── */
function buildContextSamples(n = 1000) {
  if (memory.length === 0) return "";
  // En son RECENT_EXCLUDE mesajı hariç tut (yakın zamanlı → tekrar riski var)
  const usable = memory.slice(0, Math.max(0, memory.length - RECENT_EXCLUDE));
  return usable.slice(-n).join("\n");
}

let serverPersonality = "";
let fewShotPairs = [];

function buildFewShotPairs() {
  if (memory.length < 20) return;
  const usable = memory.slice(0, memory.length - RECENT_EXCLUDE);
  const pairs = [];

  for (let i = 0; i < usable.length - 1; i++) {
    const q = usable[i];
    const a = usable[i + 1];
    if (!q || !a) continue;
    if (q.includes("http") || a.includes("http")) continue;
    if (q.includes("<@") || a.includes("<@")) continue;

    const qUser = q.split(":")[0];
    const aUser = a.split(":")[0];
    if (qUser === aUser) continue;

    const qContent = q.includes(": ") ? q.split(": ").slice(1).join(": ") : q;
    const aContent = a.includes(": ") ? a.split(": ").slice(1).join(": ") : a;

    const qw = qContent.split(" ").length;
    const aw = aContent.split(" ").length;
    if (qw < 1 || qw > 10 || aw < 1 || aw > 8) continue;
    if (qContent.length < 3 || aContent.length < 2) continue;
    if (containsReligiousAbuse(qContent) || containsReligiousAbuse(aContent)) continue;
    // Tekrar eden aynı karakter dizisini filtrele
    if (/(.)\1{3,}/.test(qContent) || /(.)\1{3,}/.test(aContent)) continue;
    if (/[A-Z]{8,}/.test(qContent) || /[A-Z]{8,}/.test(aContent)) continue;

    pairs.push({ q: qContent, a: aContent });
  }

  fewShotPairs = pairs;
  console.log(`[FEWSHOT] ${pairs.length} çift hazırlandı`);
}

function getRandomFewShot(n = 20) {
  if (fewShotPairs.length === 0) return "";
  return [...fewShotPairs]
    .sort(() => Math.random() - 0.5)
    .slice(0, n)
    .map(p => `— ${p.q}\n— ${p.a}`)
    .join("\n\n");
}

/* ── SİSTEM PROMPTU (paylaşımlı) ─────────────────── */
function buildSystemPrompt(fewShot, contextSamples) {
  const personalityNote = serverPersonality
    ? `\n\nBU SUNUCUNUN KENDİNE ÖZGÜ TARZI:\n${serverPersonality}`
    : "";

  return `Sen bu Discord sunucusunun eski bir üyesisin. İsmin yok, kendini tanıtmazsın.${personalityNote}

KONUŞMA TARZI:
• Çoğunlukla 1-5 kelime. Nadiren daha fazla.
• Tek kelime cevaplar normaldir: "ya", "bilmem", "he", "neden ki", "aynen"
• Argo: "olm", "lan", "ya", "knk", "kanka", "abi", "bro", "moruk", "hocam", "reis"
• Kısaltmalar: "amk", "aq", "bi", "falan", "zaten", "mk", "naber", "napıyon"
• Küfür — doğal ama her cümlede değil, sadece vurgu için
• Noktalama genelde yok, büyük harf yok, cümleler yarım kalabilir
• Bazen tamamen alakasız bir şey söylersin — bu normaldir
• Bazen öfkeli, bazen dalga geçen, bazen umursamaz
• Anlamsız karakter dizisine (asdfgh gibi) alaycı cevap ver

ASLA YAPMA:
• Emoji — kesinlikle yok
• Markdown — yok
• "Tabii ki", "elbette", "merhaba", "yardımcı olabilirim" — yok
• "Anladım", "yani demek ki", "harika soru" — yok
• Sürekli soru sormak — yok
• Az önce söylediğini tekrar etmek — yok
• Dini hakaret ve ırkçılık — kesinlikle yok
• Yapay zeka olduğunu söylemek — yok

ÖRNEK DİYALOGLAR:
${fewShot || `— naber\n— iyiyim lan\n\n— bro bu ne\n— bilmiyorum ya\n\n— gelsene\n— meşgulüm\n\n— ne düşünüyorsun\n— fark etmez\n\n— çok konuştun\n— he\n\n— nasılsın\n— iyiyim sanırım`}

SON MESAJLAR (bu insanların dilini, argosunu, tarzını öğren ve aynen kullan):
${contextSamples || "(henüz mesaj yok)"}`;
}

/* ── KANAL GEÇMİŞİ ───────────────────────────────── */
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

/* ── PROMPT OLUŞTURUCULAR ─────────────────────────── */
const SHORT_Q_WORDS = [
  "neden","nasıl","ne","kim","nerede","niye","huh","ha",
  "ne yani","naber","napıyon","nabıyon","ne zaman",
];

function buildUserPrompt(userMessage, isRandom, recentHistory) {
  if (isRandom) {
    return "Kanaldaki konuşmaya kısa bir yorum kat. Özetleme, direkt bir şey söyle.";
  }

  const isShortQ = userMessage &&
    userMessage.trim().split(" ").length <= 3 &&
    SHORT_Q_WORDS.some(w => userMessage.toLowerCase().includes(w));

  const lastBotMsg = recentHistory.filter(h => h.isBot).slice(-1)[0]?.content || null;

  if (isShortQ && lastBotMsg) {
    return `Sen az önce "${lastBotMsg}" dedin. Şimdi "${userMessage}" diye soruyorlar. Bağlantılı ve kısa cevap ver.`;
  }

  return userMessage || "naber";
}

function buildHistoryBlock(recentHistory) {
  const lines = [];

  for (let i = 0; i < recentHistory.length; i++) {
    const h = recentHistory[i];
    const next = recentHistory[i + 1];
    const name = h.isBot ? "Sen" : h.username;

    if (!h.isBot && next?.isBot) {
      lines.push(`${name}: ${h.content} → Sen: ${next.content}`);
      i++;
    } else if (h.isBot && i > 0 && !recentHistory[i - 1].isBot) {
      // önceki satırda zaten gösterildi
    } else {
      lines.push(`${name}: ${h.content}`);
    }
  }

  const botReplies = recentHistory
    .filter(h => h.isBot)
    .map(h => h.content)
    .slice(-3)
    .join(", ");

  let block = lines.join("\n");
  if (botReplies) block += `\n\n[Sen az önce şunları söyledin: "${botReplies}" — bunları TEKRAR ETME]`;
  return block;
}

/* ── SUNUCU KİŞİLİĞİ ANALİZİ ─────────────────────── */
async function analyzeServerPersonality() {
  if (!GROQ_API_KEY || memory.length < 100) return;

  const sample = Array.from({ length: 60 }, () => memory[randInt(0, memory.length)]);
  const prompt = `Aşağıdaki Discord konuşmalarını analiz et ve bu sunucunun konuşma tarzını 5-8 cümleyle özetle.
Şunları belirt: sık kullanılan kelimeler/argo, konuşma tonu, sık geçen konular, mizah tarzı.
Kısa ve net yaz, madde madde değil düz metin olarak.

KONUŞMALAR:
${sample.join("\n")}`;

  try {
    const res = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 200,
          temperature: 0.3,
        }),
      },
      20000
    );
    if (!res.ok) return;
    const text = (await res.json())?.choices?.[0]?.message?.content?.trim();
    if (text) {
      serverPersonality = text;
      console.log("[PERSONALITY] Analiz tamamlandı:", text.slice(0, 100) + "...");
    }
  } catch (e) {
    console.warn("[PERSONALITY] Analiz hatası:", e?.message?.slice(0, 60));
  }

  buildFewShotPairs();
}

/* ── GEMINI AI ────────────────────────────────────── */
async function askGemini(userMessage, isRandom, recentHistory) {
  if (!GEMINI_API_KEY) return null;

  const systemText    = buildSystemPrompt(getRandomFewShot(20), buildContextSamples(1000));
  const userPrompt    = buildUserPrompt(userMessage, isRandom, recentHistory);
  const historyBlock  = buildHistoryBlock(recentHistory);

  const contents = [];
  if (historyBlock.trim()) {
    contents.push({ role: "user",  parts: [{ text: "Son konuşmalar:\n" + historyBlock }] });
    contents.push({ role: "model", parts: [{ text: "tamam" }] });
  }
  contents.push({ role: "user", parts: [{ text: userPrompt }] });

  const body = {
    system_instruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: { maxOutputTokens: 80, temperature: 1.0, topP: 0.92 },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",       threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        15000
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if ((res.status === 503 || res.status === 429) && attempt < RETRY_DELAYS.length) {
          console.warn(`[GEMINI] ${res.status} retry ${attempt + 1}`);
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        console.error(`[GEMINI] HTTP ${res.status}:`, errText.slice(0, 150));
        return null;
      }

      const raw = (await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!raw || containsReligiousAbuse(raw)) return null;
      const cleaned = cleanAIOutput(raw);
      if (!cleaned || isRefusal(cleaned)) return null;
      return cleaned;

    } catch (e) {
      if (attempt < RETRY_DELAYS.length) {
        console.warn(`[GEMINI] retry: ${e?.name}`);
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      console.error("[GEMINI] Error:", e?.name, e?.message?.slice(0, 100));
      return null;
    }
  }
  return null;
}

/* ── GROQ AI ──────────────────────────────────────── */
async function askGroq(userMessage, isRandom, recentHistory) {
  if (!GROQ_API_KEY) return null;

  const systemText   = buildSystemPrompt(getRandomFewShot(6), buildContextSamples(80));
  const userPrompt   = buildUserPrompt(userMessage, isRandom, recentHistory);
  const historyBlock = buildHistoryBlock(recentHistory);

  const messages = [{ role: "system", content: systemText }];
  if (historyBlock.trim()) {
    messages.push({ role: "user",      content: "Son konuşmalar:\n" + historyBlock });
    messages.push({ role: "assistant", content: "tamam" });
  }
  messages.push({ role: "user", content: userPrompt });

  const body = { model: GROQ_MODEL, messages, max_tokens: 80, temperature: 1.0, top_p: 0.92 };

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify(body),
        },
        15000
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if ((res.status === 503 || res.status === 429) && attempt < RETRY_DELAYS.length) {
          console.warn(`[GROQ] ${res.status} retry ${attempt + 1}`);
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        console.error(`[GROQ] HTTP ${res.status}:`, errText.slice(0, 200));
        return null;
      }

      const raw = (await res.json())?.choices?.[0]?.message?.content?.trim();
      if (!raw || containsReligiousAbuse(raw)) return null;
      const cleaned = cleanAIOutput(raw);
      if (!cleaned || isRefusal(cleaned)) return null;
      return cleaned;

    } catch (e) {
      if (attempt < RETRY_DELAYS.length) {
        console.warn(`[GROQ] retry: ${e?.name}`);
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      console.error("[GROQ] Error:", e?.name, e?.message?.slice(0, 100));
      return null;
    }
  }
  return null;
}

/* Gemini → Groq sırasıyla dene */
async function askAI(userMessage = null, isRandom = false, recentHistory = []) {
  if (GEMINI_API_KEY) {
    const result = await askGemini(userMessage, isRandom, recentHistory);
    if (result) return result;
  }
  return askGroq(userMessage, isRandom, recentHistory);
}

/* ── ROBLOX ───────────────────────────────────────── */
const placeNameCache   = new Map();
const universeNameCache = new Map();
const ROBLOX_CACHE_MS  = 10 * 60 * 1000;

async function fetchRobloxPlaceName(placeId) {
  if (!placeId) return null;
  const key    = String(placeId);
  const cached = placeNameCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.name;
  try {
    const r = await fetchWithTimeout(
      `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${Number(placeId)}`,
      {}, 12000
    );
    if (!r.ok) return null;
    const name = (await r.json())?.[0]?.name || null;
    placeNameCache.set(key, { name, exp: Date.now() + ROBLOX_CACHE_MS });
    return name;
  } catch (e) {
    console.error("Roblox place name error:", e?.name);
    return null;
  }
}

async function fetchRobloxUniverseName(universeId) {
  if (!universeId) return null;
  const key    = String(universeId);
  const cached = universeNameCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.name;
  try {
    const r = await fetchWithTimeout(
      `https://games.roblox.com/v1/games?universeIds=${Number(universeId)}`,
      {}, 12000
    );
    if (!r.ok) return null;
    const name = (await r.json())?.data?.[0]?.name || null;
    universeNameCache.set(key, { name, exp: Date.now() + ROBLOX_CACHE_MS });
    return name;
  } catch (e) {
    console.error("Roblox universe name error:", e?.name);
    return null;
  }
}

async function fetchUniverseIdFromPlace(placeId) {
  if (!placeId) return null;
  try {
    const r = await fetchWithTimeout(
      `https://apis.roblox.com/universes/v1/places/${Number(placeId)}/universe`,
      {}, 12000
    );
    if (!r.ok) return null;
    return (await r.json())?.universeId || null;
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

    const p = (await r.json())?.userPresences?.[0];
    if (!p) return null;

    const presenceType  = p.userPresenceType;
    const placeId       = p.placeId || null;
    let   universeId    = p.universeId || null;
    const lastLocation  = (p.lastLocation || "").trim() || null;

    if (!universeId && placeId) universeId = await fetchUniverseIdFromPlace(placeId);

    let gameName = null;
    if (placeId)    gameName = await fetchRobloxPlaceName(placeId);
    if (!gameName && universeId) gameName = await fetchRobloxUniverseName(universeId);
    if (!gameName)  gameName = lastLocation;

    return { presenceType, placeId, universeId, lastLocation, gameName, raw: p };
  } catch (e) {
    console.error("Roblox status error:", e?.name);
    return null;
  }
}

/* ── SEED ─────────────────────────────────────────── */
async function seedByDays(channel, days = SEED_DAYS, maxMessages = SEED_MAX) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const collected = [];
  let beforeId = undefined;

  Object.assign(seedState, {
    running: true, done: false, error: null,
    channelName: channel?.name || null,
    days, max: maxMessages, collected: 0, fetchCount: 0,
    startedAt: Date.now(), lastUpdateAt: Date.now(),
  });

  const startedAt = seedState.startedAt;
  let lastLogAt = startedAt, lastBeat = 0;

  const beat = (tag, extra = "") => {
    const now = Date.now();
    if (now - lastBeat < 5000) return;
    lastBeat = now;
    console.log(`[SEED] ${tag} fetch=${seedState.fetchCount} collected=${collected.length} ${extra}`);
  };

  const logProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastLogAt < 5000) return;
    lastLogAt = now;
    const elapsed = now - startedAt;
    const rate = Math.round(collected.length / Math.max(1, elapsed / 1000));
    console.log(`Seed: ${collected.length}/${maxMessages} | fetch=${seedState.fetchCount} | ${formatDuration(elapsed)} | ~${rate} msg/sn`);
    seedState.collected = collected.length;
    seedState.lastUpdateAt = now;
  };

  console.log(`Seed başladı: son ${days} gün, max ${maxMessages} mesaj (#${channel.name})`);

  while (collected.length < maxMessages) {
    await new Promise(r => setImmediate(r));

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
        console.log(`[SEED] RATE LIMIT: ${retryAfter}s bekliyor...`);
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
  while (memory.length > MAX_MEMORY) memory.shift();

  memorySet.clear();
  for (const t of memory) memorySet.add(normalizeText(t));

  logProgress(true);
  Object.assign(seedState, { running: false, done: true, error: null });
  console.log(`Seed tamam ✅ Hafıza: ${memory.length} mesaj (#${channel.name})`);

  try {
    const fs = require("fs");
    fs.writeFileSync("seed.txt", memory.join("\n"), "utf8");
    console.log(`[SEED] seed.txt kaydedildi (${memory.length} satır)`);
  } catch (e) {
    console.warn("[SEED] seed.txt kaydedilemedi:", e?.message?.slice(0, 60));
  }

  await analyzeServerPersonality();
}

/* ── DISCORD CLIENT ───────────────────────────────── */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once("ready", async () => {
  console.log(`Bot aktif: ${client.user.tag}`);
  if (!GROQ_API_KEY) console.warn("[GROQ] UYARI: GROQ_API_KEY tanımlı değil!");

  try {
    const ch = await client.channels.fetch(SEED_CHANNEL_ID);
    if (!ch?.isTextBased()) { console.log("Seed: Kanal bulunamadı."); return; }
    console.log(`Seed: Kanal bulundu -> #${ch.name}`);
    await seedByDays(ch, SEED_DAYS, SEED_MAX);
  } catch (e) {
    console.error("Seed error:", e);
  }
});

/* ── HTTP SERVER ──────────────────────────────────── */
http.createServer(async (req, res) => {
  try {
    const u      = new URL(req.url, `http://${req.headers.host}`);
    const path   = u.pathname;
    const action = (u.searchParams.get("action") || "").toLowerCase();

    if (path === "/") { res.writeHead(200); return res.end("OK"); }

    if (path === "/cmd") {
      const key = u.searchParams.get("key") || "";
      if (!CMD_KEY || key !== CMD_KEY) { res.writeHead(401); return res.end("unauthorized"); }

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

      if (action === "get_seed") {
        const fs = require("fs");
        if (!fs.existsSync("seed.txt")) { res.writeHead(404); return res.end("seed.txt henüz oluşturulmadı"); }
        const content = fs.readFileSync("seed.txt", "utf8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "attachment; filename=seed.txt" });
        return res.end(content);
      }

      if (action === "personality") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(serverPersonality || "(henüz analiz yapılmadı)");
      }

      res.writeHead(400); return res.end("unknown action");
    }

    res.writeHead(404); res.end("not found");
  } catch (e) {
    res.writeHead(500); res.end("error");
  }
}).listen(PORT, () => console.log(`HTTP server on ${PORT}`));

/* ── CEVAP GÖNDERİCİ (yazıyor efekti) ────────────── */
async function sendReply(target, text, channel = null) {
  // Kısa bir "yazıyor..." gecikmesi — daha insancıl hissettiriyor
  const typingDelay = Math.min(text.length * 40 + randInt(300, 800), 3000);
  if (channel) channel.sendTyping().catch(() => {});
  else if (target.channel) target.channel.sendTyping().catch(() => {});
  await sleep(typingDelay);

  if (channel) return channel.send(text);
  return target.reply(text);
}

/* ── MESSAGE HANDLER ──────────────────────────────── */
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const content = (message.content || "").trim();
    const lower   = content.toLowerCase();
    const isDM    = message.guild === null;
    const isAdmin = message.author.id === ADMIN_USER_ID;

    /* === *gökhan (Roblox durumu) === */
    if (lower === "*gökhan" || lower === "*gokhan") {
      const status = await fetchRobloxStatus();
      if (!status) { await message.reply("roblox durumu çekemedim"); return; }

      if (status.presenceType === 0) { await message.reply("offline"); return; }
      if (status.presenceType === 3) { await message.reply("studio'da"); return; }
      if (status.presenceType === 2) {
        const gameText = status.gameName ||
          (status.placeId ? `placeId: ${status.placeId}` : null) ||
          (status.universeId ? `universeId: ${status.universeId}` : null) ||
          "oyun bilgisi yok";
        await message.reply(`robloxta\n${gameText}`);
        return;
      }
      await message.reply("online");
      return;
    }

    /* === *gökhanraw (admin debug) === */
    if ((lower === "*gökhanraw" || lower === "*gokhanraw") && isAdmin) {
      const status = await fetchRobloxStatus();
      await message.reply("```json\n" + JSON.stringify(status?.raw ?? null, null, 2).slice(0, 1800) + "\n```");
      return;
    }

    /* === ADMIN KOMUTLARI === */
    if (isAdmin) {
      if (lower === "*reaction off")    { reactionsEnabled = false; await message.reply("reaction kapalı"); return; }
      if (lower === "*reaction on")     { reactionsEnabled = true;  await message.reply("reaction açık");   return; }
      if (lower === "*reaction status") { await message.reply(reactionsEnabled ? "açık" : "kapalı"); return; }

      if (lower === "*seed status") {
        if (!seedState.startedAt) { await message.reply("seed başlamadı"); return; }
        const elapsed = Date.now() - seedState.startedAt;
        const rate    = Math.round(seedState.collected / Math.max(1, elapsed / 1000));
        const st      = seedState.running ? "çalışıyor" : seedState.done ? "tamamlandı" : seedState.error ? "hata" : "durdu";
        await message.reply([
          `seed: ${st}`,
          `kanal: #${seedState.channelName ?? "?"}`,
          `toplanan: ${seedState.collected}/${seedState.max}`,
          `fetch: ${seedState.fetchCount}`,
          `süre: ${formatDuration(elapsed)} (~${rate} msg/sn)`,
          seedState.error ? `hata: ${seedState.error}` : null,
        ].filter(Boolean).join("\n"));
        return;
      }

      if (lower === "*ai test") {
        const out = await askAI("naber", false);
        await message.reply(out ? `ok: ${out}` : "yanıt yok (key kontrol et)");
        return;
      }

      if (lower === "*yardim" || lower === "*help") {
        await message.reply([
          "**komutlar:**",
          "`*reaction on/off/status`",
          "`*seed status`",
          "`*ai test`",
          "`*gökhan`",
          "`*gökhanraw`",
          "`*yardim`",
        ].join("\n"));
        return;
      }

      if (isDM && !lower.startsWith("*")) {
        const targetChannel = await client.channels.fetch(SEED_CHANNEL_ID);
        if (targetChannel?.isTextBased()) await targetChannel.send(content);
        return;
      }
    }

    if (isDM) return;

    /* === HAFIZA GÜNCELLEME === */
    if (message.channel.id === SEED_CHANNEL_ID && content.length > 0 && !containsReligiousAbuse(content)) {
      const username = message.author.username || "biri";
      const entry    = `${username}: ${content}`;
      const last     = memory[memory.length - 1];

      if (last && last.startsWith(username + ": ")) {
        memory[memory.length - 1] = last + " " + content;
        memorySet.add(normalizeText(memory[memory.length - 1]));
      } else {
        addToMemory(entry);
      }
    }

    /* === @MENTION === */
    if (message.mentions.has(client.user) && Math.random() < MENTION_CHANCE) {
      const cleanContent  = content.replace(/<@!?\d+>/g, "").trim();
      const recentHistory = await fetchRecentHistory(message.channel, 10);
      const out = await askAI(cleanContent || "ne düşünüyorsun", false, recentHistory) || randomSentence();
      rememberBotOutput(out);
      await sendReply(message, out, message.channel);
      return;
    }

    /* === BOT MESAJINA REPLY === */
    if (
      message.reference &&
      message.mentions.repliedUser?.id === client.user.id &&
      Math.random() < REPLY_CHANCE
    ) {
      const recentHistory = await fetchRecentHistory(message.channel, 10);
      const out = await askAI(content, false, recentHistory) || randomSentence();
      rememberBotOutput(out);
      await sendReply(message, out, message.channel);
      return;
    }

    /* === RASTGELE MESAJ === */
    messageCounter++;
    if (messageCounter >= nextMessageTarget) {
      messageCounter    = 0;
      nextMessageTarget = randInt(20, 51);

      const recentHistory = await fetchRecentHistory(message.channel, 10);
      const out = await askAI(content || null, true, recentHistory) || randomSentence();
      rememberBotOutput(out);
      await sendReply(null, out, message.channel);
    }

    /* === REACTION === */
    if (!reactionsEnabled || message.author.id !== TARGET_USER_ID) return;
    if (!message.reactions.cache.some(r => r.emoji.name === EMOJI_1)) await message.react(EMOJI_1);
    if (!message.reactions.cache.some(r => r.emoji.name === EMOJI_2)) await message.react(EMOJI_2);

  } catch (e) {
    console.error(e);
  }
});

/* ── LOGIN ────────────────────────────────────────── */
console.log("Discord login başlıyor... token:", Boolean(process.env.DISCORD_TOKEN));

client.on("error",      e => console.error("Discord error:",  e));
client.on("shardError", e => console.error("Shard error:",    e));
process.on("unhandledRejection", e => console.error("UnhandledRejection:", e));
process.on("uncaughtException",  e => console.error("UncaughtException:",  e));

client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log("Discord login OK"))
  .catch(e  => console.error("Discord login FAIL:", e));
