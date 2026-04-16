const {
    SlashCommandBuilder,
    Events
} = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');
const play = require('play-dl');

// This map will store all the guild-specific music queues
const guildQueues = new Map();
let listenersAttached = false;
let globalContext = null;

// --- Define all the slash commands for the music bot ---
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
        
        const serverQueue = guildQueues.get(interaction.guild.id);

        // Route the interaction to the correct handler function
        switch (interaction.commandName) {
            case 'play':
                await handlePlay(interaction, serverQueue);
                break;
            case 'skip':
                await handleSkip(interaction, serverQueue);
                break;
            case 'stop':
                await handleStop(interaction, serverQueue);
                break;
            case 'queue':
                await handleQueue(interaction, serverQueue);
                break;
            case 'nowplaying':
                await handleNowPlaying(interaction, serverQueue);
                break;
            case 'pause':
                await handlePause(interaction, serverQueue);
                break;
            case 'resume':
                await handleResume(interaction, serverQueue);
                break;
        }
    });
}


// --- Command Handler Functions ---

async function handlePlay(interaction, serverQueue) {
    await interaction.deferReply();
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
        return interaction.editReply('You need to be in a voice channel to play music!');
    }

    const query = interaction.options.getString('query');
    let songs = [];

    try {
        const searchResult = await play.search(query, { limit: 1 });
        if (searchResult.length === 0) return interaction.editReply(`❌ No results found for "${query}"`);

        const firstResult = searchResult[0];
        if (firstResult.type === 'playlist') {
            const playlist = await play.playlist_info(firstResult.url, { incomplete: true });
            const videos = await playlist.all_videos();
            songs = videos.map(video => ({
                title: video.title,
                url: video.url,
                duration: video.durationRaw,
                thumbnail: video.thumbnails[0]?.url,
                requestedBy: interaction.user,
            }));
        } else {
            songs.push({
                title: firstResult.title,
                url: firstResult.url,
                duration: firstResult.durationRaw,
                thumbnail: firstResult.thumbnails[0]?.url,
                requestedBy: interaction.user,
            });
        }
    } catch (e) {
        console.error('[MusicPlayer] Search Error:', e);
        return interaction.editReply('There was an error searching for the song!');
    }

    if (!serverQueue) {
        const queueConstruct = {
            textChannel: interaction.channel,
            voiceChannel: voiceChannel,
            connection: null,
            player: createAudioPlayer(),
            songs: songs,
        };
        guildQueues.set(interaction.guild.id, queueConstruct);
        serverQueue = queueConstruct;

        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });
            serverQueue.connection = connection;

            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                } catch (error) {
                    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
                    guildQueues.delete(interaction.guild.id);
                }
            });

            serverQueue.player.on(AudioPlayerStatus.Idle, () => {
                serverQueue.songs.shift();
                playNextSong(interaction.guild, serverQueue);
            });

            serverQueue.player.on('error', error => {
                console.error(`[MusicPlayer] Player Error in guild ${interaction.guild.id}:`, error);
                serverQueue.songs.shift();
                playNextSong(interaction.guild, serverQueue);
            });

            connection.subscribe(serverQueue.player);
            playNextSong(interaction.guild, serverQueue);
        } catch (err) {
            console.error(err);
            guildQueues.delete(interaction.guild.id);
            return interaction.editReply('Could not join the voice channel!');
        }
    } else {
        serverQueue.songs.push(...songs);
    }

    const guildSettings = await globalContext.getGuildSettings(interaction.guild.id);
    const theme = guildSettings.theme || 'dark';
    if (songs.length > 1) {
        const embed = globalContext.createThemedEmbed(theme, {
            title: '🎶 Playlist Added',
            description: `Added **${songs.length}** songs to the queue.`,
        });
        return interaction.editReply({ embeds: [embed] });
    } else {
        const embed = globalContext.createThemedEmbed(theme, {
            title: '🎵 Song Added to Queue',
            description: `[${songs[0].title}](${songs[0].url})`,
            thumbnail: { url: songs[0].thumbnail },
            fields: [{ name: 'Duration', value: songs[0].duration, inline: true }],
            footer: { text: `Requested by ${songs[0].requestedBy.tag}` }
        });
        return interaction.editReply({ embeds: [embed] });
    }
}

async function playNextSong(guild, serverQueue) {
    if (!serverQueue.songs.length) {
        if (serverQueue.connection) serverQueue.connection.destroy();
        guildQueues.delete(guild.id);
        return;
    }

    const song = serverQueue.songs[0];
    try {
        const stream = await play.stream(song.url);
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);

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
        serverQueue.songs.shift();
        playNextSong(guild, serverQueue);
    }
}

async function handleSkip(interaction, serverQueue) {
    if (!interaction.member.voice.channel) return interaction.reply({ content: 'You are not in a voice channel!', ephemeral: true });
    if (!serverQueue) return interaction.reply({ content: 'There is no song that I could skip!', ephemeral: true });
    
    serverQueue.player.stop(); // The 'idle' event will trigger the next song
    await interaction.reply('⏭️ Skipped the current song.');
}

async function handleStop(interaction, serverQueue) {
    if (!interaction.member.voice.channel) return interaction.reply({ content: 'You are not in a voice channel!', ephemeral: true });
    if (!serverQueue) return interaction.reply({ content: 'There is nothing to stop!', ephemeral: true });

    serverQueue.songs = [];
    if (serverQueue.connection) serverQueue.connection.destroy();
    guildQueues.delete(interaction.guild.id);
    await interaction.reply('⏹️ Stopped the music and cleared the queue.');
}

async function handleQueue(interaction, serverQueue) {
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

async function handleNowPlaying(interaction, serverQueue) {
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

async function handlePause(interaction, serverQueue) {
    if (!interaction.member.voice.channel) return interaction.reply({ content: 'You are not in a voice channel!', ephemeral: true });
    if (!serverQueue) return interaction.reply({ content: 'There is nothing to pause!', ephemeral: true });
    
    const success = serverQueue.player.pause();
    await interaction.reply({ content: success ? '⏸️ Paused the music.' : 'Could not pause the music.', ephemeral: true });
}

async function handleResume(interaction, serverQueue) {
    if (!interaction.member.voice.channel) return interaction.reply({ content: 'You are not in a voice channel!', ephemeral: true });
    if (!serverQueue) return interaction.reply({ content: 'There is nothing to resume!', ephemeral: true });

    const success = serverQueue.player.unpause();
    await interaction.reply({ content: success ? '▶️ Resumed the music.' : 'Could not resume the music.', ephemeral: true });
}

module.exports = { initialize };
