const mineCooldowns = new Map();

/**
 * The function that gets executed when a user runs the !mine command.
 * @param {object} context The context object provided by the command handler.
 */
async function executeMineCommand(context) {
    const { message, db, createThemedEmbed, guildCfg } = context;
    const userId = message.author.id;

    // Cooldown check (e.g., 5 minutes)
    const cooldownTime = 5 * 60 * 1000;
    const lastUsed = mineCooldowns.get(userId);
    if (lastUsed && (Date.now() - lastUsed) < cooldownTime) {
        const remaining = Math.ceil((cooldownTime - (Date.now() - lastUsed)) / 60000);
        return message.reply(`⏳ Your mining rigs are cooling down. You can mine again in **${remaining} minute(s)**.`);
    }

    // Check if the user owns any crypto rigs
    const [rigs] = await db.query('SELECT quantity FROM user_businesses WHERE user_id = ? AND biz_id = ?', [userId, 'crypto_rig_1']);
    const rigCount = rigs.length > 0 ? rigs[0].quantity : 0;

    if (rigCount === 0) {
        return message.reply("❌ You don't own any Crypto Mining Rigs. Buy them from the `!shop` to start mining!");
    }

    // Calculate earnings
    const baseGainPerRig = 150; // Base earning per rig
    const randomFactor = Math.random() * 50; // A bit of randomness
    const totalGain = Math.floor((baseGainPerRig + randomFactor) * rigCount);

    // Update user's balance
    await db.query('UPDATE users SET balance = balance + ? WHERE user_id = ?', [totalGain, userId]);

    // Set cooldown
    mineCooldowns.set(userId, Date.now());

    // Send confirmation message
    const embed = createThemedEmbed(guildCfg.theme, {
        title: '⛏️ Crypto Mining Operation',
        description: `Your **${rigCount}** mining rig(s) successfully mined some crypto!`,
        fields: [
            { name: '💰 Earnings', value: `$${totalGain.toLocaleString()}`, inline: true }
        ],
        thumbnail: { url: 'https://i.imgur.com/tH33G9A.png' }, // A crypto-like icon
        timestamp: true,
        footer: { text: 'Economy DLC - Crypto' }
    });

    return message.reply({ embeds: [embed] });
}

module.exports = {
    // This addon doesn't need an initialize function, it just provides extensions.
    economyExtensions: {
        shopItems: [
            {
                id: 'crypto_rig_1',
                name: 'Crypto Mining Rig',
                price: 75000,
                income: 120 // This is the passive income per hour
            }
        ],
        commands: [
            {
                name: 'mine',
                description: 'Use your crypto rigs to mine for extra cash.',
                execute: executeMineCommand
            }
        ]
    }
};

