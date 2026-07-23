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

// Helper: Send detailed A-to-Z logs to Log Channel + Owner DM simultaneously
async function sendOlympusLog(guild, title, description, color = '#FF0000') {
    try {
        const config = await AntiNukeConfig.findOne({ guildId: guild.id });
        
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();

        // 1. Send to Log Channel
        if (config && config.logChannelId) {
            const logChan = guild.channels.cache.get(config.logChannelId);
            if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
        }

        // 2. Send to Server Owner DM
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
            await owner.send({ embeds: [embed] }).catch(() => null);
        }
    } catch (e) {
        console.error('Logging Error:', e);
    }
}

// Check if a user/bot is whitelisted by the Owner
async function isWhitelisted(guildId, userId, ownerId) {
    if (userId === ownerId || userId === client.user.id) return true;
    const config = await AntiNukeConfig.findOne({ guildId });
    return config && config.whitelistedUsers && config.whitelistedUsers.includes(userId);
}


// ================= OLYMPUS STRICT SECURITY ENGINE =================

// 1. Bot Add Protection
client.on('guildMemberAdd', async (member) => {
    try {
        if (!member.user.bot) return;

        const audit = await member.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        const allowed = await isWhitelisted(member.guild.id, executorId, member.guild.ownerId);

        if (!allowed) {
            // Unauthorized bot -> Kick bot & Ban the adder immediately
            await member.kick('Olympus Guard: Unauthorized Bot Addition').catch(() => null);
            
            const adder = await member.guild.members.fetch(executorId).catch(() => null);
            if (adder && adder.bannable) {
                await adder.roles.set([]).catch(() => null);
                await adder.ban({ reason: `🚨 Olympus Guard: Added unauthorized bot (${member.user.tag})` }).catch(() => null);
            }

            await sendOlympusLog(
                member.guild,
                '🚨 UNAUTHORIZED BOT ADD BLOCKED!',
                `\`\`\`text\nBot Added : ${member.user.tag}\nAdded By  : ${entry.executor.tag}\nAction    : Bot Kicked, Adder Banned\n\`\`\``
            );
        }
    } catch (e) {
        console.error('BotAdd Error:', e);
    }
});

// 2. Channel Deletion Protection
client.on('channelDelete', async (channel) => {
    try {
        const audit = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        const allowed = await isWhitelisted(channel.guild.id, executorId, channel.guild.ownerId);

        if (!allowed) {
            const member = await channel.guild.members.fetch(executorId).catch(() => null);
            if (member) {
                if (member.user.bot) {
                    // Bot trying to delete -> Ban
                    if (member.bannable) {
                        await member.roles.set([]).catch(() => null);
                        await member.ban({ reason: `🚨 Olympus Guard: Unauthorized Channel Deletion` }).catch(() => null);
                    }
                } else {
                    // Human Admin trying to mess up -> Strip all roles instantly (No kick/ban)
                    await member.roles.set([]).catch(() => null);
                }
            }

            await sendOlympusLog(
                channel.guild,
                '🛡️ CHANNEL DELETION BLOCKED',
                `\`\`\`text\nChannel   : #${channel.name}\nAction By : ${entry.executor.tag} (${member && member.user.bot ? 'Bot' : 'Admin'})\nResponse  : ${member && member.user.bot ? 'Bot Banned' : 'Admin Roles Stripped'}\n\`\`\``
            );
        }
    } catch (e) {
        console.error('Channel Delete Error:', e);
    }
});

// 3. Channel Creation Logging & Guard
client.on('channelCreate', async (channel) => {
    try {
        const audit = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelCreate }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        const allowed = await isWhitelisted(channel.guild.id, executorId, channel.guild.ownerId);

        if (!allowed && entry.executor.id !== client.user.id) {
            const member = await channel.guild.members.fetch(executorId).catch(() => null);
            if (member) {
                if (member.user.bot) {
                    await member.ban({ reason: `🚨 Olympus Guard: Unauthorized Channel Creation` }).catch(() => null);
                } else {
                    await member.roles.set([]).catch(() => null);
                }
            }
            await channel.delete('Olympus Guard: Unauthorized Creation').catch(() => null);

            await sendOlympusLog(
                channel.guild,
                '🛡️ UNAUTHORIZED CHANNEL CREATION BLOCKED',
                `\`\`\`text\nChannel   : #${channel.name}\nCreated By: ${entry.executor.tag}\nResponse  : Deleted & Offender Neutralized\n\`\`\``
            );
        } else {
            // General Log for Safe Action
            await sendOlympusLog(
                channel.guild,
                '📝 Channel Created',
                `\`\`\`text\nChannel   : #${channel.name}\nCreated By: ${entry.executor.tag}\n\`\`\``,
                '#00FF00'
            );
        }
    } catch (e) {
        console.error('Channel Create Error:', e);
    }
});

// 4. Role Deletion / Creation / Modification Tracking & Guard
client.on('roleDelete', async (role) => {
    try {
        const audit = await role.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.RoleDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        const allowed = await isWhitelisted(role.guild.id, executorId, role.guild.ownerId);

        if (!allowed) {
            const member = await role.guild.members.fetch(executorId).catch(() => null);
            if (member) {
                if (member.user.bot) {
                    await member.ban({ reason: `🚨 Olympus Guard: Unauthorized Role Deletion` }).catch(() => null);
                } else {
                    await member.roles.set([]).catch(() => null);
                }
            }

            await sendOlympusLog(
                role.guild,
                '🛡️ UNAUTHORIZED ROLE DELETION BLOCKED',
                `\`\`\`text\nRole      : @${role.name}\nDeleted By: ${entry.executor.tag}\nResponse  : Offender Neutralized\n\`\`\``
            );
        }
    } catch (e) {
        console.error('Role Delete Error:', e);
    }
});


// ================= SLASH COMMANDS =================
client.once('clientReady', async () => {
    console.log(`🛡️ Olympus-Style Security Bot Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    const commands = [
        new SlashCommandBuilder().setName('antinuke').setDescription('Olympus Security Management (Owner Only)')
            .addSubcommand(s => s.setName('setup').setDescription('Set log channel')
                .addChannelOption(c => c.setName('channel').setDescription('Log channel').setRequired(true)))
            .addSubcommand(s => s.setName('whitelist').setDescription('Whitelist a user/bot')
                .addStringOption(o => o.setName('action').setDescription('Add or Remove').setRequired(true).addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
                .setUserOption(u => u.setName('target').setDescription('User or Bot to whitelist').setRequired(true)))
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});


// ================= COMMAND HANDLING =================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only the **Server Owner** can manage Olympus Security settings!', ephemeral: true });
    }

    if (interaction.commandName === 'antinuke') {
        const sub = interaction.options.getSubcommand();
        let config = await AntiNukeConfig.findOne({ guildId: interaction.guild.id });
        if (!config) config = new AntiNukeConfig({ guildId: interaction.guild.id });

        if (sub === 'setup') {
            const chan = interaction.options.getChannel('channel');
            config.logChannelId = chan.id;
            await config.save();
            return await interaction.reply({ content: `✅ Olympus security logs & owner DMs will now be sent to ${chan}`, ephemeral: true });
        }

        if (sub === 'whitelist') {
            const action = interaction.options.getString('action');
            const target = interaction.options.getUser('target');

            if (!config.whitelistedUsers) config.whitelistedUsers = [];

            if (action === 'add') {
                if (config.whitelistedUsers.includes(target.id)) {
                    return await interaction.reply({ content: `⚠️ ${target.tag} is already whitelisted.`, ephemeral: true });
                }
                config.whitelistedUsers.push(target.id);
                await config.save();
                return await interaction.reply({ content: `✅ Successfully added **${target.tag}** to the strict whitelist.`, ephemeral: true });
            } else if (action === 'remove') {
                config.whitelistedUsers = config.whitelistedUsers.filter(id => id !== target.id);
                await config.save();
                return await interaction.reply({ content: `✅ Successfully removed **${target.tag}** from the whitelist.`, ephemeral: true });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
        
