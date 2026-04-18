const {
    SlashCommandBuilder,
    Events,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const config = require('../../config/config');

// This map will store all the guild-specific music queues
// It will hold an object with the player instance, song queue, and text channel.
const guildQueues = new Map();

// These will be initialized once across all guilds.
let shoukaku = null;
let globalContext = null;

// --- Define all the slash commands for the music bot ---
// This structure remains the same.
const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Plays a song from YouTube, Spotify, or SoundCloud.')
        .addStringOption(option =>
            option.setName('query')
            .setDescription('The song URL or search query.')
            .setRequired(true)),
    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skips the current song.'),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stops the music, clears the queue, and leaves the channel.'),
    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Displays the current song queue.'),
    new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Shows what song is currently playing.'),
    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pauses the music.'),
    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Resumes the music.')
];

/**
 * The main entry point for the addon, called by the addon manager.
 */
function initialize(client, guildId, context) {
    globalContext = context;
    console.log(`[Addon:MusicPlayer] Initializing for server ${guildId}...`);

    // Initialize Shoukaku (the Lavalink client) only once.
    if (!shoukaku) {
        if (!config.lavalink || !config.lavalink.nodes) {
            console.error('[Addon:MusicPlayer] Lavalink configuration is missing from config/config.js!');
            return;
        }
        // Connects to the Lavalink node(s) specified in your config file.
        shoukaku = new Shoukaku(new Connectors.DiscordJS(client), config.lavalink.nodes);
        client.shoukaku = shoukaku; // Attach to the main client for global access.

        // Shoukaku event listeners for debugging and stability.
        shoukaku.on('ready', (name) => console.log(`[Lavalink] Node '${name}' is now connected.`));
        shoukaku.on('error', (name, error) => console.error(`[Lavalink] Node '${name}' encountered an error:`, error));
        shoukaku.on('close', (name, code, reason) => console.log(`[Lavalink] Node '${name}' closed, code ${code}, reason: ${reason || 'No reason'}`));
        shoukaku.on('disconnect', (name, players, moved) => console.log(`[Lavalink] Node '${name}' disconnected, moved ${moved} players.`));

        // Fix for dynamic addon loading: Shoukaku misses the Discord 'ready' event because the bot is already online.
        if (client.isReady() && !shoukaku.id) {
            console.log('[Lavalink] Bot is already ready, manually triggering Lavalink connection...');
            shoukaku.id = client.user.id;
            for (const node of config.lavalink.nodes) {
                shoukaku.addNode(node);
            }
        }
    }

    // Register all music commands for this specific guild
    commands.forEach(command => {
        client.application?.commands.create(command.toJSON(), guildId).catch(console.error);
    });

    // Hot-reloadable interaction listener setup
    if (client.__musicListener) {
        client.removeListener(Events.InteractionCreate, client.__musicListener);
    }

    client.__musicListener = async interaction => {
        if (!interaction.guild) return;

        if (interaction.isChatInputCommand()) {
            const isMusicCommand = commands.some(c => c.name === interaction.commandName);
            if (!isMusicCommand) return;

            try {
                switch (interaction.commandName) {
                    case 'play': await handlePlay(interaction); break;
                    case 'skip': await handleSkip(interaction); break;
                    case 'stop': await handleStop(interaction); break;
                    case 'queue': await handleQueue(interaction); break;
                    case 'nowplaying': await handleNowPlaying(interaction); break;
                    case 'pause': await handlePause(interaction); break;
                    case 'resume': await handleResume(interaction); break;
                }
            } catch (error) {
                console.error(`[MusicPlayer] Command Error (${interaction.commandName}):`, error);
                const errorMsg = '❌ An error occurred while executing this command. It may have expired or timed out.';
                if (interaction.replied || interaction.deferred) {
                    await interaction.editReply({ content: errorMsg, embeds: [] }).catch(() => {});
                } else {
                    await interaction.reply({ content: errorMsg, ephemeral: true }).catch(() => {});
                }
            }
        } else if (interaction.isButton()) {
            if (!interaction.customId.startsWith('music_')) return;
            try {
                await handleMusicButtons(interaction);
            } catch (error) {
                console.error(`[MusicPlayer] Button Error (${interaction.customId}):`, error);
            }
        }
    };

    client.on(Events.InteractionCreate, client.__musicListener);
}

// --- Command Handler Functions ---

async function handlePlay(interaction) {
    await interaction.deferReply();
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
        return interaction.editReply('You need to be in a voice channel to play music!');
    }

    if (!interaction.client.shoukaku) {
        return interaction.editReply('Lavalink is not ready. Please try again in a moment.');
    }

    let node;
    try {
        // In Shoukaku V4, getNode() was removed. We use nodeResolver to get the best node.
        node = interaction.client.shoukaku.options.nodeResolver(interaction.client.shoukaku.nodes);
        // Fallback in case the resolver doesn't return anything but nodes are connected
        if (!node) node = interaction.client.shoukaku.nodes.values().next().value;
        if (!node) {
            // This case handles when getNode() returns undefined but doesn't throw.
            return interaction.editReply('No Lavalink node could be selected. Please check the bot console.');
        }
    } catch (error) {
        // This case handles when getNode() throws an error (e.g., no nodes connected at all).
        console.error('[MusicPlayer] Failed to get Lavalink node:', error);
        return interaction.editReply('No Lavalink nodes are connected. Please check the bot console.');
    }

    const query = interaction.options.getString('query');
    // Use Lavalink to resolve the query. It supports URLs and search queries.
    const result = await node.rest.resolve(query.startsWith('http') ? query : `ytsearch:${query}`);
    
    // Lavalink V4 uses lowercase loadTypes (empty, error, track, playlist, search)
    if (!result || result.loadType === 'empty' || result.loadType === 'error') {
        return interaction.editReply(`❌ No results found for "${query}"`);
    }

    let tracks = [];
    let playlistName = null;

    if (result.loadType === 'playlist') {
        tracks = result.data.tracks;
        playlistName = result.data.info.name;
    } else if (result.loadType === 'search') {
        const track = result.data[0];
        if (!track) return interaction.editReply(`❌ No results found for "${query}"`);
        tracks = [track];
    } else if (result.loadType === 'track') {
        tracks = [result.data];
    }

    let serverQueue = guildQueues.get(interaction.guild.id);
    let player;

    if (!serverQueue) {
        try {
            // In Shoukaku V4, you join channels via the main shoukaku instance, not the node.
            player = await interaction.client.shoukaku.joinVoiceChannel({
                guildId: interaction.guild.id,
                channelId: voiceChannel.id,
                shardId: interaction.guild.shardId,
                deaf: true
            });
        } catch (error) {
            console.error('[MusicPlayer] Error joining voice channel:', error);
            return interaction.editReply('Could not join the voice channel!');
        }

        const newQueue = {
            player: player,
            songs: [],
            textChannel: interaction.channel,
            loop: false,
            paused: false,
            nowPlayingMessage: null
        };
        guildQueues.set(interaction.guild.id, newQueue);
        serverQueue = newQueue;

        // --- Player Event Listeners ---
        // When a song finishes, play the next one.
        player.on('end', () => {
            const q = guildQueues.get(interaction.guild.id);
            if (q) {
                if (!q.loop) {
                    q.songs.shift();
                }
                playNextSong(interaction.guild, q.player);
            }
        });
        // Handle player errors.
        player.on('exception', (error) => {
            console.error(`[MusicPlayer] Player Exception in guild ${interaction.guild.id}:`, error);
            const q = guildQueues.get(interaction.guild.id);
            q?.textChannel.send('An error occurred with the player. Trying to skip to the next song.');
        });
        // Clean up when the connection is closed.
        player.on('closed', (reason) => {
            console.log(`[MusicPlayer] Player closed in guild ${interaction.guild.id}:`, reason);
            if (reason && reason.code === 4017) {
                const q = guildQueues.get(interaction.guild.id);
                if (q && q.textChannel) {
                    q.textChannel.send('❌ **Connection blocked:** This voice channel has **End-to-End Encryption (E2EE)** enabled.\n\n**How to fix:**\n1. Hover over the Voice Channel and click the **Edit Channel (Gear Icon)**.\n2. Go to the **Overview** tab.\n3. Scroll down and turn **OFF** the toggle for **Enable End-to-End Encryption**.\n4. Save your changes and try playing a song again!').catch(() => {});
                }
            }
            guildQueues.delete(interaction.guild.id);
        });

    } else {
        player = serverQueue.player;
    }

    const songs = tracks.map(track => ({
        title: track.info.title,
        url: track.info.uri,
        // Format duration from ms to HH:MM:SS or MM:SS
        duration: new Date(track.info.length).toISOString().slice(11, 19).replace(/^00:/, ''),
        thumbnail: (track.info.uri.includes("youtube") || track.info.uri.includes("youtu.be")) ? `https://img.youtube.com/vi/${track.info.identifier}/hqdefault.jpg` : null,
        requestedBy: interaction.user,
        track: track.encoded // The base64 encoded track from Lavalink
    }));

    serverQueue.songs.push(...songs);

    // If the player is not playing anything, start it.
    if (!player.track) {
        playNextSong(interaction.guild, player);
    }

    // --- Reply to the user ---
    const guildSettings = await globalContext.getGuildSettings(interaction.guild.id);
    const theme = guildSettings.theme || 'dark';
    if (playlistName) {
        const embedParams = {
            title: '🎶 Playlist Added',
            description: `Added **${songs.length}** songs from **${playlistName}** to the queue.`,
        };
        if (songs[0].thumbnail) {
            embedParams.thumbnail = { url: songs[0].thumbnail };
            embedParams.image = { url: songs[0].thumbnail };
        }
        const embed = globalContext.createThemedEmbed(theme, embedParams);
        return interaction.editReply({ embeds: [embed] });
    } else {
        const embedParams = {
            title: '🎵 Song Added to Queue',
            description: `**[${songs[0].title}](${songs[0].url})**`,
            fields: [{ name: 'Duration', value: songs[0].duration, inline: true }],
            footer: { text: `Requested by ${songs[0].requestedBy.tag}` }
        };
        if (songs[0].thumbnail) {
            embedParams.thumbnail = { url: songs[0].thumbnail };
            embedParams.image = { url: songs[0].thumbnail };
        }
        const embed = globalContext.createThemedEmbed(theme, embedParams);
        return interaction.editReply({ embeds: [embed] });
    }
}

async function playNextSong(guild, player) {
    const serverQueue = guildQueues.get(guild.id);
    if (!serverQueue || !serverQueue.songs.length) {
        serverQueue?.textChannel.send('✅ Queue finished. Leaving voice channel.');
        if (player) guild.client.shoukaku.leaveVoiceChannel(guild.id);
        guildQueues.delete(guild.id);
        return;
    }

    const song = serverQueue.songs[0];
    try {
        // In Shoukaku V4, the track must be passed inside an 'encoded' property
        await player.playTrack({ track: { encoded: song.track } });

        const guildSettings = await globalContext.getGuildSettings(guild.id);
        const theme = guildSettings.theme || 'dark';
        const embedParams = {
            title: '▶️ Now Playing',
            description: `**${song.title}**`,
            fields: [{ name: 'Duration', value: song.duration, inline: true }],
            footer: { text: `Requested by ${song.requestedBy.tag}` }
        };
        if (song.thumbnail) {
            embedParams.thumbnail = { url: song.thumbnail };
            embedParams.image = { url: song.thumbnail };
        }
        const embed = globalContext.createThemedEmbed(theme, embedParams);
        
        if (serverQueue.nowPlayingMessage) {
            serverQueue.nowPlayingMessage.edit({ components: [] }).catch(() => {});
        }

        serverQueue.nowPlayingMessage = await serverQueue.textChannel.send({ 
            embeds: [embed],
            components: [getMusicControlRow(serverQueue)]
        });
    } catch (error) {
        console.error(`[MusicPlayer] Play Error in guild ${guild.id}:`, error);
        serverQueue.textChannel.send(`❌ Error playing ${song.title}. Skipping.`);
        if (!serverQueue.loop) {
            serverQueue.songs.shift();
        }
        playNextSong(guild, player);
    }
}

async function handleSkip(interaction) {
    if (!interaction.member.voice.channel) return interaction.reply({ content: 'You are not in a voice channel!', ephemeral: true });
    const serverQueue = guildQueues.get(interaction.guild.id);
    if (!serverQueue || !serverQueue.player) return interaction.reply({ content: 'There is no song that I could skip!', ephemeral: true });
    
    serverQueue.player.stopTrack(); // The 'end' event will trigger the next song.
    await interaction.reply('⏭️ Skipped the current song.');
}

async function handleStop(interaction) {
    if (!interaction.member.voice.channel) return interaction.reply({ content: 'You are not in a voice channel!', ephemeral: true });
    const serverQueue = guildQueues.get(interaction.guild.id);
    if (!serverQueue || !serverQueue.player) return interaction.reply({ content: 'There is nothing to stop!', ephemeral: true });

    serverQueue.songs = [];
    serverQueue.loop = false;
    if (serverQueue.nowPlayingMessage) {
        serverQueue.nowPlayingMessage.edit({ components: [] }).catch(() => {});
    }
    interaction.client.shoukaku.leaveVoiceChannel(interaction.guild.id); // V4 method to leave
    guildQueues.delete(interaction.guild.id);
    await interaction.reply('⏹️ Stopped the music and cleared the queue.');
}

async function handleQueue(interaction) {
    const serverQueue = guildQueues.get(interaction.guild.id);
    if (!serverQueue || !serverQueue.songs.length) {
        return interaction.reply({ content: 'The queue is currently empty.', ephemeral: true });
    }

    const guildSettings = await globalContext.getGuildSettings(interaction.guild.id);
    const theme = guildSettings.theme || 'dark';
    const nowPlaying = serverQueue.songs[0];
    const queueString = serverQueue.songs
        .slice(1, 11)
        .map((song, index) => `${index + 1}. ${song.title} \`[${song.duration}]\``)
        .join('\n');

    const embedParams = {
        title: '🎶 Music Queue',
        description: `**Now Playing:**\n${nowPlaying.title} \`[${nowPlaying.duration}]\`\n\n**Up Next:**\n${queueString || 'Nothing else in the queue.'}`,
        footer: { text: `Total songs in queue: ${serverQueue.songs.length}` }
    };
    if (nowPlaying.thumbnail) {
        embedParams.thumbnail = { url: nowPlaying.thumbnail };
        embedParams.image = { url: nowPlaying.thumbnail };
    }
    const embed = globalContext.createThemedEmbed(theme, embedParams);

    await interaction.reply({ embeds: [embed] });
}

async function handleNowPlaying(interaction) {
    const serverQueue = guildQueues.get(interaction.guild.id);
    if (!serverQueue || !serverQueue.songs.length) {
        return interaction.reply({ content: 'Nothing is currently playing.', ephemeral: true });
    }
    const song = serverQueue.songs[0];
    const guildSettings = await globalContext.getGuildSettings(interaction.guild.id);
    const theme = guildSettings.theme || 'dark';

    const embedParams = {
        title: '▶️ Now Playing',
        description: `**${song.title}**`,
        fields: [{ name: 'Duration', value: song.duration, inline: true }],
        footer: { text: `Requested by ${song.requestedBy.tag}` }
    };
    if (song.thumbnail) {
        embedParams.thumbnail = { url: song.thumbnail };
        embedParams.image = { url: song.thumbnail };
    }
    const embed = globalContext.createThemedEmbed(theme, embedParams);
    
    if (serverQueue.nowPlayingMessage) {
        serverQueue.nowPlayingMessage.edit({ components: [] }).catch(() => {});
    }
    const message = await interaction.reply({ embeds: [embed], components: [getMusicControlRow(serverQueue)], fetchReply: true });
    serverQueue.nowPlayingMessage = message;
}

async function handlePause(interaction) {
    if (!interaction.member.voice.channel) return interaction.reply({ content: 'You are not in a voice channel!', ephemeral: true });
    const serverQueue = guildQueues.get(interaction.guild.id);
    if (!serverQueue || !serverQueue.player) return interaction.reply({ content: 'There is nothing to pause!', ephemeral: true });
    
    serverQueue.paused = true;
    const success = await serverQueue.player.setPaused(true);
    if (serverQueue.nowPlayingMessage) {
        serverQueue.nowPlayingMessage.edit({ components: [getMusicControlRow(serverQueue)] }).catch(() => {});
    }
    await interaction.reply({ content: success ? '⏸️ Paused the music.' : 'Could not pause the music.', ephemeral: true });
}

async function handleResume(interaction) {
    if (!interaction.member.voice.channel) return interaction.reply({ content: 'You are not in a voice channel!', ephemeral: true });
    const serverQueue = guildQueues.get(interaction.guild.id);
    if (!serverQueue || !serverQueue.player) return interaction.reply({ content: 'There is nothing to resume!', ephemeral: true });

    serverQueue.paused = false;
    const success = await serverQueue.player.setPaused(false);
    if (serverQueue.nowPlayingMessage) {
        serverQueue.nowPlayingMessage.edit({ components: [getMusicControlRow(serverQueue)] }).catch(() => {});
    }
    await interaction.reply({ content: success ? '▶️ Resumed the music.' : 'Could not resume the music.', ephemeral: true });
}

function getMusicControlRow(serverQueue) {
    const playPauseBtn = new ButtonBuilder()
        .setCustomId('music_toggle_pause')
        .setLabel(serverQueue.paused ? '▶️ Resume' : '⏸️ Pause')
        .setStyle(serverQueue.paused ? ButtonStyle.Success : ButtonStyle.Secondary);

    const skipBtn = new ButtonBuilder()
        .setCustomId('music_skip')
        .setLabel('⏭️ Skip')
        .setStyle(ButtonStyle.Primary);

    const stopBtn = new ButtonBuilder()
        .setCustomId('music_stop')
        .setLabel('⏹️ Stop')
        .setStyle(ButtonStyle.Danger);

    const loopBtn = new ButtonBuilder()
        .setCustomId('music_toggle_loop')
        .setLabel(serverQueue.loop ? '🔁 Loop: ON' : '🔁 Loop: OFF')
        .setStyle(serverQueue.loop ? ButtonStyle.Success : ButtonStyle.Secondary);

    return new ActionRowBuilder().addComponents(playPauseBtn, skipBtn, stopBtn, loopBtn);
}

async function handleMusicButtons(interaction) {
    const serverQueue = guildQueues.get(interaction.guild.id);
    if (!serverQueue || !serverQueue.player) {
        return interaction.reply({ content: '❌ No active music session.', ephemeral: true });
    }
    
    const botVoiceChannel = interaction.guild.members.me?.voice?.channelId;
    if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== botVoiceChannel) {
        return interaction.reply({ content: '❌ You must be in the same voice channel as the bot to use these controls.', ephemeral: true });
    }

    switch (interaction.customId) {
        case 'music_toggle_pause':
            serverQueue.paused = !serverQueue.paused;
            await serverQueue.player.setPaused(serverQueue.paused);
            await interaction.update({ components: [getMusicControlRow(serverQueue)] });
            break;
        case 'music_skip':
            await interaction.deferUpdate();
            serverQueue.player.stopTrack(); // Triggers 'end' event, playing next track
            break;
        case 'music_stop':
            serverQueue.songs = [];
            serverQueue.loop = false;
            if (serverQueue.nowPlayingMessage) {
                serverQueue.nowPlayingMessage.edit({ components: [] }).catch(() => {});
            }
            interaction.client.shoukaku.leaveVoiceChannel(interaction.guild.id);
            guildQueues.delete(interaction.guild.id);
            await interaction.update({ components: [] });
            interaction.followUp({ content: '⏹️ Music stopped and queue cleared.', ephemeral: true });
            break;
        case 'music_toggle_loop':
            serverQueue.loop = !serverQueue.loop;
            await interaction.update({ components: [getMusicControlRow(serverQueue)] });
            break;
    }
}

module.exports = { initialize };
