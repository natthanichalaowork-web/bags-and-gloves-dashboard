/**
 * Settings for Code.gs. This is the EXAMPLE (safe to publish). The real file is Config.gs, which holds your
 * email addresses, sheet IDs and allow-list: keep it out of the public repository (it is in .gitignore).
 *
 * In Apps Script: add a script file called "Config" and paste your filled-in copy of this.
 */
const CONFIG = {
  // ---- where the data lives ----
  TASKS_SHEET_ID: 'REPLACE_WITH_TASKS_SHEET_ID',
  TASKS_TAB: 'Tasks',            // falls back to the first tab if this name is not found
  REQUESTS_TAB: 'Requests',      // created by setup()
  DESIGNER_SHEET_ID: 'REPLACE_WITH_DESIGNER_SHEET_ID',
  DESIGNER_TAB: '',              // blank = first tab
  DESIGNER_FROM: '2026-09-20',   // designer rows published on/after this date
  TIMEZONE: 'Asia/Bangkok',
  PROJECT_NAME: 'Ad-hoc requests',

  // ---- who may open the internal dashboard (Google accounts, exact emails) ----
  GOOGLE_CLIENT_ID: 'REPLACE_WITH_GOOGLE_CLIENT_ID',   // OAuth client ID (Web application). See SETUP.md, "Team sign-in"
  ALLOWED_VIEWERS: ['person1@example.com', 'person2@example.com'],

  // ---- request emails ----
  MANAGER_EMAIL: 'REPLACE_WITH_MARKETING_MANAGER_EMAIL',   // always CC'd
  ALWAYS_CC: ['marketing@example.com'],
  BCC_WHOLE_TEAM: true,          // also BCC everyone listed in PEOPLE (the assignee is the To, so is never repeated)
  CONFIRM_TO_REQUESTER: true,    // short confirmation copy to the requester
  ADD_TO_CALENDAR: true,         // all-day event on the deadline in the assignee's Google Calendar
  DASHBOARD_URL: 'https://example.github.io/your-repo/team.html',

  // ids are used by ROUTING below
  PEOPLE: {
    nat:     { name: 'Natthanicha',     email: 'REPLACE_WITH_EMAIL' },
    prateap: { name: 'Prateap',         email: 'REPLACE_WITH_EMAIL' },
    creator: { name: 'Content Creator', email: 'REPLACE_WITH_EMAIL' }
  },

  // ---- who handles which request type (the public page cannot choose) ----
  // people: eligible people, the one with the most free slots gets it (ties: listed order)
  // routes: a different list when an answer matches, e.g. product photos go to the designer
  // hours:  rough effort written to the Hours column
  ROUTING: {
    design: { people: ['prateap'], hours: 4 },
    video:  { people: ['creator', 'nat'], hours: 10, routes: { format: { 'Product photos': ['prateap'] } } },
    ads:    { people: ['nat'], hours: 8 },
    line:   { people: ['nat'], hours: 3 },
    web:    { people: ['nat', 'creator'], hours: 5 },
    market: { people: ['prateap'], hours: 3, routes: { kind: { 'Promotion / campaign': ['nat'], 'Price change': ['nat'] } } },
    report: { people: ['nat'], hours: 4 },
    event:  { people: ['nat', 'creator'], hours: 8 },
    brand:  { people: ['nat', 'creator'], hours: 6 },
    other:  { people: ['nat'], hours: 3 }
  },
  CAPACITY: 12,                  // slots per person
  SLOT_DAYS: 14,                 // work that is overdue or due within this many days takes a slot

  // ---- live calendar for the dashboard ----
  CALENDAR_ID: '',               // blank = the calendar of the account that owns this script
  CALENDAR_FROM: '2026-09-01',
  CALENDAR_DAYS_AHEAD: 150,
  WHO_BY_EMAIL: { 'person1@example.com': 'Person 1' },   // calendar guest email → name shown on events

  // used by TasksSheetTools.gs
  PROJECT_LIST: ['Ad-hoc requests'],
  PROJECT_BY_KEY: { adhoc: 'Ad-hoc requests' },          // keys: adhoc paid-ads line-oa ceo-lens house-brand d1010 content anniversary newsletter

  RATE_LIMIT_PER_HOUR: 10        // per requester email
};
