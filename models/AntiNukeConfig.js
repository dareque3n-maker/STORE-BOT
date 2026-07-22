const mongoose = require('mongoose');

const AntiNukeSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    logChannelId: { type: String, default: null },
    whitelistedUsers: { type: [String], default: [] },
    
    // Emergency Triggered Snapshot & Transcript (Auto-delete after 10 mins)
    emergencyBackups: [{
        backupId: String,
        createdAt: { type: Date, default: Date.now, expires: 600 }, // 600 seconds = 10 minutes
        deletedChannelName: String,
        transcript: String,
        channelData: Object
    }]
});

module.exports = mongoose.model('AntiNukeConfig', AntiNukeSchema);
