require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const OpenAI = require("openai");

/* =========================
   OPENAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let genaiEnabled = true;

/* =========================
   TOKEN TAKİP
========================= */
let dailyTokens = 0;
let monthlyTokens = 0;
let lastDay = new Date().getDate();
let lastMonth = new Date().getMonth();

const MONTHLY_TOKEN_BUDGET = 900_000; // ~5$

function checkTokenReset() {
  const now = new Date();

  if (now.getDate() !== lastDay) {
    console.log(`📅 Günlük token reset: ${dailyTokens}`);
    dailyTokens = 0;
    lastDay = now.getDate();
  }

  if (now.getMonth() !== lastMonth) {
    console.log(`📆 Aylık token reset: ${monthlyTokens}`);
    monthlyTokens = 0;
    lastMonth = now.getMonth();
    genaiEnabled = true;
  }
}

/* =========================
   AYARLAR
========================= */
const ADMIN_USER_ID = "297433660553035778";
const SEED_CHANNEL_ID = "705537838770421761";

let messageCounter = 0;
let nextMessageTarget = Math.floor(Math.random() * 16) + 5;

/* =========================
   HAFIZA
========================= */
const memory = [];
const MAX_MEMORY = 40000;
const RECENT_EXCLUDE = 100;

/* =========================
   METİN ARAÇLARI
========================= */
function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* =========================
   MARKOV
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

function markovSentence() {
  if (memory.length < 60) return "Aga noluyo burada.";

  const usable =
    memory.length > RECENT_EXCLUDE
      ? memory.slice(0, memory.length - RECENT_EXCLUDE)
      : memory;

  const model = buildMarkov3(usable);
  const keys = Array.from(model.keys());
  if (!keys.length) return "Bir şeyler dönüyor ama çözemedim.";

  const start = randomFrom(keys).split("|");
  const out = [...start];
  const targetLen = Math.floor(Math.random() * 6) + 5;

  while (out.length < targetLen) {
    const key = `${out[out.length - 3]}|${out[out.length - 2]}|${out[out.length - 1]}`;
    const nexts = model.get(key);
    if (!nexts) break;
    out.push(randomFrom(nexts));
  }

  let s = out.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/* =========================
   GENAI CEVAP
========================= */
async function genaiReply(userMessage) {
  checkTokenReset();

  if (!genaiEnabled) return markovSentence();

  const style = memory.slice(-10).join("\n");

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Discord sohbet tarzında, kısa ve doğal cevap ver. En fazla 2 cümle.",
      },
      {
        role: "user",
        content: `Örnek konuşmalar:\n${style}\n\nMesaj:\n${userMessage}`,
      },
    ],
    max_tokens: 80,
    temperature: 0.9,
  });

  const used = res.usage.total_tokens;
  dailyTokens += used;
  monthlyTokens += used;

  console.log(
    `🧠 GenAI token +${used} | Günlük ${dailyTokens} | Aylık ${monthlyTokens}`
  );

  if (monthlyTokens >= MONTHLY_TOKEN_BUDGET) {
    genaiEnabled = false;
    console.log("💸 Aylık token limiti doldu → GenAI kapandı");
  }

  return res.choices[0].message.content;
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

client.once("ready", () => {
  console.log(`🤖 Bot aktif: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    const content = message.content.trim();

    /* === HAFIZA === */
    if (message.channel.id === SEED_CHANNEL_ID && content) {
      memory.push(content);
      if (memory.length > MAX_MEMORY) memory.shift();
    }

    /* === ADMIN KOMUTLARI === */
    if (message.author.id === ADMIN_USER_ID) {
      const cmd = content.toLowerCase();

      if (cmd === "*ai status") {
        await message.reply(
          [
            `🤖 GenAI: ${genaiEnabled ? "AÇIK" : "KAPALI"}`,
            `📅 Günlük token: ${dailyTokens}`,
            `📆 Aylık token: ${monthlyTokens}/${MONTHLY_TOKEN_BUDGET}`,
          ].join("\n")
        );
        return;
      }
    }

    /* === MENTION → GENAI === */
    if (message.mentions.has(client.user)) {
      await message.reply(await genaiReply(content));
      return;
    }

    /* === REPLY → GENAI === */
    if (
      message.reference &&
      message.mentions.repliedUser?.id === client.user.id
    ) {
      await message.reply(await genaiReply(content));
      return;
    }

    /* === RASTGELE MARKOV MESAJ === */
    messageCounter++;
    if (messageCounter >= nextMessageTarget) {
      messageCounter = 0;
      nextMessageTarget = Math.floor(Math.random() * 16) + 5;
      await message.channel.send(markovSentence());
    }
  } catch (e) {
    console.error(e);
  }
});

client.login(process.env.DISCORD_TOKEN);
