require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const TARGET_USER_ID = "HEDEF_KULLANICI_ID";
const EMOJI_1 = ":chair:";
const EMOJI_2 = ":knot:";

client.once("ready", () => console.log(`Bot aktif: ${client.user.tag}`));

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (message.author.id !== TARGET_USER_ID) return;

    const reactions = message.reactions.cache;
    const has1 = reactions.some((r) => r.emoji.name === EMOJI_1);
    const has2 = reactions.some((r) => r.emoji.name === EMOJI_2);

    if (!has1) await message.react(EMOJI_1);
    if (!has2) await message.react(EMOJI_2);
  } catch (e) {
    console.error(e);
  }
});

client.login(process.env.DISCORD_TOKEN);
