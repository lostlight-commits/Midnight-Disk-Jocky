const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, MessageFlags } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, VoiceConnectionStatus } = require('@discordjs/voice');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const SpotifyWebApi = require('spotify-web-api-node');

const execPromise = promisify(exec);

// Resolve config path relative to this file so systemd/cwd do not matter
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
// Path to yt-dlp binary; can be overridden in config.json with "ytdlp_path"
const YTDLP_BIN = config.ytdlp_path || 'yt-dlp';
// Extra yt-dlp args (for example: ["--cookies", "/path/to/cookies.txt"]).
// Backwards-compatible shortcut: if ytdlp_cookies is set, use it as --cookies file.
// Always prepend --no-config so any global yt-dlp config (which may set -f, etc.)
// does not interfere with the bot's behaviour.
const RAW_YTDLP_ARGS = Array.isArray(config.ytdlp_args)
    ? config.ytdlp_args
    : (config.ytdlp_cookies ? ['--cookies', config.ytdlp_cookies] : []);

const YTDLP_ARGS = ['--no-config', ...RAW_YTDLP_ARGS];

// Optional explicit format for playback; if omitted, yt-dlp chooses the best.
// Example: "best", "bestaudio", or a more complex selector.
const YTDLP_PLAY_FORMAT = typeof config.ytdlp_format === 'string' && config.ytdlp_format.trim()
    ? config.ytdlp_format.trim()
    : null;

// Per-user preference storage (simple JSON file on disk)
const USER_PREFS_PATH = path.join(__dirname, 'user_prefs.json');
let userPreferences = {};

function loadUserPreferences() {
    try {
        if (fs.existsSync(USER_PREFS_PATH)) {
            const raw = fs.readFileSync(USER_PREFS_PATH, 'utf8');
            userPreferences = JSON.parse(raw);
        }
    } catch (err) {
        console.error('Failed to load user preferences:', err.message || err);
        userPreferences = {};
    }
}

function saveUserPreferences() {
    try {
        fs.writeFileSync(USER_PREFS_PATH, JSON.stringify(userPreferences, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save user preferences:', err.message || err);
    }
}

function getUserPreferences(userId) {
    if (!userPreferences[userId]) {
        userPreferences[userId] = {};
    }
    return userPreferences[userId];
}

loadUserPreferences();

if (config.ytdlp_cookies) {
    console.log('Using yt-dlp cookies file from config.');
}
console.log('🎵 Discord Music Bot starting...');

// Spotify API client (client credentials flow, metadata only)
let spotifyApi = null;
let spotifyTokenExpiresAt = 0;

if (config.spotify_client_id && config.spotify_client_secret) {
    spotifyApi = new SpotifyWebApi({
        clientId: config.spotify_client_id,
        clientSecret: config.spotify_client_secret
    });
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const queues = new Map();

// Base URL for Radio Browser public API (use JSON API endpoint)
const RADIO_BROWSER_BASE = 'https://de1.api.radio-browser.info/json';

// Station pagination size for select menus (Discord limit is 25 options)
const RADIO_PAGE_SIZE = 25;

// Per-user radio browsing sessions (stores last fetched station list)
const radioSessions = new Map();

class MusicQueue {
    constructor(guildId) {
        this.guildId = guildId;
        this.songs = [];
        this.connection = null;
        this.player = createAudioPlayer();
        this.volume = 1.0;
        this.loop = false;
        this.isPlaying = false;
        this.currentSong = null;
        this.idleTimeout = null;
        this.restartInterval = null;
        this.currentProcess = null; // Active ffmpeg / yt-dlp child process
        this.connectionListenersAttached = false;

        this.player.on(AudioPlayerStatus.Idle, () => {
            if (this.loop && this.currentSong) {
                this.songs.unshift(this.currentSong);
            }
            this.playNext();
        });

        this.player.on('error', (error) => {
            console.error('Audio error:', error.message);
            this.playNext();
        });

        // Setup restart interval (5 hours)
        this.setupRestartInterval();
    }

    attachConnectionListeners() {
        if (!this.connection || this.connectionListenersAttached) {
            return;
        }

        this.connectionListenersAttached = true;

        this.connection.on(VoiceConnectionStatus.Disconnected, () => {
            console.log('🔌 Voice connection disconnected, cleaning up queue for guild', this.guildId);
            this.stop();
            if (this.connection) {
                try {
                    this.connection.destroy();
                } catch (err) {
                    console.error('Error destroying voice connection:', err.message);
                }
                this.connection = null;
            }
            queues.delete(this.guildId);
        });
    }

    setupRestartInterval() {
        // Restart current stream every 5 hours to prevent disconnects
        this.restartInterval = setInterval(() => {
            if (this.isPlaying && this.currentSong && this.currentSong.type === 'radio') {
                console.log('🔄 Auto-restarting radio stream after 5 hours...');
                const currentSong = this.currentSong;
                this.player.stop();
                setTimeout(() => {
                    this.songs.unshift(currentSong);
                    this.playNext();
                }, 1000);
            }
        }, 5 * 60 * 60 * 1000); // 5 hours
    }

    checkIdleState() {
        // Check if anyone is in the voice channel
        if (!this.connection) return;

        const channel = this.connection.joinConfig.channelId;
        const guild = client.guilds.cache.get(this.guildId);
        if (!guild) return;

        const voiceChannel = guild.channels.cache.get(channel);
        if (!voiceChannel) return;

        const members = voiceChannel.members.filter(m => !m.user.bot);
        
        if (members.size === 0) {
            console.log('👋 No users in voice channel, entering idle mode...');
            this.enterIdleMode();
        } else {
            this.clearIdleTimeout();
        }
    }

    enterIdleMode() {
        this.clearIdleTimeout();
        
        // Wait 5 minutes before leaving
        this.idleTimeout = setTimeout(() => {
            console.log('💤 Idle timeout reached, leaving voice channel...');
            this.stop();
            if (this.connection) {
                this.connection.destroy();
                this.connection = null;
            }
            queues.delete(this.guildId);
        }, 5 * 60 * 1000); // 5 minutes
    }

    clearIdleTimeout() {
        if (this.idleTimeout) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
        }
    }

    cleanup() {
        this.clearIdleTimeout();
        if (this.restartInterval) {
            clearInterval(this.restartInterval);
            this.restartInterval = null;
        }
        this.stopCurrentProcess();
    }

    stopCurrentProcess() {
        if (this.currentProcess) {
            try {
                this.currentProcess.kill('SIGKILL');
            } catch (err) {
                console.error('Failed to kill current media process:', err.message);
            } finally {
                this.currentProcess = null;
            }
        }
    }

    async addSong(songInfo) {
        this.songs.push(songInfo);
        this.clearIdleTimeout(); // User activity detected
        if (!this.isPlaying) {
            await this.playNext();
        }
    }

    async addMultipleSongs(songInfos) {
        this.songs.push(...songInfos);
        this.clearIdleTimeout(); // User activity detected
        if (!this.isPlaying) {
            await this.playNext();
        }
    }

    async playNext() {
        // Ensure any previous media process is terminated before starting a new one
        this.stopCurrentProcess();

        if (this.songs.length === 0) {
            this.isPlaying = false;
            this.currentSong = null;
            this.checkIdleState(); // Check if should enter idle mode
            return;
        }

        this.currentSong = this.songs.shift();
        this.isPlaying = true;
        this.clearIdleTimeout(); // Playing content, clear idle

        try {
            console.log('▶️  Playing:', this.currentSong.title);
            
            let stream;
            let streamType;

            if (this.currentSong.type === 'radio') {
                console.log('📻 Streaming radio via ffmpeg...');
                const ffmpeg = spawn('ffmpeg', [
                    '-i', this.currentSong.url,
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    'pipe:1'
                ]);

                this.currentProcess = ffmpeg;
                stream = ffmpeg.stdout;
                streamType = StreamType.Raw;

                ffmpeg.stderr.on('data', (data) => {
                    const msg = data.toString();
                    if (msg.includes('Error')) {
                        console.error('ffmpeg:', msg.split('\n')[0]);
                    }
                });

                ffmpeg.on('error', (err) => {
                    console.error('ffmpeg spawn error:', err.message);
                    if (this.currentProcess === ffmpeg) {
                        this.currentProcess = null;
                    }
                });

                ffmpeg.on('close', (code) => {
                    if (code && code !== 0 && code !== 255) {
                        console.error('ffmpeg exited with code', code);
                    }
                    if (this.currentProcess === ffmpeg) {
                        this.currentProcess = null;
                    }
                });

			} else {
				console.log('🎵 Streaming YouTube via yt-dlp...');
				// For large Spotify playlists we may have deferred YouTube resolution.
				if (!this.currentSong.url && this.currentSong.deferredQuery) {
					try {
						const ytResults = await searchYouTube(this.currentSong.deferredQuery, 1);
						if (!ytResults || ytResults.length === 0) {
							console.warn('No YouTube match for deferred track:', this.currentSong.deferredQuery);
							// Skip this entry and move on to the next song.
							this.isPlaying = false;
							this.currentSong = null;
							return this.playNext();
						}

						const v = ytResults[0];
						this.currentSong.url = v.url;
						if (!this.currentSong.title) {
							this.currentSong.title = v.title;
						}
					} catch (err) {
						console.error('Deferred YouTube resolution failed:', err.message || err);
						this.isPlaying = false;
						this.currentSong = null;
						return this.playNext();
					}
				}

				// Optional explicit format if configured; otherwise let yt-dlp decide.
				const ytdlpArgs = [
					...(YTDLP_PLAY_FORMAT ? ['-f', YTDLP_PLAY_FORMAT] : []),
					'-o', '-',
					'--no-warnings',
					'--no-playlist',
					this.currentSong.url
				];
				const ytdlp = spawn(YTDLP_BIN, [...YTDLP_ARGS, ...ytdlpArgs]);

                this.currentProcess = ytdlp;
                stream = ytdlp.stdout;
                streamType = StreamType.Arbitrary;

                ytdlp.on('error', (err) => {
                    console.error('yt-dlp spawn error:', err.message);
                    if (this.currentProcess === ytdlp) {
                        this.currentProcess = null;
                    }
                });

                ytdlp.stderr.on('data', (data) => {
                    const msg = data.toString();
                    if (msg.toLowerCase().includes('error')) {
                        console.error('yt-dlp:', msg.split('\n')[0]);
                    }
                });

                ytdlp.on('close', (code) => {
                    if (code && code !== 0 && code !== 255) {
                        console.error('yt-dlp exited with code', code);
                    }
                    if (this.currentProcess === ytdlp) {
                        this.currentProcess = null;
                    }
                });
            }

            if (!this.connection) {
                console.warn('No voice connection available for guild', this.guildId, '- stopping queue.');
                this.stop();
                queues.delete(this.guildId);
                return;
            }

            const resource = createAudioResource(stream, {
                inputType: streamType,
                inlineVolume: true
            });

            resource.volume.setVolume(this.volume);
            this.player.play(resource);
            this.connection.subscribe(this.player);

            console.log('✅ Playback started');

        } catch (error) {
            console.error('Playback failed:', error.message);
            await new Promise(r => setTimeout(r, 1000));
            this.playNext();
        }
    }

    skip() {
        this.stopCurrentProcess();
        this.player.stop();
    }

    pause() {
        return this.player.pause();
    }

    resume() {
        return this.player.unpause();
    }

    stop() {
        this.songs = [];
        this.currentSong = null;
        this.stopCurrentProcess();
        this.player.stop();
        this.isPlaying = false;
        this.cleanup();
    }

    setVolume(vol) {
        this.volume = Math.max(0, Math.min(2, vol));
    }

    shuffle() {
        for (let i = this.songs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.songs[i], this.songs[j]] = [this.songs[j], this.songs[i]];
        }
    }
}

async function getSongInfo(query) {
    try {
        console.log('🔍 Query:', query);

        // Spotify URL detection (tracks & playlists)
        const spotifyInfo = parseSpotifyUrl(query);
        if (spotifyInfo && spotifyApi) {
            const api = await ensureSpotifyAccessToken();
            if (api) {
                if (spotifyInfo.type === 'track') {
                    const trackSong = await resolveSpotifyTrack(api, spotifyInfo.id);
                    if (trackSong) return trackSong;
                } else if (spotifyInfo.type === 'playlist') {
                    // Allow large playlists (up to ~2000 tracks by default)
                    const playlistSongs = await resolveSpotifyPlaylist(api, spotifyInfo.id, 2000);
                    if (playlistSongs && playlistSongs.length > 0) return playlistSongs;
                }
            }
        }

        // Radio station detection
        if (query.match(/\.(mp3|m3u8|aac|pls)(\?.*)?$/i) || 
            query.includes('stream.') || 
            query.includes('ihrhls.com') || 
            query.includes('streamguys')) {
            return {
                title: 'Radio Stream',
                url: query,
                type: 'radio'
            };
        }

async function ensureSpotifyAccessToken() {
    if (!spotifyApi) return null;

    const now = Date.now();
    if (now < spotifyTokenExpiresAt - 60000) {
        return spotifyApi;
    }

    try {
        const data = await spotifyApi.clientCredentialsGrant();
        spotifyApi.setAccessToken(data.body.access_token);
        spotifyTokenExpiresAt = now + (data.body.expires_in * 1000);
        console.log('✅ Spotify access token refreshed');
        return spotifyApi;
    } catch (err) {
        console.error('Spotify token fetch failed:', err.message || err);
        return null;
    }
}

function parseSpotifyUrl(url) {
    if (typeof url !== 'string') return null;

    // open.spotify.com URLs
    let match = url.match(/open\.spotify\.com\/(track|playlist)\/([a-zA-Z0-9]+)/);
    if (match) {
        return { type: match[1], id: match[2] };
    }

    // spotify: URIs
    match = url.match(/^spotify:(track|playlist):([a-zA-Z0-9]+)$/);
    if (match) {
        return { type: match[1], id: match[2] };
    }

    return null;
}

async function resolveSpotifyTrack(api, trackId) {
    try {
        const data = await api.getTrack(trackId);
        const track = data.body;
        const artists = (track.artists || []).map(a => a.name).join(', ');
        const searchQuery = `${track.name} ${artists}`;

        const results = await searchYouTube(searchQuery, 1);
        if (!results || results.length === 0) {
            console.warn('No YouTube match for Spotify track:', searchQuery);
            return null;
        }

        const v = results[0];
        return {
            title: `${track.name} - ${artists}`,
            url: v.url,
            thumbnail: v.thumbnail,
            type: 'youtube'
        };
    } catch (err) {
        console.error('Spotify track resolve failed:', err.message || err);
        return null;
    }
}

// Fetch up to maxTracks tracks from a Spotify playlist, handling pagination.
async function fetchSpotifyPlaylistTracks(api, playlistId, maxTracks) {
    const collected = [];
    const pageSize = 100;
    let offset = 0;

    while (collected.length < maxTracks) {
        const page = await api.getPlaylistTracks(playlistId, {
            offset,
            limit: pageSize
        });

        const items = page.body.items || [];
        if (items.length === 0) {
            break;
        }

        for (const item of items) {
            const track = item && item.track;
            if (!track) continue;
            collected.push(track);
            if (collected.length >= maxTracks) {
                break;
            }
        }

        if (!page.body.next || items.length < pageSize) {
            // No more pages available
            break;
        }

        offset += pageSize;
    }

    return collected;
}

async function resolveSpotifyPlaylist(api, playlistId, maxTracks = 2000) {
    try {
        const tracks = await fetchSpotifyPlaylistTracks(api, playlistId, maxTracks);
        if (!tracks || tracks.length === 0) {
            console.warn('Spotify playlist has no tracks to resolve');
            return [];
        }

        // Build lightweight entries and defer YouTube resolution to playback time
        const results = tracks.map((track) => {
            const artists = (track.artists || []).map(a => a.name).join(', ');
            const title = `${track.name} - ${artists}`;
            const searchQuery = `${track.name} ${artists}`;
            return {
                title,
                url: null, // resolved lazily just before playback
                thumbnail: null,
                type: 'youtube',
                deferredQuery: searchQuery
            };
        });

        console.log(`✅ Prepared ${results.length} tracks from Spotify playlist (lazy YouTube search)`);
        return results;
    } catch (err) {
        console.error('Spotify playlist resolve failed:', err.message || err);
        return null;
    }
}

// Try to resolve a human-friendly playlist name from a URL using Spotify or yt-dlp
async function resolvePlaylistNameFromUrl(url) {
    // Spotify playlist name
    try {
        const spotifyInfo = parseSpotifyUrl(url);
        if (spotifyInfo && spotifyInfo.type === 'playlist' && spotifyApi) {
            const api = await ensureSpotifyAccessToken();
            if (api) {
                const data = await api.getPlaylist(spotifyInfo.id);
                if (data && data.body && data.body.name) {
                    return data.body.name;
                }
            }
        }
    } catch (err) {
        console.error('Spotify playlist name resolve failed:', err.message || err);
    }

    // Fallback: use yt-dlp to inspect the playlist
    try {
        const playlistArgs = [
            '--flat-playlist',
            '--dump-json',
            url
        ];
        const allArgs = [...YTDLP_ARGS, ...playlistArgs];
        const cmd = `${YTDLP_BIN} ${allArgs.map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(' ')}`;
        const { stdout } = await execPromise(cmd);
        const firstLine = stdout
            .trim()
            .split('\n')
            .find(line => line && line.trim().length > 0);

        if (!firstLine) {
            return null;
        }

        const data = JSON.parse(firstLine);
        if (data.playlist_title) return data.playlist_title;
        if (data.title) return data.title;
        return null;
    } catch (err) {
        console.error('Playlist name resolve failed:', err.message || err);
        return null;
    }
}

        // Playlist detection
        if (query.includes('playlist?list=') || query.includes('&list=')) {
            console.log('📋 Detected playlist, fetching videos...');

            try {
                const playlistArgs = [
                    '--flat-playlist',
                    '--dump-json',
                    query
                ];
                const allArgs = [...YTDLP_ARGS, ...playlistArgs];
                const cmd = `${YTDLP_BIN} ${allArgs.map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(' ')}`;
                const { stdout } = await execPromise(cmd);
                const videos = stdout
                    .trim()
                    .split('\n')
                    .map(line => {
                        try {
                            const data = JSON.parse(line);
                            return {
                                title: data.title,
                                url: `https://www.youtube.com/watch?v=${data.id}`,
                                thumbnail: data.thumbnails?.[0]?.url || null,
                                type: 'youtube'
                            };
                        } catch {
                            return null;
                        }
                    })
                    .filter(v => v !== null);

                console.log(`✅ Found ${videos.length} videos in playlist`);
                return videos;
            } catch (err) {
                console.error('Playlist fetch failed:', err.message);
                return null;
            }
        }

        // Direct YouTube URL
        if (query.includes('youtube.com/watch') || query.includes('youtu.be')) {
            return {
                title: 'YouTube Video',
                url: query,
                thumbnail: null,
                type: 'youtube'
            };
        }

        // Search YouTube using yt-dlp
        const ytResults = await searchYouTube(query, 1);
        if (ytResults && ytResults.length > 0) {
            const v = ytResults[0];
            return {
                title: v.title,
                url: v.url,
                thumbnail: v.thumbnail,
                type: 'youtube'
            };
        }

        return null;
    } catch (error) {
        console.error('Search failed:', error.message);
        return null;
    }
}

// ==================== SPOTIFY / YOUTUBE HELPERS ====================

// Use yt-dlp CLI to search YouTube using spawn (no shell) to avoid quoting issues.
async function searchYouTube(query, maxResults = 1) {
    return new Promise((resolve) => {
        try {
            const searchQuery = String(query || '');
            const args = [
                ...YTDLP_ARGS,
                '--flat-playlist',
                '--dump-json',
                `ytsearch${maxResults}:${searchQuery}`
            ];

            const ytdlp = spawn(YTDLP_BIN, args);
            let stdout = '';
            let stderr = '';

            ytdlp.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            ytdlp.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            ytdlp.on('close', (code) => {
                if (code && code !== 0 && code !== 255) {
                    const firstErrLine = (stderr || '').split('\n').find(l => l.trim()) || stderr;
                    console.error('YouTube search failed (code %s): %s', code, firstErrLine || 'unknown error');
                    resolve([]);
                    return;
                }

                const lines = stdout.trim().split('\n').filter(Boolean);
                const results = lines.map(line => {
                    try {
                        const data = JSON.parse(line);
                        return {
                            title: data.title,
                            url: `https://www.youtube.com/watch?v=${data.id}`,
                            thumbnail: data.thumbnails && data.thumbnails[0] ? data.thumbnails[0].url : null,
                            type: 'youtube'
                        };
                    } catch {
                        return null;
                    }
                }).filter(v => v !== null);

                resolve(results);
            });

            ytdlp.on('error', (err) => {
                console.error('YouTube search spawn failed:', err.message || err);
                resolve([]);
            });
        } catch (err) {
            console.error('YouTube search failed:', err.message || err);
            resolve([]);
        }
    });
}

// ==================== SPOTIFY HELPERS ====================

// Logical radio structure used by the bot UI. Each subgroup maps to a
// Radio Browser tag and a list of language codes. For each
// (genre -> subgroup -> language) we will fetch up to 100 stations from the
// Radio Browser API at selection time.
const RADIO_CONFIG = {
    chill: {
        'Lounge': { tag: 'lounge', languages: ['en', 'es', 'fr', 'de'] },
        'Downtempo': { tag: 'downtempo', languages: ['en', 'es'] },
        'Ambient / Chill': { tag: 'chillout', languages: ['en', 'es', 'fr'] }
    },
    country: {
        'Country': { tag: 'country', languages: ['en'] },
        'Bluegrass': { tag: 'bluegrass', languages: ['en'] }
    },
    electronic: {
        'House / Techno': { tag: 'house', languages: ['en', 'de', 'es'] },
        'Trance / DnB': { tag: 'trance', languages: ['en', 'de'] },
        'Ambient / Chill': { tag: 'ambient', languages: ['en', 'es'] }
    },
    hiphop: {
        'Hip Hop': { tag: 'hip hop', languages: ['en', 'fr', 'de'] },
        'R&B': { tag: 'rnb', languages: ['en'] },
        'Lo-Fi': { tag: 'lofi', languages: ['en', 'ja'] }
    },
    jazz: {
        'Jazz': { tag: 'jazz', languages: ['en', 'fr'] },
        'Blues': { tag: 'blues', languages: ['en'] }
    },
    pop: {
        'Pop': { tag: 'pop', languages: ['en', 'es', 'fr'] },
        'Dance': { tag: 'dance', languages: ['en', 'de'] }
    },
    rock: {
        'Classic Rock': { tag: 'classic rock', languages: ['en'] },
        'Hard Rock': { tag: 'hard rock', languages: ['en'] },
        'Alternative': { tag: 'alternative rock', languages: ['en'] },
        'Metal': { tag: 'metal', languages: ['en'] },
        'Disco': { tag: 'disco', languages: ['en'] },
        'Classical': { tag: 'classical', languages: ['en'] }
    },
    world: {
        'Reggae': { tag: 'reggae', languages: ['en'] },
        'Latin': { tag: 'latin', languages: ['es', 'pt'] },
        'Soul': { tag: 'soul', languages: ['en'] }
    }
};

// Helper to deduplicate stations by URL and cap list size (default 100)
function getUniqueStations(stations, maxCount = 100) {
    const seen = new Set();
    const result = [];
    for (const station of stations || []) {
        if (!station || !station.url) continue;
        if (seen.has(station.url)) continue;
        seen.add(station.url);
        result.push(station);
        if (result.length >= maxCount) break;
    }
    return result;
}

// Fetch stations from Radio Browser for a given tag/language
async function fetchRadioStations({ tag, language, limit = 100 }) {
    try {
        const params = new URLSearchParams();
        if (tag) params.set('tag', tag);
        if (language) params.set('language', language);
        params.set('order', 'votes');
        params.set('reverse', 'true');
        params.set('limit', String(limit));

        const url = `${RADIO_BROWSER_BASE}/stations/search?${params.toString()}`;
        const res = await fetch(url);
        if (!res.ok) {
            console.error('Radio Browser HTTP error:', res.status);
            return [];
        }

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('application/json') && !contentType.includes('json')) {
            const body = await res.text();
            console.error('Radio Browser non-JSON response (first 200 chars):', body.slice(0, 200));
            return [];
        }

        let data;
        try {
            data = await res.json();
        } catch (parseErr) {
            console.error('Radio Browser JSON parse failed:', parseErr.message || parseErr);
            return [];
        }
        return data
            .filter(s => s && (s.url_resolved || s.url))
            .map(s => ({
                name: s.name || s.stationuuid || 'Unknown Station',
                url: s.url_resolved || s.url
            }));
    } catch (err) {
        console.error('Radio Browser fetch failed:', err.message);
        return [];
    }
}

// Build station select + pagination buttons for the current user session
function buildStationComponents(userId) {
    const session = radioSessions.get(userId);
    if (!session || !Array.isArray(session.stations) || session.stations.length === 0) {
        return null;
    }

    const { stations, genre, subgroup, language } = session;
    let { page } = session;

    const totalPages = Math.max(1, Math.ceil(stations.length / RADIO_PAGE_SIZE));
    if (page < 0) page = 0;
    if (page >= totalPages) page = totalPages - 1;
    session.page = page;

    const start = page * RADIO_PAGE_SIZE;
    const pageStations = stations.slice(start, start + RADIO_PAGE_SIZE);

    const options = pageStations.map((station, i) => ({
        label: station.name.substring(0, 100),
        value: String(start + i) // global index into stations array
    }));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('radio_station')
        .setPlaceholder('Choose a station')
        .addOptions(options);

    const rows = [new ActionRowBuilder().addComponents(selectMenu)];

    const buttons = [];
    if (page > 0) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId('radio_station_prev')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
        );
    }
    if (page < totalPages - 1) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId('radio_station_next')
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    if (buttons.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(...buttons));
    }

    const content = `📻 **${subgroup}** (${language.toUpperCase()}) stations (page ${page + 1}/${totalPages}):`;
    return { content, components: rows };
}


// ==================== COMMANDS ====================

const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song or YouTube URL')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Song name or YouTube URL')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('radio')
        .setDescription('Play a radio station'),
    
    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current song'),
    
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop playback and clear queue'),
    
    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pause playback'),
    
    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Resume playback'),
    
    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Show the current queue'),
    
    new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Show currently playing song'),
    
    new SlashCommandBuilder()
        .setName('loop')
        .setDescription('Toggle loop mode'),
    
    new SlashCommandBuilder()
        .setName('shuffle')
        .setDescription('Shuffle the queue'),
    
    new SlashCommandBuilder()
        .setName('volume')
        .setDescription('Set volume (0-200)')
        .addIntegerOption(option =>
            option.setName('level')
                .setDescription('Volume level 0-200')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(200)),

    new SlashCommandBuilder()
        .setName('playfavorite')
        .setDescription('Play one of your saved favorites'),

    new SlashCommandBuilder()
        .setName('prefrence')
        .setDescription('View or change your playback preferences and favorites')
        .addBooleanOption(option =>
            option.setName('shuffle')
                .setDescription('Default shuffle for songs you add')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('loop')
                .setDescription('Default loop mode for your playback')
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('volume')
                .setDescription('Default volume level 0-200')
                .setRequired(false)
                .setMinValue(0)
                .setMaxValue(200))
        .addStringOption(option =>
            option.setName('favorite')
                .setDescription('Playlist URL or "radio" to save current station')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('resetcommans')
        .setDescription('Owner only: reset slash commands')
];

// Register commands
const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
    try {
        console.log('🔄 Registering slash commands...');
        await rest.put(
            Routes.applicationCommands(config.clientId),
            { body: commands }
        );
        console.log('✅ Slash commands registered');
    } catch (error) {
        console.error('❌ Command registration failed:', error);
    }
})();

// ==================== EVENTS ====================

client.once(Events.ClientReady, (c) => {
	console.log(`✅ Bot online as ${c.user.tag}`);
	console.log(`📻 Radio genres available: ${Object.keys(RADIO_CONFIG).length}`);
	client.user.setActivity('music 🎵', { type: 'LISTENING' });
});

// Voice state update handler for idle detection
client.on('voiceStateUpdate', (oldState, newState) => {
    const queue = queues.get(oldState.guild.id);
    if (queue && queue.connection) {
        setTimeout(() => queue.checkIdleState(), 1000);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu() && !interaction.isButton()) return;

    const guildId = interaction.guildId;

    // Handle radio station selection and pagination
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'radio_genre') {
            const genre = interaction.values[0];
            const subgroups = RADIO_CONFIG[genre];

            if (!subgroups) {
                await interaction.update({
                    content: '❌ Unknown genre selection.',
                    components: [],
                    embeds: []
                });
                return;
            }

            const options = Object.keys(subgroups).map(subgroup => ({
                label: subgroup,
                value: `${genre}:${subgroup}`
            }));

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('radio_subgroup')
                .setPlaceholder('Choose a station group')
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(selectMenu);
            await interaction.update({ 
                content: `📻 Selected: **${genre}**\nNow choose a station group:`, 
                components: [row], 
                embeds: [] 
            });
            return;
        }

        if (interaction.customId === 'radio_subgroup') {
            const [genre, subgroup] = interaction.values[0].split(':');
            const subgroupConfig = RADIO_CONFIG[genre]?.[subgroup];

            if (!subgroupConfig || !Array.isArray(subgroupConfig.languages) || subgroupConfig.languages.length === 0) {
                await interaction.update({ 
                    content: `❌ No language groups found for **${subgroup}**.`,
                    components: [],
                    embeds: []
                });
                return;
            }

            const options = subgroupConfig.languages.map(lang => ({
                label: lang.toUpperCase(),
                value: `${genre}:${subgroup}:${lang}`
            }));

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('radio_language')
                .setPlaceholder('Choose a language')
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(selectMenu);
            await interaction.update({ 
                content: `📻 **${subgroup}** languages:`, 
                components: [row], 
                embeds: [] 
            });
            return;
        }

        if (interaction.customId === 'radio_language') {
            const [genre, subgroup, language] = interaction.values[0].split(':');
            const subgroupConfig = RADIO_CONFIG[genre]?.[subgroup];

            if (!subgroupConfig) {
                await interaction.update({ 
                    content: '❌ Invalid subgroup selection.',
                    components: [],
                    embeds: []
                });
                return;
            }

            const stationsRaw = await fetchRadioStations({ tag: subgroupConfig.tag, language, limit: 100 });
            const stations = getUniqueStations(stationsRaw, 100);

            if (stations.length === 0) {
                await interaction.update({ 
                    content: `❌ No stations found for **${subgroup}** (${language.toUpperCase()}).`,
                    components: [],
                    embeds: []
                });
                return;
            }

            // Store session for pagination and selection
            radioSessions.set(interaction.user.id, {
                stations,
                genre,
                subgroup,
                language,
                page: 0
            });

            const built = buildStationComponents(interaction.user.id);
            if (!built) {
                await interaction.update({
                    content: '❌ Failed to build station list.',
                    components: [],
                    embeds: []
                });
                return;
            }

            await interaction.update({ 
                content: built.content, 
                components: built.components, 
                embeds: [] 
            });
            return;
        }

        // Favorite type selection: playlist or radio
        if (interaction.customId === 'favorite_type') {
            const type = interaction.values[0];
            const prefs = getUserPreferences(interaction.user.id);

            if (type === 'playlist') {
                const list = Array.isArray(prefs.favoritePlaylists) ? prefs.favoritePlaylists : [];
                if (list.length === 0) {
                    await interaction.update({
                        content: '❌ You have no favorite playlists saved. Use /prefrence to add some.',
                        components: [],
                        embeds: []
                    });
                    return;
                }

                const options = list.map((entry, index) => {
                    let name;
                    if (typeof entry === 'string') {
                        name = entry;
                    } else {
                        name = entry.name || entry.url || `Playlist ${index + 1}`;
                    }
                    return {
                        label: String(name).substring(0, 100),
                        value: String(index)
                    };
                });

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('favorite_playlist')
                    .setPlaceholder('Choose a favorite playlist')
                    .addOptions(options);

                const row = new ActionRowBuilder().addComponents(selectMenu);
                await interaction.update({
                    content: '⭐ Choose a playlist favorite:',
                    components: [row],
                    embeds: []
                });
                return;
            }

            if (type === 'radio') {
                const list = Array.isArray(prefs.favoriteRadios) ? prefs.favoriteRadios : [];
                if (list.length === 0) {
                    await interaction.update({
                        content: '❌ You have no favorite radio stations saved. Use /prefrence favorite:radio while a station is playing.',
                        components: [],
                        embeds: []
                    });
                    return;
                }

                const options = list.map((entry, index) => ({
                    label: String(entry && entry.name ? entry.name : `Radio ${index + 1}`).substring(0, 100),
                    value: String(index)
                }));

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('favorite_radio')
                    .setPlaceholder('Choose a favorite radio station')
                    .addOptions(options);

                const row = new ActionRowBuilder().addComponents(selectMenu);
                await interaction.update({
                    content: '⭐ Choose a radio favorite:',
                    components: [row],
                    embeds: []
                });
                return;
            }
        }

        // Favorite playlist selection
        if (interaction.customId === 'favorite_playlist') {
            const prefs = getUserPreferences(interaction.user.id);
            const list = Array.isArray(prefs.favoritePlaylists) ? prefs.favoritePlaylists : [];
            const index = parseInt(interaction.values[0], 10);

            if (Number.isNaN(index) || !list[index]) {
                await interaction.update({
                    content: '❌ Unable to load that favorite playlist.',
                    components: [],
                    embeds: []
                });
                return;
            }

            const entry = list[index];
            const url = typeof entry === 'string' ? entry : entry.url;
            const displayName = typeof entry === 'string' ? entry : (entry.name || entry.url || 'Playlist');

            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.update({
                    content: '❌ You must be in a voice channel!',
                    components: [],
                    embeds: []
                });
                return;
            }

            await interaction.update({
                content: '⏳ Loading favorite playlist...',
                components: [],
                embeds: []
            });

            try {
                const songInfo = await getSongInfo(url);
                if (!songInfo) {
                    await interaction.followUp({ content: '❌ Could not load that favorite playlist.', flags: MessageFlags.Ephemeral });
                    return;
                }

                let queue = queues.get(guildId);
                if (!queue) {
                    queue = new MusicQueue(guildId);
                    queues.set(guildId, queue);
                }

                // Apply user preferences to this queue instance
                if (typeof prefs.volume === 'number') {
                    queue.setVolume(prefs.volume);
                }
                if (typeof prefs.loop === 'boolean') {
                    queue.loop = prefs.loop;
                }

                if (!queue.connection) {
                    queue.connection = joinVoiceChannel({
                        channelId: voiceChannel.id,
                        guildId: guildId,
                        adapterCreator: interaction.guild.voiceAdapterCreator
                    });
                    queue.attachConnectionListeners();
                }

                if (Array.isArray(songInfo)) {
                    await queue.addMultipleSongs(songInfo);
                    await interaction.followUp({
                        content: `✅ Playing favorite playlist: **${displayName}** (${songInfo.length} tracks added)`,
                        flags: MessageFlags.Ephemeral
                    });
                } else {
                    await queue.addSong(songInfo);
                    await interaction.followUp({
                        content: `✅ Playing favorite: **${songInfo.title}**`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (err) {
                console.error('Failed to play favorite playlist:', err.message || err);
                await interaction.followUp({ content: '❌ Failed to play that favorite playlist.', flags: MessageFlags.Ephemeral });
            }
            return;
        }

        // Favorite radio selection
        if (interaction.customId === 'favorite_radio') {
            const prefs = getUserPreferences(interaction.user.id);
            const list = Array.isArray(prefs.favoriteRadios) ? prefs.favoriteRadios : [];
            const index = parseInt(interaction.values[0], 10);

            if (Number.isNaN(index) || !list[index]) {
                await interaction.update({
                    content: '❌ Unable to load that favorite radio station.',
                    components: [],
                    embeds: []
                });
                return;
            }

            const entry = list[index];
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.update({
                    content: '❌ You must be in a voice channel!',
                    components: [],
                    embeds: []
                });
                return;
            }

            let queue = queues.get(guildId);
            if (!queue) {
                queue = new MusicQueue(guildId);
                queues.set(guildId, queue);
            }

            if (!queue.connection) {
                queue.connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guildId,
                    adapterCreator: interaction.guild.voiceAdapterCreator
                });
                queue.attachConnectionListeners();
            }

            // Instant swap to selected favorite radio station
            queue.stop();
            queue.songs = [];

            await queue.addSong({
                title: entry && entry.name ? entry.name : 'Radio Station',
                url: entry.url,
                type: 'radio'
            });

            await interaction.update({
                content: `📻 Now playing favorite radio: **${entry && entry.name ? entry.name : 'Radio Station'}**`,
                components: [],
                embeds: []
            });
            return;
        }

        if (interaction.customId === 'radio_station') {
            const index = parseInt(interaction.values[0], 10);
            const session = radioSessions.get(interaction.user.id);

            if (!session || !Array.isArray(session.stations) || Number.isNaN(index) || !session.stations[index]) {
                await interaction.update({ content: '❌ Unable to load that station.', components: [], embeds: [] });
                return;
            }

            const { stations, genre, subgroup, language } = session;
            const station = stations[index];

            if (!station) {
                await interaction.update({ content: '❌ Unable to load that station.', components: [], embeds: [] });
                return;
            }

            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.update({ content: '❌ You must be in a voice channel!', components: [], embeds: [] });
                return;
            }

            let queue = queues.get(guildId);
            if (!queue) {
                queue = new MusicQueue(guildId);
                queues.set(guildId, queue);
            }

            if (!queue.connection) {
                queue.connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guildId,
                    adapterCreator: interaction.guild.voiceAdapterCreator
                });
                queue.attachConnectionListeners();
            }

            // INSTANT SWAP - Clear queue and play new station immediately
            queue.stop();
            queue.songs = [];
            
            await queue.addSong({
                title: station.name,
                url: station.url,
                type: 'radio'
            });

            const embed = new EmbedBuilder()
                .setColor('#1DB954')
                .setTitle('📻 Now Playing Radio')
                .setDescription(`**${station.name}**`)
                .addFields(
                    { name: 'Genre', value: genre, inline: true },
                    { name: 'Group', value: subgroup, inline: true }
                )
                .setTimestamp();

            await interaction.update({ content: null, embeds: [embed], components: [] });
            return;
        }
    } else if (interaction.isButton()) {
        if (interaction.customId === 'radio_station_prev' || interaction.customId === 'radio_station_next') {
            const session = radioSessions.get(interaction.user.id);
            if (!session || !Array.isArray(session.stations) || session.stations.length === 0) {
                await interaction.update({
                    content: '❌ Station list expired. Please run /radio again.',
                    components: [],
                    embeds: []
                });
                return;
            }

            const totalPages = Math.max(1, Math.ceil(session.stations.length / RADIO_PAGE_SIZE));

            if (interaction.customId === 'radio_station_prev' && session.page > 0) {
                session.page -= 1;
            } else if (interaction.customId === 'radio_station_next' && session.page < totalPages - 1) {
                session.page += 1;
            }

            const built = buildStationComponents(interaction.user.id);
            if (!built) {
                await interaction.update({
                    content: '❌ Failed to build station list.',
                    components: [],
                    embeds: []
                });
                return;
            }

            await interaction.update({
                content: built.content,
                components: built.components,
                embeds: []
            });
            return;
        }
    }

    // Handle slash commands
    const { commandName } = interaction;

    if (commandName === 'resetcommans') {
        const ownerId = '290553401815597057';
        if (interaction.user.id !== ownerId) {
            return interaction.reply({
                content: '❌ You are not allowed to use this command.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!interaction.guildId) {
            return interaction.reply({
                content: '❌ This command can only be used inside a guild.',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const guildIdForReset = interaction.guildId;

            console.log('🧹 resetcommans: clearing guild commands for', guildIdForReset);
            await rest.put(
                Routes.applicationGuildCommands(config.clientId, guildIdForReset),
                { body: [] }
            );

            console.log('🔄 resetcommans: re-registering global commands');
            await rest.put(
                Routes.applicationCommands(config.clientId),
                { body: commands }
            );

            await interaction.editReply('✅ Commands reset: cleared guild commands and re-registered global commands.');
        } catch (err) {
            console.error('resetcommans failed:', err.message || err);
            await interaction.editReply('❌ Failed to reset commands. Check bot logs for details.');
        }

        return;
    }

    if (commandName === 'play') {
        const query = interaction.options.getString('query');
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            return interaction.reply({ content: '❌ You must be in a voice channel!', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const songInfo = await getSongInfo(query);
        if (!songInfo) {
            return interaction.editReply('❌ Could not find that song!');
        }

        let queue = queues.get(guildId);
        if (!queue) {
            queue = new MusicQueue(guildId);
            queues.set(guildId, queue);
        }

        // Apply user preferences to this queue instance
        const prefs = getUserPreferences(interaction.user.id);
        if (prefs) {
            if (typeof prefs.volume === 'number') {
                queue.setVolume(prefs.volume);
            }
            if (typeof prefs.loop === 'boolean') {
                queue.loop = prefs.loop;
            }
        }

        if (!queue.connection) {
            queue.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator
            });
            queue.attachConnectionListeners();
        }

        if (Array.isArray(songInfo)) {
            await queue.addMultipleSongs(songInfo);
            // Shuffle upcoming songs for this user if they prefer it
            if (prefs && prefs.shuffle && queue.songs.length > 1) {
                queue.shuffle();
            }
            return interaction.editReply(`✅ Added **${songInfo.length}** songs to queue!`);
        } else {
            await queue.addSong(songInfo);
            if (prefs && prefs.shuffle && queue.songs.length > 1) {
                queue.shuffle();
            }
            return interaction.editReply(`✅ Added to queue: **${songInfo.title}**`);
        }
    }

    if (commandName === 'radio') {
        const genres = Object.keys(RADIO_CONFIG);
        const options = genres.map(genre => ({
            label: genre.charAt(0).toUpperCase() + genre.slice(1),
            value: genre
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('radio_genre')
            .setPlaceholder('Choose a genre')
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.reply({
            content: '📻 **Select a radio genre:**',
            components: [row],
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (commandName === 'skip') {
        const queue = queues.get(guildId);
        if (!queue || !queue.isPlaying) {
            return interaction.reply({ content: '❌ Nothing is playing!', flags: MessageFlags.Ephemeral });
        }
        queue.skip();
        await interaction.reply('⏭️ Skipped!');
    }

    if (commandName === 'stop') {
        const queue = queues.get(guildId);
        if (!queue) {
            return interaction.reply({ content: '❌ Nothing is playing!', flags: MessageFlags.Ephemeral });
        }
        queue.stop();
        if (queue.connection) {
            queue.connection.destroy();
            queue.connection = null;
        }
        queues.delete(guildId);
        await interaction.reply('⏹️ Stopped and cleared queue!');
    }

    if (commandName === 'pause') {
        const queue = queues.get(guildId);
        if (!queue || !queue.isPlaying) {
            return interaction.reply({ content: '❌ Nothing is playing!', flags: MessageFlags.Ephemeral });
        }
        queue.pause();
        await interaction.reply('⏸️ Paused!');
    }

    if (commandName === 'resume') {
        const queue = queues.get(guildId);
        if (!queue) {
            return interaction.reply({ content: '❌ Nothing is playing!', flags: MessageFlags.Ephemeral });
        }
        queue.resume();
        await interaction.reply('▶️ Resumed!');
    }

    if (commandName === 'queue') {
        const queue = queues.get(guildId);
        if (!queue || queue.songs.length === 0) {
            return interaction.reply({ content: '📭 Queue is empty!', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor('#1DB954')
            .setTitle('📋 Current Queue')
            .setDescription(
                queue.songs
                    .slice(0, 10)
                    .map((song, i) => `${i + 1}. ${song.title}`)
                    .join('\n')
            );

        if (queue.songs.length > 10) {
            embed.setFooter({ text: `...and ${queue.songs.length - 10} more` });
        }

        await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'nowplaying') {
        const queue = queues.get(guildId);
        if (!queue || !queue.currentSong) {
            return interaction.reply({ content: '❌ Nothing is playing!', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor('#1DB954')
            .setTitle('🎵 Now Playing')
            .setDescription(`**${queue.currentSong.title}**`)
            .addFields(
                { name: 'Type', value: queue.currentSong.type === 'radio' ? '📻 Radio' : '🎵 YouTube', inline: true },
                { name: 'Loop', value: queue.loop ? '✅ On' : '❌ Off', inline: true }
            );

        await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'loop') {
        const queue = queues.get(guildId);
        if (!queue) {
            return interaction.reply({ content: '❌ Nothing is playing!', flags: MessageFlags.Ephemeral });
        }
        queue.loop = !queue.loop;
        const prefs = getUserPreferences(interaction.user.id);
        prefs.loop = queue.loop;
        saveUserPreferences();
        await interaction.reply(`🔁 Loop: **${queue.loop ? 'ON' : 'OFF'}** (Preference saved)`);
    }

    if (commandName === 'shuffle') {
        const queue = queues.get(guildId);
        if (!queue || queue.songs.length === 0) {
            return interaction.reply({ content: '❌ Queue is empty!', flags: MessageFlags.Ephemeral });
        }
        queue.shuffle();
        // Persist user preference that they prefer shuffled playback
        const prefs = getUserPreferences(interaction.user.id);
        prefs.shuffle = true;
        saveUserPreferences();
        await interaction.reply('🔀 Queue shuffled! (Preference saved)');
    }

    if (commandName === 'volume') {
        const level = interaction.options.getInteger('level');
        const queue = queues.get(guildId);
        if (!queue) {
            return interaction.reply({ content: '❌ Nothing is playing!', flags: MessageFlags.Ephemeral });
        }
        queue.setVolume(level / 100);
        const prefs = getUserPreferences(interaction.user.id);
        prefs.volume = level / 100;
        prefs.volumePercent = level;
        saveUserPreferences();
        await interaction.reply(`🔊 Volume set to **${level}%** (Preference saved)`);
    }

    if (commandName === 'playfavorite') {
        const prefs = getUserPreferences(interaction.user.id);
        const hasPlaylists = Array.isArray(prefs.favoritePlaylists) && prefs.favoritePlaylists.length > 0;
        const hasRadios = Array.isArray(prefs.favoriteRadios) && prefs.favoriteRadios.length > 0;

        if (!hasPlaylists && !hasRadios) {
            return interaction.reply({
                content: '❌ You have no favorites saved yet. Use /prefrence to add favorite playlists or radio stations.',
                flags: MessageFlags.Ephemeral
            });
        }

        const options = [];
        if (hasPlaylists) {
            options.push({ label: 'Playlists', value: 'playlist' });
        }
        if (hasRadios) {
            options.push({ label: 'Radio Stations', value: 'radio' });
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('favorite_type')
            .setPlaceholder('Choose what type of favorite to play')
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.reply({
            content: '⭐ **Choose a favorite type to play:**',
            components: [row],
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (commandName === 'preference' || commandName === 'prefrence') {
        const userId = interaction.user.id;
        const shuffle = interaction.options.getBoolean('shuffle');
        const loop = interaction.options.getBoolean('loop');
        const volume = interaction.options.getInteger('volume');
        const favorite = interaction.options.getString('favorite');

        const prefs = getUserPreferences(userId);
        let changed = false;

        // Handle favorites: playlist URLs or "radio" keyword
        if (favorite) {
            const favLower = favorite.toLowerCase();

            if (favLower === 'radio') {
                const queue = queues.get(guildId);
                if (!queue || !queue.currentSong || queue.currentSong.type !== 'radio') {
                    await interaction.reply({ content: '❌ No radio station is currently playing to save as a favorite.', flags: MessageFlags.Ephemeral });
                    return;
                }

                if (!Array.isArray(prefs.favoriteRadios)) {
                    prefs.favoriteRadios = [];
                }

                const existing = prefs.favoriteRadios.some(r => r && r.url === queue.currentSong.url);
                if (!existing) {
                    prefs.favoriteRadios.push({
                        name: queue.currentSong.title || 'Radio Station',
                        url: queue.currentSong.url
                    });
                    // Cap stored favorites to avoid unbounded growth
                    if (prefs.favoriteRadios.length > 20) {
                        prefs.favoriteRadios.shift();
                    }
                }
                changed = true;
            } else {
                if (!Array.isArray(prefs.favoritePlaylists)) {
                    prefs.favoritePlaylists = [];
                }

                const existing = prefs.favoritePlaylists.some(p =>
                    (typeof p === 'string' ? p === favorite : p && p.url === favorite)
                );

                if (!existing) {
                    let playlistName = null;
                    try {
                        playlistName = await resolvePlaylistNameFromUrl(favorite);
                    } catch (err) {
                        console.error('Error resolving favorite playlist name:', err.message || err);
                    }

                    prefs.favoritePlaylists.push({
                    name: playlistName || 'Playlist',
                        url: favorite
                    });

                    if (prefs.favoritePlaylists.length > 20) {
                        prefs.favoritePlaylists.shift();
                    }
                }
                changed = true;
            }
        }

        if (shuffle !== null) {
            prefs.shuffle = shuffle;
            changed = true;
        }
        if (loop !== null) {
            prefs.loop = loop;
            changed = true;
        }
        if (volume !== null) {
            const clampedVol = Math.max(0, Math.min(200, volume));
            prefs.volume = clampedVol / 100;
            prefs.volumePercent = clampedVol;
            changed = true;
        }

        if (changed) {
            saveUserPreferences();
        }

        const effectiveShuffle = typeof prefs.shuffle === 'boolean' ? (prefs.shuffle ? 'ON' : 'OFF') : 'Not set';
        const effectiveLoop = typeof prefs.loop === 'boolean' ? (prefs.loop ? 'ON' : 'OFF') : 'Not set';
        const effectiveVolume = typeof prefs.volumePercent === 'number' ? `${prefs.volumePercent}%` : 'Not set';

        let favoritePlaylistsText = 'None';
        if (Array.isArray(prefs.favoritePlaylists) && prefs.favoritePlaylists.length > 0) {
            const sample = prefs.favoritePlaylists
                .slice(0, 3)
                .map(p => (typeof p === 'string' ? p : (p.name || p.url || 'Playlist')))
                .join('\n');
            if (prefs.favoritePlaylists.length > 3) {
                favoritePlaylistsText = `${sample}\n...and ${prefs.favoritePlaylists.length - 3} more`;
            } else {
                favoritePlaylistsText = sample;
            }
        }

        let favoriteRadiosText = 'None';
        if (Array.isArray(prefs.favoriteRadios) && prefs.favoriteRadios.length > 0) {
            const names = prefs.favoriteRadios
                .slice(0, 3)
                .map(r => r && r.name ? r.name : 'Radio Station')
                .join('\n');
            if (prefs.favoriteRadios.length > 3) {
                favoriteRadiosText = `${names}\n...and ${prefs.favoriteRadios.length - 3} more`;
            } else {
                favoriteRadiosText = names;
            }
        }

        const embed = new EmbedBuilder()
            .setColor('#1DB954')
            .setTitle('⚙️ Your Playback Preferences')
            .addFields(
                { name: 'Shuffle', value: effectiveShuffle, inline: true },
                { name: 'Loop', value: effectiveLoop, inline: true },
                { name: 'Volume', value: effectiveVolume, inline: true },
                { name: 'Favorite Playlists', value: favoritePlaylistsText, inline: false },
                { name: 'Favorite Radio Stations', value: favoriteRadiosText, inline: false }
            );

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
});

client.login(config.token);
