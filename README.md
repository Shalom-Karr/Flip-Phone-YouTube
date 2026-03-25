# Infinity V64 (YouTube DL & Routing Bot)

This is an automated YouTube downloading, processing, and distribution service. It provides a robust, resilient system for batch-downloading videos or audio, splitting/compressing large files, and distributing them via SMTP or to specific GroupMe channels, all coordinated through Google Apps Script integrations.

## Features
- **Concurrent Downloading:** Leverages `yt-dlp` to pull high-quality videos and audio streams with resilient retry mechanisms.
- **Automated Processing:** Splits large video files into chunked segments (for email attachments) and heavily compresses them using `ffmpeg`.
- **Intelligent Routing:** Queues processed files and handles robust SMTP distribution across multiple, load-balanced accounts to bypass rate limits. 
- **Cloudflared Integration:** Automatically establishes a secure Cloudflare tunnel to expose the web interface and API endpoints.
- **Web UI:** A dynamic, responsive dashboard for queue management, video trimming, and system monitoring.
- **Self-Healing:** Includes watchdog threads to recover stuck downloads and clear corrupted partial files.

## Prerequisites
- **Python 3.8+**
- **FFmpeg:** Must be installed and accessible in the system's PATH.
- **Cloudflared:** Expected to be located in the project's root directory (`cloudflared.exe`) to automatically establish external tunnels.

## External Tools Setup

### 1. Installing FFmpeg
FFmpeg is required for video compression and splitting.

- **Windows (Recommended):**
  Open PowerShell as Administrator and run:
  ```powershell
  winget install ffmpeg
  ```
  Alternatively, download the "Essentials" build from [ffmpeg.org](https://ffmpeg.org/download.html), extract it, and add the `bin` folder to your System PATH.
- **Linux (Ubuntu/Debian):**
  ```bash
  sudo apt update && sudo apt install ffmpeg
  ```

### 2. Setting up Cloudflared
The script automatically manages a Cloudflare Tunnel to provide an external URL without port forwarding.

1. Download the `cloudflared` executable for your platform from the [Cloudflare Downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. **Windows:** Rename the downloaded file (e.g., `cloudflared-windows-amd64.exe`) to **`cloudflared.exe`**.
3. Move the file into the `ytdlp_new` root folder.

## Setup Instructions

1. **Clone the repository:**
   ```bash
   git clone <your-repository-url>
   cd ytdlp_new
   ```

2. **Install Python Dependencies:**
   The application will attempt to auto-install these on launch, but you can manually install them via:
   ```bash
   pip install -r requirements.txt
   ```

3. **Environment Configuration:**
   Create a `.env` file in the root directory (use the provided `.env.example` as a template or see the configuration below).

4. **Run the Application:**
   ```bash
   python ytdlp.py
   ```

## Configuration (`.env`)

You MUST provide a `.env` file with the following keys for the application to function correctly:

```ini
# Primary Email Routing
SENDER_EMAIL=your_primary_sender@gmail.com
DEFAULT_RECEIVER=your_destination_email@gmail.com

# Integrations
DEFAULT_BOT_ID=your_groupme_bot_id
GAS_CALLBACK_URL=https://script.google.com/macros/s/YOUR_GAS_ID/exec
YOUTUBE_API_KEY=your_google_youtube_api_key

# SMTP Configuration
# Single Account Fallback:
SMTP_PASSWORD=your_app_password
# Multiple Accounts (Load Balanced) - Comma separated username:password pairs
SMTP_ACCOUNTS=sender1@gmail.com:app_pass1,sender2@gmail.com:app_pass2

# Advanced Logic
# Comma separated list of emails. If the sender or recipient matches these,
# the sent email will be instantly purged from the Gmail "Sent" folder.
PURGE_TRIGGERS=sensitive_account@domain.com,another_account@domain.com
```

## Folder Structure
- `/downloads/` - Auto-generated. Stores active and completed video/audio files.
- `/templates/` - Contains the `index.html` file for the Flask-served Web UI.
- `ytdlp.py` - The main application daemon.
- `state.json` - Auto-generated. Maintains the persistent queue and job history across restarts.
- `activity.log` - Auto-generated. Detailed system logs.

## Google Apps Script (GAS) Setup

The `GAS/` folder contains the middleware that connects GroupMe to your Python server. This setup allows users to interact with the bot through GroupMe messages.

### Files in GAS Folder
- **Code.Gs** - Main GroupMe webhook handler and bot logic
- **Admin.Gs** - Backend API for admin dashboard
- **AdminPanel.html** - Web-based admin interface

### Setting up Google Apps Script

1. **Create a new Google Apps Script project:**
   - Go to [script.google.com](https://script.google.com)
   - Click "New Project"
   - Name it (e.g., "YouTube Bot")

2. **Copy the GAS files:**
   - Create three files in your project: `Code.gs`, `Admin.gs`, and `AdminPanel.html`
   - Copy the contents from the `GAS/` folder files to the corresponding project files

3. **Enable YouTube Data API:**
   - In the Apps Script editor, click on "Services" (+ icon in left sidebar)
   - Find and add "YouTube Data API v3"

4. **Configure Script Properties:**
   - Go to Project Settings (gear icon)
   - Click "Script Properties" → "Add script property"
   - Add the following properties:

   | Property | Description | Example |
   |----------|-------------|---------|
   | `CFG_PAGEKITE_URL` | Your Python server's public URL (from Cloudflare tunnel) | `https://your-tunnel.trycloudflare.com` |
   | `CFG_GOOGLE_API_KEY` | YouTube Data API key | `AIzaSy...` |
   | `CFG_GOOGLE_CX_ID` | Google Custom Search Engine ID | `c8f9a...` |
   | `CFG_DAILY_LIMIT` | Daily download limit per user | `20` |
   | `CFG_MAX_RESULTS` | Max search results to return | `10` |
   | `CFG_OWNER_ID` | Your GroupMe user ID (owner) | `12345678` |
   | `CFG_DEFAULT_BOT_ID` | Fallback GroupMe bot ID | `your_bot_id` |
   | `CFG_DEFAULT_EMAIL` | Default email recipient | `your_email@gmail.com` |

5. **Deploy as Web App:**
   - Click "Deploy" → "New deployment"
   - Select type: "Web app"
   - Set "Execute as": "Me"
   - Set "Who has access": "Anyone"
   - Click "Deploy"
   - Copy the deployment URL

6. **Update your `.env` file:**
   - Add the deployment URL to your `.env` file:
     ```ini
     GAS_CALLBACK_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
     ```

### Setting up GroupMe Bot

1. **Create a GroupMe Bot:**
   - Go to [dev.groupme.com](https://dev.groupme.com)
   - Log in with your GroupMe account
   - Go to "Bots" → "Create Bot"
   - Select the group where you want the bot
   - Name your bot
   - Set the callback URL to your Google Apps Script deployment URL
   - Click "Submit"

2. **Configure the Bot in GAS:**
   - Copy the Bot ID from GroupMe
   - In your Google Apps Script project, you can add the group mapping using the admin command `add group [group_id] [bot_id]` or set it as `CFG_DEFAULT_BOT_ID`

3. **Get your GroupMe User ID:**
   - Send a message in the group
   - Check the Google Apps Script execution logs to find your user ID
   - Update the `CFG_OWNER_ID` property with your user ID

### Admin Dashboard

Once deployed, you can access the admin dashboard by opening the deployment URL in your browser. The dashboard provides:
- User management
- Group management
- Download history
- System logs
- Ban management
- Quota management
- System configuration

## Available Commands

The bot supports a wide range of commands through GroupMe. Commands are case-insensitive and can be sent directly in the group chat.

### Search & Discovery

- `search [query]` - Search YouTube videos
- `search channel [name]` - Search for YouTube channels
- `search tiktok [query]` - Search TikTok content
- `search insta [query]` - Search Instagram content
- `short [query]` - Search videos under 7 minutes
- `long [query]` - Search videos over 15 minutes
- `trending [country]` - Get trending videos (default: US)
- `surprise` - Random search with AI-generated query
- `lucky [query]` - Download first result immediately
- `id [video_id]` - Download by YouTube video ID
- `next` - View next page of search results

### Download & Selection

- `1`, `2`, `3`, etc. - Select a result by number
- `2-5` - Select a range of results
- `all` - Download all results from search
- `[quality] [query]` - Prefix search with quality preference
  - Examples: `720p cats`, `1080p music videos`, `480p tutorials`
  - Available qualities: `360p`, `480p`, `720p`, `1080p`
- `mp3 [query]` or `audio [query]` - Download audio only
- `[query] 0:30-1:45` - Download with time trim (format: MM:SS or HH:MM:SS)
- Direct URL - Paste any YouTube or supported platform URL

### User Settings & Profile

- `help` - Show command list and usage instructions
- `me` or `profile` - View your profile, quota, and download statistics
- `set default [quality]` - Set your personal default quality preference
  - Example: `set default 720p`
- `favs` - List your saved favorite videos
- `save [number]` - Save a search result to your favorites
  - Example: `save 3`
- `del fav [number]` - Delete a favorite from your list

### Channel Subscriptions

- `sub [number]` - Subscribe to a channel from search results
- `sub [url]` - Subscribe to a channel by URL (admin only)
- `unsub [channel_id]` - Unsubscribe from a channel (admin only)
- `subs` - List all active subscriptions (admin only)
- `check subs` - Manually check for new videos from subscriptions (admin only)

### Admin Commands

#### User Management
- `users` or `list users` - List all registered users
- `add user [id] [email] [name] [role]` - Register a new user
  - Roles: `admin`, `user`, `guest`
  - Example: `add user 12345 user@email.com John admin`
- `del user [id]` - Delete a user
- `set role [id] [role]` - Change a user's role

#### Group Management
- `groups` or `list groups` - List all GroupMe group mappings
- `add group [group_id] [bot_id]` - Map a GroupMe group to a bot
- `del group [group_id]` - Remove a group mapping

#### Quota Management
- `check quota [id]` - View a user's remaining quota
- `reset quota [id]` - Reset a user's quota to 0 (used downloads)
- `set quota [id] [amount]` - Set a specific quota for a user

#### Ban Management
- `ban [id] [time]` - Ban a user temporarily or permanently
  - Time formats: `5m` (minutes), `2h` (hours), `3d` (days), `permanent`
  - Example: `ban 12345 24h`
- `unban [id]` - Remove a ban from a user

#### System Management
- `status` or `sys info` - Check server health and statistics
- `logs` - View Google Sheets activity logs
- `remote logs` - View Python server console output
- `history` - View recent download history
- `files` - List files on the server
- `delete file [name]` - Delete a specific file from the server
- `lock quality [quality]` - Force maximum quality globally
  - Example: `lock quality 480p`
- `unlock quality` - Remove quality lock
- `maint on` / `maint off` - Enable/disable maintenance mode
- `flush` - Force send queued emails
- `clean` - Clear download queue
- `announce [message]` - Broadcast a message to all groups
- `reports` - View user-submitted reports
- `clear reports` - Delete all reports
- `check tunnel` - Verify Cloudflare tunnel URL
- `update server` - Trigger Python server update

### Owner Commands

These commands are only available to the configured owner (CFG_OWNER_ID):
- All admin commands
- `owner help` - View owner-specific command list
- Direct system configuration changes
- Critical system operations

### Command Help System

The bot includes context-sensitive help:
- `help` - General help and basic commands
- `admin help` - Admin command reference
- `owner help` - Owner command reference
- `help [command]` - Get help for specific commands
  - Examples: `help search`, `help sub`, `help ban`, `help lock`

## User Roles & Permissions

### Guest (Default)
- Can search and view results
- Cannot download videos
- Automatically assigned to new users

### User
- All guest permissions
- Can download videos (subject to quota)
- Can save favorites
- Can set personal preferences

### Admin
- All user permissions
- Can manage other users
- Can view system logs and history
- Can manage subscriptions
- Can configure system settings
- No download quota restrictions

### Owner
- All admin permissions
- Can promote/demote admins
- Can modify critical system configuration
- Full system access

## API & Endpoints

The Flask application serves a web interface at `http://localhost:8005`. It also exposes several API endpoints for remote management, triggering downloads, checking queue status, and pulling the active Cloudflare Tunnel URL.

### Key API Endpoints
- `/get_link` - Trigger a download request
- `/api/status` - Get server health and metrics
- `/api/search` - Perform YouTube searches
- `/api/subscribe` - Subscribe to a channel
- `/api/files` - List downloaded files
- `/api/trim` - Trim video files
- `/force_send` - Flush the email queue
- `/api/get_tunnel` - Get current Cloudflare tunnel URL
- `/api/update` - Trigger server update
