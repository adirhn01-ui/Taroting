// Minimal inline SVG icon set (stroke-based, currentColor).

const paths: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  play: '<path d="m6 4 14 8-14 8z"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  stepBack: '<path d="M18 5v14L8 12z"/><path d="M6 5v14"/>',
  stepFwd: '<path d="M6 5v14l10-7z"/><path d="M18 5v14"/>',
  loop: '<path d="M17 2v4H7a4 4 0 0 0-4 4v1"/><path d="m17 2 3 3-3 3"/><path d="M7 22v-4h10a4 4 0 0 0 4-4v-1"/><path d="m7 22-3-3 3-3"/>',
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 3h4v6a2 2 0 0 0 4 0V3h4"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 7.9 20 20M8.1 16.1 20 4"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4m0 14v4M4.2 4.2l2.8 2.8m10 10 2.8 2.8M1 12h4m14 0h4M4.2 19.8 7 17m10-10 2.8-2.8"/>',
  export: '<path d="M12 15V3m0 0L7 8m5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>',
  warning: '<path d="M12 3 2 20h20z"/><path d="M12 9v5m0 3v.01"/>',
  flag: '<path d="M4 22V4M4 4h11l-2 4 2 4H4"/>',
};

export function icon(name: keyof typeof paths | string, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name as string] ?? ""}</svg>`;
}
