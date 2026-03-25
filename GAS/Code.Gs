/**
 * 🚀 ULTIMATE GROUPME BOT - CONTEXT ISOLATION (v40.1)
 * 
 * UPDATES: 
 * - FIXED Cross-talk bug: Search results are now saved per-Group ID.
 * - Removed global search keys, added dynamic 'getContextKeys(gid)'.
 * - Updated all handlers to accept 'groupId'.
 */

// ==========================================
// 1. CONFIGURATION LOADER
// ==========================================

const DB_GROUPS = 'cfg_groups_db';
const DB_USERS = 'cfg_users_db';
const SPREADSHEET_ID_KEY = 'spreadsheetId';
const HISTORY_LOG_KEY = 'global_download_history'; 
const BANNED_USERS_KEY = 'banned_user_ids';
const MAINT_MODE_KEY = 'maintenance_mode_active';
const OFFLINE_QUEUE_SHEET = 'OfflineQueue';
const REPORTS_KEY = 'user_reports_log'; 
const QUOTA_KEY_PREFIX = 'quota_';
const FAVORITES_PREFIX = 'fav_list_';

function getConfig() {
  const p = PropertiesService.getScriptProperties();
  return {
    PAGEKITE: p.getProperty('CFG_PAGEKITE_URL'),
    API_KEY: p.getProperty('CFG_GOOGLE_API_KEY'),
    CX_ID: p.getProperty('CFG_GOOGLE_CX_ID'),
    LIMIT: parseInt(p.getProperty('CFG_DAILY_LIMIT') || '20'),
    MAX_RES: parseInt(p.getProperty('CFG_MAX_RESULTS') || '10'),
    OWNER: p.getProperty('CFG_OWNER_ID'),
    DEF_BOT: p.getProperty('CFG_DEFAULT_BOT_ID'),
    DEF_EMAIL: p.getProperty('CFG_DEFAULT_EMAIL')
  };
}

// --- NEW CONTEXT HELPER ---
function getContextKeys(gid) {
  const suffix = gid ? `_${gid}` : '_dm';
  return {
    SEARCH: 'last_search' + suffix,
    CHANNEL: 'last_channel' + suffix,
    QUERY: 'last_query' + suffix,
    TOKEN: 'page_token' + suffix
  };
}

function getGroups() { const j = PropertiesService.getScriptProperties().getProperty(DB_GROUPS); return j ? JSON.parse(j) : {}; }
function getUsers() { const j = PropertiesService.getScriptProperties().getProperty(DB_USERS); return j ? JSON.parse(j) : {}; }
function saveGroups(obj) { PropertiesService.getScriptProperties().setProperty(DB_GROUPS, JSON.stringify(obj)); }
function saveUsers(obj) { PropertiesService.getScriptProperties().setProperty(DB_USERS, JSON.stringify(obj)); }

function handleSetDefaultQuality(quality, userId, botId) {
  const users = getUsers();
  if (users[userId]) {
    users[userId].default_quality = quality;
    saveUsers(users);
    sendMsg(`Default quality set to ${quality}.`, botId);
  } else {
    sendMsg("User not found.", botId);
  }
}

function handleQualityLock(quality, botId) {
  const p = PropertiesService.getScriptProperties();
  if (quality) {
    p.setProperty('GLOBAL_QUALITY_LOCK', quality);
    sendMsg(`Global quality locked to ${quality}.`, botId);
  } else {
    p.deleteProperty('GLOBAL_QUALITY_LOCK');
    sendMsg("Global quality lock removed.", botId);
  }
}

function resolveQuality(requestedQuality, user) {
  const p = PropertiesService.getScriptProperties();
  const globalLock = p.getProperty('GLOBAL_QUALITY_LOCK');
  const userDefault = user ? user.default_quality : null;

  let quality = requestedQuality || userDefault || '480p';

  if (quality !== 'audio' && globalLock) {
    const lockVal = parseInt(globalLock);
    const qualityVal = parseInt(quality);
    if (qualityVal > lockVal) {
      quality = globalLock;
    }
  }
  return quality;
}

// ==========================================
// 2. MAIN WEBHOOK HANDLER
// ==========================================

function doPost(e) {
  try {
    const postData = JSON.parse(e.postData.contents);
    if (!postData) return ContentService.createTextOutput("OK");
    
    // --- FIXED SYSTEM EVENT HANDLER ---
    if (postData.type === 'system_event') {
      const newUrl = postData.public_url;
      const eventTitle = postData.title || "System Update"; // Fallback to prevent 'title' error
      
      if (newUrl) {
        PropertiesService.getScriptProperties().setProperty('CFG_PAGEKITE_URL', newUrl);
        logToSheet('System', eventTitle, 'Success', newUrl);
      }
      // CRITICAL: Return here so we don't try to check "isUserBanned" for a system update
      return ContentService.createTextOutput("System Event Processed");
    }
    // ----------------------------------

    const CFG = getConfig();

    // 2. HANDLE PYTHON CALLBACKS
    if (postData.type === 'python_callback') return ContentService.createTextOutput(JSON.stringify(handlePythonCallback(postData, CFG))).setMimeType(ContentService.MimeType.JSON);
    if (postData.type === 'python_sync') return ContentService.createTextOutput(JSON.stringify({ jobs: getAndClearOfflineQueue() })).setMimeType(ContentService.MimeType.JSON);

    // 3. IGNORE BOT MESSAGES
    if (postData.sender_type === 'bot') return ContentService.createTextOutput("OK"); 

    // 4. IDENTIFY SENDER
    const rawId = postData.sender_id || postData.user_id;
    if (!rawId) return ContentService.createTextOutput("OK");
    
    const senderId = String(rawId);
    const groupId = String(postData.group_id || 'dm');

    let text = (postData.text || '').trim();
    if (!text) return ContentService.createTextOutput("OK");
    let trimData = null;
    const timecodeMatch = text.match(/(\d{1,2}:\d{2})(?:-(\d{1,2}:\d{2}))?/);
    if (timecodeMatch) {
      trimData = { start: timecodeMatch[1], end: timecodeMatch[2] || null };
      text = text.replace(timecodeMatch[0], '').trim();
    }
    
    const allGroups = getGroups();
    const allUsers = getUsers();
    const currentBotId = allGroups[groupId] || CFG.DEF_BOT;
    
    // AUTO-USER DISCOVERY
    let user = allUsers[senderId];
    if (!user) {
      user = { email: CFG.DEF_EMAIL, name: postData.name || 'New User', role: 'guest', default_quality: null };
      allUsers[senderId] = user;
      saveUsers(allUsers);
      
      const adminMsg = `🆕 NEW USER DETECTED\nName: ${user.name}\nID: ${senderId}\nEmail: ${user.email}\nRole: guest\n\nTo approve: set role ${senderId} user`;
      const bots = [...new Set(Object.values(allGroups))];
      bots.forEach(bid => { sendMsg(adminMsg, bid); Utilities.sleep(200); });
    }
    
    const isOwner = (senderId === CFG.OWNER); 
    const isAdmin = (user.role === 'admin' || user.role === 'owner' || isOwner);
    let lowerText = text.toLowerCase();

    // --- BAN LOGIC ---
    if (isUserBanned(senderId)) {
      if (lowerText === 'request unban') { handleUnbanRequest(senderId, user, currentBotId); return; }
      if (isLikelyCommand(lowerText)) { sendMsg(`ACCESS DENIED\nUser: ${user.name}\nStatus: BANNED\n\nType: request unban`, currentBotId); }
      return; 
    }

    if (isMaintenanceActive() && !isAdmin) { sendMsg("SYSTEM: Under maintenance.", currentBotId); return; }

    if (text) logToSheet('Command', text, 'Received', `User: ${user.name}`);

    let requestedQuality = null;
    if (lowerText.startsWith('mp3 ') || lowerText.startsWith('audio ')) {
      requestedQuality = 'audio';
      lowerText = lowerText.replace(/^(mp3|audio)\s+/, '');
    } else {
      const qualMatch = lowerText.match(/^(\d{3,4}p)\s+/);
      if (qualMatch) {
        requestedQuality = qualMatch[1];
        lowerText = lowerText.replace(qualMatch[0], '');
      }
    }
    const targetQuality = resolveQuality(requestedQuality, user);

    // --- SMART HELP LISTENERS ---
    if (lowerText === 'search') return sendMsg("[ SEARCH HELP ]\n- search [query]\n- search channel [name]\n- search tiktok [query]\n- short [query]\n- long [query]", currentBotId);
    if (lowerText === 'sub') return sendMsg("[ SUBSCRIBE HELP ]\n1. search channel [name]\n2. sub 1 (or sub 2)", currentBotId);
    if (lowerText === 'unsub') return sendMsg("[ UNSUBSCRIBE HELP ]\nType: unsub [channel_id]\n(Use 'list subs' to find ID)", currentBotId);
    if (lowerText === 'lucky') return sendMsg("[ LUCKY HELP ]\nType: lucky [query]\n(Downloads first result)", currentBotId);
    
    if (isAdmin) {
        if (lowerText === 'add') return sendMsg("[ ADD HELP ]\nadd user [id] [email] [name] [role]\nadd group [group_id] [bot_id]", currentBotId);
        if (lowerText === 'del') return sendMsg("[ DEL HELP ]\ndel user [id]\ndel group [group_id]", currentBotId);
        if (lowerText === 'set') return sendMsg("[ SET HELP ]\nset role [id] [admin/user]\nset default [quality]\nset quota [id] [amount]", currentBotId);
        if (lowerText === 'list') return sendMsg("[ LIST HELP ]\n- list users\n- list groups\n- list subs", currentBotId);
        if (lowerText === 'ban') return sendMsg("[ BAN HELP ]\nban [user_id] [time(m,h,d)]\nunban [user_id]", currentBotId);
        if (lowerText === 'lock') return sendMsg("[ LOCK HELP ]\nlock quality [240p/360p/480p...]\nunlock quality", currentBotId);
        // --- ADDED COMMANDS ---
if (lowerText === 'check tunnel') handleTunnelCheck(currentBotId, CFG);
if (lowerText === 'update server') handleForceUpdate(currentBotId, CFG);
    }

    // --- COMMAND ROUTER ---
    
    // 1. Help & Context
    if (lowerText === 'help' || lowerText === 'sk help') handleHelp(isAdmin, isOwner, currentBotId, user.name);
    else if (lowerText === 'admin help' && isAdmin) handleAdminHelp(currentBotId);
    else if (lowerText === 'owner help' && isOwner) handleOwnerHelp(currentBotId);
    else if (lowerText === 'me' || lowerText === 'profile') handleUserProfile(senderId, user, currentBotId, CFG);
    
    // 2. Search & Download (PASSED groupId)
    else if (lowerText.startsWith('search channel ')) handleLocalChannelSearch(lowerText.replace('search channel ', '').trim(), currentBotId, groupId, CFG);
    else if (lowerText.startsWith('search tiktok ')) handleGoogleSearch(lowerText.replace('search tiktok ', ''), 'tiktok.com', currentBotId, groupId, CFG);
    else if (lowerText.startsWith('search insta ')) handleGoogleSearch(lowerText.replace('search insta ', ''), 'instagram.com', currentBotId, groupId, CFG);
    else if (lowerText.startsWith('search ')) handleVideoSearch(lowerText.substring(7).trim(), currentBotId, groupId, null, null, CFG); 
    else if (lowerText.startsWith('short ')) handleVideoSearch(lowerText.substring(6).trim(), currentBotId, groupId, null, 'short', CFG);
    else if (lowerText.startsWith('long ')) handleVideoSearch(lowerText.substring(5).trim(), currentBotId, groupId, null, 'long', CFG);
    else if (lowerText.startsWith('trending')) handleGlobalTrending(lowerText.replace('trending', '').trim() || 'US', currentBotId, groupId, CFG);
    else if (lowerText === 'surprise') handleSurpriseVideo(currentBotId, groupId, CFG);
    else if (lowerText.startsWith('lucky ')) { if (checkQuota(senderId, isAdmin, currentBotId, CFG)) handleLuckySearch(lowerText.substring(6).trim(), user.email, currentBotId, targetQuality, trimData, CFG); }
    else if (lowerText === 'next') handleNextPage(currentBotId, groupId, CFG);
    
    // 3. Selection (PASSED groupId)
    else if (lowerText.startsWith('sub ') && !lowerText.includes('http')) handleSubscribeSelection(lowerText.substring(4).trim(), currentBotId, groupId, CFG);
    else if (/^[\d\s,-]+$/.test(lowerText) || lowerText.includes('all')) { if (checkQuota(senderId, isAdmin, currentBotId, CFG)) handleDownloadSelection(lowerText, user.email, currentBotId, groupId, targetQuality, trimData, CFG); }
    
    // 4. Extras
    else if (lowerText.startsWith('set default ')) handleSetDefaultQuality(lowerText.substring(12).trim(), senderId, currentBotId);
    else if (lowerText === 'suggest') handleSmartSuggestions(currentBotId, groupId, CFG);
    else if (lowerText === 'random') handleRandomRecommendation(currentBotId, groupId, CFG);
    else if (lowerText.startsWith('save ')) handleSaveFavorite(lowerText.substring(5).trim(), senderId, currentBotId, groupId);
    else if (lowerText === 'favs') handleListFavorites(senderId, currentBotId, groupId);
    else if (lowerText.startsWith('del fav ')) handleDeleteFavorite(lowerText.substring(8).trim(), senderId, currentBotId);
    
    // Direct ID Download
    else if (lowerText.startsWith('id ')) {
      const videoIdMatch = lowerText.match(/id\s+([a-zA-Z0-9_-]{11})/);
      if (videoIdMatch) {
        const videoId = videoIdMatch[1];
        if (checkQuota(senderId, isAdmin, currentBotId, CFG)) {
          triggerPythonDownload([`https://youtu.be/${videoId}`], user.email, currentBotId, targetQuality, trimData, CFG);
        }
      } else {
        sendMsg("Invalid ID format. Use: id [11-character video ID]", currentBotId);
      }
    }
    // 5. Direct URL
    else if (text.match(/(https?:\/\/[^\s]+)/) && !lowerText.startsWith('search') && !lowerText.startsWith('sub') && !lowerText.startsWith('announce')) {
      const url = text.match(/(https?:\/\/[^\s]+)/)[0];
      if (checkQuota(senderId, isAdmin, currentBotId, CFG)) triggerPythonDownload([url], user.email, currentBotId, targetQuality, trimData, CFG);
    }
    
    // 6. Admin
    else if (isAdmin) {
      if (lowerText === 'status' || lowerText === 'sys info') handleServerStatus(currentBotId, CFG);
      if (lowerText === 'remote logs') handleViewRemoteLogs(currentBotId, CFG);
      if (lowerText === 'history') handleViewRemoteHistory(currentBotId, CFG);
      if (lowerText === 'logs') handleViewSystemLogs(currentBotId);
      if (lowerText === 'files') handleListRemoteFiles(currentBotId, CFG);
      if (lowerText.startsWith('delete file ')) handleRemoteDeleteFile(lowerText.replace('delete file ', '').trim(), currentBotId, CFG);

      if (lowerText === 'users' || lowerText === 'list users' || lowerText === 'list all users') handleListUsers(currentBotId);
      if (lowerText === 'groups' || lowerText === 'list groups' || lowerText === 'list all groups') handleListGroups(currentBotId);
      
      if (lowerText.startsWith('add user ')) handleAddUser(text, currentBotId);
      if (lowerText.startsWith('del user ')) handleDelUser(lowerText, currentBotId, CFG);
      if (lowerText.startsWith('set role ')) handleSetRole(lowerText, currentBotId, CFG);
      if (lowerText.startsWith('add group ')) handleAddGroup(text, currentBotId);
      if (lowerText.startsWith('del group ')) handleDelGroup(lowerText, currentBotId);
      
      if (lowerText.startsWith('check quota ')) handleCheckQuota(lowerText, currentBotId, CFG);
      if (lowerText.startsWith('reset quota ')) handleResetQuota(lowerText, currentBotId, CFG);
      if (lowerText.startsWith('set quota ')) handleSetQuota(lowerText, currentBotId, CFG);

      if (lowerText === 'flush') sendPythonCommand('/force_send', {}, 'Flush Queue', currentBotId, CFG);
      if (lowerText === 'clean') sendPythonCommand('/actions/clear_queue', {}, 'Clear Queue', currentBotId, CFG);
      if (lowerText === 'check subs') sendPythonCommand('/actions/check_subs', {}, 'Check Subs', currentBotId, CFG);
      
      if (lowerText === 'subs') handleSubList(currentBotId, CFG);
      if (lowerText.startsWith('sub http')) handleSubscribeDirect(text.match(/(https?:\/\/[^\s]+)/)[0], currentBotId, CFG);
      if (lowerText.startsWith('unsub ')) handleUnsubscribe(lowerText, currentBotId, CFG);
      
      if (lowerText.startsWith('ban ')) handleBanUser(lowerText.replace('ban ', '').trim(), currentBotId, CFG);
      if (lowerText.startsWith('unban ')) handleUnbanUser(lowerText.replace('unban ', '').trim(), currentBotId);
      if (lowerText.startsWith('lock quality ')) handleQualityLock(lowerText.substring(13).trim(), currentBotId);
      if (lowerText === 'unlock quality') handleQualityLock(null, currentBotId);
      
      if (lowerText.startsWith('maint ')) handleMaintenanceToggle(lowerText, currentBotId);
      
      if (lowerText.startsWith('announce ')) {
        const msg = text.substring(9).trim();
        const bots = [...new Set(Object.values(getGroups()))];
        bots.forEach(bid => { sendMsg(`ANNOUNCEMENT\n${msg}\n\n- ${user.name}`, bid); Utilities.sleep(200); });
      }
      
      if (lowerText === 'reports') handleViewReports(currentBotId);
      if (lowerText === 'clear reports') handleClearReports(currentBotId);
    }

  } catch (err) {
    logToSheet('System Error', err.message, 'Failure', err.stack);
  }
  return ContentService.createTextOutput("OK");
}

// ==========================================
// 4. MANAGEMENT HANDLERS
// ==========================================

function isLikelyCommand(t) {
  return t.match(/^(search|lucky|short|long|trending|surprise|sub|unsub|http|mp3|help|me|profile|suggest|random|favs|save|del|list|add|set|reset|ban|unban|flush|clean|check|status|logs|history|announce|[\d, -]+$|all$)/);
}

function handleUnbanRequest(uid, user, botId) {
  sendMsg("REQUEST SENT.\nAdmins have been notified.", botId);
  const groups = getGroups();
  const bots = [...new Set(Object.values(groups))];
  const msg = `🚨 UNBAN REQUEST\nName: ${user.name}\nID: ${uid}\nEmail: ${user.email}\nTo unban: type 'unban ${uid}'`;
  bots.forEach(bid => { sendMsg(msg, bid); Utilities.sleep(200); });
}

function handleListUsers(botId) {
  const u = getUsers();
  let m = "REGISTERED USERS:\n";
  Object.keys(u).forEach(id => {
    let icon = "[User]";
    if (u[id].role === 'owner') icon = "[OWNER]";
    else if (u[id].role === 'admin') icon = "[ADMIN]";
    m += `\n${icon} ${u[id].name} (${u[id].role})\nID: ${id}\nEmail: ${u[id].email}`;
  });
  sendMsg(m, botId);
}

function handleAddUser(text, botId) {
  const parts = text.split(' ');
  if (parts.length < 6) { sendMsg("ERROR: Missing info.\nFormat: add user [id] [email] [name] [role]", botId); return; }
  const u = getUsers();
  u[parts[2]] = { email: parts[3], name: parts[4], role: parts[5].toLowerCase(), default_quality: null };
  saveUsers(u);
  sendMsg(`USER ADDED:\nName: ${parts[4]}\nRole: ${parts[5]}`, botId);
}

function handleSetRole(text, botId, CFG) {
  const parts = text.split(' ');
  if (parts.length < 4) { sendMsg("ERROR: Missing info.\nFormat: set role [id] [admin/user]", botId); return; }
  const targetId = parts[2];
  const newRole = parts[3].toLowerCase();
  
  if (targetId === CFG.OWNER) { sendMsg("ERROR: Cannot change Owner role.", botId); return; }
  const u = getUsers();
  if (u[targetId]) {
    u[targetId].role = newRole;
    saveUsers(u);
    sendMsg(`ROLE UPDATED:\nUser: ${u[targetId].name}\nNew Role: ${newRole.toUpperCase()}`, botId);
  } else { sendMsg("ERROR: User ID not found.", botId); }
}

function handleDelUser(text, botId, CFG) {
  const id = text.replace('del user ', '').trim();
  if (id === CFG.OWNER) { sendMsg("ERROR: Cannot delete Owner.", botId); return; }
  const u = getUsers();
  if (u[id]) { delete u[id]; saveUsers(u); sendMsg(`DELETED User ID: ${id}`, botId); } 
  else { sendMsg("ERROR: User ID not found.", botId); }
}

function handleListGroups(botId) {
  const g = getGroups();
  let m = "MAPPED GROUPS:\n";
  Object.keys(g).forEach(gid => m += `\nGroup ID: ${gid}\nBot ID: ${g[gid]}\n`);
  sendMsg(m, botId);
}

function handleAddGroup(text, botId) {
  const parts = text.split(' ');
  if (parts.length < 4) { sendMsg("ERROR: Format is add group [GroupID] [BotID]", botId); return; }
  const g = getGroups();
  g[parts[2]] = parts[3];
  saveGroups(g);
  sendMsg(`MAPPED Group ${parts[2]}`, botId);
}

function handleDelGroup(text, botId) {
  const gid = text.replace('del group ', '').trim();
  const g = getGroups();
  if (g[gid]) { delete g[gid]; saveGroups(g); sendMsg(`UNMAPPED Group ${gid}`, botId); } 
  else { sendMsg("ERROR: Group ID not found.", botId); }
}

function handleCheckQuota(text, botId, CFG) {
  const targetId = text.replace('check quota ', '').trim();
  if (!targetId) return sendMsg("ERROR: Format is check quota [User_ID]", botId);
  const u = getUsers()[targetId];
  const name = u ? u.name : "Unknown";
  const prop = PropertiesService.getScriptProperties().getProperty(QUOTA_KEY_PREFIX + targetId);
  let data = prop ? JSON.parse(prop) : { count: 0, date: '' };
  if (data.date !== new Date().toDateString()) data.count = 0;
  sendMsg(`QUOTA STATUS: ${name}\nUsed: ${data.count} / ${CFG.LIMIT}\nDate: ${new Date().toDateString()}`, botId);
}

function handleResetQuota(text, botId, CFG) {
  const targetId = text.replace('reset quota ', '').trim();
  const resetData = { date: new Date().toDateString(), count: 0 };
  PropertiesService.getScriptProperties().setProperty(QUOTA_KEY_PREFIX + targetId, JSON.stringify(resetData));
  sendMsg(`QUOTA RESET: 0 for ID: ${targetId}`, botId);
}

function handleSetQuota(text, botId, CFG) {
  const parts = text.split(' ');
  const targetId = parts[2];
  const amount = parseInt(parts[3]);
  if (!targetId || isNaN(amount)) return sendMsg("ERROR: Format is set quota [id] [amount]", botId);
  PropertiesService.getScriptProperties().setProperty(QUOTA_KEY_PREFIX + targetId, JSON.stringify({ date: new Date().toDateString(), count: amount }));
  sendMsg(`QUOTA SET: ${amount} for ID: ${targetId}`, botId);
}

function handleBanUser(command, botId, CFG) {
  const parts = command.split(' ');
  const targetId = parts[0];
  const durationStr = parts[1]; // e.g., "5m", "1h", "2d"

  if (!targetId) return;
  if (targetId === CFG.OWNER) { sendMsg("ERROR: Cannot ban Owner.", botId); return; }

  const u = getUsers()[targetId];
  const name = u ? u.name : "Unknown";
  const props = PropertiesService.getScriptProperties();
  const banList = JSON.parse(props.getProperty(BANNED_USERS_KEY) || '{}');

  let expiration = 0; // Permanent ban
  if (durationStr) {
    const durationMatch = durationStr.match(/^(\d+)([mhd])$/);
    if (durationMatch) {
      const value = parseInt(durationMatch[1]);
      const unit = durationMatch[2];
      const now = new Date().getTime();
      if (unit === 'm') expiration = now + value * 60 * 1000;
      if (unit === 'h') expiration = now + value * 60 * 60 * 1000;
      if (unit === 'd') expiration = now + value * 24 * 60 * 60 * 1000;
    }
  }

  banList[targetId] = expiration;
  props.setProperty(BANNED_USERS_KEY, JSON.stringify(banList));
  
  const banType = expiration === 0 ? "permanently" : `until ${new Date(expiration).toLocaleString()}`;
  sendMsg(`USER BANNED\nName: ${name}\nID: ${targetId}\nBan: ${banType}`, botId);
}

function handleUnbanUser(targetId, botId) {
  if(!targetId) return;
  const u = getUsers()[targetId];
  const name = u ? u.name : "Unknown";
  const props = PropertiesService.getScriptProperties();
  const banList = JSON.parse(props.getProperty(BANNED_USERS_KEY) || '{}');
  
  if (banList.hasOwnProperty(targetId)) {
    delete banList[targetId];
    props.setProperty(BANNED_USERS_KEY, JSON.stringify(banList));
    sendMsg(`USER UNBANNED\nName: ${name}\nID: ${targetId}`, botId);
  } else { sendMsg(`ERROR: User ID not found in ban list.`, botId); }
}

// ==========================================
// 5. PYTHON INTERACTION
// ==========================================

function sendPythonCommand(endpoint, payload, actionName, botId, CFG) {
  try {
    const options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true };
    const response = UrlFetchApp.fetch(`${CFG.PAGEKITE}${endpoint}`, options);
    if (response.getResponseCode() === 200) {
      logToSheet('API Request', actionName, 'Success', 'Sent to PageKite');
      sendMsg(`DONE: ${actionName}`, botId);
    } else { throw new Error(`Server ${response.getResponseCode()}`); }
  } catch (e) {
    let offlinePayload = { type: 'command', endpoint: endpoint, payload: payload };
    if (e.message.includes("Service invoked too many times")) {
      offlinePayload.notification_on_complete = `UrlFetchApp quota exceeded. Your command "${actionName}" has been queued.`;
    } else {
      sendMsg(`OFFLINE: "${actionName}" queued.`, botId);
    }
    saveToOfflineQueue(offlinePayload);
    logToSheet('UrlFetchApp Error', actionName, 'Queued (Offline)', e.message);
  }
}

function triggerPythonDownload(urls, email, botId, quality, trim, CFG) {
  const payload = {
    url: urls,
    email: email,
    bot_id: botId,
    quality: quality || '480p',
    trim: trim
  };
  try {
    const response = UrlFetchApp.fetch(`${CFG.PAGEKITE}/get_link`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) {
      logToSheet('Download Request', `Sent ${urls.length} items`, 'Success', 'Handed to Python');
    } else {
      throw new Error(`Server Error: ${response.getResponseCode()}`);
    }
  } catch (e) {
    let offlinePayload = { type: 'download', ...payload };
    if (e.message.includes("Service invoked too many times")) {
      offlinePayload.notification_on_complete = "UrlFetchApp quota exceeded for the day. Your download has been queued and will be processed shortly.";
    } else {
      sendMsg("OFFLINE: Download Queued.", botId);
    }
    saveToOfflineQueue(offlinePayload);
    logToSheet('UrlFetchApp Error', urls.join(','), 'Queued (Offline)', e.message);
  }
}

function handlePythonCallback(d, CFG) {
  const title = d.title || 'Video';
  const userEmail = d.email || CFG.DEF_EMAIL;
  if (d.status === 'failed') { logToSheet('Download Failed', title, 'Error', d.error); } 
  else {
    logToSheet('Delivery Success', title, 'Success', `To: ${userEmail}`);
    if (d.part_index === 1 || !d.part_index) addToHistory(title, userEmail);
  }
  return { status: "ok", jobs: getAndClearOfflineQueue() };
}

// ==========================================
// 6. LOCAL SEARCH & UTILS (ISOLATED CONTEXT)
// ==========================================

function handleLocalChannelSearch(query, botId, groupId, CFG) {
  try {
    const results = YouTube.Search.list('snippet', { q: query, maxResults: 5, type: 'channel' });
    if (!results.items || results.items.length === 0) { sendMsg("No channels found.", botId); return; }
    const items = results.items.map(i => ({ title: i.snippet.title, id: i.id.channelId }));
    let msg = `CHANNEL RESULTS:\n`;
    items.forEach((item, i) => msg += `\n${i + 1}. ${item.title}`);
    msg += `\n\nType 'sub 1' to subscribe.`;
    
    // NEW: Save with group-specific key
    const keys = getContextKeys(groupId);
    PropertiesService.getScriptProperties().setProperty(keys.CHANNEL, JSON.stringify(items));
    sendMsg(msg, botId);
  } catch (e) { sendMsg("Search Error (Check API).", botId); }
}

function handleSubscribeSelection(indexStr, botId, groupId, CFG) {
  const props = PropertiesService.getScriptProperties();
  const keys = getContextKeys(groupId);
  const storedData = props.getProperty(keys.CHANNEL);
  
  if (!storedData) { sendMsg("Search for a channel first.", botId); return; }
  const results = JSON.parse(storedData);
  const index = parseInt(indexStr) - 1;
  if (results[index]) { sendPythonCommand('/api/subscribe', { channel_id: results[index].id }, `Sub: ${results[index].title}`, botId, CFG); } 
  else { sendMsg("Invalid number.", botId); }
}

function handleVideoSearch(query, botId, groupId, pageToken, durationFilter, CFG) {
  try {
    const searchOpts = { q: query, maxResults: durationFilter ? 20 : CFG.MAX_RES, type: 'video' };
    if (pageToken) searchOpts.pageToken = pageToken;
    const searchRes = YouTube.Search.list('snippet', searchOpts);
    let items = searchRes.items;
    
    if (durationFilter) {
      const videoIds = items.map(i => i.id.videoId).join(',');
      const videoRes = YouTube.Videos.list('contentDetails,snippet', { id: videoIds });
      items = videoRes.items.filter(v => {
        const s = parseIsoDuration(v.contentDetails.duration);
        return durationFilter === 'short' ? s < 420 : s > 900;
      }).slice(0, CFG.MAX_RES).map(v => ({ id: { videoId: v.id }, snippet: { title: v.snippet.title } }));
    }

    const results = items.filter(i => i.id && i.id.videoId).map(i => ({ title: i.snippet.title, id: i.id.videoId }));
    if (!results.length) { sendMsg(`No videos found.`, botId); return; }
    
    let msg = pageToken ? `NEXT: "${query}"\n` : `RESULTS: "${query}"${durationFilter ? ' ('+durationFilter+')' : ''}\n`;
    results.forEach((v, i) => msg += `\n${i+1}. ${v.title}`);
    
    // NEW: Save with group-specific key
    const keys = getContextKeys(groupId);
    const props = PropertiesService.getScriptProperties();
    props.setProperty(keys.SEARCH, JSON.stringify(results));
    props.setProperty(keys.QUERY, query);
    props.setProperty(keys.TOKEN, searchRes.nextPageToken || '');
    sendMsg(msg, botId);
  } catch (e) { sendMsg("Search failed (Quota?).", botId); }
}

function handleGlobalTrending(r, botId, groupId, CFG){
  try {
    const c=r.toUpperCase().substring(0,2);
    const x=YouTube.Videos.list('snippet',{chart:'mostPopular',regionCode:c,maxResults:CFG.MAX_RES});
    if(!x.items||!x.items.length){sendMsg(`No data "${c}".`,botId);return;}
    const z=x.items.map(i=>({title:i.snippet.title,id:i.id}));
    let m=`TRENDING ${c}:\n`;
    z.forEach((v,i)=>m+=`\n${i+1}. ${v.title}`);
    
    const keys = getContextKeys(groupId);
    PropertiesService.getScriptProperties().setProperty(keys.SEARCH,JSON.stringify(z));
    sendMsg(m,botId);
  } catch(e){sendMsg("Error (Try US, UK)",botId);}
}

function handleSurpriseVideo(botId, groupId, CFG){
  const p=['IMG_','DSC_','MVI_','VID_'];
  const q=`${p[Math.floor(Math.random()*p.length)]}${Math.floor(Math.random()*9000)+1000}`;
  sendMsg(`SURPRISE: "${q}"`,botId);
  handleVideoSearch(q,botId,groupId,null,null, CFG);
}

function parseIsoDuration(d){const m=d.match(/PT(\d+H)?(\d+M)?(\d+S)?/);return (parseInt(m[1]||0)*3600)+(parseInt(m[2]||0)*60)+parseInt(m[3]||0);}

function handleDownloadSelection(choice, userEmail, botId, groupId, quality, trimData, CFG) {
  try {
    const props = PropertiesService.getScriptProperties();
    const keys = getContextKeys(groupId); // NEW: Use group keys
    const storedData = props.getProperty(keys.SEARCH);
    
    if (!storedData) { sendMsg("Search active.", botId); return; }
    const results = JSON.parse(storedData);
    let indexes = [];
    if (choice.includes('all')) { indexes = results.map((_, i) => i); } 
    else { choice.split(',').forEach(part => { if (part.includes('-')) { const [start, end] = part.split('-').map(x => parseInt(x.trim())); if (!isNaN(start) && !isNaN(end)) { for (let i = start; i <= end; i++) indexes.push(i - 1); } } else { const n = parseInt(part.trim()); if (!isNaN(n)) indexes.push(n - 1); } }); }

    const urls = indexes.map(i => {
      const item = results[i];
      if (!item) return null;
      const id = String(item.id || item.link || item.videoId || '').trim();
      if (!id) return null;
      return id.startsWith('http') ? id : `https://youtu.be/${id}`;
    }).filter(Boolean);

    if (urls.length > 0) {
      logToSheet('Selection Success', `Queuing ${urls.length}`, 'Processing', urls.join(', '));
      sendMsg(`Queuing ${urls.length} items...`, botId);
      triggerPythonDownload(urls, userEmail, botId, quality, trimData, CFG);
    } else { sendMsg("Invalid selection.", botId); }
  } catch(e) { sendMsg("Error: " + e.message, botId); logToSheet('Selection Critical', choice, 'Crash', e.stack); }
}

function handleSaveFavorite(x,u,b,groupId){
  const props=PropertiesService.getScriptProperties();
  const keys = getContextKeys(groupId);
  const s=props.getProperty(keys.SEARCH); // NEW: Use group keys
  if(!s)return sendMsg("Search first",b);
  const r=JSON.parse(s);const i=parseInt(x)-1;if(!r[i])return sendMsg("Invalid",b);const k=FAVORITES_PREFIX+u;let f=JSON.parse(props.getProperty(k)||'[]');if(f.some(v=>v.title===r[i].title))return sendMsg("Exists",b);f.push(r[i]);props.setProperty(k,JSON.stringify(f));sendMsg(`Saved "${r[i].title}"`,b);
}

function handleNextPage(b,groupId,CFG){
  const props=PropertiesService.getScriptProperties();
  const keys = getContextKeys(groupId);
  const q=props.getProperty(keys.QUERY);
  const t=props.getProperty(keys.TOKEN);
  if(!q||!t)return sendMsg("No next",b);
  handleVideoSearch(q,b,groupId,t,null,CFG);
}

// ==========================================
// 7. QUEUE & UTILS
// ==========================================

function saveToOfflineQueue(data) {
  try {
    const props = PropertiesService.getScriptProperties();
    let id = props.getProperty(SPREADSHEET_ID_KEY);
    if (!id) { id = SpreadsheetApp.create("VideoBot_Logs").getId(); props.setProperty(SPREADSHEET_ID_KEY, id); }
    const ss = SpreadsheetApp.openById(id);
    let sheet = ss.getSheetByName(OFFLINE_QUEUE_SHEET);
    if (!sheet) sheet = ss.insertSheet(OFFLINE_QUEUE_SHEET);
    sheet.appendRow([new Date(), JSON.stringify(data)]);
  } catch(e){}
}

function getAndClearOfflineQueue() {
  try {
    const id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_KEY);
    if (!id) return [];
    const sheet = SpreadsheetApp.openById(id).getSheetByName(OFFLINE_QUEUE_SHEET);
    if (!sheet) return [];
    const rows = sheet.getDataRange().getValues();
    if (rows.length === 0) return [];
    const jobs = [];
    for (let i = 0; i < rows.length; i++) { try { jobs.push(JSON.parse(rows[i][1])); } catch(e){} }
    sheet.clear();
    return jobs;
  } catch(e) { return []; }
}

function logToSheet(action, details, status, error) {
  try {
    const props = PropertiesService.getScriptProperties();
    let id = props.getProperty(SPREADSHEET_ID_KEY);
    if (!id) {
      const ss = SpreadsheetApp.create("VideoBot_Logs");
      id = ss.getId();
      props.setProperty(SPREADSHEET_ID_KEY, id);
      ss.getSheets()[0].appendRow(["Timestamp", "Action", "Details", "Status", "Error"]);
    }
    const ss = SpreadsheetApp.openById(id);
    ss.getSheets()[0].appendRow([new Date(), action, details, status, error || '']);
  } catch(e) { console.log("Logger Error: " + e.message); }
}

function sendMsg(t,b){try{UrlFetchApp.fetch('https://api.groupme.com/v3/bots/post',{method:'post',contentType:'application/json',payload:JSON.stringify({bot_id:b,text:t})});}catch(e){logToSheet('UrlFetchApp Error', 'Failed to send GroupMe message', 'Failure', e.message);}}

function handleHelp(isAdmin, isOwner, botId, name) {
  let m = `Hi ${name}!\n\n`;
  m += `SEARCH\n- search [query]\n- id [video_id]\n- short / long [query]\n- search channel [name]\n\n`;
  m += `DOWNLOAD & OPTIONS\n- 1, all, 1-3\n- lucky [query]\n- [query] 0:30-1:00 (Trim)\n- 720p [query] (Quality)\n\n`;
  m += `USER SETTINGS\n- set default [quality]\n- profile | me\n- favs | save 1 (Select favs by #)\n`;
  if(isAdmin || isOwner) {
    m += `\nADMIN\n- status, logs, history, files\n- users, groups\n- add, del, set, ban\n(Type 'admin help' for commands)`;
  }
  if(isOwner) m += `\nOWNER\n(Type 'owner help')`;
  sendMsg(m, botId);
}

function handleAdminHelp(botId) {
  let m = "[ ADMIN COMMANDS ]\n\n";
  m += "USERS & BANS\n- list users | ban [id] [time]\n- set role [id] user (Approve Guest)\n- add user [id] [email] [name] [role]\n\n";
  m += "FILES & SYSTEM\n- files (List server files)\n- delete file [name]\n- lock quality [480p]\n- status, logs, history\n- flush | clean";
  sendMsg(m, botId);
}

function handleOwnerHelp(botId) {
  let m = "[ OWNER COMMANDS ]\n\n";
  m += "- set role [id] [admin/user]\n  (Promote/Demote users)\n\n";
  m += "- maint on / maint off\n  (Lock bot for maintenance)\n\n";
  m += "- clean\n  (Wipe server queue)\n\n";
  m += "- clear reports\n  (Delete user reports)";
  sendMsg(m, botId);
}

function checkQuota(u,a,b,CFG){if(a)return true;const k=QUOTA_KEY_PREFIX+u;let d=JSON.parse(PropertiesService.getScriptProperties().getProperty(k)||'{}');if(d.date!==new Date().toDateString())d={date:new Date().toDateString(),count:0};if(d.count>=CFG.LIMIT){sendMsg(`Limit Reached (${CFG.LIMIT}/day).`,b);return false;}d.count++;PropertiesService.getScriptProperties().setProperty(k,JSON.stringify(d));return true;}
function addToHistory(t,e){const p=PropertiesService.getScriptProperties();let h=JSON.parse(p.getProperty(HISTORY_LOG_KEY)||'[]');h.unshift({title:t,user:e,date:new Date()});if(h.length>20)h=h.slice(0,20);p.setProperty(HISTORY_LOG_KEY,JSON.stringify(h));}
function handleSmartSuggestions(b,groupId,CFG){
  const props = PropertiesService.getScriptProperties();
  const h=JSON.parse(props.getProperty(HISTORY_LOG_KEY)||'[]');
  if(!h.length)return handleVideoSearch("trending",b,groupId,null,null,CFG);
  const w=h[0].title.split(' ')[0];
  handleVideoSearch(`best ${w} content`,b,groupId,null,null,CFG);
}

function handleRandomRecommendation(b,groupId,CFG){
  const props = PropertiesService.getScriptProperties();
  const h=JSON.parse(props.getProperty(HISTORY_LOG_KEY)||'[]');
  if(!h.length)return handleVideoSearch("trending",b,groupId,null,null,CFG);
  const r=h[Math.floor(Math.random()*h.length)];
  sendMsg(`Like "${r.title}"?`,b);
  handleVideoSearch(`similar to ${r.title}`,b,groupId,null,null,CFG);
}

function handleServerStatus(b,CFG){
  try {
    const r = UrlFetchApp.fetch(`${CFG.PAGEKITE}/api/status`, {muteHttpExceptions: true});
    const d = JSON.parse(r.getContentText());
    let msg = `SYSTEM ONLINE\n`;
    msg += `Litterbox: ${d.clouds?.Litterbox} | SMTP: ${d.clouds?.SMTP}\n`;
    msg += `CPU: ${d.sys.cpu}% | RAM: ${d.sys.ram}%\n`;
    msg += `Queue: ${d.queue.length} items | Disk: ${d.sys.disk_free}GB\n`;
    sendMsg(msg, b);
  } catch (e) { sendMsg("OFFLINE (Status Unavailable)", b); logToSheet('UrlFetchApp Error', 'Failed to get server status', 'Failure', e.message); }
}

function handleViewRemoteLogs(botId, CFG) {
  try {
    const response = UrlFetchApp.fetch(`${CFG.PAGEKITE}/api/status`, {muteHttpExceptions: true});
    const data = JSON.parse(response.getContentText());
    if (!data.logs) { sendMsg("No logs.", botId); return; }
    const logLines = data.logs.split('\n').filter(line => line.trim() !== '');
    const msg = `SERVER CONSOLE (Last 15):\n\n${logLines.slice(-15).join('\n')}`;
    sendMsg(msg.length > 900 ? msg.substring(0, 900) + "..." : msg, botId);
  } catch (e) { sendMsg("Error fetching logs: " + e.message, botId); logToSheet('UrlFetchApp Error', 'Failed to get remote logs', 'Failure', e.message); }
}

function handleViewRemoteHistory(botId, CFG) {
  try {
    const response = UrlFetchApp.fetch(`${CFG.PAGEKITE}/api/status`, {muteHttpExceptions: true});
    const data = JSON.parse(response.getContentText());
    if (!data.history || !data.history.length) { sendMsg("Empty History.", botId); return; }
    let msg = "REMOTE HISTORY:\n";
    data.history.slice(0, 12).forEach((item) => {
      let icon = item.status === 'failed' ? '[X]' : '[OK]';
      const timeStr = new Date(item.timestamp * 1000).toLocaleTimeString('en-US', {hour: '2-digit', minute:'2-digit'});
      msg += `\n${icon} [${timeStr}] ${item.title ? item.title.substring(0, 20) : 'Unknown'}`;
      if (item.status === 'failed' && item.error) msg += `\n   - Error: ${item.error}`;
    });
    sendMsg(msg, botId);
  } catch (e) { sendMsg("Error fetching history: " + e.message, botId); logToSheet('UrlFetchApp Error', 'Failed to get remote history', 'Failure', e.message); }
}

function handleSubscribeDirect(u,b,CFG){sendPythonCommand('/api/subscribe',{channel_id:u},'Direct Sub',b,CFG);}
function handleUnsubscribe(t,b,CFG){sendPythonCommand('/api/unsubscribe',{channel_id:t.replace('unsub ','').trim()},'Unsub',b,CFG);}
function handleSubList(b,CFG){try{const r=UrlFetchApp.fetch(`${CFG.PAGEKITE}/api/status`);const d=JSON.parse(r.getContentText());const s=d.subscriptions||{};let m="SUBSCRIPTIONS:\n";Object.keys(s).forEach(k=>m+=`\n${s[k].name||k}`);sendMsg(m,b);}catch(e){sendMsg("Offline - Cannot list subs",b); logToSheet('UrlFetchApp Error', 'Failed to list subs', 'Failure', e.message);}}
function handleViewHistory(b){const h=JSON.parse(PropertiesService.getScriptProperties().getProperty(HISTORY_LOG_KEY)||'[]');let m="HISTORY:\n";h.forEach((x,i)=>m+=`${i+1}. ${x.title}\n`);sendMsg(m,b);}

function isUserBanned(userId) {
  // 1. HARD SAFETY CHECK: If ID is missing or is the string "undefined", they are not a banned user.
  if (!userId || userId === 'undefined' || userId === 'null') return false;

  try {
    const props = PropertiesService.getScriptProperties();
    const jsonStr = props.getProperty('banned_user_ids');

    if (!jsonStr) return false;

    const banList = JSON.parse(jsonStr);
    const uid = String(userId);

    if (Array.isArray(banList)) {
      return banList.indexOf(uid) !== -1;
    } else {
      const banInfo = banList[uid];
      if (banInfo === undefined) return false;
      if (banInfo === 0) return true; // Permanent

      const now = new Date().getTime();
      if (now > banInfo) {
        // Ban expired, clean it up
        delete banList[uid];
        props.setProperty('banned_user_ids', JSON.stringify(banList));
        return false;
      }
      return true;
    }
  } catch (e) {
    console.error("Ban Check Error: " + e.message);
    return false; // Fail open to prevent bot crash
  }
}

function handleMaintenanceToggle(c,b){ const isOn = c.includes('on'); PropertiesService.getScriptProperties().setProperty(MAINT_MODE_KEY, isOn?'true':'false'); sendMsg(isOn?"MAINT ON":"MAINT OFF",b); logToSheet('Admin', 'Maintenance Toggle', 'Success', `Set to: ${isOn}`); }
function isMaintenanceActive(){return PropertiesService.getScriptProperties().getProperty(MAINT_MODE_KEY)==='true';}
function handleUserProfile(u,o,b,CFG){const p=PropertiesService.getScriptProperties();const k=QUOTA_KEY_PREFIX+u;const d=JSON.parse(p.getProperty(k)||'{"count":0}');const r=CFG.LIMIT-(d.date===new Date().toDateString()?d.count:0);sendMsg(`USER: ${o.name}\nRole: ${o.role.toUpperCase()}\nQuota: ${r} left`,b);}
function handleViewReports(b){const r=JSON.parse(PropertiesService.getScriptProperties().getProperty(REPORTS_KEY)||'[]');if(!r.length){sendMsg("None.",b);return;}let m="REPORTS:\n";r.forEach((x,i)=>m+=`\n${i+1}. ${x.msg} (${x.user})`);sendMsg(m,b);}
function handleClearReports(b){PropertiesService.getScriptProperties().deleteProperty(REPORTS_KEY);sendMsg("Cleared.",b);}
function handleSaveFavorite(x,u,b,groupId){
  const props=PropertiesService.getScriptProperties();
  const keys = getContextKeys(groupId);
  const s=props.getProperty(keys.SEARCH);
  if(!s)return sendMsg("Search first",b);
  const r=JSON.parse(s);const i=parseInt(x)-1;if(!r[i])return sendMsg("Invalid",b);const k=FAVORITES_PREFIX+u;let f=JSON.parse(props.getProperty(k)||'[]');if(f.some(v=>v.title===r[i].title))return sendMsg("Exists",b);f.push(r[i]);props.setProperty(k,JSON.stringify(f));sendMsg(`Saved "${r[i].title}"`,b);
}

function handleListFavorites(u,b,groupId){
  const props=PropertiesService.getScriptProperties();
  const f=JSON.parse(props.getProperty(FAVORITES_PREFIX+u)||'[]');
  if(!f.length)return sendMsg("No favs",b);
  let m="FAVORITES:\n";
  f.forEach((v,i)=>m+=`\n${i+1}. ${v.title}`);
  const keys = getContextKeys(groupId);
  props.setProperty(keys.SEARCH,JSON.stringify(f));
  sendMsg(m,b);
}

function handleListRemoteFiles(botId, CFG) {
  try {
    const r = UrlFetchApp.fetch(`${CFG.PAGEKITE}/api/files`);
    const files = JSON.parse(r.getContentText());
    if (!files.length) return sendMsg("No files found on server.", botId);
    let msg = "SERVER FILES:\n";
    files.forEach((f, i) => msg += `\n${i+1}. ${f.name} (${f.size} MB)`);
    sendMsg(msg, botId);
  } catch (e) { sendMsg("Error fetching files.", botId); }
}

function handleRemoteDeleteFile(filename, botId, CFG) {
  if (!filename) return sendMsg("Specify filename.", botId);
  sendPythonCommand('/api/delete_file', { filename: filename }, `Delete: ${filename}`, botId, CFG);
}
function handleDeleteFavorite(x,u,b){const k=FAVORITES_PREFIX+u;const p=PropertiesService.getScriptProperties();let f=JSON.parse(p.getProperty(k)||'[]');const i=parseInt(x)-1;if(!f[i])return;f.splice(i,1);p.setProperty(k,JSON.stringify(f));sendMsg("Deleted.",b);}
function handleGoogleSearch(query, site, botId, groupId, CFG) {
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${CFG.API_KEY}&cx=${CFG.CX_ID}&q=${encodeURIComponent("site:"+site+" "+query)}&num=${CFG.MAX_RES}`;
    const res = JSON.parse(UrlFetchApp.fetch(url).getContentText());
    const items = res.items.map(i => ({ title: i.title, id: i.link }));
    let msg = `SEARCH RESULTS:\n`;
    items.forEach((item, i) => msg += `${i + 1}. ${item.title}\n`);
    
    // SAVE CONTEXT
    const keys = getContextKeys(groupId);
    PropertiesService.getScriptProperties().setProperty(keys.SEARCH, JSON.stringify(items));
    sendMsg(msg, botId);
  } catch(e) { sendMsg("Google Search Failed.", botId); }
}
function handleViewSystemLogs(botId) {
  try {
    const id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_KEY);
    if (!id) { sendMsg("No Log Sheet found yet.", botId); return; }
    const sheet = SpreadsheetApp.openById(id).getSheets()[0];
    const lastRow = sheet.getLastRow();
    if (lastRow === 0) { sendMsg("Logs are empty.", botId); return; }
    const startRow = Math.max(1, lastRow - 9);
    const numRows = lastRow - startRow + 1;
    const data = sheet.getRange(startRow, 1, numRows, 5).getValues();
    let msg = "SHEET LOGS (Last 10):\n";
    data.forEach(row => {
      let timeStr = "N/A";
      try { timeStr = new Date(row[0]).toLocaleTimeString('en-US', {hour: '2-digit', minute:'2-digit'}); } catch(e){}
      const action = row[1] || '?';
      const status = row[3] || '?';
      const icon = (status === 'Success') ? '[OK]' : (status === 'Failure' || status === 'Error') ? '[X]' : '[i]';
      msg += `\n${icon} [${timeStr}] ${action}`;
    });
    sendMsg(msg, botId);
  } catch (e) {
    sendMsg("Error reading logs: " + e.message, botId);
  }
}
function handleLuckySearch(q,e,b,l,t,CFG){try{const r=YouTube.Search.list('snippet',{q:q,maxResults:1,type:'video'});if(r.items.length){const i=r.items[0];sendMsg(`LUCKY: "${i.snippet.title}"`,b);triggerPythonDownload([`https://youtu.be/${i.id.videoId}`],e,b,l,t,CFG);}else sendMsg("None",b);}catch(x){sendMsg("Err",b);}}

/**
 * Asks the Python server for its current Cloudflare URL.
 * If offline, this request is saved to the Offline Queue.
 */
function handleTunnelCheck(botId, CFG) {
  sendMsg("📡 Checking tunnel status...", botId);
  // This endpoint was added to the Python code in the previous step
  sendPythonCommand('/api/get_tunnel', {}, 'Tunnel URL Verification', botId, CFG);
}

/**
 * Sends a command to the server to trigger a script update or restart.
 */
function handleForceUpdate(botId, CFG) {
  sendMsg("System: Sending Force Update signal to server...", botId);
  // This assumes you have an update logic or just want to trigger a restart
  sendPythonCommand('/api/update', { action: 'git_pull' }, 'Force Server Update', botId, CFG);
}
