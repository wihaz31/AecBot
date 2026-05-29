require("dotenv").config();

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const playdl = require("play-dl");
const { execFile, spawn } = require("child_process");

/* =========================
   AYARLAR
========================= */
const SEED_CHANNEL_ID = "705537838770421761";

const SEED_DAYS = 1500;
const SEED_MAX = 150000;

const MAX_MEMORY_MESSAGES = 40000;
const RECENT_EXCLUDE = 100;

let messageCounter = 0;
let nextMessageTarget = Math.floor(Math.random() * 31) + 20;

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
const markovChain = new Map();
const markovStarts = [];
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

    if (words.length < 2) continue;

    words.forEach((w) => {
      if (w.length >= 3 && /^[a-zğüşıöç]+$/.test(w)) allWords.add(w);
    });

    markovStarts.push(words[0]);

    for (let i = 0; i < words.length - 1; i++) {
      const key = words[i];
      if (!markovChain.has(key)) markovChain.set(key, []);
      markovChain.get(key).push(words[i + 1]);
    }
  }

  wordPool = Array.from(allWords);
  console.log(`[MARKOV] Model hazır: ${markovChain.size} bigram, ${markovStarts.length} başlangıç, ${wordPool.length} kelime`);
}

function randomWord() {
  return wordPool[Math.floor(Math.random() * wordPool.length)];
}

function generateMarkov(startWord = null) {
  if (markovStarts.length === 0) return null;

  const start = startWord || markovStarts[Math.floor(Math.random() * markovStarts.length)];

  const targetLen = Math.random() < 0.4
    ? Math.floor(Math.random() * 3) + 3
    : Math.floor(Math.random() * 7) + 4;

  const result = [start];
  let current = start;

  for (let i = 1; i < targetLen; i++) {
    if (Math.random() < 0.35 || !markovChain.has(current)) {
      const rnd = randomWord();
      if (rnd) {
        result.push(rnd);
        current = rnd;
      } else break;
    } else {
      const nexts = markovChain.get(current);
      const next = nexts[Math.floor(Math.random() * nexts.length)];
      result.push(next);
      current = next;
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
   MÜZİK
========================= */
const musicQueues = new Map();

const YT_COOKIE_FILE = "/tmp/yt-cookies.txt";
if (process.env.YOUTUBE_COOKIE) {
  try {
    let content = process.env.YOUTUBE_COOKIE.replace(/\\n/g, "\n");
    if (!content.includes("\n")) {
      // Koyeb env var satır sonlarını boşluğa çevirmiş — düzelt
      const entries = content.split(/ (?=\.youtube\.com\t)/);
      content = "# Netscape HTTP Cookie File\n" + entries.join("\n");
    }
    fs.writeFileSync(YT_COOKIE_FILE, content);
  } catch {}
}
function ytdlpCookieArgs() {
  return process.env.YOUTUBE_COOKIE ? ["--cookies", YT_COOKIE_FILE] : [];
}

function ytdlpGetInfo(url) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const args = ["--no-playlist", "--print", "%(title)s", "--no-warnings", "--socket-timeout", "20", ...ytdlpCookieArgs(), url];
    const proc = spawn("yt-dlp", args);
    let stdout = "";
    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; });
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(stderr.slice(0, 200) || "yt-dlp hata kodu: " + code));
      resolve(stdout.trim());
    });
    proc.on("error", reject);
    setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 30000);
  });
}

function ytdlpSearch(query) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const args = ["--no-playlist", "--print", "%(title)s", "--print", "%(webpage_url)s", "--no-warnings", "--socket-timeout", "20", ...ytdlpCookieArgs(), `ytsearch1:${query}`];
    const proc = spawn("yt-dlp", args);
    let stdout = "";
    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; });
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(stderr.slice(0, 200) || "yt-dlp hata kodu: " + code));
      const lines = stdout.trim().split("\n");
      if (lines.length < 2) return reject(new Error("Sonuç bulunamadı"));
      resolve({ title: lines[0], url: lines[1] });
    });
    proc.on("error", reject);
    setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 30000);
  });
}

function ytdlpCreateResource(url) {
  const ytdlp = spawn("yt-dlp", ["-f", "bestaudio[ext=webm]/bestaudio/best", "-o", "-", "--quiet", "--no-playlist", ...ytdlpCookieArgs(), url]);
  const ffmpeg = spawn("ffmpeg", ["-i", "pipe:0", "-vn", "-f", "ogg", "-acodec", "libopus", "-ar", "48000", "-ac", "2", "-loglevel", "error", "pipe:1"]);
  ytdlp.stdout.pipe(ffmpeg.stdin);
  ytdlp.stderr.on("data", () => {});
  ffmpeg.stderr.on("data", () => {});
  ytdlp.on("error", () => ffmpeg.kill());
  return createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
}

async function playNext(guildId) {
  const state = musicQueues.get(guildId);
  if (!state) return;
  if (state.queue.length === 0) {
    state.current = null;
    try { state.connection.destroy(); } catch {}
    musicQueues.delete(guildId);
    return;
  }
  const song = state.queue.shift();
  state.current = song;
  try {
    const resource = ytdlpCreateResource(song.url);
    state.player.play(resource);
    if (state.textChannel) await state.textChannel.send(`▶️ Şimdi çalıyor: **${song.title}**`);
  } catch {
    if (state.textChannel) await state.textChannel.send("❌ Çalarken hata oluştu, atlanıyor...");
    playNext(guildId);
  }
}

/* =========================
   KİCK BİLDİRİMİ
========================= */
let kickWasLive = false;

async function checkKick() {
  try {
    const r = await fetchWithTimeout(
      `https://kick.com/api/v2/channels/${KICK_CHANNEL_SLUG}`,
      { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } },
      8000
    );
    if (!r.ok) return;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("json")) return;
    const data = await r.json();
    const isLive = !!data.livestream;
    if (isLive && !kickWasLive) {
      kickWasLive = true;
      try {
        const ch = await client.channels.fetch(KICK_NOTIFY_CHANNEL_ID);
        if (ch?.isTextBased()) {
          await ch.send(`🔴 **Dünya çapında ADC Berkay Zeitnot Aşıkuzun şimdi yayında!**\nhttps://kick.com/${KICK_CHANNEL_SLUG}`);
        }
      } catch {}
    } else if (!isLive) {
      kickWasLive = false;
    }
  } catch {}
}

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
    if (!r.ok) return null;
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;
    const cleaned = text.replace(/[*_`~|]/g, "").trim();
    if (containsReligiousAbuse(cleaned)) return null;
    if (!cleaned) return null;
    return cleaned;
  } catch {
    return null;
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
  setInterval(checkKick, 2 * 60 * 1000);
  checkKick();
  const playdlToken = {};
  if (process.env.YOUTUBE_COOKIE) {
    playdlToken.youtube = { cookie: process.env.YOUTUBE_COOKIE };
  }
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    playdlToken.spotify = {
      client_id: process.env.SPOTIFY_CLIENT_ID,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET,
      refresh_token: "",
      access_token: "",
    };
  }
  if (Object.keys(playdlToken).length > 0) {
    try {
      await playdl.setToken(playdlToken);
      console.log("[MÜZİK] play-dl token ayarlandı:", Object.keys(playdlToken).join(", "));
    } catch { console.log("[MÜZİK] play-dl token ayarlanamadı"); }
  }

  const [savedEconomy, savedInventory] = await Promise.all([
    redisGet("economy"),
    redisGet("inventory"),
  ]);
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

  try {
    const channel = await client.channels.fetch(SEED_CHANNEL_ID);
    if (channel?.isTextBased()) {
      console.log(`[SEED] ${channel.name} kanalından mesajlar yükleniyor...`);
      let lastId = null;
      let fetched = 0;
      const rawMessages = [];

      seedState.running = true;
      seedState.channelName = channel.name;
      seedState.startedAt = Date.now();

      const cutoff = Date.now() - SEED_DAYS * 24 * 60 * 60 * 1000;

      while (fetched < SEED_MAX) {
        const opts = { limit: 100 };
        if (lastId) opts.before = lastId;
        let msgs;
        try {
          msgs = await channel.messages.fetch(opts);
        } catch (e) {
          seedState.error = e.message;
          break;
        }
        if (msgs.size === 0) break;
        let tooOld = false;
        for (const m of msgs.values()) {
          if (m.createdTimestamp < cutoff) { tooOld = true; break; }
          if (!m.author.bot && m.content.length > 0 && m.content.length <= MAX_WORDS_PER_MESSAGE * 8) {
            const txt = m.content.trim();
            if (!containsReligiousAbuse(txt)) {
              rawMessages.push(txt);
              const entry = `${m.author.username}: ${txt}`;
              if (!memorySet.has(normalizeText(entry))) {
                memory.push(entry);
                memorySet.add(normalizeText(entry));
              }
            }
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

      buildMarkov(rawMessages);
      if (memory.length > MAX_MEMORY_MESSAGES) memory.splice(0, memory.length - MAX_MEMORY_MESSAGES);
      uploadMemoryToGemini();
      seedState.running = false;
      seedState.done = true;
      console.log(`[SEED] Tamamlandı: ${rawMessages.length} mesaj, ${memory.length} hafıza`);
    }
  } catch (e) {
    seedState.running = false;
    seedState.error = e.message;
    console.error("[SEED] Hata:", e.message);
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
      markovBigrams: markovChain.size,
      wordPoolSize: wordPool.length,
      seed: seedState,
    }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
}).listen(PORT, () => console.log(`[HTTP] Port ${PORT}`));

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
    if (isDM && !lower.startsWith("*")) {
      console.log(`DM from admin: ${content}`);
      const targetChannel = await client.channels.fetch(SEED_CHANNEL_ID);
      if (targetChannel?.isTextBased()) await targetChannel.send(content);
      return;
    }
  }

  if (lower === "*yardim" || lower === "*yardım" || lower === "*help") {
    await message.reply([
      "**komutlar:**",
      "`*ai [mesaj]` — yapay zeka",
      "`*bakiye` / `*para` — para bakiyesi",
      "`*bonus` — günlük 500 🪙",
      "`*zar [miktar]` — zar bahsi",
      "`*tura [miktar] yazı/tura` — yazı tura",
      "`*tkm` / `*rps [miktar] taş/kağıt/makas` — taş kağıt makas",
      "`*bj [miktar]` — blackjack (⬆️ kart • 🛑 dur)",
      "`*ver @kişi [miktar]` — para gönder",
      "`*çal [şarkı adı / YouTube URL / Spotify URL]` — müzik çal",
      "`*dur` / `*devam` / `*atla` / `*kuyruk` / `*çık` — müzik kontrol",
      "`*kelime` — kelime oyunu başlat",
      "`*kelimeson` — kelime oyunu bitir",
      "`*slot [miktar]` — slot makinesi",
      "`*hafıza` — eski bir mesajı hatırla",
      "`*kasalar` — CS2 kasalarını listele",
      "`*kasa [recoil|revolution|kilowatt|gamma2|dreams|chroma|cobblestone]` — kasa aç",
      "`*envanter [@kişi]` — CS2 envanteri",
      "`*gökhan`",
    ].join("\n"));
    return;
  }

  if (lower.startsWith("*çal ") || lower.startsWith("*cal ")) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) { await message.reply("Bir ses kanalında olman gerekiyor!"); return; }
    const query = content.slice(content.indexOf(" ") + 1).trim();
    if (!query) { await message.reply("Kullanım: `*çal [şarkı adı / YouTube URL / Spotify URL]`"); return; }
    let song;
    try {
      const urlType = await playdl.validate(query);
      if (urlType === "yt_video") {
        const title = await ytdlpGetInfo(query);
        song = { url: query, title: title || query };
      } else if (urlType === "sp_track") {
        const spData = await playdl.spotify(query);
        const searchQ = `${spData.name} ${spData.artists?.[0]?.name || ""}`.trim();
        const result = await ytdlpSearch(searchQ);
        song = { url: result.url, title: `${spData.name}${spData.artists?.[0]?.name ? " - " + spData.artists[0].name : ""}` };
      } else {
        const result = await ytdlpSearch(query);
        song = result;
      }
    } catch (e) {
      const msg = e?.message || "";
      if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("spawn")) {
        await message.reply("❌ yt-dlp kurulu değil, sunucuyu yeniden başlat.");
      } else {
        await message.reply(`❌ Şarkı bulunamadı: ${msg.slice(0, 100)}`);
      }
      return;
    }
    if (!musicQueues.has(message.guildId)) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      const player = createAudioPlayer();
      connection.subscribe(player);
      player.on(AudioPlayerStatus.Idle, () => playNext(message.guildId));
      musicQueues.set(message.guildId, { connection, player, queue: [], current: null, textChannel: message.channel });
    }
    const state = musicQueues.get(message.guildId);
    state.queue.push(song);
    if (!state.current) {
      playNext(message.guildId);
    } else {
      await message.reply(`➕ Kuyruğa eklendi: **${song.title}**`);
    }
    return;
  }

  if (lower === "*dur") {
    const state = musicQueues.get(message.guildId);
    if (!state?.current) { await message.reply("Şu an çalan bir şey yok."); return; }
    state.player.pause();
    await message.reply("⏸️ Duraklatldı.");
    return;
  }

  if (lower === "*devam") {
    const state = musicQueues.get(message.guildId);
    if (!state) { await message.reply("Şu an çalan bir şey yok."); return; }
    state.player.unpause();
    await message.reply("▶️ Devam ediyor.");
    return;
  }

  if (lower === "*atla") {
    const state = musicQueues.get(message.guildId);
    if (!state?.current) { await message.reply("Atlanacak bir şey yok."); return; }
    state.player.stop();
    await message.reply("⏭️ Atlandı.");
    return;
  }

  if (lower === "*kuyruk") {
    const state = musicQueues.get(message.guildId);
    if (!state?.current) { await message.reply("Kuyruk boş."); return; }
    const lines = [`▶️ **${state.current.title}** (çalıyor)`];
    state.queue.forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
    await message.reply(lines.join("\n"));
    return;
  }

  if (lower === "*çık" || lower === "*cik") {
    const state = musicQueues.get(message.guildId);
    if (!state) { await message.reply("Ses kanalında değilim."); return; }
    state.queue = [];
    state.player.stop();
    try { state.connection.destroy(); } catch {}
    musicQueues.delete(message.guildId);
    await message.reply("👋 Ses kanalından çıkıldı.");
    return;
  }

  if (lower === "*gökhan" || lower === "*gokhan") {
    const presence = await getRobloxPresence();
    if (!presence) { await message.reply("Roblox durumu çekemedim."); return; }
    if (!presence.online) { await message.reply("offline."); return; }
    if (presence.inGame) {
      await message.reply(`Gökhan yine Robloxta aq.\nOyun: ${presence.gameName || "bilinmiyor"}`);
    } else {
      await message.reply("Gökhan Studio'da nabıyon aq.");
    }
    return;
  }

  if (lower === "*bakiye" || lower === "*para") {
    await message.reply(`bakiyen: **${getBalance(message.author.id)}** 🪙`);
    return;
  }

  if (lower === "*bonus") {
    const now = Date.now();
    const last = lastBonus.get(message.author.id) || 0;
    if (now - last < BONUS_COOLDOWN) {
      const kalan = BONUS_COOLDOWN - (now - last);
      await message.reply(`bonus zaten alındı. kalan: ${formatDuration(kalan)}`);
      return;
    }
    lastBonus.set(message.author.id, now);
    setBalance(message.author.id, getBalance(message.author.id) + BONUS_AMOUNT);
    await message.reply(`günlük bonus +${BONUS_AMOUNT} 🪙 | Bakiye: ${getBalance(message.author.id)} 🪙`);
    return;
  }

  if (lower.startsWith("*bj")) {
    const parts = content.split(/\s+/);
    const bet = parseBet(parts[1], message.author.id);
    if (!bet) { await message.reply(`geçersiz miktar. bakiyen: ${getBalance(message.author.id)} 🪙`); return; }
    const deck = bjDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];
    if (bjHandVal(playerHand) === 21) {
      bjDealerPlay({ dealerHand, deck });
      const result = bjResolve({ playerHand, dealerHand, bet, userId: message.author.id });
      await message.reply(`Sen: ${bjShowHand(playerHand)}\nDealer: ${bjShowHand(dealerHand)}\nBlackjack! ${result} | Bakiye: ${getBalance(message.author.id)} 🪙`);
      return;
    }
    const sent = await message.reply(`Sen: ${bjShowHand(playerHand)}\nDealer: ${bjShowHand(dealerHand, true)}\nBahis: ${bet} 🪙 | ⬆️ kart çek • 🛑 dur`);
    bjGames.set(message.author.id, { deck, playerHand, dealerHand, bet, userId: message.author.id, messageId: sent.id, channelId: sent.channelId });
    await sent.react("⬆️");
    await sent.react("🛑");
    return;
  }

  if (lower === "*kelime") {
    const word = getStartWord();
    wordGames.set(message.channelId, { lastWord: word, requiredLetter: wordLastLetter(word), usedWords: new Set([word]), lastPlayerId: null });
    await message.channel.send(`kelime oyunu başladı! **${word}** — sıradaki kelime **'${wordLastLetter(word)}'** ile başlamalı`);
    return;
  }

  if (lower === "*kelimeson" || lower === "*kelimedur") {
    if (wordGames.has(message.channelId)) {
      wordGames.delete(message.channelId);
      await message.channel.send("kelime oyunu bitti");
    }
    return;
  }

  if (lower.startsWith("*ai")) {
    const query = content.slice(3).trim();
    const recentHistory = await fetchRecentHistory(message.channel, 8);
    const out = await askGemini(query || "naber", false, recentHistory) || randomSentence();
    await message.reply(out);
    return;
  }

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

  if (lower.startsWith("*tahmin")) {
    const num = Math.floor(Math.random() * 100) + 1;
    guessGames.set(message.channelId, { number: num });
    await message.channel.send("1 ile 100 arasında bir sayı tuttum. @beni mention yaparak tahmin et!");
    return;
  }

  if (lower.startsWith("*ver")) {
    const target = message.mentions.users.first();
    const parts = content.split(/\s+/);
    const bet = parseBet(parts[parts.length - 1], message.author.id);
    if (!target || !bet || target.id === message.author.id || target.bot) {
      await message.reply("kullanım: *ver @kişi miktar");
      return;
    }
    setBalance(message.author.id, getBalance(message.author.id) - bet);
    setBalance(target.id, getBalance(target.id) + bet);
    await message.reply(`${target.username}'a **${bet}** 🪙 gönderildi`);
    return;
  }

  if (lower === "*sıralama" || lower === "*siralama") {
    const sorted = [...balances.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (sorted.length === 0) { await message.reply("henüz bakiye kaydı yok"); return; }
    const medals = ["🥇","🥈","🥉"];
    const lines = await Promise.all(sorted.map(async ([uid, bal], i) => {
      let name;
      try { const u = await client.users.fetch(uid); name = u.username; } catch { name = uid; }
      const prefix = medals[i] || `${i + 1}.`;
      return `${prefix} **${name}** — ${bal} 🪙`;
    }));
    await message.reply("**para sıralaması:**\n" + lines.join("\n"));
    return;
  }

  if (lower === "*hafıza" || lower === "*hafiza") {
    const usable = memory.filter(m => m.includes(": ") && m.length > 15 && m.length < 200);
    if (usable.length === 0) { await message.reply("henüz hafızam boş"); return; }
    const entry = usable[Math.floor(Math.random() * usable.length)];
    const colon = entry.indexOf(": ");
    const who = entry.slice(0, colon);
    const said = entry.slice(colon + 2);
    await message.reply(`bir zamanlar **${who}** şöyle demişti:\n> ${said}`);
    return;
  }

  if (lower.startsWith("*slot")) {
    const parts = content.split(/\s+/);
    const bet = parseBet(parts[1], message.author.id);
    if (!bet) { await message.reply(`geçersiz miktar. bakiyen: ${getBalance(message.author.id)} 🪙`); return; }
    const symbols = [
      { e: "🍒", w: 30 }, { e: "🍋", w: 25 }, { e: "🍊", w: 20 },
      { e: "🍇", w: 15 }, { e: "🔔", w: 6 }, { e: "⭐", w: 3 },
      { e: "💎", w: 1 }, { e: "7️⃣", w: 1 },
    ];
    const totalW = symbols.reduce((s, x) => s + x.w, 0);
    function spin() {
      let r = Math.random() * totalW;
      for (const s of symbols) { r -= s.w; if (r <= 0) return s.e; }
      return symbols[0].e;
    }
    const reels = [spin(), spin(), spin()];
    const line = reels.join(" | ");
    const bal = getBalance(message.author.id);
    let result, delta;
    if (reels[0] === reels[1] && reels[1] === reels[2]) {
      const mult = reels[0] === "💎" ? 20 : reels[0] === "7️⃣" ? 10 : reels[0] === "⭐" ? 5 : reels[0] === "🔔" ? 4 : 3;
      delta = bet * mult - bet;
      setBalance(message.author.id, bal + delta);
      result = `🎉 üçlü! x${mult} → +${delta} 🪙`;
    } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
      delta = 0;
      result = `ikili — para iade`;
    } else {
      delta = -bet;
      setBalance(message.author.id, bal - bet);
      result = `-${bet} 🪙`;
    }
    await message.reply(`[ ${line} ]\n${result} | Bakiye: ${getBalance(message.author.id)} 🪙`);
    return;
  }

  if (lower === "*kasa" || lower === "*kasalar") {
    const lines = Object.entries(CASES).map(([key, c]) => {
      return `**${c.name}** (\`*kasa ${key}\`) — ${c.cost} 🪙`;
    });
    await message.reply(`**CS2 Kasaları:**\n${lines.join("\n")}\n\nNadirlik şansları: ⬜ Consumer %79.9 | 🟦 Industrial %16.0 | 🟪 Mil-Spec %3.2 | 🔵 Restricted %0.64 | 🩷 Classified %0.26 | 🔴 Covert %0.064 | 🟡 Knife %0.026`);
    return;
  }

  if (lower.startsWith("*kasa ")) {
    const key = lower.slice(6).trim();
    const caseData = CASES[key];
    if (!caseData) {
      await message.reply(`bilinmeyen kasa. kullanılabilir kasalar: ${Object.keys(CASES).join(", ")}`);
      return;
    }
    const bal = getBalance(message.author.id);
    if (bal < caseData.cost) {
      await message.reply(`yetersiz bakiye! Bu kasa ${caseData.cost} 🪙 gerektiriyor. Bakiyen: ${bal} 🪙`);
      return;
    }
    setBalance(message.author.id, bal - caseData.cost);

    const rarity = rollRarity();
    const skinPool = caseData.skins[rarity];
    const skin = skinPool[Math.floor(Math.random() * skinPool.length)];
    const condition = rollCondition();
    const isStatTrak = ["milspec","restricted","classified","covert","knife"].includes(rarity) && Math.random() < 0.1;
    const stPrefix = isStatTrak ? "StatTrak™ " : "";
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

    const savesToInventory = ["restricted","classified","covert","knife"].includes(rarity);
    setBalance(message.author.id, getBalance(message.author.id) + coinReward);
    if (savesToInventory) {
      addToInventory(message.author.id, message.author.username, {
        name: fullName,
        rarity,
        case: caseData.name,
        date: new Date().toISOString(),
      });
    }

    const rarityLabel = `${info.color} ${info.label}`;
    const stNote = isStatTrak ? " *(StatTrak™ +50%)*" : "";
    const inventoryNote = savesToInventory
      ? `\n📦 **Envantere eklendi!** +${coinReward} 🪙${stNote}`
      : `\n+${coinReward} 🪙${stNote}`;
    await message.reply(`🎰 **${caseData.name}** açıldı!\n\n${rarityLabel}\n🔫 **${fullName}**${inventoryNote}\n\nYeni bakiye: ${getBalance(message.author.id)} 🪙`);
    return;
  }

  if (lower === "*envanter" || lower.startsWith("*envanter ")) {
    let targetId = message.author.id;
    let targetName = message.author.username;
    if (message.mentions.users.size > 0) {
      const mentioned = message.mentions.users.first();
      targetId = mentioned.id;
      targetName = mentioned.username;
    }
    const inv = inventory[targetId];
    if (!inv || inv.items.length === 0) {
      await message.reply(targetId === message.author.id ? "envanterin boş! kasa açarak nadir skinler kazanabilirsin." : `**${targetName}** kullanıcısının envanteri boş.`);
      return;
    }
    const rarityOrder = ["knife","covert","classified","restricted","milspec"];
    const sorted = [...inv.items].sort((a, b) => rarityOrder.indexOf(a.rarity) - rarityOrder.indexOf(b.rarity));
    const lines = sorted.map((item, i) => {
      const info = RARITY_INFO[item.rarity] || {};
      return `${i + 1}. ${info.color || ""} ${item.name}`;
    });
    const chunks = [];
    let chunk = [];
    for (const line of lines) {
      chunk.push(line);
      if (chunk.length === 15) { chunks.push(chunk.join("\n")); chunk = []; }
    }
    if (chunk.length) chunks.push(chunk.join("\n"));
    const header = `**${targetName}** envanteri (${sorted.length} item):`;
    await message.reply(`${header}\n${chunks[0]}`);
    for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
    return;
  }

  if (lower.startsWith("*zar")) {
    const parts = content.split(/\s+/);
    const bet = parseBet(parts[1], message.author.id);
    if (!bet) { await message.reply(`geçersiz miktar. bakiyen: ${getBalance(message.author.id)} 🪙`); return; }
    const ur = Math.floor(Math.random() * 6) + 1;
    const br = Math.floor(Math.random() * 6) + 1;
    const bal = getBalance(message.author.id);
    let result;
    if (ur > br) { setBalance(message.author.id, bal + bet); result = `kazandın +${bet} 🪙`; }
    else if (ur < br) { setBalance(message.author.id, bal - bet); result = `kaybettin -${bet} 🪙`; }
    else result = "berabere, para iade";
    await message.reply(`Sen: **${ur}** | Ben: **${br}** — ${result} | Bakiye: ${getBalance(message.author.id)} 🪙`);
    return;
  }

  if (lower.startsWith("*tura")) {
    const parts = content.split(/\s+/);
    const bet = parseBet(parts[1], message.author.id);
    const choice = parts[2]?.toLowerCase();
    if (!bet || !["yazı", "tura", "yazi"].includes(choice)) {
      await message.reply(`kullanım: *tura [miktar] yazı/tura | bakiyen: ${getBalance(message.author.id)} 🪙`);
      return;
    }
    const result = Math.random() < 0.5 ? "yazı" : "tura";
    const normalChoice = choice === "yazi" ? "yazı" : choice;
    const bal = getBalance(message.author.id);
    if (result === normalChoice) {
      setBalance(message.author.id, bal + bet);
      await message.reply(`**${result}** — kazandın +${bet} 🪙 | Bakiye: ${getBalance(message.author.id)} 🪙`);
    } else {
      setBalance(message.author.id, bal - bet);
      await message.reply(`**${result}** — kaybettin -${bet} 🪙 | Bakiye: ${getBalance(message.author.id)} 🪙`);
    }
    return;
  }

  if (lower.startsWith("*tkm") || lower.startsWith("*rps")) {
    const parts = content.split(/\s+/);
    const valid = ["tas", "kagit", "makas"];
    const choice = foldTR(parts[2] || "");
    if (!valid.includes(choice)) {
      await message.reply(`kullanım: *tkm [miktar] taş/kağıt/makas | bakiyen: ${getBalance(message.author.id)} 🪙`);
      return;
    }
    const bet = parseBet(parts[1], message.author.id);
    if (!bet) { await message.reply(`geçersiz miktar. bakiyen: ${getBalance(message.author.id)} 🪙`); return; }
    const names = { tas: "taş", kagit: "kağıt", makas: "makas" };
    const beats = { tas: "makas", kagit: "tas", makas: "kagit" };
    const options = ["tas", "kagit", "makas"];
    const bot = options[Math.floor(Math.random() * 3)];
    const bal = getBalance(message.author.id);
    let result;
    if (choice === bot) { result = "berabere, para iade"; }
    else if (beats[choice] === bot) { setBalance(message.author.id, bal + bet); result = `kazandın +${bet} 🪙`; }
    else { setBalance(message.author.id, bal - bet); result = `kaybettin -${bet} 🪙`; }
    await message.reply(`Sen: **${names[choice]}** | Ben: **${names[bot]}** — ${result} | Bakiye: ${getBalance(message.author.id)} 🪙`);
    return;
  }

  if (lower === "*roblox" || lower === "*oyun") {
    const presence = await getRobloxPresence();
    if (!presence) { await message.reply("bilgi alınamadı"); return; }
    if (!presence.online) { await message.reply("şu an çevrimdışı"); return; }
    if (presence.inGame) {
      await message.reply(`oyunda: **${presence.gameName || "bilinmiyor"}**`);
    } else {
      await message.reply("çevrimiçi ama oyunda değil");
    }
    return;
  }

  let isReplyToBot = false;
  if (message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (refMsg.author.id === client.user.id) isReplyToBot = true;
    } catch {}
  }
  let shouldRespond = false;

  messageCounter++;
  if (messageCounter >= nextMessageTarget) {
    messageCounter = 0;
    nextMessageTarget = Math.floor(Math.random() * 31) + 20;
    shouldRespond = true;
  }

  if (isReplyToBot || shouldRespond) {
    const recentHistory = await fetchRecentHistory(message.channel, 8);
    const context = isReplyToBot
      ? `${message.author.username}: ${content}`
      : content;

    const out = await askGemini(context, false, recentHistory);
    if (out) {
      if (!botRecentSet.has(out)) {
        botRecentSet.add(out);
        if (botRecentSet.size > BOT_RECENT_LIMIT) botRecentSet.delete(botRecentSet.values().next().value);
        if (isReplyToBot) {
          await message.reply(out);
        } else {
          await message.channel.send(out);
        }
      }
      return;
    }

    const markov = generateMarkov();
    if (markov && markov.split(" ").length >= 5) {
      if (!botRecentSet.has(markov)) {
        botRecentSet.add(markov);
        if (botRecentSet.size > BOT_RECENT_LIMIT) botRecentSet.delete(botRecentSet.values().next().value);
        if (isReplyToBot) {
          await message.reply(markov);
        } else {
          await message.channel.send(markov);
        }
      }
    }
  }

  if (reactionsEnabled && message.author.id === TARGET_USER_ID) {
    try {
      await message.react(EMOJI_1);
      await message.react(EMOJI_2);
    } catch {}
  }
});

/* =========================
   BLACKJACK REAKSİYON
========================= */
client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  if (reaction.message.partial) { try { await reaction.message.fetch(); } catch { return; } }

  const game = [...bjGames.values()].find(g => g.messageId === reaction.message.id && g.userId === user.id);
  if (!game) return;

  const emoji = reaction.emoji.name;
  if (emoji !== "⬆️" && emoji !== "🛑") return;

  try { await reaction.users.remove(user.id); } catch {}

  const msg = reaction.message;

  if (emoji === "⬆️") {
    game.playerHand.push(game.deck.pop());
    if (bjHandVal(game.playerHand) > 21) {
      bjGames.delete(game.userId);
      setBalance(game.userId, getBalance(game.userId) - game.bet);
      try { await msg.reactions.removeAll(); } catch {}
      await msg.edit(`Sen: ${bjShowHand(game.playerHand)}\nDealer: ${bjShowHand(game.dealerHand)}\nBUST! -${game.bet} 🪙 | Bakiye: ${getBalance(game.userId)} 🪙`);
    } else {
      await msg.edit(`Sen: ${bjShowHand(game.playerHand)}\nDealer: ${bjShowHand(game.dealerHand, true)}\nBahis: ${game.bet} 🪙 | ⬆️ kart çek • 🛑 dur`);
    }
  } else if (emoji === "🛑") {
    bjDealerPlay(game);
    const result = bjResolve(game);
    bjGames.delete(game.userId);
    try { await msg.reactions.removeAll(); } catch {}
    await msg.edit(`Sen: ${bjShowHand(game.playerHand)}\nDealer: ${bjShowHand(game.dealerHand)}\n${result} | Bakiye: ${getBalance(game.userId)} 🪙`);
  }
});

client.login(process.env.DISCORD_TOKEN);