import os
import threading
import time
import sys
import json
import subprocess
import glob
import urllib.request
import urllib.error
import re
import logging
import shutil
import datetime
import random
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email import encoders
from flask import Flask, request, jsonify, send_from_directory, render_template

from dotenv import load_dotenv
load_dotenv()

# --- AUTO-INSTALL & UPDATE ---
def install_libs():
    libs = ['requests', 'psutil', 'waitress', 'yt-dlp', 'mutagen', 'python-dotenv', 'pytubefix']
    for lib in libs:
        try:
            __import__(lib.replace('-', '_'))
        except ImportError:
            subprocess.check_call([sys.executable, "-m", "pip", "install", lib])
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-U", "yt-dlp"])
    except: pass

install_libs()
import requests
import psutil
import yt_dlp
from waitress import serve

# --- CONFIGURATION ---
app = Flask(__name__)
BASE_DIR = os.getcwd()
DOWNLOAD_FOLDER = os.path.join(BASE_DIR, 'downloads')
LOG_FILE = os.path.join(BASE_DIR, 'activity.log')
STATE_FILE = os.path.join(BASE_DIR, 'state.json')
COOKIES_FILE = os.path.join(BASE_DIR, 'cookies.txt')

GAS_CALLBACK_URL = os.environ.get('GAS_CALLBACK_URL')

JOBS = {}
SEND_QUEUE = []
QUEUE_PAUSED = False
JOB_HISTORY = []
SUBSCRIPTIONS = {}
SETTINGS = {"source_ip": ""}
TOTAL_SUCCESS = 0
CLOUD_STATUS = {"Litterbox": "Online", "SMTP": "Ready"}
YOUTUBE_API_KEY = os.environ.get('YOUTUBE_API_KEY')
DOWNLOAD_SEMAPHORE = threading.Semaphore(4)

# --- LOCKING SYSTEM ---
ACTIVE_LOCKS = set()
lock_mutex = threading.Lock()

def is_locked(filename):
    with lock_mutex: return filename in ACTIVE_LOCKS
def acquire_lock(filename):
    with lock_mutex: ACTIVE_LOCKS.add(filename)
def release_lock(filename):
    with lock_mutex:
        if filename in ACTIVE_LOCKS: ACTIVE_LOCKS.remove(filename)

SENDER_EMAIL = os.environ.get('SENDER_EMAIL')
DEFAULT_RECEIVER = os.environ.get('DEFAULT_RECEIVER')
DEFAULT_BOT_ID = os.environ.get('DEFAULT_BOT_ID')

if not os.path.exists(DOWNLOAD_FOLDER): os.makedirs(DOWNLOAD_FOLDER)

# --- LOGGING ---
class CleanFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        return not ("/api/" in msg or "fragment" in msg or "PO Token" in msg)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S', handlers=[logging.FileHandler(LOG_FILE, encoding='utf-8'), logging.StreamHandler(sys.stdout)])
logging.getLogger("werkzeug").addFilter(CleanFilter())
logging.getLogger("yt_dlp").addFilter(CleanFilter())
logging.getLogger().addFilter(CleanFilter())

logging.info("--- SYSTEM STARTUP (V64 - SMART ROUTING - LINUX) ---")

# --- UTILS ---
def clean_ascii(text):
    if text is None: return "Unknown"
    return str(text).encode('ascii', 'ignore').decode('ascii').strip()

def send_groupme_msg(bot_id, text):
    if not bot_id or bot_id == "default_bot": return
    try: requests.post("https://api.groupme.com/v3/bots/post", json={"bot_id": bot_id, "text": text})
    except: pass

def resolve_channel_name_api(channel_id):
    if not YOUTUBE_API_KEY: return None, None
    try:
        url = f"https://www.googleapis.com/youtube/v3/channels?part=snippet&id={channel_id}&key={YOUTUBE_API_KEY}"
        with urllib.request.urlopen(url) as r:
            data = json.load(r)
            if 'items' in data and len(data['items']) > 0:
                s = data['items'][0]['snippet']
                return s['title'], s['thumbnails']['default']['url']
    except: pass
    return None, None

def send_results_to_google(payload):
    if not GAS_CALLBACK_URL: return
    try:
        # Improved title detection to prevent KeyError
        display_name = "System Update"
        if isinstance(payload, dict):
            display_name = payload.get('title') or payload.get('type') or "System Event"

        logging.info(f"📡 Notifying Google Sheet: {display_name}")

        # Switch to requests for the callback as well
        requests.post(GAS_CALLBACK_URL, json=payload, timeout=10)
    except Exception as e:
        logging.error(f"❌ Google Callback Failed: {e}")

# --- STATE ---
def save_state():
    try:
        global JOB_HISTORY
        if len(JOB_HISTORY) > 200: JOB_HISTORY = JOB_HISTORY[-200:]
        state = {"jobs": JOBS, "queue": SEND_QUEUE, "history": JOB_HISTORY, "total_success": TOTAL_SUCCESS, "subscriptions": SUBSCRIPTIONS, "settings": SETTINGS}
        with open(STATE_FILE + ".tmp", 'w', encoding='utf-8') as f: json.dump(state, f, indent=2)
        if os.path.exists(STATE_FILE): os.remove(STATE_FILE)
        os.rename(STATE_FILE + ".tmp", STATE_FILE)
    except: pass

def load_state():
    global JOBS, SEND_QUEUE, JOB_HISTORY, TOTAL_SUCCESS, SUBSCRIPTIONS, SETTINGS
    if not os.path.exists(STATE_FILE): return
    try:
        with open(STATE_FILE, 'r', encoding='utf-8') as f:
            state = json.load(f)
            JOBS = state.get("jobs", {}); SEND_QUEUE = state.get("queue", []); JOB_HISTORY = state.get("history", []); TOTAL_SUCCESS = state.get("total_success", 0); subs = state.get("subscriptions", {}); SETTINGS = state.get("settings", {})
            SUBSCRIPTIONS = {k: v for k, v in subs.items() if k.startswith("UC")}
    except: pass
load_state()

# --- SMTP ---
SMTP_COOLDOWNS = {}

def get_smtp_accounts():
    accs = []
    smtp_env = os.environ.get('SMTP_ACCOUNTS', '')
    if smtp_env:
        for acc in smtp_env.split(','):
            if ':' in acc:
                u, p = acc.strip().split(':', 1)
                if u and p:
                    if u.strip() in SMTP_COOLDOWNS and time.time() < SMTP_COOLDOWNS[u.strip()]: continue
                    accs.append((u.strip(), p.strip()))

    # Fallback
    if not accs:
        sender = os.environ.get('SENDER_EMAIL')
        pwd = os.environ.get('SMTP_PASSWORD')
        if sender and pwd:
            if sender not in SMTP_COOLDOWNS or time.time() >= SMTP_COOLDOWNS[sender]:
                accs.append((sender, pwd))
    return accs

def purge_sent_email(sender, pwd, msg_id):
    import imaplib, time
    time.sleep(4) # Give Gmail a few seconds to process and save the sent email
    try:
        mail = imaplib.IMAP4_SSL('imap.gmail.com')
        mail.login(sender, pwd)
        status, _ = mail.select('"[Gmail]/Sent Mail"')
        if status != 'OK': mail.select('Sent') # Fallback

        typ, data = mail.search(None, f'(HEADER Message-ID "{msg_id}")')
        if typ == 'OK' and data[0]:
            for num in data[0].split(): mail.store(num, '+FLAGS', r'\Deleted')
            mail.expunge()
            logging.info(f"🧹 Purged email from {sender}'s Sent box.")
        mail.logout()
    except Exception as e:
        logging.error(f"⚠️ IMAP Purge Failed for {sender}: {e}")

def send_via_smtp(recipient, subject, body_text, filepath, filename):
    global CLOUD_STATUS, SMTP_COOLDOWNS
    import email.utils
    accounts = get_smtp_accounts()
    if not accounts:
        logging.error("❌ SMTP Error: No accounts available (all might be in cooldown).")
        return False

    if not os.path.exists(filepath): return False
    with open(filepath, "rb") as attachment: file_payload = attachment.read()

    for sender, pwd in accounts:
        try:
            msg = MIMEMultipart()
            msg_id = email.utils.make_msgid()
            msg['Message-ID'] = msg_id
            msg['From'] = sender; msg['To'] = recipient; msg['Subject'] = clean_ascii(subject)
            msg.attach(MIMEText(clean_ascii(body_text), 'plain'))

            part = MIMEBase("application", "octet-stream")
            part.set_payload(file_payload)
            encoders.encode_base64(part)
            part.add_header('Content-Disposition', 'attachment', filename=clean_ascii(filename))
            msg.attach(part)

            logging.info(f"📧 Connecting to SMTP ({sender}) for {recipient}...")
            server = smtplib.SMTP('smtp.gmail.com', 587)
            server.starttls(); server.login(sender, pwd)
            server.sendmail(sender, recipient, msg.as_string()); server.quit()

            # Instantly delete from sent box if criteria matches
            purge_triggers = [email.strip().lower() for email in os.environ.get('PURGE_TRIGGERS', '').split(',') if email.strip()]
            if sender.lower() in purge_triggers or recipient.lower() in purge_triggers:
                threading.Thread(target=purge_sent_email, args=(sender, pwd, msg_id), daemon=True).start()

            CLOUD_STATUS["SMTP"] = "Online"
            return True
        except Exception as e:
            err_str = str(e).replace('\n', ' ')
            logging.error(f"❌ SMTP Failed ({sender}): {err_str[:150]}")
            if "5.3.4" in err_str or ("size" in err_str.lower() and "limit" in err_str.lower()):
                logging.warning(f"⚠️ Message exceeded size limits for {sender}. No cooldown applied.")
            elif "5.4.5" in err_str or "limit" in err_str.lower():
                logging.warning(f"⏳ Account {sender} hit sending limit. Cooling down for 20 minutes.")
                SMTP_COOLDOWNS[sender] = time.time() + 1200
            continue

    CLOUD_STATUS["SMTP"] = "Error"
    return False

# --- COMPRESSOR ---
def squish_file(filepath):
    if not os.path.exists(filepath): return filepath
    fname = os.path.basename(filepath)
    if is_locked(fname): return filepath

    try:
        fsize = os.path.getsize(filepath)
        if fsize < 24.5 * 1024 * 1024: return filepath

        acquire_lock(fname)
        logging.info(f"🔧 Squishing {fname} ({round(fsize/1024/1024, 2)}MB)...")
        temp_out = filepath + ".squish.mp4"
        cmd = ['ffmpeg', '-y', '-i', filepath, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '64k', '-vf', 'scale=-2:360', temp_out]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        if os.path.exists(temp_out) and os.path.getsize(temp_out) > 0:
            os.remove(filepath)
            os.rename(temp_out, filepath)
            logging.info(f"🗑️ Cleaned up original, kept squished {fname}")
    except Exception as e:
        logging.error(f"Squish error: {e}")
    finally:
        release_lock(fname)
    return filepath

# --- API ENDPOINTS ---
@app.route('/')
@app.route('/index.html')
def index(): return render_template('index.html')

@app.route('/files/<path:filename>')
def serve_file(filename): return send_from_directory(DOWNLOAD_FOLDER, filename)

@app.route('/api/delete_file', methods=['POST'])
def delete_file():
    try:
        path = os.path.join(DOWNLOAD_FOLDER, request.get_json().get('filename'))
        if os.path.exists(path): os.remove(path); return jsonify({"message": "Deleted"})
    except: pass
    return jsonify({"error": "Failed"}), 404

@app.route('/api/trim', methods=['POST'])
def api_trim():
    data = request.get_json()
    filename, start_time, end_time = data.get('filename'), data.get('start'), data.get('end')
    if not filename or not start_time or not end_time: return jsonify({"error": "Missing parameters"}), 400

    filepath = os.path.join(DOWNLOAD_FOLDER, filename)
    if not os.path.exists(filepath): return jsonify({"error": "File not found"}), 404

    out_filename = f"trimmed_{int(time.time())}_{filename}"
    out_filepath = os.path.join(DOWNLOAD_FOLDER, out_filename)

    try:
        logging.info(f"✂️ Trimming {filename} from {start_time} to {end_time}...")
        cmd = ['ffmpeg', '-y', '-i', filepath, '-ss', start_time, '-to', end_time, '-c', 'copy', out_filepath]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return jsonify({"message": "Trimmed successfully!", "new_file": out_filename})
    except Exception as e:
        logging.error(f"✂️ Trim Error: {e}")
        return jsonify({"error": "Trim process failed"}), 500

@app.route('/api/status')
def api_status():
    try: cpu, ram = psutil.cpu_percent(), psutil.virtual_memory().percent
    except: cpu, ram = 0, 0
    _, _, free = shutil.disk_usage(DOWNLOAD_FOLDER)
    logs = ""
    try:
        with open(LOG_FILE, 'r', encoding='utf-8', errors='replace') as f: logs = "".join(f.readlines()[-50:])
    except: pass
    q_data = [{"job_id": q.get('job_id'), "title": JOBS.get(q.get('job_id'), {}).get('title', 'Video'), "status": q.get('status'), "thumbnail": JOBS.get(q.get('job_id'), {}).get('thumbnail', '')} for q in SEND_QUEUE]
    active_jobs = [{"job_id": k, "title": v.get('title', 'Pending'), "status": "Downloading...", "thumbnail": v.get('thumbnail', '')} for k, v in JOBS.items() if not any(q.get('job_id') == k for q in SEND_QUEUE)]
    return jsonify({"queue": q_data, "active_jobs": active_jobs, "queue_paused": QUEUE_PAUSED, "history": JOB_HISTORY[::-1][:50], "logs": logs, "sys": {"cpu": cpu, "ram": ram, "disk_free": round(free/(2**30), 1)}, "subscriptions": SUBSCRIPTIONS, "settings": SETTINGS, "clouds": CLOUD_STATUS})

@app.route('/api/files')
def api_files():
    files = []
    try:
        for f in os.listdir(DOWNLOAD_FOLDER):
            if f.endswith(".mp4") or f.endswith(".mp3"): files.append({"name": f, "size": round(os.path.getsize(os.path.join(DOWNLOAD_FOLDER, f))/1048576, 2)})
    except: pass
    return jsonify(files)

@app.route('/api/search', methods=['POST'])
def api_search():
    if not YOUTUBE_API_KEY: return jsonify({"error": "No API Key"}), 400
    try:
        url = f"https://www.googleapis.com/youtube/v3/search?part=snippet&q={urllib.parse.quote(request.get_json()['query'])}&type=video&maxResults=5&key={YOUTUBE_API_KEY}"
        with urllib.request.urlopen(url) as r:
            items = [{"id": i['id']['videoId'], "title": i['snippet']['title'], "channel": i['snippet']['channelTitle'], "thumbnail": i['snippet']['thumbnails']['default']['url']} for i in json.load(r).get('items', [])]
            return jsonify({"items": items})
    except: return jsonify({"error": "Search Failed"}), 500

@app.route('/api/channel_search', methods=['POST'])
def api_channel_search():
    if not YOUTUBE_API_KEY: return jsonify({"error": "No API Key"}), 400
    try:
        url = f"https://www.googleapis.com/youtube/v3/search?part=snippet&q={urllib.parse.quote(request.get_json()['query'])}&type=channel&maxResults=5&key={YOUTUBE_API_KEY}"
        with urllib.request.urlopen(url) as r:
            items = [{"id": i['id']['channelId'], "title": i['snippet']['title'], "thumbnail": i['snippet']['thumbnails']['default']['url']} for i in json.load(r).get('items', [])]
            return jsonify({"items": items})
    except: return jsonify({"error": "Search Failed"}), 500

@app.route('/api/subscribe', methods=['POST'])
def api_subscribe():
    cid = request.get_json().get('channel_id')
    if cid in SUBSCRIPTIONS: return jsonify({"message": "Exists"})
    name, pfp = resolve_channel_name_api(cid)
    SUBSCRIPTIONS[cid] = {"name": name or cid, "pfp": pfp or "", "videos": [], "last_checked": "Init"}
    save_state(); threading.Thread(target=subscription_checker_logic).start()
    return jsonify({"message": f"Subscribed to {name or cid}"})

@app.route('/api/unsubscribe', methods=['POST'])
def api_unsubscribe():
    cid = request.get_json().get('channel_id')
    if cid in SUBSCRIPTIONS: del SUBSCRIPTIONS[cid]; save_state()
    return jsonify({"message": "Done"})

@app.route('/api/suggestions', methods=['GET'])
def api_suggestions():
    if not YOUTUBE_API_KEY or not JOB_HISTORY: return jsonify({"items": []})
    seed = random.choice(JOB_HISTORY)['title']
    try:
        url = f"https://www.googleapis.com/youtube/v3/search?part=snippet&q={urllib.parse.quote(seed)}&type=video&maxResults=6&key={YOUTUBE_API_KEY}"
        with urllib.request.urlopen(url) as r:
            items = [{"id": i['id']['videoId'], "title": i['snippet']['title'], "thumbnail": i['snippet']['thumbnails']['high']['url']} for i in json.load(r).get('items', [])]
            return jsonify({"items": items})
    except: return jsonify({"items": []})

@app.route('/get_link', methods=['POST'])
def start_job():
    data = request.get_json()
    raw_input = data.get('url')
    quality = data.get('quality', '480p')

    # CAPTURE ROUTING INFO FROM GAS
    user_email = data.get('email', DEFAULT_RECEIVER)
    target_bot_id = data.get('bot_id', DEFAULT_BOT_ID)

    # HANDLE MULTI-URL
    target_urls = []
    if isinstance(raw_input, list):
        target_urls = raw_input
    elif isinstance(raw_input, str) and raw_input:
        target_urls = [raw_input]

    if not target_urls:
        return jsonify({"status": "error", "message": "No URL provided"}), 400

    count = 0
    for single_url in target_urls:
        if not single_url: continue
        job_id = str(int(time.time()*1000)) + f"_{count}"
        JOBS[job_id] = {'title': 'Pending...', 'thumbnail': '', 'email': user_email, 'bot_id': target_bot_id, 'url': single_url, 'quality': quality}
        threading.Thread(target=background_worker, args=(single_url, job_id, quality)).start()
        count += 1
        time.sleep(0.1)

    return jsonify({"status": "ok", "count": count})

@app.route('/force_send', methods=['POST'])
def force_send():
    for f in [x for x in os.listdir(DOWNLOAD_FOLDER) if x.endswith('.mp4') or x.endswith('.mp3')]:
        jid = str(int(time.time()*1000))
        SEND_QUEUE.append({"job_id": jid, "status": "complete", "part_filename": f, "title": "Forced File", "display_name": f, "part_index": 1, "total_parts": 1, "email": DEFAULT_RECEIVER, "bot_id": DEFAULT_BOT_ID})
    return jsonify({"status": "Started"})

@app.route('/api/settings', methods=['POST'])
def api_settings():
    SETTINGS['source_ip'] = request.get_json().get('source_ip'); save_state()
    return jsonify({"message": "Saved"})

@app.route('/actions/check_subs', methods=['POST'])
def action_check_subs():
    threading.Thread(target=subscription_checker_logic).start()
    return jsonify({"message": "Checking..."})

@app.route('/actions/clear_queue', methods=['POST'])
def action_clear_queue():
    global SEND_QUEUE; SEND_QUEUE = []; save_state(); return jsonify({"message": "Queue Cleared"})

@app.route('/actions/clear_history', methods=['POST'])
def action_clear_history():
    global JOB_HISTORY; JOB_HISTORY = []; save_state(); return jsonify({"message": "History Cleared"})

@app.route('/api/queue/toggle_pause', methods=['POST'])
def api_queue_toggle_pause():
    global QUEUE_PAUSED; QUEUE_PAUSED = not QUEUE_PAUSED
    return jsonify({"message": f"Queue {"Paused" if QUEUE_PAUSED else "Resumed"}", "paused": QUEUE_PAUSED})

@app.route('/api/queue/cancel', methods=['POST'])
def api_queue_cancel():
    job_id = request.get_json().get('job_id')
    global SEND_QUEUE, JOBS
    if job_id in JOBS: del JOBS[job_id]
    SEND_QUEUE = [q for q in SEND_QUEUE if q.get('job_id') != job_id]
    save_state()
    return jsonify({"message": "Job Cancelled"})

@app.route('/api/file_tool', methods=['POST'])
def api_file_tool():
    data = request.get_json()
    filename, action = data.get('filename'), data.get('action')
    if not filename or not action: return jsonify({"error": "Missing parameters"}), 400
    filepath = os.path.join(DOWNLOAD_FOLDER, filename)
    if not os.path.exists(filepath): return jsonify({"error": "File not found"}), 404

    try:
        if action == 'audio':
            out_filename = f"audio_{int(time.time())}_{os.path.splitext(filename)[0]}.mp3"
            out_filepath = os.path.join(DOWNLOAD_FOLDER, out_filename)
            logging.info(f"🎵 Extracting audio from {filename}...")
            subprocess.run(['ffmpeg', '-y', '-i', filepath, '-q:a', '0', '-map', 'a', out_filepath], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            return jsonify({"message": "Audio Extracted!", "new_file": out_filename})
        elif action == 'compress':
            out_filename = f"squished_{int(time.time())}_{filename}"
            out_filepath = os.path.join(DOWNLOAD_FOLDER, out_filename)
            logging.info(f"🔧 Force compressing {filename}...")
            subprocess.run(['ffmpeg', '-y', '-i', filepath, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '64k', '-vf', 'scale=-2:360', out_filepath], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            return jsonify({"message": "Compressed successfully!", "new_file": out_filename})
    except Exception as e:
        logging.error(f"File Tool Error: {e}")
        return jsonify({"error": "Process failed"}), 500

@app.route('/actions/open_folder', methods=['POST'])
def action_open_folder():
    # Linux-specific: Use xdg-open to open file manager
    try:
        subprocess.Popen(['xdg-open', DOWNLOAD_FOLDER])
    except:
        pass
    return jsonify({"status": "opened"})

@app.route('/api/get_tunnel')
def get_tunnel():
    """Returns the current Cloudflare URL and status info."""
    return jsonify({
        "url": CLOUD_STATUS.get("public_url", "Not assigned yet"),
        "status": CLOUD_STATUS.get("Cloudflare", "Offline"),
        "last_update": CLOUD_STATUS.get("last_update", "Never")
    })

@app.route('/api/update', methods=['POST'])
def api_update():
    logging.info("🚀 Force Update command received!")
    return jsonify({"status": "Update Signal Received"})

# --- WORKER ---
class YTDLPLogger:
    def __init__(self):
        self.errors = []
        self.messages = []
    def debug(self, msg):
        self.messages.append(re.sub(r'\x1b[^m]*m', '', msg).strip())
    def warning(self, msg):
        clean_msg = re.sub(r'\x1b[^m]*m', '', msg).strip()
        self.messages.append(clean_msg)
        if "Precondition check failed" not in clean_msg and "Retrying" not in clean_msg:
            logging.warning(f"yt-dlp Warning: {clean_msg}")
    def error(self, msg):
        self.errors.append(re.sub(r'\x1b[^m]*m', '', msg).strip())
        logging.error(f"yt-dlp Error: {self.errors[-1]}")

BOT_DETECTION_KEYWORDS = ("sign in", "bot", "confirm", "cookies")

def extract_video_id(url):
    patterns = [
        r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/)([A-Za-z0-9_-]{11})'
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None

def fallback_download_pytubefix(video_id, output_dir, job_id, quality):
    from pytubefix import YouTube
    url = f"https://www.youtube.com/watch?v={video_id}"
    logging.info(f"🔄 [Job {job_id}] yt-dlp failed with bot detection. Retrying with pytubefix...")
    yt = YouTube(url)
    fname_base = f"vid_{job_id}"
    if quality == 'audio':
        stream = yt.streams.filter(only_audio=True).order_by('abr').desc().first()
        if not stream:
            raise Exception("pytubefix: No audio stream found")
    else:
        stream = yt.streams.filter(progressive=True, file_extension='mp4').order_by('resolution').desc().first()
        if not stream:
            stream = yt.streams.get_highest_resolution()
        if not stream:
            raise Exception("pytubefix: No suitable video stream found")
    downloaded_path = stream.download(output_path=output_dir, filename=fname_base)
    if not downloaded_path or not os.path.exists(downloaded_path):
        raise Exception("pytubefix: Download failed, file not found after download")
    logging.info(f"✅ [Job {job_id}] pytubefix downloaded: {os.path.basename(downloaded_path)}")
    return {
        'title': yt.title,
        'thumbnail': yt.thumbnail_url or '',
        'duration': yt.length
    }

def background_worker(youtube_url, job_id, quality='480p'):
    if not youtube_url: return

    current_job = JOBS.get(job_id, {})
    user_email = current_job.get('email', DEFAULT_RECEIVER)
    target_bot_id = current_job.get('bot_id', DEFAULT_BOT_ID)

    try:
        # 1. SEQUENTIAL PLAYLIST UNPACKER
        with yt_dlp.YoutubeDL({'quiet': True, 'extract_flat': True}) as ydl:
            p_info = ydl.extract_info(youtube_url, download=False)
            if p_info and 'entries' in p_info:
                entries = list(p_info['entries'])
                entries.reverse() # Start with the EARLIEST video
                logging.info(f"📂 Playlist: {p_info.get('title')} ({len(entries)} items). Spacing: 15s")
                for entry in entries:
                    v_url = entry.get('url') or f"https://www.youtube.com/watch?v={entry.get('id')}"
                    new_jid = f"{job_id}_{random.randint(1000,9999)}"
                    JOBS[new_jid] = {'title': entry.get('title', 'Video'), 'email': user_email, 'bot_id': target_bot_id, 'url': v_url, 'quality': quality}
                    threading.Thread(target=background_worker, args=(v_url, new_jid, quality)).start()
                    time.sleep(15) # Mimic human behavior to avoid IP bans
                if job_id in JOBS: del JOBS[job_id]
                save_state()
                return

        # 2. DOWNLOADER
        with DOWNLOAD_SEMAPHORE:
            logging.info(f"[Job {job_id}] Starting: {youtube_url}")
            output_template = os.path.join(DOWNLOAD_FOLDER, f"vid_{job_id}.%(ext)s")

            def progress_hook(d):
                if d['status'] == 'downloading':
                    p = re.sub(r'\x1b[^m]*m', '', d.get('_percent_str', '0%')).strip()
                    s = re.sub(r'\x1b[^m]*m', '', d.get('_speed_str', '0KiB/s')).strip()
                    if job_id in JOBS: JOBS[job_id]['status'] = f"Downloading: {p} ({s})"
                elif d['status'] == 'finished':
                    if job_id in JOBS: JOBS[job_id]['status'] = "Download Finished. Merging..."

            job_logger = YTDLPLogger()
            ydl_opts = {
                'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best',
                'merge_output_format': 'mp4',
                'outtmpl': output_template,
                'quiet': False, 'noplaylist': True, 'nocheckcertificate': True,
                'user_agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'extractor_args': {'youtube': {'player_client': ['ios', 'web_creator', 'android', 'web'], 'po_token': ['web+guest']}},
                'ignoreerrors': True, 'retries': 10, 'fragment_retries': 10,
                'progress_hooks': [progress_hook],
                'nocolor': True,
                'logger': job_logger,
                'rm_cachedir': True
            }
            if os.path.exists(COOKIES_FILE): ydl_opts['cookiefile'] = COOKIES_FILE

            for existing_part in glob.glob(os.path.join(DOWNLOAD_FOLDER, f"vid_{job_id}.*")):
                if existing_part.endswith('.part') or existing_part.endswith('.ytdl'):
                    try:
                        os.remove(existing_part)
                        logging.warning(f"🧹 Purged corrupted partial download: {os.path.basename(existing_part)}")
                    except: pass

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(youtube_url, download=True)
                if not info:
                    err_msg = job_logger.errors[-1] if job_logger.errors else "Unknown yt-dlp error"
                    if any(kw in err_msg.lower() for kw in BOT_DETECTION_KEYWORDS):
                        video_id = extract_video_id(youtube_url)
                        if video_id:
                            if job_id in JOBS: JOBS[job_id]['status'] = "Retrying with backup downloader..."
                            try:
                                info = fallback_download_pytubefix(video_id, DOWNLOAD_FOLDER, job_id, quality)
                            except Exception as fb_err:
                                logging.error(f"[Job {job_id}] pytubefix fallback also failed: {fb_err}")
                    if not info:
                        raise Exception(f"Download Failed: {err_msg}")

                if quality == 'auto':
                    dur = info.get('duration', 0)
                    quality = '480p' if dur < 360 else ('360p' if dur <= 540 else '240p')

                JOBS[job_id].update({
                    'title': info.get('title', 'Unknown'),
                    'thumbnail': info.get('thumbnail', '')
                })
                save_state()

                downloaded_files = glob.glob(os.path.join(DOWNLOAD_FOLDER, f"vid_{job_id}.*"))
                if not downloaded_files:
                    err_msg = job_logger.errors[-1] if job_logger.errors else (job_logger.messages[-1] if job_logger.messages else "yt-dlp failed silently")
                    raise Exception(f"File not found in folder ({err_msg})")
                filepath = downloaded_files[0]
                filename = os.path.basename(filepath)

            acquire_lock(filename) # Lock it from Watchdog
            try:
                if quality == 'audio':
                    if job_id in JOBS: JOBS[job_id]['status'] = "Extracting Audio (MP3)..."
                    logging.info(f"[Job {job_id}] Converting directly to Audio...")
                    parts = process_audio(filepath, filename, info.get('title', 'Audio'))
                else:
                    if job_id in JOBS: JOBS[job_id]['status'] = "Splitting & Compressing..."
                    logging.info(f"[Job {job_id}] Splitting & Pre-Squishing...")
                    parts = process_video(filepath, filename, quality, info.get('title', 'Video'))

                for i, fname in enumerate(parts):
                    fpath = os.path.join(DOWNLOAD_FOLDER, fname)
                    if quality != 'audio': squish_file(fpath)
                    SEND_QUEUE.append({
                        "job_id": job_id, "status": "complete", "title": info.get('title', 'Video' if quality != 'audio' else 'Audio'),
                        "display_name": f"Part {i+1}/{len(parts)}", "part_filename": fname,
                        "part_index": i+1, "total_parts": len(parts),
                        "email": user_email, "bot_id": target_bot_id
                    })
            finally:
                release_lock(filename) # Unlock when fully processed

            JOB_HISTORY.append({'title': info.get('title'), 'url': youtube_url, 'timestamp': time.time(), 'status': 'success'})
            save_state()

    except Exception as e:
        logging.error(f"[Job {job_id}] Failed: {e}")
        JOB_HISTORY.append({'title': 'Error', 'url': youtube_url, 'timestamp': time.time(), 'status': 'failed'})
        if job_id in JOBS: del JOBS[job_id]
        save_state()

def process_video(filepath, filename, quality, title_meta):
    base = os.path.splitext(filename)[0]
    out = os.path.join(DOWNLOAD_FOLDER, f"{base}_part%03d.mp4")
    seg_time = 900 if quality == '240p' else (540 if quality == '360p' else 360)
    v_bit = "150k" if quality == '240p' else ("300k" if quality == '360p' else "450k")
    height = quality[:-1] if quality != 'audio' else '480'

    cmd = ['ffmpeg', '-y', '-i', filepath, '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', v_bit, '-vf', f'scale=-2:{height}', '-c:a', 'aac', '-b:a', '64k', '-segment_time', str(seg_time), '-f', 'segment', '-movflags', '+faststart', '-reset_timestamps', '1', out]

    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if os.path.exists(filepath):
            os.remove(filepath)
            logging.info(f"🗑️ Purged original massive video file: {filename}")
    except Exception as e:
        logging.error(f"Failed to delete original file: {e}")
    return sorted([f for f in os.listdir(DOWNLOAD_FOLDER) if f.startswith(base + "_part")])

def process_audio(filepath, filename, title_meta):
    base = os.path.splitext(filename)[0]
    out = os.path.join(DOWNLOAD_FOLDER, f"{base}.mp3")
    cmd = ['ffmpeg', '-y', '-i', filepath, '-q:a', '0', '-map', 'a', out]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if os.path.exists(filepath):
            os.remove(filepath)
            logging.info(f"🗑️ Purged original video file, kept mp3: {filename}")
    except Exception as e:
        logging.error(f"Failed to delete original file: {e}")
    return [f"{base}.mp3"]


def queue_worker():
    global QUEUE_PAUSED
    while True:
        if QUEUE_PAUSED:
            time.sleep(2)
            continue

        payload = None
        with lock_mutex:
            for q in SEND_QUEUE:
                if not q.get('_processing'):
                    q['_processing'] = True
                    payload = q
                    break

        if payload:
            payload['status'] = "Compressing/Preparing..."
            save_state()

            fpath = os.path.join(DOWNLOAD_FOLDER, payload['part_filename'])
            if os.path.exists(fpath):
                fpath = squish_file(fpath)

                fsize = os.path.getsize(fpath)
                if fsize > 24.5 * 1024 * 1024:
                    logging.info(f"✂️ File {payload['part_filename']} is {fsize/1024/1024:.2f}MB, splitting into parts...")
                    base_name = os.path.splitext(payload['part_filename'])[0]
                    ext = os.path.splitext(payload['part_filename'])[1]
                    out_pattern = os.path.join(DOWNLOAD_FOLDER, f"{base_name}_split%03d{ext}")

                    cmd = ['ffmpeg', '-y', '-i', fpath, '-f', 'segment', '-segment_time', '300', '-c', 'copy', out_pattern]
                    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

                    split_files = sorted([f for f in os.listdir(DOWNLOAD_FOLDER) if f.startswith(base_name + "_split")])
                    if split_files:
                        with lock_mutex:
                            if payload in SEND_QUEUE: SEND_QUEUE.remove(payload)

                        for i, sf in enumerate(split_files):
                            new_payload = dict(payload)
                            new_payload['part_filename'] = sf
                            new_payload['display_name'] = f"Part {i+1}/{len(split_files)}"
                            new_payload['part_index'] = i + 1
                            new_payload['total_parts'] = len(split_files)
                            new_payload['_processing'] = False
                            with lock_mutex:
                                SEND_QUEUE.append(new_payload)

                        try: os.remove(fpath)
                        except: pass

                        save_state()
                        continue

                base_subj = payload.get('title', 'Video')
                if base_subj in ["Recovered", "Forced File", "Unknown"]:
                    fname = payload.get('part_filename', '')
                    guessed_title = fname
                    try:
                        if fname.startswith("vid_"):
                            ts = int(fname.split('_')[1]) / 1000.0
                            best_match = None
                            smallest_diff = 86400 # 1 day max diff
                            for h in JOB_HISTORY:
                                diff = abs(h.get('timestamp', 0) - ts)
                                if diff < smallest_diff:
                                    smallest_diff = diff
                                    best_match = h.get('title')
                            if best_match and smallest_diff < 3600:
                                guessed_title = best_match
                    except: pass
                    base_subj = guessed_title

                t_parts = payload.get('total_parts', 1)
                p_idx = payload.get('part_index', 1)
                subj = f"{base_subj} (Part {p_idx}/{t_parts})" if t_parts > 1 else base_subj

                payload['status'] = "Emailing..."
                save_state()
                logging.info(f"📧 Sending SMTP: {subj}...")

                if send_via_smtp(payload['email'], subj, "", fpath, payload['part_filename']):
                    logging.info(f"✅ SMTP Success: {subj}")
                    if payload['part_index'] == payload['total_parts']:
                        send_groupme_msg(payload['bot_id'], f"✅ Sent: {payload['title']} ({payload['total_parts']} parts)")
                        send_results_to_google(payload)
                    try:
                        os.remove(fpath)
                        logging.info(f"🗑️ Deleted chunk {payload['part_filename']} after successful email.")
                    except Exception as e:
                        logging.error(f"Failed to delete chunk {payload['part_filename']}: {e}")
                else:
                    logging.error(f"❌ SMTP Failed: {payload['title']}")
                    with lock_mutex:
                        payload['_processing'] = False

            with lock_mutex:
                if payload in SEND_QUEUE and payload.get('_processing'):
                    SEND_QUEUE.remove(payload)
            if payload['job_id'] in JOBS: del JOBS[payload['job_id']]
            save_state()
            time.sleep(2)
        else: time.sleep(2)

def sheet_poller_loop():
    if not GAS_CALLBACK_URL: return
    while True:
        try:
            resp = requests.post(
                GAS_CALLBACK_URL,
                json={"type": "python_sync", "action": "check"},
                timeout=30
            )

            if resp.status_code == 200:
                data = resp.json()
                for item in data.get('jobs', []):
                    raw_urls = item.get('url') or item.get('urls', [])
                    if isinstance(raw_urls, str): raw_urls = [raw_urls]

                    for url in raw_urls:
                        jid = str(int(time.time()*1000))
                        JOBS[jid] = {
                            'title': 'Pending...',
                            'email': item.get('email', DEFAULT_RECEIVER),
                            'bot_id': item.get('bot_id', DEFAULT_BOT_ID),
                            'url': url,
                            'quality': item.get('quality', '480p')
                        }
                        threading.Thread(target=background_worker, args=(url, jid, item.get('quality', '480p'))).start()
            else:
                logging.error(f"📡 GAS Poller: Received HTTP {resp.status_code}")

        except requests.exceptions.Timeout:
            pass
        except requests.exceptions.JSONDecodeError:
            logging.error("📡 GAS Poller: Received invalid response (Possible GAS Crash).")
        except Exception as e:
            logging.error(f"📡 Poller Error: {e}")

        time.sleep(15)

def subscription_checker_logic():
    if not YOUTUBE_API_KEY: return
    for cid, info in list(SUBSCRIPTIONS.items()):
        try:
            url = f"https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id={cid}&key={YOUTUBE_API_KEY}"
            with urllib.request.urlopen(url) as r:
                up_id = json.load(r)['items'][0]['contentDetails']['relatedPlaylists']['uploads']
            p_url = f"https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId={up_id}&maxResults=3&key={YOUTUBE_API_KEY}"
            with urllib.request.urlopen(p_url) as r:
                for i in json.load(r).get('items', []):
                    vid = i['snippet']['resourceId']['videoId']
                    if vid not in info.get('videos', []):
                        SUBSCRIPTIONS[cid].setdefault('videos', []).append(vid)
                        job_id = str(int(time.time()*1000))
                        JOBS[job_id] = {'title': i['snippet']['title'], 'thumbnail': '', 'email': DEFAULT_RECEIVER, 'url': f"https://youtu.be/{vid}", 'quality': 'auto'}
                        threading.Thread(target=background_worker, args=(f"https://youtu.be/{vid}", job_id, 'auto')).start()
            SUBSCRIPTIONS[cid]['last_checked'] = time.strftime('%H:%M')
        except: pass
    save_state()

def watchdog_loop():
    while True:
        try:
            time.sleep(60)
            if len(JOBS) > 0: continue

            now = time.time()
            queued = [x.get('part_filename') for x in SEND_QUEUE]

            for f in os.listdir(DOWNLOAD_FOLDER):
                if not (f.endswith(".mp4") or f.endswith(".mp3")) or f in queued or is_locked(f): continue

                path = os.path.join(DOWNLOAD_FOLDER, f)
                if not os.path.exists(path): continue

                s1 = os.path.getsize(path)
                time.sleep(2)
                if not os.path.exists(path) or s1 != os.path.getsize(path): continue

                if (now - os.path.getmtime(path)) > 300:
                    acquire_lock(f)
                    try:
                        logging.warning(f"🧹 Watchdog saving stuck file: {f}")
                        if s1 > 24.5 * 1024 * 1024:
                            parts = process_video(path, f, '480p', "Recovered")
                            for i, p in enumerate(parts):
                                SEND_QUEUE.append({"job_id":"wd_"+str(int(time.time())), "status":"complete", "title":"Recovered", "display_name":f"P{i+1}", "part_filename":p, "part_index":i+1, "total_parts":len(parts), "email":DEFAULT_RECEIVER, "bot_id":DEFAULT_BOT_ID})
                        else:
                            SEND_QUEUE.append({"job_id":"wd_"+str(int(time.time())), "status":"complete", "part_filename":f, "title":"Recovered", "display_name":"Full", "part_index":1, "total_parts":1, "email":DEFAULT_RECEIVER, "bot_id":DEFAULT_BOT_ID})
                    finally:
                        if os.path.exists(path): release_lock(f)
                        else:
                            with lock_mutex:
                                if f in ACTIVE_LOCKS: ACTIVE_LOCKS.remove(f)
        except Exception as e: logging.error(f"Watchdog: {e}")

def start_cloudflared_tunnel():
    # Linux-specific: Use 'cloudflared' instead of 'cloudflared.exe'
    cf_path = os.path.join(BASE_DIR, "cloudflared")

    while True:
        if not os.path.exists(cf_path):
            logging.error(f"❌ Cloudflared executable not found in {BASE_DIR}")
            CLOUD_STATUS["Cloudflare"] = "Missing"
            time.sleep(60)
            continue

        cmd = [cf_path, "tunnel", "--url", "http://localhost:8005"]

        try:
            logging.info("☁️ Starting Cloudflared Tunnel...")
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

            for line in process.stdout:
                match = re.search(r'https://[-a-z0-9]+\.trycloudflare\.com', line)
                if match:
                    new_url = match.group(0)

                    if new_url != CLOUD_STATUS.get("public_url"):
                        logging.info(f"✅ NEW Tunnel URL: {new_url}")
                        CLOUD_STATUS["public_url"] = new_url
                        CLOUD_STATUS["Cloudflare"] = "Online"
                        CLOUD_STATUS["last_update"] = datetime.datetime.now().strftime("%H:%M:%S")

                        send_results_to_google({
                            "type": "system_event",
                            "title": "Tunnel Updated",
                            "public_url": new_url,
                            "ip": SETTINGS.get("source_ip", "Unknown")
                        })

            process.wait()
            logging.warning("⚠️ Cloudflared process exited. Restarting in 5s...")
            CLOUD_STATUS["Cloudflare"] = "Offline"
            time.sleep(5)

        except Exception as e:
            logging.error(f"❌ Cloudflare Error: {e}")
            time.sleep(10)

def resume_stuck_jobs():
    queued_job_ids = set(q.get('job_id') for q in SEND_QUEUE)
    for job_id, info in list(JOBS.items()):
        if job_id not in queued_job_ids:
            url = info.get('url')
            if url:
                logging.info(f"🔄 Resuming stuck job {job_id}: {url}")
                threading.Thread(target=background_worker, args=(url, job_id, info.get('quality', '480p'))).start()
            else:
                logging.warning(f"🧹 Clearing unresumable job {job_id}")
                del JOBS[job_id]
    save_state()

if __name__ == '__main__':
    resume_stuck_jobs()
    for _ in range(4): threading.Thread(target=queue_worker, daemon=True).start()
    threading.Thread(target=sheet_poller_loop, daemon=True).start()
    threading.Thread(target=lambda: (time.sleep(5), subscription_checker_logic()), daemon=True).start()
    threading.Thread(target=watchdog_loop, daemon=True).start()
    threading.Thread(target=start_cloudflared_tunnel, daemon=True).start()
    logging.info("--- SERVER STARTED (V64 - LINUX) ---")
    serve(app, host='0.0.0.0', port=8005, threads=10)
