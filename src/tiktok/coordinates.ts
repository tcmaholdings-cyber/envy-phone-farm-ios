export interface Point { x: number; y: number }
export interface TikTokCoordinates {
    passcodeKeypad: { columnX: [number, number, number]; rowY: [number, number, number, number] };
    tiktok: {
        profileTab: Point; homeTab: Point; accountSwitcher: Point; create: Point; upload: Point;
        selectMultiple: Point; useLayout: Point;
        picker: { circleX: number; columnStep: number; firstY: number; trayY: number; rowStep: number; cellX: number; cellStep: number; cellY: number };
        pickerNext: Point; editorNext: Point; caption: Point; keyboardBack: Point; draft: Point; finish: Point;
        like: Point; save: Point; swipe: { x: number; startY: number; endY: number; durationMs: number };
    };
}

export const DEVICE_COORDINATES = {
    iphone8: {
        passcodeKeypad: { columnX: [103, 191, 275], rowY: [220, 347, 425, 506] },
        tiktok: {
            profileTab: { x: 338, y: 656 }, homeTab: { x: 38, y: 653 }, accountSwitcher: { x: 185, y: 158 },
            create: { x: 187, y: 640 }, upload: { x: 30, y: 635 }, selectMultiple: { x: 24, y: 618 },
            useLayout: { x: 24, y: 489 },
            picker: { circleX: 106, columnStep: 126, firstY: 482, trayY: 360, rowStep: 125, cellX: 62, cellStep: 125, cellY: 526 },
            pickerNext: { x: 277, y: 617 }, editorNext: { x: 277, y: 637 }, caption: { x: 120, y: 236 },
            keyboardBack: { x: 22, y: 42 }, draft: { x: 98, y: 630 }, finish: { x: 277, y: 630 },
            like: { x: 345, y: 313 }, save: { x: 345, y: 444 }, swipe: { x: 187, startY: 550, endY: 150, durationMs: 450 },
        },
    },
    iphoneX: {
        passcodeKeypad: { columnX: [103, 191, 275], rowY: [292, 419, 497, 578] },
        tiktok: {
            profileTab: { x: 338, y: 767 }, homeTab: { x: 38, y: 764 }, accountSwitcher: { x: 185, y: 182 },
            create: { x: 187, y: 751 }, upload: { x: 30, y: 746 }, selectMultiple: { x: 24, y: 729 },
            useLayout: { x: 24, y: 600 },
            picker: { circleX: 106, columnStep: 126, firstY: 593, trayY: 471, rowStep: 125, cellX: 62, cellStep: 125, cellY: 637 },
            pickerNext: { x: 277, y: 728 }, editorNext: { x: 277, y: 748 }, caption: { x: 120, y: 260 },
            keyboardBack: { x: 22, y: 66 }, draft: { x: 98, y: 741 }, finish: { x: 277, y: 741 },
            like: { x: 345, y: 424 }, save: { x: 345, y: 555 }, swipe: { x: 187, startY: 670, endY: 180, durationMs: 450 },
        },
    },
    iphone13: {
        passcodeKeypad: { columnX: [111, 199, 283], rowY: [308, 435, 513, 594] },
        tiktok: {
            profileTab: { x: 353, y: 799 }, homeTab: { x: 38, y: 796 }, accountSwitcher: { x: 192, y: 185 },
            create: { x: 195, y: 783 }, upload: { x: 31, y: 778 }, selectMultiple: { x: 25, y: 761 },
            useLayout: { x: 25, y: 632 },
            picker: { circleX: 110, columnStep: 131, firstY: 625, trayY: 503, rowStep: 130, cellX: 64, cellStep: 130, cellY: 669 },
            pickerNext: { x: 288, y: 760 }, editorNext: { x: 288, y: 780 }, caption: { x: 125, y: 263 },
            keyboardBack: { x: 22, y: 69 }, draft: { x: 102, y: 773 }, finish: { x: 288, y: 773 },
            like: { x: 360, y: 456 }, save: { x: 360, y: 587 }, swipe: { x: 195, startY: 696, endY: 190, durationMs: 450 },
        },
    },
} satisfies Record<string, TikTokCoordinates>;

export type CoordinateProfile = keyof typeof DEVICE_COORDINATES;
export function coordinatesForProfile(profile = 'iphone8'): TikTokCoordinates {
    if (!(profile in DEVICE_COORDINATES)) throw new Error(`Unknown TikTok coordinate profile "${profile}"`);
    return DEVICE_COORDINATES[profile as CoordinateProfile];
}
