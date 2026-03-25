# Quick Reference: Windows vs Linux Differences

This document provides a quick reference for the differences between `ytdlp.py` (Windows) and `ytdlp-linux.py` (Linux).

## Modified Code Sections

### 1. Cloudflared Binary Path (Line ~854)

**Windows (`ytdlp.py`):**
```python
cf_path = os.path.join(BASE_DIR, "cloudflared.exe")
```

**Linux (`ytdlp-linux.py`):**
```python
# Linux-specific: Use 'cloudflared' instead of 'cloudflared.exe'
cf_path = os.path.join(BASE_DIR, "cloudflared")
```

### 2. Open Folder Function (Line ~471-475)

**Windows (`ytdlp.py`):**
```python
@app.route('/actions/open_folder', methods=['POST'])
def action_open_folder():
    try: os.startfile(DOWNLOAD_FOLDER)
    except: pass
    return jsonify({"status": "opened"})
```

**Linux (`ytdlp-linux.py`):**
```python
@app.route('/actions/open_folder', methods=['POST'])
def action_open_folder():
    # Linux-specific: Use xdg-open to open file manager
    try:
        subprocess.Popen(['xdg-open', DOWNLOAD_FOLDER])
    except:
        pass
    return jsonify({"status": "opened"})
```

### 3. User Agent String (Line ~551)

**Windows (`ytdlp.py`):**
```python
'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
```

**Linux (`ytdlp-linux.py`):**
```python
'user_agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
```

### 4. Startup Messages (Lines 93, 920)

**Windows (`ytdlp.py`):**
```python
logging.info("--- SYSTEM STARTUP (V64 - SMART ROUTING) ---")
# ... later ...
logging.info("--- SERVER STARTED (V64) ---")
```

**Linux (`ytdlp-linux.py`):**
```python
logging.info("--- SYSTEM STARTUP (V64 - SMART ROUTING - LINUX) ---")
# ... later ...
logging.info("--- SERVER STARTED (V64 - LINUX) ---")
```

### 5. Escape Sequence Fix (Line 188)

**Both versions now use:**
```python
for num in data[0].split(): mail.store(num, '+FLAGS', r'\Deleted')
```
(Uses raw string `r'\Deleted'` to avoid syntax warning)

## System Requirements

### Windows
- Windows 10 or later
- Python 3.8+
- FFmpeg (via winget or manual install)
- cloudflared.exe

### Linux
- Ubuntu 20.04+ (or equivalent)
- Python 3.8+
- FFmpeg (via apt)
- xdg-utils (for folder opening)
- cloudflared (Linux binary)

## Installation Commands

### Windows
```powershell
# Install FFmpeg
winget install ffmpeg

# Download cloudflared
# Manual download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
# Rename to cloudflared.exe

# Install Python dependencies
pip install -r requirements.txt
```

### Linux
```bash
# Install FFmpeg
sudo apt-get update
sudo apt-get install -y ffmpeg xdg-utils

# Download cloudflared
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
mv cloudflared-linux-amd64 cloudflared
chmod +x cloudflared

# Install Python dependencies
pip install -r requirements.txt
```

## Running the Application

### Windows
```powershell
python ytdlp.py
```

### Linux
```bash
python ytdlp-linux.py
```

## Identical Features

The following features work identically on both platforms:
- ✅ YouTube video downloading
- ✅ Video processing and compression
- ✅ SMTP email delivery
- ✅ Flask web server
- ✅ Cloudflare tunnel integration
- ✅ Queue management
- ✅ Subscription monitoring
- ✅ Job history tracking
- ✅ All API endpoints
- ✅ Web interface functionality

## Choosing the Right Version

| Use Case | Recommended Version |
|----------|-------------------|
| Running on Windows PC | `ytdlp.py` |
| Running on Linux server | `ytdlp-linux.py` |
| Docker deployment | `ytdlp-linux.py` |
| WSL (Windows Subsystem for Linux) | `ytdlp-linux.py` |
| DevContainer development | `ytdlp-linux.py` |
| Cloud VM (AWS, GCP, Azure) | `ytdlp-linux.py` |

## File Manager Behavior

### Windows
- Clicking "Open Folder" button opens Windows Explorer
- Uses native `os.startfile()` function

### Linux
- Clicking "Open Folder" button opens default file manager
- Uses `xdg-open` command (works with any desktop environment)

## Notes

1. Both versions share the same codebase for core functionality
2. Only 4 platform-specific sections differ between versions
3. The web interface is identical
4. All API endpoints function the same way
5. Configuration via `.env` file is identical
