const mongoose = require('mongoose');

const AntiNukeSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    logChannelId: { type: String, default: null },
    whitelistedUsers: { type: [String], default: [] },
    
    // Rolling & Locked Emergency Backups (Auto-managed)
    backups: [{
        backupId: String,
        timestamp: { type: Date, default: Date.now },
        data: Object
    }]
});

module.exports = mongoose.model('AntiNukeConfig', AntiNukeSchema);
