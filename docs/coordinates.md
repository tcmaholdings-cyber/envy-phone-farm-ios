# Coordinate profiles

**Short answer to "can people add coordinate configs?":** not at runtime. A
coordinate profile is a compiled constant in the source. `devices.json` only
*selects* one that already exists. Adding a new layout means editing two files
and redeploying. Three profiles ship today:

| Profile | Screen (points) | Phones (product types) | Status |
| --- | --- | --- | --- |
| `iphone8` | 375 × 667 | iPhone 8 (`iPhone10,1`, `iPhone10,4`), SE 2nd gen (`iPhone12,8`), SE 3rd gen (`iPhone14,6`); also fits the 7 | measured on a device |
| `iphoneX` | 375 × 812 | iPhone X (`iPhone10,3`, `iPhone10,6`), XS (`iPhone11,2`), 12 mini (`iPhone13,1`), 13 mini (`iPhone14,4`) | derived from `iphone8`, verify on a phone |
| `iphone13` | 390 × 844 | iPhone 12 (`iPhone13,2`), iPhone 13 (`iPhone14,5`) | derived from `iphone8`, verify on a phone |

The registration wizard suggests the right profile from the phone's product
type. XS Max / XR (414 × 896) and the 12 Pro / 13 Pro / 14 are not listed:
the 390 × 844 models could reuse `iphone13` by adding their product types.

The two derived profiles move bottom‑anchored targets (tab bar, Create, picker,
Next/Post, the like/save rail) down by the extra height above the home
indicator, top‑anchored ones (caption, back, account switcher) by the taller
status bar, and scale x with width. Before relying on them, open the device
page, unlock with the padlock (checks the keypad rows), and walk the
**Touch points** list; fix any single‑tap target there. If the keypad, picker
grid or swipe is off, correct the profile itself (see *Measuring coordinates*).

## What a profile is

A profile is a full set of tap targets for one screen geometry, in
**points** (not pixels), defined by the `DeviceCoordinates` interface in
`src/devices/coordinates.ts`:

- `screenSize` — `{ width, height }` in points
- `passcodeKeypad` — column x's and row y's for auto‑unlock
- `tiktok` — every tap/swipe the built‑in TikTok plugin uses (tabs, create,
  media picker grid, caption field, like/save, feed swipe, …)

```ts
export const DEVICE_COORDINATES = {
  iphone8: {
    displayName: 'iPhone 8',
    productTypes: ['iPhone10,1', 'iPhone10,4'],   // iPhone 8 / 8 Plus
    screenSize: { width: 375, height: 667 },
    passcodeKeypad: { columnX: [103, 191, 275], rowY: [220, 347, 425, 506] },
    tiktok: { profileTab: { x: 338, y: 656 }, /* … */ },
  },
} satisfies Record<string, DeviceCoordinates>;

export const DEFAULT_COORDINATE_PROFILE = 'iphone8';
```

`iphone8` (375 × 667) also fits the iPhone SE 2/3 and iPhone 7 — identical
screen geometry.

## How selection works

- `devices.json` → `"coordinateProfile": "<key>"` picks a profile.
- No `coordinateProfile` → `DEFAULT_COORDINATE_PROFILE` (`iphone8`).
- An unknown key throws at load:
  `Unknown coordinate profile "…". Add it to src/devices/coordinates.ts.`
- `coordinateProfiles()` powers the picker in the registration UI;
  `profileForProductType(productType)` can auto‑suggest a profile if the
  device's `productType` is listed in some profile's `productTypes`.

## Adding a profile (e.g. iPhone 13/14, 390 × 844)

1. **`src/devices/coordinates.ts`** — add a key to `DEVICE_COORDINATES`:

   ```ts
   iphone13: {
     displayName: 'iPhone 13/14',
     productTypes: ['iPhone14,5', 'iPhone14,7'],
     screenSize: { width: 390, height: 844 },
     passcodeKeypad: { columnX: [/* … */], rowY: [/* … */] },
     tiktok: { /* every field, re-measured for this screen */ },
   },
   ```

2. **`src/tiktok/coordinates.ts`** — mirror the same `tiktok` block and
   `passcodeKeypad` under the same key. (The standalone TikTok entrypoints load
   their coordinates from this second, self‑contained copy so they can run as
   bare `tsx` scripts. Keep the two in sync.)

3. `npm run typecheck && npm test`, redeploy `web` + `worker`, then set
   `"coordinateProfile": "iphone13"` on the matching `devices.json` entries.

### Measuring coordinates

Open the device's live screen in the dashboard, or
`GET /api/devices/:udid/remote/screenshot`. The image is in points already
(WDA reports a point‑sized screen). Read off each target's centre. Verify by
firing single taps with `POST /api/devices/:udid/remote/action`
(`{ "type": "tap", "x": …, "y": … }`) and watching the screen.

## Per‑device overrides (dashboard calibration)

The **15 single‑tap TikTok targets** — `profileTab`, `homeTab`,
`accountSwitcher`, `create`, `upload`, `selectMultiple`, `useLayout`,
`pickerNext`, `editorNext`, `caption`, `keyboardBack`, `draft`, `finish`,
`like`, `save` — can be re‑pointed per device without a code change, from the
device page → **Touch points**: pick a target, click where it belongs
on the live screen, Save. Reset one point or all of them back to the profile.
Flip **Control device** to drive the phone with taps/swipes on the preview so
you can get to the screen a target lives on, and the padlock button unlocks it.

Overrides are stored on the `devices.json` entry and merge over the selected
profile at runtime (`resolveDeviceCoordinates`):

```jsonc
{ "name": "Phone 12", "coordinateProfile": "iphone8",
  "coordinates": { "like": { "x": 350, "y": 320 }, "create": { "x": 190, "y": 642 } } }
```

API: `GET /api/devices/:udid/coordinates` (effective values + which are
overridden), `PATCH /api/devices/:udid` with `{ "coordinates": { … } }` — the
object **replaces** the whole override map; `{}` clears it. Points are validated
against the profile's screen bounds.

The `picker` grid, `swipe` vector and `passcodeKeypad` are not single points and
stay profile‑level — add a new profile for a materially different layout.

## Why adding a whole profile still needs code

The profile map is a typed `const` so the compiler can guarantee every field
exists and every `devices.json` reference resolves. A JSON/env‑loaded profile
source (validated at startup, same shape) would be a reasonable contribution.
Until then, treat new device geometries as a small PR against
`src/devices/coordinates.ts` + `src/tiktok/coordinates.ts`.

A plugin **cannot** currently register its own coordinate profiles; the
`tiktok` block is specific to the built‑in plugin. A third‑party plugin that
needs screen‑relative taps should ship its own coordinate map inside the
package and key it on `device.productType` or its own `pluginData`.
