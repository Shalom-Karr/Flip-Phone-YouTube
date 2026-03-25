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

## API & Endpoints
The Flask application serves a web interface at `http://localhost:8005`. It also exposes several API endpoints for remote management, triggering downloads, checking queue status, and pulling the active Cloudflare Tunnel URL.
