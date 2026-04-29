const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    PermissionFlagsBits,
    ChannelSelectMenuBuilder,
    StringSelectMenuBuilder
} = require('discord.js');

let globalContext = null;

/**
 * Fetches the application configuration from the server's database.
 * @param {object} db The database connection.
 * @returns {Promise<object>} The configuration.
 */
async function getAppConfig(db) {
    const config = {
        submissionChannelId: null,
        q1: "What is your age?",
        q2: "Why do you want to be staff?",
        q3: "What is your previous experience?",
        q4: "How would you handle a spamming user?",
        q5: "Timezone & availability?",
        reminderChannelId: null,
        reminderEnabled: 'false',
        panelChannelId: null,
        panelMessageId: null,
        applicationsOpen: 'true'
    };
    try {
        const [rows] = await db.query("SELECT `key`, `value` FROM addon_storage WHERE addon_name = 'applications'");
        for (const row of rows) {
            if (row.key === 'submissionChannelId') config.submissionChannelId = row.value;
            if (row.key === 'q1') config.q1 = row.value;
            if (row.key === 'q2') config.q2 = row.value;
            if (row.key === 'q3') config.q3 = row.value;
            if (row.key === 'q4') config.q4 = row.value;
            if (row.key === 'q5') config.q5 = row.value;
            if (row.key === 'reminderChannelId') config.reminderChannelId = row.value;
            if (row.key === 'reminderEnabled') config.reminderEnabled = row.value;
            if (row.key === 'panelChannelId') config.panelChannelId = row.value;
            if (row.key === 'panelMessageId') config.panelMessageId = row.value;
            if (row.key === 'applicationsOpen') config.applicationsOpen = row.value;
        }
    } catch (e) {
        console.error("[Applications] Warning: Could not fetch config (table might not exist yet). Using defaults.");
    }
    return config;
}

/**
 * Generates the setup panel embed and components.
 * @param {object} config The current application configuration.
 * @param {object} context The bot context.
 * @returns {object} The message options.
 */
async function generateSetupMessage(config, context) {
    const { createThemedEmbed, guildCfg } = context;
    
    let panelStatus = 'Not deployed';
    if (config.panelChannelId && config.panelMessageId) {
        panelStatus = `<#${config.panelChannelId}> (Jump to Message)`;
    }

    let reminderStatus = config.reminderEnabled === 'true' ? '✅ Enabled' : '❌ Disabled';
    let appStatus = config.applicationsOpen === 'true' ? '🟢 Open' : '🔴 Closed';

    const embed = createThemedEmbed(guildCfg.theme, {
        title: '⚙️ Applications System Setup',
        description: 'Configure your application system using the menus below.\nChanges are saved automatically.',
        fields: [
            { name: 'Application Status', value: appStatus, inline: false },
            { name: 'Submission Channel', value: config.submissionChannelId ? `<#${config.submissionChannelId}>` : 'Not set', inline: false },
            { name: 'Deployed Panel', value: panelStatus, inline: false },
            { name: 'Automated Reminder', value: `Channel: ${config.reminderChannelId ? `<#${config.reminderChannelId}>` : 'Not set'}\nStatus: ${reminderStatus}`, inline: false },
            { name: 'Question 1', value: config.q1 || 'Not set', inline: false },
            { name: 'Question 2', value: config.q2 || 'Not set', inline: false },
            { name: 'Question 3', value: config.q3 || 'Not set', inline: false },
            { name: 'Question 4', value: config.q4 || 'Not set', inline: false },
            { name: 'Question 5', value: config.q5 || 'Not set', inline: false },
        ],
        color: '#5865F2'
    });

    const row1 = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId('app_setup_sub_channel')
            .setPlaceholder('Select Submission Channel (Where applications go)')
            .setChannelTypes(ChannelType.GuildText)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('app_setup_edit_question')
            .setPlaceholder('Edit a Question...')
            .addOptions([
                { label: 'Question 1', value: 'q1', description: 'Edit the 1st question on the form' },
                { label: 'Question 2', value: 'q2', description: 'Edit the 2nd question on the form' },
                { label: 'Question 3', value: 'q3', description: 'Edit the 3rd question on the form' },
                { label: 'Question 4', value: 'q4', description: 'Edit the 4th question on the form' },
                { label: 'Question 5', value: 'q5', description: 'Edit the 5th question on the form' },
            ])
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId('app_setup_deploy_channel')
            .setPlaceholder('Deploy / Resend "Apply Now" Panel to Channel...')
            .setChannelTypes(ChannelType.GuildText)
    );

    const row4 = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId('app_setup_reminder_channel')
            .setPlaceholder('Select Daily Reminder Channel...')
            .setChannelTypes(ChannelType.GuildText)
    );

    const row5 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('app_setup_toggle_status')
            .setLabel(config.applicationsOpen === 'true' ? 'Close Applications' : 'Open Applications')
            .setStyle(config.applicationsOpen === 'true' ? ButtonStyle.Danger : ButtonStyle.Success)
            .setEmoji(config.applicationsOpen === 'true' ? '🔒' : '🔓'),
        new ButtonBuilder()
            .setCustomId('app_setup_toggle_reminder')
            .setLabel(config.reminderEnabled === 'true' ? 'Disable Reminders' : 'Enable Reminders')
            .setStyle(config.reminderEnabled === 'true' ? ButtonStyle.Danger : ButtonStyle.Success)
            .setEmoji('⏰'),
        new ButtonBuilder()
            .setCustomId('app_setup_delete_panel')
            .setLabel('Delete Deployed Panel')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🗑️'),
        new ButtonBuilder()
            .setCustomId('app_setup_close')
            .setLabel('Close Setup')
            .setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

/**
 * Background function to check inactivity and send the reminder panel.
 */
async function checkAndSendReminder(client, guildId, context) {
    try {
        const { getDbByGuild, getGuildSettings } = context;
        const db = await getDbByGuild(guildId);
        if (!db) return;

        const config = await getAppConfig(db);
        if (config.applicationsOpen !== 'true' || config.reminderEnabled !== 'true' || !config.reminderChannelId) return;

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(config.reminderChannelId);
        if (!channel) return;

        const messages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
        const lastMsg = messages?.first();
        if (!lastMsg) return; // If channel is completely empty, don't trigger.

        const hoursSinceLastMsg = (Date.now() - lastMsg.createdTimestamp) / (1000 * 60 * 60);
        
        // 7 hours of inactivity required
        if (hoursSinceLastMsg >= 7) {
            // Prevent sending a reminder more than once every 24 hours
            const lastReminder = config.lastReminderTime ? parseInt(config.lastReminderTime) : 0;
            const hoursSinceReminder = (Date.now() - lastReminder) / (1000 * 60 * 60);

            if (hoursSinceReminder >= 24) {
                const guildCfg = await getGuildSettings(guildId);
                const fullContext = { ...context, client, db, guildCfg };
                
                const embed = fullContext.createThemedEmbed(guildCfg.theme, {
                    title: '👋 We are looking for Staff!',
                    description: 'Wanna be a staff member for our community? Then join the staff team now!\n\nClick the button below to start your application.',
                    color: '#5865F2',
                    footer: { text: `Automated Reminder` }
                });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('application_start').setLabel('Apply Now').setStyle(ButtonStyle.Primary).setEmoji('📄')
                );

                await channel.send({ embeds: [embed], components: [row] });
                
                // Save the new reminder time
                await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['applications', 'lastReminderTime', Date.now().toString()]);
            }
        }
    } catch (err) {
        console.error(`[Applications] Reminder check failed for guild ${guildId}:`, err);
    }
}

/**
 * Handles the master !applications command.
 * @param {object} context The command context.
 */
async function handleApplicationsCommand(context) {
    const { message, db } = context;

    // Admin check
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply('❌ You must be an Administrator to use this command.');
    }

    const config = await getAppConfig(db);
    const setupMsg = await generateSetupMessage(config, context);
    return message.reply(setupMsg);
}

/**
 * Creates and shows the application modal.
 * @param {import('discord.js').ButtonInteraction} interaction The button interaction.
 * @param {object} context The bot context.
 */
async function showApplicationModal(interaction, context) {
    const { db } = context;
    const config = await getAppConfig(db);

    const modal = new ModalBuilder()
        .setCustomId('application_submit_modal')
        .setTitle('Staff Application Form');

    // Add questions to the modal
    const q1 = new TextInputBuilder().setCustomId('app_question_1').setLabel(config.q1).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
    const q2 = new TextInputBuilder().setCustomId('app_question_2').setLabel(config.q2).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    const q3 = new TextInputBuilder().setCustomId('app_question_3').setLabel(config.q3).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    const q4 = new TextInputBuilder().setCustomId('app_question_4').setLabel(config.q4).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    const q5 = new TextInputBuilder().setCustomId('app_question_5').setLabel(config.q5).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);

    modal.addComponents(
        new ActionRowBuilder().addComponents(q1),
        new ActionRowBuilder().addComponents(q2),
        new ActionRowBuilder().addComponents(q3),
        new ActionRowBuilder().addComponents(q4),
        new ActionRowBuilder().addComponents(q5)
    );

    await interaction.showModal(modal);
}

/**
 * Handles the submission of the application modal.
 * @param {import('discord.js').ModalSubmitInteraction} interaction The modal submission interaction.
 * @param {object} context The bot context.
 */
async function handleApplicationSubmit(interaction, context) {
    const { client, createThemedEmbed, guildCfg, db } = context;
    
    const config = await getAppConfig(db);

    if (!config.submissionChannelId) {
        console.error("[Applications] Submission channel ID is not configured.");
        return interaction.editReply({ content: '❌ An error occurred. The submission channel is not configured. Please contact an administrator.' });
    }

    const submissionChannel = await client.channels.fetch(config.submissionChannelId).catch(() => null);
    if (!submissionChannel) {
        console.error(`[Applications] Could not find submission channel with ID: ${config.submissionChannelId}`);
        return interaction.editReply({ content: '❌ An error occurred. The submission channel could not be found. Please contact an administrator.' });
    }

    const a1 = interaction.fields.getTextInputValue('app_question_1');
    const a2 = interaction.fields.getTextInputValue('app_question_2');
    const a3 = interaction.fields.getTextInputValue('app_question_3');
    const a4 = interaction.fields.getTextInputValue('app_question_4');
    const a5 = interaction.fields.getTextInputValue('app_question_5');

    const submissionEmbed = createThemedEmbed(guildCfg.theme, {
        author: { name: `New Application from ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() },
        title: 'Staff Application Submission',
        color: '#2ECC71',
        fields: [
            { name: 'Applicant', value: `${interaction.user} (${interaction.user.id})`, inline: false },
            { name: config.q1 || 'Question 1', value: a1 || 'No answer provided', inline: false },
            { name: config.q2 || 'Question 2', value: `\`\`\`${a2 || 'No answer provided'}\`\`\``, inline: false },
            { name: config.q3 || 'Question 3', value: `\`\`\`${a3 || 'No answer provided'}\`\`\``, inline: false },
            { name: config.q4 || 'Question 4', value: `\`\`\`${a4 || 'No answer provided'}\`\`\``, inline: false },
            { name: config.q5 || 'Question 5', value: a5 || 'No answer provided', inline: false },
        ],
        timestamp: new Date(),
        footer: { text: `Application System` }
    });

    try {
        await submissionChannel.send({ embeds: [submissionEmbed] });
        await interaction.editReply({ content: '✅ Your application has been submitted successfully! We will review it shortly.' });
    } catch (error) {
        console.error('[Applications] Failed to send submission embed:', error);
        await interaction.editReply({ content: '❌ There was an error sending your application. Please try again later or contact an administrator.' });
    }
}

/**
 * Handles all interactions for the Applications System.
 * @param {import('discord.js').Interaction} interaction
 */
async function applicationsInteractionCreate(interaction) {
    if (!interaction.customId) return;
    
    // Early exit: Only fetch the database if this interaction belongs to the Application Addon
    const isAppInteraction = interaction.customId === 'application_start' || 
                             interaction.customId === 'application_submit_modal' || 
                             interaction.customId.startsWith('app_setup_');
    if (!isAppInteraction) return;

    // 1. EARLY DEFERRAL: Instantly tell Discord to wait so it doesn't fail the interaction
    try {
        if (interaction.isChannelSelectMenu() || (interaction.isModalSubmit() && interaction.customId.startsWith('app_setup_q_modal_')) || (interaction.isButton() && interaction.customId.startsWith('app_setup_'))) {
            await interaction.deferUpdate();
        } else if (interaction.isModalSubmit() && interaction.customId === 'application_submit_modal') {
            await interaction.deferReply({ ephemeral: true });
        }
    } catch (err) {
        console.error("[Applications] Failed to defer interaction:", err);
        return;
    }

    // 2. Fetch the database connection securely
    const { getDbByGuild, getGuildSettings } = globalContext;
    const db = await getDbByGuild(interaction.guild.id);
    if (!db) {
        const errorMsg = { content: '❌ Database connection failed.', ephemeral: true };
        return interaction.deferred ? interaction.followUp(errorMsg) : interaction.reply(errorMsg);
    }

    // 3. Process the component action
    if (interaction.isButton() && interaction.customId === 'application_start') {
        const config = await getAppConfig(db);
        if (config.applicationsOpen !== 'true') {
            return interaction.reply({ content: '❌ Applications are currently closed. Please check back later!', ephemeral: true });
        }
        if (!config.submissionChannelId) {
            return interaction.reply({ content: '❌ The application system has not been fully configured. Please contact an administrator.', ephemeral: true });
        }
        await showApplicationModal(interaction, { db });
        
    } else if (interaction.isButton() && interaction.customId.startsWith('app_setup_')) {
        const guildCfg = await getGuildSettings(interaction.guild.id);
        const fullContext = { ...globalContext, client: interaction.client, db, guildCfg };

        if (interaction.customId === 'app_setup_close') {
            await interaction.deleteReply().catch(async () => {
                await interaction.message.delete().catch(() => {});
            });
            return;
        } else if (interaction.customId === 'app_setup_toggle_status') {
            const config = await getAppConfig(db);
            const newState = config.applicationsOpen === 'true' ? 'false' : 'true';
            await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['applications', 'applicationsOpen', newState]);
            if (newState === 'false') {
                await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['applications', 'reminderEnabled', 'false']);
            }
            const updatedConfig = await getAppConfig(db);
            await interaction.editReply(await generateSetupMessage(updatedConfig, fullContext));
            return;
        } else if (interaction.customId === 'app_setup_toggle_reminder') {
            const config = await getAppConfig(db);
            const newState = config.reminderEnabled === 'true' ? 'false' : 'true';
            await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['applications', 'reminderEnabled', newState]);
            const updatedConfig = await getAppConfig(db);
            await interaction.editReply(await generateSetupMessage(updatedConfig, fullContext));
        } else if (interaction.customId === 'app_setup_delete_panel') {
            const config = await getAppConfig(db);
            if (config.panelChannelId && config.panelMessageId) {
                const channel = interaction.guild.channels.cache.get(config.panelChannelId);
                if (channel) await channel.messages.delete(config.panelMessageId).catch(() => {});
                await db.query("DELETE FROM addon_storage WHERE addon_name = 'applications' AND `key` IN ('panelChannelId', 'panelMessageId')");
                const updatedConfig = await getAppConfig(db);
                await interaction.editReply(await generateSetupMessage(updatedConfig, fullContext));
                await interaction.followUp({ content: '✅ Deployed panel has been deleted.', ephemeral: true });
            } else {
                await interaction.followUp({ content: '❌ No panel is currently deployed.', ephemeral: true });
            }
        }

    } else if (interaction.isChannelSelectMenu()) {
        // Now we can safely load the heavy server settings because we already deferred!
        const guildCfg = await getGuildSettings(interaction.guild.id);
        const fullContext = { ...globalContext, client: interaction.client, db, guildCfg };
        
        try {
            if (interaction.customId === 'app_setup_sub_channel') {
                const channelId = interaction.values[0];
                await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['applications', 'submissionChannelId', channelId]);
                const updatedConfig = await getAppConfig(db);
                await interaction.editReply(await generateSetupMessage(updatedConfig, fullContext));
            } else if (interaction.customId === 'app_setup_deploy_channel') {
                const channelId = interaction.values[0];
                const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
                
                if (!channel) return interaction.followUp({ content: '❌ Channel not found.', ephemeral: true });

                // Delete the old panel if one exists
                const config = await getAppConfig(db);
                if (config.panelChannelId && config.panelMessageId) {
                    const oldChannel = interaction.guild.channels.cache.get(config.panelChannelId);
                    if (oldChannel) await oldChannel.messages.delete(config.panelMessageId).catch(() => {});
                }

                const embed = fullContext.createThemedEmbed(guildCfg.theme, {
                    title: '📝 Staff Applications',
                    description: 'Interested in joining our staff team? Click the button below to open an application form.\n\nPlease ensure you meet all requirements before applying and answer all questions honestly and to the best of your ability.',
                    color: '#5865F2', 
                    footer: { text: `${interaction.guild.name} | Application System` }
                });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('application_start').setLabel('Apply Now').setStyle(ButtonStyle.Primary).setEmoji('📄')
                );

                const panelMsg = await channel.send({ embeds: [embed], components: [row] });
                await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['applications', 'panelChannelId', channel.id]);
                await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['applications', 'panelMessageId', panelMsg.id]);
                
                const updatedConfig = await getAppConfig(db);
                await interaction.editReply(await generateSetupMessage(updatedConfig, fullContext));
                await interaction.followUp({ content: `✅ Application panel deployed to ${channel}!`, ephemeral: true });
            } else if (interaction.customId === 'app_setup_reminder_channel') {
                const channelId = interaction.values[0];
                await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['applications', 'reminderChannelId', channelId]);
                // Automatically enable reminders if a channel is selected
                await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['applications', 'reminderEnabled', 'true']);
                const updatedConfig = await getAppConfig(db);
                await interaction.editReply(await generateSetupMessage(updatedConfig, fullContext));
            }
        } catch (error) {
            console.error("[Applications] Error processing Channel Select Menu:", error);
            await interaction.followUp({ content: '❌ An error occurred. Make sure your database table was successfully created.', ephemeral: true });
        }
        
    } else if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'app_setup_edit_question') {
            try {
                const qKey = interaction.values[0];
                const config = await getAppConfig(db);
                
                const modal = new ModalBuilder().setCustomId(`app_setup_q_modal_${qKey}`).setTitle(`Edit ${qKey.toUpperCase()}`);
                const textInput = new TextInputBuilder().setCustomId('new_question_text').setLabel('Question Text (Max 45 chars)').setStyle(TextInputStyle.Short).setMaxLength(45).setRequired(true).setValue(config[qKey] || '');

                modal.addComponents(new ActionRowBuilder().addComponents(textInput));
                await interaction.showModal(modal);
            } catch (error) {
                console.error("[Applications] Error launching Question modal:", error);
            }
        }
        
    } else if (interaction.isModalSubmit()) {
        const guildCfg = await getGuildSettings(interaction.guild.id);
        const fullContext = { ...globalContext, client: interaction.client, db, guildCfg };

        if (interaction.customId === 'application_submit_modal') {
            await handleApplicationSubmit(interaction, fullContext);
        } else if (interaction.customId.startsWith('app_setup_q_modal_')) {
            try {
                const qKey = interaction.customId.split('_').pop();
                const newText = interaction.fields.getTextInputValue('new_question_text');
                await db.query('REPLACE INTO addon_storage (addon_name, `key`, `value`) VALUES (?, ?, ?)', ['applications', qKey, newText]);
                const updatedConfig = await getAppConfig(db);
                await interaction.editReply(await generateSetupMessage(updatedConfig, fullContext));
            } catch (error) {
                console.error("[Applications] Error saving Question:", error);
                await interaction.followUp({ content: '❌ An error occurred while saving the question.', ephemeral: true });
            }
        }
    }
}

module.exports = {
    name: "Applications",
    description: "A staff application system using Discord modals.",

    async setupDatabase(db, guildId) {
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS addon_storage (
                    addon_name VARCHAR(100) NOT NULL,
                    \`key\` VARCHAR(100) NOT NULL,
                    \`value\` TEXT,
                    PRIMARY KEY (addon_name, \`key\`)
                )
            `);
        } catch (error) {
            console.error(`[Applications] Failed to verify addon_storage table for guild ${guildId}:`, error);
        }
    },

    async initialize(client, guildId, context) {
        globalContext = context;
        const { getDbByGuild } = context;
        const db = await getDbByGuild(guildId);
        if (!db) {
            console.error(`[Applications] No database connection for guild ${guildId}. Addon cannot function.`);
            return;
        }

        // Ensure we only attach the listener once
        if (!client.listeners('interactionCreate').find(l => l.name === 'applicationsInteractionCreate')) {
            client.on('interactionCreate', applicationsInteractionCreate);
        }

        // Setup the background interval for the inactivity reminder (checks every 30 minutes)
        if (!client.__appReminderIntervals) client.__appReminderIntervals = new Map();
        if (client.__appReminderIntervals.has(guildId)) clearInterval(client.__appReminderIntervals.get(guildId));

        const interval = setInterval(() => checkAndSendReminder(client, guildId, context), 30 * 60 * 1000);
        client.__appReminderIntervals.set(guildId, interval);
        // Run an initial check 10 seconds after boot
        setTimeout(() => checkAndSendReminder(client, guildId, context), 10000);

        console.log(`Initializing Applications Addon for guild ${guildId}...`);
    },

    economyExtensions: {
        commands: [{
            name: 'applications',
            description: 'Manages the staff application system. (Admin only)',
            execute: handleApplicationsCommand
        }]
    }
};