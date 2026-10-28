# Marketing Team Hub — setup and access control

## Who sees what

| Page | Address | Who |
|---|---|---|
| **Request page** (`index.html`) | the site address | Anyone. It can only *send* a request. It contains and reads no internal data. |
| **Team dashboard** (`team.html`) | the site address + `/team.html` | Only the Google accounts listed in `ALLOWED_VIEWERS`. The page loads empty; every task, calendar event, designer item and number is fetched from the Apps Script server **after** it verifies the Google sign-in. |

GitHub Pages is public by design, so the lock is on the **data**, not the page: the server checks the Google ID token with Google,
checks it was issued for *our* sign-in ID, and checks the email is on the allow-list. Anything else gets nothing back.
If sign-in is not configured, the dashboard stays locked (it fails closed).

Private files (never commit these; they are in `.gitignore`): `apps-script/Config.gs` (emails, sheet IDs, allow-list) and
`apps-script/Snapshot.gs` (projects, Drive links, performance numbers). Only `Config.example.gs` is in the repository.

## One-time setup (about 20 minutes)

### 1. Create the Google sign-in ID (5 minutes, free, no secret to keep)
1. Open <https://console.cloud.google.com/> with the company Google account, create a project (e.g. "Marketing Team Hub").
2. **APIs & Services → OAuth consent screen**: choose **Internal** (only your Workspace) and fill in the app name.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
   Under **Authorized JavaScript origins** add exactly `https://natthanichalaowork-web.github.io` (no path, no trailing slash).
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`). It is not a secret.

### 2. Update Apps Script (Tasks sheet → Extensions → Apps Script)
1. Replace the contents of **Code.gs** with the new `Code.gs`.
2. Add two script files with **+ → Script**: **Config** (paste `Config.gs`) and **Snapshot** (paste `Snapshot.gs`).
3. In **Config**, set `GOOGLE_CLIENT_ID` to the Client ID from step 1. Check `ALLOWED_VIEWERS`.
4. If you use the Tasks sheet tools, replace `TasksSheetTools.gs` with the new one too.
5. Run **`setup`** and approve the new permissions (it reads your calendar and checks sign-in tokens with Google).
   The log lists anything still missing.
6. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.** The web app URL stays the same.

> Do step 2 **before** the new pages go live. The new server no longer serves the old public task feed, so the old dashboard
> page would show "Sheet unavailable" until the new pages are published.

### 3. Put the Client ID on the dashboard page
In `team.html`, set `googleClientId: "…apps.googleusercontent.com"` in `SETTINGS`, commit, and let GitHub Pages publish.

### 4. Close the old back doors (the important part)
- **Tasks sheet:** *File → Share → Publish to web* → **Stop publishing**. (The old published CSV link is public.)
- **Designer Automation sheet:** *Share → General access → Restricted*. The server reads it as the script owner, the dashboard no longer needs the link.
- **Drive docs linked on the dashboard** (briefs, lead database, Shopee sheet, folders): if they are shared as "anyone with the link", set them to Restricted or to the company only.
- Old links that were visible in the public repository's history stay readable there. Treat any "anyone with the link" file as exposed until you restrict it.

### 5. Tell the team
Bookmark `…/team.html`. Share the plain site address (the request page) with people outside Marketing.

## Day to day
- **Let someone in:** add their Google email to `ALLOWED_VIEWERS` in Config → new deployment version. Remove an email the same way; it takes effect on their next refresh.
- **Who handles which request:** `ROUTING` in Config (people, answer-based routes such as Product photos → designer, hours). The public page cannot pick the person; the server picks the eligible person with the most free slots.
- **Refresh the performance numbers / projects / milestones:** edit `Snapshot.gs` in Apps Script, then deploy a new version.
- **Calendar:** now live. It is read from the calendar of the account that owns the script (`CALENDAR_ID` blank), from `CALENDAR_FROM` on.
- Dashboard polling: tasks every 15 s, designer sheet + calendar + snapshot every 60 s (server caches for 10 s / 60 s / 5 min).

## Request emails and calendar (unchanged behaviour)
- To the assignee, CC the marketing manager and `ALWAYS_CC`, BCC everyone in `PEOPLE` (`BCC_WHOLE_TEAM`). The requester gets a confirmation copy (`CONFIRM_TO_REQUESTER`).
- Each request adds an all-day event on its deadline to the assignee's Google Calendar (`ADD_TO_CALENDAR`).
- Emails go from the account that deployed the script (about 100 a day on free Gmail, 1,500 on Workspace).
- Protection on the public form: hidden spam trap, input validation, 10 requests/hour per email address.

## Easier Tasks sheet (TasksSheetTools.gs)
A second script file that makes the Tasks workbook easier to use and keeps it in step with the Designer Automation sheet.
1. Same Apps Script project: **+ → Script**, name it `TasksSheetTools`, paste in `TasksSheetTools.gs`.
2. Run **`hubSetup`** once and approve the permissions. Reload the sheet: a **Marketing Hub** menu appears.

It adds dropdowns, a date check and overdue / due-soon / done colours on **Tasks**, a read-only **Designer (synced)** mirror (every 10 minutes),
an **All tasks** list, a per-person **Summary**, and updated **Lists** / **How to use** tabs. It never writes to the Designer Automation sheet and never
renames a Tasks header, so the dashboard keeps working. It reads the designer sheet ID and project names from the private `Config.gs`.

## About the repository being public
Earlier versions of this repository put the dashboard data (tasks, calendar, performance numbers, Drive links, team emails) in public files.
Those versions remain in the repository's history even though the current files no longer contain them. The reliable fixes are in step 4
(restrict the files) and, if you want the history gone, to move the site to a new repository created from the current files.
