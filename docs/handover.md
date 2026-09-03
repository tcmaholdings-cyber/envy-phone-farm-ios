# Handover: transferring a farm to a licensee

How to hand this software, and optionally a running farm, to another operator
(the worked example is **Envy LLC**, taking over a rack of iPhone 12 minis on a
new Mac mini). The transfer is a git repository plus a short list of things
that deliberately do **not** travel in git.

## 1. What is transferred

| Item | How |
| --- | --- |
| Source code, docs, tests, deploy scripts | git — the whole history of this repository, or a squashed release branch if you prefer not to share history |
| Licence | `LICENSE` (Apache-2.0) + `NOTICE` stay in the tree; the grant document `LICENSE-GRANT.md` is signed separately |
| Branding | The licensee's `.env` (`PHONE_FARM_BRAND_*`) and their logo file — never committed to the shared tree |
| Operating knowledge | `docs/install-mac-mini.md`, `docs/configuration.md`, `docs/operations.md`; `AGENTS.md` for engineers and AI agents |

## 2. What is NOT transferred (and must be recreated by the licensee)

| Item | Why | What they do instead |
| --- | --- | --- |
| `.env` | secrets, signing identity, DB password | `cp .env.example .env`, fill in their own values |
| `devices.json` | UDIDs, passcodes, calibration of *your* phones | re-register their phones through the wizard |
| Apple Developer Team / signing certificate | Apple ToS; a Team is per legal entity | their own paid Team; `XCODE_ORG_ID`, `WDA_BUNDLE_ID` |
| PostgreSQL data (schedules, history, uploads) | operational data of the previous operator | fresh `db:migrate`; export a `pg_dump` only if both parties want history moved |
| `.appium2/`, DerivedData, `.wda/` | machine-local build products | `npm run appium:install-driver`, `npm run wda:prepare` |
| TikTok accounts on the phones | belong to the phones' owner | already on their phones |

Run this before publishing the transfer repository and confirm it prints nothing:

```sh
git ls-files | grep -E '^\.env$|^\.env\.|devices\.json|\.appium2/|static/brand/[^.]' ; git grep -nE 'BEGIN (RSA|OPENSSH|CERTIFICATE)|xox[bp]-|AKIA[0-9A-Z]{16}' -- . ':!package-lock.json'
```

## 3. Publishing the transfer repository

From the current origin (`Git-Agni/prod-FARM-IOS-Core`):

```sh
# 1. tag the exact state being handed over
git checkout main && git pull
git tag -a v0.1.0-handover-envy -m "Handover to Envy LLC — white-label + docs"
# 2. create the licensee's empty repository (their GitHub org, private), then
git remote add envy git@github.com:<envy-org>/phone-farm-ios.git
git push envy main --tags            # full history
#    — or, without history —
git checkout --orphan envy-main && git commit -m "Phone Farm iOS Core — licensed to Envy LLC" && git push envy envy-main:main
# 3. on GitHub: protect main, enable Actions (CI is GitHub-hosted only — see SECURITY.md), add the licensee's engineers
```

The licensee then follows `docs/install-mac-mini.md` on their Mac mini. Their
first commit should be the branding + launchd prefix (`.env` is not committed,
so this is really just `static/brand/` artwork if they choose to track it).

## 4. Envy LLC specifics

**Branding** (`.env` on the Envy host; logo file at `static/brand/logo.png`):

```sh
PHONE_FARM_BRAND_NAME=Envy Farm
PHONE_FARM_BRAND_TITLE=Envy
PHONE_FARM_BRAND_BY=by Envy LLC
PHONE_FARM_BRAND_BY_URL=https://envy.example        # replace with Envy's site
PHONE_FARM_BRAND_LOGO=static/brand/logo.png
PHONE_FARM_FOOTER_TEXT=© 2026 Envy LLC · Powered by Phone Farm iOS Core
PHONE_FARM_BRAND_URL=https://envy.example
PHONE_FARM_LAUNCHD_PREFIX=com.envy.phone-farm       # read by deploy/launchd/install-agents.sh only
```

**Fleet:** iPhone 12 mini (375 × 812 pt). Register each phone with the
`iphone8` profile and calibrate the TikTok touch points per device, exactly as
the current farm does; see the note in `docs/install-mac-mini.md` §8 and the
follow-up item below.

**Same iOS version across the rack**, recorded in `IOS_PLATFORM_VERSION`.

**Pinned toolchain that is known to work together:** Node 22+, Appium 3.7,
XCUITest driver 12.9.0 (`npm run appium:install-driver`), WebDriverAgent
patches in `Patches/` (8.9.1), PostgreSQL 17. The Mac mini that currently runs
this fleet is on Xcode 26.6.

## 5. Recommended follow-ups for the licensee

1. **`iphone12mini` coordinate profile** — measure once, add to
   `src/devices/coordinates.ts` and `src/tiktok/coordinates.ts`
   (`docs/coordinates.md`), and the per-phone calibration mostly disappears.
2. **Auth provider** before any non-loopback bind (`docs/configuration.md` → Exposure).
3. **Nightly backups** (`docs/operations.md` → Backups) and an uptime check on `/health`.
4. **A staging phone** that receives TikTok updates first, so layout changes
   are caught before the rack.

## 6. Support boundary

Unless the signed `LICENSE-GRANT.md` says otherwise, the software is delivered
as-is under Apache-2.0 §7 (no warranty). Bug reports and fixes flow through
the licensee's own repository; the licensor may, at its option, accept
upstream contributions.
