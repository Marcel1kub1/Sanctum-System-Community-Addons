const fs = require('fs');
const path = require('path');
// GitHub Voice Chat Addon (Upload this as index.js)
const { ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

let listenersAttached = false;
let globalContext = null;

// Sets up a MySQL table exclusively for this addon!
async function ensureTable(pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS addon_voicechat (
        guild_id VARCHAR(50) PRIMARY KEY,
        master_channel_id VARCHAR(50),
        active_channels JSON
    )`);
}

async function getGuildData(pool, guildId) {
    const [rows] = await pool.query('SELECT master_channel_id, active_channels FROM addon_voicechat WHERE guild_id = ?', [guildId]);
    if (rows.length > 0) {
        return {
            masterChannelId: rows[0].master_channel_id,
            activeChannels: typeof rows[0].active_channels === 'string' ? JSON.parse(rows[0].active_channels) : (rows[0].active_channels || {})
        };
    }
    return { masterChannelId: null, activeChannels: {} };
}

async function saveGuildData(pool, guildId, data) {
    await pool.query(
        'INSERT INTO addon_voicechat (guild_id, master_channel_id, active_channels) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE master_channel_id = ?, active_channels = ?',
        [guildId, data.masterChannelId, JSON.stringify(data.activeChannels), data.masterChannelId, JSON.stringify(data.activeChannels)]
    );
}

function initialize(client, guildId, context) {
    console.log(`[Addon:VoiceChatSystem] Initializing dynamically from GitHub for guild ${guildId}...`);
    globalContext = context;
    const pool = context.getDbByGuild(guildId);
    
    // Ensure the MySQL table exists when the addon is loaded
    ensureTable(pool).catch(console.error);

    const registerCommand = () => {
        client.application?.commands.create({
            name: 'vcsetup',
            description: 'Sets up the Join-to-Create Voice Chat System categories and channels.',
            defaultMemberPermissions: PermissionFlagsBits.Administrator
        }).catch(console.error);
    };

    if (client.isReady()) registerCommand();
    else client.once(Events.ClientReady, registerCommand);

    if (!listenersAttached) {
        listenersAttached = true;
        attachListeners(client);
    }
}

function attachListeners(client) {
    client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
        if (!newState.guild || !globalContext) return;
        const guildId = newState.guild.id;
        const pool = globalContext.getDbByGuild(guildId);
        const data = await getGuildData(pool, guildId);
        
        if (newState.channelId === data.masterChannelId && oldState.channelId !== data.masterChannelId) {
            const member = newState.member;
            const category = newState.channel?.parent;

            try {
                const newChannel = await newState.guild.channels.create({
                    name: `🔊 ${member.user.username}'s VC`,
                    type: ChannelType.GuildVoice,
                    parent: category ? category.id : null,
                    permissionOverwrites: [
                        { id: newState.guild.id, allow: [PermissionFlagsBits.Connect] },
                        { id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers, PermissionFlagsBits.MoveMembers] }
                    ]
                });

                await member.voice.setChannel(newChannel);
                data.activeChannels[newChannel.id] = { ownerId: member.id };
                await saveGuildData(pool, guildId, data);
                
                const guildCfg = await globalContext.getGuildSettings(guildId);
                sendControlPanel(newChannel, member, guildCfg.theme);
            } catch (error) {
                console.error('[Addon:VoiceChatSystem] Error creating VC:', error);
            }
        }

        if (oldState.channelId && oldState.channelId !== data.masterChannelId) {
            if (data.activeChannels[oldState.channelId]) {
                const channel = oldState.channel;
                if (channel && channel.members.size === 0) {
                    channel.delete().catch(() => {});
                    delete data.activeChannels[oldState.channelId];
                    await saveGuildData(pool, guildId, data);
                }
            }
        }
    });

    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.guild || !globalContext) return;
        const guildId = interaction.guild.id;
        const pool = globalContext.getDbByGuild(guildId);
        const data = await getGuildData(pool, guildId);

        if (interaction.isChatInputCommand() && interaction.commandName === 'vcsetup') {
            await interaction.deferReply({ ephemeral: true });
            const category = await interaction.guild.channels.create({ name: '🎤 Voice Channels', type: ChannelType.GuildCategory });
            const masterChannel = await interaction.guild.channels.create({ name: '➕ Join to Create', type: ChannelType.GuildVoice, parent: category.id });
            
            data.masterChannelId = masterChannel.id;
            await saveGuildData(pool, guildId, data);
            return interaction.editReply(`✅ Voice Chat System setup complete! Category and Master Channel created.`);
        }

        if (interaction.isButton() && interaction.customId.startsWith('vc_')) {
            const channel = interaction.member?.voice?.channel;
            if (!channel) return interaction.reply({ content: 'You must be in a voice channel to use these controls.', ephemeral: true });

            const channelInfo = data.activeChannels[channel.id];
            if (!channelInfo) return interaction.reply({ content: 'This is not a managed voice channel.', ephemeral: true });
            if (channelInfo.ownerId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: '❌ Only the owner of this channel can use these controls.', ephemeral: true });
            }

            if (interaction.customId === 'vc_lock') {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
                return interaction.reply({ content: '🔒 Channel Locked!', ephemeral: true });
            }
            if (interaction.customId === 'vc_unlock') {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
                return interaction.reply({ content: '🔓 Channel Unlocked!', ephemeral: true });
            }
            if (interaction.customId === 'vc_rename') {
                const modal = new ModalBuilder().setCustomId('vc_modal_rename').setTitle('Rename Channel');
                const input = new TextInputBuilder().setCustomId('new_name').setLabel('New Channel Name').setStyle(TextInputStyle.Short).setValue(channel.name).setMaxLength(30);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }
            if (interaction.customId === 'vc_limit') {
                const modal = new ModalBuilder().setCustomId('vc_modal_limit').setTitle('Set User Limit');
                const input = new TextInputBuilder().setCustomId('user_limit').setLabel('Number (0 for unlimited)').setStyle(TextInputStyle.Short).setValue(String(channel.userLimit || 0));
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith('vc_modal_')) {
            const channel = interaction.member?.voice?.channel;
            if (!channel) return interaction.reply({ content: 'An error occurred. Please try again.', ephemeral: true });
            
            if (interaction.customId === 'vc_modal_rename') {
                const newName = interaction.fields.getTextInputValue('new_name');
                await channel.setName(newName).catch(console.error);
                return interaction.reply({ content: `✏️ Channel renamed to ****!`, ephemeral: true });
            }
            if (interaction.customId === 'vc_modal_limit') {
                const limitStr = interaction.fields.getTextInputValue('user_limit');
                const limit = parseInt(limitStr);
                if (isNaN(limit) || limit < 0 || limit > 99) return interaction.reply({ content: '❌ Please enter a valid number between 0 and 99.', ephemeral: true });
                await channel.setUserLimit(limit).catch(console.error);
                return interaction.reply({ content: `👥 Channel user limit set to **${limit === 0 ? 'Unlimited' : limit}**!`, ephemeral: true });
            }
        }
    });
}

function sendControlPanel(channel, member, theme) {
    const embed = globalContext.createThemedEmbed(theme, {
        title: '🎛️ Voice Control Panel',
        description: `Welcome, ! Use the buttons below to manage your channel.`
    });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_lock').setLabel('Lock').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vc_unlock').setLabel('Unlock').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vc_rename').setLabel('Rename').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('vc_limit').setLabel('Limit Users').setStyle(ButtonStyle.Secondary)
    );

    channel.send({ content: ``, embeds: [embed], components: [row] }).catch(console.error);
}

module.exports = { initialize };
const { createThemedEmbed } = require('../src/theming');
const { getGuildSettings } = require('../src/index');

let listenersAttached = false;

// Manage per-guild configuration data locally within the addon's folder
function getGuildDataPath(guildId) {
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${guildId}.json`);
}

function getGuildData(guildId) {
    const dataPath = getGuildDataPath(guildId);
    if (fs.existsSync(dataPath)) {
        return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    }
    return { masterChannelId: null, activeChannels: {} };
}

function saveGuildData(guildId, data) {
    fs.writeFileSync(getGuildDataPath(guildId), JSON.stringify(data, null, 2));
}

function initialize(client, options) {
    console.log(`[Addon:VoiceChatSystem] Initializing...`);

    // Ensure event listeners are only attached once even if loaded multiple times
    if (!listenersAttached) {
        listenersAttached = true;
        attachListeners(client);
    }
    
    // Register the setup command automatically when the bot is ready
    const registerCommand = () => {
        client.application?.commands.create({
            name: 'vcsetup',
            description: 'Sets up the Join-to-Create Voice Chat System categories and channels.',
            defaultMemberPermissions: PermissionFlagsBits.Administrator
        }).catch(console.error);
    };

    if (client.isReady()) {
        registerCommand();
    } else {
        client.once(Events.ClientReady, registerCommand);
    }
}

function attachListeners(client) {
    // 1. Listen for voice state updates (When someone joins the Master VC)
    client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
        if (!newState.guild) return;
        const guildId = newState.guild.id;
        const data = getGuildData(guildId);
        
        // User joined the Master Channel
        if (newState.channelId === data.masterChannelId && oldState.channelId !== data.masterChannelId) {
            const member = newState.member;
            const category = newState.channel?.parent;

            try {
                const newChannel = await newState.guild.channels.create({
                    name: `🔊 ${member.user.username}'s VC`,
                    type: ChannelType.GuildVoice,
                    parent: category ? category.id : null,
                    permissionOverwrites: [
                        { id: newState.guild.id, allow: [PermissionFlagsBits.Connect] },
                        { id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers, PermissionFlagsBits.MoveMembers] }
                    ]
                });

                // Move member to their new channel
                await member.voice.setChannel(newChannel);
                
                // Save the channel ownership to database
                data.activeChannels[newChannel.id] = { ownerId: member.id };
                saveGuildData(guildId, data);
                
                const guildCfg = await getGuildSettings(guildId);
                // Send the interactive management panel to the new voice channel
                sendControlPanel(newChannel, member, guildCfg.theme);
            } catch (error) {
                console.error('[Addon:VoiceChatSystem] Error creating VC:', error);
            }
        }

        // Cleanup empty channels when users leave
        if (oldState.channelId && oldState.channelId !== data.masterChannelId) {
            if (data.activeChannels[oldState.channelId]) {
                const channel = oldState.channel;
                if (channel && channel.members.size === 0) {
                    channel.delete().catch(() => {});
                    delete data.activeChannels[oldState.channelId];
                    saveGuildData(guildId, data);
                }
            }
        }
    });

    // 2. Listen for button clicks, modals, and commands
    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.guild) return;
        const guildId = interaction.guild.id;
        const data = getGuildData(guildId);

        // Command: /vcsetup
        if (interaction.isChatInputCommand() && interaction.commandName === 'vcsetup') {
            await interaction.deferReply({ ephemeral: true });
            const category = await interaction.guild.channels.create({ name: '🎤 Voice Channels', type: ChannelType.GuildCategory });
            const masterChannel = await interaction.guild.channels.create({ name: '➕ Join to Create', type: ChannelType.GuildVoice, parent: category.id });
            
            data.masterChannelId = masterChannel.id;
            saveGuildData(guildId, data);
            return interaction.editReply(`✅ Voice Chat System setup complete! Category and Master Channel created.`);
        }

        // Control Panel Buttons
        if (interaction.isButton() && interaction.customId.startsWith('vc_')) {
            const channel = interaction.member?.voice?.channel;
            if (!channel) return interaction.reply({ content: 'You must be in a voice channel to use these controls.', ephemeral: true });

            const channelInfo = data.activeChannels[channel.id];
            if (!channelInfo) return interaction.reply({ content: 'This is not a managed voice channel.', ephemeral: true });
            if (channelInfo.ownerId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: '❌ Only the owner of this channel can use these controls.', ephemeral: true });
            }

            if (interaction.customId === 'vc_lock') {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
                return interaction.reply({ content: '🔒 Channel Locked!', ephemeral: true });
            }
            if (interaction.customId === 'vc_unlock') {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
                return interaction.reply({ content: '🔓 Channel Unlocked!', ephemeral: true });
            }
            if (interaction.customId === 'vc_rename') {
                const modal = new ModalBuilder().setCustomId('vc_modal_rename').setTitle('Rename Channel');
                const input = new TextInputBuilder().setCustomId('new_name').setLabel('New Channel Name').setStyle(TextInputStyle.Short).setValue(channel.name).setMaxLength(30);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }
            if (interaction.customId === 'vc_limit') {
                const modal = new ModalBuilder().setCustomId('vc_modal_limit').setTitle('Set User Limit');
                const input = new TextInputBuilder().setCustomId('user_limit').setLabel('Number (0 for unlimited)').setStyle(TextInputStyle.Short).setValue(String(channel.userLimit || 0));
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }
        }

        // Control Panel Modals
        if (interaction.isModalSubmit() && interaction.customId.startsWith('vc_modal_')) {
            const channel = interaction.member?.voice?.channel;
            if (!channel) return interaction.reply({ content: 'An error occurred. Please try again.', ephemeral: true });
            
            if (interaction.customId === 'vc_modal_rename') {
                const newName = interaction.fields.getTextInputValue('new_name');
                await channel.setName(newName).catch(console.error);
                return interaction.reply({ content: `✏️ Channel renamed to **${newName}**!`, ephemeral: true });
            }
            if (interaction.customId === 'vc_modal_limit') {
                const limitStr = interaction.fields.getTextInputValue('user_limit');
                const limit = parseInt(limitStr);
                if (isNaN(limit) || limit < 0 || limit > 99) return interaction.reply({ content: '❌ Please enter a valid number between 0 and 99.', ephemeral: true });
                await channel.setUserLimit(limit).catch(console.error);
                return interaction.reply({ content: `👥 Channel user limit set to **${limit === 0 ? 'Unlimited' : limit}**!`, ephemeral: true });
            }
        }
    });
}

function sendControlPanel(channel, member, theme) {
    const embed = createThemedEmbed(theme, {
        title: '🎛️ Voice Control Panel',
        description: `Welcome, ${member}! Use the buttons below to manage your channel.`
    });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_lock').setLabel('Lock').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vc_unlock').setLabel('Unlock').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vc_rename').setLabel('Rename').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('vc_limit').setLabel('Limit Users').setStyle(ButtonStyle.Secondary)
    );

    channel.send({ content: `${member}`, embeds: [embed], components: [row] }).catch(console.error);
}

module.exports = { initialize };
