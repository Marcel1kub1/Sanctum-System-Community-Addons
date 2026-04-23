const { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, UserSelectMenuBuilder, StringSelectMenuBuilder, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
let listenersAttached = false;
let globalContext = null;

// Manage per-guild configuration data locally within the addon's folder
function getGuildDataPath(guildId) {
    // Save data outside the addon folder so it survives Addon updates!
    const dir = path.join(process.cwd(), 'addon_data', 'VoiceChatSystem');
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

function initialize(client, guildId, context) {
    globalContext = context;
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
                try {
                    await member.voice.setChannel(newChannel);
                } catch (moveError) {
                    console.warn(`[Addon:VoiceChatSystem] User disconnected before move. Cleaning up...`);
                    await newChannel.delete().catch(() => {});
                    return;
                }

                // Save the channel ownership and panel message ID to database
                const guildCfg = await globalContext.getGuildSettings(guildId);
                const panelMessage = await sendControlPanel(newChannel, member, guildCfg.theme);

                if (panelMessage) {
                    data.activeChannels[newChannel.id] = { ownerId: member.id, panelMessageId: panelMessage.id };
                    saveGuildData(guildId, data);
                }
            } catch (error) {
                console.error('[Addon:VoiceChatSystem] Error creating VC:', error);
            }
        }

        // Cleanup empty channels when users leave
        if (oldState.channelId && oldState.channelId !== data.masterChannelId) {
            if (data.activeChannels[oldState.channelId]) {
                // Fetch the channel fresh from the cache to ensure accurate member counts
                const channel = oldState.guild.channels.cache.get(oldState.channelId);
                
                // Check if the channel exists and has NO humans left in it (ignores bots)
                if (channel && channel.members.filter(m => !m.user.bot).size === 0) {
                    channel.delete().catch(err => console.error('[Addon:VoiceChatSystem] Error deleting VC:', err));
                    delete data.activeChannels[oldState.channelId];
                    saveGuildData(guildId, data);
                } else if (!channel) {
                    // If the channel was already manually deleted, just clean the database
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
            try {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            } catch (err) {
                return; // Interaction expired or already handled
            }

            const category = await interaction.guild.channels.create({ name: '🎤 Voice Channels', type: ChannelType.GuildCategory });
            const masterChannel = await interaction.guild.channels.create({ name: '➕ Join to Create', type: ChannelType.GuildVoice, parent: category.id });
            
            data.masterChannelId = masterChannel.id;
            saveGuildData(guildId, data);
            return interaction.editReply(`✅ Voice Chat System setup complete! Category and Master Channel created.`);
        }

        // Control Panel Buttons
        if (interaction.isButton() && interaction.customId.startsWith('vc_')) {
            await interaction.deferUpdate().catch(() => {});
            const channel = interaction.member?.voice?.channel;
            if (!channel) return interaction.followUp({ content: 'You must be in a voice channel to use these controls.', ephemeral: true }).catch(() => {});

            const channelInfo = data.activeChannels[channel.id];
            if (!channelInfo) return interaction.followUp({ content: 'This is not a managed voice channel.', ephemeral: true }).catch(() => {});

            // Allow non-owners to claim an abandoned channel
            if (interaction.customId === 'vc_claim') {
                if (channelInfo.ownerId === interaction.user.id) return interaction.followUp({ content: 'You already own this channel.', ephemeral: true }).catch(() => {});
                if (channel.members.has(channelInfo.ownerId)) return interaction.followUp({ content: '❌ The current owner is still in the channel.', ephemeral: true }).catch(() => {});
                
                // Update owner and permissions
                data.activeChannels[channel.id].ownerId = interaction.user.id;
                saveGuildData(guildId, data);
                await channel.permissionOverwrites.edit(interaction.user.id, { ManageChannels: true, MuteMembers: true, DeafenMembers: true, MoveMembers: true });

                const { theme } = await globalContext.getGuildSettings(guildId);
                await updateControlPanel(interaction, theme);
                return interaction.followUp({ content: '👑 You are now the new owner of this channel!', ephemeral: true }).catch(() => {});
            }

            // From here, only the owner or an admin can proceed
            if (channelInfo.ownerId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.followUp({ content: '❌ Only the owner of this channel can use these controls.', ephemeral: true }).catch(() => {});
            }

            const { theme } = await globalContext.getGuildSettings(guildId);

            switch (interaction.customId) {
                case 'vc_delete':
                    await interaction.followUp({ content: '🗑️ Disbanding channel...', ephemeral: true }).catch(() => {});
                    await channel.delete().catch(() => {});
                    delete data.activeChannels[channel.id];
                    saveGuildData(guildId, data);
                    return;

                case 'vc_toggle_lock': {
                    const state = getControlPanelState(channel);
                    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: state.isLocked ? null : false });
                    await updateControlPanel(interaction, theme);
                    await interaction.followUp({ content: state.isLocked ? '🔓 Channel Unlocked!' : '🔒 Channel Locked!', ephemeral: true }).catch(() => {});
                    break;
                }
                case 'vc_toggle_visibility': {
                    const state = getControlPanelState(channel);
                    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: state.isHidden ? null : false });
                    await updateControlPanel(interaction, theme);
                    await interaction.followUp({ content: state.isHidden ? '👁️ Channel is now visible!' : '🙈 Channel is now hidden!', ephemeral: true }).catch(() => {});
                    break;
                }
                case 'vc_rename': {
                    const modal = new ModalBuilder().setCustomId('vc_modal_rename').setTitle('Rename Channel');
                    const input = new TextInputBuilder().setCustomId('new_name').setLabel('New Channel Name').setStyle(TextInputStyle.Short).setValue(channel.name).setMaxLength(30);
                    modal.addComponents(new ActionRowBuilder().addComponents(input));
                    return interaction.showModal(modal).catch(() => {});
                }
                case 'vc_limit': {
                    const modal = new ModalBuilder().setCustomId('vc_modal_limit').setTitle('Set User Limit');
                    const input = new TextInputBuilder().setCustomId('user_limit').setLabel('Number (0-99, 0 for unlimited)').setStyle(TextInputStyle.Short).setValue(String(channel.userLimit || 0));
                    modal.addComponents(new ActionRowBuilder().addComponents(input));
                    return interaction.showModal(modal).catch(() => {});
                }
                case 'vc_kick':
                case 'vc_permit':
                case 'vc_reject':
                case 'vc_transfer': {
                    const select = new UserSelectMenuBuilder()
                        .setCustomId(interaction.customId.replace('vc_', 'vc_select_'))
                        .setPlaceholder(`Select a user to ${interaction.customId.split('_')[1]}...`);
                    const row = new ActionRowBuilder().addComponents(select);
                    return interaction.followUp({ content: 'Please select a user below.', components: [row], ephemeral: true });
                }
                case 'vc_toggle_stream': {
                    const state = getControlPanelState(channel);
                    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Stream: state.isStreamingDisabled ? null : false });
                    await updateControlPanel(interaction, theme);
                    await interaction.followUp({ content: state.isStreamingDisabled ? '📹 Streaming has been enabled!' : '📹 Streaming has been disabled for @everyone.', ephemeral: true }).catch(() => {});
                    break;
                }
                case 'vc_bitrate': {
                    const modal = new ModalBuilder().setCustomId('vc_modal_bitrate').setTitle('Set Channel Bitrate');
                    const maxBitrate = Math.floor(interaction.guild.maximumBitrate / 1000);
                    const input = new TextInputBuilder()
                        .setCustomId('bitrate')
                        .setLabel(`Bitrate in kbps (8-${maxBitrate})`)
                        .setStyle(TextInputStyle.Short)
                        .setValue(String(channel.bitrate / 1000));
                    modal.addComponents(new ActionRowBuilder().addComponents(input));
                    return interaction.showModal(modal).catch(() => {});
                }
            }
        }

        // Control Panel Modals
        if (interaction.isModalSubmit() && interaction.customId.startsWith('vc_modal_')) {
            const channel = interaction.member?.voice?.channel;
            if (!channel) return interaction.reply({ content: 'An error occurred. Please try again.', ephemeral: true }).catch(() => {});
            
            const { theme } = await globalContext.getGuildSettings(guildId);

            if (interaction.customId === 'vc_modal_rename') {
                const newName = interaction.fields.getTextInputValue('new_name');
                await channel.setName(newName).catch(console.error);
                await updateControlPanel(interaction, theme);
                return interaction.reply({ content: `✏️ Channel renamed to **${newName}**!`, ephemeral: true }).catch(() => {});
            }
            if (interaction.customId === 'vc_modal_limit') {
                const limitStr = interaction.fields.getTextInputValue('user_limit');
                const limit = parseInt(limitStr);
                if (isNaN(limit) || limit < 0 || limit > 99) return interaction.reply({ content: '❌ Please enter a valid number between 0 and 99.', ephemeral: true }).catch(() => {});
                await channel.setUserLimit(limit).catch(console.error);
                await updateControlPanel(interaction, theme);
                return interaction.reply({ content: `👥 Channel user limit set to **${limit === 0 ? 'Unlimited' : limit}**!`, ephemeral: true }).catch(() => {});
            }
            if (interaction.customId === 'vc_modal_bitrate') {
                const bitrateStr = interaction.fields.getTextInputValue('bitrate');
                const bitrate = parseInt(bitrateStr) * 1000;
                const maxBitrate = interaction.guild.maximumBitrate;
                if (isNaN(bitrate) || bitrate < 8000 || bitrate > maxBitrate) {
                    return interaction.reply({ content: `❌ Please enter a valid bitrate between 8 and ${maxBitrate / 1000} kbps.`, ephemeral: true }).catch(() => {});
                }
                await channel.setBitrate(bitrate).catch(console.error);
                await updateControlPanel(interaction, theme);
                return interaction.reply({ content: `📶 Channel bitrate set to **${bitrateStr} kbps**!`, ephemeral: true }).catch(() => {});
            }
        }

        // Control Panel String Select Menus
        if (interaction.isStringSelectMenu() && interaction.customId === 'vc_select_region') {
            const channel = interaction.member?.voice?.channel;
            if (!channel) return interaction.reply({ content: 'An error occurred. Please try again.', ephemeral: true }).catch(() => {});

            const channelInfo = data.activeChannels[channel.id];
            if (!channelInfo || (channelInfo.ownerId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator))) {
                return interaction.reply({ content: '❌ You no longer have permission to manage this channel.', ephemeral: true });
            }

            const newRegion = interaction.values[0];
            const regionId = newRegion === 'auto' ? null : newRegion;

            await channel.setRTCRegion(regionId).catch(console.error);

            const { theme } = await globalContext.getGuildSettings(guildId);
            await updateControlPanel(interaction, theme);
            
            const voiceRegions = await interaction.client.rest.get(Routes.voiceRegions());
            const regionName = voiceRegions.find(r => r.id === newRegion)?.name ?? 'Automatic';

            return interaction.reply({ content: `🌎 Channel region set to **${regionName}**!`, ephemeral: true });
        }

        // Control Panel User Select Menus
        if (interaction.isUserSelectMenu() && interaction.customId.startsWith('vc_select_')) {
            const channel = interaction.member?.voice?.channel;
            if (!channel) return interaction.reply({ content: 'An error occurred. Please try again.', ephemeral: true }).catch(() => {});

            const channelInfo = data.activeChannels[channel.id];
            if (!channelInfo || (channelInfo.ownerId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator))) {
                return interaction.reply({ content: '❌ You no longer have permission to manage this channel.', ephemeral: true });
            }

            const targetId = interaction.values[0];
            const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
            if (!targetMember) return interaction.reply({ content: '❌ Could not find that member.', ephemeral: true });

            const { theme } = await globalContext.getGuildSettings(guildId);

            switch (interaction.customId) {
                case 'vc_select_kick': {
                    if (targetMember.id === channelInfo.ownerId) return interaction.reply({ content: "❌ You can't kick the channel owner.", ephemeral: true });
                    if (!targetMember.voice.channel || targetMember.voice.channel.id !== channel.id) return interaction.reply({ content: '❌ That user is not in this voice channel.', ephemeral: true });
                    await targetMember.voice.disconnect('Kicked by channel owner.');
                    return interaction.reply({ content: `👢 Kicked ${targetMember.displayName}.`, ephemeral: true });
                }
                case 'vc_select_permit': {
                    await channel.permissionOverwrites.edit(targetMember.id, { Connect: true });
                    return interaction.reply({ content: `✅ Allowed ${targetMember.displayName} to connect.`, ephemeral: true });
                }
                case 'vc_select_reject': {
                    await channel.permissionOverwrites.edit(targetMember.id, { Connect: false });
                    if (targetMember.voice.channel?.id === channel.id) await targetMember.voice.disconnect('Permissions revoked by channel owner.');
                    return interaction.reply({ content: `🚫 Denied ${targetMember.displayName} from connecting.`, ephemeral: true });
                }
                case 'vc_select_transfer': {
                    if (targetMember.id === interaction.user.id) return interaction.reply({ content: "❌ You can't transfer ownership to yourself.", ephemeral: true });
                    if (targetMember.user.bot) return interaction.reply({ content: "❌ You can't transfer ownership to a bot.", ephemeral: true });

                    // Update owner in DB
                    data.activeChannels[channel.id].ownerId = targetMember.id;
                    saveGuildData(guildId, data);

                    // Swap permissions
                    await channel.permissionOverwrites.edit(interaction.user.id, { ManageChannels: null, MuteMembers: null, DeafenMembers: null, MoveMembers: null });
                    await channel.permissionOverwrites.edit(targetMember.id, { ManageChannels: true, MuteMembers: true, DeafenMembers: true, MoveMembers: true });

                    await updateControlPanel(interaction, theme);
                    return interaction.reply({ content: `👑 Transferred ownership to ${targetMember.displayName}!`, ephemeral: true });
                }
            }
        }
    });
}

function getControlPanelState(channel) {
    const everyonePerms = channel.permissionOverwrites.cache.get(channel.guild.id);
    const isLocked = everyonePerms?.deny.has(PermissionFlagsBits.Connect) ?? false;
    const isHidden = everyonePerms?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;
    const isStreamingDisabled = everyonePerms?.deny.has(PermissionFlagsBits.Stream) ?? false;
    return { isLocked, isHidden, limit: channel.userLimit, bitrate: channel.bitrate, isStreamingDisabled, rtcRegion: channel.rtcRegion };
}

async function createControlPanelEmbed(channel, owner, theme) {
    const state = getControlPanelState(channel);
    const limit = state.limit === 0 ? 'Unlimited' : state.limit;

    let regionName = 'Automatic';
    if (state.rtcRegion) {
        const voiceRegions = await channel.client.rest.get(Routes.voiceRegions());
        regionName = voiceRegions.find(r => r.id === state.rtcRegion)?.name ?? 'Automatic';
    }

    const description = [
        `👑 **Owner:** ${owner.toString()}`,
        `👥 **User Limit:** \`${limit}\``,
        `🔒 **Status:** \`${state.isLocked ? 'Locked' : 'Unlocked'}\``,
        `👁️ **Visibility:** \`${state.isHidden ? 'Hidden' : 'Visible'}\``,
        `📶 **Bitrate:** \`${state.bitrate / 1000} kbps\``,
        `📹 **Streaming:** \`${state.isStreamingDisabled ? 'Disabled' : 'Enabled'}\``,
        `🌎 **Region:** \`${regionName}\``
    ].join('\n');

    return globalContext.createThemedEmbed(theme, {
        title: '🎛️ Voice Control Panel',
        description: `Manage **${channel.name}** using the buttons below.\n\n${description}`
    });
}

async function updateControlPanel(interaction, theme) {
    const channel = interaction.member?.voice?.channel;
    if (!channel) return;

    const data = getGuildData(interaction.guild.id);
    const channelInfo = data.activeChannels[channel.id];
    if (!channelInfo || !channelInfo.panelMessageId) return;

    try {
        const panelMessage = await channel.messages.fetch(channelInfo.panelMessageId).catch(() => null);
        const owner = await interaction.guild.members.fetch(channelInfo.ownerId).catch(() => null);
        
        if (panelMessage && owner) {
            const embed = await createControlPanelEmbed(channel, owner, theme);
            await panelMessage.edit({ embeds: [embed] });
        }
    } catch (error) {
        console.error('[Addon:VoiceChatSystem] Failed to update control panel:', error);
    }
}

async function sendControlPanel(channel, member, theme) {
    const embed = await createControlPanelEmbed(channel, member, theme);

    // Row 1: General Channel Settings
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_rename').setLabel('Rename').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
        new ButtonBuilder().setCustomId('vc_limit').setLabel('Limit').setStyle(ButtonStyle.Primary).setEmoji('👥'),
        new ButtonBuilder().setCustomId('vc_bitrate').setLabel('Bitrate').setStyle(ButtonStyle.Primary).setEmoji('📶'),
        new ButtonBuilder().setCustomId('vc_toggle_stream').setLabel('Streaming').setStyle(ButtonStyle.Secondary).setEmoji('📹')
    );

    // Row 2: Region Select Menu
    const voiceRegions = await channel.client.rest.get(Routes.voiceRegions());
    const currentRegion = channel.rtcRegion;

    const regionOptions = voiceRegions
        .filter(region => !region.deprecated)
        .map(region => ({
            label: region.name,
            value: region.id,
            description: region.optimal ? 'Optimal' : undefined,
            default: region.id === currentRegion,
        }));

    regionOptions.unshift({ label: 'Automatic', value: 'auto', description: 'Let Discord choose the best region.', default: !currentRegion });

    const regionSelectMenu = new StringSelectMenuBuilder()
        .setCustomId('vc_select_region')
        .setPlaceholder('Select a Voice Region')
        .addOptions(regionOptions.slice(0, 25));

    const row2 = new ActionRowBuilder().addComponents(
        regionSelectMenu
    );

    // Row 3: Access & User Management
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_toggle_lock').setLabel('Lock/Unlock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
        new ButtonBuilder().setCustomId('vc_toggle_visibility').setLabel('Hide/Unhide').setStyle(ButtonStyle.Secondary).setEmoji('👁️'),
        new ButtonBuilder().setCustomId('vc_kick').setLabel('Kick').setStyle(ButtonStyle.Danger).setEmoji('👢'),
        new ButtonBuilder().setCustomId('vc_permit').setLabel('Permit').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('vc_reject').setLabel('Reject').setStyle(ButtonStyle.Danger).setEmoji('🚫')
    );

    // Row 4: Ownership & Danger Zone
    const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_transfer').setLabel('Transfer').setStyle(ButtonStyle.Primary).setEmoji('👑'),
        new ButtonBuilder().setCustomId('vc_claim').setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🙌'),
        new ButtonBuilder().setCustomId('vc_delete').setLabel('Disband').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
    );

    try {
        return await channel.send({ content: `${member}`, embeds: [embed], components: [row1, row2, row3, row4] });
    } catch (error) {
        console.error('[Addon:VoiceChatSystem] Failed to send control panel:', error);
        return null;
    }
}

module.exports = { initialize };