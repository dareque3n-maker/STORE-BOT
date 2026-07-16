require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const { connectDB } = require('./db');
const { registerSlashCommands } = require('./commands');
const { handleInteractions } = require('./interactions');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Database Initialization
if (process.env.MONGO_URI) {
    connectDB(process.env.MONGO_URI);
} else {
    console.error('❌ CRITICAL ERROR: MONGO_URI missing in .env environment!');
    process.exit(1);
}

// Bot Gateway Listener
client.once('ready', async () => {
    console.log(`🔥 ${client.user.tag} status check: Online and Functional!`);
    
    // Deploys the application slash structures dynamically on startup
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        const commandsData = registerSlashCommands();
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commandsData }
        );
        console.log('🚀 Successfully reloaded application (/) slash commands global blueprints.');
    } catch (error) {
        console.error('❌ Failed to register global commands structural mappings:', error);
    }
});

// Central Event Handler Router for Interactions (Menus, Modals, Buttons)
client.on('interactionCreate', async (interaction) => {
    try {
        await handleInteractions(interaction);
    } catch (error) {
        console.error('❌ Intercepted runtime exception inside interaction event wrapper:', error);
    }
});

client.login(process.env.DISCORD_TOKEN);
