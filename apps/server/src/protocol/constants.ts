export const LX_SYNC = {
  helloMessage: 'Hello~::^-^::~v4~',
  idPrefix: 'OjppZDo6',
  authMessagePrefix: 'lx-music auth::',
  connectMessage: 'lx-music connect',
  authFailedMessage: 'Auth failed',
  blockedIpMessage: 'Blocked IP',
  closeCode: {
    normal: 1000,
    failed: 4100,
  },
  featureVersion: {
    list: 1,
    dislike: 1,
  },
} as const

export type SyncDomain = keyof typeof LX_SYNC.featureVersion
