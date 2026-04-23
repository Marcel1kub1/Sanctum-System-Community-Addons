const { Events, PermissionFlagsBits, ChannelType, RoleSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');

let globalContext = null;

// --- Data Management ---

/**
 * Gets the path for a guild's data file.
 * @param {string} guildId The ID of the guild.
 * @returns {string} The full path to the JSON file.
 */
function getGuildDataPath(guildId) {
    const dir = path.join(process.cwd(), 'addon_data', 'WelcomeSystem');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${guildId}.json`);
}

/**
 * Retrieves the configuration for a specific guild.
 * @param {string} guildId The ID of the guild.
 * @returns {object} The guild's configuration data.
 */
function getGuildData(guildId) {
    const dataPath = getGuildDataPath(guildId);
    if (fs.existsSync(dataPath)) {
        return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    }
    // Default settings
    return {
        enabled: false,
        channelId: null,
        message: 'Welcome {user} to {guild}!',
        roleId: null
    };
}

/**
 * Saves the configuration for a specific guild.
 * @param {string} guildId The ID of the guild.
 * @param {object} data The data to save.
 */
function saveGuildData(guildId, data) {
    fs.writeFileSync(getGuildDataPath(guildId), JSON.stringify(data, null, 2));
}

// --- Main Logic ---

/**
 * Initializes the addon, sets up listeners and commands.
 * @param {import('discord.js').Client} client The Discord client instance.
 * @param {string} guildId The ID of the guild being initialized for.
 * @param {object} context The global application context.
 */
function initialize(client, guildId, context) {
    globalContext = context;
    console.log(`[Addon:WelcomeSystem] Initializing...`);

    // Attach listeners only once to avoid duplicates during reloads.
    if (!client.listeners(Events.GuildMemberAdd).find(l => l.name === 'welcomeSystemGuildMemberAdd')) {
        client.on(Events.GuildMemberAdd, welcomeSystemGuildMemberAdd);
    }
    if (!client.listeners(Events.InteractionCreate).find(l => l.name === 'welcomeSystemInteractionCreate')) {
        client.on(Events.InteractionCreate, welcomeSystemInteractionCreate);
    }

    // Register the setup command.
    const registerCommand = () => {
        client.application?.commands.create({
            name: 'welcome',
            description: 'Configure the welcome system for this server.',
            defaultMemberPermissions: PermissionFlagsBits.Administrator,
                options: [
                    { name: 'setup', description: 'Run the interactive setup for the welcome system.', type: 1 /* SUB_COMMAND */ },
                    { name: 'status', description: 'View the current welcome system configuration.', type: 1 /* SUB_COMMAND */ }
                ]
        }).catch(console.error);
    };

    if (client.isReady()) {
        registerCommand();
    } else {
        client.once(Events.ClientReady, registerCommand);
    }
}

// --- Event Handlers ---

/**
 * Handles the GuildMemberAdd event to welcome new users.
 * @param {import('discord.js').GuildMember} member The member who joined.
 */
async function welcomeSystemGuildMemberAdd(member) {
    const guildId = member.guild.id;
    const data = getGuildData(guildId);

    if (!data.enabled || !data.channelId) return;

    const channel = await member.guild.channels.fetch(data.channelId).catch(() => null);
    if (!channel) {
        console.warn(`[Addon:WelcomeSystem] Welcome channel ${data.channelId} not found in guild ${guildId}. Disabling.`);
        data.enabled = false;
        saveGuildData(guildId, data);
        return;
    }

    // Assign role if configured
    if (data.roleId) {
        const role = await member.guild.roles.fetch(data.roleId).catch(() => null);
        if (role) {
            await member.roles.add(role).catch(err => console.error(`[Addon:WelcomeSystem] Failed to add role ${data.roleId} to member ${member.id}:`, err));
        } else {
            console.warn(`[Addon:WelcomeSystem] Welcome role ${data.roleId} not found in guild ${guildId}.`);
        }
    }

    // Send welcome message
    const welcomeMessage = data.message.replace('{user}', member.toString()).replace('{guild}', member.guild.name);

    try {
        const { theme } = await globalContext.getGuildSettings(guildId);
        const embed = globalContext.createThemedEmbed(theme, {
            description: welcomeMessage,
            thumbnail: { url: member.user.displayAvatarURL() }
        });
        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error(`[Addon:WelcomeSystem] Failed to send welcome message in guild ${guildId}:`, error);
    }
}

/**
 * Creates the payload for the welcome system dashboard (embeds and components).
 * @param {string} guildId The ID of the guild.
 * @param {boolean} isSetup If true, includes configuration buttons.
 * @returns {Promise<object>} The payload for a message reply/update.
 */
async function createWelcomeDashboardPayload(guildId, isSetup = false) {
    const data = getGuildData(guildId);
    const { theme } = await globalContext.getGuildSettings(guildId);

    const statusChannel = data.channelId ? `<#${data.channelId}>` : 'Not set';
    const statusRole = data.roleId ? `<@&${data.roleId}>` : 'Not set';
    const status = data.enabled ? 'Enabled' : 'Disabled';

    const embed = globalContext.createThemedEmbed(theme, {
        title: isSetup ? 'Welcome System Setup' : 'Welcome System Status',
        description: isSetup ? 'Use the buttons below to configure the welcome system.' : null,
        fields: [
            { name: 'Status', value: status, inline: true },
            { name: 'Welcome Channel', value: statusChannel, inline: true },
            { name: 'Autorole', value: statusRole, inline: true },
            { name: 'Message', value: `\`\`\`\n${data.message}\n\`\`\`` }
        ]
    });

    if (!isSetup) {
        return { embeds: [embed], components: [] };
    }

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('welcome_setup_toggle')
            .setLabel(data.enabled ? 'Disable System' : 'Enable System')
            .setStyle(data.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('welcome_setup_channel')
            .setLabel('Set Channel')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('welcome_setup_message')
            .setLabel('Set Message')
            .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('welcome_setup_role')
            .setLabel('Set Role')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('welcome_setup_removerole')
            .setLabel('Remove Role')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!data.roleId)
    );

    return { embeds: [embed], components: [row1, row2], ephemeral: true };
}

/**
 * Handles interactions for the /welcome command and its components.
 * @param {import('discord.js').Interaction} interaction The interaction object.
 */
async function welcomeSystemInteractionCreate(interaction) {
    if (!interaction.inGuild()) return;

    const isWelcomeInteraction = (
        (interaction.isChatInputCommand() && interaction.commandName === 'welcome') ||
        (interaction.isButton() && interaction.customId.startsWith('welcome_setup_')) ||
        (interaction.isRoleSelectMenu() && interaction.customId === 'welcome_setup_role_select') ||
        (interaction.isChannelSelectMenu() && interaction.customId === 'welcome_setup_channel_select') ||
        (interaction.isModalSubmit() && interaction.customId === 'welcome_setup_message_modal')
    );
    if (!isWelcomeInteraction) return;

    const guildId = interaction.guild.id;
    let data = getGuildData(guildId);

    // --- Setup Dashboard Button Handlers ---
    if (interaction.isButton()) {
        await interaction.deferUpdate();
        switch (interaction.customId) {
            case 'welcome_setup_toggle':
                data.enabled = !data.enabled;
                saveGuildData(guildId, data);
                return interaction.editReply(await createWelcomeDashboardPayload(guildId, true));
            case 'welcome_setup_channel':
                const channelMenu = new ChannelSelectMenuBuilder().setCustomId('welcome_setup_channel_select').setPlaceholder('Select a channel for welcome messages').setChannelTypes([ChannelType.GuildText]);
                const channelRow = new ActionRowBuilder().addComponents(channelMenu);
                return interaction.editReply({ content: 'Please select a channel from the menu below.', components: [channelRow], embeds: [] });
            case 'welcome_setup_message':
                const modal = new ModalBuilder().setCustomId('welcome_setup_message_modal').setTitle('Set Welcome Message');
                const messageInput = new TextInputBuilder().setCustomId('message_input').setLabel("Welcome Message").setPlaceholder('Use {user} for user mention and {guild} for server name.').setStyle(TextInputStyle.Paragraph).setValue(data.message);
                modal.addComponents(new ActionRowBuilder().addComponents(messageInput));
                return interaction.showModal(modal);
            case 'welcome_setup_role':
                const roleMenu = new RoleSelectMenuBuilder().setCustomId('welcome_setup_role_select').setPlaceholder('Select a role to assign to new members');
                const roleRow = new ActionRowBuilder().addComponents(roleMenu);
                return interaction.editReply({ content: 'Please select a role from the menu below. I must have a role higher than the selected role to be able to assign it.', components: [roleRow], embeds: [] });
            case 'welcome_setup_removerole':
                data.roleId = null;
                saveGuildData(guildId, data);
                return interaction.editReply(await createWelcomeDashboardPayload(guildId, true));
        }
    }

    // --- Setup Component Submit Handlers ---
    if (interaction.isChannelSelectMenu()) {
        await interaction.deferUpdate();
        data.channelId = interaction.values[0];
        saveGuildData(guildId, data);
        return interaction.editReply(await createWelcomeDashboardPayload(guildId, true));
    }

    if (interaction.isRoleSelectMenu()) {
        await interaction.deferUpdate();
        const roleId = interaction.values[0];
        const role = await interaction.guild.roles.fetch(roleId);

        if (!role) {
            await interaction.editReply(await createWelcomeDashboardPayload(guildId, true));
            return interaction.followUp({ content: '❌ This role no longer exists.', ephemeral: true });
        }
        if (role.managed || role.position >= interaction.guild.members.me.roles.highest.position) {
            await interaction.editReply(await createWelcomeDashboardPayload(guildId, true));
            return interaction.followUp({ content: '❌ I cannot assign this role. It is managed by an integration or is higher than my highest role.', ephemeral: true });
        }

        data.roleId = roleId;
        saveGuildData(guildId, data);
        return interaction.editReply(await createWelcomeDashboardPayload(guildId, true));
    }

    if (interaction.isModalSubmit()) {
        await interaction.deferUpdate();
        data.message = interaction.fields.getTextInputValue('message_input');
        saveGuildData(guildId, data);
        return interaction.editReply(await createWelcomeDashboardPayload(guildId, true));
    }

    // --- Slash Command Handler ---
    if (interaction.isChatInputCommand()) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ You need Administrator permissions to use this command.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'setup':
                await interaction.deferReply({ ephemeral: true });
                return interaction.editReply(await createWelcomeDashboardPayload(guildId, true));
            case 'status':
                await interaction.deferReply({ ephemeral: false }); // Status can be public
                return interaction.editReply(await createWelcomeDashboardPayload(guildId, false));
        }
    }
}

module.exports = { initialize };
