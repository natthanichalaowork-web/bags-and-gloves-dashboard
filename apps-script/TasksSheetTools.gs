/**
 * Marketing Team Hub — Tasks sheet tools.
 *
 * Paste this as a second file ("TasksSheetTools") in the SAME Apps Script project as Code.gs
 * (Tasks sheet → Extensions → Apps Script → + → Script). Then run `hubSetup` once.
 *
 * What it gives the Tasks workbook
 *   - A "Marketing Hub" menu: Add task form, Mark rows Done, Sync designer now, Sort by due date, Set up / repair
 *   - Dropdowns, date + number checks, colour rules (overdue / due soon / done) and a frozen, filterable header on Tasks
 *   - "Designer (synced)": read-only mirror of the Designer Automation sheet, refreshed every 10 minutes
 *   - "All tasks": Tasks + designer work in one list, sorted by due date
 *   - "Summary": open / overdue / due this week / free slots per person
 *   - Updated Lists and How to use tabs
 *
 * It never writes to the Designer Automation sheet (a chat bot runs on it) and never renames a Tasks header,
 * so the dashboard keeps working exactly as before. The dashboard reads only the Tasks tab.
 */
const HUB = {
  DESIGNER_SHEET_ID: '1VZjyodbbljTgY38JZPLnzcvxsmlD-sE0BCpBxEbDaCw',
  DESIGNER_TAB: '',                 // blank = first tab
  DESIGNER_FROM: '2026-09-20',      // same cut-off the dashboard uses (designer rows published on/after this date)
  SYNC_MINUTES: 10,                 // 1, 5, 10, 15 or 30
  CAPACITY: 12,                     // free slots = this minus open tasks due within 14 days (same rule as the dashboard)
  TEAM: ['Natthanicha', 'Sadanan (Bo)', 'Prateap', 'Content Creator', 'Marketing (shared)'],
  STATUSES: ['To do', 'In progress', 'Review', 'Done'],
  PRIORITIES: ['High', 'Medium', 'Low'],
  TYPES: ['Ad-hoc'],
  PROJECTS: [
    'Ad-hoc requests', 'Paid Ads Phase 2 — Meta (Ads 13–18)', 'LINE OA broadcasts — Sep / Oct', "Woon's Lens — CEO branding",
    'House Brand launch — Built From Real Work', '10.10 campaign', 'Corporate & B2C content calendar', '30th Anniversary',
    'Internal newsletter — Issue 07', 'Lead engine Phase 1 — LINE OA + website', 'E-commerce performance reporting'
  ],
  TAB: { designer: 'Designer (synced)', all: 'All tasks', summary: 'Summary', lists: 'Lists', howto: 'How to use' },
  ROWS: 1000,                       // validation / formatting reach this many rows
  NAVY: '#00396b', GOLD: '#e9b94f'
};

/* ============================================================ menu */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Marketing Hub')
    .addItem('➕ Add task (form)', 'hubAddTaskDialog')
    .addItem('✅ Mark selected rows Done', 'hubMarkDone')
    .addSeparator()
    .addItem('🔄 Sync designer sheet now', 'hubSyncDesigner')
    .addItem('↕ Sort Tasks by due date', 'hubSortTasks')
    .addItem('🧹 Set up / repair this sheet', 'hubSetup')
    .addToUi();
}

/* ============================================================ pure helpers (no Google services; unit-tested) */

var HUB_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Any date cell → 'yyyy-mm-dd' or ''. Understands Date objects, 2026-10-15, 15/10/2026, "15 Oct 2026", Thai Buddhist years. */
function hubDay_(v, tz) {
  if (v === '' || v == null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return (typeof Utilities !== 'undefined')
      ? Utilities.formatDate(v, tz || 'Asia/Bangkok', 'yyyy-MM-dd')
      : v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/), y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})$/)) && HUB_MONTHS[m[2].toLowerCase()]) { d = +m[1]; mo = HUB_MONTHS[m[2].toLowerCase()]; y = +m[3]; }
  else return '';
  if (y > 2400) y -= 543;
  const chk = new Date(y, mo - 1, d);
  if (chk.getFullYear() !== y || chk.getMonth() !== mo - 1 || chk.getDate() !== d) return '';
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
}

/** Same status map as the dashboard: Briefed→To do · In Design→In progress · Draft/Revision→Review · Approved/Published→Done */
function hubStatus_(s) {
  const k = String(s || '').trim().toLowerCase();
  const map = { 'briefed': 'To do', 'in design': 'In progress', 'draft': 'Review', 'revision': 'Review', 'revision requested': 'Review',
                'approved': 'Done', 'published': 'Done' };
  return map[k] || 'To do';
}

/** Same project rules as the dashboard (designProject), returning the project NAME used in the Tasks sheet. */
function hubProject_(campaign, title) {
  const c = String(campaign || '').toLowerCase(), t = String(title || '').toLowerCase();
  const P = HUB.PROJECTS;
  if (/\bnewsletter\b/.test(t)) return P[8];
  if (c.indexOf('30th anniversary') >= 0) return P[7];
  if (c.indexOf('woon') >= 0 || c.indexOf('ceo') >= 0) return P[3];
  if (c.indexOf('house brand') >= 0) return P[4];
  if (c.indexOf('10.10') >= 0) return P[5];
  if (/\bads\b/.test(c) || /^\[ads\]/.test(t)) return P[1];
  if (/\bline\b/.test(c) || /^\[line/.test(t)) return P[2];
  return P[6];
}

/** Designer sheet values (2-D array with header) → clean task objects. Cancelled rows and rows before DESIGNER_FROM are dropped. */
function hubDesignerTasks_(values, tz) {
  if (!values || !values.length) return [];
  const h = values[0].map(function (x) { return String(x).trim().toLowerCase(); });
  const col = function (name) { return h.indexOf(name.toLowerCase()); };
  const c = { id: col('Task_ID'), pub: col('Publish_Date'), time: col('Publish_Time'), due: col('Design_Due'), camp: col('Campaign'),
              title: col('Content'), who: col('Designer'), st: col('Status'), pri: col('Priority'), brief: col('Brief_URL'), draft: col('Draft_URL') };
  ['id', 'pub', 'due', 'camp', 'title', 'who', 'st'].forEach(function (k) {
    if (c[k] < 0) throw new Error('Designer sheet is missing a column the sync needs (' + k + ')');
  });
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const status = String(r[c.st] || '').trim().toLowerCase();
    if (status === 'cancelled' || status === 'canceled') continue;
    const title = String(r[c.title] || '').trim(), publish = hubDay_(r[c.pub], tz);
    if (!title || !publish || publish < HUB.DESIGNER_FROM) continue;
    const pri = String(r[c.pri] || '').trim();
    out.push({
      id: String(r[c.id] || '').trim(), project: hubProject_(r[c.camp], title), title: title,
      assignee: String(r[c.who] || '').trim(), status: hubStatus_(r[c.st]), rawStatus: String(r[c.st] || '').trim(),
      due: hubDay_(r[c.due], tz), publish: publish, time: c.time >= 0 ? String(r[c.time] || '') : '',
      priority: HUB.PRIORITIES.indexOf(pri) >= 0 ? pri : 'Medium',
      brief: c.brief >= 0 ? String(r[c.brief] || '').trim() : '', draft: c.draft >= 0 ? String(r[c.draft] || '').trim() : ''
    });
  }
  return out;
}

/** Sort key for the "All tasks" list: open work by due date first, then done work, blank dates last in each group. */
function hubSortKey_(status, due) { return (status === 'Done' ? '1' : '0') + (due || '9999-99-99'); }

/* ============================================================ sheet helpers */

function hubDate_(s) { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function hubSheet_(name, create) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh && create) sh = ss.insertSheet(name);
  return sh;
}
function hubHeaderCol_(sh, prefix) {   // 1-based column of the header starting with prefix, or 0
  const i = colIdx_(headerIndex_(sh), prefix.toLowerCase());
  return i < 0 ? 0 : i + 1;
}
function hubStyleHeader_(range) {
  range.setBackground(HUB.NAVY).setFontColor('#ffffff').setFontWeight('bold').setVerticalAlignment('middle').setWrap(true);
}
function hubListRule_(values, allowInvalid) {
  return SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(allowInvalid).build();
}
function hubRule_(range, formula, background, fontColor, extra) {
  let b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula).setRanges([range]);
  if (background) b = b.setBackground(background);
  if (fontColor) b = b.setFontColor(fontColor);
  if (extra && extra.strike) b = b.setStrikethrough(true);
  if (extra && extra.bold) b = b.setBold(true);
  return b.build();
}

/** Status / overdue / due-soon / priority colours for a task list. cols = 1-based column numbers. */
function hubColourRules_(sh, cols, lastCol) {
  const R = Math.min(HUB.ROWS, sh.getMaxRows() - 1), L = function (n) { return String.fromCharCode(64 + n); };   // never reach past the sheet's last row
  const st = L(cols.status), du = L(cols.due), pr = L(cols.priority);
  const rows = function (c) { return sh.getRange(2, c, R, 1); };
  const whole = sh.getRange(2, 1, R, lastCol);
  const due = '$' + du + '2';
  const dueDate = 'IFERROR(DATEVALUE(' + due + '),' + due + ')';
  return [
    hubRule_(whole, '=$' + st + '2="Done"', null, '#9aa0a6', { strike: true }),
    hubRule_(rows(cols.due), '=AND($' + st + '2<>"Done",' + due + '<>"",' + dueDate + '<TODAY())', '#fde2e1', '#b42318', { bold: true }),
    hubRule_(rows(cols.due), '=AND($' + st + '2<>"Done",' + due + '<>"",' + dueDate + '>=TODAY(),' + dueDate + '<=TODAY()+3)', '#fff3d6', '#8a5a00'),
    hubRule_(rows(cols.status), '=$' + st + '2="In progress"', '#dbeafe', '#1d4ed8'),
    hubRule_(rows(cols.status), '=$' + st + '2="Review"', '#fef3c7', '#92400e'),
    hubRule_(rows(cols.status), '=$' + st + '2="Done"', '#dcfce7', '#166534'),
    hubRule_(rows(cols.priority), '=$' + pr + '2="High"', null, '#b42318', { bold: true })
  ];
}

/* ============================================================ setup */

/** One-click setup / repair. Safe to run again. */
function hubSetup() {
  const log = [];
  hubFixLists_(); log.push('Lists updated');
  hubFixTasksTab_(); log.push('Tasks tab: dropdowns, colours, frozen header');
  hubWriteHowTo_(); log.push('How to use rewritten');
  hubSyncDesigner(); log.push('Designer sheet synced');
  hubInstallTrigger_(); log.push('Auto-sync every ' + HUB.SYNC_MINUTES + ' minutes');
  ss_().setActiveSheet(tasksSheet_());
  Logger.log(log.join('\n'));
  try { SpreadsheetApp.getUi().alert('Marketing Hub sheet is ready', log.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* run from the editor: no UI */ }
}

function hubFixLists_() {
  const sh = hubSheet_(HUB.TAB.lists, true);
  const cols = [['Projects', HUB.PROJECTS], ['Team', HUB.TEAM], ['Status', HUB.STATUSES], ['Priority', HUB.PRIORITIES], ['Type', HUB.TYPES]];
  sh.clear();
  cols.forEach(function (c, i) {
    sh.getRange(1, i + 1).setValue(c[0]);
    sh.getRange(2, i + 1, c[1].length, 1).setValues(c[1].map(function (v) { return [v]; }));
  });
  hubStyleHeader_(sh.getRange(1, 1, 1, cols.length));
  sh.setFrozenRows(1); sh.setColumnWidth(1, 330); for (let i = 2; i <= cols.length; i++) sh.setColumnWidth(i, 160);
  sh.setTabColor('#98a2b3');
}

function hubFixTasksTab_() {
  const sh = tasksSheet_();
  const c = {
    project: hubHeaderCol_(sh, 'project'), task: hubHeaderCol_(sh, 'task'), assignee: hubHeaderCol_(sh, 'assignee'),
    status: hubHeaderCol_(sh, 'status'), due: hubHeaderCol_(sh, 'due'), priority: hubHeaderCol_(sh, 'priority'),
    notes: hubHeaderCol_(sh, 'notes'), type: hubHeaderCol_(sh, 'type'), hours: hubHeaderCol_(sh, 'hours')
  };
  ['project', 'task', 'assignee', 'status', 'due', 'priority'].forEach(function (k) {
    if (!c[k]) throw new Error('Tasks tab has no "' + k + '" column. Do not rename the header row; the dashboard needs it.');
  });
  const lastCol = sh.getLastColumn(), R = Math.min(HUB.ROWS, sh.getMaxRows() - 1);   // never reach past the sheet's last row

  // Old role name: the dashboard now uses "Content Creator".
  const taskRange = sh.getRange(2, c.task, Math.max(1, sh.getLastRow() - 1), 1);
  taskRange.setValues(taskRange.getValues().map(function (r) { return [String(r[0]).replace(/Arkom/g, 'Content Creator')]; }));
  const who = sh.getRange(2, c.assignee, Math.max(1, sh.getLastRow() - 1), 1);
  who.setValues(who.getValues().map(function (r) { return [String(r[0]) === 'Arkom' ? 'Content Creator' : r[0]]; }));

  // Dropdowns and input checks.
  sh.getRange(2, c.project, R, 1).setDataValidation(hubListRule_(HUB.PROJECTS, true));            // warn only: new projects are allowed
  sh.getRange(2, c.assignee, R, 1).setDataValidation(hubListRule_(HUB.TEAM, false));
  sh.getRange(2, c.status, R, 1).setDataValidation(hubListRule_(HUB.STATUSES, false));
  sh.getRange(2, c.priority, R, 1).setDataValidation(hubListRule_(HUB.PRIORITIES, false));
  if (c.type) sh.getRange(2, c.type, R, 1).setDataValidation(hubListRule_(HUB.TYPES, true));
  // Accepts real dates and yyyy-mm-dd text (the website form writes text), rejects anything else.
  const dueCell = String.fromCharCode(64 + c.due) + '2';
  sh.getRange(2, c.due, R, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation()
      .requireFormulaSatisfied('=OR(' + dueCell + '="",ISNUMBER(' + dueCell + '),NOT(ISERROR(DATEVALUE(' + dueCell + '))))')
      .setAllowInvalid(false).setHelpText('Type a date like 2026-10-15').build())
    .setNumberFormat('yyyy-mm-dd');
  if (c.hours) sh.getRange(2, c.hours, R, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).build());

  // Defaults for new rows: a fresh row starts as To do / Medium.
  // (Left blank on purpose: the dashboard treats blank status as To do and blank priority as Medium.)

  // Look and feel.
  hubStyleHeader_(sh.getRange(1, 1, 1, lastCol));
  sh.setFrozenRows(1); sh.setFrozenColumns(0);
  sh.setRowHeight(1, 34);
  sh.getRange(2, 1, R, lastCol).setVerticalAlignment('top');
  sh.getRange(2, c.task, R, 1).setWrap(true);
  if (c.notes) sh.getRange(2, c.notes, R, 1).setWrap(true);
  sh.setColumnWidth(c.project, 260); sh.setColumnWidth(c.task, 420); sh.setColumnWidth(c.assignee, 130);
  sh.setColumnWidth(c.status, 110); sh.setColumnWidth(c.due, 110); sh.setColumnWidth(c.priority, 90);
  if (c.notes) sh.setColumnWidth(c.notes, 260);
  sh.setTabColor(HUB.NAVY);
  if (sh.getFilter()) sh.getFilter().remove();
  sh.getRange(1, 1, Math.max(2, sh.getLastRow()), lastCol).createFilter();
  sh.setConditionalFormatRules(hubColourRules_(sh, { status: c.status, due: c.due, priority: c.priority }, lastCol));
}

function hubWriteHowTo_() {
  const sh = hubSheet_(HUB.TAB.howto, true);
  const lines = [
    'How this workbook feeds the Marketing Team Hub website',
    '',
    'ADD A TASK',
    '1. Easiest: menu Marketing Hub → ➕ Add task (form). Fill the form, press Add.',
    '2. Or type straight into the Tasks tab: pick Project, Assignee, Status and Priority from the dropdowns; type dates like 2026-10-15.',
    '3. Requests from the website form (Request work tab) land in Tasks automatically, with a Request ID.',
    '',
    'UPDATE A TASK',
    '4. Change Status in the Tasks tab (To do → In progress → Review → Done), or select rows and use Marketing Hub → ✅ Mark selected rows Done.',
    '5. Red date = overdue. Amber date = due within 3 days. Grey + strikethrough = Done.',
    '',
    'DESIGNER WORK',
    '6. Designer tasks live in the Designer Automation sheet (a chat bot updates it). Do not copy them into Tasks.',
    '7. Tab "Designer (synced)" is a read-only mirror, refreshed every ' + HUB.SYNC_MINUTES + ' minutes. Tab "All tasks" shows Tasks + designer work together, sorted by due date. Edit in the source sheet, never in these two tabs: they are rewritten on every sync.',
    '8. Tab "Summary" shows open, overdue, due this week and free slots for each person.',
    '',
    'RULES THAT KEEP THE WEBSITE WORKING',
    '• Do not rename or delete the header row on the Tasks tab, and keep the Tasks tab as the first tab.',
    '• To add a person or project: add it to the Lists tab, then ask the site owner to add it to the website too.',
    '• The website checks for changes every 15 seconds.'
  ];
  sh.clear();
  sh.getRange(1, 1, lines.length, 1).setValues(lines.map(function (l) { return [l]; })).setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidth(1, 900);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold').setFontColor(HUB.NAVY);
  ['ADD A TASK', 'UPDATE A TASK', 'DESIGNER WORK', 'RULES THAT KEEP THE WEBSITE WORKING'].forEach(function (h) {
    const i = lines.indexOf(h); if (i >= 0) sh.getRange(i + 1, 1).setFontWeight('bold').setFontColor(HUB.NAVY);
  });
  sh.setTabColor('#98a2b3');
}

/* ============================================================ designer sync + combined view */

/** Mirrors the Designer Automation sheet into "Designer (synced)" and rebuilds "All tasks" and "Summary". Read-only on the source. */
function hubSyncDesigner() {
  const tz = ss_().getSpreadsheetTimeZone();
  const src = SpreadsheetApp.openById(HUB.DESIGNER_SHEET_ID);
  const srcSheet = HUB.DESIGNER_TAB ? src.getSheetByName(HUB.DESIGNER_TAB) : src.getSheets()[0];
  const design = hubDesignerTasks_(srcSheet.getDataRange().getValues(), src.getSpreadsheetTimeZone());
  design.sort(function (a, b) { return (a.due || '9999').localeCompare(b.due || '9999'); });

  hubWriteDesignerTab_(design);
  hubWriteAllTasks_(design, tz);
  hubWriteSummary_();
}

function hubWriteDesignerTab_(design) {
  const sh = hubSheet_(HUB.TAB.designer, true);
  const header = ['Task ID', 'Publish date', 'Design due', 'Project', 'Content', 'Designer', 'Status', 'Designer sheet status', 'Priority', 'Brief', 'Draft'];
  sh.clear(); sh.clearConditionalFormatRules();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  hubStyleHeader_(sh.getRange(1, 1, 1, header.length));
  if (design.length) {
    const rows = design.map(function (t) {
      return [t.id, t.publish ? hubDate_(t.publish) : '', t.due ? hubDate_(t.due) : '', t.project, t.title, t.assignee, t.status, t.rawStatus, t.priority, t.brief, t.draft];
    });
    sh.getRange(2, 1, rows.length, header.length).setValues(rows).setVerticalAlignment('top');
    sh.getRange(2, 2, rows.length, 2).setNumberFormat('yyyy-mm-dd');
  }
  sh.setFrozenRows(1);
  [110, 100, 100, 250, 420, 120, 100, 130, 80, 220, 220].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(2, 5, Math.max(1, design.length), 1).setWrap(true);
  sh.setConditionalFormatRules(hubColourRules_(sh, { status: 7, due: 3, priority: 9 }, header.length));
  if (sh.getFilter()) sh.getFilter().remove();
  sh.getRange(1, 1, Math.max(2, design.length + 1), header.length).createFilter();
  sh.setTabColor('#7c3aed');
  sh.getRange(1, header.length + 2).setValue('Read-only mirror of the Designer Automation sheet. Refreshed ' + Utilities.formatDate(new Date(), ss_().getSpreadsheetTimeZone(), 'd MMM HH:mm') + '. Edit tasks in the source sheet.')
    .setFontColor('#b42318').setFontWeight('bold');
}

function hubWriteAllTasks_(design, tz) {
  const tasks = tasksSheet_();
  const vals = tasks.getDataRange().getValues();
  const h = vals[0].map(function (x) { return String(x).trim().toLowerCase(); });
  const ix = function (p) { return colIdx_(h, p); };
  const c = { project: ix('project'), task: ix('task'), assignee: ix('assignee'), status: ix('status'), due: ix('due'), priority: ix('priority'), notes: ix('notes') };
  const list = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    const title = String(r[c.task] || '').trim();
    if (!title) continue;
    const st = String(r[c.status] || '').trim() || 'To do';
    list.push({ source: 'Tasks', project: String(r[c.project] || ''), title: title, assignee: String(r[c.assignee] || ''), status: st,
                due: hubDay_(r[c.due], tz), priority: String(r[c.priority] || '') || 'Medium', publish: '', note: String(r[c.notes] || '') });
  }
  design.forEach(function (t) {
    list.push({ source: 'Designer', project: t.project, title: t.title, assignee: t.assignee, status: t.status, due: t.due,
                priority: t.priority, publish: t.publish, note: t.brief || '' });
  });
  list.sort(function (a, b) { return hubSortKey_(a.status, a.due).localeCompare(hubSortKey_(b.status, b.due)); });

  const sh = hubSheet_(HUB.TAB.all, true);
  const header = ['Source', 'Project', 'Task', 'Assignee', 'Status', 'Due date', 'Priority', 'Publish date', 'Notes / brief link'];
  sh.clear(); sh.clearConditionalFormatRules();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  hubStyleHeader_(sh.getRange(1, 1, 1, header.length));
  if (list.length) {
    const rows = list.map(function (t) {
      return [t.source, t.project, t.title, t.assignee, t.status, t.due ? hubDate_(t.due) : '', t.priority, t.publish ? hubDate_(t.publish) : '', t.note];
    });
    sh.getRange(2, 1, rows.length, header.length).setValues(rows).setVerticalAlignment('top');
    sh.getRange(2, 6, rows.length, 1).setNumberFormat('yyyy-mm-dd');
    sh.getRange(2, 8, rows.length, 1).setNumberFormat('yyyy-mm-dd');
  }
  sh.setFrozenRows(1);
  [80, 250, 420, 130, 100, 100, 80, 100, 260].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(2, 3, Math.max(1, list.length), 1).setWrap(true);
  sh.setConditionalFormatRules(hubColourRules_(sh, { status: 5, due: 6, priority: 7 }, header.length));
  if (sh.getFilter()) sh.getFilter().remove();
  sh.getRange(1, 1, Math.max(2, list.length + 1), header.length).createFilter();
  sh.setTabColor('#2563eb');
  sh.getRange(1, header.length + 2).setValue('Generated list (Tasks + Designer). Do not edit here: it is rewritten on every sync.').setFontColor('#b42318').setFontWeight('bold');
}

function hubWriteSummary_() {
  const sh = hubSheet_(HUB.TAB.summary, true);
  const A = "'" + HUB.TAB.all + "'!";
  const who = A + '$D$2:$D$2000', st = A + '$E$2:$E$2000', due = A + '$F$2:$F$2000';
  const header = ['Person', 'Open tasks', 'Overdue', 'Due in 7 days', 'Done', 'Free slots (next 14 days)'];
  sh.clear();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  hubStyleHeader_(sh.getRange(1, 1, 1, header.length));
  const rows = HUB.TEAM.map(function (p, i) {
    const r = i + 2, me = '$A' + r;
    return [p,
      '=COUNTIFS(' + who + ',' + me + ',' + st + ',"<>Done")',
      '=COUNTIFS(' + who + ',' + me + ',' + st + ',"<>Done",' + due + ',"<"&TODAY())',
      '=COUNTIFS(' + who + ',' + me + ',' + st + ',"<>Done",' + due + ',">="&TODAY(),' + due + ',"<="&TODAY()+7)',
      '=COUNTIFS(' + who + ',' + me + ',' + st + ',"Done")',
      '=MAX(0,' + HUB.CAPACITY + '-COUNTIFS(' + who + ',' + me + ',' + st + ',"<>Done",' + due + ',"<="&TODAY()+14))'];
  });
  sh.getRange(2, 1, rows.length, header.length).setFormulas(rows);
  sh.getRange(2, 1, rows.length, 1).setFontWeight('bold');
  sh.getRange(2, 2, rows.length, 5).setHorizontalAlignment('center');
  sh.setFrozenRows(1);
  [180, 100, 90, 110, 80, 190].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  const rules = [
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#fde2e1').setFontColor('#b42318').setRanges([sh.getRange(2, 3, rows.length, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberEqualTo(0).setBackground('#fde2e1').setFontColor('#b42318').setRanges([sh.getRange(2, 6, rows.length, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(1, 3).setBackground('#fff3d6').setFontColor('#8a5a00').setRanges([sh.getRange(2, 6, rows.length, 1)]).build()
  ];
  sh.setConditionalFormatRules(rules);
  sh.getRange(rows.length + 3, 1).setValue('Counts Tasks + Designer work together (see the All tasks tab). Free slots follow the same rule as the website: open work that is overdue or due within 14 days, out of ' + HUB.CAPACITY + '.').setFontColor('#667085');
  sh.setTabColor(HUB.GOLD);
}

function hubInstallTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'hubSyncDesigner') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('hubSyncDesigner').timeBased().everyMinutes(HUB.SYNC_MINUTES).create();
}

/* ============================================================ everyday actions */

function hubSortTasks() {
  const sh = tasksSheet_();
  const due = hubHeaderCol_(sh, 'due');
  if (sh.getLastRow() < 3 || !due) return;
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).sort({ column: due, ascending: true });
}

function hubMarkDone() {
  const sh = SpreadsheetApp.getActiveSheet(), ui = SpreadsheetApp.getUi();
  if (sh.getName() !== tasksSheet_().getName()) { ui.alert('Mark Done works on the Tasks tab. Select the task rows there first.'); return; }
  const st = hubHeaderCol_(sh, 'status');
  const sel = sh.getActiveRangeList() ? sh.getActiveRangeList().getRanges() : [sh.getActiveRange()];
  let n = 0;
  sel.forEach(function (rg) {
    for (let r = rg.getRow(); r < rg.getRow() + rg.getNumRows(); r++) {
      if (r < 2) continue;
      if (String(sh.getRange(r, hubHeaderCol_(sh, 'task')).getValue()).trim()) { sh.getRange(r, st).setValue('Done'); n++; }
    }
  });
  ui.alert(n ? n + ' task' + (n === 1 ? '' : 's') + ' marked Done.' : 'No task rows were selected.');
}

function hubAddTaskDialog() {
  const data = { projects: HUB.PROJECTS, team: HUB.TEAM, priorities: HUB.PRIORITIES };
  const html = '<!doctype html><html><head><base target="_top"><style>' +
    'body{font:14px Arial,sans-serif;margin:16px;color:#15181d}label{display:block;font-weight:bold;margin:12px 0 4px}' +
    'input,select,textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font:inherit}' +
    'button{margin-top:16px;padding:10px 18px;border:0;border-radius:6px;background:#00396b;color:#fff;font:inherit;font-weight:bold;cursor:pointer}' +
    '#msg{margin-top:10px;color:#b42318}</style></head><body>' +
    '<label>Project</label><select id="project"></select>' +
    '<label>Task *</label><input id="task" placeholder="What needs to be done?">' +
    '<label>Assignee *</label><select id="assignee"></select>' +
    '<label>Due date</label><input id="due" type="date">' +
    '<label>Priority</label><select id="priority"></select>' +
    '<label>Notes (optional)</label><textarea id="notes" rows="2"></textarea>' +
    '<button id="go">Add task</button><div id="msg"></div>' +
    '<script>var D=' + JSON.stringify(data).replace(/</g, '\\u003c') + ';' +
    'function fill(id,list,sel){var s=document.getElementById(id);list.forEach(function(v){var o=document.createElement("option");o.value=v;o.textContent=v;if(v===sel)o.selected=true;s.appendChild(o)})}' +
    'fill("project",D.projects);fill("assignee",[""].concat(D.team));fill("priority",D.priorities,"Medium");' +
    'document.getElementById("go").onclick=function(){var b=this,m=document.getElementById("msg");m.textContent="";' +
    'var o={project:project.value,task:task.value,assignee:assignee.value,due:due.value,priority:priority.value,notes:notes.value};' +
    'if(!o.task.trim()||!o.assignee){m.textContent="Please fill in the task and the assignee.";return}' +
    'b.disabled=true;b.textContent="Adding…";google.script.run.withSuccessHandler(function(){google.script.host.close()})' +
    '.withFailureHandler(function(e){b.disabled=false;b.textContent="Add task";m.textContent=e.message})' +
    '.hubAddTask(o)};</script></body></html>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(440).setHeight(560), 'Add a task');
}

/** Called by the Add task form. Writes one row at the bottom of Tasks. */
function hubAddTask(o) {
  const task = String(o.task || '').trim(), assignee = String(o.assignee || '').trim();
  if (!task || !assignee) throw new Error('Task and assignee are required');
  if (HUB.TEAM.indexOf(assignee) < 0) throw new Error('Unknown assignee');
  const sh = tasksSheet_(), width = sh.getLastColumn();
  const row = new Array(width).fill('');
  const put = function (p, v) { const c = hubHeaderCol_(sh, p); if (c) row[c - 1] = v; };
  put('project', String(o.project || '').slice(0, 200));
  put('task', task.slice(0, 300));
  put('assignee', assignee);
  put('status', 'To do');
  put('due', /^\d{4}-\d{2}-\d{2}$/.test(o.due || '') ? hubDate_(o.due) : '');
  put('priority', HUB.PRIORITIES.indexOf(o.priority) >= 0 ? o.priority : 'Medium');
  put('notes', String(o.notes || 'Added from the sheet form').slice(0, 300));
  // First empty row by Task column (getLastRow can be inflated by formatting).
  const taskCol = hubHeaderCol_(sh, 'task');
  const col = sh.getRange(1, taskCol, sh.getMaxRows(), 1).getValues();
  let next = 2;
  for (let i = col.length - 1; i >= 1; i--) if (String(col[i][0]).trim()) { next = i + 2; break; }
  if (next > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);
  sh.getRange(next, 1, 1, width).setValues([row.map(function (v) { return v === undefined ? '' : v; })]);
  CacheService.getScriptCache().remove('rows');   // dashboard feed refreshes immediately
}
