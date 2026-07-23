const mongoose = require('mongoose');

const AntiNukeConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    logChannelId: { type: String, default: null },
    whitelistedUsers: { type: [String], default: [] }
});

module.exports = mongoose.model('AntiNukeConfig', AntiNukeConfigSchema);
