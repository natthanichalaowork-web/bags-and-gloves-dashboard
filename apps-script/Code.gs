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

// Columns the dashboard is allowed to read (header prefixes, lower case). Nothing else leaves the sheet.
const PUBLIC_COLS = ['project', 'task', 'assignee', 'status', 'due', 'priority', 'notes',
                     'type', 'requested', 'hours', 'affects', 'request id', 'designer id', 'publish'];
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

const EXTRA_TASK_COLS = ['Type', 'Requested by', 'Hours', 'Affects', 'Request ID', 'Designer ID', 'Publish date'];
const REQUEST_COLS = ['Request ID', 'Client ID', 'Submitted', 'Requester', 'Email', 'Department', 'Contact',
  'Request type', 'Title', 'Description', 'Details', 'Links', 'Deadline', 'Urgency', 'Urgent reason',
  'Priority', 'Assignee', 'Est. hours', 'Related project', 'Email status', 'Calendar'];

/* ---------------- web app entry points ---------------- */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'tasks';
  try {
    if (action === 'ping') return json_({ ok: true, time: new Date().toISOString() });
    if (action === 'calendar') return json_({ ok: true, events: calendarRows_(), serverTime: new Date().toISOString() });
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
    const body = JSON.parse(e.postData.contents);
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


/* ---------------- changing a task's status from the dashboard ---------------- */

const STATUS_VALUES = ['To do', 'In progress', 'Review', 'Done'];
// Dashboard status -> designer sheet status (for tasks that live in the Designer Automation sheet)
const DESIGNER_STATUS_OUT = { 'To do': 'Briefed', 'In progress': 'In Design', 'Review': 'Draft Submitted', 'Done': 'Approved' };

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
  const fails = Number(cache.get('pwfail') || 0);
  if (fails >= 10) return { ok: false, error: 'Too many wrong passcodes. Try again in 10 minutes.' };
  if (want !== real) {
    try { cache.put('pwfail', String(fails + 1), 600); } catch (_) {}
    return { ok: false, error: 'Wrong passcode.', code: 'passcode' };
  }
  const status = String(b.status || '');
  if (STATUS_VALUES.indexOf(status) < 0) return { ok: false, error: 'Unknown status.' };

  const tasks = tasksSheet_();
  const th = headerIndex_(tasks);
  const C = { status: colIdx_(th, 'status'), title: colIdx_(th, 'task'), project: colIdx_(th, 'project'),
              rid: colIdx_(th, 'request id'), did: colIdx_(th, 'designer id') };
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
    if (hits.length === 1) row = hits[0];
    else if (hits.length > 1) return { ok: false, error: 'More than one task has this name; change it in the sheet.' };
  }

  let designerDone = false;
  if (did) {
    const out = DESIGNER_STATUS_OUT[status];
    const dsh = SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID).getSheetByName(CONFIG.DESIGNER_TAB);
    const dv = dsh.getDataRange().getValues();
    const dh = dv[0].map(function (h) { return String(h).trim().toLowerCase(); });
    const dId = dh.indexOf('task_id'), dSt = dh.indexOf('status');
    for (let i = 1; i < dv.length; i++) {
      if (String(dv[i][dId]).trim() !== did) continue;
      if (String(dv[i][dSt]).trim().toLowerCase() === 'cancelled') return { ok: false, error: 'This designer task is cancelled.' };
      dsh.getRange(i + 1, dSt + 1).setValue(out);
      designerDone = true;
      break;
    }
    if (!designerDone && row < 0) return { ok: false, error: 'Task not found in the designer sheet.' };
  }
  if (row >= 0) tasks.getRange(row + 1, C.status + 1).setValue(status);
  else if (!designerDone) return { ok: false, error: 'Task not found in the Tasks sheet.' };
  cache.remove('rows');
  return { ok: true, where: designerDone ? 'designer' : 'tasks', status: status };
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
  target.setNumberFormat('@');                                     // text only: no formulas, dates stay yyyy-mm-dd
  target.setValues([row.map(safe_)]);

  // 2. Private full log.
  const log = [id, r.clientId, Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'), r.name, r.email,
    r.dept, r.contact, r.typeLabel, r.title, r.description, details, r.links, r.deadline, r.urgency,
    r.urgentReason, r.priority, person.name, r.estHours, r.affects, 'pending', 'pending'];
  const lr = requests.getRange(requests.getLastRow() + 1, 1, 1, REQUEST_COLS.length);
  lr.setNumberFormat('@');
  lr.setValues([log.map(safe_)]);
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
  if (c >= 0) sh.getRange(row, c + 1).setValue(value);
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
  for (let i = 0; i < vals.length; i++) if (String(vals[i][c]) === value) return { id: String(vals[i][0]) };
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
    case 'draft submitted': case 'draft': case 'revision': case 'deadline change requested': return 'Review';
    case 'approved': case 'scheduled': case 'published': return 'Done';
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
 *  - ADD:    every designer row published on/after DESIGNER_FROM that is not cancelled and not yet in Tasks becomes a task row
 *            (project, assignee, due = Design_Due, priority, publish date, Designer ID).
 *  - UPDATE: rows created by the sync (Notes start with DESIGNER_NOTE) follow the designer sheet for status, due, assignee, title and publish date.
 *            Rows you linked by hand (typed a Designer ID yourself) only get their Status updated; your wording is kept.
 *  - A linked row whose designer task is cancelled is marked "CANCELLED ·" in Notes (the dashboard hides it).
 * Run once by hand to test, and run installDesignerSync() once to keep it running automatically.
 */
function syncFromDesigner() {
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
  const dh = dv[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const D = {};
  ['task_id', 'publish_date', 'design_due', 'campaign', 'content', 'designer', 'status', 'priority'].forEach(function (k) { D[k] = dh.indexOf(k); });
  Object.keys(D).forEach(function (k) { if (D[k] < 0) throw new Error('Designer tab is missing the "' + k + '" column.'); });
  const designer = {};
  dv.slice(1).forEach(function (r) {
    const id = String(r[D.task_id]).trim();
    if (id) designer[id] = r;
  });

  const rows = tasks.getDataRange().getValues();
  const width = tasks.getLastColumn();
  const seen = {};
  let updated = 0, added = 0;
  const set = function (i, key, value) {
    if (C[key] < 0) return;
    const cur = rows[i][C[key]];
    if (String(cur instanceof Date ? normDate_(cur) : cur).trim() === String(value).trim()) return;
    tasks.getRange(i + 1, C[key] + 1).setValue(value);
    updated++;
  };

  for (let i = 1; i < rows.length; i++) {
    const id = C['designer id'] >= 0 ? String(rows[i][C['designer id']] || '').trim() : '';
    if (!id) continue;
    seen[id] = true;
    const r = designer[id];
    if (!r) continue;
    const notes = String(rows[i][C.notes] || '');
    const managed = notes.indexOf(CONFIG.DESIGNER_NOTE) === 0 || notes.indexOf('CANCELLED') === 0;
    if (String(r[D.status]).trim().toLowerCase() === 'cancelled') {
      if (notes.indexOf('CANCELLED') !== 0) set(i, 'notes', 'CANCELLED · ' + notes);
      continue;
    }
    if (notes.indexOf('CANCELLED') === 0) set(i, 'notes', CONFIG.DESIGNER_NOTE + ' ' + id);   // un-cancelled
    const want = designerStatusToTask_(r[D.status]);
    if (want) set(i, 'status', want);
    if (managed) {
      set(i, 'task', String(r[D.content]).trim());
      set(i, 'assignee', String(r[D.designer]).trim());
      set(i, 'due', normDate_(r[D.design_due]));
      set(i, 'publish', normDate_(r[D.publish_date]));
    }
  }

  // Add designer tasks that are not in Tasks yet.
  const fresh = [];
  Object.keys(designer).forEach(function (id) {
    if (seen[id]) return;
    const r = designer[id];
    const status = String(r[D.status]).trim().toLowerCase();
    const publish = normDate_(r[D.publish_date]);
    const content = String(r[D.content]).trim();
    if (status === 'cancelled' || !content || !publish || publish < CONFIG.DESIGNER_FROM) return;
    const row = new Array(width).fill('');
    const put = function (key, value) { if (C[key] >= 0) row[C[key]] = value; };
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
  if (fresh.length) {
    tasks.getRange(tasks.getLastRow() + 1, 1, fresh.length, width).setValues(fresh);
    added = fresh.length;
  }
  if (added || updated) CacheService.getScriptCache().remove('rows');   // dashboard sees the change straight away
  Logger.log('Designer sync: ' + added + ' task(s) added, ' + updated + ' cell(s) updated.');
  return { added: added, updated: updated };
}

/** Run once: creates a time trigger that calls syncFromDesigner() every DESIGNER_SYNC_MINUTES minutes. */
function installDesignerSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncFromDesigner') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncFromDesigner').timeBased().everyMinutes(CONFIG.DESIGNER_SYNC_MINUTES).create();
  Logger.log('Designer sync scheduled every ' + CONFIG.DESIGNER_SYNC_MINUTES + ' minutes.');
}

function setup() {
  const sh = tasksSheet_();
  const header = headerIndex_(sh);
  EXTRA_TASK_COLS.forEach(function (name) {
    if (colIdx_(header, name.toLowerCase()) < 0) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue(name).setFontWeight('bold');
    }
  });
  requestsSheet_();
  CalendarApp.getDefaultCalendar();   // triggers the Calendar permission prompt
  const problems = [];
  if (/^REPLACE_/.test(CONFIG.MANAGER_EMAIL)) problems.push('MANAGER_EMAIL');
  Object.keys(CONFIG.PEOPLE).forEach(function (k) {
    if (/^REPLACE_/.test(CONFIG.PEOPLE[k].email)) problems.push('PEOPLE.' + k + '.email');
  });
  Logger.log(problems.length ? 'Sheet ready, but still fill in: ' + problems.join(', ') : 'Setup complete. Now deploy as a web app.');
}

/** Run to check the email path: sends one test message to the manager only. */
function testEmail() {
  MailApp.sendEmail({
    to: CONFIG.MANAGER_EMAIL, cc: CONFIG.ALWAYS_CC.join(','),
    subject: '[Marketing Request Desk] Test email',
    body: 'If you can read this, request emails are working. No action needed.'
  });
}
