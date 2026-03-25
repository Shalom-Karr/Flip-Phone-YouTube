// ==========================================
// 🔐 ADMIN DASHBOARD BACKEND (v3.0 Ultimate)
// ==========================================

const ADMIN_PASS_KEY = 'ADMIN_PASSWORD';
const DEFAULT_PASS = 'admin123';

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('AdminPanel')
      .setTitle('Infinity Bot Admin')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

function checkLogin(passwordInput) {
  const props = PropertiesService.getScriptProperties();
  const savedPass = props.getProperty(ADMIN_PASS_KEY) || DEFAULT_PASS;
  return passwordInput === savedPass;
}

function getDashboardData(passwordInput) {
  if (!checkLogin(passwordInput)) throw new Error("⛔ Access Denied");

  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  
  const safeParse = (json, fallback) => {
    try { return json ? JSON.parse(json) : fallback; } catch (e) { return fallback; }
  };

  // LOGS
  let logs = [];
  try {
    const sheetId = allProps['spreadsheetId'];
    if (sheetId) {
      const sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
      const lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        const startRow = Math.max(2, lastRow - 49);
        const numRows = lastRow - startRow + 1;
        const data = sheet.getRange(startRow, 1, numRows, 5).getValues();
        logs = data.reverse().map(r => ({
          time: new Date(r[0]).toLocaleString(),
          action: r[1],
          details: r[2],
          status: r[3],
          error: r[4]
        }));
      }
    }
  } catch(e) { logs = [{time: 'Error', action: 'Fetch Failed', details: e.message, status: 'ERR'}]; }

  // CONTEXTS
  const groupContexts = {};
  Object.keys(allProps).forEach(key => {
    if (key.startsWith('last_query_')) {
      const gid = key.replace('last_query_', '');
      const displayId = gid === '_dm' ? 'Direct Message' : gid.replace('_', '');
      groupContexts[displayId] = { query: allProps[key] };
    }
  });

  return {
    config: {
      owner_id: allProps['CFG_OWNER_ID'] || '',
      api_key: allProps['CFG_GOOGLE_API_KEY'] || '',
      cx_id: allProps['CFG_GOOGLE_CX_ID'] || '',
      pagekite: allProps['CFG_PAGEKITE_URL'] || '',
      limit: allProps['CFG_DAILY_LIMIT'] || '20',
      admin_pass: allProps[ADMIN_PASS_KEY] || DEFAULT_PASS,
      whitelist_mode: allProps['CFG_WHITELIST_MODE'] === 'true' // New Setting
    },
    users: safeParse(allProps['cfg_users_db'], {}),
    bans: safeParse(allProps['banned_user_ids'], {}),
    groups: safeParse(allProps['cfg_groups_db'], {}),
    history: safeParse(allProps['global_download_history'], []),
    contexts: groupContexts,
    logs: logs
  };
}

function saveDashboardData(type, data) {
  const props = PropertiesService.getScriptProperties();
  if (type === 'users') props.setProperty('cfg_users_db', JSON.stringify(data));
  else if (type === 'bans') props.setProperty('banned_user_ids', JSON.stringify(data));
  else if (type === 'groups') props.setProperty('cfg_groups_db', JSON.stringify(data));
  else if (type === 'config') {
    props.setProperty('CFG_OWNER_ID', data.owner_id);
    props.setProperty('CFG_GOOGLE_API_KEY', data.api_key);
    props.setProperty('CFG_GOOGLE_CX_ID', data.cx_id);
    props.setProperty('CFG_PAGEKITE_URL', data.pagekite);
    props.setProperty('CFG_DAILY_LIMIT', data.limit);
    props.setProperty('CFG_WHITELIST_MODE', data.whitelist_mode.toString());
    if(data.admin_pass) props.setProperty(ADMIN_PASS_KEY, data.admin_pass);
  }
  return "Saved Successfully";
}

// --- TOOLS & ANALYTICS ---

function adminTriggerDownload(data) {
  const props = PropertiesService.getScriptProperties();
  const groups = JSON.parse(props.getProperty('cfg_groups_db') || '{}');
  const botId = groups[data.groupId] || props.getProperty('CFG_DEFAULT_BOT_ID');
  const CFG = { PAGEKITE: props.getProperty('CFG_PAGEKITE_URL') };
  triggerPythonDownload([data.url], data.email, botId, data.quality, null, CFG);
  return `Started download for ${data.email}`;
}

function adminTestSearch(query) {
  const res = YouTube.Search.list('snippet', { q: query, maxResults: 10, type: 'video' });
  return res.items.map(i => ({
    title: i.snippet.title,
    channel: i.snippet.channelTitle,
    id: i.id.videoId,
    thumb: i.snippet.thumbnails.medium.url
  }));
}

function adminBroadcast(msg) {
  const props = PropertiesService.getScriptProperties();
  const groups = JSON.parse(props.getProperty('cfg_groups_db') || '{}');
  const botIds = [...new Set(Object.values(groups))]; // Unique bots
  
  let count = 0;
  botIds.forEach(botId => {
    try {
      UrlFetchApp.fetch('https://api.groupme.com/v3/bots/post', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ bot_id: botId, text: "📢 SYSTEM ALERT:\n" + msg })
      });
      count++;
    } catch(e) {}
  });
  return `Broadcast sent to ${count} groups.`;
}

function adminGetServerHealth() {
  const props = PropertiesService.getScriptProperties();
  const pk = props.getProperty('CFG_PAGEKITE_URL');
  try {
    const r = UrlFetchApp.fetch(`${pk}/api/status`);
    const d = JSON.parse(r.getContentText());
    return {
      cpu: d.sys.cpu,
      ram: d.sys.ram,
      disk: d.sys.disk_free,
      queue: d.queue.length
    };
  } catch(e) {
    throw new Error("Server Offline");
  }
}
