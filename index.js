require("dotenv").config();

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const http = require("http");
const { URL } = require("url");
const { Client, GatewayIntentBits, Partials, ApplicationCommandOptionType, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType, AttachmentBuilder } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const playdl = require("play-dl");
const { createCanvas, registerFont } = require('canvas');
registerFont('/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', { family: 'NotoEmoji' });
const GIFEncoder = require('gif-encoder-2');
const ffmpegStatic = require('ffmpeg-static');
const os = require('os');
const { spawn } = require("child_process");
const fs = require("fs");

/* =========================
   AYARLAR
========================= */
const SEED_CHANNEL_ID = "705537838770421761";

const SEED_DAYS = 1500;
const SEED_MAX = 150000;

const MAX_MEMORY_MESSAGES = 40000;

// Seed'i Redis'e kaydetme limiti (Upstash free request limiti ~1MB)
const SEED_REDIS_LIMIT_BYTES = 900 * 1024;

let messageCounter = 0;
let nextMessageTarget = Math.floor(Math.random() * 31) + 20;
const guildCounters = new Map(); // sunucu başına counter

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

// Kick
const KICK_CHANNEL_SLUG = "zeitnot";
const KICK_NOTIFY_CHANNEL_ID = "705537838770421761";
// Kick Pusher kanal ID — kick.com/zeitnot sayfasında F12 > Network > zeitnot isteği > JSON'daki "id"
const KICK_CHANNEL_ID = process.env.KICK_CHANNEL_ID || "";

// Roblox
const ROBLOX_USER_ID = "2575829815";
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE || "";

// Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash-lite";
let geminiFileUri = null;

// Upstash Redis
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

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
const FALLBACK_WORDS = [
  "araba", "bilgisayar", "oyun", "masa", "kalem", "defter", "telefon",
  "futbol", "deniz", "orman", "aslan", "kapı", "yıldız", "nehir", "bahçe",
];

/* =========================
   KÜFÜR FİLTRE
========================= */
const SWEAR_TERMS = [
  "allahsız", "dinsiz", "imansız", "kafir", "kâfir",
  "allah'ın", "allahın", "peygamber",
];

function containsReligiousAbuse(text) {
  const t = normalizeText(text);
  if (!t) return false;
  const hasRel = SWEAR_TERMS.some((w) => t.includes(w));
  if (!hasRel) return false;
  return SWEAR_TERMS.some((w) => t.includes(w));
}

/* =========================
   YARDIMCI
========================= */
async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function redisGet(key) {
  if (!UPSTASH_URL) return null;
  try {
    const r = await fetchWithTimeout(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["GET", key]),
    }, 5000);
    if (!r.ok) return null;
    const data = await r.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function redisSet(key, value) {
  if (!UPSTASH_URL) return;
  try {
    await fetchWithTimeout(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", key, JSON.stringify(value)]),
    }, 5000);
  } catch {}
}

/* =========================
   SUNUCU AYARLARI (kanal config)
========================= */
// guildConfig: { guildId: { sohbetChannelId, seedChannelId } }
let guildConfig = {};
let seedChannelIds = new Set([SEED_CHANNEL_ID]);

function rebuildSeedChannelIds() {
  const s = new Set(Object.values(guildConfig).map((c) => c.seedChannelId).filter(Boolean));
  if (s.size === 0) s.add(SEED_CHANNEL_ID); // geriye dönük uyumluluk
  seedChannelIds = s;
}

let guildConfigSaveTimer = null;
function saveGuildConfig() {
  rebuildSeedChannelIds();
  if (guildConfigSaveTimer) clearTimeout(guildConfigSaveTimer);
  guildConfigSaveTimer = setTimeout(() => redisSet("guildConfig", guildConfig), 2000);
}

function getSohbetChannelId(guildId) {
  return guildConfig[guildId]?.sohbetChannelId || null;
}

/* =========================
   SEED REDIS CACHE
========================= */
let seedSaveTimer = null;
function saveSeedMemory() {
  if (!UPSTASH_URL) return;
  if (seedSaveTimer) return; // zaten planlı, ilk yazımdan 10sn sonra kaydeder
  seedSaveTimer = setTimeout(async () => {
    seedSaveTimer = null;
    try {
      let arr = memory;
      let json = JSON.stringify(arr);
      // Limiti aşarsa en eski mesajları düşürerek sığdır
      if (Buffer.byteLength(json, "utf8") > SEED_REDIS_LIMIT_BYTES) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          const slice = arr.slice(mid);
          if (Buffer.byteLength(JSON.stringify(slice), "utf8") <= SEED_REDIS_LIMIT_BYTES) hi = mid;
          else lo = mid + 1;
        }
        arr = arr.slice(lo);
        json = JSON.stringify(arr);
        if (Buffer.byteLength(json, "utf8") > SEED_REDIS_LIMIT_BYTES) {
          console.log("[SEED] Redis limiti aşıldı, kaydedilmedi");
          return;
        }
      }
      await redisSet("seedMemory", arr);
      console.log(`[SEED] Redis'e kaydedildi: ${arr.length} mesaj (${Math.round(Buffer.byteLength(json, "utf8") / 1024)}KB)`);
    } catch (e) {
      console.log("[SEED] Redis kayıt hatası:", e.message?.slice(0, 80));
    }
  }, 10000);
}

/* =========================
   METİN NORMALİZASYON
========================= */
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9ğüşıöç\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function foldTR(s) {
  return (s || "")
    .toLowerCase()
    .replace(/i̇/g, "i")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

function turkishLower(s) {
  return (s || "")
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLowerCase();
}

function isWordOnly(s) {
  return /^[a-zğüşıöç]+$/.test(s);
}

function wordLastLetter(w) {
  if (!w) return "";
  return w[w.length - 1];
}

function handleSimpleChoiceQuestion(text) {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  const hasRel = ["mı", "mi", "mu", "mü", "mısın", "misin", "musun", "müsün"].some((s) => t.includes(" " + s) || t.endsWith(" " + s));
  if (!hasRel) return false;
  return SWEAR_TERMS.some((w) => t.includes(w));
}

/* =========================
   HAFIZA FONKSİYONLARI
========================= */
async function fetchRecentHistory(channel, n = 10) {
  if (memory.length === 0) return "";
  const usable = memory.filter((m) => m.length < 200);
  if (usable.length === 0) return "";
  return usable.slice(-n).join("\n");
}

async function fetchRecentMessages(channel, limit = 20) {
  try {
    const msgs = await channel.messages.fetch({ limit });
    return Array.from(msgs.values())
      .reverse()
      .map((m) => `${m.author.username}: ${m.content}`)
      .filter((s) => s.length < 300);
  } catch {
    return [];
  }
}

function getRandomMemory(n = 5) {
  const usable = memory.filter((m) => m.length < 200);
  if (usable.length === 0) return "";
  const shuffled = [...usable].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n).join("\n");
}

/* =========================
   GEMİNİ SİSTEM PROMPTU
========================= */
const SYSTEM_PROMPT = `Sen bir Türk Discord sunucusunda yaşayan bir botsun. Kısa, samimi, bazen argo konuşuyorsun.
- Cevaplar genelde 1-5 kelime. Çoğu zaman tek kelime yeterli: "he", "yok", "ya", "amk", "neyse"
- Yazım kurallarına uymak zorunda değilsin, küçük harf kullan
- Noktalama işareti kullanma
- Dini hakaretlerden kaçın
- Konuşmayı devam ettir, soru sormak zorunda değilsin`;

/* =========================
   MARKOV ZİNCİRİ
========================= */
// trigram: key = "word1 word2", value = [word3, ...]
const markovChain = new Map();
const markovStarts = []; // ["word1 word2", ...]
let wordPool = [];

function buildMarkov(messages) {
  markovChain.clear();
  markovStarts.length = 0;
  wordPool = [];

  const allWords = new Set();

  for (const msg of messages) {
    const words = msg
      .toLowerCase()
      .replace(/[^a-z0-9ğüşıöç\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (words.length < 3) continue;

    words.forEach((w) => {
      if (w.length >= 3 && /^[a-zğüşıöç]+$/.test(w)) allWords.add(w);
    });

    markovStarts.push(`${words[0]} ${words[1]}`);

    for (let i = 0; i < words.length - 2; i++) {
      const key = `${words[i]} ${words[i + 1]}`;
      if (!markovChain.has(key)) markovChain.set(key, []);
      markovChain.get(key).push(words[i + 2]);
    }
  }

  wordPool = Array.from(allWords);
  console.log(`[MARKOV] Model hazır: ${markovChain.size} trigram, ${markovStarts.length} başlangıç, ${wordPool.length} kelime`);
}

function randomWord() {
  return wordPool[Math.floor(Math.random() * wordPool.length)];
}

function generateMarkov(startPair = null) {
  if (markovStarts.length === 0) return null;

  const start = startPair || markovStarts[Math.floor(Math.random() * markovStarts.length)];
  const [w1, w2] = start.split(" ");

  const targetLen = Math.random() < 0.4
    ? Math.floor(Math.random() * 3) + 4
    : Math.floor(Math.random() * 7) + 5;

  const result = [w1, w2];
  let prev = w1, cur = w2;

  for (let i = 2; i < targetLen; i++) {
    const key = `${prev} ${cur}`;
    if (!markovChain.has(key) || Math.random() < 0.15) {
      const rnd = randomWord();
      if (rnd) {
        result.push(rnd);
        prev = cur;
        cur = rnd;
      } else break;
    } else {
      const nexts = markovChain.get(key);
      const next = nexts[Math.floor(Math.random() * nexts.length)];
      result.push(next);
      prev = cur;
      cur = next;
    }
  }

  const text = result.join(" ");
  if (!containsReligiousAbuse(text)) return text;
  return null;
}

function randomSentence() {
  const base = generateMarkov();
  if (base && !containsReligiousAbuse(base)) return base;
  return null;
}

/* =========================
   EKONOMİ
========================= */
const DEFAULT_BALANCE = 1000;
const BONUS_AMOUNT = 500;
const BONUS_COOLDOWN = 24 * 60 * 60 * 1000;

const balances = new Map();
const lastBonus = new Map();

let economySaveTimer = null;
function saveEconomy() {
  if (economySaveTimer) clearTimeout(economySaveTimer);
  economySaveTimer = setTimeout(() => {
    redisSet("economy", Object.fromEntries(balances));
    economySaveTimer = null;
  }, 3000);
}

function getBalance(userId) {
  if (!balances.has(userId)) balances.set(userId, DEFAULT_BALANCE);
  return balances.get(userId);
}

function setBalance(userId, amount) {
  balances.set(userId, Math.max(0, Math.floor(amount)));
  saveEconomy();
}

function parseBet(str, userId) {
  const bal = getBalance(userId);
  if (!str || str === "hepsi" || str === "all") return bal > 0 ? bal : null;
  const n = parseInt(str);
  if (isNaN(n) || n <= 0) return null;
  if (n > bal) return null;
  return n;
}

/* =========================
   ÇARK ÇEVİRİCİ
========================= */
const WHEEL_COLORS = [
  '#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#FF6BBF',
  '#FF9F43','#54A0FF','#A29BFE','#00D2D3','#FD79A8',
  '#55EFC4','#FDCB6E','#74B9FF','#E17055','#81ECEC',
  '#FAB1A0','#B2BEC3','#00B894','#E84393','#6C5CE7',
];

function drawWheelFrame(ctx, options, rotation, size) {
  const n = options.length;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 20;

  ctx.fillStyle = '#23272A';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < n; i++) {
    const startAngle = rotation + (i / n) * Math.PI * 2 - Math.PI / 2;
    const endAngle   = rotation + ((i + 1) / n) * Math.PI * 2 - Math.PI / 2;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length];
    ctx.fill();
    ctx.strokeStyle = '#23272A';
    ctx.lineWidth = 2;
    ctx.stroke();

    const midAngle = (startAngle + endAngle) / 2;
    const textR = r * 0.68;
    const tx = cx + Math.cos(midAngle) * textR;
    const ty = cy + Math.sin(midAngle) * textR;
    const fontSize = Math.max(9, Math.min(15, Math.floor(600 / n / options[i].length * 2.5)));

    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(midAngle + Math.PI / 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 3;
    const maxLen = Math.max(6, Math.floor(r * Math.PI / n / fontSize * 1.6));
    const label = options[i].length > maxLen ? options[i].slice(0, maxLen - 1) + '…' : options[i];
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  // Dış çember
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#99AAB5';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Merkez
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = '#23272A';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Ok (üstte, aşağı bakıyor — çarka doğru)
  ctx.beginPath();
  ctx.moveTo(cx, 28);      // ok ucu aşağıda
  ctx.lineTo(cx - 13, 4);  // sol üst
  ctx.lineTo(cx + 13, 4);  // sağ üst
  ctx.closePath();
  ctx.fillStyle = '#FFFFFF';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 4;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#23272A';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

async function generateWheelGif(options, winnerIdx) {
  const size = 600;
  const n = options.length;
  const FRAMES = 50;

  const totalRotation = (9 - (winnerIdx + 0.5) / n) * Math.PI * 2;

  const encoder = new GIFEncoder(size, size, 'neuquant', false);
  encoder.setRepeat(-1);
  encoder.setQuality(5);
  encoder.start();

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  for (let f = 0; f <= FRAMES; f++) {
    const t = f / FRAMES;
    const eased = 1 - Math.pow(1 - t, 3);
    const rotation = totalRotation * eased;

    let delay;
    if (t < 0.5)       delay = 30;
    else if (t < 0.75) delay = 30 + Math.round(150 * ((t - 0.5) / 0.25));
    else               delay = 180 + Math.round(170 * ((t - 0.75) / 0.25));
    if (f === FRAMES)  delay = 2500;

    encoder.setDelay(delay);
    drawWheelFrame(ctx, options, rotation, size);
    encoder.addFrame(ctx);
  }

  encoder.finish();
  return Buffer.from(encoder.out.getData());
}

async function generateSlotGif(finalReels, resultType, delta, newBalance) {
  const W = 440, H = 210;
  const encoder = new GIFEncoder(W, H, 'neuquant', false);
  encoder.setQuality(6);
  encoder.setRepeat(-1);
  encoder.start();

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const ALL_SYMS = ['🍒','🍋','🍊','🍇','🔔','⭐','💎','7️⃣'];
  const CELL = 108;
  const GAP = 12;
  const startX = Math.floor((W - 3 * CELL - 2 * GAP) / 2);
  const cellY = 58;

  // Frame at which each reel stops (0-indexed)
  const STOP = [26, 36, 46];
  const TOTAL = 60;

  // Spin offsets staggered for variety
  const spinIdx = [0, 3, 5];

  function drawFrame(f) {
    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1a0a2e');
    grad.addColorStop(1, '#0d0520');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Decorative top stripe
    ctx.fillStyle = '#ffd700';
    ctx.fillRect(0, 0, W, 4);
    ctx.fillRect(0, H - 4, W, 4);

    // Header
    ctx.font = 'bold 24px "NotoEmoji", sans-serif';
    ctx.fillStyle = '#ffd700';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#ff8800';
    ctx.shadowBlur = 10;
    ctx.fillText('🎰  SLOT MAKİNESİ', W / 2, 28);
    ctx.shadowBlur = 0;

    for (let r = 0; r < 3; r++) {
      const x = startX + r * (CELL + GAP);
      const stopped = f >= STOP[r];

      if (!stopped && f % 2 === 0) {
        spinIdx[r] = (spinIdx[r] + 1) % ALL_SYMS.length;
      }

      const sym = stopped ? finalReels[r] : ALL_SYMS[spinIdx[r]];

      // Cell shadow
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(x + 4, cellY + 4, CELL, CELL);

      // Cell background
      if (stopped) {
        const cellGrad = ctx.createLinearGradient(x, cellY, x, cellY + CELL);
        cellGrad.addColorStop(0, '#0a3060');
        cellGrad.addColorStop(1, '#051a3a');
        ctx.fillStyle = cellGrad;
      } else {
        ctx.fillStyle = '#1a1040';
      }
      ctx.fillRect(x, cellY, CELL, CELL);

      // Border
      ctx.strokeStyle = stopped ? '#ffd700' : '#553388';
      ctx.lineWidth = stopped ? 3 : 1.5;
      ctx.strokeRect(x, cellY, CELL, CELL);

      // Inner highlight line (top) for stopped reels
      if (stopped) {
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 4, cellY + 4);
        ctx.lineTo(x + CELL - 4, cellY + 4);
        ctx.stroke();
      }

      // Symbol
      ctx.font = '62px "NotoEmoji", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = stopped ? 'rgba(255,215,0,0.5)' : 'transparent';
      ctx.shadowBlur = stopped ? 8 : 0;
      ctx.fillText(sym, x + CELL / 2, cellY + CELL / 2 + 2);
      ctx.shadowBlur = 0;
    }

    // Win overlay flash (blink on triple win)
    if (resultType === 'triple' && f >= STOP[2] && f % 6 < 3) {
      ctx.fillStyle = 'rgba(255, 215, 0, 0.07)';
      ctx.fillRect(0, 0, W, H);
    }

    // Result text (after all reels stopped)
    if (f >= STOP[2]) {
      let resultText, resultColor;
      if (resultType === 'triple') {
        resultText = `🎉  +${delta} 🪙  ›  Bakiye: ${newBalance} 🪙`;
        resultColor = '#00ee88';
      } else if (resultType === 'pair') {
        resultText = `🤝  Para iade  ›  Bakiye: ${newBalance} 🪙`;
        resultColor = '#ffdd44';
      } else {
        resultText = `💸  -${Math.abs(delta)} 🪙  ›  Bakiye: ${newBalance} 🪙`;
        resultColor = '#ff5555';
      }
      ctx.font = 'bold 19px "NotoEmoji", sans-serif';
      ctx.fillStyle = resultColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = resultColor;
      ctx.shadowBlur = 6;
      ctx.fillText(resultText, W / 2, cellY + CELL + 26);
      ctx.shadowBlur = 0;
    }
  }

  for (let f = 0; f < TOTAL; f++) {
    let delay;
    if (f < STOP[0])        delay = 55;
    else if (f < STOP[1])   delay = 60;
    else if (f < STOP[2])   delay = 65;
    else if (f === TOTAL - 1) delay = 2500;
    else                    delay = 80;

    encoder.setDelay(delay);
    drawFrame(f);
    encoder.addFrame(ctx);
  }

  encoder.finish();
  return Buffer.from(encoder.out.getData());
}

/* =========================
   CS2 CASE SYSTEM
========================= */
let inventory = {};
let inventorySaveTimer = null;
function saveInventory() {
  if (inventorySaveTimer) clearTimeout(inventorySaveTimer);
  inventorySaveTimer = setTimeout(() => {
    redisSet("inventory", inventory);
    inventorySaveTimer = null;
  }, 3000);
}

const RARITY_INFO = {
  consumer:   { label: "Consumer Grade",   color: "⬜", coinMin: 3,     coinMax: 8      },
  industrial: { label: "Industrial Grade", color: "🟦", coinMin: 10,    coinMax: 30     },
  milspec:    { label: "Mil-Spec",          color: "🟪", coinMin: 40,    coinMax: 120    },
  restricted: { label: "Restricted",        color: "🔵", coinMin: 200,   coinMax: 600    },
  classified: { label: "Classified",        color: "🩷", coinMin: 1000,  coinMax: 3000   },
  covert:     { label: "Covert",            color: "🔴", coinMin: 4000,  coinMax: 12000  },
  knife:      { label: "★ Contraband",      color: "🟡", coinMin: 15000, coinMax: 50000  },
};

const RARITY_WEIGHTS = [
  { rarity: "consumer",   w: 7992 },
  { rarity: "industrial", w: 1598 },
  { rarity: "milspec",    w: 320  },
  { rarity: "restricted", w: 64   },
  { rarity: "classified", w: 26   },
  { rarity: "covert",     w: 6    },
  { rarity: "knife",      w: 2    },
];

const COIN_RATE = 100;

const CONDITION_COIN_MULT = { FN: 1.00, MW: 0.55, FT: 0.28, WW: 0.18, BS: 0.12 };

const SKIN_PRICES = {
  // Recoil Case
  "MP9 | Rose Iron": 0.05, "MAC-10 | Allure": 0.06, "P250 | Vino Primo": 0.04,
  "Nova | Toy Soldier": 0.05, "Sawed-Off | Amber Fade": 0.05,
  "CZ75-Auto | Distressed": 0.08, "UMP-45 | Roadblock": 0.09,
  "Tec-9 | Decimator": 0.07, "FAMAS | Meow 36": 0.07, "MP5-SD | Desert Storm": 0.08,
  "SSG 08 | Parallax": 0.50, "Glock-18 | Winterized": 0.30,
  "Desert Eagle | Trigger Discipline": 1.50, "AK-47 | Ice Coaled": 0.60,
  "M4A4 | 龍王 (Dragon King)": 3.00, "Five-SeveN | Scrawl": 0.25, "M4A1-S | Restless": 0.40,
  "Galil AR | Connexion": 1.00, "AWP | Chromatic Aberration": 3.00,
  "MP9 | Starlight Protector": 2.00, "FAMAS | Meltdown": 1.00, "USP-S | Ticket to Hell": 8.00,
  "AK-47 | Head Shot": 45.00, "M4A1-S | Emphorosaur-S": 55.00,
  "Desert Eagle | Blue Ply": 15.00, "M4A4 | Poly Mag": 12.00,
  "AK-47 | Baroque Purple": 120.00, "M4A4 | Recoil": 90.00,

  // Revolution Case
  "MAC-10 | Whitefish": 0.04, "UMP-45 | Wild Child": 0.05, "P250 | Vanguard": 0.04,
  "Sawed-Off | Spirit Board": 0.05, "P90 | Maze Solver": 0.06,
  "MP9 | Featherweight": 0.08, "Nova | Windblown": 0.06, "Tec-9 | Rebel": 0.07,
  "XM1014 | Iridescent": 0.06, "MP5-SD | Liquidation": 0.07,
  "Five-SeveN | Hybrid": 0.40, "M249 | Downtown": 0.20, "AUG | Momentum": 0.35,
  "MP7 | Abyssal Apparition": 0.30, "MAC-10 | Light Box": 0.25,
  "P90 | Neoqueen": 1.50, "SSG 08 | Skull Cracker": 0.35,
  "Glock-18 | Umbral Rabbit": 3.00, "FAMAS | Eye of Athena": 1.50,
  "M4A4 | Etch Lord": 8.00, "AK-47 | Inheritance": 5.00,
  "Desert Eagle | Printstream": 25.00,
  "M4A1-S | Blackwater": 25.00, "MP9 | Hydra": 6.00,
  "M4A4 | Temukau": 70.00,

  // Kilowatt Case
  "CZ75-Auto | Capacitor": 0.05, "P2000 | Elevate": 0.04, "MP9 | Bioleak": 0.05,
  "Sawed-Off | Devourer": 0.05, "MAC-10 | Graven": 0.05,
  "Tec-9 | Slag": 0.07, "XM1014 | Zombie Offensive": 0.06, "Nova | Dark Sigil": 0.07,
  "UMP-45 | Primal Saber": 0.08, "P90 | Vent Rush": 0.07,
  "Glock-18 | Block-18": 0.50, "AUG | Flux": 0.30, "MP5-SD | Condition Zero": 0.35,
  "M249 | Warbird": 0.25, "FAMAS | Rapid Eye Movement": 0.40, "SSG 08 | Dezastre": 0.40,
  "AWP | Chrome Cannon": 4.00, "MP7 | Guerrilla": 1.50,
  "M4A1-S | Jawbreaker": 5.00, "AK-47 | Leet Museo": 6.00, "USP-S | Stainless": 3.00,
  "M4A1-S | Mecha Industries": 30.00, "AK-47 | Violet Murano": 20.00,
  "M4A1-S | Stratocat": 90.00,

  // Gamma 2 Case
  "PP-Bizon | Jungle Slipstream": 0.04, "Dual Berettas | Cyanospatter": 0.05,
  "MP9 | Avalanche": 0.05, "Nova | Predator": 0.05, "P250 | Wingshot": 0.04,
  "FAMAS | Djinn": 0.08, "XM1014 | Entombed": 0.06,
  "Tec-9 | Re-Entry": 0.07, "MAC-10 | Heat": 0.07,
  "M4A4 | Buzz Kill": 0.80, "USP-S | Para Green": 0.50, "SSG 08 | Ghost Crusader": 0.40,
  "Glock-18 | Wasteland Rebel": 1.00, "AK-47 | Neon Revolution": 1.50,
  "M4A1-S | Flashback": 0.60, "FAMAS | Valence": 0.35,
  "Desert Eagle | Oxide Blaze": 2.00, "M4A4 | The Coalition": 2.50,
  "AK-47 | Frontside Misty": 3.00, "Galil AR | Stone Cold": 1.50,
  "AWP | Phobos": 3.50, "CZ75-Auto | Chalice": 40.00,
  "AK-47 | Wasteland Rebel": 10.00, "M4A1-S | Hyper Beast": 25.00,
  "Dual Berettas | Retribution": 5.00,
  "AK-47 | Neon Rider": 55.00, "M4A4 | Neo-Noir": 45.00,

  // Dreams & Nightmares Case
  "Dual Berettas | Melondrama": 0.05, "MP5-SD | Necro Jr.": 0.05,
  "UMP-45 | Oscillator": 0.05, "MAC-10 | Ensnared": 0.05, "Nova | Bloomstick": 0.04,
  "P250 | Visions": 0.07, "CZ75-Auto | Emerald Quartz": 0.08,
  "Glock-18 | Night": 0.07, "FAMAS | Doomkitty": 0.07, "Tec-9 | Bamboozle": 0.07,
  "MP7 | Neon Ply": 0.35, "M4A4 | Tooth Fairy": 0.80, "USP-S | Monster Mashup": 0.50,
  "AK-47 | Phantom Disruptor": 0.60, "M4A1-S | Night Terror": 0.80, "Galil AR | Akoben": 0.30,
  "AWP | No Pray No Spray": 3.00, "M4A1-S | Darkness Falls": 4.00,
  "AK-47 | Legion of Anubis": 5.00,
  "AK-47 | Nightwish": 8.00, "M4A4 | Spider Lily": 18.00,
  "AK-47 | X-Ray": 150.00,

  // Chroma 2 Case
  "Five-SeveN | Violent Daimyo": 0.05, "MP7 | Gunsmoke": 0.06,
  "P2000 | Panther": 0.05, "P250 | See Ya Later": 0.05, "Sawed-Off | Snake Camo": 0.04,
  "AUG | Aristocrat": 0.08, "MAC-10 | Neon Rider": 0.09, "Nova | Antique": 0.07,
  "Tec-9 | Titanium Bit": 0.07, "XM1014 | Red Python": 0.08,
  "M4A4 | Radiation Hazard": 0.50, "P90 | Shallow Grave": 0.35,
  "AK-47 | Carbone Fiber": 0.40, "Desert Eagle | Bronze Deco": 0.60,
  "USP-S | Torque": 0.50, "Galil AR | Eco": 0.30, "CZ75-Auto | Imprint": 0.35,
  "AK-47 | Elite Build": 2.50, "M4A1-S | Icarus Fell": 3.00, "SG 553 | Cyrex": 2.50,
  "Glock-18 | Catacombs": 1.50, "AWP | Pit Viper": 4.00,
  "M4A1-S | Bright Water": 10.00, "Galil AR | Crimson Tsunami": 8.00,
  "AK-47 | Hydroponic": 45.00, "M4A4 | Desolate Space": 40.00,

  // Cobblestone Souvenir Package
  "PP-Bizon | Sand Dashed": 0.04, "P250 | Valence": 0.05,
  "Desert Eagle | Cobalt Disruption": 0.10, "CZ75-Auto | Army Mesh": 0.05,
  "XM1014 | Grassland": 0.07, "MP7 | Armor Core": 0.08, "Galil AR | Shattered": 0.07,
  "M249 | System Lock": 0.08, "SG 553 | Pulse": 0.07,
  "P2000 | Pathfinder": 0.40, "FAMAS | Spitfire": 0.35,
  "Glock-18 | Bunsen Burner": 0.40, "P90 | Trigon": 0.50,
  "M4A4 | Faded Zebra": 2.00, "AK-47 | Safari Mesh": 1.00,
  "MP7 | Forest DDPAT": 0.80, "USP-S | Forest Leaves": 1.50, "SSG 08 | Abyss": 1.50,
  "M4A1-S | Master Piece": 250.00, "P90 | Death by Kitty": 10.00,
  "M4A4 | Howl": 2000.00,

  // Knives
  "★ Bayonet": 130, "★ Flip Knife": 130, "★ Gut Knife": 90,
  "★ Karambit": 400, "★ M9 Bayonet": 200, "★ Huntsman Knife": 120,
  "★ Falchion Knife": 100, "★ Shadow Daggers": 80, "★ Bowie Knife": 100,
  "★ Butterfly Knife": 350, "★ Talon Knife": 180, "★ Navaja Knife": 80,
  "★ Stiletto Knife": 100, "★ Ursus Knife": 110, "★ Classic Knife": 110,
  "★ Paracord Knife": 90, "★ Survival Knife": 90, "★ Nomad Knife": 100,
  "★ Skeleton Knife": 150, "★ Kukri Knife": 120,
  "★ AWP | Dragon Lore": 1500,
};

function rollRarity() {
  const total = RARITY_WEIGHTS.reduce((s, x) => s + x.w, 0);
  let r = Math.floor(Math.random() * total);
  for (const { rarity, w } of RARITY_WEIGHTS) {
    if (r < w) return rarity;
    r -= w;
  }
  return "consumer";
}

const CONDITIONS = [
  { label: "Factory New",    short: "FN", w: 3  },
  { label: "Minimal Wear",   short: "MW", w: 24 },
  { label: "Field-Tested",   short: "FT", w: 33 },
  { label: "Well-Worn",      short: "WW", w: 24 },
  { label: "Battle-Scarred", short: "BS", w: 16 },
];

function rollCondition() {
  const total = CONDITIONS.reduce((s, x) => s + x.w, 0);
  let r = Math.floor(Math.random() * total);
  for (const c of CONDITIONS) {
    if (r < c.w) return c;
    r -= c.w;
  }
  return CONDITIONS[2];
}

const CASES = {
  "recoil": {
    name: "Recoil Case",
    cost: 280,
    skins: {
      consumer:   ["MP9 | Rose Iron", "MAC-10 | Allure", "P250 | Vino Primo", "Nova | Toy Soldier", "Sawed-Off | Amber Fade"],
      industrial: ["CZ75-Auto | Distressed", "UMP-45 | Roadblock", "Tec-9 | Decimator", "FAMAS | Meow 36", "MP5-SD | Desert Storm"],
      milspec:    ["SSG 08 | Parallax", "Glock-18 | Winterized", "Desert Eagle | Trigger Discipline", "AK-47 | Ice Coaled", "M4A4 | 龍王 (Dragon King)", "Five-SeveN | Scrawl", "M4A1-S | Restless"],
      restricted: ["Galil AR | Connexion", "AWP | Chromatic Aberration", "MP9 | Starlight Protector", "FAMAS | Meltdown", "USP-S | Ticket to Hell"],
      classified: ["AK-47 | Head Shot", "M4A1-S | Emphorosaur-S", "Desert Eagle | Blue Ply", "M4A4 | Poly Mag"],
      covert:     ["AK-47 | Baroque Purple", "M4A4 | Recoil"],
      knife:      ["★ Bayonet", "★ Flip Knife", "★ Gut Knife", "★ Karambit", "★ M9 Bayonet", "★ Huntsman Knife", "★ Falchion Knife", "★ Shadow Daggers", "★ Bowie Knife", "★ Butterfly Knife", "★ Talon Knife", "★ Navaja Knife", "★ Stiletto Knife", "★ Ursus Knife", "★ Classic Knife", "★ Paracord Knife", "★ Survival Knife", "★ Nomad Knife", "★ Skeleton Knife"],
    },
  },
  "revolution": {
    name: "Revolution Case",
    cost: 275,
    skins: {
      consumer:   ["MAC-10 | Whitefish", "UMP-45 | Wild Child", "P250 | Vanguard", "Sawed-Off | Spirit Board", "P90 | Maze Solver"],
      industrial: ["MP9 | Featherweight", "Nova | Windblown", "Tec-9 | Rebel", "XM1014 | Iridescent", "MP5-SD | Liquidation"],
      milspec:    ["Five-SeveN | Hybrid", "M249 | Downtown", "AUG | Momentum", "MP7 | Abyssal Apparition", "MAC-10 | Light Box", "P90 | Neoqueen", "SSG 08 | Skull Cracker"],
      restricted: ["Glock-18 | Umbral Rabbit", "FAMAS | Eye of Athena", "M4A4 | Etch Lord", "AK-47 | Inheritance", "Desert Eagle | Printstream"],
      classified: ["M4A1-S | Blackwater", "MP9 | Hydra"],
      covert:     ["AK-47 | Head Shot", "M4A4 | Temukau"],
      knife:      ["★ Bayonet", "★ Flip Knife", "★ Gut Knife", "★ Karambit", "★ M9 Bayonet", "★ Huntsman Knife", "★ Falchion Knife", "★ Shadow Daggers", "★ Bowie Knife", "★ Butterfly Knife", "★ Talon Knife", "★ Navaja Knife", "★ Stiletto Knife", "★ Ursus Knife", "★ Classic Knife", "★ Paracord Knife", "★ Survival Knife", "★ Nomad Knife", "★ Skeleton Knife"],
    },
  },
  "kilowatt": {
    name: "Kilowatt Case",
    cost: 400,
    skins: {
      consumer:   ["CZ75-Auto | Capacitor", "P2000 | Elevate", "MP9 | Bioleak", "Sawed-Off | Devourer", "MAC-10 | Graven"],
      industrial: ["Tec-9 | Slag", "XM1014 | Zombie Offensive", "Nova | Dark Sigil", "UMP-45 | Primal Saber", "P90 | Vent Rush"],
      milspec:    ["Glock-18 | Block-18", "AUG | Flux", "MP5-SD | Condition Zero", "M249 | Warbird", "FAMAS | Rapid Eye Movement", "Desert Eagle | Trigger Discipline", "SSG 08 | Dezastre"],
      restricted: ["AWP | Chrome Cannon", "MP7 | Guerrilla", "M4A1-S | Jawbreaker", "AK-47 | Leet Museo", "USP-S | Stainless"],
      classified: ["M4A1-S | Mecha Industries", "AK-47 | Violet Murano"],
      covert:     ["M4A4 | Etch Lord", "M4A1-S | Stratocat"],
      knife:      ["★ Kukri Knife", "★ Bayonet", "★ Flip Knife", "★ Gut Knife", "★ Karambit", "★ M9 Bayonet", "★ Huntsman Knife", "★ Falchion Knife", "★ Shadow Daggers", "★ Bowie Knife", "★ Butterfly Knife", "★ Talon Knife", "★ Navaja Knife", "★ Stiletto Knife", "★ Ursus Knife", "★ Classic Knife", "★ Paracord Knife", "★ Survival Knife", "★ Nomad Knife", "★ Skeleton Knife"],
    },
  },
  "gamma2": {
    name: "Gamma 2 Case",
    cost: 300,
    skins: {
      consumer:   ["PP-Bizon | Jungle Slipstream", "Dual Berettas | Cyanospatter", "MP9 | Avalanche", "Nova | Predator", "P250 | Wingshot"],
      industrial: ["FAMAS | Djinn", "XM1014 | Entombed", "Tec-9 | Re-Entry", "MAC-10 | Heat", "MP9 | Featherweight"],
      milspec:    ["M4A4 | Buzz Kill", "USP-S | Para Green", "SSG 08 | Ghost Crusader", "Glock-18 | Wasteland Rebel", "AK-47 | Neon Revolution", "M4A1-S | Flashback", "FAMAS | Valence"],
      restricted: ["Desert Eagle | Oxide Blaze", "M4A4 | The Coalition", "AK-47 | Frontside Misty", "Galil AR | Stone Cold", "AWP | Phobos", "CZ75-Auto | Chalice"],
      classified: ["AK-47 | Wasteland Rebel", "M4A1-S | Hyper Beast", "Dual Berettas | Retribution"],
      covert:     ["AK-47 | Neon Rider", "M4A4 | Neo-Noir"],
      knife:      ["★ Bayonet", "★ Flip Knife", "★ Gut Knife", "★ Karambit", "★ M9 Bayonet", "★ Huntsman Knife", "★ Falchion Knife", "★ Shadow Daggers", "★ Bowie Knife", "★ Butterfly Knife", "★ Talon Knife", "★ Navaja Knife", "★ Stiletto Knife", "★ Ursus Knife", "★ Classic Knife", "★ Paracord Knife", "★ Survival Knife", "★ Nomad Knife", "★ Skeleton Knife"],
    },
  },
  "dreams": {
    name: "Dreams & Nightmares Case",
    cost: 300,
    skins: {
      consumer:   ["Dual Berettas | Melondrama", "MP5-SD | Necro Jr.", "UMP-45 | Oscillator", "MAC-10 | Ensnared", "Nova | Bloomstick"],
      industrial: ["P250 | Visions", "CZ75-Auto | Emerald Quartz", "Glock-18 | Night", "FAMAS | Doomkitty", "Tec-9 | Bamboozle"],
      milspec:    ["XM1014 | Zombie Offensive", "MP7 | Neon Ply", "M4A4 | Tooth Fairy", "USP-S | Monster Mashup", "AK-47 | Phantom Disruptor", "M4A1-S | Night Terror", "Galil AR | Akoben"],
      restricted: ["AWP | No Pray No Spray", "M4A1-S | Darkness Falls", "AK-47 | Legion of Anubis", "MP9 | Starlight Protector", "P90 | Neoqueen"],
      classified: ["AK-47 | Nightwish", "M4A4 | Spider Lily"],
      covert:     ["AK-47 | X-Ray", "M4A4 | Temukau"],
      knife:      ["★ Bayonet", "★ Flip Knife", "★ Gut Knife", "★ Karambit", "★ M9 Bayonet", "★ Huntsman Knife", "★ Falchion Knife", "★ Shadow Daggers", "★ Bowie Knife", "★ Butterfly Knife", "★ Talon Knife", "★ Navaja Knife", "★ Stiletto Knife", "★ Ursus Knife", "★ Classic Knife", "★ Paracord Knife", "★ Survival Knife", "★ Nomad Knife", "★ Skeleton Knife"],
    },
  },
  "chroma": {
    name: "Chroma 2 Case",
    cost: 285,
    skins: {
      consumer:   ["Five-SeveN | Violent Daimyo", "MP7 | Gunsmoke", "P2000 | Panther", "P250 | See Ya Later", "Sawed-Off | Snake Camo"],
      industrial: ["AUG | Aristocrat", "MAC-10 | Neon Rider", "Nova | Antique", "Tec-9 | Titanium Bit", "XM1014 | Red Python"],
      milspec:    ["M4A4 | Radiation Hazard", "P90 | Shallow Grave", "AK-47 | Carbone Fiber", "Desert Eagle | Bronze Deco", "USP-S | Torque", "Galil AR | Eco", "CZ75-Auto | Imprint"],
      restricted: ["AK-47 | Elite Build", "M4A1-S | Icarus Fell", "SG 553 | Cyrex", "Glock-18 | Catacombs", "AWP | Pit Viper"],
      classified: ["M4A1-S | Bright Water", "Galil AR | Crimson Tsunami"],
      covert:     ["AK-47 | Hydroponic", "M4A4 | Desolate Space"],
      knife:      ["★ Bayonet", "★ Flip Knife", "★ Gut Knife", "★ Karambit", "★ M9 Bayonet", "★ Huntsman Knife", "★ Falchion Knife", "★ Shadow Daggers", "★ Bowie Knife", "★ Butterfly Knife", "★ Talon Knife", "★ Navaja Knife", "★ Stiletto Knife", "★ Ursus Knife", "★ Classic Knife", "★ Paracord Knife", "★ Survival Knife", "★ Nomad Knife", "★ Skeleton Knife"],
    },
  },
  "cobblestone": {
    name: "Cobblestone Souvenir Package",
    cost: 1000,
    skins: {
      consumer:   ["PP-Bizon | Sand Dashed", "P250 | Valence", "Five-SeveN | Violent Daimyo", "Desert Eagle | Cobalt Disruption", "CZ75-Auto | Army Mesh"],
      industrial: ["XM1014 | Grassland", "MP7 | Armor Core", "Galil AR | Shattered", "M249 | System Lock", "SG 553 | Pulse"],
      milspec:    ["P2000 | Pathfinder", "FAMAS | Spitfire", "M4A1-S | Bright Water", "AK-47 | Carbone Fiber", "Glock-18 | Bunsen Burner", "Nova | Antique", "P90 | Trigon"],
      restricted: ["M4A4 | Faded Zebra", "AK-47 | Safari Mesh", "MP7 | Forest DDPAT", "USP-S | Forest Leaves", "SSG 08 | Abyss"],
      classified: ["M4A1-S | Master Piece", "P90 | Death by Kitty"],
      covert:     ["M4A4 | Howl"],
      knife:      ["★ AWP | Dragon Lore"],
    },
  },
};

function addToInventory(userId, username, item) {
  if (!inventory[userId]) inventory[userId] = { username, items: [] };
  inventory[userId].username = username;
  inventory[userId].items.push(item);
  saveInventory();
}

// item.name = "StatTrak™ AK-47 | Ice Coaled (FN)"
function calcItemPrice(item) {
  const isSt = item.name.startsWith('StatTrak™ ');
  const nameNoSt = isSt ? item.name.slice('StatTrak™ '.length) : item.name;
  const condMatch = nameNoSt.match(/\((\w+)\)$/);
  const condShort = condMatch ? condMatch[1] : 'FT';
  const skinName = nameNoSt.replace(/\s*\(\w+\)$/, '');
  const basePrice = SKIN_PRICES[skinName];
  const info = RARITY_INFO[item.rarity] || RARITY_INFO.milspec;
  let coins;
  if (basePrice !== undefined) {
    const condMult = CONDITION_COIN_MULT[condShort] ?? 0.28;
    coins = Math.max(info.coinMin, Math.round(basePrice * condMult * COIN_RATE));
  } else {
    coins = Math.round((info.coinMin + info.coinMax) / 2);
  }
  return isSt ? Math.floor(coins * 1.5) : coins;
}

// Bekleyen takas teklifleri: tradeId → { senderId, targetId, senderItem, targetItem, senderIdx, targetIdx, msgId, timeout }
const pendingTrades = new Map();
let tradeIdCounter = 0;

/* =========================
   BLACKJACK
========================= */
const bjGames = new Map();

function bjDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const faces = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
  const deck = [];
  for (const s of suits) for (const f of faces) deck.push(f + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function bjCardVal(card) {
  const f = card.slice(0, -1);
  if (f === "A") return 11;
  if (["J","Q","K"].includes(f)) return 10;
  return parseInt(f);
}

function bjHandVal(hand) {
  let val = hand.reduce((s, c) => s + bjCardVal(c), 0);
  let aces = hand.filter((c) => c.slice(0, -1) === "A").length;
  while (val > 21 && aces > 0) { val -= 10; aces--; }
  return val;
}

function bjShowHand(hand, hideSecond = false) {
  if (hideSecond) return `${hand[0]} ??`;
  return `${hand.join(" ")} **(${bjHandVal(hand)})**`;
}

function bjDealerPlay(game) {
  while (bjHandVal(game.dealerHand) < 17) game.dealerHand.push(game.deck.pop());
}

function bjResolve(game) {
  const pv = bjHandVal(game.playerHand);
  const dv = bjHandVal(game.dealerHand);
  const bal = getBalance(game.userId);
  if (pv > 21) {
    setBalance(game.userId, bal - game.bet);
    return `bust! kaybettin -${game.bet} 🪙`;
  }
  if (dv > 21 || pv > dv) {
    setBalance(game.userId, bal + game.bet);
    return `kazandın +${game.bet} 🪙`;
  }
  if (pv < dv) {
    setBalance(game.userId, bal - game.bet);
    return `kaybettin -${game.bet} 🪙`;
  }
  return "berabere, para iade";
}

function bjButtons(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bj_hit').setLabel('Kart Çek ⬆️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('bj_stand').setLabel('Dur 🛑').setStyle(ButtonStyle.Danger).setDisabled(disabled)
  );
}

/* =========================
   KELİME OYUNU
========================= */
const wordGames = new Map();
const tdkCache = new Map();

async function isTurkishWord(word) {
  const key = turkishLower(word);
  if (tdkCache.has(key)) return tdkCache.get(key);
  try {
    const r = await fetchWithTimeout(
      `https://sozluk.gov.tr/gts?ara=${encodeURIComponent(word)}`,
      {},
      5000
    );
    if (!r.ok) { tdkCache.set(key, true); return true; }
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      tdkCache.set(key, true);
      return true;
    }
    const r2 = await fetchWithTimeout(
      `https://sozluk.gov.tr/yazim?ara=${encodeURIComponent(word)}`,
      {},
      5000
    );
    if (!r2.ok) { tdkCache.set(key, true); return true; }
    const data2 = await r2.json();
    const valid = Array.isArray(data2) && data2.length > 0;
    tdkCache.set(key, valid);
    return valid;
  } catch {
    return true;
  }
}

function getStartWord() {
  const fallback = ["araba","bilgisayar","oyun","masa","kalem","defter","telefon","futbol","deniz","orman","aslan","kapı","yıldız","nehir","bahçe"];
  if (wordPool.length > 0) {
    for (let i = 0; i < 100; i++) {
      const w = wordPool[Math.floor(Math.random() * wordPool.length)].toLowerCase();
      if (w.length >= 4 && /^[a-zğüşıöç]+$/.test(w) && w[w.length - 1] !== "ğ") return w;
    }
  }
  return fallback[Math.floor(Math.random() * fallback.length)];
}

/* =========================
   TAHMİN OYUNU
========================= */
const guessGames = new Map();

async function handleGuessGame(message, content) {
  const channelId = message.channelId;
  if (!guessGames.has(channelId)) return false;
  const game = guessGames.get(channelId);
  const guess = parseInt(content.trim());
  if (isNaN(guess)) return false;
  if (guess === game.number) {
    guessGames.delete(channelId);
    await message.reply(`doğru! sayı ${game.number} idi 🎉`);
  } else if (guess < game.number) {
    await message.reply("daha büyük");
  } else {
    await message.reply("daha küçük");
  }
  return true;
}

/* =========================
   ROBLOX
========================= */
async function getRobloxPresence() {
  if (!ROBLOX_COOKIE) return null;
  try {
    const r = await fetchWithTimeout(
      `https://presence.roblox.com/v1/presence/users`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `.ROBLOSECURITY=${ROBLOX_COOKIE}`,
        },
        body: JSON.stringify({ userIds: [parseInt(ROBLOX_USER_ID)] }),
      },
      8000
    );
    if (!r.ok) return null;
    const data = await r.json();
    const p = data?.userPresences?.[0];
    if (!p) return null;
    return {
      online: p.userPresenceType > 0,
      inGame: p.userPresenceType === 2,
      inStudio: p.userPresenceType === 3,
      gameName: p.lastLocation || null,
    };
  } catch {
    return null;
  }
}

/* =========================
   DOĞUM GÜNÜ
========================= */
// roleMenus: { messageId: { guildId, channelId, title, roles: [{emoji, roleId, roleName}] } }
let roleMenus = {};
let roleMenuSaveTimer = null;
function saveRoleMenus() {
  if (roleMenuSaveTimer) clearTimeout(roleMenuSaveTimer);
  roleMenuSaveTimer = setTimeout(() => redisSet("roleMenus", roleMenus), 2000);
}

function buildRoleMenuContent(title, roles) {
  const lines = roles.map(r => `${r.emoji} : ${r.roleName}`);
  return `**Role Menu: ${title}**\nReact to give yourself a role.\n\n${lines.join('\n')}`;
}

// birthdays: { userId: { date: "GG-AA", name, guildId } }
let birthdays = {};
let birthdayLastRun = null; // artık kullanılmıyor, geriye dönük uyumluluk için tutuldu
// sentReminders: { "userId-YYYY": true } — yılda bir kez reminder için
// sentCelebrations: { "userId-YYYY": true } — yılda bir kez kutlama için
let sentReminders = {};
let sentCelebrations = {};

let birthdaySaveTimer = null;
function saveBirthdays() {
  if (birthdaySaveTimer) clearTimeout(birthdaySaveTimer);
  birthdaySaveTimer = setTimeout(() => {
    redisSet("birthdays", birthdays);
  }, 2000);
}

function pad2(n) { return String(n).padStart(2, "0"); }

// "12.05", "12/5", "12-05", "12 5" -> "12-05" (gün-ay), geçersizse null
function parseBirthday(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{1,2})\s*[.\/\-\s]\s*(\d{1,2})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;
  return `${pad2(day)}-${pad2(month)}`;
}

function formatBirthday(date) {
  const [d, mo] = date.split("-");
  return `${d}.${mo}`;
}

const TR_MONTHS = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
function formatBirthdayLong(date) {
  const [d, mo] = date.split("-");
  return `${parseInt(d, 10)} ${TR_MONTHS[parseInt(mo, 10) - 1]}`;
}

// Türkiye saatine göre gün-ay döndürür
function trDayMonth(offsetDays = 0) {
  const now = new Date();
  const tr = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));
  tr.setDate(tr.getDate() + offsetDays);
  return { key: `${pad2(tr.getDate())}-${pad2(tr.getMonth() + 1)}`, year: tr.getFullYear() };
}

// Bir guild için kutlama/sohbet kanalını döndürür (config -> system -> ilk uygun kanal)
async function findAnnounceChannel(guildId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const me = guild.members.me || (await guild.members.fetchMe());
    const configuredId = getSohbetChannelId(guildId);
    if (configuredId) {
      try {
        const ch = await guild.channels.fetch(configuredId);
        if (ch?.isTextBased?.() && ch.permissionsFor(me)?.has("SendMessages")) return ch;
      } catch {}
    }
    if (guild.systemChannel?.permissionsFor(me)?.has("SendMessages")) return guild.systemChannel;
    const channels = await guild.channels.fetch();
    for (const ch of channels.values()) {
      if (ch?.isTextBased?.() && ch.permissionsFor(me)?.has("SendMessages")) return ch;
    }
  } catch {}
  return null;
}

async function checkBirthdays() {
  if (Object.keys(birthdays).length === 0) return;

  const today = trDayMonth(0);
  const tomorrow = trDayMonth(1);
  console.log(`[BDAY] Kontrol: bugün=${today.key} yarın=${tomorrow.key}`);

  const entries = Object.entries(birthdays);

  // 1. Yarın doğum günü olanlar -> diğer kayıtlı kullanıcılara DM (yılda bir)
  const tomorrowPeople = entries.filter(([, b]) => b.date === tomorrow.key);
  for (const [uid, info] of tomorrowPeople) {
    const reminderKey = `${uid}-${tomorrow.year}`;
    if (sentReminders[reminderKey]) continue; // bu yıl zaten gönderildi
    sentReminders[reminderKey] = true;
    redisSet("bdaySent", { reminders: sentReminders, celebrations: sentCelebrations });
    const name = info.name || "birinin";
    console.log(`[BDAY] Yarın ${name} doğum günü, reminder gönderiliyor...`);
    for (const [otherId] of entries) {
      if (otherId === uid) continue;
      try {
        const user = await client.users.fetch(otherId);
        await user.send(`🎂 Yarın **${name}**'in doğum günü! Kutlamayı unutma 🎉`);
      } catch {}
      await sleep(500);
    }
  }

  // 2. Bugün doğum günü olanlar -> sohbet kanalına kutlama (yılda bir)
  const todayPeople = entries.filter(([, b]) => b.date === today.key);
  for (const [uid, info] of todayPeople) {
    const celebKey = `${uid}-${today.year}`;
    if (sentCelebrations[celebKey]) continue; // bu yıl zaten kutlandı
    sentCelebrations[celebKey] = true;
    redisSet("bdaySent", { reminders: sentReminders, celebrations: sentCelebrations });
    const channel = await findAnnounceChannel(info.guildId);
    if (channel) {
      try {
        await channel.send(`🎉🎂 İyi ki doğdun <@${uid}>! Mutlu yıllar! 🥳🎈`);
      } catch {}
    }
  }
}

/* =========================
   KİCK BİLDİRİMİ
========================= */
let kickWasLive = false;

async function sendKickNotification() {
  try {
    const ch = await client.channels.fetch(KICK_NOTIFY_CHANNEL_ID);
    if (ch?.isTextBased()) {
      await ch.send(`🔴 **Dünya çapında ADC Berkay Zeitnot Aşıkuzun şimdi yayında!**\nhttps://kick.com/${KICK_CHANNEL_SLUG}`);
    }
    console.log(`[KICK] Bildirim gönderildi`);
  } catch (e) {
    console.error(`[KICK] Bildirim hatası: ${e.message}`);
  }
}

function startKickPusher() {
  if (!KICK_CHANNEL_ID) {
    console.log(`[KICK] KICK_CHANNEL_ID ayarlanmamış, Pusher başlatılmıyor`);
    return;
  }
  const WS = require('ws');
  const PUSHER_URL = `wss://ws-us2.pusher.com/app/eb1d5f283081a78b932c?protocol=7&client=js&version=8.4.0&flash=false`;
  let reconnectDelay = 5000;

  function connect() {
    const ws = new WS(PUSHER_URL);

    ws.on('open', () => {
      console.log(`[KICK] Pusher bağlandı`);
      reconnectDelay = 5000;
      ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { auth: '', channel: `channel.${KICK_CHANNEL_ID}` },
      }));
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.event === 'App\\Events\\StreamerIsLive') {
        if (!kickWasLive) {
          kickWasLive = true;
          await sendKickNotification();
        }
      } else if (msg.event === 'App\\Events\\StreamerIsOffline') {
        console.log(`[KICK] Yayın bitti`);
        kickWasLive = false;
      } else if (msg.event === 'pusher:ping') {
        ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      }
    });

    ws.on('close', (code) => {
      console.log(`[KICK] Pusher bağlantısı kapandı (${code}), ${reconnectDelay/1000}sn sonra yeniden bağlanılıyor`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    });

    ws.on('error', (e) => {
      console.error(`[KICK] Pusher hatası: ${e.message}`);
    });
  }

  connect();
}

// Eski polling (artık kullanılmıyor, geriye dönük uyumluluk)
async function checkKick() {}

/* =========================
   GEMİNİ
========================= */
async function uploadMemoryToGemini() {
  if (!GEMINI_API_KEY || memory.length === 0) return;
  const text = memory.join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const form = new FormData();
  form.append("file", blob, "memory.txt");
  try {
    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
      { method: "POST", body: form },
      30000
    );
    if (!r.ok) return;
    const data = await r.json();
    geminiFileUri = data?.file?.uri;
    console.log(`[GEMİNİ] Hafıza dosyası yüklendi: ${geminiFileUri}`);
  } catch (e) {
    console.error("[GEMİNİ] Upload hatası:", e.message);
  }
}

async function askGemini(prompt, useFile = false, recentHistory = "") {
  if (!GEMINI_API_KEY) return null;
  try {
    const parts = [];
    if (useFile && geminiFileUri) {
      parts.push({ fileData: { mimeType: "text/plain", fileUri: geminiFileUri } });
    } else if (recentHistory) {
      parts.push({ text: `Son mesajlar:\n${recentHistory}\n\n` });
    }
    parts.push({ text: prompt });

    const body = {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.95,
        maxOutputTokens: 200,
        topP: 0.9,
      },
    };

    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      15000
    );
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.log("[GEMİNİ] API hatası:", r.status, errText.slice(0, 200));
      return null;
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;
    const cleaned = text.replace(/[*_`~|]/g, "").trim();
    if (containsReligiousAbuse(cleaned)) return null;
    if (!cleaned) return null;
    return cleaned;
  } catch (e) {
    console.log("[GEMİNİ] catch hatası:", e.message);
    return null;
  }
}

/* =========================
   MÜZİK (yt-dlp)
========================= */
const musicQueues = new Map();

const YT_COOKIE_FILE = "/root/AecBot/yt-cookies.txt";
if (process.env.YOUTUBE_COOKIE) {
  try {
    let content = process.env.YOUTUBE_COOKIE.replace(/\\n/g, "\n");
    if (!content.includes("\n")) {
      const entries = content.split(/ (?=\.youtube\.com\t)/);
      content = "# Netscape HTTP Cookie File\n" + entries.join("\n");
    }
    fs.writeFileSync(YT_COOKIE_FILE, content);
  } catch {}
}
function ytdlpCookieArgs() {
  return fs.existsSync(YT_COOKIE_FILE) ? ["--cookies", YT_COOKIE_FILE] : [];
}

async function ytdlpGetInfo(url) {
  try {
    const r = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {}, 5000
    );
    if (r.ok) { const d = await r.json(); return d.title || url; }
  } catch {}
  return url;
}

async function ytdlpSearch(query) {
  try {
    const results = await playdl.search(query, { source: { youtube: "video" }, limit: 1 });
    if (results.length > 0) return { title: results[0].title, url: results[0].url };
  } catch {}
  return new Promise((resolve, reject) => {
    const args = ["--no-playlist", "--print", "%(title)s", "--print", "%(webpage_url)s",
      "--no-warnings", "--extractor-args", "youtube:player_client=ios,web",
      "--socket-timeout", "10", ...ytdlpCookieArgs(), `ytsearch1:${query}`];
    const proc = spawn("yt-dlp", args);
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; });
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(stderr.slice(0, 200) || "yt-dlp hata: " + code));
      const lines = stdout.trim().split("\n");
      if (lines.length < 2) return reject(new Error("Sonuç bulunamadı"));
      resolve({ title: lines[0], url: lines[1] });
    });
    proc.on("error", reject);
    setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 20000);
  });
}

function ytdlpTempFile(url, cookieArgs) {
  const tmpFile = `/tmp/aecbot_${Date.now()}.webm`;
  return new Promise((resolve, reject) => {
    const ytdlp = spawn("yt-dlp", [
      "--js-runtimes", "node",
      "-f", "bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio",
      "--no-playlist",
      ...cookieArgs,
      "-o", tmpFile, url
    ]);
    let err = "";
    ytdlp.stderr.on("data", d => { err += d; });
    ytdlp.on("error", reject);
    const dlTimer = setTimeout(() => { ytdlp.kill(); reject(new Error("yt-dlp download timeout")); }, 120000);
    ytdlp.on("close", code => {
      clearTimeout(dlTimer);
      if (code !== 0) {
        fs.unlink(tmpFile, () => {});
        console.log("[yt-dlp]", err.slice(-300));
        return reject(new Error(err.slice(-200)));
      }
      const ffmpeg = spawn("ffmpeg", [
        "-i", tmpFile, "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2",
        "-loglevel", "warning", "pipe:1"
      ]);
      let resolved = false;
      ffmpeg.stderr.on("data", d => console.log("[ffmpeg]", d.toString().slice(0, 150)));
      ffmpeg.on("error", e => { if (!resolved) { resolved = true; fs.unlink(tmpFile, () => {}); reject(e); } });
      ffmpeg.stdout.once("readable", () => {
        if (!resolved) {
          resolved = true;
          const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
          ffmpeg.on("close", () => fs.unlink(tmpFile, () => {}));
          resolve(resource);
        }
      });
      setTimeout(() => {
        if (!resolved) { resolved = true; ffmpeg.kill(); fs.unlink(tmpFile, () => {}); reject(new Error("ffmpeg timeout")); }
      }, 15000);
    });
  });
}

const INVIDIOUS_INSTANCES = [
  "https://invidious.privacyredirect.com",
  "https://invidious.nerdvpn.de",
  "https://yewtu.be",
  "https://invidious.slipfox.xyz",
  "https://inv.tux.pizza",
  "https://iv.datura.network",
];

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.tokhmi.xyz",
];

async function isAudioUrlValid(url) {
  try {
    const r = await fetchWithTimeout(url, { method: "HEAD" }, 1500);
    if (!r.ok) return false;
    const ct = r.headers.get("content-type") || "";
    return ct.includes("audio") || ct.includes("video") || ct.includes("octet");
  } catch {
    return false;
  }
}

// Tüm instance + itag kombinasyonlarını paralel dene, ilk çalışanı al
async function getInvidiousAudioUrl(videoId) {
  const itags = [251, 140];
  const attempts = [];
  for (const instance of INVIDIOUS_INSTANCES) {
    for (const itag of itags) {
      attempts.push((async () => {
        const url = `${instance}/latest_version?id=${videoId}&itag=${itag}&local=true`;
        const valid = await isAudioUrlValid(url);
        if (!valid) throw new Error("invalid");
        console.log(`[MÜZİK] Invidious stream: ${instance} itag=${itag}`);
        return url;
      })());
    }
  }
  try {
    return await Promise.any(attempts);
  } catch {
    console.log("[MÜZİK] Tüm Invidious instance'ları başarısız");
    return null;
  }
}

async function getPipedAudioUrl(videoId) {
  const attempts = PIPED_INSTANCES.map(async instance => {
    const r = await fetchWithTimeout(`${instance}/streams/${videoId}`, {}, 2500);
    if (!r.ok) throw new Error("not ok");
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    const streams = (data.audioStreams || []).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (!streams.length) throw new Error("no streams");
    const audioUrl = streams[0].url;
    if (!audioUrl) throw new Error("no url");
    const valid = await isAudioUrlValid(audioUrl);
    if (!valid) throw new Error("url erişilemez");
    console.log(`[MÜZİK] Piped stream: ${instance}`);
    return audioUrl;
  });
  try {
    return await Promise.any(attempts);
  } catch {
    console.log("[MÜZİK] Tüm Piped instance'ları başarısız");
    return null;
  }
}

function ffmpegFromUrl(audioUrl) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      "-i", audioUrl,
      "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2",
      "-loglevel", "warning", "pipe:1"
    ]);
    let resolved = false;
    let stderrBuf = "";
    ffmpeg.stderr.on("data", d => {
      const s = d.toString();
      stderrBuf += s;
      console.log("[ffmpeg-inv]", s.slice(0, 150));
    });
    ffmpeg.on("error", err => { if (!resolved) { resolved = true; reject(err); } });
    ffmpeg.on("close", code => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`ffmpeg erken çıktı (kod ${code}): ${stderrBuf.slice(0, 120)}`));
      }
    });
    ffmpeg.stdout.once("readable", () => {
      if (!resolved) {
        // Çok hızlı kapanma varsa yakında close eventi gelecek, küçük bekleme
        setTimeout(() => {
          if (!resolved) { resolved = true; resolve(createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw })); }
        }, 200);
      }
    });
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; ffmpeg.kill(); reject(new Error("ffmpeg 30s timeout")); }
    }, 30000);
    ffmpeg.stdout.on("close", () => clearTimeout(timer));
  });
}

async function soundcloudStream(query) {
  // play-dl ile SoundCloud'da ara ve direkt stream et (yt-dlp gerektirmez)
  const results = await playdl.search(query, { source: { soundcloud: "tracks" }, limit: 1 });
  if (!results || !results[0]) throw new Error("SoundCloud'da bulunamadı");
  const scUrl = results[0].url;
  console.log("[MÜZİK] SoundCloud:", results[0].name);
  const stream = await playdl.stream(scUrl);
  return createAudioResource(stream.stream, { inputType: stream.type });
}

async function ytdlpCreateResource(url, title) {
  const ytVidMatch = url.match(/(?:youtu\.be\/|[?&]v=)([a-zA-Z0-9_-]{11})/);
  if (ytVidMatch) {
    const videoId = ytVidMatch[1];
    // 1. Invidious proxy
    try {
      const audioUrl = await getInvidiousAudioUrl(videoId);
      if (audioUrl) return await ffmpegFromUrl(audioUrl);
    } catch (e) {
      console.log("[MÜZİK] Invidious stream başarısız:", e.message?.slice(0, 80));
    }
    // 2. Piped.video proxy
    try {
      const audioUrl = await getPipedAudioUrl(videoId);
      if (audioUrl) return await ffmpegFromUrl(audioUrl);
    } catch (e) {
      console.log("[MÜZİK] Piped stream başarısız:", e.message?.slice(0, 80));
    }
  }
  // 3. yt-dlp temp dosya → ffmpeg
  const cookieArgs = ytdlpCookieArgs();
  try {
    return await ytdlpTempFile(url, cookieArgs);
  } catch (e) {
    console.log("[MÜZİK] yt-dlp başarısız:", e.message?.slice(0, 80));
    if (cookieArgs.length > 0) {
      try {
        return await ytdlpTempFile(url, []);
      } catch (e2) {
        console.log("[MÜZİK] yt-dlp cookie'siz de başarısız:", e2.message?.slice(0, 80));
      }
    }
  }
  // 4. Son çare: SoundCloud
  const scQuery = title || url;
  console.log("[MÜZİK] SoundCloud fallback:", scQuery.slice(0, 60));
  return await soundcloudStream(scQuery);
}

async function playNext(guildId) {
  const state = musicQueues.get(guildId);
  if (!state) return;
  if (state.queue.length === 0) {
    state.current = null;
    // Hemen çıkma — 3 dakika bekle, yeni şarkı gelmezse ayrıl
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      const s = musicQueues.get(guildId);
      if (s && s.queue.length === 0 && !s.current) {
        try { s.connection.destroy(); } catch {}
        musicQueues.delete(guildId);
      }
    }, 3 * 60 * 1000);
    return;
  }
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  const song = state.queue.shift();
  state.current = song;
  try {
    const resource = await ytdlpCreateResource(song.url, song.title);
    state.player.play(resource);
    if (state.textChannel) await state.textChannel.send(`▶️ Şimdi çalıyor: **${song.title}**`);
  } catch (e) {
    console.error("[MÜZİK] playNext hatası:", e.message?.slice(0, 200));
    if (state.textChannel) await state.textChannel.send("❌ Çalarken hata oluştu, atlanıyor...");
    playNext(guildId);
  }
}

/* =========================
   SLASH KOMUT TANIMLARI
========================= */
const SLASH_COMMANDS = [
  { name: 'çal', description: 'Bir şarkı çal', options: [{ name: 'şarkı', description: 'Şarkı adı, YouTube veya Spotify linki', type: ApplicationCommandOptionType.String, required: true }] },
  { name: 'dur', description: 'Müziği duraklat' },
  { name: 'devam', description: 'Müziği devam ettir' },
  { name: 'atla', description: 'Mevcut şarkıyı atla' },
  { name: 'kuyruk', description: 'Müzik kuyruğunu göster' },
  { name: 'çık', description: 'Ses kanalından çık' },
  { name: 'bakiye', description: 'Para bakiyeni gör' },
  { name: 'bonus', description: 'Günlük bonus al (500 🪙)' },
  { name: 'ver', description: 'Birine para gönder', options: [
    { name: 'kişi', description: 'Kişi', type: ApplicationCommandOptionType.User, required: true },
    { name: 'miktar', description: 'Miktar', type: ApplicationCommandOptionType.Integer, required: true, minValue: 1 }
  ]},
  { name: 'sıralama', description: 'Para sıralaması' },
  { name: 'zar', description: 'Zar at', options: [{ name: 'miktar', description: 'Bahis (sayı veya hepsi)', type: ApplicationCommandOptionType.String, required: true }] },
  { name: 'tura', description: 'Yazı tura', options: [
    { name: 'miktar', description: 'Bahis', type: ApplicationCommandOptionType.String, required: true },
    { name: 'seçim', description: 'Yazı veya tura', type: ApplicationCommandOptionType.String, required: true, choices: [{ name: 'Yazı', value: 'yazı' }, { name: 'Tura', value: 'tura' }] }
  ]},
  { name: 'tkm', description: 'Taş kağıt makas', options: [
    { name: 'miktar', description: 'Bahis', type: ApplicationCommandOptionType.String, required: true },
    { name: 'seçim', description: 'Seçim', type: ApplicationCommandOptionType.String, required: true, choices: [{ name: 'Taş', value: 'taş' }, { name: 'Kağıt', value: 'kağıt' }, { name: 'Makas', value: 'makas' }] }
  ]},
  { name: 'bj', description: 'Blackjack oyna', options: [{ name: 'miktar', description: 'Bahis', type: ApplicationCommandOptionType.String, required: true }] },
  { name: 'slot', description: 'Slot makinesi', options: [{ name: 'miktar', description: 'Bahis', type: ApplicationCommandOptionType.String, required: true }] },
  { name: 'tahmin', description: 'Sayı tahmin oyunu başlat' },
  { name: 'kelime', description: 'Kelime oyunu başlat' },
  { name: 'kelimeson', description: 'Kelime oyununu bitir' },
  { name: 'kasalar', description: 'CS2 kasalarını listele' },
  { name: 'kasa', description: 'CS2 kasası aç', options: [{ name: 'tip', description: 'Kasa türü', type: ApplicationCommandOptionType.String, required: true, choices: [
    { name: 'Recoil Case', value: 'recoil' }, { name: 'Revolution Case', value: 'revolution' },
    { name: 'Kilowatt Case', value: 'kilowatt' }, { name: 'Gamma 2 Case', value: 'gamma2' },
    { name: 'Dreams & Nightmares', value: 'dreams' }, { name: 'Chroma 2 Case', value: 'chroma' },
    { name: 'Cobblestone Package', value: 'cobblestone' }
  ]}]},
  { name: 'envanter', description: 'CS2 envanterini gör', options: [{ name: 'kişi', description: 'Kullanıcı (boş = kendin)', type: ApplicationCommandOptionType.User, required: false }] },
  { name: 'sat', description: 'Envanterdeki bir itemi coin karşılığı sat', options: [
    { name: 'numara', description: 'Envanter numarası (/envanter ile gör)', type: ApplicationCommandOptionType.Integer, required: true, minValue: 1 }
  ]},
  { name: 'takas', description: 'Başka bir kullanıcıyla item takası yap', options: [
    { name: 'kişi', description: 'Takas yapılacak kişi', type: ApplicationCommandOptionType.User, required: true },
    { name: 'ver', description: 'Kendi envanter numaranı ver (0 = sadece ver, takas alma)', type: ApplicationCommandOptionType.Integer, required: true, minValue: 0 },
    { name: 'al', description: 'Karşının envanter numarası (0 = sadece ver, karşılık alma)', type: ApplicationCommandOptionType.Integer, required: false, minValue: 1 },
  ]},
  { name: 'ai', description: 'Yapay zeka ile konuş', options: [{ name: 'mesaj', description: 'Mesajın', type: ApplicationCommandOptionType.String, required: false }] },
  { name: 'hafıza', description: 'Eski bir mesajı hatırla' },
  { name: 'gökhan', description: "Gökhan Roblox'ta mı?" },
  { name: 'roblox', description: 'Roblox oyun durumu' },
  {
    name: 'doğumgünü',
    description: 'Doğum günü işlemleri',
    options: [
      {
        name: 'ekle',
        description: 'Doğum günü kaydet',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          { name: 'tarih', description: 'Gün.Ay (örn: 12.05)', type: ApplicationCommandOptionType.String, required: true },
          { name: 'kişi', description: 'Kimin doğum günü (boş = kendin)', type: ApplicationCommandOptionType.User, required: false },
        ],
      },
      {
        name: 'sil',
        description: 'Doğum günü kaldır',
        type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'kişi', description: 'Kimin (boş = kendin)', type: ApplicationCommandOptionType.User, required: false }],
      },
      { name: 'liste', description: 'Kayıtlı doğum günleri', type: ApplicationCommandOptionType.Subcommand },
    ],
  },
  {
    name: 'ayar',
    description: 'Sunucu kanal ayarları (yönetici)',
    options: [
      {
        name: 'sohbet',
        description: 'Kutlama/sohbet kanalını ayarla',
        type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'kanal', description: 'Kanal', type: ApplicationCommandOptionType.Channel, required: true, channelTypes: [ChannelType.GuildText] }],
      },
      {
        name: 'seed',
        description: 'Öğrenme (seed) kanalını ayarla',
        type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'kanal', description: 'Kanal', type: ApplicationCommandOptionType.Channel, required: true, channelTypes: [ChannelType.GuildText] }],
      },
      { name: 'göster', description: 'Mevcut ayarları göster', type: ApplicationCommandOptionType.Subcommand },
    ],
  },
  {
    name: 'roller',
    description: 'Rol menüsü sistemi (yönetici)',
    defaultMemberPermissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      {
        name: 'oluştur',
        description: 'Yeni rol menüsü oluştur',
        type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'başlık', description: 'Menü başlığı (örn: roller)', type: ApplicationCommandOptionType.String, required: true }],
      },
      {
        name: 'ekle',
        description: 'Rol menüsüne emoji-rol çifti ekle',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          { name: 'mesaj', description: 'Rol menüsü mesaj ID', type: ApplicationCommandOptionType.String, required: true },
          { name: 'emoji', description: 'Emoji (Unicode veya sunucu emojisi)', type: ApplicationCommandOptionType.String, required: true },
          { name: 'rol', description: 'Verilecek rol', type: ApplicationCommandOptionType.Role, required: true },
        ],
      },
      {
        name: 'çıkar',
        description: 'Rol menüsünden emoji-rol çiftini kaldır',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          { name: 'mesaj', description: 'Rol menüsü mesaj ID', type: ApplicationCommandOptionType.String, required: true },
          { name: 'emoji', description: 'Kaldırılacak emoji', type: ApplicationCommandOptionType.String, required: true },
        ],
      },
      {
        name: 'sil',
        description: 'Rol menüsünü tamamen sil',
        type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'mesaj', description: 'Rol menüsü mesaj ID', type: ApplicationCommandOptionType.String, required: true }],
      },
    ],
  },
  { name: 'çark', description: 'Çark çevir ve rastgele seç', options: [
    { name: 'seçenekler', description: 'Virgülle ayır: Pizza, Burger, Sushi', type: ApplicationCommandOptionType.String, required: true },
  ]},
  { name: 'seed-yenile', description: 'Seed kanallarını sıfırdan tara ve Markov modelini yenile (yönetici)', defaultMemberPermissions: String(PermissionFlagsBits.ManageGuild) },
  { name: 'yardım', description: 'Komut listesi' },
];

/* =========================
   SEED FONKSIYONU
========================= */
const COMBINE_GAP_MS = 5 * 60 * 1000;

async function runSeed() {
  if (seedState.running) return;
  try {
    const rawMessages = [];
    memory.length = 0;
    memorySet.clear();
    seedState.running = true;
    seedState.done = false;
    seedState.error = null;
    seedState.collected = 0;
    seedState.fetchCount = 0;
    seedState.startedAt = Date.now();
    const cutoff = Date.now() - SEED_DAYS * 24 * 60 * 60 * 1000;

    const channelNames = [];
    for (const channelId of seedChannelIds) {
      let channel;
      try { channel = await client.channels.fetch(channelId); } catch { continue; }
      if (!channel?.isTextBased()) continue;
      channelNames.push(channel.name);
      console.log(`[SEED] ${channel.name} kanalından mesajlar yükleniyor...`);

      let seedPending = null;
      function flushSeedPending() {
        if (!seedPending) return;
        const { username, text } = seedPending;
        if (!containsReligiousAbuse(text)) {
          rawMessages.push(text);
          const entry = `${username}: ${text}`;
          if (!memorySet.has(normalizeText(entry))) {
            memory.push(entry);
            memorySet.add(normalizeText(entry));
          }
        }
        seedPending = null;
      }

      let lastId = null;
      let fetched = 0;
      while (fetched < SEED_MAX) {
        const opts = { limit: 100 };
        if (lastId) opts.before = lastId;
        let msgs;
        try { msgs = await channel.messages.fetch(opts); } catch (e) { seedState.error = e.message; break; }
        if (msgs.size === 0) break;
        let tooOld = false;
        for (const m of msgs.values()) {
          if (m.createdTimestamp < cutoff) { tooOld = true; flushSeedPending(); break; }
          if (m.author.bot || !m.content || m.content.length > MAX_WORDS_PER_MESSAGE * 8) { flushSeedPending(); continue; }
          const txt = m.content.trim();
          if (!txt) continue;
          if (seedPending && seedPending.authorId === m.author.id && (seedPending.timestamp - m.createdTimestamp) < COMBINE_GAP_MS) {
            seedPending.text = txt + " " + seedPending.text;
            seedPending.timestamp = m.createdTimestamp;
          } else {
            flushSeedPending();
            seedPending = { authorId: m.author.id, username: m.author.username, timestamp: m.createdTimestamp, text: txt };
          }
        }
        fetched += msgs.size;
        seedState.collected = rawMessages.length;
        seedState.fetchCount = fetched;
        seedState.lastUpdateAt = Date.now();
        lastId = msgs.last()?.id;
        if (tooOld) break;
        await sleep(120);
      }
      flushSeedPending();
    }

    seedState.channelName = channelNames.join(", ");
    buildMarkov(rawMessages);
    if (memory.length > MAX_MEMORY_MESSAGES) memory.splice(0, memory.length - MAX_MEMORY_MESSAGES);
    uploadMemoryToGemini();
    saveSeedMemory();
    seedState.running = false;
    seedState.done = true;
    console.log(`[SEED] Tamamlandı: ${rawMessages.length} mesaj, ${memory.length} hafıza`);
  } catch (e) {
    seedState.running = false;
    seedState.error = e.message;
    console.error("[SEED] Hata:", e.message);
  }
}

/* =========================
   DİSCORD
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});


client.once("ready", async () => {
  console.log(`[BOT] ${client.user.tag} hazır`);
  startKickPusher();

  await client.application.commands.set(SLASH_COMMANDS);
  console.log('[BOT] Slash komutları kaydedildi');

  // SoundCloud client_id otomatik al
  try {
    const scId = await playdl.getFreeClientID();
    playdl.setToken({ soundcloud: { client_id: scId } });
    console.log('[BOT] SoundCloud client_id alındı');
  } catch (e) {
    console.log('[BOT] SoundCloud client_id alınamadı:', e.message?.slice(0, 60));
  }

  // Doğum günü kontrolü (her saat başı; içeride günde 1 kez çalışır)
  setInterval(checkBirthdays, 60 * 60 * 1000);
  setTimeout(checkBirthdays, 10 * 1000);

  const [savedEconomy, savedInventory, savedBirthdays, savedBdayRun, savedGuildConfig, savedSeed, savedRoleMenus, savedBdaySent] = await Promise.all([
    redisGet("economy"),
    redisGet("inventory"),
    redisGet("birthdays"),
    redisGet("birthdayLastRun"),
    redisGet("guildConfig"),
    redisGet("seedMemory"),
    redisGet("roleMenus"),
    redisGet("bdaySent"),
  ]);
  if (savedGuildConfig) {
    guildConfig = savedGuildConfig;
    rebuildSeedChannelIds();
    console.log(`[AYAR] ${Object.keys(guildConfig).length} sunucu ayarı yüklendi`);
  }
  if (savedBirthdays) {
    birthdays = savedBirthdays;
    console.log(`[DOĞUMGÜNÜ] ${Object.keys(birthdays).length} kayıt yüklendi`);
  }
  if (savedBdayRun) birthdayLastRun = savedBdayRun;
  if (savedBdaySent) {
    sentReminders = savedBdaySent.reminders || {};
    sentCelebrations = savedBdaySent.celebrations || {};
    console.log(`[DOĞUMGÜNÜ] ${Object.keys(sentReminders).length} reminder, ${Object.keys(sentCelebrations).length} kutlama kaydı yüklendi`);
  }
  if (savedRoleMenus) {
    roleMenus = savedRoleMenus;
    console.log(`[ROLLER] ${Object.keys(roleMenus).length} rol menüsü yüklendi`);
  }
  if (savedEconomy) {
    for (const [k, v] of Object.entries(savedEconomy)) balances.set(k, Number(v));
    console.log(`[EKONOMİ] ${balances.size} kullanıcı Redis'ten yüklendi`);
  } else {
    console.log(`[EKONOMİ] Redis'te veri yok, sıfırdan başlıyor`);
  }
  if (savedInventory) {
    inventory = savedInventory;
    console.log(`[ENVANTER] Redis'ten yüklendi`);
  }

  // Seed Redis cache'inde varsa Discord'dan çekme, hızlı başlat
  if (savedSeed && Array.isArray(savedSeed) && savedSeed.length > 0) {
    const rawMessages = [];
    for (const entry of savedSeed) {
      if (!memorySet.has(normalizeText(entry))) {
        memory.push(entry);
        memorySet.add(normalizeText(entry));
      }
      const idx = entry.indexOf(": ");
      rawMessages.push(idx >= 0 ? entry.slice(idx + 2) : entry);
    }
    buildMarkov(rawMessages);
    uploadMemoryToGemini();
    seedState.running = false;
    seedState.done = true;
    console.log(`[SEED] Redis cache'inden yüklendi: ${memory.length} mesaj (Discord taraması atlandı)`);
  } else {
    runSeed();
  }
});

/* =========================
   HTTP SUNUCU
========================= */
http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = url.searchParams.get("key");

  if (url.pathname === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (CMD_KEY && key !== CMD_KEY) {
    res.writeHead(401);
    res.end("unauthorized");
    return;
  }

  if (url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      uptime: Math.floor(process.uptime()),
      memoryEntries: memory.length,
      markovTrigrams: markovChain.size,
      wordPoolSize: wordPool.length,
      seed: seedState,
    }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
}).listen(PORT, () => console.log(`[HTTP] Port ${PORT}`));

/* =========================
   INTERACTION HANDLER
========================= */
client.on('interactionCreate', async (interaction) => {
  // Takas butonları
  if (interaction.isButton() && (interaction.customId.startsWith('takas_accept_') || interaction.customId.startsWith('takas_decline_'))) {
    const tradeId = parseInt(interaction.customId.split('_')[2]);
    const trade = pendingTrades.get(tradeId);
    if (!trade) { await interaction.reply({ content: 'Bu takas teklifi süresi dolmuş veya geçersiz.', flags: 64 }); return; }
    if (interaction.user.id !== trade.targetId) { await interaction.reply({ content: 'Bu teklif sana ait değil.', flags: 64 }); return; }

    clearTimeout(trade.timeout);
    pendingTrades.delete(tradeId);

    const senderInv = inventory[trade.senderId];
    const targetInv = inventory[trade.targetId];

    if (interaction.customId.startsWith('takas_decline_')) {
      await interaction.update({ content: `❌ **Takas reddedildi.**`, components: [] });
      return;
    }

    // Kabul — itemi doğrula ve takas et
    if (!senderInv || !senderInv.items[trade.senderIdx]) {
      await interaction.update({ content: '❌ Teklif eden kullanıcının itemi artık mevcut değil.', components: [] }); return;
    }
    if (trade.targetIdx !== null && (!targetInv || !targetInv.items[trade.targetIdx])) {
      await interaction.update({ content: '❌ Senin iteminiz artık mevcut değil.', components: [] }); return;
    }

    const senderItem = senderInv.items[trade.senderIdx];
    if (trade.targetIdx !== null) {
      const targetItem = targetInv.items[trade.targetIdx];
      senderInv.items.splice(trade.senderIdx, 1);
      targetInv.items.splice(trade.targetIdx, 1);
      if (!inventory[trade.targetId]) inventory[trade.targetId] = { username: interaction.user.username, items: [] };
      if (!inventory[trade.senderId]) inventory[trade.senderId] = { username: trade.senderName, items: [] };
      inventory[trade.targetId].items.push(senderItem);
      inventory[trade.senderId].items.push(targetItem);
      saveInventory();
      await interaction.update({ content: `✅ **Takas tamamlandı!**\n<@${trade.senderId}> → **${senderItem.name}** ↔ <@${trade.targetId}> → **${targetItem.name}**`, components: [], allowedMentions: { parse: [] } });
    } else {
      // Karşılıksız transfer (hediye)
      senderInv.items.splice(trade.senderIdx, 1);
      if (!inventory[trade.targetId]) inventory[trade.targetId] = { username: interaction.user.username, items: [] };
      inventory[trade.targetId].items.push(senderItem);
      saveInventory();
      await interaction.update({ content: `✅ **Transfer tamamlandı!**\n<@${trade.senderId}> → <@${trade.targetId}>: **${senderItem.name}**`, components: [], allowedMentions: { parse: [] } });
    }
    return;
  }

  // Blackjack butonu
  if (interaction.isButton()) {
    if (interaction.customId !== 'bj_hit' && interaction.customId !== 'bj_stand') return;
    const game = bjGames.get(interaction.user.id);
    if (!game) { await interaction.reply({ content: 'Aktif oyunun yok.', flags: 64 }); return; }

    if (interaction.customId === 'bj_hit') {
      game.playerHand.push(game.deck.pop());
      if (bjHandVal(game.playerHand) > 21) {
        bjGames.delete(interaction.user.id);
        setBalance(game.userId, getBalance(game.userId) - game.bet);
        await interaction.update({ content: `Sen: ${bjShowHand(game.playerHand)}\nDealer: ${bjShowHand(game.dealerHand)}\nBUST! -${game.bet} 🪙 | Bakiye: ${getBalance(game.userId)} 🪙`, components: [bjButtons(true)] });
      } else {
        await interaction.update({ content: `Sen: ${bjShowHand(game.playerHand)}\nDealer: ${bjShowHand(game.dealerHand, true)}\nBahis: ${game.bet} 🪙`, components: [bjButtons()] });
      }
    } else {
      bjDealerPlay(game);
      const result = bjResolve(game);
      bjGames.delete(interaction.user.id);
      await interaction.update({ content: `Sen: ${bjShowHand(game.playerHand)}\nDealer: ${bjShowHand(game.dealerHand)}\n${result} | Bakiye: ${getBalance(game.userId)} 🪙`, components: [bjButtons(true)] });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  // === MÜZİK ===
  if (cmd === 'çal') {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) { await interaction.reply({ content: 'Önce bir ses kanalına gir!', flags: 64 }); return; }
    let query = interaction.options.getString('şarkı');
    const ytVidMatch = query.match(/(?:youtu\.be\/|[?&]v=)([a-zA-Z0-9_-]{11})/);
    if (ytVidMatch && query.includes('list=')) query = `https://www.youtube.com/watch?v=${ytVidMatch[1]}`;
    await interaction.deferReply();
    let song;
    try {
      const urlType = await playdl.validate(query).catch(() => null);
      if (urlType === 'yt_video' || (ytVidMatch && (urlType === 'yt_playlist' || !urlType))) {
        const videoUrl = ytVidMatch ? `https://www.youtube.com/watch?v=${ytVidMatch[1]}` : query;
        const title = await ytdlpGetInfo(videoUrl);
        song = { url: videoUrl, title: title || videoUrl };
      } else if (urlType === 'sp_track') {
        const spData = await playdl.spotify(query);
        const searchQ = `${spData.name} ${spData.artists?.[0]?.name || ''}`.trim();
        const result = await ytdlpSearch(searchQ);
        song = { url: result.url, title: `${spData.name}${spData.artists?.[0]?.name ? ' - ' + spData.artists[0].name : ''}` };
      } else {
        song = await ytdlpSearch(query);
      }
    } catch (e) {
      await interaction.editReply(`❌ Şarkı bulunamadı: ${e.message?.slice(0, 100)}`);
      return;
    }
    if (!musicQueues.has(interaction.guildId)) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });
      const ap = createAudioPlayer();
      connection.subscribe(ap);
      ap.on(AudioPlayerStatus.Idle, () => playNext(interaction.guildId));
      musicQueues.set(interaction.guildId, { connection, player: ap, queue: [], current: null, textChannel: interaction.channel });
    }
    const state = musicQueues.get(interaction.guildId);
    state.queue.push(song);
    if (!state.current) {
      await interaction.editReply(`▶️ Yükleniyor: **${song.title}**`);
      playNext(interaction.guildId);
    } else {
      await interaction.editReply(`➕ Kuyruğa eklendi: **${song.title}**`);
    }
    return;
  }

  if (cmd === 'dur') {
    const state = musicQueues.get(interaction.guildId);
    if (!state?.current) { await interaction.reply('Şu an çalan bir şey yok.'); return; }
    state.player.pause();
    await interaction.reply('⏸️ Duraklatıldı.');
    return;
  }

  if (cmd === 'devam') {
    const state = musicQueues.get(interaction.guildId);
    if (!state) { await interaction.reply('Şu an çalan bir şey yok.'); return; }
    state.player.unpause();
    await interaction.reply('▶️ Devam ediyor.');
    return;
  }

  if (cmd === 'atla') {
    const state = musicQueues.get(interaction.guildId);
    if (!state?.current) { await interaction.reply('Atlanacak bir şey yok.'); return; }
    state.player.stop();
    await interaction.reply('⏭️ Atlandı.');
    return;
  }

  if (cmd === 'kuyruk') {
    const state = musicQueues.get(interaction.guildId);
    if (!state?.current) { await interaction.reply('Kuyruk boş.'); return; }
    const lines = [`▶️ **${state.current.title}** (çalıyor)`];
    state.queue.forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
    await interaction.reply(lines.slice(0, 20).join('\n'));
    return;
  }

  if (cmd === 'çık') {
    const state = musicQueues.get(interaction.guildId);
    if (!state) { await interaction.reply('Ses kanalında değilim.'); return; }
    state.queue = [];
    state.player.stop();
    try { state.connection.destroy(); } catch {}
    musicQueues.delete(interaction.guildId);
    await interaction.reply('👋 Ses kanalından çıkıldı.');
    return;
  }

  // === EKONOMİ ===
  if (cmd === 'bakiye') {
    await interaction.reply(`bakiyen: **${getBalance(interaction.user.id)}** 🪙`);
    return;
  }

  if (cmd === 'bonus') {
    const now = Date.now();
    const last = lastBonus.get(interaction.user.id) || 0;
    if (now - last < BONUS_COOLDOWN) {
      const kalan = BONUS_COOLDOWN - (now - last);
      await interaction.reply(`bonus zaten alındı. kalan: ${formatDuration(kalan)}`);
      return;
    }
    lastBonus.set(interaction.user.id, now);
    setBalance(interaction.user.id, getBalance(interaction.user.id) + BONUS_AMOUNT);
    await interaction.reply(`günlük bonus +${BONUS_AMOUNT} 🪙 | Bakiye: ${getBalance(interaction.user.id)} 🪙`);
    return;
  }

  if (cmd === 'ver') {
    const target = interaction.options.getUser('kişi');
    const amount = interaction.options.getInteger('miktar');
    if (target.id === interaction.user.id || target.bot) { await interaction.reply('Geçersiz hedef.'); return; }
    const bal = getBalance(interaction.user.id);
    if (amount > bal) { await interaction.reply(`yetersiz bakiye! Bakiyen: ${bal} 🪙`); return; }
    setBalance(interaction.user.id, bal - amount);
    setBalance(target.id, getBalance(target.id) + amount);
    await interaction.reply(`${target.username}'a **${amount}** 🪙 gönderildi`);
    return;
  }

  if (cmd === 'sıralama') {
    await interaction.deferReply();
    const sorted = [...balances.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (sorted.length === 0) { await interaction.editReply('henüz bakiye kaydı yok'); return; }
    const medals = ['🥇','🥈','🥉'];
    const lines = await Promise.all(sorted.map(async ([uid, bal], i) => {
      let name;
      try { const u = await client.users.fetch(uid); name = u.username; } catch { name = uid; }
      return `${medals[i] || `${i+1}.`} **${name}** — ${bal} 🪙`;
    }));
    await interaction.editReply('**para sıralaması:**\n' + lines.join('\n'));
    return;
  }

  // === OYUNLAR ===
  if (cmd === 'zar') {
    const bet = parseBet(interaction.options.getString('miktar'), interaction.user.id);
    if (!bet) { await interaction.reply(`geçersiz miktar. bakiyen: ${getBalance(interaction.user.id)} 🪙`); return; }
    const ur = Math.floor(Math.random() * 6) + 1;
    const br = Math.floor(Math.random() * 6) + 1;
    const bal = getBalance(interaction.user.id);
    let result;
    if (ur > br) { setBalance(interaction.user.id, bal + bet); result = `kazandın +${bet} 🪙`; }
    else if (ur < br) { setBalance(interaction.user.id, bal - bet); result = `kaybettin -${bet} 🪙`; }
    else result = 'berabere, para iade';
    await interaction.reply(`Sen: **${ur}** | Ben: **${br}** — ${result} | Bakiye: ${getBalance(interaction.user.id)} 🪙`);
    return;
  }

  if (cmd === 'tura') {
    const bet = parseBet(interaction.options.getString('miktar'), interaction.user.id);
    const choice = interaction.options.getString('seçim');
    if (!bet) { await interaction.reply(`geçersiz miktar. bakiyen: ${getBalance(interaction.user.id)} 🪙`); return; }
    const result = Math.random() < 0.5 ? 'yazı' : 'tura';
    const bal = getBalance(interaction.user.id);
    if (result === choice) {
      setBalance(interaction.user.id, bal + bet);
      await interaction.reply(`**${result}** — kazandın +${bet} 🪙 | Bakiye: ${getBalance(interaction.user.id)} 🪙`);
    } else {
      setBalance(interaction.user.id, bal - bet);
      await interaction.reply(`**${result}** — kaybettin -${bet} 🪙 | Bakiye: ${getBalance(interaction.user.id)} 🪙`);
    }
    return;
  }

  if (cmd === 'tkm') {
    const bet = parseBet(interaction.options.getString('miktar'), interaction.user.id);
    const choice = foldTR(interaction.options.getString('seçim'));
    if (!bet) { await interaction.reply(`geçersiz miktar. bakiyen: ${getBalance(interaction.user.id)} 🪙`); return; }
    const names = { tas: 'taş', kagit: 'kağıt', makas: 'makas' };
    const beats = { tas: 'makas', kagit: 'tas', makas: 'kagit' };
    const options = ['tas', 'kagit', 'makas'];
    const bot = options[Math.floor(Math.random() * 3)];
    const bal = getBalance(interaction.user.id);
    let result;
    if (choice === bot) result = 'berabere, para iade';
    else if (beats[choice] === bot) { setBalance(interaction.user.id, bal + bet); result = `kazandın +${bet} 🪙`; }
    else { setBalance(interaction.user.id, bal - bet); result = `kaybettin -${bet} 🪙`; }
    await interaction.reply(`Sen: **${names[choice] || choice}** | Ben: **${names[bot]}** — ${result} | Bakiye: ${getBalance(interaction.user.id)} 🪙`);
    return;
  }

  if (cmd === 'bj') {
    const bet = parseBet(interaction.options.getString('miktar'), interaction.user.id);
    if (!bet) { await interaction.reply(`geçersiz miktar. bakiyen: ${getBalance(interaction.user.id)} 🪙`); return; }
    const deck = bjDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];
    if (bjHandVal(playerHand) === 21) {
      bjDealerPlay({ dealerHand, deck });
      const result = bjResolve({ playerHand, dealerHand, bet, userId: interaction.user.id });
      await interaction.reply(`Sen: ${bjShowHand(playerHand)}\nDealer: ${bjShowHand(dealerHand)}\nBlackjack! ${result} | Bakiye: ${getBalance(interaction.user.id)} 🪙`);
      return;
    }
    bjGames.set(interaction.user.id, { deck, playerHand, dealerHand, bet, userId: interaction.user.id });
    await interaction.reply({ content: `Sen: ${bjShowHand(playerHand)}\nDealer: ${bjShowHand(dealerHand, true)}\nBahis: ${bet} 🪙`, components: [bjButtons()] });
    return;
  }

  if (cmd === 'slot') {
    const bet = parseBet(interaction.options.getString('miktar'), interaction.user.id);
    if (!bet) { await interaction.reply(`geçersiz miktar. bakiyen: ${getBalance(interaction.user.id)} 🪙`); return; }
    await interaction.deferReply();
    const symbols = [
      { e: '🍒', w: 30 }, { e: '🍋', w: 25 }, { e: '🍊', w: 20 },
      { e: '🍇', w: 15 }, { e: '🔔', w: 6 }, { e: '⭐', w: 3 },
      { e: '💎', w: 1 }, { e: '7️⃣', w: 1 },
    ];
    const totalW = symbols.reduce((s, x) => s + x.w, 0);
    function spin() {
      let r = Math.random() * totalW;
      for (const s of symbols) { r -= s.w; if (r <= 0) return s.e; }
      return symbols[0].e;
    }
    const reels = [spin(), spin(), spin()];
    const bal = getBalance(interaction.user.id);
    let resultType, delta, caption;
    if (reels[0] === reels[1] && reels[1] === reels[2]) {
      const mult = reels[0] === '💎' ? 20 : reels[0] === '7️⃣' ? 10 : reels[0] === '⭐' ? 5 : reels[0] === '🔔' ? 4 : 3;
      delta = bet * mult - bet;
      setBalance(interaction.user.id, bal + delta);
      resultType = 'triple';
      caption = `🎉 **Üçlü! x${mult}** — +${delta} 🪙 | Bakiye: ${getBalance(interaction.user.id)} 🪙`;
    } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
      delta = 0;
      resultType = 'pair';
      caption = `🤝 **İkili** — para iade | Bakiye: ${getBalance(interaction.user.id)} 🪙`;
    } else {
      delta = -bet;
      setBalance(interaction.user.id, bal - bet);
      resultType = 'loss';
      caption = `💸 **Kaybettin** — -${bet} 🪙 | Bakiye: ${getBalance(interaction.user.id)} 🪙`;
    }
    try {
      const gif = await generateSlotGif(reels, resultType, delta, getBalance(interaction.user.id));
      const att = new AttachmentBuilder(gif, { name: 'slot.gif' });
      await interaction.editReply({ content: caption, files: [att] });
    } catch (err) {
      console.error('[SLOT GIF]', err);
      await interaction.editReply(caption);
    }
    return;
  }

  if (cmd === 'tahmin') {
    const num = Math.floor(Math.random() * 100) + 1;
    guessGames.set(interaction.channelId, { number: num });
    await interaction.reply('1 ile 100 arasında bir sayı tuttum. Beni mention yaparak tahmin et!');
    return;
  }

  if (cmd === 'kelime') {
    const word = getStartWord();
    wordGames.set(interaction.channelId, { lastWord: word, requiredLetter: wordLastLetter(word), usedWords: new Set([word]), lastPlayerId: null });
    await interaction.reply(`kelime oyunu başladı! **${word}** — sıradaki kelime **'${wordLastLetter(word)}'** ile başlamalı`);
    return;
  }

  if (cmd === 'kelimeson') {
    if (wordGames.has(interaction.channelId)) wordGames.delete(interaction.channelId);
    await interaction.reply('kelime oyunu bitti');
    return;
  }

  // === CS2 ===
  if (cmd === 'kasalar') {
    const lines = Object.entries(CASES).map(([key, c]) => `**${c.name}** (\`/kasa ${key}\`) — ${c.cost} 🪙`);
    await interaction.reply(`**CS2 Kasaları:**\n${lines.join('\n')}\n\nNadirlik: ⬜ %79.9 | 🟦 %16.0 | 🟪 %3.2 | 🔵 %0.64 | 🩷 %0.26 | 🔴 %0.064 | 🟡 %0.026`);
    return;
  }

  if (cmd === 'kasa') {
    const key = interaction.options.getString('tip');
    const caseData = CASES[key];
    if (!caseData) { await interaction.reply('Bilinmeyen kasa.'); return; }
    const bal = getBalance(interaction.user.id);
    if (bal < caseData.cost) { await interaction.reply(`yetersiz bakiye! Bu kasa ${caseData.cost} 🪙. Bakiyen: ${bal} 🪙`); return; }
    setBalance(interaction.user.id, bal - caseData.cost);
    const rarity = rollRarity();
    const skinPool = caseData.skins[rarity];
    const skin = skinPool[Math.floor(Math.random() * skinPool.length)];
    const condition = rollCondition();
    const isStatTrak = ['milspec','restricted','classified','covert','knife'].includes(rarity) && Math.random() < 0.1;
    const stPrefix = isStatTrak ? 'StatTrak™ ' : '';
    const fullName = `${stPrefix}${skin} (${condition.short})`;
    const info = RARITY_INFO[rarity];
    const basePrice = SKIN_PRICES[skin];
    let coinReward;
    if (basePrice !== undefined) {
      const condMult = CONDITION_COIN_MULT[condition.short] ?? 0.28;
      coinReward = Math.max(info.coinMin, Math.round(basePrice * condMult * COIN_RATE));
    } else {
      coinReward = info.coinMin + Math.floor(Math.random() * (info.coinMax - info.coinMin + 1));
    }
    if (isStatTrak) coinReward = Math.floor(coinReward * 1.5);
    const savesToInventory = rarity !== 'consumer';
    setBalance(interaction.user.id, getBalance(interaction.user.id) + coinReward);
    if (savesToInventory) addToInventory(interaction.user.id, interaction.user.username, { name: fullName, rarity, case: caseData.name, date: new Date().toISOString() });
    const rarityLabel = `${info.color} ${info.label}`;
    const stNote = isStatTrak ? ' *(StatTrak™ +50%)*' : '';
    const inventoryNote = savesToInventory
      ? `\n📦 **Envantere eklendi!**${stNote} *(+${coinReward} 🪙 bonus)*`
      : `\n🪙 Çok yaygın, otomatik satıldı: **+${coinReward} 🪙**`;
    await interaction.reply(`🎰 **${caseData.name}** açıldı!\n\n${rarityLabel}\n🔫 **${fullName}**${inventoryNote}\n\nYeni bakiye: ${getBalance(interaction.user.id)} 🪙`);
    return;
  }

  if (cmd === 'envanter') {
    await interaction.deferReply();
    const targetUser = interaction.options.getUser('kişi') || interaction.user;
    const targetId = targetUser.id;
    const targetName = targetUser.username;
    const inv = inventory[targetId];
    if (!inv || inv.items.length === 0) {
      await interaction.editReply(targetId === interaction.user.id ? 'envanterin boş! kasa açarak nadir skinler kazanabilirsin.' : `**${targetName}** kullanıcısının envanteri boş.`);
      return;
    }
    const rarityOrder = ['knife','covert','classified','restricted','milspec','consumer'];
    const sorted = [...inv.items].sort((a, b) => rarityOrder.indexOf(a.rarity) - rarityOrder.indexOf(b.rarity));
    const lines = sorted.map((item, i) => `${i + 1}. ${RARITY_INFO[item.rarity]?.color || ''} ${item.name}`);
    const chunks = [];
    let chunk = [];
    for (const line of lines) {
      chunk.push(line);
      if (chunk.length === 15) { chunks.push(chunk.join('\n')); chunk = []; }
    }
    if (chunk.length) chunks.push(chunk.join('\n'));
    await interaction.editReply(`**${targetName}** envanteri (${sorted.length} item):\n${chunks[0]}`);
    for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);
    return;
  }

  if (cmd === 'sat') {
    const num = interaction.options.getInteger('numara');
    const inv = inventory[interaction.user.id];
    if (!inv || inv.items.length === 0) { await interaction.reply({ content: 'Envanterin boş.', flags: 64 }); return; }
    const rarityOrder = ['knife','covert','classified','restricted','milspec','consumer'];
    const sorted = [...inv.items].map((item, origIdx) => ({ item, origIdx }))
      .sort((a, b) => rarityOrder.indexOf(a.item.rarity) - rarityOrder.indexOf(b.item.rarity));
    if (num > sorted.length) { await interaction.reply({ content: `Geçersiz numara. Envanterin ${sorted.length} item içeriyor.`, flags: 64 }); return; }
    const { item, origIdx } = sorted[num - 1];
    const coins = calcItemPrice(item);
    inv.items.splice(origIdx, 1);
    saveInventory();
    setBalance(interaction.user.id, getBalance(interaction.user.id) + coins);
    const info = RARITY_INFO[item.rarity] || RARITY_INFO.milspec;
    await interaction.reply({ content: `${info.color} **${item.name}** satıldı: **+${coins} 🪙**\nYeni bakiye: ${getBalance(interaction.user.id)} 🪙`, flags: 64 });
    return;
  }

  if (cmd === 'takas') {
    const targetUser = interaction.options.getUser('kişi');
    const verNum = interaction.options.getInteger('ver');
    const alNum = interaction.options.getInteger('al') ?? null;

    if (targetUser.id === interaction.user.id) { await interaction.reply({ content: 'Kendine takas yapamazsın.', flags: 64 }); return; }
    if (targetUser.bot) { await interaction.reply({ content: 'Botlara takas yapamazsın.', flags: 64 }); return; }

    const senderInv = inventory[interaction.user.id];
    if (verNum > 0 && (!senderInv || senderInv.items.length === 0)) { await interaction.reply({ content: 'Envanterin boş.', flags: 64 }); return; }

    const rarityOrder = ['knife','covert','classified','restricted','milspec','consumer'];
    let senderSorted = [], targetSorted = [];
    if (verNum > 0) {
      senderSorted = [...(senderInv?.items || [])].map((item, origIdx) => ({ item, origIdx }))
        .sort((a, b) => rarityOrder.indexOf(a.item.rarity) - rarityOrder.indexOf(b.item.rarity));
      if (verNum > senderSorted.length) { await interaction.reply({ content: `Geçersiz numara. Envanterin ${senderSorted.length} item içeriyor.`, flags: 64 }); return; }
    }

    let targetOrigIdx = null;
    let targetItemDisplay = '_Karşılıksız transfer_';
    if (alNum !== null) {
      const targetInv = inventory[targetUser.id];
      if (!targetInv || targetInv.items.length === 0) { await interaction.reply({ content: `**${targetUser.username}** kullanıcısının envanteri boş.`, flags: 64 }); return; }
      targetSorted = [...targetInv.items].map((item, origIdx) => ({ item, origIdx }))
        .sort((a, b) => rarityOrder.indexOf(a.item.rarity) - rarityOrder.indexOf(b.item.rarity));
      if (alNum > targetSorted.length) { await interaction.reply({ content: `Geçersiz numara. **${targetUser.username}** kullanıcısının envanterinde ${targetSorted.length} item var.`, flags: 64 }); return; }
      targetOrigIdx = targetSorted[alNum - 1].origIdx;
      const ti = targetSorted[alNum - 1].item;
      const tiInfo = RARITY_INFO[ti.rarity] || RARITY_INFO.milspec;
      targetItemDisplay = `${tiInfo.color} **${ti.name}**`;
    }

    const senderOrigIdx = verNum > 0 ? senderSorted[verNum - 1].origIdx : null;
    let senderItemDisplay = '_Karşılıksız transfer_';
    if (verNum > 0) {
      const si = senderSorted[verNum - 1].item;
      const siInfo = RARITY_INFO[si.rarity] || RARITY_INFO.milspec;
      senderItemDisplay = `${siInfo.color} **${si.name}**`;
    }

    const tradeId = ++tradeIdCounter;
    const timeout = setTimeout(async () => {
      if (pendingTrades.has(tradeId)) {
        pendingTrades.delete(tradeId);
        try {
          const ch = interaction.channel;
          const msg = await ch.messages.fetch(pendingTrades.get(tradeId)?.msgId).catch(() => null);
          if (msg) await msg.edit({ content: '⏰ Takas teklifi süresi doldu.', components: [] });
        } catch {}
      }
    }, 60000);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`takas_accept_${tradeId}`).setLabel('✅ Kabul').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`takas_decline_${tradeId}`).setLabel('❌ Reddet').setStyle(ButtonStyle.Danger),
    );

    const content = [
      `**Takas Teklifi** — <@${targetUser.id}>, kabul ediyor musun? *(60 sn)*`,
      ``,
      `<@${interaction.user.id}> veriyor: ${senderItemDisplay}`,
      `<@${targetUser.id}> veriyor: ${targetItemDisplay}`,
    ].join('\n');

    const msg = await interaction.reply({ content, components: [row], fetchReply: true, allowedMentions: { users: [targetUser.id] } });
    pendingTrades.set(tradeId, {
      senderId: interaction.user.id,
      senderName: interaction.user.username,
      targetId: targetUser.id,
      senderIdx: senderOrigIdx,
      targetIdx: targetOrigIdx,
      msgId: msg.id,
      timeout,
    });
    return;
  }

  // === DİĞER ===
  if (cmd === 'ai') {
    await interaction.deferReply();
    const query = interaction.options.getString('mesaj') || 'naber';
    const recentHistory = await fetchRecentHistory(null, 8);
    const out = await askGemini(query, false, recentHistory) || randomSentence() || 'hmm';
    await interaction.editReply(out);
    return;
  }

  if (cmd === 'hafıza') {
    const usable = memory.filter(m => m.includes(': ') && m.length > 15 && m.length < 200);
    if (usable.length === 0) { await interaction.reply('henüz hafızam boş'); return; }
    const entry = usable[Math.floor(Math.random() * usable.length)];
    const colon = entry.indexOf(': ');
    const who = entry.slice(0, colon);
    const said = entry.slice(colon + 2);
    await interaction.reply(`bir zamanlar **${who}** şöyle demişti:\n> ${said}`);
    return;
  }

  if (cmd === 'gökhan') {
    await interaction.deferReply();
    const presence = await getRobloxPresence();
    if (!presence) { await interaction.editReply('Roblox durumu çekemedim.'); return; }
    if (!presence.online) { await interaction.editReply('offline.'); return; }
    if (presence.inGame) await interaction.editReply(`Gökhan yine Robloxta aq.\nOyun: ${presence.gameName || 'bilinmiyor'}`);
    else await interaction.editReply('Gökhan Studio\'da nabıyon aq.');
    return;
  }

  if (cmd === 'roblox') {
    await interaction.deferReply();
    const presence = await getRobloxPresence();
    if (!presence) { await interaction.editReply('bilgi alınamadı'); return; }
    if (!presence.online) { await interaction.editReply('şu an çevrimdışı'); return; }
    if (presence.inGame) await interaction.editReply(`oyunda: **${presence.gameName || 'bilinmiyor'}**`);
    else await interaction.editReply('çevrimiçi ama oyunda değil');
    return;
  }

  if (cmd === 'doğumgünü') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'ekle') {
      const raw = interaction.options.getString('tarih');
      const date = parseBirthday(raw);
      if (!date) { await interaction.reply({ content: 'Geçersiz tarih. Örnek: `12.05`', flags: 64 }); return; }
      const target = interaction.options.getUser('kişi') || interaction.user;
      birthdays[target.id] = {
        date,
        name: target.username,
        guildId: interaction.guildId,
      };
      saveBirthdays();
      const who = target.id === interaction.user.id ? 'Senin doğum günün' : `<@${target.id}> için doğum günü`;
      await interaction.reply({ content: `🎂 ${who} kaydedildi: **${formatBirthday(date)}**`, allowedMentions: { parse: [] } });
      return;
    }
    if (sub === 'sil') {
      const target = interaction.options.getUser('kişi') || interaction.user;
      if (birthdays[target.id]) {
        delete birthdays[target.id];
        saveBirthdays();
        await interaction.reply({ content: 'Doğum günü silindi.', flags: 64 });
      } else {
        await interaction.reply({ content: 'Kayıtlı doğum günü yok.', flags: 64 });
      }
      return;
    }
    if (sub === 'liste') {
      const now = trDayMonth(0);
      const [todayDay, todayMonth] = now.key.split("-").map(Number);
      const list = Object.entries(birthdays)
        .sort((a, b) => {
          const [ad, am] = a[1].date.split("-").map(Number);
          const [bd, bm] = b[1].date.split("-").map(Number);
          return am !== bm ? am - bm : ad - bd;
        })
        .map(([uid, b]) => {
          const [d, m] = b.date.split("-").map(Number);
          const upcoming = m === todayMonth && d >= todayDay;
          const label = `${formatBirthdayLong(b.date)} — <@${uid}>`;
          return `• ${upcoming ? `**${label}**` : label}`;
        });
      if (list.length === 0) { await interaction.reply('Henüz kayıtlı doğum günü yok.'); return; }
      await interaction.reply({ content: `🎂 **Doğum Günleri**\n${list.join('\n')}`, allowedMentions: { parse: [] } });
      return;
    }
    return;
  }

  if (cmd === 'ayar') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'Bu komut için "Sunucuyu Yönet" yetkisi gerekir.', flags: 64 });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'sohbet' || sub === 'seed') {
      const channel = interaction.options.getChannel('kanal');
      if (!channel?.isTextBased?.()) { await interaction.reply({ content: 'Metin kanalı seç.', flags: 64 }); return; }
      if (!guildConfig[interaction.guildId]) guildConfig[interaction.guildId] = {};
      if (sub === 'sohbet') guildConfig[interaction.guildId].sohbetChannelId = channel.id;
      else guildConfig[interaction.guildId].seedChannelId = channel.id;
      saveGuildConfig();
      await interaction.reply({ content: `✅ ${sub === 'sohbet' ? 'Sohbet/kutlama' : 'Öğrenme (seed)'} kanalı <#${channel.id}> olarak ayarlandı.`, flags: 64 });
      return;
    }
    if (sub === 'göster') {
      const cfg = guildConfig[interaction.guildId] || {};
      const sohbet = cfg.sohbetChannelId ? `<#${cfg.sohbetChannelId}>` : '_ayarlanmamış_';
      const seed = cfg.seedChannelId ? `<#${cfg.seedChannelId}>` : '_ayarlanmamış_';
      await interaction.reply({ content: `**Sunucu Ayarları**\nSohbet/kutlama: ${sohbet}\nÖğrenme (seed): ${seed}`, flags: 64 });
      return;
    }
    return;
  }

  if (cmd === 'çark') {
    const raw = interaction.options.getString('seçenekler');
    const options = raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    if (options.length < 2) { await interaction.reply({ content: 'En az 2 seçenek gir. Virgülle ayır: `Pizza, Burger, Sushi`', flags: 64 }); return; }
    if (options.length > 20) { await interaction.reply({ content: 'En fazla 20 seçenek girebilirsin.', flags: 64 }); return; }
    await interaction.deferReply();
    const winnerIdx = Math.floor(Math.random() * options.length);
    const gif = await generateWheelGif(options, winnerIdx);
    const attachment = new AttachmentBuilder(gif, { name: 'cark.gif' });
    await interaction.editReply({ content: `🎡 **${options[winnerIdx]}** seçildi!`, files: [attachment] });
    return;
  }

  if (cmd === 'seed-yenile') {
    if (seedState.running) {
      await interaction.reply({ content: `⏳ Seed zaten çalışıyor (${seedState.collected} mesaj toplandı).`, flags: 64 });
      return;
    }
    await interaction.reply({ content: `🔄 Seed başlatıldı — kanallar: **${[...seedChannelIds].join(', ')}**\nBu işlem birkaç dakika sürebilir.`, flags: 64 });
    runSeed();
    return;
  }

  if (cmd === 'roller') {
    const sub = interaction.options.getSubcommand();

    // Mesaj ID veya başlık adına göre menü bul
    function findMenu(input) {
      const guildId = interaction.guildId;
      if (roleMenus[input]?.guildId === guildId) return [input, roleMenus[input]];
      const lower = input.toLowerCase();
      const found = Object.entries(roleMenus).find(([, m]) => m.guildId === guildId && m.title.toLowerCase() === lower);
      return found || [null, null];
    }

    if (sub === 'oluştur') {
      const title = interaction.options.getString('başlık');
      const msg = await interaction.channel.send(`**Role Menu: ${title}**\nReact to give yourself a role.\n\n_Henüz rol eklenmedi. \`/roller ekle\` ile ekleyin._`);
      roleMenus[msg.id] = { guildId: interaction.guildId, channelId: interaction.channelId, title, roles: [] };
      saveRoleMenus();
      await interaction.reply({ content: `Rol menüsü oluşturuldu!\nEklemek için: \`/roller ekle mesaj:${title} emoji:🎮 rol:@RolAdı\``, flags: 64 });
      return;
    }
    if (sub === 'ekle') {
      const input = interaction.options.getString('mesaj');
      const emoji = interaction.options.getString('emoji').trim();
      const role = interaction.options.getRole('rol');
      const [msgId, menu] = findMenu(input);
      if (!menu) { await interaction.reply({ content: 'Rol menüsü bulunamadı. Başlık adını veya mesaj ID\'sini kontrol et.', flags: 64 }); return; }
      if (menu.roles.some(r => r.emoji === emoji)) {
        await interaction.reply({ content: 'Bu emoji zaten menüde var.', flags: 64 }); return;
      }
      menu.roles.push({ emoji, roleId: role.id, roleName: role.name });
      try {
        const ch = await client.channels.fetch(menu.channelId);
        const msg = await ch.messages.fetch(msgId);
        await msg.edit(buildRoleMenuContent(menu.title, menu.roles));
        await msg.react(emoji);
      } catch (e) {
        await interaction.reply({ content: `Mesaj güncellenemedi: ${e.message}`, flags: 64 }); return;
      }
      saveRoleMenus();
      await interaction.reply({ content: `${emoji} → **${role.name}** eklendi.`, flags: 64 });
      return;
    }
    if (sub === 'çıkar') {
      const input = interaction.options.getString('mesaj');
      const emoji = interaction.options.getString('emoji').trim();
      const [msgId, menu] = findMenu(input);
      if (!menu) { await interaction.reply({ content: 'Rol menüsü bulunamadı.', flags: 64 }); return; }
      const before = menu.roles.length;
      menu.roles = menu.roles.filter(r => r.emoji !== emoji);
      if (menu.roles.length === before) {
        await interaction.reply({ content: 'Bu emoji menüde yok.', flags: 64 }); return;
      }
      try {
        const ch = await client.channels.fetch(menu.channelId);
        const msg = await ch.messages.fetch(msgId);
        const content = menu.roles.length > 0 ? buildRoleMenuContent(menu.title, menu.roles) : `**Role Menu: ${menu.title}**\nReact to give yourself a role.\n\n_Henüz rol eklenmedi._`;
        await msg.edit(content);
      } catch {}
      saveRoleMenus();
      await interaction.reply({ content: `${emoji} menüden çıkarıldı.`, flags: 64 });
      return;
    }
    if (sub === 'sil') {
      const input = interaction.options.getString('mesaj');
      const [msgId, menu] = findMenu(input);
      if (!menu) { await interaction.reply({ content: 'Rol menüsü bulunamadı.', flags: 64 }); return; }
      try {
        const ch = await client.channels.fetch(menu.channelId);
        const msg = await ch.messages.fetch(msgId);
        await msg.delete();
      } catch {}
      delete roleMenus[msgId];
      saveRoleMenus();
      await interaction.reply({ content: 'Rol menüsü silindi.', flags: 64 });
      return;
    }
    return;
  }

  if (cmd === 'yardım') {
    await interaction.reply([
      '**komutlar:**',
      '`/ai` — yapay zeka',
      '`/bakiye` / `/bonus` — para',
      '`/zar` / `/tura` / `/tkm` / `/bj` / `/slot` — oyunlar',
      '`/ver` / `/sıralama` — ekonomi',
      '`/çal` / `/dur` / `/devam` / `/atla` / `/kuyruk` / `/çık` — müzik',
      '`/kelime` / `/kelimeson` / `/tahmin` — sözel oyunlar',
      '`/doğumgünü` — doğum günü ekle/sil/liste',
      '`/kasalar` / `/kasa` / `/envanter` / `/sat` / `/takas` — CS2',
      '`/hafıza` / `/gökhan` / `/roblox` — diğer',
      '`/ayar` — sohbet/seed kanalı ayarla (yönetici)',
      '`/roller` — reaction rol menüsü oluştur/yönet (yönetici)',
    ].join('\n'));
    return;
  }
});

/* =========================
   REACTION ROLE
========================= */
async function handleReactionRole(reaction, user, add) {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  const menu = roleMenus[reaction.message.id];
  if (!menu) return;
  const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
  const entry = menu.roles.find(r => r.emoji === emoji);
  if (!entry) return;
  try {
    const guild = await client.guilds.fetch(menu.guildId);
    const member = await guild.members.fetch(user.id);
    if (add) await member.roles.add(entry.roleId);
    else await member.roles.remove(entry.roleId);
  } catch {}
}

client.on('messageReactionAdd', (reaction, user) => handleReactionRole(reaction, user, true));
client.on('messageReactionRemove', (reaction, user) => handleReactionRole(reaction, user, false));

/* =========================
   MESAJ İŞLEYİCİ
========================= */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const isDM = !message.guild;
  const content = message.content.trim();
  const lower = content.toLowerCase();

  if (isDM && !lower.startsWith("*")) {
    console.log(`DM from admin: ${content}`);
    const targetChannel = await client.channels.fetch(SEED_CHANNEL_ID);
    if (targetChannel?.isTextBased()) {
      let text = content;
      const mentions = [...content.matchAll(/@([^\s@#]+)/g)];
      for (const m of mentions) {
        try {
          const results = await targetChannel.guild.members.fetch({ query: m[1], limit: 5 });
          const match = results.find(mb =>
            mb.user.username.toLowerCase() === m[1].toLowerCase() ||
            mb.displayName.toLowerCase() === m[1].toLowerCase()
          ) || results.first();
          if (match) text = text.replace(m[0], `<@${match.id}>`);
        } catch { }
      }
      await targetChannel.send(text);
    }
    return;
  }

  if (message.author.id === ADMIN_USER_ID || isDM) {
    if (lower === "*reaction on") {
      reactionsEnabled = true;
      await message.reply("reaction açıldı");
      return;
    }
    if (lower === "*reaction off") {
      reactionsEnabled = false;
      await message.reply("reaction kapatıldı");
      return;
    }
    if (lower === "*reaction status") {
      await message.reply(`reaction: ${reactionsEnabled ? "açık" : "kapalı"}`);
      return;
    }
    if (lower === "*seed status") {
      const s = seedState;
      const lines = [
        `durum: ${s.running ? "çalışıyor" : s.done ? "tamamlandı" : "başlamadı"}`,
        `toplanan: ${s.collected}`,
        `fetch: ${s.fetchCount}`,
        s.error ? `hata: ${s.error}` : null,
        s.startedAt ? `süre: ${formatDuration(Date.now() - s.startedAt)}` : null,
      ].filter(Boolean);
      await message.reply(lines.join("\n"));
      return;
    }
    if (lower === "*gemini test") {
      const out = await askGemini("Merhaba, nasılsın?", false);
      await message.reply(out ? `Gemini: ${out}` : "Gemini yanıt vermedi (key kontrol et)");
      return;
    }
    if (lower === "*bday test") {
      const today = trDayMonth(0);
      const tomorrow = trDayMonth(1);
      const entries = Object.entries(birthdays);
      const tomorrowPeople = entries.filter(([, b]) => b.date === tomorrow.key);
      const todayPeople = entries.filter(([, b]) => b.date === today.key);
      const remKey = tomorrowPeople.map(([uid]) => `${uid}-${tomorrow.year}`);
      const celKey = todayPeople.map(([uid]) => `${uid}-${today.year}`);
      await message.reply(
        `📅 Bugün: ${today.key} | Yarın: ${tomorrow.key}\n` +
        `Toplam kayıt: ${entries.length}\n` +
        `Yarın doğum günü: ${tomorrowPeople.map(([, b]) => b.name).join(', ') || 'yok'}\n` +
        `Reminder gönderildi mi: ${remKey.map(k => `${k}=${!!sentReminders[k]}`).join(', ') || '-'}\n` +
        `Bugün doğum günü: ${todayPeople.map(([, b]) => b.name).join(', ') || 'yok'}\n` +
        `Kutlama gönderildi mi: ${celKey.map(k => `${k}=${!!sentCelebrations[k]}`).join(', ') || '-'}`
      );
      return;
    }
    if (lower === "*bday run") {
      sentReminders = {};
      sentCelebrations = {};
      await message.reply("sentReminders/Celebrations sıfırlandı, checkBirthdays çalıştırılıyor...");
      await checkBirthdays();
      await message.reply("checkBirthdays tamamlandı.");
      return;
    }
    if (lower === "*kick test") {
      const ENDPOINTS = [
        `https://kick.com/api/v2/channels/${KICK_CHANNEL_SLUG}`,
        `https://kick.com/api/internal/v2/channels/${KICK_CHANNEL_SLUG}`,
        `https://kick.com/api/v1/channels/${KICK_CHANNEL_SLUG}`,
      ];
      const HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://kick.com/",
      };
      const results = [];
      for (const url of ENDPOINTS) {
        try {
          const r = await fetchWithTimeout(url, { headers: HEADERS }, 8000);
          const ct = r.headers.get("content-type") || "";
          if (!r.ok) { results.push(`❌ ${url.split('/').slice(-2).join('/')} → ${r.status}`); continue; }
          if (!ct.includes("json")) { results.push(`⚠️ ${url.split('/').slice(-2).join('/')} → JSON değil`); continue; }
          const data = await r.json();
          const isLive = !!(data.livestream || data.is_live || data.channel?.is_live);
          results.push(`✅ ${url.split('/').slice(-2).join('/')} → ${isLive ? '🔴 CANLI' : '⚫ offline'}`);
        } catch (e) {
          results.push(`❌ ${url.split('/').slice(-2).join('/')} → ${e.message?.slice(0, 40)}`);
        }
      }
      results.push(`kickWasLive: ${kickWasLive}`);
      await message.reply(results.join('\n'));
      return;
    }
    if (lower === "*redis test") {
      if (!UPSTASH_URL) { await message.reply("UPSTASH_REDIS_REST_URL env var eksik"); return; }
      try {
        await redisSet("ping", { ts: Date.now() });
        const result = await redisGet("ping");
        await message.reply(result ? `Redis bağlantısı OK ✅\n${balances.size} kullanıcı bakiyede, ${Object.keys(inventory).length} envanter kaydı` : "Redis set OK ama get null döndü ❌");
      } catch (e) {
        await message.reply(`Redis hatası ❌: ${e.message}`);
      }
      return;
    }
  }

  if (seedChannelIds.has(message.channel.id) && content.length > 0) {
    if (!containsReligiousAbuse(content)) {
      const username = message.author.username || "biri";
      const entry = `${username}: ${content}`;
      const last = memory[memory.length - 1];
      const lastTs = memory._lastTs || 0;
      const now = Date.now();
      const sameUserRecent = last && last.startsWith(username + ": ") && (now - lastTs) < 5 * 60 * 1000;
      if (sameUserRecent) {
        memory[memory.length - 1] = last + " " + content;
        memorySet.add(normalizeText(memory[memory.length - 1]));
        memory._lastTs = now;
      } else {
        memory.push(entry);
        memorySet.add(normalizeText(entry));
        memory._lastTs = now;
        if (memory.length > MAX_MEMORY_MESSAGES) {
          const removed = memory.shift();
          memorySet.delete(normalizeText(removed));
        }
      }
      saveSeedMemory();
    }
  }

  if (wordGames.has(message.channelId) && !message.mentions.has(client.user)) {
    const game = wordGames.get(message.channelId);
    const word = turkishLower(content.trim());
    if (isWordOnly(word)) {
      if (message.author.id === game.lastPlayerId) {
        await message.react("🚫");
        await message.reply("aynı kişi üst üste oynayamaz!");
        return;
      }
      if (game.usedWords.has(word)) {
        await message.react("❌");
        await message.reply(`**${word}** zaten kullanıldı!`);
      } else if (word[0] !== game.requiredLetter) {
        await message.react("❌");
        await message.reply(`kelime **'${game.requiredLetter}'** harfiyle başlamalı! ('${word}' geçersiz)`);
      } else if (wordLastLetter(word) === "ğ") {
        await message.react("❌");
        await message.reply("ğ ile biten kelime kabul edilmez, çıkmaz sokak!");
      } else {
        const valid = await isTurkishWord(word);
        if (!valid) {
          await message.react("❌");
          await message.reply(`**${word}** TDK'da bulunamadı!`);
        } else {
          game.usedWords.add(word);
          game.lastWord = word;
          game.requiredLetter = wordLastLetter(word);
          game.lastPlayerId = message.author.id;
          await message.react("✅");
        }
      }
      return;
    }
  }

  if (message.mentions.has(client.user) && Math.random() < MENTION_RESPONSE_CHANCE) {
    if (await handleGuessGame(message, content)) return;
    const choiceAnswer = handleSimpleChoiceQuestion(content);
    if (choiceAnswer) { await message.reply(choiceAnswer); return; }
    const out = generateMarkov() || randomSentence();
    if (out) { await message.reply(out); return; }
    return;
  }

  let isReplyToBot = false;
  if (message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (refMsg.author.id === client.user.id) isReplyToBot = true;
    } catch {}
  }
  // Sunucu başına counter
  const guildId = message.guildId;
  if (!guildCounters.has(guildId)) guildCounters.set(guildId, { count: 0, target: Math.floor(Math.random() * 31) + 20 });
  const gc = guildCounters.get(guildId);
  let shouldRespond = false;
  gc.count++;
  if (gc.count >= gc.target) {
    gc.count = 0;
    gc.target = Math.floor(Math.random() * 31) + 20;
    shouldRespond = true;
  }

  // Bot'a reply → Markov
  if (isReplyToBot) {
    const markov = generateMarkov();
    if (markov && !botRecentSet.has(markov)) {
      botRecentSet.add(markov);
      if (botRecentSet.size > BOT_RECENT_LIMIT) botRecentSet.delete(botRecentSet.values().next().value);
      await message.reply(markov);
    }
    return;
  }

  // Counter tetiklendi → tüm seed'den Markov
  if (shouldRespond) {
    const markov = generateMarkov();
    if (markov && markov.split(" ").length >= 3 && !botRecentSet.has(markov)) {
      botRecentSet.add(markov);
      if (botRecentSet.size > BOT_RECENT_LIMIT) botRecentSet.delete(botRecentSet.values().next().value);
      await message.channel.send(markov);
    }
  }

  if (reactionsEnabled && message.author.id === TARGET_USER_ID) {
    try {
      await message.react(EMOJI_1);
      await message.react(EMOJI_2);
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
