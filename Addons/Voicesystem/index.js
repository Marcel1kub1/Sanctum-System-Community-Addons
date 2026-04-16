const { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, ModalBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
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
                        { id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Speak] },
                        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] }
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
            
            // Claim allows non-owners to take over if the owner left
            if (interaction.customId === 'vc_claim') {
                if (channelInfo.ownerId === interaction.user.id) return interaction.reply({ content: 'You already own this channel!', ephemeral: true });
                if (channel.members.has(channelInfo.ownerId)) return interaction.reply({ content: 'The current owner is still in the channel.', ephemeral: true });
                
                data.activeChannels[channel.id].ownerId = interaction.user.id;
                saveGuildData(guildId, data);
                await channel.permissionOverwrites.edit(interaction.user.id, { ManageChannels: true, MuteMembers: true, DeafenMembers: true, MoveMembers: true, ViewChannel: true, SendMessages: true, Speak: true, Connect: true });
                return interaction.reply({ content: '👑 You successfully claimed ownership of this channel!', ephemeral: true });
            }

            if (channelInfo.ownerId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: '❌ Only the owner of this channel can use these controls.', ephemeral: true });
            }

            if (interaction.customId === 'vc_lock') {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
                return interaction.reply({ content: '🔒 Channel Locked! No one else can join.', ephemeral: true });
            }
            if (interaction.customId === 'vc_unlock') {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
                return interaction.reply({ content: '🔓 Channel Unlocked! Anyone can join now.', ephemeral: true });
            }
            if (interaction.customId === 'vc_hide') {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false });
                return interaction.reply({ content: '👻 Channel Hidden! It is now invisible to others.', ephemeral: true });
            }
            if (interaction.customId === 'vc_unhide') {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: null });
                return interaction.reply({ content: '👁️ Channel Visible! Everyone can see it again.', ephemeral: true });
            }
            if (interaction.customId === 'vc_mute_all') {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Speak: false });
                return interaction.reply({ content: '🔇 Everyone else has been muted.', ephemeral: true });
            }
            if (interaction.customId === 'vc_unmute_all') {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Speak: null });
                return interaction.reply({ content: '🔊 Everyone can speak again.', ephemeral: true });
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
            if (interaction.customId === 'vc_bitrate') {
                const modal = new ModalBuilder().setCustomId('vc_modal_bitrate').setTitle('Set Audio Bitrate (kbps)');
                const input = new TextInputBuilder().setCustomId('bitrate').setLabel('Bitrate (8-96 for standard servers)').setStyle(TextInputStyle.Short).setValue(String(channel.bitrate / 1000));
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            // Interactions requiring User Selection
            if (interaction.customId === 'vc_permit_req') {
                const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('vc_select_permit').setPlaceholder('Select a user to permit'));
                return interaction.reply({ content: 'Who do you want to allow into your channel?', components: [row], ephemeral: true });
            }
            if (interaction.customId === 'vc_kick_req') {
                const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('vc_select_kick').setPlaceholder('Select a user to kick'));
                return interaction.reply({ content: 'Who do you want to kick from your channel?', components: [row], ephemeral: true });
            }
            if (interaction.customId === 'vc_ban_req') {
                const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('vc_select_ban').setPlaceholder('Select a user to ban'));
                return interaction.reply({ content: 'Who do you want to ban from your channel?', components: [row], ephemeral: true });
            }
            if (interaction.customId === 'vc_transfer_req') {
                const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('vc_select_transfer').setPlaceholder('Select the new owner'));
                return interaction.reply({ content: 'Who do you want to transfer ownership to?', components: [row], ephemeral: true });
            }
        }

        // Handle the User Selection Menus
        if (interaction.isUserSelectMenu() && interaction.customId.startsWith('vc_select_')) {
            const channel = interaction.member?.voice?.channel;
            if (!channel) return interaction.reply({ content: 'You must be in a voice channel.', ephemeral: true });
            const channelInfo = data.activeChannels[channel.id];
            if (!channelInfo) return interaction.reply({ content: 'This is not a managed voice channel.', ephemeral: true });
            if (channelInfo.ownerId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: '❌ Only the owner can use this.', ephemeral: true });
            }

            const targetId = interaction.values[0];
            const targetMember = interaction.guild.members.cache.get(targetId) || await interaction.guild.members.fetch(targetId).catch(() => null);
            if (!targetMember) return interaction.reply({ content: 'User not found.', ephemeral: true });
            if (targetId === interaction.user.id) return interaction.reply({ content: 'You cannot perform this action on yourself.', ephemeral: true });

            if (interaction.customId === 'vc_select_permit') {
                await channel.permissionOverwrites.edit(targetId, { Connect: true, ViewChannel: true });
                return interaction.reply({ content: `🟢 **${targetMember.user.tag}** has been permitted to join.`, ephemeral: true });
            } else if (interaction.customId === 'vc_select_kick') {
                if (targetMember.voice.channelId === channel.id) await targetMember.voice.disconnect();
                return interaction.reply({ content: `🔴 **${targetMember.user.tag}** was kicked.`, ephemeral: true });
            } else if (interaction.customId === 'vc_select_ban') {
                await channel.permissionOverwrites.edit(targetId, { Connect: false, ViewChannel: false });
                if (targetMember.voice.channelId === channel.id) await targetMember.voice.disconnect();
                return interaction.reply({ content: `🚫 **${targetMember.user.tag}** is now banned from this channel.`, ephemeral: true });
            } else if (interaction.customId === 'vc_select_transfer') {
                data.activeChannels[channel.id].ownerId = targetId;
                saveGuildData(guildId, data);
                await channel.permissionOverwrites.edit(targetId, { ManageChannels: true, MuteMembers: true, DeafenMembers: true, MoveMembers: true, ViewChannel: true, SendMessages: true, Speak: true, Connect: true });
                await channel.permissionOverwrites.edit(interaction.user.id, { ManageChannels: null }); // Revoke original owner perms
                return interaction.reply({ content: `🤝 Ownership transferred to **${targetMember.user.tag}**.`, ephemeral: true });
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
            if (interaction.customId === 'vc_modal_bitrate') {
                const bitrateStr = interaction.fields.getTextInputValue('bitrate');
                const bitrate = parseInt(bitrateStr);
                if (isNaN(bitrate) || bitrate < 8 || bitrate > 384) return interaction.reply({ content: '❌ Invalid bitrate. Must be between 8 and 384.', ephemeral: true });
                await channel.setBitrate(bitrate * 1000).catch(() => {});
                if (!interaction.replied) return interaction.reply({ content: `📻 Audio bitrate updated to **${bitrate} kbps**!`, ephemeral: true });
            }
        }
    });
}

function sendControlPanel(channel, member, theme) {
    const embed = createThemedEmbed(theme, {
        title: '🎛️ Voice Control Panel',
        description: `Welcome, ${member}! Use the buttons below to manage your channel.`
    });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_lock').setLabel('Lock 🔒').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vc_unlock').setLabel('Unlock 🔓').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vc_hide').setLabel('Hide 👻').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vc_unhide').setLabel('Unhide 👁️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vc_rename').setLabel('Rename ✏️').setStyle(ButtonStyle.Primary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_limit').setLabel('Limit 👥').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('vc_bitrate').setLabel('Bitrate 📻').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('vc_mute_all').setLabel('Mute All 🔇').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vc_unmute_all').setLabel('Unmute All 🔊').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vc_claim').setLabel('Claim 👑').setStyle(ButtonStyle.Success)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_permit_req').setLabel('Permit 🟢').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vc_kick_req').setLabel('Kick 🔴').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vc_ban_req').setLabel('Ban 🚫').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vc_transfer_req').setLabel('Transfer 🤝').setStyle(ButtonStyle.Primary)
    );

    channel.send({ content: `${member}`, embeds: [embed], components: [row1, row2, row3] }).catch(console.error);
}

module.exports = { initialize };
