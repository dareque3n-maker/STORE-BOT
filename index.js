require('dotenv').config(); 
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { connectDB } = require('./db'); 
const { handleInteractions } = require('./interactions');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

// Database Setup
const mongoURI = process.env.MONGO_URI || process.env.MONGO_URL;
if (!mongoURI) {
    console.error('❌ CRITICAL ERROR: Database Connection String missing!');
    process.exit(1);
}

// Fixed Matrix Commands Setup
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
    
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('🔄 Re-syncing clean application (/) commands...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('✅ Commands successfully re-synchronized.');
    } catch (error) {
        console.error('❌ Slash command registration failed:', error);
    }
});

connectDB(mongoURI);

client.on('interactionCreate', async (interaction) => {
    try {
        await handleInteractions(interaction);
    } catch (err) {
        console.error('Interaction gateway runtime exception:', err);
    }
});

client.login(process.env.DISCORD_TOKEN);
