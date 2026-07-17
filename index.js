require('dotenv').config(); 
const { Client, GatewayIntentBits } = require('discord.js');
const { connectDB } = require('./db'); 
const { handleInteractions } = require('./interactions');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages // User ko direct DM bhejne ke liye zaroori hai
    ]
});

const mongoURI = process.env.MONGO_URI || process.env.MONGO_URL;
if (!mongoURI) {
    console.error('❌ CRITICAL ERROR: Database Connection String missing!');
    process.exit(1);
}

client.once('ready', () => {
    console.log(`🤖 Logged in successfully as ${client.user.tag}!`);
});

// Database connection fire karo
connectDB(mongoURI);

// Gateway Interactions Listener
client.on('interactionCreate', async (interaction) => {
    try {
        await handleInteractions(interaction);
    } catch (err) {
        console.error('Interaction gateway exception:', err);
    }
});

client.login(process.env.DISCORD_TOKEN);
