const mongoose = require('mongoose');

const AntiNukeSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    logChannelId: { type: String, default: null },
    
    // Whitelisted Users (Admins/Owner who can delete without trigger)
    whitelistedUsers: { type: [String], default: [] },

    // Limits within a 10-second window
    maxChannelDelete: { type: Number, default: 2 },
    maxRoleDelete: { type: Number, default: 2 },
    maxBans: { type: Number, default: 3 },
    maxKicks: { type: Number, default: 3 }
});

module.exports = mongoose.model('AntiNukeConfig', AntiNukeSchema);
