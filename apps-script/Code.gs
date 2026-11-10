/**
 * Bags and Gloves — Marketing Request Desk backend (Google Apps Script web app).
 *
 * What it does
 *   GET  ?action=tasks  -> live task rows from the Tasks sheet (the dashboard polls this every ~15 s)
 *   POST (JSON)         -> a request from the dashboard form:
 *                          1. logs the full request in the "Requests" tab (private)
 *                          2. adds a task row to the Tasks tab (shows on the dashboard straight away)
 *                          3. emails the assignee, CC marketing manager + marketing@bagglove.com, BCC the whole team
 *                          4. adds an all-day event on the deadline to the assignee's Google Calendar
 *
 * Setup: see SETUP.md in this folder.
 */
const CONFIG = {
  TASKS_SHEET_ID: '11Xh4zGImypXjkDXm8GUeibSFFwUdgyKNTYzCBQnMeg8',
  TASKS_TAB: 'Tasks',            // falls back to the first tab if this name is not found
  REQUESTS_TAB: 'Requests',      // created by setup()
  TIMEZONE: 'Asia/Bangkok',
  PROJECT_NAME: 'Ad-hoc requests',

  // Always CC'd on every request email.
  MANAGER_EMAIL: 'sadanan@bagglove.com',
  ALWAYS_CC: ['marketing@bagglove.com'],
  BCC_WHOLE_TEAM: true,          // also BCC everyone listed in PEOPLE below (the assignee is the To, so is never repeated)

  // Also send the requester a short confirmation copy (separate email). Set false to turn off.
  CONFIRM_TO_REQUESTER: true,

  // Add an all-day event on the deadline to the assignee's Google Calendar (as an invited guest, no extra email).
  ADD_TO_CALENDAR: true,
  DASHBOARD_URL: 'https://natthanichalaowork-web.github.io/bags-and-gloves-dashboard/',

  // ids must match the TEAM ids in index.html
  PEOPLE: {
    nat:     { name: 'Natthanicha',     email: 'natthanicha@bagglove.com' },
    prateap: { name: 'Prateap',         email: 'prateap@bagglove.com' },
    creator: { name: 'Content Creator', email: 'marketing@bagglove.com' }   // open role: use the shared inbox until someone is hired
  },

  RATE_LIMIT_PER_HOUR: 10,       // per requester email

  // Designer Automation sheet: Tasks rows that have a "Designer ID" take their Status from it (see syncFromDesigner).
  DESIGNER_SHEET_ID: '1VZjyodbbljTgY38JZPLnzcvxsmlD-sE0BCpBxEbDaCw',
  DESIGNER_TAB: 'Communication Calendar',
  DESIGNER_SYNC_MINUTES: 15,

  // Email when a task changes status (from the dashboard or by typing in the Tasks sheet).
  // To = the assignee, CC = the manager + ALWAYS_CC. "Waiting approval" goes To the manager instead (they are the approver), CC the assignee.
  // Routine moves (To do / In progress / Review) are not emailed; edit this list to change that.
  NOTIFY_ON_STATUS: true,
  NOTIFY_STATUSES: ['Needs rework', 'Waiting approval', 'Ready', 'Done', 'Blocked', 'Waiting for info', 'On hold', 'Postponed', 'Cancelled'],

  // Live calendar feed for the dashboard (?action=calendar). Only events whose title matches a rule in CAL_RULES are
  // exposed (title, date, time, category, guest first names). Private events, descriptions, locations and guest emails never leave the calendar.
  CALENDAR_ID: 'natthanicha@bagglove.com',
  CALENDAR_OWNER_NAME: 'Natthanicha',
  CALENDAR_FROM: '2026-09-01',
  CALENDAR_DAYS_AHEAD: 150,
  DESIGNER_FROM: '2026-09-20',   // only designer rows published on/after this date are added
  DESIGNER_NOTE: 'Designer sheet ·',   // Notes prefix that marks a row created (and fully managed) by the sync
  // Designer campaign -> dashboard project name (same rules as the dashboard)
  PROJECT_NAMES: {
    anniversary: '30th Anniversary', newsletter: 'Internal newsletter — Issue 07', 'ceo-lens': "Woon's Lens — CEO branding",
    'house-brand': 'House Brand launch — Built From Real Work', d1010: '10.10 campaign', 'paid-ads': 'Paid Ads Phase 2 — Meta (Ads 13–18)',
    'line-oa': 'LINE OA broadcasts — Sep / Oct', content: 'Corporate & B2C content calendar'
  }
};

const SCRIPT_VERSION = '2026-11-10c';   // shown by ?action=health so you can tell which version is deployed
const SYNC_BUDGET_MS = 240000;          // a sync run stops after 4 minutes; the next run carries on
const BACKUP_KEEP = 7;                  // daily "Backup yyyy-MM-dd" copies of the Tasks tab that are kept
const LOG_KEEP = 300;                   // rows kept in the Sync log / Audit log tabs

// Columns the dashboard is allowed to read (header prefixes, lower case). Nothing else leaves the sheet.
const PUBLIC_COLS = ['project', 'task', 'assignee', 'status', 'due', 'priority', 'notes',
                     'type', 'requested', 'hours', 'affects', 'request id', 'designer id', 'publish', 'status note'];
// Columns this script needs on the Tasks tab (added by setup() if missing).
// title pattern -> dashboard category (first match wins). Same categories as the dashboard calendar filters.
const CAL_RULES = [
  ['prep',     /^\[?PREP\]?(\s|—|-|\[|$)/i],
  ['deadline', /^\[(Designer Deadline|DESIGN DUE)\]/i],
  ['ads',      /^\[ADS\]|^Meta\b|^\[REVIEW\]\s*Optimi[sz]e Ad/i],
  ['review',   /^\[(REVIEW|Management)/i],
  ['house',    /^\[(HOUSE|LAUNCH)\]/i],
  ['line',     /^\[LINE|^LINE\b|\bLine Broadcast\b/i],
  ['ceo',      /^\[(PROOF|TEASER|CEO|WOON|RECAP)(\]|\s)|^Certificate/i],
  ['ecom',     /^\[(Tentative\s+)?(9\.9|10\.10|11\.11|12\.12|SEP|OCT|NOV|DEC|ECOM|Payday)[^\]]*\]|Makro|Shopee|Lazada/i],
  ['content',  /^POST\b|^\[(CORP|B2C|HYBRID LITE|CREATOR)\]|^Bags\b/i],
  ['team',     /^Marketing|^Internal|^\[EVENT\]|^ย้อนหลัง|^CEO|^30th|ทำบุญ|^Team\b|meeting|FoodX|FoodEx|อบรม|ครบรอบ|งานกีฬาสี|^Schedule\b/i]
];
function classifyEvent_(title) {
  const t = String(title || '').trim();
  for (let i = 0; i < CAL_RULES.length; i++) if (CAL_RULES[i][1].test(t)) return CAL_RULES[i][0];
  return '';
}

const EXTRA_TASK_COLS = ['Type', 'Requested by', 'Hours', 'Affects', 'Request ID', 'Designer ID', 'Publish date', 'Status note'];
const REQUEST_COLS = ['Request ID', 'Client ID', 'Submitted', 'Requester', 'Email', 'Department', 'Contact',
  'Request type', 'Title', 'Description', 'Details', 'Links', 'Deadline', 'Urgency', 'Urgent reason',
  'Priority', 'Assignee', 'Est. hours', 'Related project', 'Email status', 'Calendar', 'Status', 'Status updated'];

/* ---------------- web app entry points ---------------- */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'tasks';
  try {
    if (action === 'ping') return json_({ ok: true, time: new Date().toISOString() });
    if (action === 'calendar') return json_({ ok: true, events: calendarRows_(), serverTime: new Date().toISOString() });
    if (action === 'designer') return json_({ ok: true, rows: designerFeed_(), serverTime: new Date().toISOString() });
    if (action === 'health') return json_(healthReport_(false));
    if (action === 'tasks') return json_({ ok: true, rows: taskRows_(), serverTime: new Date().toISOString() });
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > 60000) return json_({ ok: false, error: 'Request too large' });
    const body = JSON.parse(raw);
    if (body && body.action === 'setStatus') return json_(setStatus_(body));
    return json_(submit_(body));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* ---------------- reading tasks ---------------- */

function taskRows_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('rows');
  if (hit) return JSON.parse(hit);
  const sh = tasksSheet_();
  const values = sh.getDataRange().getValues();
  if (!values.length) return [];
  const header = values[0].map(function (h) { return String(h).trim(); });
  const keep = [];
  header.forEach(function (h, i) {
    const l = h.toLowerCase();
    if (PUBLIC_COLS.some(function (p) { return l.indexOf(p) === 0; })) keep.push(i);
  });
  const rows = values.map(function (r) {
    return keep.map(function (i) { return cell_(r[i]); });
  });
  try { cache.put('rows', JSON.stringify(rows), 10); } catch (_) {}   // 10 s cache protects the quota
  return rows;
}



/* ---------------- email when a status changes ---------------- */

function personByName_(name) {
  const k = String(name || '').trim().toLowerCase();
  if (!k) return null;
  const ids = Object.keys(CONFIG.PEOPLE);
  for (let i = 0; i < ids.length; i++) {
    const p = CONFIG.PEOPLE[ids[i]];
    if (ids[i].toLowerCase() === k || String(p.name).toLowerCase() === k) return p;
  }
  return null;
}

/**
 * Emails the people who need to know that a task changed status. Never throws: a mail problem must not undo the status change.
 * c = { title, project, assignee, from, to, note, newDue, source }
 * Returns { sent, to: [..], skipped?, error? }.
 */
function notifyStatus_(c) {
  try {
    if (!CONFIG.NOTIFY_ON_STATUS) return { sent: false, skipped: 'notifications are off' };
    if (CONFIG.NOTIFY_STATUSES.indexOf(c.to) < 0) return { sent: false, skipped: 'routine move, not emailed' };
    if (c.from && String(c.from).trim().toLowerCase() === String(c.to).toLowerCase()) return { sent: false, skipped: 'no change' };
    const cache = CacheService.getScriptCache();
    const dedupe = 'nt:' + String(c.title).slice(0, 60) + '|' + c.to;
    if (cache.get(dedupe)) return { sent: false, skipped: 'already emailed a moment ago' };
    if (MailApp.getRemainingDailyQuota() < 1) return { sent: false, error: 'daily email quota reached' };

    const person = personByName_(c.assignee);
    const manager = CONFIG.MANAGER_EMAIL;
    const real = function (e) { return e && !/^REPLACE_/i.test(e); };
    let to, cc = [];
    if (c.to === 'Waiting approval') { to = manager; if (person) cc.push(person.email); }
    else { to = person ? person.email : manager; cc.push(manager); }
    cc = cc.concat(CONFIG.ALWAYS_CC).filter(function (e, i, a) { return real(e) && e.toLowerCase() !== String(to).toLowerCase() && a.indexOf(e) === i; });
    if (!real(to)) return { sent: false, error: 'no email address configured for ' + (c.assignee || 'the assignee') };

    const rows = [['Task', c.title], ['Project', c.project || '—'], ['Assigned to', c.assignee || '—'], ['Status', (c.from ? c.from + '  →  ' : '') + c.to]];
    if (c.note) rows.push(['Reason / note', c.note]);
    if (c.newDue) rows.push(['New due date', c.newDue]);
    rows.push(['Changed from', c.source || 'dashboard']);
    const meaning = STATUS_MEANING[c.to] || '';
    const subject = '[Marketing Hub] ' + c.to + ' — ' + c.title;
    const text = c.to + ': ' + c.title + '\n' + meaning + '\n\n' + rows.map(function (x) { return x[0] + ': ' + x[1]; }).join('\n') +
      '\n\nOpen the dashboard: ' + CONFIG.DASHBOARD_URL;
    const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#15181d;max-width:620px">' +
      '<div style="background:#00396b;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;border-bottom:4px solid #e9b94f">' +
      '<div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;opacity:.8">Bags and Gloves · Marketing Team Hub</div>' +
      '<div style="font-size:18px;font-weight:bold;margin-top:2px">' + esc_(c.to) + ' — ' + esc_(c.title) + '</div></div>' +
      '<div style="border:1px solid #e4e7ec;border-top:0;padding:16px 18px;border-radius:0 0 10px 10px">' +
      (meaning ? '<p style="margin:0 0 10px;color:#344054">' + esc_(meaning) + '</p>' : '') +
      '<table style="border-collapse:collapse;width:100%">' +
      rows.map(function (x) {
        return '<tr><td style="padding:5px 12px 5px 0;color:#667085;white-space:nowrap;vertical-align:top">' + esc_(x[0]) +
          '</td><td style="padding:5px 0"><b>' + esc_(x[1]) + '</b></td></tr>';
      }).join('') + '</table>' +
      '<p style="margin-top:16px"><a href="' + esc_(CONFIG.DASHBOARD_URL) + '" style="background:#00396b;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none;font-weight:bold">Open the dashboard</a></p>' +
      '</div></div>';
    MailApp.sendEmail({ to: to, cc: cc.join(','), subject: subject, body: text, htmlBody: html, name: 'Marketing Team Hub' });
    try { cache.put(dedupe, '1', 120); } catch (_) {}
    return { sent: true, to: [to].concat(cc) };
  } catch (err) {
    return { sent: false, error: String(err && err.message || err) };
  }
}

/* ---------------- changing a task's status from the dashboard ---------------- */

const STATUS_VALUES = ['To do', 'In progress', 'Review', 'Needs rework', 'Waiting approval', 'Ready', 'Done',
                       'Blocked', 'Waiting for info', 'On hold', 'Postponed', 'Cancelled'];
// Dashboard status -> designer sheet status. null = the designer sheet has no such status, so only the Tasks sheet changes
// (and the 15-minute sync leaves it alone until the designer sheet says Approved/Published/Cancelled).
// Postponed uses the designer sheet's own "Deadline Change Requested" flow.
const DESIGNER_STATUS_OUT = { 'To do': 'Briefed', 'In progress': 'In Design', 'Review': 'Draft Submitted', 'Needs rework': 'Revision', 'Done': 'Approved',
                              'Postponed': 'Deadline Change Requested', 'Cancelled': 'Cancelled',
                              'Waiting approval': null, 'Ready': null, 'Blocked': null, 'Waiting for info': null, 'On hold': null };
const TASKS_ONLY = ['Waiting approval', 'Ready', 'Blocked', 'Waiting for info', 'On hold'];
const KEEPS_NOTE = ['Needs rework', 'Waiting approval', 'Ready', 'Blocked', 'Waiting for info', 'On hold', 'Postponed', 'Cancelled'];
const STATUS_MEANING = {
  'Needs rework': 'Changes are needed before this can move on.', 'Waiting approval': 'It is ready and waiting for an approval.',
  'Ready': 'It is approved and ready to publish or hand over.', 'Done': 'It is finished.',
  'Blocked': 'It cannot move forward until something is resolved.', 'Waiting for info': 'It is waiting for information or an answer from someone.',
  'On hold': 'It is paused on purpose for now.', 'Postponed': 'It has been moved to a new date.', 'Cancelled': 'It has been dropped and no longer needs doing.',
  'To do': 'It has not started.', 'In progress': 'Work has started.', 'Review': 'It is being reviewed.'
};

/**
 * POST {action:'setStatus', passcode, status, designerId?, reqId?, title?, project?}
 * Needs the Script property EDIT_PASSCODE (Project settings -> Script properties). Without it editing is switched off.
 * - Task has a Designer ID: the designer sheet is updated (it is the source of truth) and the Tasks row too.
 * - Otherwise the Tasks row is found by Request ID, else by exact title (+ project when given).
 */
function setStatus_(b) {
  const want = String(b.passcode == null ? '' : b.passcode);
  const real = PropertiesService.getScriptProperties().getProperty('EDIT_PASSCODE');
  if (!real) return { ok: false, error: 'Editing is switched off. In Apps Script open Project settings > Script properties and add EDIT_PASSCODE.' };
  const cache = CacheService.getScriptCache();
  const device = String(b.deviceId || 'anon').replace(/[^\w-]/g, '').slice(0, 40) || 'anon';
  const kDev = 'pwfail:' + device, kAll = 'pwfail:all';
  // 10 wrong tries per device and 60 overall in 10 minutes, so one stranger cannot lock the whole team out.
  if (Number(cache.get(kDev) || 0) >= 10 || Number(cache.get(kAll) || 0) >= 60) {
    return { ok: false, error: 'Too many wrong passcodes. Try again in 10 minutes.' };
  }
  if (want !== real) {
    try { cache.put(kDev, String(Number(cache.get(kDev) || 0) + 1), 600); cache.put(kAll, String(Number(cache.get(kAll) || 0) + 1), 600); } catch (_) {}
    return { ok: false, error: 'Wrong passcode.', code: 'passcode' };
  }
  const status = String(b.status || '');
  if (STATUS_VALUES.indexOf(status) < 0) return { ok: false, error: 'Unknown status.' };
  const note = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const newDue = String(b.newDue || '').trim();
  if (status === 'Postponed' && !/^\d{4}-\d{2}-\d{2}$/.test(newDue)) return { ok: false, error: 'Pick the new date for a postponed task.' };

  const tasks = tasksSheet_();
  const th = headerIndex_(tasks);
  const C = { status: colIdx_(th, 'status'), title: colIdx_(th, 'task'), project: colIdx_(th, 'project'),
              rid: colIdx_(th, 'request id'), did: colIdx_(th, 'designer id'), note: colIdx_(th, 'status note'), due: colIdx_(th, 'due') };
  if (C.status < 0 || C.title < 0) return { ok: false, error: 'Tasks tab layout not recognised.' };
  const rows = tasks.getDataRange().getValues();
  const norm = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };
  const did = String(b.designerId || '').trim(), rid = String(b.reqId || '').trim();
  let row = -1;
  for (let i = 1; i < rows.length && row < 0; i++) {
    if (did && C.did >= 0 && String(rows[i][C.did]).trim() === did) row = i;
    else if (!did && rid && C.rid >= 0 && String(rows[i][C.rid]).trim() === rid) row = i;
  }
  if (row < 0 && !did) {
    const hits = [];
    for (let i = 1; i < rows.length; i++) {
      if (norm(rows[i][C.title]) !== norm(b.title)) continue;
      if (b.project && C.project >= 0 && norm(rows[i][C.project]) !== norm(b.project)) continue;
      hits.push(i);
    }
    if (!hits.length && b.project) {          // the project name can differ (e.g. translated): fall back to the task name alone
      for (let i = 1; i < rows.length; i++) if (norm(rows[i][C.title]) === norm(b.title)) hits.push(i);
    }
    if (hits.length === 1) row = hits[0];
    else if (hits.length > 1) return { ok: false, error: 'More than one task has this name; change it in the sheet.' };
  }

  // Which designer task is this? The id sent by the dashboard, else the Designer ID on the Tasks row,
  // else an exact (case-insensitive) match of the task name with a designer "Content" (only when it is unique).
  let did2 = did || (row >= 0 && C.did >= 0 ? String(rows[row][C.did] || '').trim() : '');
  let before = row >= 0 ? String(rows[row][C.status]) : '';
  let designerDone = false, matchedByName = false, designerRowNo = 0, designerCell = null;
  const dsh = SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID).getSheetByName(CONFIG.DESIGNER_TAB);
  if (dsh) {
    const dv = dsh.getDataRange().getValues();
    const dh = dv[0].map(function (h) { return String(h).trim().toLowerCase(); });
    const dId = dh.indexOf('task_id'), dSt = dh.indexOf('status'), dCo = dh.indexOf('content');
    if (dId >= 0 && dSt >= 0) {
      let hit = -1;
      if (did2) {
        for (let i = 1; i < dv.length && hit < 0; i++) if (String(dv[i][dId]).trim() === did2) hit = i;
        if (hit < 0 && did) { if (row < 0) return { ok: false, error: 'Task not found in the designer sheet.' }; }
      } else if (dCo >= 0 && b.title) {
        const found = [];
        for (let i = 1; i < dv.length; i++) {
          if (norm(dv[i][dCo]) === norm(b.title) && String(dv[i][dSt]).trim().toLowerCase() !== 'cancelled') found.push(i);
        }
        if (found.length === 1) { hit = found[0]; matchedByName = true; }
      }
      if (hit >= 0) {
        if (String(dv[hit][dSt]).trim().toLowerCase() === 'cancelled') return { ok: false, error: 'This designer task is cancelled.' };
        if (!before) before = String(dv[hit][dSt]);
        const outStatus = DESIGNER_STATUS_OUT[status];
        if (outStatus) {
          safeSet_(dsh, hit + 1, dSt + 1, outStatus);
          designerDone = true; designerRowNo = hit + 1; designerCell = [dsh, hit + 1, dSt + 1, outStatus];
          if (status === 'Postponed') {            // use the designer sheet's own deadline-change columns when it has them
            const put = function (name, val) { const c = dh.indexOf(name); if (c >= 0) safeSet_(dsh, hit + 1, c + 1, val); };
            put('requested_design_due', newDue); put('deadline_request_reason', note || 'Postponed from the dashboard');
            put('deadline_request_status', 'Pending'); put('deadline_request_by', 'Dashboard');
            put('deadline_request_at', Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'));
          }
        }
        did2 = String(dv[hit][dId]).trim();
      }
    }
  }
  if (row < 0 && !designerDone) return { ok: false, error: TASKS_ONLY.indexOf(status) >= 0 ? '"' + status + '" is kept on the Tasks sheet, but this task is not in it yet. Wait for the next sync or add it there.' : 'Task not found in the Tasks sheet.' };
  if (row >= 0) {
    writeCell_(tasks, row + 1, C.status + 1, status);
    if (C.note >= 0) {
      const keep = KEEPS_NOTE.indexOf(status) >= 0;
      if (keep || String(rows[row][C.note] || '')) writeCell_(tasks, row + 1, C.note + 1, keep ? note : '');
    }
    if (status === 'Postponed' && C.due >= 0) writeCell_(tasks, row + 1, C.due + 1, newDue);
  }
  // Requests log (private tab): keep the status of ad-hoc requests there too.
  let requestsRow = 0;
  try {
    const reqId = rid || (row >= 0 && C.rid >= 0 ? String(rows[row][C.rid] || '').trim() : '');
    if (reqId) {
      const rq = requestsSheet_(), found = findRow_(rq, 'Request ID', reqId);
      if (found) { setCell_(rq, found.row, 'Status', status + (note ? ' — ' + note : '')); setCell_(rq, found.row, 'Status updated', Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm')); requestsRow = found.row; }
    }
  } catch (_) {}
  // Read the cells back, so the dashboard can say for sure what the sheets now hold.
  SpreadsheetApp.flush();
  const checks = [];
  if (row >= 0) checks.push({ sheet: 'Tasks', row: row + 1, value: String(tasks.getRange(row + 1, C.status + 1).getValue()), want: status });
  if (designerCell) checks.push({ sheet: 'Designer', row: designerCell[1], value: String(designerCell[0].getRange(designerCell[1], designerCell[2]).getValue()), want: designerCell[3] });
  const mismatches = checks.filter(function (c) { return c.value !== c.want; });
  if (mismatches.length) logSync_('setStatus', 0, 0, 'WRITE NOT VISIBLE: ' + mismatches.map(function (c) { return c.sheet + ' row ' + c.row + ' holds "' + c.value + '", wanted "' + c.want + '"'; }).join('; '));
  cache.remove('rows'); cache.remove('dfeed');
  const where = (row >= 0 ? 'tasks' : '') + (row >= 0 && designerDone ? ' + ' : '') + (designerDone ? 'designer' : '');
  auditLog_(device, b.title || did2 || rid, before, status + (note ? ' — ' + note : '') + (status === 'Postponed' ? ' → ' + newDue : ''), where + (matchedByName ? ' (matched by name)' : ''));
  let mail = { sent: false, skipped: 'you chose not to email' };
  if (b.notify !== false) {
    const assignee = row >= 0 ? String(rows[row][colIdx_(th, 'assignee')] || '') : String(b.assignee || '');
    mail = notifyStatus_({ title: b.title || String(rows[row] ? rows[row][C.title] : did2), project: b.project || (row >= 0 && C.project >= 0 ? String(rows[row][C.project]) : ''),
                           assignee: assignee, from: before, to: status, note: note, newDue: status === 'Postponed' ? newDue : '', source: 'dashboard' });
  }
  return { ok: true, where: where, tasksRow: row >= 0, designerRow: designerDone, status: status, emailed: !!mail.sent, emailTo: mail.to || [], emailNote: mail.error || mail.skipped || '',
           saved: checks.map(function (c) { return c.sheet + ' sheet, row ' + c.row; }).concat(requestsRow ? ['Requests log, row ' + requestsRow] : []),
           verified: mismatches.length === 0,
           problem: mismatches.map(function (c) { return c.sheet + ' row ' + c.row + ' still shows "' + c.value + '"'; }).join('; ') };
}

/** Live designer rows (only the columns the dashboard needs, as shown in the sheet). Replaces the slower, cached CSV export. */
function designerFeed_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('dfeed');
  if (hit) return JSON.parse(hit);
  const sh = SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID).getSheetByName(CONFIG.DESIGNER_TAB);
  if (!sh) throw new Error('Designer tab not found');
  const vals = sh.getDataRange().getDisplayValues();
  const head = vals[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const want = ['Task_ID', 'Publish_Date', 'Design_Due', 'Campaign', 'Content', 'Designer', 'Status', 'Priority'];
  const idx = want.map(function (w) { return head.indexOf(w.toLowerCase()); });
  if (idx.some(function (i) { return i < 0; })) throw new Error('Designer tab is missing a column');
  const out = [want];
  vals.slice(1).forEach(function (r) { if (String(r[idx[0]]).trim()) out.push(idx.map(function (i) { return r[i]; })); });
  try { cache.put('dfeed', JSON.stringify(out), 10); } catch (_) {}
  return out;
}

/* ---------------- live calendar ---------------- */

function calendarRows_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('cal');
  if (hit) return JSON.parse(hit);
  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID) || CalendarApp.getDefaultCalendar();
  const from = new Date(CONFIG.CALENDAR_FROM + 'T00:00:00+07:00');
  const to = new Date(Date.now() + CONFIG.CALENDAR_DAYS_AHEAD * 86400000);
  const byEmail = {};
  Object.keys(CONFIG.PEOPLE).forEach(function (k) { byEmail[CONFIG.PEOPLE[k].email.toLowerCase()] = CONFIG.PEOPLE[k].name; });
  const day = function (dt) { return Utilities.formatDate(dt, CONFIG.TIMEZONE, 'yyyy-MM-dd'); };
  const out = [];
  cal.getEvents(from, to).forEach(function (ev) {
    const title = ev.getTitle();
    const cat = classifyEvent_(title);
    if (!cat) return;
    const row = { d: '', t: '', title: title, cat: cat };
    if (ev.isAllDayEvent()) {
      row.d = day(ev.getAllDayStartDate());
      const last = day(new Date(ev.getAllDayEndDate().getTime() - 86400000));   // end date is exclusive
      if (last > row.d) row.end = last;
    } else {
      row.d = day(ev.getStartTime());
      row.t = Utilities.formatDate(ev.getStartTime(), CONFIG.TIMEZONE, 'HH:mm');
    }
    const who = [CONFIG.CALENDAR_OWNER_NAME];
    ev.getGuestList().forEach(function (g) {
      const n = byEmail[String(g.getEmail()).toLowerCase()];
      if (n && who.indexOf(n) < 0) who.push(n);
    });
    row.who = who;
    out.push(row);
  });
  out.sort(function (a, b) { return (a.d + (a.t || '00:00')).localeCompare(b.d + (b.t || '00:00')); });
  try { cache.put('cal', JSON.stringify(out), 60); } catch (_) {}   // 100 KB cache limit: large calendars simply skip the cache
  return out;
}

function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

/* ---------------- handling a request ---------------- */

function submit_(b) {
  if (b.website) return { ok: true, id: 'REQ-IGNORED' };           // honeypot: bots fill hidden fields
  const r = validate_(b);
  const person = CONFIG.PEOPLE[r.assigneeId];

  const requests = requestsSheet_();
  const existing = findRow_(requests, 'Client ID', r.clientId);
  if (existing) return { ok: true, id: existing.id, assigneeName: person.name, emailed: true, duplicate: true };

  rateLimit_(r.email);

  const now = new Date();
  const id = nextId_(now);
  const details = r.details.map(function (d) { return d.label + ': ' + d.value; }).join('\n');

  // 1. Task row first, so the dashboard shows it even if email fails.
  const tasks = tasksSheet_();
  const cols = headerIndex_(tasks);
  const width = tasks.getLastColumn();
  const row = new Array(width).fill('');
  const put = function (prefix, value) { const i = colIdx_(cols, prefix); if (i >= 0) row[i] = value; };
  put('project', CONFIG.PROJECT_NAME);
  put('task', r.title);
  put('assignee', person.name);
  put('status', 'To do');
  put('due', r.deadline);
  put('priority', r.priority);
  put('notes', id + ' · ' + r.typeLabel + ' · requested by ' + r.name + ' (' + r.dept + ')');
  put('type', 'Ad-hoc');
  put('requested', r.name + ' (' + r.dept + ')');
  put('hours', r.estHours);
  put('affects', r.affects);
  put('request id', id);
  const target = tasks.getRange(tasks.getLastRow() + 1, 1, 1, width);
  setTextValues_(target, [row.map(safe_)]);                        // text only: no formulas, dates stay yyyy-mm-dd

  // 2. Private full log.
  const log = [id, r.clientId, Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'), r.name, r.email,
    r.dept, r.contact, r.typeLabel, r.title, r.description, details, r.links, r.deadline, r.urgency,
    r.urgentReason, r.priority, person.name, r.estHours, r.affects, 'pending', 'pending'];
  const lr = requests.getRange(requests.getLastRow() + 1, 1, 1, REQUEST_COLS.length);
  setTextValues_(lr, [log.map(safe_)]);
  const logRow = requests.getLastRow();

  CacheService.getScriptCache().remove('rows');

  // 3. Email.
  let emailed = true, emailError = '';
  try {
    sendEmails_(id, r, person, details);
  } catch (err) {
    emailed = false;
    emailError = String(err && err.message || err);
  }

  // 4. Calendar. A failure here never blocks the request; it is reported and logged.
  let calendarAdded = false, calendarNote = CONFIG.ADD_TO_CALENDAR ? '' : 'off';
  if (CONFIG.ADD_TO_CALENDAR) {
    try {
      calendarNote = 'event ' + addToCalendar_(id, r, person);
      calendarAdded = true;
    } catch (err) {
      calendarNote = 'FAILED: ' + String(err && err.message || err);
    }
  }
  setCell_(requests, logRow, 'Email status', emailed ? 'sent' : 'FAILED: ' + emailError);
  setCell_(requests, logRow, 'Calendar', calendarNote);

  return { ok: true, id: id, assigneeName: person.name, emailed: emailed, emailError: emailed ? '' : emailError,
           calendarAdded: calendarAdded };
}

function validate_(b) {
  const str = function (v, max) { return String(v == null ? '' : v).trim().slice(0, max); };
  const req = b.requester || {};
  const r = {
    clientId: str(b.clientId, 80),
    name: str(req.name, 100), email: str(req.email, 150).toLowerCase(),
    dept: str(req.dept, 80), contact: str(req.contact, 100),
    typeLabel: str(b.type && b.type.label, 80),
    title: str(b.title, 150), description: str(b.description, 4000),
    links: str(b.links, 2000),
    deadline: str(b.deadline, 10), urgency: str(b.urgency, 20), urgentReason: str(b.urgentReason, 1000),
    priority: str(b.priority, 10), assigneeId: str(b.assigneeId, 30),
    estHours: Number(b.estHours) > 0 ? String(Number(b.estHours)) : '',
    affects: str(b.affects, 100),
    details: (Array.isArray(b.details) ? b.details : []).slice(0, 40).map(function (d) {
      return { label: str(d.label, 80), value: str(d.value, 1000) };
    })
  };
  if (!r.clientId) throw new Error('Missing request id');
  if (!r.name || !r.dept || !r.typeLabel || !r.title || !r.description) throw new Error('Please fill in all required fields');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) throw new Error('Please enter a valid email address');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.deadline)) throw new Error('Please choose a valid deadline');
  if (['High', 'Medium', 'Low'].indexOf(r.priority) < 0) throw new Error('Invalid priority');
  const person = CONFIG.PEOPLE[r.assigneeId];
  if (!person) throw new Error('Unknown assignee');
  if (/^REPLACE_/.test(person.email) || /^REPLACE_/.test(CONFIG.MANAGER_EMAIL)) {
    throw new Error('Email addresses are not configured yet. Ask the admin to finish setup (SETUP.md).');
  }
  return r;
}

function rateLimit_(email) {
  const cache = CacheService.getScriptCache();
  const key = 'rl:' + email;
  const n = Number(cache.get(key) || 0);
  if (n >= CONFIG.RATE_LIMIT_PER_HOUR) throw new Error('Too many requests from this email. Please try again later.');
  cache.put(key, String(n + 1), 3600);
}

function nextId_(now) {
  const day = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyMMdd');
  const props = PropertiesService.getScriptProperties();
  const key = 'seq_' + day;
  const n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return 'REQ-' + day + '-' + ('00' + n).slice(-3);
}

/* ---------------- calendar ---------------- */

/** All-day event on the deadline, in the deployer's calendar with the assignee invited (appears on their calendar). */
function addToCalendar_(id, r, person) {
  const p = r.deadline.split('-').map(Number);
  const day = new Date(p[0], p[1] - 1, p[2]);
  const cal = CalendarApp.getDefaultCalendar();
  const title = (r.priority === 'High' ? '[URGENT] ' : '') + '[' + id + '] ' + r.title;
  const description = 'Marketing request ' + id + ' (' + r.typeLabel + ')\n' +
    'Requested by: ' + r.name + ' · ' + r.dept + ' · ' + r.email + (r.contact ? ' · ' + r.contact : '') + '\n' +
    'Priority: ' + r.priority + (r.urgentReason ? ' — ' + r.urgentReason : '') + '\n\n' +
    r.description + (r.links ? '\n\nLinks:\n' + r.links : '') + '\n\nDashboard: ' + CONFIG.DASHBOARD_URL;
  const owner = Session.getEffectiveUser().getEmail().toLowerCase();
  const options = { description: description };
  if (person.email.toLowerCase() !== owner) options.guests = person.email;   // sendInvites stays false: the request email already went out
  const ev = cal.createAllDayEvent(title, day, options);
  ev.addPopupReminder(24 * 60);   // 1 day before
  return ev.getId();
}

/* ---------------- email ---------------- */

function sendEmails_(id, r, person, details) {
  if (MailApp.getRemainingDailyQuota() < 1) throw new Error('Daily email quota reached - the task is on the dashboard but no email was sent.');
  const seen = {};
  seen[person.email.toLowerCase()] = true;                // the assignee is the To, never repeated
  const unique = function (list) {
    return list.filter(function (e) {
      const k = String(e || '').toLowerCase();
      if (!k || /^replace_/.test(k) || seen[k]) return false;
      seen[k] = true;
      return true;
    });
  };
  const cc = unique([CONFIG.MANAGER_EMAIL].concat(CONFIG.ALWAYS_CC));
  const bcc = unique(CONFIG.BCC_WHOLE_TEAM ? Object.keys(CONFIG.PEOPLE).map(function (k) { return CONFIG.PEOPLE[k].email; }) : []);
  const flag = r.priority === 'High' ? '[URGENT] ' : '';
  const subject = flag + '[Marketing Request ' + id + '] ' + r.title;
  const rows = [
    ['Request ID', id], ['Type', r.typeLabel], ['Assigned to', person.name],
    ['Deadline', r.deadline], ['Priority', r.priority + (r.urgentReason ? ' — ' + r.urgentReason : '')],
    ['Requested by', r.name + ' · ' + r.dept], ['Reply to', r.email + (r.contact ? ' · ' + r.contact : '')]
  ];
  const text = 'New marketing request ' + id + '\n\n' +
    rows.map(function (x) { return x[0] + ': ' + x[1]; }).join('\n') +
    '\n\nWhat is needed:\n' + r.description +
    (details ? '\n\nDetails:\n' + details : '') + (r.links ? '\n\nLinks:\n' + r.links : '') +
    '\n\nThe task is already on the Marketing Team Hub dashboard. Reply to this email to reach the requester.';
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#15181d;max-width:640px">' +
    '<div style="background:#00396b;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;border-bottom:4px solid #e9b94f">' +
    '<div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;opacity:.8">Bags and Gloves · Marketing Request Desk</div>' +
    '<div style="font-size:18px;font-weight:bold;margin-top:2px">' + esc_(flag + r.title) + '</div></div>' +
    '<div style="border:1px solid #e4e7ec;border-top:0;padding:16px 18px;border-radius:0 0 10px 10px">' +
    '<table style="border-collapse:collapse;width:100%">' +
    rows.map(function (x) {
      return '<tr><td style="padding:5px 12px 5px 0;color:#667085;white-space:nowrap;vertical-align:top">' + esc_(x[0]) +
        '</td><td style="padding:5px 0"><b>' + esc_(x[1]) + '</b></td></tr>';
    }).join('') + '</table>' +
    '<h3 style="margin:16px 0 4px;font-size:14px">What is needed</h3><div style="white-space:pre-wrap">' + esc_(r.description) + '</div>' +
    (details ? '<h3 style="margin:16px 0 4px;font-size:14px">Details</h3><div style="white-space:pre-wrap">' + esc_(details) + '</div>' : '') +
    (r.links ? '<h3 style="margin:16px 0 4px;font-size:14px">Links</h3><div style="white-space:pre-wrap">' + esc_(r.links) + '</div>' : '') +
    '<p style="color:#667085;font-size:12px;margin-top:18px">This task is already on the Marketing Team Hub dashboard. ' +
    'Reply to this email to reach the requester directly.</p></div></div>';

  MailApp.sendEmail({
    to: person.email, cc: cc.join(','), bcc: bcc.join(','), replyTo: r.email,
    subject: subject, body: text, htmlBody: html, name: 'Marketing Request Desk'
  });

  if (CONFIG.CONFIRM_TO_REQUESTER) {
    MailApp.sendEmail({
      to: r.email, replyTo: CONFIG.ALWAYS_CC[0] || person.email,
      subject: 'We received your request ' + id + ': ' + r.title,
      name: 'Marketing Request Desk',
      body: 'Hi ' + r.name + ',\n\nThank you. Your marketing request ' + id + ' has been assigned to ' + person.name +
        '. Requested deadline: ' + r.deadline + '.\n\nIf anything changes, reply to this email or write to ' +
        (CONFIG.ALWAYS_CC[0] || 'the marketing team') + ' and quote the request ID.\n\nBags and Gloves Marketing Team'
    });
  }
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ---------------- sheet helpers ---------------- */

function setCell_(sh, row, headerName, value) {
  const c = headerIndex_(sh).indexOf(headerName.toLowerCase());
  if (c >= 0) safeSet_(sh, row, c + 1, value);
}
function safe_(v) { return v == null ? '' : String(v); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function ss_() { return SpreadsheetApp.openById(CONFIG.TASKS_SHEET_ID); }
function tasksSheet_() { const s = ss_(); return s.getSheetByName(CONFIG.TASKS_TAB) || s.getSheets()[0]; }
function requestsSheet_() {
  const s = ss_();
  let sh = s.getSheetByName(CONFIG.REQUESTS_TAB);
  if (!sh) {
    sh = s.insertSheet(CONFIG.REQUESTS_TAB);
    sh.getRange(1, 1, 1, REQUEST_COLS.length).setValues([REQUEST_COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  // Older Requests tabs may lack newer columns (e.g. Calendar): add them to the header so they line up with the data.
  const header = headerIndex_(sh);
  REQUEST_COLS.forEach(function (name, i) {
    if (header.indexOf(name.toLowerCase()) < 0) sh.getRange(1, i + 1).setValue(name).setFontWeight('bold');
  });
  return sh;
}
function headerIndex_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
}
function colIdx_(header, prefix) {
  const exact = header.indexOf(prefix);          // "status" must not pick up "status note"
  if (exact >= 0) return exact;
  for (let i = 0; i < header.length; i++) if (header[i].indexOf(prefix) === 0) return i;
  return -1;
}
function findRow_(sh, headerName, value) {
  const last = sh.getLastRow();
  if (last < 2) return null;
  const header = headerIndex_(sh);
  const c = header.indexOf(headerName.toLowerCase());
  if (c < 0) return null;
  const vals = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][c]) === value) return { id: String(vals[i][0]), row: i + 2 };
  return null;
}

/* ---------------- one-time setup + tests (run from the Apps Script editor) ---------------- */

/** Run once: adds missing columns to the Tasks tab, creates the Requests tab, checks the config. */

/* ---------------- Designer Automation -> Tasks status sync ---------------- */

// Designer status -> Tasks status. Cancelled / unknown statuses return '' = leave the row alone.
function designerStatusToTask_(s) {
  switch (String(s || '').trim().toLowerCase()) {
    case 'briefed': return 'To do';
    case 'in design': return 'In progress';
    case 'draft submitted': case 'draft': return 'Review';
    case 'revision': case 'revision requested': return 'Needs rework';
    case 'deadline change requested': return 'Postponed';
    case 'approved': case 'scheduled': case 'published': return 'Done';
    case 'cancelled': case 'canceled': return 'Cancelled';
    default: return '';
  }
}

function designerProject_(campaign, title) {
  const c = String(campaign || '').toLowerCase(), t = String(title || '').toLowerCase();
  let id = 'content';
  if (/\bnewsletter\b/.test(t)) id = 'newsletter';
  else if (c.indexOf('30th anniversary') >= 0) id = 'anniversary';
  else if (c.indexOf('woon') >= 0 || c.indexOf('ceo') >= 0) id = 'ceo-lens';
  else if (c.indexOf('house brand') >= 0) id = 'house-brand';
  else if (c.indexOf('10.10') >= 0) id = 'd1010';
  else if (/\bads\b/.test(c) || /^\[ads\]/.test(t)) id = 'paid-ads';
  else if (/\bline\b/.test(c) || /^\[line/.test(t)) id = 'line-oa';
  return CONFIG.PROJECT_NAMES[id];
}

var MONTHS_ = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Designer dates arrive as a Date, "2026-09-14" or "28 Aug 2026". Returns 'yyyy-MM-dd' or ''.
function normDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const t = String(v == null ? '' : v).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})$/);
  if (m && MONTHS_[m[2].toLowerCase()]) return m[3] + '-' + ('0' + MONTHS_[m[2].toLowerCase()]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}

/**
 * Keeps the Tasks sheet in step with the Designer Automation sheet (Communication Calendar tab):
 *  - ADD:    every designer row published on/after DESIGNER_FROM that is not cancelled and not yet in Tasks becomes a task row.
 *  - UPDATE: rows created by the sync (Notes start with DESIGNER_NOTE) follow the designer sheet for status, due, assignee, title and publish date.
 *            Rows you linked by hand (typed a Designer ID yourself) only get their Status updated; your wording is kept.
 *  - A linked row whose designer task is cancelled is marked "CANCELLED ·" in Notes (the dashboard hides it).
 * Safety: runs under the script lock, refuses to run if the designer tab looks empty, takes a daily backup of the Tasks tab first,
 * writes everything as plain text (no formulas), stops after SYNC_BUDGET_MS and picks up where it left off next run,
 * and records every run in the "Sync log" tab (an email goes to the script owner when a run fails, at most once a day).
 * Run once by hand to test, and run installDesignerSync() once to keep it running automatically.
 */
function syncFromDesigner() {
  try {
    return withLock_(syncDesignerCore_, 30000);
  } catch (err) {
    const msg = String(err && err.message || err);
    logSync_('sync', 0, 0, 'ERROR: ' + msg);
    notifyOwner_('Designer sync failed', 'The Designer Automation → Tasks sync failed:\n\n' + msg + '\n\nSee the "Sync log" tab. Nothing was deleted.');
    return { added: 0, updated: 0, error: msg };
  }
}

function syncDesignerCore_() {
  const t0 = Date.now();
  const tasks = tasksSheet_();
  let th = headerIndex_(tasks);
  ['Designer ID', 'Publish date'].forEach(function (name) {
    if (colIdx_(th, name.toLowerCase()) < 0) { tasks.getRange(1, tasks.getLastColumn() + 1).setValue(name).setFontWeight('bold'); th = headerIndex_(tasks); }
  });
  const C = {};
  ['project', 'task', 'assignee', 'status', 'due', 'priority', 'notes', 'designer id', 'publish'].forEach(function (k) { C[k] = colIdx_(th, k); });
  ['project', 'task', 'assignee', 'status', 'due', 'priority', 'notes'].forEach(function (k) {
    if (C[k] < 0) throw new Error('Tasks tab is missing the "' + k + '" column.');
  });

  const dsh = SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID).getSheetByName(CONFIG.DESIGNER_TAB);
  if (!dsh) throw new Error('Designer tab not found: ' + CONFIG.DESIGNER_TAB);
  const dv = dsh.getDataRange().getValues();
  if (dv.length < 6) throw new Error('Designer tab looks empty (' + Math.max(0, dv.length - 1) + ' rows). Sync skipped to protect the Tasks sheet.');
  const dh = dv[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const D = {};
  ['task_id', 'publish_date', 'design_due', 'campaign', 'content', 'designer', 'status', 'priority'].forEach(function (k) { D[k] = dh.indexOf(k); });
  Object.keys(D).forEach(function (k) { if (D[k] < 0) throw new Error('Designer tab is missing the "' + k + '" column.'); });
  const designer = {};
  dv.slice(1).forEach(function (r) {
    const id = String(r[D.task_id]).trim();
    if (id) designer[id] = r;
  });

  backupTasksOncePerDay_();

  const rows = tasks.getDataRange().getValues();
  const width = tasks.getLastColumn();
  const seen = {};
  let updated = 0, added = 0, partial = false;
  const set = function (i, key, value) {
    if (C[key] < 0 || partial) return;
    if (Date.now() - t0 > SYNC_BUDGET_MS) { partial = true; return; }
    const cur = rows[i][C[key]];
    if (String(cur instanceof Date ? normDate_(cur) : cur).trim() === String(value).trim()) return;
    writeCell_(tasks, i + 1, C[key] + 1, value);
    updated++;
  };

  for (let i = 1; i < rows.length && !partial; i++) {
    const id = C['designer id'] >= 0 ? String(rows[i][C['designer id']] || '').trim() : '';
    if (!id) continue;
    seen[id] = true;
    const r = designer[id];
    if (!r) continue;
    const notes = String(rows[i][C.notes] || '');
    const managed = notes.indexOf(CONFIG.DESIGNER_NOTE) === 0 || notes.indexOf('CANCELLED') === 0;
    if (notes.indexOf('CANCELLED') === 0 && String(r[D.status]).trim().toLowerCase() !== 'cancelled') set(i, 'notes', CONFIG.DESIGNER_NOTE + ' ' + id);   // legacy marker
    const want = designerStatusToTask_(r[D.status]);          // includes Cancelled and Postponed
    const cur = String(rows[i][C.status] || '').trim();
    const keepOwn = TASKS_ONLY.indexOf(cur) >= 0 && want !== 'Done' && want !== 'Cancelled';   // these exist only on the Tasks sheet: do not wipe them
    if (want && !keepOwn) set(i, 'status', want);
    if (want === 'Cancelled') continue;
    if (managed) {
      set(i, 'task', String(r[D.content]).trim());
      set(i, 'assignee', String(r[D.designer]).trim());
      set(i, 'due', normDate_(r[D.design_due]));
      set(i, 'publish', normDate_(r[D.publish_date]));
    }
  }

  // Add designer tasks that are not in Tasks yet (skipped on a partial run: finish the updates first).
  const fresh = [];
  if (!partial) Object.keys(designer).forEach(function (id) {
    if (seen[id]) return;
    const r = designer[id];
    const status = String(r[D.status]).trim().toLowerCase();
    const publish = normDate_(r[D.publish_date]);
    const content = String(r[D.content]).trim();
    if (status === 'cancelled' || !content || !publish || publish < CONFIG.DESIGNER_FROM) return;
    const row = new Array(width).fill('');
    const put = function (key, value) { if (C[key] >= 0) row[C[key]] = String(value); };
    const pri = String(r[D.priority]).trim();
    put('project', designerProject_(r[D.campaign], content));
    put('task', content);
    put('assignee', String(r[D.designer]).trim());
    put('status', designerStatusToTask_(r[D.status]) || 'To do');
    put('due', normDate_(r[D.design_due]));
    put('priority', /^(high|medium|low)$/i.test(pri) ? pri.charAt(0).toUpperCase() + pri.slice(1).toLowerCase() : 'Medium');
    put('notes', CONFIG.DESIGNER_NOTE + ' ' + id);
    put('designer id', id);
    put('publish', publish);
    fresh.push(row);
  });
  for (let off = 0; off < fresh.length; off += 100) {            // chunks keep each write small
    const chunk = fresh.slice(off, off + 100);
    const target = tasks.getRange(tasks.getLastRow() + 1, 1, chunk.length, width);
    setTextValues_(target, chunk);                                // text only: no formulas
  }
  added = fresh.length;
  if (added || updated) { CacheService.getScriptCache().remove('rows'); CacheService.getScriptCache().remove('dfeed'); }   // dashboard sees the change straight away
  logSync_('sync', added, updated, partial ? 'PARTIAL: time budget reached, continues next run' : 'ok');
  Logger.log('Designer sync: ' + added + ' task(s) added, ' + updated + ' cell(s) updated' + (partial ? ' (partial)' : '') + '.');
  return { added: added, updated: updated, partial: partial };
}

/* ---------------- edits made directly in the sheets are copied to the other sheet straight away ---------------- */

// Status text typed in a sheet -> the dashboard's status (anything else is ignored)
function statusFromText_(v) {
  const k = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const map = { 'to do': 'To do', 'todo': 'To do', 'in progress': 'In progress', 'doing': 'In progress', 'review': 'Review', 'done': 'Done',
                'needs rework': 'Needs rework', 'rework': 'Needs rework', 'revision': 'Needs rework',
                'waiting approval': 'Waiting approval', 'waiting for approval': 'Waiting approval', 'awaiting approval': 'Waiting approval',
                'ready': 'Ready', 'ready to publish': 'Ready', 'scheduled': 'Ready',
                'blocked': 'Blocked', 'waiting for info': 'Waiting for info', 'waiting': 'Waiting for info', 'waiting for client': 'Waiting for info',
                'on hold': 'On hold', 'hold': 'On hold', 'paused': 'On hold',
                'postponed': 'Postponed', 'delayed': 'Postponed', 'cancelled': 'Cancelled', 'canceled': 'Cancelled' };
  return map[k] || '';
}

/**
 * Installable onEdit trigger on the TASKS sheet (see installEditSync). When someone changes a Status cell, the same status is
 * written to the Designer Automation sheet (matched by Designer ID, else a unique exact title match), so the two never disagree.
 * Edits made by the script itself never fire this, so there are no loops.
 */
function onTasksEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (sh.getName() !== CONFIG.TASKS_TAB) return;
    const th = headerIndex_(sh);
    const cS = colIdx_(th, 'status') + 1, cT = colIdx_(th, 'task') + 1, cD = colIdx_(th, 'designer id') + 1;
    if (!cS || e.range.getColumn() > cS || e.range.getColumn() + e.range.getNumColumns() - 1 < cS) return;
    const first = Math.max(2, e.range.getRow()), last = Math.min(e.range.getRow() + e.range.getNumRows() - 1, first + 199);
    withLock_(function () {
      const dsh = SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID).getSheetByName(CONFIG.DESIGNER_TAB);
      if (!dsh) return;
      const dv = dsh.getDataRange().getValues();
      const dh = dv[0].map(function (h) { return String(h).trim().toLowerCase(); });
      const dId = dh.indexOf('task_id'), dSt = dh.indexOf('status'), dCo = dh.indexOf('content');
      if (dId < 0 || dSt < 0) return;
      for (let r = first; r <= last; r++) {
        const status = statusFromText_(sh.getRange(r, cS).getValue());
        if (!status) continue;
        if (last - first < 3) {                       // a few rows at most: never mass-mail from a paste
          const oldText = e.oldValue !== undefined && e.range.getNumRows() === 1 ? statusFromText_(e.oldValue) : '';
          if (oldText !== status) {
            const cA = colIdx_(th, 'assignee') + 1, cP = colIdx_(th, 'project') + 1, cN = colIdx_(th, 'status note') + 1, cU = colIdx_(th, 'due') + 1;
            notifyStatus_({ title: String(sh.getRange(r, cT).getValue() || ''), project: cP ? String(sh.getRange(r, cP).getValue() || '') : '',
                            assignee: cA ? String(sh.getRange(r, cA).getValue() || '') : '', from: oldText, to: status,
                            note: cN ? String(sh.getRange(r, cN).getValue() || '') : '', newDue: status === 'Postponed' && cU ? String(sh.getRange(r, cU).getValue() || '') : '', source: 'typed in the Tasks sheet' });
          }
        }
        let did = cD ? String(sh.getRange(r, cD).getValue() || '').trim() : '';
        let hit = -1;
        for (let i = 1; i < dv.length && did && hit < 0; i++) if (String(dv[i][dId]).trim() === did) hit = i;
        if (!did && dCo >= 0 && cT) {
          const title = String(sh.getRange(r, cT).getValue() || '').trim().toLowerCase();
          const found = [];
          for (let i = 1; i < dv.length; i++) if (title && String(dv[i][dCo]).trim().toLowerCase() === title) found.push(i);
          if (found.length === 1) hit = found[0];
        }
        if (hit < 0) continue;
        const cur = String(dv[hit][dSt]).trim();
        if (cur.toLowerCase() === 'cancelled' || designerStatusToTask_(cur) === status) continue;
        const out = DESIGNER_STATUS_OUT[status];
        if (!out || status === 'Postponed') continue;     // Blocked has no designer status; Postponed needs a new date, so use the dashboard
        safeSet_(dsh, hit + 1, dSt + 1, out);
        auditLog_('sheet edit', String(dv[hit][dId]), cur, status, 'tasks sheet -> designer sheet');
      }
      CacheService.getScriptCache().remove('rows'); CacheService.getScriptCache().remove('dfeed');
    }, 20000);
  } catch (err) {
    logSync_('onTasksEdit', 0, 0, 'ERROR: ' + String(err && err.message || err));
  }
}

/** Installable onEdit trigger on the DESIGNER sheet: a Status change there is copied to the matching Tasks row at once. */
function onDesignerEdit(e) {
  try {
    if (!e || !e.range) return;
    const dsh = e.range.getSheet();
    if (dsh.getName() !== CONFIG.DESIGNER_TAB) return;
    const dh = headerIndex_(dsh);
    const cS = dh.indexOf('status') + 1, cI = dh.indexOf('task_id') + 1;
    if (!cS || !cI || e.range.getColumn() > cS || e.range.getColumn() + e.range.getNumColumns() - 1 < cS) return;
    const first = Math.max(2, e.range.getRow()), last = Math.min(e.range.getRow() + e.range.getNumRows() - 1, first + 199);
    withLock_(function () {
      const tasks = tasksSheet_();
      const th = headerIndex_(tasks);
      const tS = colIdx_(th, 'status') + 1, tD = colIdx_(th, 'designer id') + 1;
      if (!tS || !tD) return;
      const tv = tasks.getDataRange().getValues();
      for (let r = first; r <= last; r++) {
        const id = String(dsh.getRange(r, cI).getValue() || '').trim();
        const want = designerStatusToTask_(dsh.getRange(r, cS).getValue());
        if (!id || !want) continue;
        for (let i = 1; i < tv.length; i++) {
          if (String(tv[i][tD - 1]).trim() !== id || String(tv[i][tS - 1]).trim() === want) continue;
          writeCell_(tasks, i + 1, tS, want);
          auditLog_('sheet edit', id, String(tv[i][tS - 1]), want, 'designer sheet -> tasks sheet');
        }
      }
      CacheService.getScriptCache().remove('rows'); CacheService.getScriptCache().remove('dfeed');
    }, 20000);
  } catch (err) {
    logSync_('onDesignerEdit', 0, 0, 'ERROR: ' + String(err && err.message || err));
  }
}

/** Run once (and approve the permissions): copies a Status typed in the Tasks sheet to the Designer sheet, and the other way round, instantly. */
function installEditSync() {
  removeEditSync();
  ScriptApp.newTrigger('onTasksEdit').forSpreadsheet(ss_()).onEdit().create();
  ScriptApp.newTrigger('onDesignerEdit').forSpreadsheet(SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID)).onEdit().create();
  Logger.log('Edit sync installed: Tasks and Designer statuses now follow each other when edited.');
}
function removeEditSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const h = t.getHandlerFunction();
    if (h === 'onTasksEdit' || h === 'onDesignerEdit') ScriptApp.deleteTrigger(t);
  });
}

/* ---------------- safety helpers ---------------- */

function withLock_(fn, waitMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) throw new Error('Busy: another update is running. Try again in a moment.');
  try { return fn(); } finally { try { lock.releaseLock(); } catch (_) {} }
}

// Google "typed columns" (a Table with a dropdown / date / number column type) only accept values of that type. When they refuse,
// say exactly which column and value, and what to change, instead of Google's bare "not allowed on cells in typed columns".
function typedHint_(err, sh, col, value) {
  const m = String(err && err.message || err);
  if (!/typed column/i.test(m)) return m;
  let head = '';
  try { head = String(sh.getRange(1, col).getValue()); } catch (_) {}
  return 'The "' + head + '" column of the "' + sh.getName() + '" sheet is a typed column (a table dropdown, date or number column) and refused "' +
    String(value == null ? '' : value).slice(0, 40) + '". Click that column\'s header → Column type → Dropdown and add this value (or set the column type to Plain text). Google said: ' + m;
}
// setValue that explains a typed-column refusal.
function safeSet_(sh, row, col, value) {
  try { sh.getRange(row, col).setValue(value); }
  catch (err) { throw new Error(typedHint_(err, sh, col, value)); }
}
// Plain text wherever the sheet allows it. A typed column refuses a number format ("You can't set the number format of cells in a
// typed column"), so then the value itself is made formula-safe instead.
function safeText_(v) {
  const t = String(v == null ? '' : v);
  return /^[=+\-@]/.test(t) && !/^[-+]?\d[\d.,]*$/.test(t) ? "'" + t : t;
}
function setTextValues_(range, values) {
  let asText = true;
  try { range.setNumberFormat('@'); } catch (_) { asText = false; }
  const out = values.map(function (row) { return row.map(function (v) { return asText ? String(v == null ? '' : v) : safeText_(v); }); });
  try { range.setValues(out); }
  catch (err) {
    const m = String(err && err.message || err);
    if (!/typed column/i.test(m)) throw err;
    const sh = range.getSheet();
    if (out.length === 1 && out[0].length === 1) throw new Error(typedHint_(err, sh, range.getColumn(), out[0][0]));
    throw new Error('A typed column of the "' + sh.getName() + '" sheet refused a value while a row was being written (' + m + '). Check the column types of that sheet (header → Column type), or set them to Plain text.');
  }
}
function writeCell_(sh, row, col, value) {
  setTextValues_(sh.getRange(row, col), [[value]]);
}

function logTab_(name, header) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold'); sh.setFrozenRows(1); }
  return sh;
}
function appendLog_(name, header, values) {
  try {
    const sh = logTab_(name, header);
    sh.appendRow(values.map(function (v) { return String(v == null ? '' : v).replace(/^([=+\-@])/, "'$1"); }));
    if (sh.getLastRow() > LOG_KEEP + 100) sh.deleteRows(2, 100);   // drop the oldest 100 rows
  } catch (_) {}   // logging must never break the real work
}
function logSync_(source, added, updated, note) {
  appendLog_('Sync log', ['Time', 'Source', 'Added', 'Updated', 'Note'], [Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'), source, added, updated, note]);
}
function auditLog_(device, task, from, to, where) {
  appendLog_('Audit log', ['Time', 'Device', 'Task', 'From', 'To', 'Where'], [Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'), device, task, from, to, where]);
}

/** One copy of the Tasks tab per day ("Backup yyyy-MM-dd") before the sync writes; the newest BACKUP_KEEP are kept. */
function backupTasksOncePerDay_() {
  try {
    const ss = ss_();
    const name = 'Backup ' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
    if (ss.getSheetByName(name)) return;
    const copy = tasksSheet_().copyTo(ss);
    copy.setName(name);
    const backups = ss.getSheets().filter(function (x) { return /^Backup \d{4}-\d{2}-\d{2}$/.test(x.getName()); })
      .sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
    backups.slice(BACKUP_KEEP).forEach(function (x) { ss.deleteSheet(x); });
  } catch (err) {
    logSync_('backup', 0, 0, 'backup failed: ' + String(err && err.message || err));
  }
}

// Email the script owner about a problem, at most once a day per subject.
function notifyOwner_(subject, body) {
  try {
    const props = PropertiesService.getScriptProperties();
    const key = 'notified_' + subject.replace(/\W+/g, '_');
    const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
    if (props.getProperty(key) === today || MailApp.getRemainingDailyQuota() < 1) return;
    props.setProperty(key, today);
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '[Marketing Hub] ' + subject, body);
  } catch (_) {}
}

/* ---------------- health check ---------------- */

/** Used by ?action=health (booleans only) and by selfTest() (with details in the log). */
function healthReport_(detail) {
  const checks = [];
  const run = function (name, fn) {
    try { const note = fn(); checks.push({ name: name, ok: true, note: note || '' }); }
    catch (err) { checks.push({ name: name, ok: false, note: String(err && err.message || err) }); }
  };
  run('Tasks tab and columns', function () {
    const h = headerIndex_(tasksSheet_());
    ['project', 'task', 'assignee', 'status', 'due', 'priority', 'notes'].forEach(function (k) { if (colIdx_(h, k) < 0) throw new Error('missing column: ' + k); });
    ['designer id', 'publish', 'request id'].forEach(function (k) { if (colIdx_(h, k) < 0) throw new Error('column "' + k + '" missing - run setup()'); });
    return 'ok';
  });
  run('Status editing enabled (EDIT_PASSCODE)', function () {
    if (!PropertiesService.getScriptProperties().getProperty('EDIT_PASSCODE')) throw new Error('EDIT_PASSCODE not set');
  });
  run('Designer sheet readable', function () {
    const sh = SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID).getSheetByName(CONFIG.DESIGNER_TAB);
    if (!sh) throw new Error('tab not found');
    return (sh.getLastRow() - 1) + ' rows';
  });
  run('Designer sync scheduled', function () {
    if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncFromDesigner'; })) throw new Error('not scheduled - run installDesignerSync()');
  });
  run('Edit sync installed (status edits copy between sheets)', function () {
    const hs = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    if (hs.indexOf('onTasksEdit') < 0 || hs.indexOf('onDesignerEdit') < 0) throw new Error('not installed - run installEditSync()');
  });
  run('Calendar readable', function () {
    const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
    if (!cal) throw new Error('calendar not found: ' + CONFIG.CALENDAR_ID);
    return cal.getEvents(new Date(), new Date(Date.now() + 30 * 86400000)).length + ' events in the next 30 days';
  });
  run('Status emails', function () {
    if (!CONFIG.NOTIFY_ON_STATUS) throw new Error('switched off (CONFIG.NOTIFY_ON_STATUS)');
    if (/^REPLACE_/i.test(CONFIG.MANAGER_EMAIL)) throw new Error('MANAGER_EMAIL not set');
    return 'on for: ' + CONFIG.NOTIFY_STATUSES.join(', ');
  });
  run('Email quota', function () {
    const q = MailApp.getRemainingDailyQuota();
    if (q < 10) throw new Error('only ' + q + ' emails left today');
    return q + ' left today';
  });
  run('Email addresses configured', function () {
    const bad = [CONFIG.MANAGER_EMAIL].concat(Object.keys(CONFIG.PEOPLE).map(function (k) { return CONFIG.PEOPLE[k].email; })).filter(function (e) { return /^REPLACE_/.test(e); });
    if (bad.length) throw new Error('still placeholders: ' + bad.length);
  });
  const all = checks.every(function (c) { return c.ok; });
  return detail ? { ok: all, version: SCRIPT_VERSION, checks: checks }
                : { ok: true, healthy: all, version: SCRIPT_VERSION, checks: checks.map(function (c) { return { name: c.name, ok: c.ok }; }) };
}

/** Run from the editor after pasting a new version: logs a plain-English checklist of what works and what needs attention. */
function selfTest() {
  const rep = healthReport_(true);
  Logger.log('Marketing Hub script ' + rep.version + ' — ' + (rep.ok ? 'ALL GOOD' : 'NEEDS ATTENTION'));
  rep.checks.forEach(function (c) { Logger.log((c.ok ? '✔ ' : '✘ ') + c.name + (c.note ? ' — ' + c.note : '')); });
  return rep;
}

/** Run once: creates a time trigger that calls syncFromDesigner() every DESIGNER_SYNC_MINUTES minutes. */
function installDesignerSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncFromDesigner') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncFromDesigner').timeBased().everyMinutes(CONFIG.DESIGNER_SYNC_MINUTES).create();
  Logger.log('Designer sync scheduled every ' + CONFIG.DESIGNER_SYNC_MINUTES + ' minutes.');
}

/** Stops the automatic sync (the tasks already in the sheet stay as they are). */
function removeDesignerSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncFromDesigner') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Designer sync switched off.');
}

/**
 * The Tasks sheet's Status dropdown only allows the values it was created with, so typing a newer status
 * (Blocked, Needs rework ...) would be flagged as invalid. This widens the dropdown to every status the dashboard uses.
 * It never fails setup: tables ("typed columns") may refuse a rule, in which case it says so and you can add the values to the dropdown by hand.
 */
function ensureStatusDropdown_() {
  try {
    const sh = tasksSheet_();
    const c = colIdx_(headerIndex_(sh), 'status');
    if (c < 0) return 'Status dropdown: Status column not found.';
    const range = sh.getRange(2, c + 1, Math.max(sh.getMaxRows() - 1, 1), 1);
    range.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUS_VALUES, true).setAllowInvalid(true).build());
    return 'Status dropdown widened to: ' + STATUS_VALUES.join(', ') + '.';
  } catch (err) {
    return 'Status dropdown NOT changed (' + String(err && err.message || err) + '). Add these values to it by hand: ' + STATUS_VALUES.join(', ') + '.';
  }
}

function step_(name, fn) {
  try { const out = fn(); Logger.log('✔ ' + name + (out ? ' — ' + out : '')); return out; }
  catch (err) { Logger.log('✘ ' + name + ' FAILED'); throw new Error('Setup step "' + name + '" failed: ' + String(err && err.message || err)); }
}

function setup() {
  const sh = tasksSheet_();
  step_('Add the extra Tasks columns', function () {
    const header = headerIndex_(sh);
    const added = [];
    EXTRA_TASK_COLS.forEach(function (name) {
      if (colIdx_(header, name.toLowerCase()) < 0) {
        sh.getRange(1, sh.getLastColumn() + 1).setValue(name).setFontWeight('bold');
        added.push(name);
      }
    });
    return added.length ? 'added ' + added.join(', ') : 'already there';
  });
  step_('Prepare the Requests tab', function () { requestsSheet_(); return 'ok'; });
  step_('Status dropdown', function () { return ensureStatusDropdown_(); });
  step_('Calendar permission', function () { CalendarApp.getDefaultCalendar(); return 'ok'; });
  const problems = [];
  if (/^REPLACE_/.test(CONFIG.MANAGER_EMAIL)) problems.push('MANAGER_EMAIL');
  Object.keys(CONFIG.PEOPLE).forEach(function (k) {
    if (/^REPLACE_/.test(CONFIG.PEOPLE[k].email)) problems.push('PEOPLE.' + k + '.email');
  });
  Logger.log(problems.length ? 'Sheet ready, but still fill in: ' + problems.join(', ') : 'Setup complete. Now run testTasksStatusColumn, then deploy as a web app.');
}

/**
 * Finds out which statuses the Tasks sheet's Status column REFUSES (a typed/dropdown column only accepts its own list).
 * It writes each status into the last Tasks row for a moment and then puts the original value back (script edits do not trigger anything).
 * Run it, read the log, then add every refused value to the column's dropdown (header → Column type → Dropdown).
 */
function testTasksStatusColumn() { return testStatusColumn_(tasksSheet_(), 'status', STATUS_VALUES, 'task'); }

/** Same for the Designer Automation sheet, with the statuses the script writes there. */
function testDesignerStatusColumn() {
  const sh = SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID).getSheetByName(CONFIG.DESIGNER_TAB);
  const out = Object.keys(DESIGNER_STATUS_OUT).map(function (k) { return DESIGNER_STATUS_OUT[k]; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  return testStatusColumn_(sh, 'status', out, 'task_id');
}

function testStatusColumn_(sh, statusHeader, values, anchorHeader) {
  const h = headerIndex_(sh);
  const cS = colIdx_(h, statusHeader) + 1, cA = colIdx_(h, anchorHeader) + 1;
  if (!cS || !cA) throw new Error('Columns "' + statusHeader + '" / "' + anchorHeader + '" not found in "' + sh.getName() + '".');
  let row = sh.getLastRow();
  while (row > 1 && !String(sh.getRange(row, cA).getValue()).trim()) row--;
  if (row < 2) throw new Error('"' + sh.getName() + '" has no data row to test on.');
  const cell = sh.getRange(row, cS);
  const original = cell.getValue();
  Logger.log('Testing "' + sh.getName() + '", Status column, row ' + row + ' (it currently holds "' + original + '"). It will be put back afterwards.');
  const refused = [], accepted = [];
  values.forEach(function (v) {
    try { cell.setValue(v); accepted.push(v); Logger.log('✔ accepted: ' + v); }
    catch (err) { refused.push(v); Logger.log('✘ refused: ' + v + '  —  ' + String(err && err.message || err)); }
  });
  let restored = true;
  try { cell.setValue(original); }
  catch (err) {
    restored = false;
    Logger.log('✘ COULD NOT PUT THE ORIGINAL VALUE BACK in "' + sh.getName() + '" row ' + row + ' column ' + cS + ' — please type "' + original + '" there by hand. Google said: ' + String(err && err.message || err));
  }
  if (restored) Logger.log('Original value "' + original + '" restored.');
  if (refused.length && !accepted.length) {
    Logger.log('➜ The script is not allowed to write ANY value into this column (it is a typed table column). Fix: click the column header → Column type → Plain text (or Dropdown that includes the values), or turn the table into a normal range (select the table → Format → Convert to range). Then run this test again.');
  } else if (refused.length) {
    Logger.log('➜ Add the refused values to the column dropdown (click the column header → Column type → Dropdown), then run this test again.');
  } else {
    Logger.log('✔ The Status column accepts every status the script writes.');
  }
  return { row: row, refused: refused, accepted: accepted, restored: restored };
}

/**
 * Read-mostly diagnosis of the typed ("table") columns the script writes to, on the Tasks and Designer sheets.
 * For each important column it reports the dropdown values (if any) and whether the script may write there — by writing the
 * cell's CURRENT value back (no change). Cells that hold formulas are skipped. Run it and send me the whole log.
 */
function diagnoseTypedColumns() {
  const targets = [
    [tasksSheet_(), ['status', 'task', 'due', 'status note', 'designer id', 'notes', 'assignee']],
    [SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID).getSheetByName(CONFIG.DESIGNER_TAB), ['status', 'design_due', 'content', 'requested_design_due', 'deadline_request_status']]
  ];
  targets.forEach(function (t) {
    const sh = t[0];
    if (!sh) { Logger.log('✘ sheet not found'); return; }
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (x) { return String(x).trim(); });
    let row = sh.getLastRow();
    Logger.log('--- "' + sh.getName() + '" (testing on row ' + row + ') ---');
    t[1].forEach(function (name) {
      const c = colIdx_(head.map(function (x) { return x.toLowerCase(); }), name);
      if (c < 0) { Logger.log('· ' + name + ': column not found'); return; }
      const cell = sh.getRange(row, c + 1);
      let dd = 'no dropdown rule';
      try {
        const rule = cell.getDataValidation();
        if (rule) {
          const vals = rule.getCriteriaValues();
          dd = rule.getCriteriaType() + (vals && vals[0] && vals[0].map ? ': ' + vals[0].slice(0, 14).join(', ') : '');
        }
      } catch (e) { dd = 'rule unreadable'; }
      let write;
      try {
        if (String(cell.getFormula() || '')) write = 'skipped (formula)';
        else { cell.setValue(cell.getValue()); write = 'script CAN write'; }
      } catch (err) { write = 'script CANNOT write — ' + String(err && err.message || err); }
      Logger.log('· ' + head[c] + ' (column ' + (c + 1) + '): ' + write + ' | ' + dd);
    });
  });
  Logger.log('Send me this whole log.');
}

/** Run to check the email path: sends one test message to the manager only. */
function testEmail() {
  MailApp.sendEmail({
    to: CONFIG.MANAGER_EMAIL, cc: CONFIG.ALWAYS_CC.join(','),
    subject: '[Marketing Request Desk] Test email',
    body: 'If you can read this, request emails are working. No action needed.'
  });
}
