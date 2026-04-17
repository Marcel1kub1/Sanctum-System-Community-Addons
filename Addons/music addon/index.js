const {
    SlashCommandBuilder,
    Events,
} = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const config = require('../../config/config');

// This map will store all the guild-specific music queues
// It will hold an object with the player instance, song queue, and text channel.
const guildQueues = new Map();

// These will be initialized once across all guilds.
let shoukaku = null;
let listenersAttached = false;
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

    // Attach the global interaction listener only once
    if (!listenersAttached) {
        listenersAttached = true;
        attachMusicListeners(client);
    }
}

/**
 * Attaches a single, global listener for all music-related interactions.
 */
function attachMusicListeners(client) {
    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.isChatInputCommand() || !interaction.guild) return;

        // Check if the command is one of our music commands
        const isMusicCommand = commands.some(c => c.name === interaction.commandName);
        if (!isMusicCommand) return;

        // Route the interaction to the correct handler function
        switch (interaction.commandName) {
            case 'play':
                await handlePlay(interaction);
                break;
            case 'skip':
                await handleSkip(interaction);
                break;
            case 'stop':
                await handleStop(interaction);
                break;
            case 'queue':
                await handleQueue(interaction);
                break;
            case 'nowplaying':
                await handleNowPlaying(interaction);
                break;
            case 'pause':
                await handlePause(interaction);
                break;
            case 'resume':
                await handleResume(interaction);
                break;
        }
    });
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
    const result = await node.rest.loadTrack(query.startsWith('http') ? query : `ytsearch:${query}`);
    if (!result || result.loadType === 'LOAD_EMPTY' || result.loadType === 'LOAD_ERROR') {
        return interaction.editReply(`❌ No results found for "${query}"`);
    }

    let tracks;
    let playlistName = null;

    if (result.loadType === 'LOAD_PLAYLIST') {
        tracks = result.data.tracks;
        playlistName = result.data.info.name;
    } else {
        // For LOAD_SEARCH, result.data is an array. For LOAD_TRACK, it's a single object.
        // We only want the first track from a search.
        const track = Array.isArray(result.data) ? result.data[0] : result.data;
        if (!track) {
            return interaction.editReply(`❌ No results found for "${query}"`);
        }
        tracks = [track];
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
            textChannel: interaction.channel
        };
        guildQueues.set(interaction.guild.id, newQueue);
        serverQueue = newQueue;

        // --- Player Event Listeners ---
        // When a song finishes, play the next one.
        player.on('end', () => {
            const q = guildQueues.get(interaction.guild.id);
            if (q) {
                q.songs.shift();
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
        thumbnail: track.info.uri.includes("youtube.com") ? `https://img.youtube.com/vi/${track.info.identifier}/mqdefault.jpg` : null,
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
        const embed = globalContext.createThemedEmbed(theme, {
            title: '🎶 Playlist Added',
            description: `Added **${songs.length}** songs from **${playlistName}** to the queue.`,
        });
        return interaction.editReply({ embeds: [embed] });
    } else {
        const embed = globalContext.createThemedEmbed(theme, {
            title: '🎵 Song Added to Queue',
            description: `[${songs[0].title}](${songs[0].url})`,
            thumbnail: { url: songs[0].thumbnail }, // Can be null for non-YT tracks
            fields: [{ name: 'Duration', value: songs[0].duration, inline: true }],
            footer: { text: `Requested by ${songs[0].requestedBy.tag}` }
        });
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
        const embed = globalContext.createThemedEmbed(theme, {
            title: '▶️ Now Playing',
            description: `${song.title}`,
            thumbnail: { url: song.thumbnail },
            fields: [{ name: 'Duration', value: song.duration, inline: true }],
            footer: { text: `Requested by ${song.requestedBy.tag}` }
        });
        serverQueue.textChannel.send({ embeds: [embed] });
    } catch (error) {
        console.error(`[MusicPlayer] Play Error in guild ${guild.id}:`, error);
        serverQueue.textChannel.send(`❌ Error playing ${song.title}. Skipping.`);
        // The 'end' event should fire on error, which will then call this function again for the next song.
        serverQueue.songs.shift();
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
    interaction.client.shoukaku.leaveVoiceChannel(interaction.guild.id); // V4 method to leave
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

    const embed = globalContext.createThemedEmbed(theme, {
        title: '🎶 Music Queue',
        description: `**Now Playing:**\n${nowPlaying.title} \`[${nowPlaying.duration}]\`\n\n**Up Next:**\n${queueString || 'Nothing else in the queue.'}`,
        footer: { text: `Total songs in queue: ${serverQueue.songs.length}` }
    });

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

    const embed = globalContext.createThemedEmbed(theme, {
        title: '▶️ Now Playing',
        description: `${song.title}`,
        thumbnail: { url: song.thumbnail },
        fields: [{ name: 'Duration', value: song.duration, inline: true }],
        footer: { text: `Requested by ${song.requestedBy.tag}` }
    });
    await interaction.reply({ embeds: [embed] });
}

async function handlePause(interaction) {
    if (!interaction.member.voice.channel) return interaction.reply({ content: 'You are not in a voice channel!', ephemeral: true });
    const serverQueue = guildQueues.get(interaction.guild.id);
    if (!serverQueue || !serverQueue.player) return interaction.reply({ content: 'There is nothing to pause!', ephemeral: true });
    
    const success = await serverQueue.player.setPaused(true);
    await interaction.reply({ content: success ? '⏸️ Paused the music.' : 'Could not pause the music.', ephemeral: true });
}

async function handleResume(interaction) {
    if (!interaction.member.voice.channel) return interaction.reply({ content: 'You are not in a voice channel!', ephemeral: true });
    const serverQueue = guildQueues.get(interaction.guild.id);
    if (!serverQueue || !serverQueue.player) return interaction.reply({ content: 'There is nothing to resume!', ephemeral: true });

    const success = await serverQueue.player.setPaused(false);
    await interaction.reply({ content: success ? '▶️ Resumed the music.' : 'Could not resume the music.', ephemeral: true });
}

module.exports = { initialize };
