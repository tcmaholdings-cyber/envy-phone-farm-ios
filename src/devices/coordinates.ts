export interface Point {
    x: number;
    y: number;
}

export interface DeviceCoordinates {
    displayName: string;
    productTypes: readonly string[];
    screenSize: {
        width: number;
        height: number;
    };
    passcodeKeypad: {
        columnX: [number, number, number];
        rowY: [number, number, number, number];
    };
    tiktok: {
        profileTab: Point;
        homeTab: Point;
        accountSwitcher: Point;
        create: Point;
        upload: Point;
        selectMultiple: Point;
        useLayout: Point;
        picker: {
            circleX: number;
            columnStep: number;
            firstY: number;
            trayY: number;
            rowStep: number;
            cellX: number;
            cellStep: number;
            cellY: number;
        };
        pickerNext: Point;
        editorNext: Point;
        caption: Point;
        keyboardBack: Point;
        draft: Point;
        finish: Point;
        like: Point;
        save: Point;
        swipe: {
            x: number;
            startY: number;
            endY: number;
            durationMs: number;
        };
    };
}

export const DEFAULT_COORDINATE_PROFILE = 'iphone8';

// Add another named layout here, then set that key as coordinateProfile on
// the matching devices.json entry. Devices without a key use iphone8.
// One profile per screen geometry: phones that share a point size share a
// profile. iphone8 was measured on a device; iphoneX and iphone13 were derived
// from it (bottom-anchored targets move down with the taller screen above the
// home indicator, top-anchored ones by the taller status bar, x scales with
// width) and must be checked on a real phone before they are trusted.
export const DEVICE_COORDINATES = {
    iphone8: {
        displayName: 'iPhone 8 / SE',
        productTypes: ['iPhone10,1', 'iPhone10,4', 'iPhone12,8', 'iPhone14,6'],
        screenSize: { width: 375, height: 667 },
        passcodeKeypad: {
            columnX: [103, 191, 275],
            rowY: [220, 347, 425, 506],
        },
        tiktok: {
            profileTab: { x: 338, y: 656 },
            homeTab: { x: 38, y: 653 },
            accountSwitcher: { x: 185, y: 158 },
            create: { x: 187, y: 640 },
            upload: { x: 30, y: 635 },
            selectMultiple: { x: 24, y: 618 },
            useLayout: { x: 24, y: 489 },
            picker: {
                circleX: 106,
                columnStep: 126,
                firstY: 482,
                trayY: 360,
                rowStep: 125,
                cellX: 62,
                cellStep: 125,
                cellY: 526,
            },
            pickerNext: { x: 277, y: 617 },
            editorNext: { x: 277, y: 637 },
            caption: { x: 120, y: 236 },
            keyboardBack: { x: 22, y: 42 },
            draft: { x: 98, y: 630 },
            finish: { x: 277, y: 630 },
            like: { x: 345, y: 313 },
            save: { x: 345, y: 444 },
            swipe: { x: 187, startY: 550, endY: 150, durationMs: 450 },
        },
    },
    iphoneX: {
        displayName: 'iPhone X / XS / 12 mini / 13 mini',
        productTypes: ['iPhone10,3', 'iPhone10,6', 'iPhone11,2', 'iPhone13,1', 'iPhone14,4'],
        screenSize: { width: 375, height: 812 },
        passcodeKeypad: {
            columnX: [103, 191, 275],
            rowY: [292, 419, 497, 578],
        },
        tiktok: {
            profileTab: { x: 338, y: 767 },
            homeTab: { x: 38, y: 764 },
            accountSwitcher: { x: 185, y: 182 },
            create: { x: 187, y: 751 },
            upload: { x: 30, y: 746 },
            selectMultiple: { x: 24, y: 729 },
            useLayout: { x: 24, y: 600 },
            picker: {
                circleX: 106,
                columnStep: 126,
                firstY: 593,
                trayY: 471,
                rowStep: 125,
                cellX: 62,
                cellStep: 125,
                cellY: 637,
            },
            pickerNext: { x: 277, y: 728 },
            editorNext: { x: 277, y: 748 },
            caption: { x: 120, y: 260 },
            keyboardBack: { x: 22, y: 66 },
            draft: { x: 98, y: 741 },
            finish: { x: 277, y: 741 },
            like: { x: 345, y: 424 },
            save: { x: 345, y: 555 },
            swipe: { x: 187, startY: 670, endY: 180, durationMs: 450 },
        },
    },
    iphone13: {
        displayName: 'iPhone 12 / 13',
        productTypes: ['iPhone13,2', 'iPhone14,5'],
        screenSize: { width: 390, height: 844 },
        passcodeKeypad: {
            columnX: [111, 199, 283],
            rowY: [308, 435, 513, 594],
        },
        tiktok: {
            profileTab: { x: 353, y: 799 },
            homeTab: { x: 38, y: 796 },
            accountSwitcher: { x: 192, y: 185 },
            create: { x: 195, y: 783 },
            upload: { x: 31, y: 778 },
            selectMultiple: { x: 25, y: 761 },
            useLayout: { x: 25, y: 632 },
            picker: {
                circleX: 110,
                columnStep: 131,
                firstY: 625,
                trayY: 503,
                rowStep: 130,
                cellX: 64,
                cellStep: 130,
                cellY: 669,
            },
            pickerNext: { x: 288, y: 760 },
            editorNext: { x: 288, y: 780 },
            caption: { x: 125, y: 263 },
            keyboardBack: { x: 22, y: 69 },
            draft: { x: 102, y: 773 },
            finish: { x: 288, y: 773 },
            like: { x: 360, y: 456 },
            save: { x: 360, y: 587 },
            swipe: { x: 195, startY: 696, endY: 190, durationMs: 450 },
        },
    },
} satisfies Record<string, DeviceCoordinates>;

// Marketing names for the product types above, so a phone on a shared
// profile is still listed as its own model.
const MODEL_NAMES: Readonly<Record<string, string>> = {
    'iPhone10,1': 'iPhone 8', 'iPhone10,4': 'iPhone 8',
    'iPhone12,8': 'iPhone SE (2nd generation)', 'iPhone14,6': 'iPhone SE (3rd generation)',
    'iPhone10,3': 'iPhone X', 'iPhone10,6': 'iPhone X',
    'iPhone11,2': 'iPhone XS',
    'iPhone13,1': 'iPhone 12 mini',
    'iPhone13,2': 'iPhone 12',
    'iPhone14,4': 'iPhone 13 mini',
    'iPhone14,5': 'iPhone 13',
};

export type CoordinateProfile = keyof typeof DEVICE_COORDINATES;
export type DeviceProfileName = CoordinateProfile;
export const DEFAULT_DEVICE_PROFILE = DEFAULT_COORDINATE_PROFILE;

export interface CoordinateProfileSummary {
    name: CoordinateProfile;
    displayName: string;
    productTypes: readonly string[];
    screenSize: DeviceCoordinates['screenSize'];
}

export function coordinateProfiles(): CoordinateProfileSummary[] {
    return Object.entries(DEVICE_COORDINATES).map(([name, coordinates]) => ({
        name: name as CoordinateProfile,
        displayName: coordinates.displayName,
        productTypes: [...coordinates.productTypes],
        screenSize: { ...coordinates.screenSize },
    }));
}

export function profileForProductType(productType: string | undefined): CoordinateProfile | undefined {
    if (!productType) return;
    return coordinateProfiles().find(({ productTypes }) => productTypes.includes(productType))?.name;
}

export function modelNameForProductType(productType: string | undefined): string | undefined {
    if (!productType) return;
    return MODEL_NAMES[productType];
}

export function coordinatesForProfile(profile: string = DEFAULT_COORDINATE_PROFILE): DeviceCoordinates {
    if (!(profile in DEVICE_COORDINATES)) {
        throw new Error(`Unknown coordinate profile "${profile}". Add it to src/devices/coordinates.ts.`);
    }
    return DEVICE_COORDINATES[profile as CoordinateProfile];
}

// The single-tap TikTok targets an operator can re-point from the dashboard.
// (picker grid, swipe vector and the passcode keypad are not single points and
// stay profile-level for now.)
export const CALIBRATABLE_POINTS = [
    'profileTab', 'homeTab', 'accountSwitcher', 'create', 'upload', 'selectMultiple', 'useLayout',
    'pickerNext', 'editorNext', 'caption', 'keyboardBack', 'draft', 'finish', 'like', 'save',
] as const;

export type CalibratablePoint = typeof CALIBRATABLE_POINTS[number];

export const POINT_LABELS: Record<CalibratablePoint, string> = {
    profileTab: 'TikTok: Profile tab', homeTab: 'TikTok: Home tab', accountSwitcher: 'TikTok: Account switcher',
    create: 'TikTok: Create (+)', upload: 'TikTok: Upload', selectMultiple: 'TikTok: Select multiple', useLayout: 'TikTok: Use layout',
    pickerNext: 'TikTok: Media picker · Next', editorNext: 'TikTok: Editor · Next', caption: 'TikTok: Caption field',
    keyboardBack: 'TikTok: Keyboard · back', draft: 'TikTok: Save draft', finish: 'TikTok: Post / Finish',
    like: 'TikTok: Like button', save: 'TikTok: Save/bookmark button',
};

/** Per-device overrides for the calibratable points, stored on the devices.json entry. */
export type DeviceCoordinateOverrides = Partial<Record<CalibratablePoint, Point>>;

/** The profile's coordinates with any per-device single-tap overrides applied. */
export function resolveDeviceCoordinates(
    profile: string | undefined,
    overrides: DeviceCoordinateOverrides | undefined,
): DeviceCoordinates {
    const base = coordinatesForProfile(profile);
    if (!overrides) return base;
    const tiktok = { ...base.tiktok };
    for (const name of CALIBRATABLE_POINTS) {
        const point = overrides[name];
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
            tiktok[name] = { x: Math.round(point.x), y: Math.round(point.y) };
        }
    }
    return { ...base, tiktok };
}

/** Validate an override map: known keys only, integer points within the profile's screen. */
export function validateCoordinateOverrides(
    value: unknown,
    profile: string | undefined,
): DeviceCoordinateOverrides {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('coordinates must be an object');
    const { width, height } = coordinatesForProfile(profile).screenSize;
    const result: DeviceCoordinateOverrides = {};
    for (const [key, point] of Object.entries(value as Record<string, unknown>)) {
        if (!CALIBRATABLE_POINTS.includes(key as CalibratablePoint)) throw new Error(`Unknown calibratable point "${key}"`);
        if (!point || typeof point !== 'object') throw new Error(`${key} must be a {x, y} point`);
        const { x, y } = point as { x: unknown; y: unknown };
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`${key} x and y must be numbers`);
        }
        if (x < 0 || y < 0 || x > width || y > height) {
            throw new Error(`${key} (${x}, ${y}) is outside the ${width}×${height} screen`);
        }
        result[key as CalibratablePoint] = { x: Math.round(x), y: Math.round(y) };
    }
    return result;
}
