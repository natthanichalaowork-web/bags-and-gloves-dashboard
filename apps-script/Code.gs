/**
 * Bags and Gloves — Marketing Request Desk backend (Google Apps Script web app).
 *
 * Two kinds of caller:
 *   PUBLIC  (anyone with the request page link)  POST {action:'submit', ...}  a request from the public form:
 *             1. logs the full request in the private "Requests" tab
 *             2. adds a task row to the Tasks tab
 *             3. emails the assignee, CC marketing manager + marketing@bagglove.com, BCC the whole team
 *             4. adds an all-day event on the deadline to the assignee's Google Calendar
 *           The server decides WHO handles it (CONFIG.ROUTING + current workload); the page cannot choose.
 *   TEAM    (Google sign-in, checked here)       POST {action:'tasks'|'data', idToken}  the internal dashboard feeds.
 *           The ID token is verified with Google, must be issued for CONFIG.GOOGLE_CLIENT_ID, and the email must be on
 *           CONFIG.ALLOWED_VIEWERS. Anything else is refused, so no internal data is ever public.
 *
 * Settings live in Config.gs and Snapshot.gs (private: keep them out of the public repository). See SETUP.md.
 */

// Columns the team dashboard may read (header prefixes, lower case). Nothing else leaves the sheet, and only after sign-in.
const DASHBOARD_COLS = ['project', 'task', 'assignee', 'status', 'due', 'priority', 'notes',
                     'type', 'requested', 'hours', 'affects', 'request id'];
// Columns this script needs on the Tasks tab (added by setup() if missing).
const EXTRA_TASK_COLS = ['Type', 'Requested by', 'Hours', 'Affects', 'Request ID'];
const REQUEST_COLS = ['Request ID', 'Client ID', 'Submitted', 'Requester', 'Email', 'Department', 'Contact',
  'Request type', 'Title', 'Description', 'Details', 'Links', 'Deadline', 'Urgency', 'Urgent reason',
  'Priority', 'Assignee', 'Est. hours', 'Related project', 'Email status', 'Calendar'];

/* ---------------- web app entry points ---------------- */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'ping') return json_({ ok: true, time: new Date().toISOString() });
  return json_({ ok: false, error: 'Not found' });      // internal feeds are POST-only and need a verified sign-in
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  const action = (body && body.action) || 'submit';
  try {
    if (action === 'submit') return json_(withLock_(function () { return submit_(body); }));
    if (action === 'tasks') {
      viewerEmail_(body.idToken);
      return json_({ ok: true, rows: taskRows_(), serverTime: new Date().toISOString() });
    }
    if (action === 'data') {
      viewerEmail_(body.idToken);
      return json_({ ok: true, designer: designerRows_(), events: calendarEvents_(), snapshot: snapshot_() });
    }
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    if (err && err.authCode) return json_({ ok: false, code: err.authCode, error: err.message, email: err.viewer || '' });
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { try { lock.releaseLock(); } catch (_) {} }
}

/* ---------------- who is allowed in ---------------- */

function authError_(code, message, viewer) {
  const err = new Error(message); err.authCode = code; err.viewer = viewer || ''; return err;
}

/** Verifies a Google ID token and returns the signed-in email, or throws an auth error. Fails closed. */
function viewerEmail_(idToken) {
  if (!CONFIG.GOOGLE_CLIENT_ID || /^REPLACE_/.test(CONFIG.GOOGLE_CLIENT_ID) || !CONFIG.ALLOWED_VIEWERS || !CONFIG.ALLOWED_VIEWERS.length) {
    throw authError_('config', 'Sign-in is not configured');
  }
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) throw authError_('signin', 'Please sign in');
  const cache = CacheService.getScriptCache();
  const key = 'tok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  let email = cache.get(key);
  if (!email) {
    const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw authError_('expired', 'Session expired');
    let t;
    try { t = JSON.parse(res.getContentText()); } catch (err) { throw authError_('signin', 'Invalid sign-in'); }
    if (t.aud !== CONFIG.GOOGLE_CLIENT_ID) throw authError_('signin', 'Invalid sign-in');
    if (t.iss !== 'accounts.google.com' && t.iss !== 'https://accounts.google.com') throw authError_('signin', 'Invalid sign-in');
    if (String(t.email_verified) !== 'true' || !t.email) throw authError_('signin', 'Invalid sign-in');
    if (Number(t.exp) * 1000 < Date.now()) throw authError_('expired', 'Session expired');
    email = String(t.email).toLowerCase();
    cache.put(key, email, 300);            // a verified token is trusted for 5 minutes; the allow-list below is checked every call
  }
  const allowed = CONFIG.ALLOWED_VIEWERS.map(function (e) { return String(e).toLowerCase(); });
  if (allowed.indexOf(email) < 0) throw authError_('denied', 'Not on the team list', email);
  return email;
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
    if (DASHBOARD_COLS.some(function (p) { return l.indexOf(p) === 0; })) keep.push(i);
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

/* ---------------- internal feeds (team only) ---------------- */

/** Chunked CacheService helpers: one cache value is limited to ~100 KB, these feeds are bigger. */
function cacheGet_(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(key + ':n') || 0);
  if (!n) return null;
  const parts = [];
  for (let i = 0; i < n; i++) { const p = c.get(key + ':' + i); if (p == null) return null; parts.push(p); }
  try { return JSON.parse(parts.join('')); } catch (e) { return null; }
}
function cachePut_(key, obj, seconds) {
  const c = CacheService.getScriptCache(), s = JSON.stringify(obj), size = 30000, all = {};
  let n = 0;
  for (let i = 0; i < s.length; i += size) { all[key + ':' + n] = s.slice(i, i + size); n++; }
  all[key + ':n'] = String(n);
  try { c.putAll(all, seconds); } catch (e) { /* too big or quota: just skip caching */ }
}

/** Any date cell → 'yyyy-mm-dd' or ''. Understands Date objects, 2026-10-15, 15/10/2026, "15 Oct 2026", Thai Buddhist years. */
function dayIso_(v, tz) {
  if (v === '' || v == null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz || CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  const s = String(v).trim(), months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/), y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})$/)) && months[m[2].toLowerCase()]) { d = +m[1]; mo = months[m[2].toLowerCase()]; y = +m[3]; }
  else return '';
  if (y > 2400) y -= 543;
  const chk = new Date(y, mo - 1, d);
  if (chk.getFullYear() !== y || chk.getMonth() !== mo - 1 || chk.getDate() !== d) return '';
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
}

/** Designer Automation sheet → only the columns the dashboard needs. Cancelled rows and rows before DESIGNER_FROM are dropped. */
function designerRows_() {
  const hit = cacheGet_('designer');
  if (hit) return hit;
  const src = SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID);
  const sh = CONFIG.DESIGNER_TAB ? src.getSheetByName(CONFIG.DESIGNER_TAB) : src.getSheets()[0];
  const values = sh.getDataRange().getValues(), tz = src.getSpreadsheetTimeZone();
  const header = values[0].map(function (x) { return String(x).trim().toLowerCase(); });
  const want = ['Task_ID', 'Publish_Date', 'Design_Due', 'Campaign', 'Content', 'Designer', 'Status', 'Priority'];
  const ix = want.map(function (n) { return header.indexOf(n.toLowerCase()); });
  if (ix.some(function (i) { return i < 0; })) throw new Error('Designer sheet is missing a column the dashboard needs');
  const out = [want];
  for (let i = 1; i < values.length; i++) {
    const r = values[i], status = String(r[ix[6]] || '').trim().toLowerCase();
    if (status === 'cancelled' || status === 'canceled') continue;
    const title = String(r[ix[4]] || '').trim(), publish = dayIso_(r[ix[1]], tz);
    if (!title || !publish || publish < CONFIG.DESIGNER_FROM) continue;
    out.push([String(r[ix[0]] || '').trim(), publish, dayIso_(r[ix[2]], tz), String(r[ix[3]] || ''), title,
              String(r[ix[5]] || '').trim(), String(r[ix[6]] || '').trim(), String(r[ix[7]] || '').trim()]);
  }
  cachePut_('designer', out, 60);
  return out;
}

/** Calendar colours/prefixes → the dashboard's categories. */
function eventCategory_(title, colorId) {
  const t = String(title || '').trim();
  if (t.indexOf('PREP') === 0 || t.indexOf('[PREP]') === 0) return 'prep';
  if (t.indexOf('POST') === 0 || t.indexOf('Website Article') >= 0) return 'content';
  if (/^\[(LINE|LINE Broadcast)\]/.test(t)) return 'line';
  if (/^\[(Designer Deadline|DESIGN DUE)\]/i.test(t)) return 'deadline';
  if (/^\[(PROOF|TEASER|CEO|WOON|RECAP)/.test(t)) return 'ceo';
  if (/^\[(HOUSE|LAUNCH)\]/.test(t)) return 'house';
  if (/^\[(10\.10|ECOM|9\.9|SEP|11\.11|12\.12)/.test(t)) return 'ecom';
  if (/^\[(CORP|CREATOR|B2C)\]/.test(t)) return 'content';
  if (t.indexOf('[REVIEW] Optimize Ad') === 0 || t.indexOf('Meta Ads') === 0 || t.indexOf('[ADS]') === 0) return 'ads';
  if (t.indexOf('[REVIEW]') === 0) return 'review';
  if (String(colorId) === '4') return 'ceo';
  return 'team';
}

/** Live calendar → [{d, t, title, cat, who?, end?}]. Read as the script owner, so the owner's calendar is the source. */
function calendarEvents_() {
  const hit = cacheGet_('events');
  if (hit) return hit;
  const cal = CONFIG.CALENDAR_ID ? CalendarApp.getCalendarById(CONFIG.CALENDAR_ID) : CalendarApp.getDefaultCalendar();
  const tz = cal.getTimeZone() || CONFIG.TIMEZONE;
  const from = Utilities.parseDate(CONFIG.CALENDAR_FROM, tz, 'yyyy-MM-dd');
  const to = new Date(Date.now() + CONFIG.CALENDAR_DAYS_AHEAD * 86400000);
  const who = CONFIG.WHO_BY_EMAIL || {};
  const out = [];
  cal.getEvents(from, to).forEach(function (ev) {
    try { if (ev.getMyStatus() === CalendarApp.GuestStatus.NO) return; } catch (e) { /* not a guest: keep */ }
    const title = String(ev.getTitle() || '').trim();
    if (!title) return;
    const o = { d: '', t: '', title: title, cat: eventCategory_(title, ev.getColor()) };
    if (ev.isAllDayEvent()) {
      const s = ev.getAllDayStartDate(), e2 = ev.getAllDayEndDate();
      o.d = Utilities.formatDate(s, tz, 'yyyy-MM-dd');
      const last = Utilities.formatDate(new Date(e2.getTime() - 86400000), tz, 'yyyy-MM-dd');   // end date is exclusive
      if (last > o.d) o.end = last;
    } else {
      o.d = Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd');
      o.t = Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm');
    }
    const names = {};
    ev.getGuestList(true).forEach(function (g) { const n = who[String(g.getEmail()).toLowerCase()]; if (n) names[n] = true; });
    const list = Object.keys(names).sort();
    if (list.length) o.who = list;
    out.push(o);
  });
  out.sort(function (a, b) { return (a.d + a.t).localeCompare(b.d + b.t); });
  cachePut_('events', out, 300);
  return out;
}

/** Private snapshot (Snapshot.gs): projects, links, performance numbers, milestones, extra Thai strings. */
function snapshot_() {
  return (typeof SNAPSHOT !== 'undefined') ? SNAPSHOT : { texts: {}, th: {}, projects: [], feed: [], links: {}, milestones: [] };
}

/* ---------------- who handles a request (decided here, never by the page) ---------------- */

/** Open work per person id: not done, and overdue or due within SLOT_DAYS (same rule as the dashboard's "slots"). */
function loadByPerson_() {
  const byName = {};
  Object.keys(CONFIG.PEOPLE).forEach(function (id) { byName[CONFIG.PEOPLE[id].name.toLowerCase()] = id; });
  const horizon = Utilities.formatDate(new Date(Date.now() + CONFIG.SLOT_DAYS * 86400000), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const load = {};
  const count = function (name, status, due) {
    const id = byName[String(name || '').trim().toLowerCase()];
    if (!id) return;
    if (/^(done|complete|completed|published|approved)$/.test(String(status || '').trim().toLowerCase())) return;
    const day = dayIso_(due, CONFIG.TIMEZONE);
    if (day && day > horizon) return;
    load[id] = (load[id] || 0) + 1;
  };
  const rows = taskRows_();
  if (rows.length) {
    const h = rows[0].map(function (x) { return String(x).trim().toLowerCase(); });
    const a = colIdx_(h, 'assignee'), s = colIdx_(h, 'status'), d = colIdx_(h, 'due');
    for (let i = 1; i < rows.length; i++) count(rows[i][a], rows[i][s], rows[i][d]);
  }
  try {
    designerRows_().slice(1).forEach(function (r) { count(r[5], r[6], r[2]); });
  } catch (e) { /* designer sheet unavailable: route on the Tasks sheet alone */ }
  return load;
}

/** Picks the person for a request type: the listed people (narrowed by the answers), most free slots first. */
function assignee_(typeId, answers) {
  const rule = (CONFIG.ROUTING && (CONFIG.ROUTING[typeId] || CONFIG.ROUTING.other)) || { people: Object.keys(CONFIG.PEOPLE).slice(0, 1) };
  let people = rule.people;
  Object.keys(rule.routes || {}).forEach(function (field) {
    const v = answers && answers[field], map = rule.routes[field];
    if (v && Object.prototype.hasOwnProperty.call(map, v)) people = map[v];
  });
  people = people.filter(function (id) { return CONFIG.PEOPLE[id]; });
  if (!people.length) throw new Error('No one is set up to handle this type of request');
  const load = loadByPerson_();
  let best = null;
  people.forEach(function (id) {
    const free = CONFIG.CAPACITY - (load[id] || 0);
    if (!best || free > best.free) best = { id: id, free: free };       // ties keep the listed order
  });
  return { id: best.id, hours: rule.hours || 3 };
}

/* ---------------- handling a request ---------------- */

function submit_(b) {
  if (b.website) return { ok: true, id: 'REQ-IGNORED' };           // honeypot: bots fill hidden fields
  const r = validate_(b);
  const pick = assignee_(r.typeId, r.answers);
  r.assigneeId = pick.id; r.estHours = String(pick.hours); r.affects = '';
  const person = CONFIG.PEOPLE[r.assigneeId];
  if (/^REPLACE_/.test(person.email) || /^REPLACE_/.test(CONFIG.MANAGER_EMAIL)) {
    throw new Error('Email addresses are not configured yet. Ask the admin to finish setup (SETUP.md).');
  }

  const requests = requestsSheet_();
  const existing = findRow_(requests, 'Client ID', r.clientId);
  if (existing) return { ok: true, id: existing.id, assigneeName: existing.assignee || person.name, emailed: true, duplicate: true };

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
    typeId: str(b.type && b.type.id, 30), typeLabel: str(b.type && b.type.label, 80),
    title: str(b.title, 150), description: str(b.description, 4000),
    links: str(b.links, 2000),
    deadline: str(b.deadline, 10), urgency: str(b.urgency, 20), urgentReason: str(b.urgentReason, 1000),
    priority: str(b.priority, 10),
    answers: (function () {                  // answers to the type-specific questions; only used for routing
      const a = {}, src = b.answers && typeof b.answers === 'object' ? b.answers : {};
      Object.keys(src).slice(0, 20).forEach(function (k) { a[str(k, 30)] = str(src[k], 200); });
      return a;
    })(),
    details: (Array.isArray(b.details) ? b.details : []).slice(0, 40).map(function (d) {
      return { label: str(d.label, 80), value: str(d.value, 1000) };
    })
  };
  if (!r.clientId) throw new Error('Missing request id');
  if (!r.name || !r.dept || !r.typeLabel || !r.title || !r.description) throw new Error('Please fill in all required fields');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) throw new Error('Please enter a valid email address');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.deadline)) throw new Error('Please choose a valid deadline');
  if (['High', 'Medium', 'Low'].indexOf(r.priority) < 0) throw new Error('Invalid priority');
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
  const ac = header.indexOf('assignee');
  for (let i = 0; i < vals.length; i++) if (String(vals[i][c]) === value) return { id: String(vals[i][0]), assignee: ac >= 0 ? String(vals[i][ac]) : '' };
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
  CalendarApp.getDefaultCalendar();                                   // triggers the Calendar permission prompt
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });   // triggers the external-request prompt
  SpreadsheetApp.openById(CONFIG.DESIGNER_SHEET_ID);                  // checks the designer sheet is reachable
  const problems = [];
  if (/^REPLACE_/.test(CONFIG.MANAGER_EMAIL)) problems.push('MANAGER_EMAIL');
  Object.keys(CONFIG.PEOPLE).forEach(function (k) {
    if (/^REPLACE_/.test(CONFIG.PEOPLE[k].email)) problems.push('PEOPLE.' + k + '.email');
  });
  if (!CONFIG.GOOGLE_CLIENT_ID || /^REPLACE_/.test(CONFIG.GOOGLE_CLIENT_ID)) problems.push('GOOGLE_CLIENT_ID (team sign-in stays locked until set)');
  if (!CONFIG.ALLOWED_VIEWERS || !CONFIG.ALLOWED_VIEWERS.length) problems.push('ALLOWED_VIEWERS');
  if (typeof SNAPSHOT === 'undefined') problems.push('Snapshot.gs (the dashboard will have no projects / performance data)');
  Logger.log(problems.length ? 'Sheet ready, but still fill in: ' + problems.join(', ') : 'Setup complete. Now deploy a new version of the web app.');
}

/** Run to check the email path: sends one test message to the manager only. */
function testEmail() {
  MailApp.sendEmail({
    to: CONFIG.MANAGER_EMAIL, cc: CONFIG.ALWAYS_CC.join(','),
    subject: '[Marketing Request Desk] Test email',
    body: 'If you can read this, request emails are working. No action needed.'
  });
}
