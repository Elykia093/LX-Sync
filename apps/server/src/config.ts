import { z } from 'zod'

const base64Key = z.string().refine((value) => {
  return (
    /^[A-Za-z0-9+/]{43}=$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  )
}, 'must be a base64 encoded 32-byte key')

const configSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(9527),
  SERVER_NAME: z.string().trim().min(1).max(64).default('LX Sync'),
  DATABASE_URL: z.string().min(1),
  MASTER_KEY: base64Key,
  ADMIN_USERNAME: z.string().trim().min(1).max(64).default('admin'),
  ADMIN_PASSWORD: z.string().min(12).max(256),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  MAX_SNAPSHOTS: z.coerce.number().int().min(1).max(1000).default(10),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  PUBLIC_ORIGIN: z
    .string()
    .url()
    .transform((value) => value.replace(/\/$/, ''))
    .optional(),
  WEB_DIST_PATH: z.string().min(1).optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
})

export type AppConfig = z.infer<typeof configSchema>

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return configSchema.parse(environment)
}
