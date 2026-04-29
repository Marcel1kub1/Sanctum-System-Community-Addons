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
        q5: "Timezone & availability?"
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
    const embed = createThemedEmbed(guildCfg.theme, {
        title: '⚙️ Applications System Setup',
        description: 'Configure your application system using the menus below.\nChanges are saved automatically.',
        fields: [
            { name: 'Submission Channel', value: config.submissionChannelId ? `<#${config.submissionChannelId}>` : 'Not set', inline: false },
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
            .setPlaceholder('Deploy "Apply Now" Panel to Channel...')
            .setChannelTypes(ChannelType.GuildText)
    );

    return { embeds: [embed], components: [row1, row2, row3] };
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
    
    await interaction.deferReply({ ephemeral: true });

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
        const { getDbByGuild } = context;
        const db = await getDbByGuild(guildId);
        if (!db) {
            console.error(`[Applications] No database connection for guild ${guildId}. Addon cannot function.`);
            return;
        }

        console.log(`Initializing Applications Addon for guild ${guildId}...`);
    },

    economyExtensions: {
        commands: [{
            name: 'applications',
            description: 'Manages the staff application system. (Admin only)',
            execute: handleApplicationsCommand
        }],
        async onInteraction(interaction, context) {
            if (!interaction.customId) return;
            
            // Early exit: Only fetch the database if this interaction belongs to the Application Addon
            const isAppInteraction = interaction.customId === 'application_start' || 
                                     interaction.customId === 'application_submit_modal' || 
                                     interaction.customId.startsWith('app_setup_');
            if (!isAppInteraction) return;

            const { getDbByGuild, getGuildSettings } = context;
            const db = await getDbByGuild(interaction.guild.id);
            if (!db) return interaction.reply({ content: '❌ Database connection failed.', ephemeral: true });

            const guildCfg = await getGuildSettings(interaction.guild.id);
            const fullContext = { ...context, client: interaction.client, db, guildCfg };

            if (interaction.isButton() && interaction.customId === 'application_start') {
                const config = await getAppConfig(db);
                if (!config.submissionChannelId) {
                    return interaction.reply({ content: '❌ The application system has not been fully configured. Please contact an administrator.', ephemeral: true });
                }
                await showApplicationModal(interaction, fullContext);
            } else if (interaction.isChannelSelectMenu()) {
                // Instantly defer the update to prevent Discord's 3-second "Interaction Failed" timeout
                await interaction.deferUpdate().catch(() => {});
                
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
    
                        const embed = fullContext.createThemedEmbed(guildCfg.theme, {
                            title: '📝 Staff Applications',
                            description: 'Interested in joining our staff team? Click the button below to open an application form.\n\nPlease ensure you meet all requirements before applying and answer all questions honestly and to the best of your ability.',
                            color: '#5865F2', 
                            footer: { text: `${interaction.guild.name} | Application System` }
                        });
    
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('application_start').setLabel('Apply Now').setStyle(ButtonStyle.Primary).setEmoji('📄')
                        );
    
                        await channel.send({ embeds: [embed], components: [row] });
                        
                        const updatedConfig = await getAppConfig(db);
                        await interaction.editReply(await generateSetupMessage(updatedConfig, fullContext));
                        await interaction.followUp({ content: `✅ Application panel deployed to ${channel}!`, ephemeral: true });
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
                if (interaction.customId === 'application_submit_modal') {
                    await handleApplicationSubmit(interaction, fullContext);
                } else if (interaction.customId.startsWith('app_setup_q_modal_')) {
                    await interaction.deferUpdate().catch(() => {});
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
    }
};