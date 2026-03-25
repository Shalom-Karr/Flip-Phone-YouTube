# Linux-Specific Implementation (ytdlp-linux.py)

This file is a Linux-compatible version of `ytdlp.py` with the following platform-specific modifications:

## Key Differences from Windows Version

### 1. Cloudflared Binary
- **Windows**: Uses `cloudflared.exe`
- **Linux**: Uses `cloudflared` (no .exe extension)
- Location: Line 854 in `start_cloudflared_tunnel()`

### 2. File Manager Integration
- **Windows**: Uses `os.startfile()` to open folders
- **Linux**: Uses `xdg-open` via subprocess
- Location: Line 472-476 in `action_open_folder()`

### 3. User Agent String
- Updated to use Linux-specific user agent string for yt-dlp
- Location: Line 552 in `background_worker()`

### 4. Startup Message
- Modified to indicate Linux version: "V64 - SMART ROUTING - LINUX"
- Location: Line 93

## Setup Instructions

### Option 1: Using DevContainer (Recommended)

1. Open this repository in VS Code
2. Install the "Remote - Containers" extension
3. Click "Reopen in Container" when prompted
4. The devcontainer will automatically:
   - Install Python dependencies
   - Install FFmpeg
   - Download and configure cloudflared
   - Set up the development environment

### Option 2: Manual Setup

1. **Install System Dependencies**:
   ```bash
   sudo apt-get update
   sudo apt-get install -y ffmpeg xdg-utils
   ```

2. **Install Python Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Download Cloudflared** (Optional):
   ```bash
   wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
   mv cloudflared-linux-amd64 cloudflared
   chmod +x cloudflared
   ```

4. **Configure Environment**:
   - Copy `.env.example` to `.env` (or create from scratch)
   - Update with your credentials

5. **Run the Application**:
   ```bash
   python ytdlp-linux.py
   ```

## DevContainer Configuration

The `.devcontainer` directory includes:

- **devcontainer.json**: VS Code DevContainer configuration
  - Python 3.11 base image
  - Pre-configured extensions (Python, Pylance, Black formatter)
  - Port forwarding for Flask server (8005)
  - Automatic setup on container creation

- **setup.sh**: Automated setup script
  - Installs system dependencies (FFmpeg, xdg-utils)
  - Installs Python packages
  - Downloads cloudflared
  - Creates sample .env file

## Port Configuration

The Flask server runs on port 8005 and is automatically forwarded in the devcontainer environment.

## Testing the Linux Version

After setup, you can test the application by:

1. Starting the server: `python ytdlp-linux.py`
2. Opening a browser to `http://localhost:8005`
3. The web interface should load successfully

## Notes

- All file paths use forward slashes (already cross-platform compatible)
- The subprocess calls use lists instead of strings (cross-platform compatible)
- No Windows-specific modules (like `winreg`) are used
- SMTP and email functionality work identically on both platforms
