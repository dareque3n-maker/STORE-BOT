require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, PermissionFlagsBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const mongoose = require('mongoose');
const AntiNukeConfig = require('./models/AntiNukeConfig');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ]
});

const spamTracker = new Map();

// ================= REAL-TIME EVENT-DRIVEN NUKE DEFENSE & TRANSCRIPT =================
client.on('channelDelete', async (channel) => {
    setTimeout(async () => {
        try {
            const audit = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete }).catch(() => null);
            const entry = audit?.entries.first();
            if (!entry || !entry.executor) return;

            const executorId = entry.executor.id;
            if (executorId === client.user.id || executorId === channel.guild.ownerId) return;

            const config = await AntiNukeConfig.findOne({ guildId: channel.guild.id });
            if (!config || !config.enabled || config.whitelistedUsers.includes(executorId)) return;

            const member = await channel.guild.members.fetch(executorId).catch(() => null);
            if (!member || !member.bannable) return;

            // 1. Neutralize Nuker instantly
            await member.roles.set([]).catch(() => null);
            await member.ban({ reason: `🚨 Anti-Nuke: Channel Deletion` }).catch(() => null);

            // 2. Fetch last 50 messages for text transcript before they vanish completely
            let transcriptText = "No messages found or channel was empty.";
            if (channel.isTextBased()) {
                const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
                if (messages && messages.size > 0) {
                    transcriptText = messages.map(m => `[${new Date(m.createdTimestamp).toLocaleString()}] ${m.author.tag}: ${m.content}`).reverse().join('\n');
                }
            }

            // 3. Save only the deleted channel's snapshot & transcript temporarily (10 mins)
            const emergencyId = 'emg_' + Date.now();
            const channelPayload = {
                name: channel.name,
                type: channel.type,
                position: channel.position
            };

            config.emergencyBackups.push({
                backupId: emergencyId,
                createdAt: new Date(),
                deletedChannelName: channel.name,
                transcript: transcriptText,
                channelData: channelPayload
            });
            await config.save();

            // 4. Send Alert + Transcript text to Logs & Owner DM
            const embed = new EmbedBuilder()
                .setTitle('🚨 EMERGENCY: CHANNEL DELETION DETECTED!')
                .setDescription(`\`\`\`text\nNuker   : ${member.user.tag}\nDeleted : #${channel.name}\nStatus  : Banned\nEmergency ID : ${emergencyId}\n\`\`\`\n⚠️ **Note:** This backup & transcript will auto-delete in **10 minutes**. Owner can use \`/restore id:${emergencyId}\``)
                .setColor('#FF0000')
                .setTimestamp();

            // Send Transcript as a file attachment if too long, or part of embed
            if (config.logChannelId) {
                const logChan = channel.guild.channels.cache.get(config.logChannelId);
                if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
            }

            const owner = await channel.guild.fetchOwner().catch(() => null);
            if (owner) {
                await owner.send({ embeds: [embed] }).catch(() => null);
                // Send transcript snippet or log to owner if needed
            }

        } catch (err) {
            console.error('Real-time defense error:', err);
        }
    }, 600);
});

// Role Delete Protection
client.on('roleDelete', async (role) => {
    setTimeout(async () => {
        const audit = await role.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.RoleDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry?.executor) return;

        const executorId = entry.executor.id;
        if (executorId === client.user.id || executorId === role.guild.ownerId) return;

        const config = await AntiNukeConfig.findOne({ guildId: role.guild.id });
        if (!config || !config.enabled || config.whitelistedUsers.includes(executorId)) return;

        const member = await role.guild.members.fetch(executorId).catch(() => null);
        if (!member || !member.bannable) return;

        await member.roles.set([]).catch(() => null);
        await member.ban({ reason: `🚨 Anti-Nuke: Role Deletion` }).catch(() => null);
    }, 600);
});


// ================= SLASH COMMANDS =================
client.once('ready', async () => {
    console.log(`🛡️ Event-Driven Anti-Nuke Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    const commands = [
        new SlashCommandBuilder().setName('antinuke').setDescription('Setup log channel')
            .addSubcommand(s => s.setName('setup').setDescription('Log channel').addChannelOption(c => c.setName('channel').setDescription('Channel').setRequired(true))),
        new SlashCommandBuilder().setName('restore').setDescription('Restore deleted channel (Owner Only)')
            .addStringOption(o => o.setName('id').setDescription('Emergency Backup ID').setRequired(true))
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only Server Owner can use this command!', ephemeral: true });
    }

    if (interaction.commandName === 'antinuke') {
        const chan = interaction.options.getChannel('channel');
        await AntiNukeConfig.findOneAndUpdate({ guildId: interaction.guild.id }, { logChannelId: chan.id }, { upsert: true });
        return await interaction.reply({ content: `✅ Log channel set to ${chan}` });
    }

    if (interaction.commandName === 'restore') {
        await interaction.deferReply({ ephemeral: true });
        const backupId = interaction.options.getString('id');
        const config = await AntiNukeConfig.findOne({ guildId: interaction.guild.id });
        
        const targetBackup = config?.emergencyBackups?.find(b => b.backupId === backupId);
        if (!targetBackup) {
            return await interaction.editReply({ content: '❌ Invalid Emergency ID or it has expired (over 10 mins old)!' });
        }

        await interaction.editReply({ content: `🔄 Restoring deleted channel **#${targetBackup.deletedChannelName}**...` });

        // Recreate the specific deleted channel
        const cData = targetBackup.channelData;
        const restoredChannel = await interaction.guild.channels.create({
            name: cData.name,
            type: cData.type,
            position: cData.position
        }).catch(() => null);

        let responseText = `✅ Channel **#${targetBackup.deletedChannelName}** successfully restored!`;
        if (restoredChannel && targetBackup.transcript) {
            responseText += `\n\n📄 **Last Chat Transcript before deletion:**\n\`\`\`text\n${targetBackup.transcript.slice(0, 1500)}\n\`\`\``;
        }

        return await interaction.editReply({ content: responseText });
    }
});

client.login(process.env.DISCORD_TOKEN);
        
