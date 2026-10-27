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

  RATE_LIMIT_PER_HOUR: 10        // per requester email
};

// Columns the dashboard is allowed to read (header prefixes, lower case). Nothing else leaves the sheet.
const PUBLIC_COLS = ['project', 'task', 'assignee', 'status', 'due', 'priority', 'notes',
                     'type', 'requested', 'hours', 'affects', 'request id'];
// Columns this script needs on the Tasks tab (added by setup() if missing).
const EXTRA_TASK_COLS = ['Type', 'Requested by', 'Hours', 'Affects', 'Request ID'];
const REQUEST_COLS = ['Request ID', 'Client ID', 'Submitted', 'Requester', 'Email', 'Department', 'Contact',
  'Request type', 'Title', 'Description', 'Details', 'Links', 'Deadline', 'Urgency', 'Urgent reason',
  'Priority', 'Assignee', 'Est. hours', 'Related project', 'Email status', 'Calendar'];

/* ---------------- web app entry points ---------------- */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'tasks';
  try {
    if (action === 'ping') return json_({ ok: true, time: new Date().toISOString() });
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
