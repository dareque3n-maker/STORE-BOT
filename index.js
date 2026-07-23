const { Client, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const mongoose = require('mongoose');
require('dotenv').config();

const AntiNukeConfig = require('./models/AntiNukeConfig');
const BackupSnapshot = require('./models/BackupSnapshot');

// Using direct numeric intents to completely bypass any undefined bitfield issues
const client = new Client({
    intents: [
        1,      // Guilds
        1 << 1, // GuildMembers
        1 << 7, // GuildBans
        1 << 3, // GuildEmojisAndStickers
        1 << 5, // GuildWebhooks
        1 << 0  // GuildAuditLogs (approx or combined flags)
    ],
    partials: [Partials.GuildMember, Partials.User, Partials.Message]
});

// Fallback to TOKEN if MONGO_URI is not provided in railway variables
const dbUri = process.env.MONGO_URI || process.env.TOKEN;
mongoose.connect(dbUri).then(() => {
    console.log("[DATABASE] Connected successfully.");
}).catch(err => console.error("[DATABASE ERROR]", err));

require('./handlers/antiNuke')(client);

client.once('ready', async () => {
    console.log(`[READY] Anti-Nuke Bot online as ${client.user.tag}`);

    const commands = [
        new SlashCommandBuilder()
            .setName('security')
            .setDescription('Setup anti-nuke log channel')
            .addSubcommand(sub =>
                sub.setName('setup')
                    .setDescription('Set log channel for security alerts')
                    .addChannelOption(option => option.setName('channel').setDescription('Log channel').setRequired(true))
            ),
        new SlashCommandBuilder()
            .setName('whitelist')
            .setDescription('Whitelist a bot or user (Owner only)')
            .addUserOption(option => option.setName('target').setDescription('Bot or User to whitelist').setRequired(true)),
        new SlashCommandBuilder()
            .setName('restore')
            .setDescription('Restore server channels and categories using backup ID')
            .addStringOption(option => option.setName('id').setDescription('Restore ID (e.g. RESTORE-12345)').setRequired(true))
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('[COMMANDS] Slash commands registered globally.');
    } catch (error) {
        console.error("Command registration error:", error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'security') {
        if (interaction.user.id !== interaction.guild.ownerId) {
            return interaction.reply({ content: '❌ Only Server Owner can use this command.', ephemeral: true });
        }
        const channel = interaction.options.getChannel('channel');
        await AntiNukeConfig.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { logChannelId: channel.id },
            { upsert: true, new: true }
        );
        return interaction.reply({ content: `✅ Security log channel successfully set to ${channel}`, ephemeral: true });
    }

    if (interaction.commandName === 'whitelist') {
        if (interaction.user.id !== interaction.guild.ownerId) {
            return interaction.reply({ content: '❌ Only Server Owner can manage whitelists.', ephemeral: true });
        }
        const target = interaction.options.getUser('target');
        let config = await AntiNukeConfig.findOne({ guildId: interaction.guild.id });
        if (!config) config = await AntiNukeConfig.create({ guildId: interaction.guild.id });

        if (target.bot) {
            if (!config.whitelistedBots.includes(target.id)) config.whitelistedBots.push(target.id);
        } else {
            if (!config.whitelistedUsers.includes(target.id)) config.whitelistedUsers.push(target.id);
        }
        await config.save();
        return interaction.reply({ content: `✅ Successfully whitelisted **${target.tag}**.`, ephemeral: true });
    }

    if (interaction.commandName === 'restore') {
        if (interaction.user.id !== interaction.guild.ownerId) {
            return interaction.reply({ content: '❌ Only Server Owner can execute restores.', ephemeral: true });
        }

        const restoreId = interaction.options.getString('id');
        const snapshot = await BackupSnapshot.findOne({ guildId: interaction.guild.id, restoreId });

        if (!snapshot) {
            return interaction.reply({ content: '❌ Invalid Restore ID or no backup found for this server.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const categoryMap = new Map();
            for (const catData of snapshot.categories) {
                const newCat = await interaction.guild.channels.create({
                    name: catData.name,
                    type: 4,
                    position: catData.position,
                    permissionOverwrites: catData.permissionOverwrites
                });
                categoryMap.set(catData.id, newCat.id);
            }

            for (const chData of snapshot.channels) {
                let newParentId = null;
                if (chData.parentId && categoryMap.has(chData.parentId)) {
                    newParentId = categoryMap.get(chData.parentId);
                }

                await interaction.guild.channels.create({
                    name: chData.name,
                    type: chData.type,
                    parent: newParentId,
                    position: chData.position,
                    topic: chData.topic,
                    bitrate: chData.bitrate,
                    userLimit: chData.userLimit,
                    permissionOverwrites: chData.permissionOverwrites
                });
            }

            return interaction.editReply({ content: `✅ Server structure successfully restored using snapshot ID: \`${restoreId}\`!` });
        } catch (err) {
            console.error("Restore failed:", err);
            return interaction.editReply({ content: '❌ Failed to fully restore server structure. Check console permissions.' });
        }
    }
});

client.login(process.env.TOKEN);
