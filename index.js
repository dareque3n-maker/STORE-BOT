require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, EmbedBuilder, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
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

// Helper: Send logs to channel and owner DM
async function sendOlympusLog(guild, title, description, color = '#FF0000') {
    try {
        const config = await AntiNukeConfig.findOne({ guildId: guild.id });
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();

        if (config && config.logChannelId) {
            const logChan = guild.channels.cache.get(config.logChannelId);
            if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
        }

        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
            await owner.send({ embeds: [embed] }).catch(() => null);
        }
    } catch (e) {
        console.error('Logging Error:', e);
    }
}

async function isWhitelisted(guildId, userId, ownerId) {
    if (userId === ownerId || userId === client.user.id) return true;
    const config = await AntiNukeConfig.findOne({ guildId });
    return config && config.whitelistedUsers && config.whitelistedUsers.includes(userId);
}

// ================= HARDCORE OLYMPUS LOCKDOWN ENGINE =================
// Ye function unwhitelisted roles/bots ki aisi taisi kar dega aur unse dangerous permissions chheen lega
async function enforceSecurityLockdown(guild) {
    try {
        const ownerId = guild.ownerId;
        const config = await AntiNukeConfig.findOne({ guildId: guild.id });
        const whitelisted = config ? config.whitelistedUsers : [];

        guild.roles.cache.forEach(async (role) => {
            // Owner ya bot ke apne roles ko chhod kar baaki sabhi roles se dangerous permissions strip kar do
            if (role.managed || role.id === guild.id) return;
            
            // Agar role kisi whitelisted member ka nahi hai ya general admin role hai
            if (role.permissions.has(PermissionFlagsBits.Administrator) || 
                role.permissions.has(PermissionFlagsBits.ManageChannels) || 
                role.permissions.has(PermissionFlagsBits.ManageRoles)) {
                
                // Check if any member with this role is whitelisted. If not, lock down permissions!
                const hasWhitelistedMember = role.members.some(m => m.id === ownerId || whitelisted.includes(m.id));
                
                if (!hasWhitelistedMember) {
                    await role.setPermissions(role.permissions.remove([
                        PermissionFlagsBits.Administrator,
                        PermissionFlagsBits.ManageChannels,
                        PermissionFlagsBits.ManageRoles,
                        PermissionFlagsBits.BanMembers,
                        PermissionFlagsBits.KickMembers
                    ])).catch(() => null);
                }
            }
        });
    } catch (e) {
        console.error('Lockdown error:', e);
    }
}

// Run lockdown check periodically and on guild events
setInterval(() => {
    client.guilds.cache.forEach(guild => enforceSecurityLockdown(guild));
}, 10 * 1000);


// ================= EVENT GUARDS =================

client.on('guildMemberAdd', async (member) => {
    try {
        if (!member.user.bot) return;

        const audit = await member.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        const allowed = await isWhitelisted(member.guild.id, executorId, member.guild.ownerId);

        if (!allowed) {
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
                    if (member.bannable) {
                        await member.roles.set([]).catch(() => null);
                        await member.ban({ reason: `🚨 Olympus Guard: Unauthorized Channel Deletion` }).catch(() => null);
                    }
                } else {
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


// ================= SLASH COMMANDS =================
client.once('clientReady', async () => {
    console.log(`🛡️ Olympus Hardcore Security Bot Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    client.guilds.cache.forEach(guild => enforceSecurityLockdown(guild));

    const commands = [
        new SlashCommandBuilder()
            .setName('antinuke')
            .setDescription('Olympus Security Management (Owner Only)')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setup')
                    .setDescription('Set log channel & enforce hard lockdown')
                    .addChannelOption(option =>
                        option.setName('channel').setDescription('Log channel').setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('whitelist')
                    .setDescription('Whitelist a user/bot')
                    .addStringOption(option =>
                        option.setName('action').setDescription('Add or Remove').setRequired(true)
                            .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' })
                    )
                    .addUserOption(option =>
                        option.setName('target').setDescription('User or Bot to whitelist').setRequired(true)
                    )
            )
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
        if (!config) config = new AntiNicoConfig({ guildId: interaction.guild.id });

        if (sub === 'setup') {
            const chan = interaction.options.getChannel('channel');
            config.logChannelId = chan.id;
            await config.save();
            
            // Enforce immediate lockdown on setup
            await enforceSecurityLockdown(interaction.guild);

            return await interaction.reply({ content: `✅ Olympus security logs set to ${chan} & **Hardcore Permission Lockdown** enforced across all roles!`, ephemeral: true });
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
                
                // Re-enforce lockdown after removing someone from whitelist
                await enforceSecurityLockdown(interaction.guild);

                return await interaction.reply({ content: `✅ Successfully removed **${target.tag}** from the whitelist and updated security lockdown.`, ephemeral: true });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
            
