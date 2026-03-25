#!/bin/bash

# DevContainer Setup Script for Flip-Phone-YouTube

echo "🚀 Setting up development environment..."

# Update package lists
echo "📦 Updating package lists..."
sudo apt-get update

# Install FFmpeg (required for video processing)
echo "🎬 Installing FFmpeg..."
sudo apt-get install -y ffmpeg

# Install xdg-utils for folder opening functionality
echo "📂 Installing xdg-utils..."
sudo apt-get install -y xdg-utils

# Install Python dependencies
echo "🐍 Installing Python dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

# Download Cloudflared (optional, for tunnel functionality)
echo "☁️ Downloading Cloudflared (optional)..."
if ! command -v cloudflared &> /dev/null; then
    wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
    sudo mv cloudflared-linux-amd64 /usr/local/bin/cloudflared
    sudo chmod +x /usr/local/bin/cloudflared
    # Also create a symlink in the project directory
    ln -s /usr/local/bin/cloudflared ./cloudflared
fi

# Create required directories
echo "📁 Creating required directories..."
mkdir -p downloads templates

# Create a sample .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating sample .env file..."
    cat > .env << 'EOL'
# Primary Email Routing
SENDER_EMAIL=your_primary_sender@gmail.com
DEFAULT_RECEIVER=your_destination_email@gmail.com

# Integrations (Optional)
DEFAULT_BOT_ID=your_groupme_bot_id
GAS_CALLBACK_URL=https://script.google.com/macros/s/YOUR_GAS_ID/exec
YOUTUBE_API_KEY=your_google_youtube_api_key

# SMTP Configuration
SMTP_PASSWORD=your_app_password
# Multiple Accounts (Load Balanced) - Comma separated username:password pairs
# SMTP_ACCOUNTS=sender1@gmail.com:app_pass1,sender2@gmail.com:app_pass2

# Advanced Logic (Optional)
# PURGE_TRIGGERS=sensitive_account@domain.com,another_account@domain.com
EOL
    echo "⚠️  Please update the .env file with your actual credentials!"
fi

echo "✅ Development environment setup complete!"
echo ""
echo "To run the application:"
echo "  python ytdlp-linux.py"
echo ""
echo "The server will be available at http://localhost:8005"
