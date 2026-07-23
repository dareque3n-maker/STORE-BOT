const mongoose = require('mongoose');

const GuildConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    logChannelId: { type: String, default: null },
    whitelistedUsers: { type: [String], default: [] },
    defaultSafeRoleId: { type: String, default: null } // Adder ke sare roles strip hone ke baad ye role milega
});

module.exports = mongoose.model('GuildConfig', GuildConfigSchema);
