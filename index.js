require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

// === RASTGELE MESAJ SAYACI (5–100) ===
let messageCounter = 0;
let nextMessageTarget = Math.floor(Math.random() * 16) + 5; // 5–20


// === KELİME HAVUZU ===
const WORD_POOL = [
  // fiiller
  "düşünüyor","bekliyor","anlamıyor","soruyor","unutuyor","hatırlıyor",
  "karışıyor","yaklaşıyor","kaçıyor","izliyor","bozuluyor","süzülüyor",
  "dağılıyor","toplanıyor","yoruluyor","çözülüyor","kapanıyor","açılıyor",
  "sallanıyor","kayboluyor","beliriyor","sürükleniyor","çarpıyor","dokunuyor",
  "duraksıyor","akıyor","titreşiyor","blitzcrank"

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
  "rahatlık","boşvermişlik","acele","duraksama","çelişki","uyumsuzluk",

  // zaman/mekan kırıntıları
  "bugün","yarın","şimdi","önce","sonra","içeride","dışarıda","Oral Mühendisi","arada","üstünde","altında",
];

function randomSentence() {
  const length = Math.floor(Math.random() * 6) + 5; // 5–10 kelime
  const words = [];

  for (let i = 0; i < length; i++) {
    words.push(WORD_POOL[Math.floor(Math.random() * WORD_POOL.length)]);
  }

  // tamamen rastgele karıştır
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [words[i], words[j]] = [words[j], words[i]];
  }

  let sentence = words.join(" ");
  sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
  return sentence;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// === REACTION AYARLARI ===
let reactionsEnabled = true;
const ADMIN_USER_ID = "297433660553035778";
const TARGET_USER_ID = "403940186494599168";
const EMOJI_1 = "🪑";
const EMOJI_2 = "🪢";

client.once("ready", () => console.log(`Bot aktif: ${client.user.tag}`));

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return; // bot mesajlarını sayma/işleme

    // === Admin komutları ===
    if (message.author.id === ADMIN_USER_ID) {
      const cmd = message.content.trim().toLowerCase();

      if (cmd === "*reaction off") {
        reactionsEnabled = false;
        await message.reply("⛔ Reaction atma kapatıldı.");
        return;
      }
      if (cmd === "*reaction on") {
        reactionsEnabled = true;
        await message.reply("✅ Reaction atma açıldı.");
        return;
      }
      if (cmd === "*reaction status") {
        await message.reply(`Durum: ${reactionsEnabled ? "✅ AÇIK" : "⛔ KAPALI"}`);
        return;
      }
    }

    // === 5–100 arası rastgele aralıkla mesaj atma ===
    messageCounter++;
    if (messageCounter >= nextMessageTarget) {
      messageCounter = 0;
      await message.channel.send(randomSentence());
      nextMessageTarget = Math.floor(Math.random() * 16) + 5; // 5–20 yeni hedef
    }

    // === Reaction kısmı ===
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

