# Midnight-Disk-Jocky

Midnight-Disk-Jocky is a self-hosted Discord music bot that plays:

- YouTube audio (via `yt-dlp` + `ffmpeg`)
- Spotify tracks and playlists (resolved to YouTube)
- Internet radio streams (via the Radio Browser API)
- User-specific favorites and playback preferences

Built on `discord.js` v14 and `@discordjs/voice`.

---

## Features

- Slash commands for all actions (`/play`, `/radio`, `/queue`, etc.)
- Spotify track & playlist URL support (resolved to YouTube)
- Large playlist support (2,000+ tracks) with **fast queuing**
  - YouTube resolution is done lazily at playback time
- Radio browsing by genre / subgroup / language using Radio Browser
- Per-user defaults stored locally:
  - volume, loop, shuffle
  - favorite playlists and radio stations
- Auto idle detection and disconnect when the voice channel is empty
- Owner-only `/resetcommans` command to clear & re-register slash commands

---

## Requirements

- Node.js 18+ (recommended)
- A Discord bot application and bot token
- `ffmpeg` in `PATH`
- `yt-dlp` installed (or configured via `config.json`)
- Spotify API credentials (for Spotify URL support)
- Outbound HTTPS access to:
  - Discord API
  - `https://de1.api.radio-browser.info` (Radio Browser)
  - Spotify API

---

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/lostlight-commits/Midnight-Disk-Jocky.git
cd Midnight-Disk-Jocky

npm install
```

If you build your own `package.json`, be sure to include at least:

- `discord.js`
- `@discordjs/voice`
- `spotify-web-api-node`

---

## Configuration

Configuration lives in `config.json` in the project root:

```json
{
  "token": "",
  "guild_id": "",
  "clientId": "",
  "owner_id": "",
  "spotify_client_id": "",
  "spotify_client_secret": "",
  "spotify_refresh_token": "",
  "ytdlp_path": "/usr/local/bin/yt-dlp",
  "ytdlp_cookies": ""
}
```

### Fields

- `token` – Your Discord bot token.
- `guild_id` – Optional guild ID (useful if you later switch to guild-only commands).
- `clientId` – Discord application (client) ID for the bot.
- `owner_id` – Discord user ID of the bot owner. Used for owner-only commands like `/resetcommans`.
- `spotify_client_id`, `spotify_client_secret` – Spotify app credentials for client-credentials flow.
- `spotify_refresh_token` – Reserved for future user-auth flows (not used in current code).
- `ytdlp_path` – Absolute path to the `yt-dlp` binary.
- `ytdlp_cookies` – Optional path to a cookies file to pass to `yt-dlp`.

> **Important:** Do **not** commit your real `token` or Spotify secrets. Keep these empty in the repository and fill them only on the host where the bot runs, or migrate to environment variables and load them in `bot.js`.

---

## Running the Bot

Start the bot with Node:

```bash
node bot.js
```

On startup you should see logs similar to:

- `🎵 Discord Music Bot starting...`
- `🔄 Registering slash commands...`
- `✅ Slash commands registered`
- `✅ Bot online as <bot#1234>`
- `📻 Radio genres available: 8`

Invite the bot to your server with scopes:

- `bot` (with `Connect` and `Speak` permissions)
- `applications.commands`

---

## Slash Commands

### Playback

- `/play query:<text or URL>`  
  Play a YouTube URL, a search query, or a Spotify track/playlist URL.
  - YouTube playlist URLs are enumerated via `yt-dlp`.
  - Spotify playlists are converted to a list of deferred tracks; each track resolves to YouTube only when it's about to be played.

- `/radio`  
  Interactive radio browser:
  - Choose a genre
  - Choose a subgroup
  - Choose a language
  - Pick a station from a paginated station list

- `/skip` – Skip the current track.
- `/stop` – Stop playback, clear the queue, and leave the voice channel.
- `/pause` / `/resume` – Pause or resume playback.
- `/queue` – Show up to the first 10 items in the current queue.
- `/nowplaying` – Show information about the currently playing item.

### Playback Options

- `/loop` – Toggle loop mode for the queue; also saved as part of your preferences.
- `/shuffle` – Shuffle the queue and save `shuffle = true` as your personal default.
- `/volume level:<0-200>` – Set volume (0–200%) for the queue and store it as your default.

### Preferences & Favorites

- `/prefrence`  
  (Name matches the bot code; intentionally spelled this way.)

  Without options, shows your preferences and favorites. With options:

  - `shuffle:<bool>` – default shuffle behavior.
  - `loop:<bool>` – default loop behavior.
  - `volume:<int 0-200>` – default volume percent.
  - `favorite:<string>`:
    - Playlist URL → add to your favorite playlists.
    - `radio` (while a radio station is playing) → save the current station as a favorite.

  Per-user data is stored in `user_prefs.json` alongside `bot.js`.

- `/playfavorite` – Interactively choose and play from:
  - Your favorite playlists
  - Your favorite radio stations

### Owner Utilities

- `/resetcommans`  
  Owner-only slash command to clean up and re-register commands.

  In `bot.js` it:

  - Verifies `interaction.user.id === OWNER_ID` (from `config.owner_id`).
  - Clears all guild commands for the current guild:
    - `Routes.applicationGuildCommands(config.clientId, guildId)` with an empty body.
  - Re-registers the global commands from the `commands` array.

Use this if Discord shows old or duplicate commands for the bot.

---

## Spotify & Large Playlists

- Spotify URLs (`open.spotify.com/track/...`, `open.spotify.com/playlist/...`, `spotify:track:...`, `spotify:playlist:...`) are detected in `getSongInfo`.

- For playlists, `resolveSpotifyPlaylist`:
  - Fetches up to 2,000 tracks from Spotify.
  - Builds lightweight queue entries with `title` and `deferredQuery`.
  - Does **not** call `yt-dlp` at queue time.

- During playback, `MusicQueue.playNext`:
  - If `currentSong.url` is missing but `deferredQuery` is set, calls `searchYouTube` (via `yt-dlp`) to find the matching YouTube video.
  - Populates `currentSong.url` (and optionally `title`), then streams it.
  - If it cannot resolve, the track is skipped and the next one is tried.

This design keeps `/play <spotify-playlist-url>` responsive even for very large playlists.

---

## Radio Support

Radio is powered by the public Radio Browser API:

- Base URL: `https://de1.api.radio-browser.info/json`
- Stations are fetched by tag + language and sorted by votes.
- `buildStationComponents` creates Discord select menus and pagination buttons.
- `getUniqueStations` deduplicates by URL and caps the list to avoid overly long menus.

The `/radio` command walks you through genre → subgroup → language → station.

---

## Troubleshooting

- Make sure `yt-dlp` path in `config.json` is correct and executable by the bot process.
- Ensure `ffmpeg` is installed and accessible in `PATH`.
- If Spotify URLs fail, check your `spotify_client_id` / `spotify_client_secret` values.
- If slash commands look duplicated or stale:
  - Run `/resetcommans` as the owner (`owner_id`).
  - Hard-reload Discord (Ctrl+R / Cmd+R).

---

## License

This project is licensed under the MIT License.

