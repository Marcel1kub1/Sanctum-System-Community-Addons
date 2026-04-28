const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');

// Store a reference to the getGuildSettings function from a complete context
let _getGuildSettings = null;

// In-memory store for lottery state. For persistence across restarts, this is loaded from and saved to a database.
const lotteryState = {
    money: { messageId: null, channelId: null, winner: null, jackpot: 'A random prize between **$1,000,000** and **$10,000,000**!' },
    level: { messageId: null, channelId: null, winner: null, jackpot: 'A massive **5,000 XP** boost!' },
    business: { messageId: null, channelId: null, winner: null, jackpot: 'A **Mining Rig Tier 50**!' }
};

const TICKET_PRICE = 10000;

/**
 * Creates the embed for a lottery panel.
 * @param {string} lotteryType - 'money', 'level', or 'business'.
 * @param {object} context - The command context.
 * @param {object} lotteryInfo - Information about the lottery.
 * @returns {object} An object containing the embed and components.
 */
async function createLotteryPanel(lotteryType, context, lotteryInfo) {
    const { createThemedEmbed, guildCfg, db } = context;
    const { jackpot, winner } = lotteryInfo;

    const [ticketCountResult] = await db.query('SELECT COUNT(*) as count FROM lottery_tickets WHERE lottery_type = ?', [lotteryType]);
    const ticketsSold = ticketCountResult[0].count;

    const titles = {
        money: '💰 Weekly Money Lottery',
        level: '📈 Weekly Level Lottery',
        business: '🏢 Weekly Business Lottery'
    };

    const descriptions = {
        money: 'Buy a ticket for a chance to win a massive cash prize!',
        level: 'Feeling slow? Buy a ticket to win a huge XP boost!',
        business: 'Expand your empire! Win a random high-tier business.'
    };

    const embed = createThemedEmbed(guildCfg.theme, {
        title: titles[lotteryType],
        description: descriptions[lotteryType],
        fields: [
            { name: '🏆 Jackpot', value: jackpot, inline: false },
            { name: '🎟️ Ticket Price', value: `$${TICKET_PRICE.toLocaleString()}`, inline: true },
            { name: '🎫 Tickets Sold', value: ticketsSold.toLocaleString(), inline: true },
        ],
        footer: { text: 'Drawing every Friday at 8 PM!' }
    });

    if (winner) {
        embed.addFields({ name: '🎉 Last Winner', value: `<@${winner.userId}> won ${winner.prize}!`, inline: false });
        embed.setColor('#FFD700'); // Gold for winner
    }

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`lottery_buy_${lotteryType}`)
                .setLabel('Buy Ticket')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🎟️')
                .setDisabled(!!winner) // Disable button if a winner has been drawn for the week
        );

    return { embeds: [embed], components: [row] };
}

/**
 * Sends or updates a specific lottery panel.
 * @param {string} type The lottery type.
 * @param {object} context The bot context.
 * @param {boolean} isNewWeek If true, sends a new message. Otherwise, edits the existing one.
 */
async function updatePanel(type, context, isNewWeek = false) {
    const { client, guildCfg, db } = context;
    if (!guildCfg.lotteryChannelId) return;

    const channel = await client.channels.fetch(guildCfg.lotteryChannelId).catch(() => null);
    if (!channel) {
        console.error(`Could not find lottery channel with ID: ${guildCfg.lotteryChannelId}`);
        return;
    }

    const panelData = await createLotteryPanel(type, context, {
        jackpot: lotteryState[type].jackpot,
        winner: lotteryState[type].winner
    });

    try {
        if (!isNewWeek && lotteryState[type].messageId) {
            const message = await channel.messages.fetch(lotteryState[type].messageId).catch(() => null);
            if (message) {
                await message.edit(panelData);
                return;
            }
        }

        // Send new message
        const sentMessage = await channel.send(panelData);
        lotteryState[type].messageId = sentMessage.id;
        lotteryState[type].channelId = sentMessage.channel.id;
        await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['lottery', `messageId_${type}`, sentMessage.id]);
        await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['lottery', `channelId_${type}`, sentMessage.channel.id]);

    } catch (error) {
        console.error(`Failed to send/update lottery panel for ${type}:`, error);
    }
}

/**
 * Draws a winner for a specific lottery.
 * @param {string} lotteryType - 'money', 'level', or 'business'.
 * @param {object} context - The command context.
 */
async function drawWinner(lotteryType, context) {
    const { db, client, createThemedEmbed, guildCfg } = context;

    const [tickets] = await db.query('SELECT user_id FROM lottery_tickets WHERE lottery_type = ?', [lotteryType]);

    if (tickets.length === 0) {
        lotteryState[lotteryType].winner = { userId: 'No one', prize: 'No tickets were sold!' };
        console.log(`Lottery (${lotteryType}): No tickets sold, no winner drawn.`);
        return;
    }

    const winnerId = tickets[Math.floor(Math.random() * tickets.length)].user_id;
    const winnerUser = await client.users.fetch(winnerId).catch(() => null);
    let prizeDescription = '';

    // Award prize
    switch (lotteryType) {
        case 'money':
            const winnings = Math.floor(Math.random() * (10000000 - 1000000 + 1)) + 1000000;
            await db.query('UPDATE users SET balance = balance + ? WHERE user_id = ?', [winnings, winnerId]);
            prizeDescription = `$${winnings.toLocaleString()}`;
            break;
        case 'level':
            const xpGain = 5000;
            await db.query('UPDATE users SET xp = xp + ? WHERE user_id = ?', [xpGain, winnerId]);
            prizeDescription = `${xpGain.toLocaleString()} XP`;
            break;
        case 'business':
            const businessId = 'crypto_50';
            const businessName = 'Mining Rig Tier 50';
            await db.query(
                'INSERT INTO user_businesses (user_id, biz_id, quantity) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE quantity = quantity + 1',
                [winnerId, businessId]
            );
            prizeDescription = `1x ${businessName}`;
            break;
    }

    lotteryState[lotteryType].winner = { userId: winnerId, prize: prizeDescription };

    const channel = await client.channels.fetch(guildCfg.lotteryChannelId).catch(() => null);
    if (channel && winnerUser) {
        const winEmbed = createThemedEmbed(guildCfg.theme, {
            title: `🎉 Lottery Winner! 🎉`,
            description: `Congratulations to <@${winnerId}> for winning the **${lotteryType} lottery**!`,
            fields: [{ name: 'Prize Won', value: prizeDescription }],
            thumbnail: { url: winnerUser.displayAvatarURL() }
        });
        await channel.send({ content: `<@${winnerId}>`, embeds: [winEmbed] });
    }

    console.log(`Lottery (${lotteryType}): Winner is ${winnerId}, who won ${prizeDescription}.`);
}

/**
 * Handles the !lottery-send command to manually reset and send panels.
 * @param {object} context The command context from the command handler.
 */
async function handleLotterySend(context) {
    const { message, isStaff, getDbByGuild } = context;
    const getGuildSettings = context.getGuildSettings || _getGuildSettings;

    if (!isStaff) {
        return message.reply('❌ You must be a staff member to use this command.');
    }

    await message.reply({ content: '🔄 Resetting lotteries and sending new panels...' });

    if (typeof getGuildSettings !== 'function') {
        console.error('[Lottery] getGuildSettings function is not available. Cannot process command.');
        return message.channel.send('❌ An internal error occurred: The configuration loader is not available.');
    }

    const db = await getDbByGuild(message.guild.id);
    if (!db) {
        console.error(`[Lottery] No database connection available for guild ${message.guild.id}. Cannot process command.`);
        return message.channel.send('❌ An internal error occurred: database connection unavailable.');
    }

    const guildCfg = await getGuildSettings(message.guild.id);
    const fullContextForCommand = {
        ...context, // Includes getDbByGuild, createThemedEmbed
        client: message.client, // Get client from the message object
        db,
        guildCfg,
        getGuildSettings // Pass the resolved function
    };

    console.log(`Manual lottery panel send triggered by staff: ${message.author.tag}`);
    
    // Reset in-memory state
    for (const type in lotteryState) {
        lotteryState[type].winner = null;
    }
    
    // Clear tickets from DB
    await db.query('DELETE FROM lottery_tickets');

    // Send new panels for each lottery type
    for (const type of ['money', 'level', 'business']) {
        await updatePanel(type, fullContextForCommand, true);
    }

    return message.channel.send('✅ New lottery panels have been sent successfully.');
}

let initialized = false;

module.exports = {
    name: "Lottery",
    description: "Weekly lotteries for money, levels, and businesses.",

    async initialize(client, guildId, context) {
        // Capture the getGuildSettings function from the context provided at initialization.
        if (!_getGuildSettings && typeof context.getGuildSettings === 'function') {
            _getGuildSettings = context.getGuildSettings;
        }

        if (initialized) {
            return; // Prevent re-initialization and multiple cron jobs
        }
        initialized = true;

        const { getDbByGuild, getGuildSettings } = context;
        const db = await getDbByGuild(guildId);

        if (!db) {
            console.error(`[Lottery] No database connection available for guild ${guildId}. Addon cannot function.`);
            initialized = false; // Allow re-initialization attempt later
            return; // Cannot proceed without a DB connection
        }

        // We build a more complete context object for the addon's functions to use.
        const guildCfg = await getGuildSettings(guildId); // Get guild settings
        const fullContext = {
            ...context,
            client,
            db, // Add the obtained db connection to the fullContext
            guildCfg
        };

        console.log("Initializing Lottery Addon...");

        // It's recommended to create these tables in your database manually.
        // CREATE TABLE IF NOT EXISTS `lottery_tickets` (`user_id` VARCHAR(25) NOT NULL, `lottery_type` VARCHAR(20) NOT NULL, INDEX `user_lottery` (`user_id`, `lottery_type`));
        // CREATE TABLE IF NOT EXISTS `addon_storage` (`addon_name` VARCHAR(50) NOT NULL, `key` VARCHAR(50) NOT NULL, `value` TEXT, PRIMARY KEY (`addon_name`, `key`));

        const [storedState] = await db.query("SELECT `key`, `value` FROM addon_storage WHERE addon_name = 'lottery'");
        for (const row of storedState) {
            const type = row.key.replace(/messageId_|channelId_/, '');
            if (lotteryState[type]) {
                if (row.key.startsWith('messageId_')) lotteryState[type].messageId = row.value;
                if (row.key.startsWith('channelId_')) lotteryState[type].channelId = row.value;
            }
        }

        // Schedule to post new lottery panels every Monday at 9 AM
        cron.schedule('0 9 * * 1', async () => {
            console.log("Running Monday lottery reset...");
            for (const type in lotteryState) {
                lotteryState[type].winner = null;
            }
            await db.query('DELETE FROM lottery_tickets');
            for (const type of ['money', 'level', 'business']) {
                await updatePanel(type, fullContext, true);
            }
        }, { scheduled: true, timezone: "Europe/Berlin" });

        // Schedule to draw winners every Friday at 8 PM
        cron.schedule('0 20 * * 5', async () => {
            console.log("Running Friday lottery drawing...");
            for (const type of ['money', 'level', 'business']) {
                await drawWinner(type, fullContext);
                await updatePanel(type, fullContext);
            }
        }, { scheduled: true, timezone: "Europe/Berlin" });

        console.log("Lottery Addon initialized with cron jobs.");
    },

    economyExtensions: {
        commands: [
            {
                name: 'lottery-send',
                description: 'Manually sends or resets the weekly lottery panels. (Staff only)',
                execute: handleLotterySend
            }
        ],
        async onInteraction(interaction, context) {
            if (!interaction.isButton() || !interaction.customId.startsWith('lottery_buy_')) return;

            await interaction.deferReply({ ephemeral: true });

            const userId = interaction.user.id;
            const lotteryType = interaction.customId.replace('lottery_buy_', '');

            const { getDbByGuild } = context;
            const getGuildSettings = context.getGuildSettings || _getGuildSettings;

            if (typeof getDbByGuild !== 'function' || typeof getGuildSettings !== 'function') {
                console.error('[Lottery] Incomplete context for interaction. Missing getDbByGuild or getGuildSettings.');
                return interaction.editReply({ content: '❌ An internal error occurred: The context for this interaction is incomplete.' });
            }

            const db = await getDbByGuild(interaction.guild.id);
            if (!db) {
                console.error(`[Lottery] No database connection available for guild ${interaction.guild.id}. Cannot process interaction.`);
                return interaction.editReply({ content: '❌ An internal error occurred: database connection unavailable.' });
            }

            // Reconstruct fullContext for updatePanel call
            const guildCfg = await getGuildSettings(interaction.guild.id);
            const interactionFullContext = { ...context, client: interaction.client, db, guildCfg, getGuildSettings };

            const [[user]] = await db.query('SELECT balance FROM users WHERE user_id = ?', [userId]);

            if (!user || user.balance < TICKET_PRICE) {
                return interaction.editReply({ content: `❌ You don't have enough money! You need **$${TICKET_PRICE.toLocaleString()}**.`, ephemeral: true });
            }

            await db.query('UPDATE users SET balance = balance - ? WHERE user_id = ?', [TICKET_PRICE, userId]);
            await db.query('INSERT INTO lottery_tickets (user_id, lottery_type) VALUES (?, ?)', [userId, lotteryType]);

            await interaction.editReply({ content: `✅ You bought 1 ticket for the **${lotteryType} lottery**! Good luck!`, ephemeral: true });

            // Update the panel in the background
            updatePanel(lotteryType, interactionFullContext).catch(e => console.error("Failed to update lottery panel post-purchase:", e));
        }
    }
};