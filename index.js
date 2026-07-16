require('dotenv').config(); 
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { connectDB } = require('./db'); 
const { handleInteraction } = require('./interactions');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Database Setup
const mongoURI = process.env.MONGO_URI || process.env.MONGO_URL;
if (!mongoURI) {
    console.error('❌ CRITICAL ERROR: Database Connection String missing!');
    process.exit(1);
}

// Slash Commands Layout
const commands = [
    new SlashCommandBuilder()
        .setName('store')
        .setDescription('Store administration management panel')
        .addSubcommand(subcommand =>
            subcommand
                .setName('bulk')
                .setDescription('Bulk import categories and items at once')
                .addStringOption(option => 
                    option.setName('input')
                        .setDescription('Format: Category:item-price || Category2:item-price')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('panel')
                .setDescription('Send the active interactive shop storefront panel')
        )
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`🤖 Logged in as ${client.user.tag}!`);
    
    // Auto register commands
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('🔄 Refreshing application (/) commands...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('✅ Successfully reloaded commands.');
    } catch (error) {
        console.error('❌ Slash command registration failed:', error);
    }
});

connectDB(mongoURI);

client.on('interactionCreate', async (interaction) => {
    try {
        await handleInteraction(interaction);
    } catch (err) {
        console.error('Interaction exception:', err);
    }
});

client.login(process.env.DISCORD_TOKEN);
