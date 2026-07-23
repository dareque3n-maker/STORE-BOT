const AntiNukeConfig = require('../models/AntiNukeConfig');
const BackupSnapshot = require('../models/BackupSnapshot');
const sendLog = require('./logger');

// Speed Spike Tracker for Whitelisted Bots (Map: botId -> timestamps array)
const actionTracker = new Map();

module.exports = (client) => {
    
    // 1. Unauthorized Bot Detection & Whitelisted Bot Speed Spike Handler
    client.on('guildMemberAdd', async (member) => {
        if (!member.user.bot) return;

        const fetchedLogs = await member.guild.fetchAuditLogs({ limit: 1, type: 28 });
        const botAddLog = fetchedLogs.entries.first();
        if (!botAddLog) return;
        const { executor } = botAddLog;

        let config = await AntiNukeConfig.findOne({ guildId: member.guild.id });
        if (!config) {
            config = await AntiNukeConfig.create({ guildId: member.guild.id });
        }

        const isOwner = executor.id === member.guild.ownerId;
        const isWhitelistedUser = config.whitelistedUsers.includes(executor.id);
        const isWhitelistedBot = config.whitelistedBots.includes(member.id);

        // CASE A: Bot is NOT whitelisted
        if (!isWhitelistedBot && !isWhitelistedUser && !isOwner) {
            try {
                await member.ban({ reason: "Anti-Nuke: Unauthorized bot detected." });
                await member.guild.members.ban(executor.id, { reason: "Added unauthorized bot." });

                sendLog(client, member.guild, "Unauthorized Bot Blocked", 
                    `**Bot:** ${member.user.tag} (\`${member.id}\`)\n**Inviter:** ${executor.tag} (\`${executor.id}\`)\n\n*Action:* Both bot & inviter banned.`);
            } catch (err) {
                console.error("Failed to block unauth bot:", err);
            }
        }
    });

    // 2. Channel Deletion Protection + Speed Spike / Rogue Whitelisted Bot Guard
    client.on('channelDelete', async (channel) => {
        const fetchedLogs = await channel.guild.fetchAuditLogs({ limit: 1, type: 12 });
        const deletionLog = fetchedLogs.entries.first();
        if (!deletionLog) return;

        const { executor } = deletionLog;
        if (!executor) return;

        let config = await AntiNukeConfig.findOne({ guildId: channel.guild.id });
        if (!config) config = await AntiNukeConfig.create({ guildId: channel.guild.id });

        const isOwner = executor.id === channel.guild.ownerId;
        const isWhitelistedUser = config.whitelistedUsers.includes(executor.id);
        const isWhitelistedBot = config.whitelistedBots.includes(executor.id);

        // Speed Spike Check for Whitelisted Bots / Users
        const now = Date.now();
        if (!actionTracker.has(executor.id)) actionTracker.set(executor.id, []);
        let timestamps = actionTracker.get(executor.id);
        timestamps = timestamps.filter(t => now - t < 2000); // 2 second window
        timestamps.push(now);
        actionTracker.set(executor.id, timestamps);

        const isSpeeding = timestamps.length > 1; // More than 1 action in < 2 seconds

        if (!isOwner && (!isWhitelistedUser || isSpeeding)) {
            try {
                // If it's a whitelisted bot going rogue, remove from whitelist & ban
                if (isWhitelistedBot) {
                    config.whitelistedBots = config.whitelistedBots.filter(id => id !== executor.id);
                    await config.save();
                }

                await channel.guild.members.ban(executor.id, { reason: "Anti-Nuke: Mass deletion / Rogue behavior triggered." });

                // Generate Instant Backup Snapshot for Recovery
                const restoreId = `RESTORE-${Math.floor(10000 + Math.random() * 90000)}`;
                const categories = [];
                const channelsArr = [];

                channel.guild.channels.cache.forEach(c => {
                    if (c.type === 4) { // Category
                        categories.push({ id: c.id, name: c.name, position: c.position, permissionOverwrites: Array.from(c.permissionOverwrites.cache.values()) });
                    } else {
                        channelsArr.push({
                            name: c.name,
                            type: c.type,
                            parentId: c.parentId,
                            position: c.position,
                            topic: c.topic || '',
                            bitrate: c.bitrate || null,
                            userLimit: c.userLimit || null,
                            permissionOverwrites: Array.from(c.permissionOverwrites.cache.values())
                        });
                    }
                });

                await BackupSnapshot.create({
                    guildId: channel.guild.id,
                    restoreId,
                    categories,
                    channels: channelsArr
                });

                sendLog(client, channel.guild, "Nuke Attempt Intercepted & Backup Created",
                    `**Culprit:** ${executor.tag} (\`${executor.id}\`)\n**Deleted Channel:** #${channel.name}\n\n*Action:* Culprit banned, whitelist revoked (if bot), and server snapshot created.\n**Restore Code:** \`/restore id:${restoreId}\``);

            } catch (err) {
                console.error("Anti-nuke channel delete handling failed:", err);
            }
        }
    });
};
