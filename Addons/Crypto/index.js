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
        return message.reply(`⏳ Your crypto assets are cooling down. You can mine again in **${remaining} minute(s)**.`);
    }

    // Get all crypto items defined in this addon
    const cryptoItems = module.exports.economyExtensions.shopItems;
    const cryptoItemIds = cryptoItems.map(item => item.id);

    // Check if the user owns any crypto assets
    const [ownedAssets] = await db.query('SELECT biz_id, quantity FROM user_businesses WHERE user_id = ? AND biz_id IN (?)', [userId, [cryptoItemIds]]);

    if (ownedAssets.length === 0) {
        return message.reply("❌ You don't own any crypto assets. Buy a 'Mining Rig Tier 1' from the `!shop` to start mining!");
    }

    // Calculate total mining power
    let totalMiningPower = 0;
    let ownedAssetSummary = [];
    for (const asset of ownedAssets) {
        const itemDetails = cryptoItems.find(i => i.id === asset.biz_id);
        if (itemDetails && itemDetails.miningPower) {
            totalMiningPower += itemDetails.miningPower * asset.quantity;
            ownedAssetSummary.push(`- ${asset.quantity}x ${itemDetails.name}`);
        }
    }

    if (totalMiningPower === 0) {
        return message.reply("❌ You don't own any crypto assets that can be used for mining. Buy them from the `!shop`!");
    }

    // Calculate earnings based on total mining power
    const baseGainPerPower = 150; // Base earning per mining power point
    const randomFactor = Math.random() * 50; // A bit of randomness for variety
    const totalGain = Math.floor((baseGainPerPower * totalMiningPower) + (randomFactor * totalMiningPower));

    // Update user's balance
    await db.query('UPDATE users SET balance = balance + ? WHERE user_id = ?', [totalGain, userId]);

    // Set cooldown
    mineCooldowns.set(userId, Date.now());

    // Send confirmation message
    const embed = createThemedEmbed(guildCfg.theme, {
        title: '⛏️ Crypto Mining Operation',
        description: `Your crypto empire whirs to life, generating a new block!`,
        fields: [
            { name: '💰 Earnings', value: `$${totalGain.toLocaleString()}`, inline: true },
            { name: '⚡ Mining Power', value: `${totalMiningPower} TH/s`, inline: true },
            { name: 'Active Assets', value: ownedAssetSummary.join('\n'), inline: false }
        ],
        thumbnail: { url: 'https://i.imgur.com/tH33G9A.png' }, // A crypto-like icon
        timestamp: true,
        footer: { text: 'Economy DLC - Crypto' }
    });

    return message.reply({ embeds: [embed] });
}

/**
 * Generates the full list of upgradable crypto items.
 * @returns {Array<object>} A list of shop item objects.
 */
function generateCryptoItems() {
    const items = [];
    const maxLevel = 100;

    const nameTiers = [
        { level: 100, name: "Singularity Core" },
        { level: 76, name: "Quantum Node" },
        { level: 51, name: "Supercomputer" },
        { level: 26, name: "Data Center" },
        { level: 11, name: "Mining Farm" },
        { level: 1, name: "Mining Rig" },
    ];

    for (let i = 1; i <= maxLevel; i++) {
        // Determine the name based on tier, finding the highest tier below or equal to current level
        const currentNameTier = nameTiers.find(t => i >= t.level);
        const name = currentNameTier.name;

        // Scalable pricing, income, and mining power.
        // Using an exponential curve to make high-end items very expensive.
        const price = Math.floor(Math.pow(i, 2.5) * 1000 + (i * 5000));
        const income = Math.floor(price * 0.045); // Passive income per hour
        const miningPower = i; // Active income from !mine command scales linearly with tier

        items.push({
            id: `crypto_${i}`,
            name: `${name} Tier ${i}`,
            price: price,
            income: income,
            miningPower: miningPower
        });
    }
    return items;
}

module.exports = {
    // This addon doesn't need an initialize function, it just provides extensions.
    economyExtensions: {
        shopItems: generateCryptoItems(),
        commands: [
            {
                name: 'mine',
                description: 'Use your crypto rigs to mine for extra cash.',
                execute: executeMineCommand
            }
        ]
    }
};
