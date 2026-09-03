# Installing on a fresh Mac mini

A complete, ordered runbook for standing the farm up on a new macOS host with a
rack of iPhones. It assumes nothing is installed. Budget half a day for the
first machine; the phone steps are the slow part.

Read once before starting: [architecture.md](architecture.md) (what the four
processes do) and [configuration.md](configuration.md) (every setting).

## 0. Hardware and accounts

| Item | Notes |
| --- | --- |
| Mac mini (Apple silicon), macOS 14+ | One farm host per rack. Keep it on mains power, never sleeping (System Settings → Energy → *Prevent automatic sleeping*), and logged in to a **graphical session** — the WebDriverAgent launcher needs one. |
| Powered USB hub(s) | One USB-C/A port per phone. Data-capable cables; cheap charge-only cables are the #1 cause of "device offline". |
| iPhones (this fleet: iPhone 12 mini) | Each with its own Apple ID signed in, TikTok installed and logged in, Developer Mode on. See §5. |
| Apple Developer account | A **paid** Team (US$99/yr) for more than one device and for profiles that do not expire weekly. Note the 10-character Team ID. |
| Admin user on the Mac | Everything below runs as one normal user account, e.g. `farm`. Give it *Automatic login* so agents come back after a power cut. |

## 1. macOS baseline

```sh
softwareupdate --install --all               # current macOS + security patches
sudo systemsetup -setcomputersleep Never      # never sleep on mains
sudo systemsetup -setremotelogin on           # SSH for administration (optional)
```

Enable **Screen Sharing** (System Settings → General → Sharing) so you can reach
the graphical session remotely: several steps below fail over plain SSH.

## 2. Toolchain

1. **Xcode** — full app from the App Store (the Command Line Tools alone are
   not enough). Then:
   ```sh
   sudo xcodebuild -license accept
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   xcodebuild -runFirstLaunch
   xcode-select -p        # must print …/Xcode.app/Contents/Developer
   ```
   Open Xcode → Settings → Accounts → add the Apple ID that belongs to the
   Developer Team. The Team ID shown there is `XCODE_ORG_ID`.
2. **Homebrew, Node 22+, Docker**
   ```sh
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   brew install node@22 git
   brew install --cask docker         # Docker Desktop; open it once and enable "Start at login"
   node --version                     # v22 or newer
   docker info >/dev/null && echo docker ok
   ```
   PostgreSQL can instead be installed natively (`brew install postgresql@17`);
   then set `DATABASE_URL` accordingly and skip `npm run db:up`.

## 3. Get the code

```sh
git clone <your-git-remote> ~/phone-farm      # the transferred repository
cd ~/phone-farm
npm install
npm run appium:install-driver                 # XCUITest driver 12.9.0 into ./.appium2 (git-ignored)
```

`npm install` builds a couple of native modules (`sharp`, `node-native-ocr`);
that needs the Xcode Command Line Tools already present from step 2.

## 4. Configure

```sh
cp .env.example .env
chmod 600 .env
```

Edit `.env`. The minimum for a working farm:

| Key | Value |
| --- | --- |
| `XCODE_ORG_ID` | your Team ID |
| `WDA_BUNDLE_ID` | a bundle id you control, e.g. `com.envy.WebDriverAgentRunner` — must be unique per Team |
| `IOS_PLATFORM_VERSION` | the iOS version on the phones, e.g. `18.6` |
| `POSTGRES_PASSWORD` / `DATABASE_URL` | pick a real password; put the same one in both |
| branding block | see [branding.md](branding.md) — for Envy LLC use the values in [handover.md](handover.md) and drop the logo at `static/brand/logo.png` |

Leave `WEB_HOST=127.0.0.1`. If the dashboard must be reachable from other
machines, read the *Exposure* section in [configuration.md](configuration.md)
first — startup refuses a non-loopback bind without an auth provider.

Start the database and apply the schema:

```sh
npm run db:up          # docker: postgres:17 on 127.0.0.1:5432, data in a named volume
npm run db:migrate     # scheduler + pg-boss schema
```

## 5. Prepare each iPhone

Per phone, in this order:

1. Settings → General → Software Update: same iOS version across the fleet
   (it must match `IOS_PLATFORM_VERSION`).
2. Sign in with the phone's own Apple ID; install TikTok; sign in to the
   TikTok account(s) the phone will run.
3. Display → Auto-Lock → **Never**; Sounds → silent; disable Notifications
   for everything except TikTok; disable *Raise to Wake*.
4. Set a 6-digit passcode you will record in the registration wizard (the
   farm auto-unlocks with it).
5. Connect by USB, unlock, tap **Trust This Computer**. In Xcode → Window →
   Devices and Simulators wait until the phone reads *Connected* (Xcode is
   mounting the Developer Disk Image).
6. Settings → Privacy & Security → **Developer Mode** → on → restart → confirm.
   The toggle only appears after the first pairing with Xcode.
7. Confirm: `xcrun xctrace list devices` lists it under *Devices* (not
   *Devices Offline*).

Label the phone physically with the name you will register it under.

## 6. Build and sign WebDriverAgent

From **Terminal.app in the graphical session** (not SSH — signing needs the
unlocked login keychain):

```sh
npm run wda:prepare -- --udid <udid>     # one phone
npm run wda:prepare -- --all             # every phone in devices.json (later)
```

The first run patches the Appium-bundled WebDriverAgent (`Patches/`), then
`xcodebuild build-for-testing` signs it for your Team and embeds a
provisioning profile listing the connected UDIDs. It ends with
`** TEST BUILD SUCCEEDED **`. Re-run it whenever you add a phone (the profile
must list the new UDID) or change `XCODE_ORG_ID` / `WDA_BUNDLE_ID`.

## 7. Run the four processes

For a first smoke test, four terminals:

```sh
npm run appium         # Appium 3 on 127.0.0.1:4725
npm run wda:service    # one WebDriverAgent per registered phone (+ USB port forwards)
npm run worker         # scheduler
npm run web            # dashboard on http://127.0.0.1:3000
```

For the always-on host, install the launchd agents instead (they start at
login, restart on crash, and log to `logs/`):

```sh
PHONE_FARM_LAUNCHD_PREFIX=com.envy.phone-farm deploy/launchd/install-agents.sh
launchctl list | grep phone-farm
tail -f logs/web.log
```

See [operations.md](operations.md) for restart, logs and upgrades.

## 8. Register the phones

Open <http://127.0.0.1:3000> → **Register device**. Pick the phone, give it
its label, choose the coordinate profile (see the note below), enter the
passcode and its TikTok account handle(s), and step through the checks
(host → connection → signing → developer → WDA → Appium → video → touch →
TikTok → accounts). Unlock the phone when WDA first launches. **Finalize**
writes the phone to `devices.json` (git-ignored, `0600`) and the worker picks
it up within 30 s.

> **Coordinate profile for iPhone 12 mini.** The shipped tap-layout profile is
> `iphone8` (375 × 667 pt). The 12 mini's logical screen is 375 × 812 pt. The
> existing farm runs 12 minis on the `iphone8` profile and corrects the 15
> single-tap TikTok targets per device from the device page → **Touch
> points** (see [coordinates.md](coordinates.md)). Do that calibration once per
> phone after registration, then run a `doomscroll` task and watch the live
> screen. A dedicated `iphone12mini` profile is the recommended follow-up
> (a small change in `src/devices/coordinates.ts` + `src/tiktok/coordinates.ts`).

## 9. First automation

Device page → **TikTok** panel → *Doomscroll* → **Run now**. Watch the live
screen and **Activity**. Then schedule it `daily` in the phone's local
timezone. Full logs: `GET /api/executions/:id`.

## 10. Acceptance checklist

- [ ] `curl -s http://127.0.0.1:3000/health` lists `com.git-agni.tiktok`
- [ ] every phone shows **Online** on the dashboard grid with a live screenshot
- [ ] `wda:service` health (`curl --unix-socket .wda/wda-service.sock http://x/health`) reports `ready` for every phone
- [ ] a `doomscroll` execution finishes with exit code 0 on every phone
- [ ] after `sudo reboot`, all five agents are back and phones return to Online without touching anything
- [ ] `.env`, `devices.json` are `0600`; `git status` shows neither
- [ ] the dashboard shows the licensee's name, logo and footer ([branding.md](branding.md))
