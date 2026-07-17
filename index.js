require('dotenv').config(); 
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { connectDB } = require('./db'); 
const { handleInteractions } = require('./interactions');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Database Connection Bridge Setup
const mongoURI = process.env.MONGO_URI || process.env.MONGO_URL;
if (!mongoURI) {
    console.error('❌ CRITICAL ERROR: Database Connection String missing on Railway!');
    process.exit(1);
}

// Clean and Original Admin Slash Commands Layout
const commands = [
    new SlashCommandBuilder()
        .setName('store')
        .setDescription('Store administration management panel')
        .addSubcommand(subcommand =>
            subcommand
                .setName('configurations')
                .setDescription('Configure base store database setups')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('panel')
                .setDescription('Deploy front facing shop panel')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('execution')
                .setDescription('Route command engine strings mapping')
        )
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`🤖 Logged in successfully as ${client.user.tag}!`);
    
    // Auto sync and refresh clean slash commands matrix to Discord API
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('🔄 Cleaning cache and refreshing original execution application (/) commands...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('✅ Application (/) commands successfully re-synchronized globally.');
    } catch (error) {
        console.error('❌ Slash command registration failed:', error);
    }
});

// Fire Database connection mapping
connectDB(mongoURI);

// Gateway Interactions Listener
client.on('interactionCreate', async (interaction) => {
    try {
        await handleInteractions(interaction);
    } catch (err) {
        console.error('Interaction gateway runtime exception:', err);
    }
});

client.login(process.env.DISCORD_TOKEN);
