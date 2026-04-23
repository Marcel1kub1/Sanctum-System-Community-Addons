const { Events, PermissionFlagsBits, ChannelType, RoleSelectMenuBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
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
        message: 'Welcome to {guild}! Please click the button below to verify and gain access to the server.',
        unverifiedRoleId: null,
        memberRoleId: null
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
                    { name: 'setup', description: 'Run the interactive setup for the verification system.', type: 1 /* SUB_COMMAND */ },
                    { name: 'post', description: 'Post the verification message in the configured channel.', type: 1 /* SUB_COMMAND */ },
                    { name: 'toggle', description: 'Enable or disable the verification system.', type: 1 /* SUB_COMMAND */ },
                    { name: 'status', description: 'View the current verification system configuration.', type: 1 /* SUB_COMMAND */ }
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
 * Handles interactions for the /welcome command and its components.
 * @param {import('discord.js').Interaction} interaction The interaction object.
 */
async function welcomeSystemInteractionCreate(interaction) {
    if (!interaction.inGuild()) return;
    if (!interaction.isChatInputCommand() && !interaction.isRoleSelectMenu()) return;
    if (interaction.commandName !== 'welcome' && interaction.customId !== 'welcome_role_select') return;

    const guildId = interaction.guild.id;
    let data = getGuildData(guildId);

    // Handle role select menu submission
    if (interaction.isRoleSelectMenu() && interaction.customId === 'welcome_role_select') {
        const roleId = interaction.values[0];
        const role = await interaction.guild.roles.fetch(roleId);

        if (!role) {
            return interaction.update({ content: '❌ This role no longer exists.', components: [] });
        }
        if (role.managed || role.position >= interaction.guild.members.me.roles.highest.position) {
            return interaction.update({ content: '❌ I cannot assign this role. It is managed by an integration or is higher than my highest role.', components: [] });
        }

        data.roleId = roleId;
        saveGuildData(guildId, data);
        return interaction.update({ content: `✅ New members will now automatically receive the **${role.name}** role.`, components: [] });
    }

    // Handle slash command
    if (interaction.isChatInputCommand() && interaction.commandName === 'welcome') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ You need Administrator permissions to use this command.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        await interaction.deferReply({ ephemeral: true });

        switch (subcommand) {
            case 'toggle':
                data.enabled = !data.enabled;
                saveGuildData(guildId, data);
                return interaction.editReply(`✅ Welcome system has been **${data.enabled ? 'enabled' : 'disabled'}**.`);
            case 'setchannel':
                const channel = interaction.options.getChannel('channel');
                data.channelId = channel.id;
                saveGuildData(guildId, data);
                return interaction.editReply(`✅ Welcome messages will now be sent to ${channel}.`);
            case 'setmessage':
                const message = interaction.options.getString('message');
                data.message = message;
                saveGuildData(guildId, data);
                return interaction.editReply(`✅ Welcome message has been updated.\n**Preview:**\n${message.replace('{user}', interaction.user.toString()).replace('{guild}', interaction.guild.name)}`);
            case 'setrole':
                const selectMenu = new RoleSelectMenuBuilder().setCustomId('welcome_role_select').setPlaceholder('Select a role to assign to new members');
                const row = new ActionRowBuilder().addComponents(selectMenu);
                return interaction.editReply({ content: 'Please select a role from the menu below. I must have a role higher than the selected role to be able to assign it.', components: [row] });
            case 'removerole':
                data.roleId = null;
                saveGuildData(guildId, data);
                return interaction.editReply('✅ The autorole for new members has been removed.');
            case 'status':
                const statusChannel = data.channelId ? `<#${data.channelId}>` : 'Not set';
                const statusRole = data.roleId ? `<@&${data.roleId}>` : 'Not set';
                const status = data.enabled ? 'Enabled' : 'Disabled';
                const { theme } = await globalContext.getGuildSettings(guildId);
                const embed = globalContext.createThemedEmbed(theme, {
                    title: 'Welcome System Status',
                    fields: [
                        { name: 'Status', value: status, inline: true },
                        { name: 'Welcome Channel', value: statusChannel, inline: true },
                        { name: 'Autorole', value: statusRole, inline: true },
                        { name: 'Message', value: `\`\`\`\n${data.message}\n\`\`\`` }
                    ]
                });
                return interaction.editReply({ embeds: [embed] });
        }
    }
}

module.exports = { initialize };
