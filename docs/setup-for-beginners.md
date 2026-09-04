# Setup guide for complete beginners

This guide gets the phone farm running on a brand-new Mac mini with **no
technical background**. Do the steps in order. Do not skip any. Each step says
what to click or type, and what you should see when it worked.

Plan for **one afternoon** for the Mac and the first phone, then about
**20 minutes per extra phone**.

## Before you start — what you need on the desk

- [ ] The Mac mini, its power cable, a monitor, keyboard and mouse. **Sit at
      the Mac. Do everything on the Mac itself, not by remote control.**
- [ ] A powered USB hub with one port per phone, and **data** cables (the
      cable that came with the iPhone is fine; cheap "charging only" cables
      will not work).
- [ ] The iPhones, each already signed in to its own Apple ID and with the
      TikTok app installed and logged in.
- [ ] Envy's **Apple Developer** login (the paid one, US$99/year). Ask whoever
      set it up. You will need the email and password and possibly their phone
      for a code.
- [ ] Envy's GitHub login, if the software is being taken from GitHub, or the
      zip file of the software on the Desktop.
- [ ] An internet connection.

Write down as you go:

| Thing | Where you will find it | Value |
| --- | --- | --- |
| Team ID (10 characters) | Xcode → Settings → Accounts, step 2.4 | ________ |
| iOS version on the phones | iPhone Settings → General → About | ________ |
| Database password (make one up, no spaces) | you | ________ |
| Each phone's label and passcode | you | ________ |

## How to type commands

Some steps say "**in Terminal, run:**" followed by a grey box. That means:

1. Open **Terminal**: press ⌘ + Space, type `Terminal`, press Return.
2. Copy the grey box **exactly**, paste it into the Terminal window, press Return.
3. Wait until you see the prompt again (a line ending in `%` or `$`). Some
   steps take minutes. Do not close the window while it is working.

If the Terminal asks for a password, it wants **the Mac login password**. You
will not see anything while typing it. Type it and press Return.

---

## Part 1 — Mac settings (10 minutes)

1. Turn on the Mac, create a user called **farm** if the setup assistant asks
   for a user. Use a password you will remember.
2. Open **System Settings** (Apple menu ⟶ System Settings).
3. **Energy** (or *Energy Saver*): turn **on** "Prevent automatic sleeping when
   the display is off". Turn **on** "Start up automatically after a power failure".
4. **Users & Groups** → click the ⓘ next to *Automatic login* → choose the
   **farm** user. (If it is greyed out, turn off FileVault under *Privacy &
   Security* first.)
5. **General → Sharing**: turn **on** *Screen Sharing* and *Remote Login*.
   (Only for helpers to look at the screen later. The setup itself is done at
   the Mac.)
6. **General → Software Update**: install everything it offers, restart if
   asked, then come back here.

## Part 2 — Install Xcode (30–60 minutes, mostly waiting)

1. Open the **App Store**, search **Xcode**, click **Get / Install**. It is
   large (10+ GB). Wait for it to finish.
2. Open **Xcode** from Applications. Click **Agree** to the licence. If it
   offers to install extra components, click **Install** and wait.
3. In Terminal, run:
   ```
   sudo xcodebuild -license accept && sudo xcode-select -s /Applications/Xcode.app/Contents/Developer && xcodebuild -runFirstLaunch && xcode-select -p
   ```
   ✅ The last line printed must be `/Applications/Xcode.app/Contents/Developer`.
4. In Xcode: menu **Xcode → Settings… → Accounts** → click **+** → *Apple ID*
   → sign in with **Envy's Apple Developer** login. When it appears in the
   left list, click it. On the right you will see a team name and, next to it,
   a **Team ID** like `AB12CD34EF`. **Write it down.**

## Part 3 — Install the helper programs (15 minutes)

In Terminal, run each box **one at a time**, waiting for each to finish.

1. Homebrew (a program installer). It will ask for your Mac password and show
   a long list; press Return when it says *Press RETURN to continue*:
   ```
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
   At the end it prints two lines starting with `echo` and `eval` under
   **Next steps**. Copy and run **those two lines** too.
2. Node and git:
   ```
   brew install node@22 git && brew link --overwrite --force node@22 && node --version
   ```
   ✅ It ends with a version starting `v22` (or higher).
3. Docker (runs the database):
   ```
   brew install --cask docker
   ```
   Then open **Docker** from Applications. Click through its welcome screens
   (skip sign-in). Open Docker's **Settings (gear) → General** and tick
   **Start Docker Desktop when you sign in**. Leave Docker running.
4. Check Docker is alive. In Terminal:
   ```
   docker info > /dev/null && echo DOCKER OK
   ```
   ✅ Prints `DOCKER OK`.

## Part 4 — Get the software (5 minutes)

**If you have the zip on the Desktop:** in Terminal, run:
```
cd ~ && unzip -q ~/Desktop/envy-phone-farm-ios-*.zip && mv envy-phone-farm-ios-* phone-farm && cd ~/phone-farm && ls
```

**If you were given GitHub access instead:** run this and sign in when it asks:
```
cd ~ && git clone https://github.com/tcmaholdings-cyber/envy-phone-farm-ios.git phone-farm && cd ~/phone-farm && ls
```

✅ Either way you now see a list of files including `package.json` and `docs`.

Then install the software's own parts (3–5 minutes):
```
cd ~/phone-farm && npm install && npm run appium:install-driver
```
✅ Ends without the word `ERR!`. Warnings (`WARN`) are fine.

## Part 5 — Fill in the settings file (10 minutes)

1. In Terminal:
   ```
   cd ~/phone-farm && cp .env.example .env && chmod 600 .env && open -a TextEdit .env
   ```
   A text file opens. Every line is `NAME=value`. Change only the lines below.
   Do not add spaces around the `=`.
2. Find and change these lines:

   | Line to find | Change it to |
   | --- | --- |
   | `XCODE_ORG_ID=replace-me` | `XCODE_ORG_ID=` **your Team ID** from Part 2 |
   | `WDA_BUNDLE_ID=com.example.WebDriverAgentRunner` | `WDA_BUNDLE_ID=com.envy.WebDriverAgentRunner` |
   | `IOS_PLATFORM_VERSION=16.7` | `IOS_PLATFORM_VERSION=` **the phones' iOS version**, e.g. `18.6` |
   | `POSTGRES_PASSWORD=CHANGE_ME` | `POSTGRES_PASSWORD=` **your made-up database password** |
   | `DATABASE_URL=postgresql://phone_farm:CHANGE_ME@127.0.0.1:5432/phone_farm` | replace **CHANGE_ME** with the **same** database password |

3. Scroll to the lines starting with `# PHONE_FARM_BRAND_`. Delete those
   lines and paste this block instead:
   ```
   PHONE_FARM_BRAND_NAME=Envy Farm
   PHONE_FARM_BRAND_TITLE=Envy
   PHONE_FARM_BRAND_BY=by Envy LLC
   PHONE_FARM_BRAND_BY_URL=
   PHONE_FARM_BRAND_LOGO=static/brand/envy-logo.png
   PHONE_FARM_FOOTER_TEXT=© 2026 Envy LLC · Powered by Phone Farm iOS Core
   PHONE_FARM_BRAND_URL=
   ```
   (Put Envy's website after the two `=` signs if you want the name to be a link.)
4. **Save** (⌘S) and close TextEdit.
5. Start the database. In Terminal:
   ```
   cd ~/phone-farm && npm run db:up && npm run db:migrate
   ```
   ✅ Ends with something like `migrations applied` and no `ERR`.

## Part 6 — Prepare each iPhone (10 minutes per phone)

On the phone:

1. **Settings → General → Software Update**: install updates so every phone
   is on the same iOS version (the one you wrote in Part 5).
2. **Settings → Display & Brightness → Auto-Lock → Never.**
3. **Settings → Sounds & Haptics**: silent. **Settings → Notifications**: turn
   off for everything except TikTok.
4. **Settings → Display & Brightness → Raise to Wake → off.**
5. Make sure the phone has a **6-digit passcode**. Write it next to the
   phone's label in your table.
6. Plug the phone into the hub. Unlock it. Tap **Trust** on the phone, enter
   the passcode.
7. On the Mac, in Xcode: menu **Window → Devices and Simulators**. The phone
   appears on the left. Wait until it says **Connected** (not *Preparing*).
   This can take a few minutes the first time.
8. On the phone: **Settings → Privacy & Security → Developer Mode → on**. It
   asks to restart; restart, then tap **Turn On** when it asks again. (If
   *Developer Mode* is not in the list, unplug, replug, and check step 7 again.)
9. Check from the Mac. In Terminal:
   ```
   xcrun xctrace list devices
   ```
   ✅ Your phone is listed under **Devices**, not under *Devices Offline*. The
   long code after its name is the **UDID**. You will need it in the next part.

Put a sticker with the phone's label on the back.

## Part 7 — Sign the control app onto the phone (5 minutes per phone)

This must be done **at the Mac, in Terminal, logged in normally** (not by
Screen Sharing from another computer's Terminal, and not over SSH).

In Terminal, replace `PASTE-UDID-HERE` with the phone's UDID from Part 6:
```
cd ~/phone-farm && npm run wda:prepare -- --udid PASTE-UDID-HERE
```
The first run takes several minutes. ✅ It ends with
`** TEST BUILD SUCCEEDED **`.

If the phone shows a pop-up about an untrusted developer: on the phone go to
**Settings → General → VPN & Device Management**, tap the developer entry, tap
**Trust**. Then run the command again.

Repeat Part 6 and Part 7 for every phone.

## Part 8 — Start the farm (2 minutes)

In Terminal:
```
cd ~/phone-farm && PHONE_FARM_LAUNCHD_PREFIX=com.envy.phone-farm deploy/launchd/install-agents.sh
```
✅ It lists five lines starting `installed com.envy.phone-farm.` These five
programs now start by themselves every time the Mac starts, and restart
themselves if they crash.

Wait one minute, then open **Safari** and go to:

**http://127.0.0.1:3000**

✅ You see the **Envy** logo top-left and a page titled **Devices**.

## Part 9 — Register each phone in the dashboard (5 minutes per phone)

1. Click **Register device** (top right).
2. Pick the phone from the list. Give it the **same label** as its sticker.
3. Leave the coordinate profile on **iPhone 8**. (Yes, for iPhone 12 mini too — see the note below.)
4. Type the phone's **passcode** and its **TikTok @handle**.
5. Click through the checks. Each should turn green. If the phone's screen
   lights up asking to unlock, **unlock it once**.
6. Click **Finalize**. The phone now appears on the Devices page as **Online**
   with a picture of its screen.
7. Click **Open device**. Find **Touch points**. For each target in the list
   (Profile tab, Home tab, Create, …): click the target's name, then click on
   the live picture of the screen exactly where that button is on this phone,
   and **Save**. Use **Control device** to tap around and reach the screen a
   button lives on. This is needed because the iPhone 12 mini's screen is
   taller than the iPhone 8 layout the software was drawn for.
8. Still on the device page, find the **TikTok** panel → **Doomscroll** →
   **Run now**. Watch the live screen for a minute. ✅ The phone scrolls TikTok
   by itself and **Activity** shows the run finishing without a red error.

## Part 10 — The reboot test (5 minutes)

Restart the Mac (Apple menu → Restart). Do not touch anything. After two
minutes open Safari at **http://127.0.0.1:3000** again.

✅ Every phone shows **Online** without you doing anything. **You are done.**

---

## Something went wrong?

| What you see | What to do |
| --- | --- |
| `command not found: brew` / `node` / `npm` | Close Terminal, open it again, try again. If still failing, redo Part 3 step 1 including the two **Next steps** lines. |
| `DOCKER OK` never prints | Open the Docker app from Applications and wait for the whale icon in the top bar to stop animating. |
| Phone is under *Devices Offline* | Different cable. Unplug and replug. Unlock the phone and tap **Trust** again. |
| `Developer Mode` is missing on the phone | Do Part 6 step 7 first (Xcode must have seen the phone), then look again. |
| `errSecInternalComponent` during Part 7 | You are not at the Mac's own screen. Sit at the Mac, log in normally, open Terminal there, run it again. |
| `TEST BUILD FAILED` mentioning *provisioning* or *team* | Wrong Team ID in `.env`, or the phone was not plugged in and unlocked. Fix, then run Part 7 again. |
| Dashboard page does not load | Wait a minute and refresh. Still nothing: in Terminal run `tail -20 ~/phone-farm/logs/web.log` and send that text to support. |
| A phone shows **Offline** on the dashboard but is plugged in | Unlock it once. If it stays Offline, run `launchctl kickstart -k gui/$(id -u)/com.envy.phone-farm.wda-service` in Terminal. |
| Taps land in the wrong place during Doomscroll | Redo Part 9 step 7 (Touch points) for that phone. |

When asking for help, say **which Part and step** you were on, and paste the
last 20 lines from the Terminal window.

## Words you will see

- **Terminal** — the app where you type commands.
- **UDID** — a phone's serial-like code, e.g. `00008101-001964122660001E`.
- **Team ID** — the 10-character code of Envy's Apple Developer account.
- **WebDriverAgent (WDA)** — the small control app the Mac installs on each phone. Part 7 builds it.
- **Appium** — the program that lets the Mac talk to that control app. Starts by itself.
- **Dashboard** — the web page at http://127.0.0.1:3000.
- **Coordinate profile / Touch points** — where on the screen the software taps. Part 9 step 7 tunes it per phone.
