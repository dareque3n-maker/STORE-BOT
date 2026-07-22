require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
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
const instantDeleteTracker = new Map();
const roleDeleteTracker = new Map();

// ================= ULTRA-FAST INSTANT NUKE DEFENSE =================

// 1. CHANNEL DELETE PROTECTION (Lightning Fast)
client.on('channelDelete', async (channel) => {
    try {
        const guildId = channel.guild.id;
        const now = Date.now();
        
        // Audit log bina delay ke fetch karo
        const audit = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete }).catch(() => null);
        const entry = audit?.entries.first();
        
        if (!entry || !entry.executor) return;
        const executorId = entry.executor.id;

        if (executorId === client.user.id || executorId === channel.guild.ownerId) return;

        const config = await AntiNukeConfig.findOne({ guildId: guildId });
        if (!config || !config.enabled || config.whitelistedUsers.includes(executorId)) return;

        // Instant rate-limit check (Max 2 channels in 10 seconds)
        const key = `${guildId}_${executorId}`;
        const userDeletions = instantDeleteTracker.get(key) || [];
        const validDeletions = userDeletions.filter(t => now - t < 10000); 
        validDeletions.push(now);
        instantDeleteTracker.set(key, validDeletions);

        // Agar user ne jaldi me 2 channel delete kiye, turant action lo!
        if (validDeletions.length >= 2) {
            instantDeleteTracker.delete(key); // Reset tracker
            
            const member = await channel.guild.members.fetch(executorId).catch(() => null);
            if (member && member.bannable) {
                // Instant Ban & Roles Strip
                await member.roles.set([]).catch(() => null);
                await member.ban({ reason: `🚨 Anti-Nuke: Mass Channel Deletion Speed Trigger` }).catch(() => null);
            }

            // Chat Transcript nikalna
            let transcriptText = "Channel was deleted too fast or was empty.";
            if (channel.isTextBased()) {
                const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
                if (messages && messages.size > 0) {
                    transcriptText = messages.map(m => `[${new Date(m.createdTimestamp).toLocaleTimeString()}] ${m.author.tag}: ${m.content}`).reverse().join('\n');
                }
            }

            // Save Specific Deleted Data for Perfect Restore
            const emergencyId = 'emg_' + Date.now();
            const channelPayload = [{
                name: channel.name,
                type: channel.type,
                parentId: channel.parent ? channel.parent.name : null, // Category link karne ke liye
                position: channel.position
            }];

            config.emergencyBackups.push({
                backupId: emergencyId,
                createdAt: new Date(),
                deletedChannelName: channel.name,
                transcript: transcriptText,
                channelData: channelPayload
            });
            await config.save();

            // Logs & Owner Alerts with Direct Copy-Paste Command
            const embed = new EmbedBuilder()
                .setTitle('🚨 LIGHTNING FAST ANTI-NUKE TRIGGERED!')
                .setDescription(`\`\`\`text\nNuker   : ${entry.executor.tag}\nAction  : Mass Channel Deletion\nStatus  : Banned & Neutralized\n\`\`\`\n**👇 Copy & Paste this command to restore:**\n\`\`\`/restore id:${emergencyId}\`\`\`\n⚠️ *Backup expires in **10 minutes**!*`)
                .setColor('#FF0000')
                .setTimestamp();
            
            if (config.logChannelId) {
                const logChan = channel.guild.channels.cache.get(config.logChannelId);
                if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
            }

            const owner = await channel.guild.fetchOwner().catch(() => null);
            if (owner) {
                await owner.send({ embeds: [embed] }).catch(() => null);
            }
        }
    } catch (err) {
        console.error('Instant Defense Error (Channel):', err);
    }
});


// 2. ROLE DELETE PROTECTION
client.on('roleDelete', async (role) => {
    try {
        const guildId = role.guild.id;
        const now = Date.now();

        const audit = await role.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.RoleDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        if (executorId === client.user.id || executorId === role.guild.ownerId) return;

        const config = await AntiNukeConfig.findOne({ guildId: guildId });
        if (!config || !config.enabled || config.whitelistedUsers.includes(executorId)) return;

        const key = `${guildId}_${executorId}`;
        const userDeletions = roleDeleteTracker.get(key) || [];
        const validDeletions = userDeletions.filter(t => now - t < 10000);
        validDeletions.push(now);
        roleDeleteTracker.set(key, validDeletions);

        // Instant Ban on 2 Role Deletions
        if (validDeletions.length >= 2) {
            roleDeleteTracker.delete(key);
            const member = await role.guild.members.fetch(executorId).catch(() => null);
            if (member && member.bannable) {
                await member.roles.set([]).catch(() => null);
                await member.ban({ reason: `🚨 Anti-Nuke: Mass Role Deletion Speed Trigger` }).catch(() => null);
            }
        }
    } catch (err) {
        console.error('Instant Defense Error (Role):', err);
    }
});


// 3. CHAT SPAM DETECTION
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    const now = Date.now();
    const key = `${message.guild.id}_${message.author.id}`;
    const userSpam = spamTracker.get(key) || [];
    
    const valid = userSpam.filter(t => now - t < 5000); // 5 sec window
    valid.push(now);
    spamTracker.set(key, valid);

    if (valid.length >= 6) { // 6 messages in 5 seconds = Nuke
        spamTracker.delete(key);
        
        const config = await AntiNukeConfig.findOne({ guildId: message.guild.id });
        if (!config || !config.enabled || config.whitelistedUsers.includes(message.author.id)) return;

        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member && member.bannable) {
            await member.roles.set([]).catch(() => null);
            await member.ban({ reason: `🚨 Anti-Nuke: Chat Spam Flooding` }).catch(() => null);
        }
    }
});


// ================= SLASH COMMANDS =================
client.once('ready', async () => {
    console.log(`🛡️ Ultimate Lightning Anti-Nuke Bot Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    const commands = [
        new SlashCommandBuilder().setName('antinuke').setDescription('Setup Anti-Nuke config')
            .addSubcommand(s => s.setName('setup').setDescription('Setup log channel').addChannelOption(c => c.setName('channel').setDescription('Logs channel').setRequired(true))),
        
        new SlashCommandBuilder().setName('restore').setDescription('Restore deleted channel (Owner Only)')
            .addStringOption(o => o.setName('id').setDescription('Emergency Backup ID').setRequired(true))
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});


// ================= COMMAND HANDLING =================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only the **Server Owner** can use this command!', ephemeral: true });
    }

    if (interaction.commandName === 'antinuke') {
        const chan = interaction.options.getChannel('channel');
        await AntiNukeConfig.findOneAndUpdate({ guildId: interaction.guild.id }, { logChannelId: chan.id }, { upsert: true });
        return await interaction.reply({ content: `✅ Anti-Nuke Log channel successfully set to ${chan}` });
    }

    if (interaction.commandName === 'restore') {
        await interaction.deferReply({ ephemeral: true });
        const backupId = interaction.options.getString('id');
        const config = await AntiNukeConfig.findOne({ guildId: interaction.guild.id });
        
        const targetBackup = config?.emergencyBackups?.find(b => b.backupId === backupId);
        if (!targetBackup) {
            return await interaction.editReply({ content: '❌ Invalid Emergency ID or it has expired (over 10 mins old)!' });
        }

        await interaction.editReply({ content: `🔄 Restoring deleted structure...` });

        const categoryMap = new Map();
        
        // Channel Data Restore Logic (Fixes Categories mapping perfectly)
        if (targetBackup.channelData && Array.isArray(targetBackup.channelData)) {
            // 1. Categories pehle banao
            const categories = targetBackup.channelData.filter(c => c.type === 4);
            const otherChannels = targetBackup.channelData.filter(c => c.type !== 4);

            for (const cat of categories) {
                const createdCat = await interaction.guild.channels.create({
                    name: cat.name,
                    type: 4, // 4 = GuildCategory
                    position: cat.position
                }).catch(() => null);

                if (createdCat) categoryMap.set(cat.name, createdCat.id);
            }

            // 2. Phir text/voice channels bana kar unko unki category mein daalo
            for (const chan of otherChannels) {
                let parentId = null;
                if (chan.parentId && categoryMap.has(chan.parentId)) {
                    parentId = categoryMap.get(chan.parentId);
                }

                await interaction.guild.channels.create({
                    name: chan.name,
                    type: chan.type,
                    parent: parentId,
                    position: chan.position
                }).catch(() => null);
            }
        }

        let responseText = `✅ Deleted structure successfully restored!`;
        if (targetBackup.transcript) {
            responseText += `\n\n📄 **Transcript Before Deletion:**\n\`\`\`text\n${targetBackup.transcript.slice(0, 1500)}\n\`\`\``;
        }

        return await interaction.editReply({ content: responseText });
    }
});

client.login(process.env.DISCORD_TOKEN);
                
