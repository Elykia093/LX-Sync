export const playlistQualities = [
  '128k',
  '320k',
  'flac',
  'hires',
  'atmos',
  'atmos_plus',
  'master',
] as const

export type PlaylistQuality = (typeof playlistQualities)[number]
