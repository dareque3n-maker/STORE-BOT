const mongoose = require('mongoose');

const antiNukeConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    logChannelId: { type: String, default: null },
    whitelistedBots: { type: [String], default: [] },
    whitelistedUsers: { type: [String], default: [] }
});

module.exports = mongoose.model('AntiNukeConfig', antiNukeConfigSchema);
