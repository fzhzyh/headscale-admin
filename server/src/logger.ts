/**
 * 日志：Fastify 内置 pino，这里只做统一配置与敏感字段脱敏。
 */
import { loadConfig } from './config.ts';

/** 这些字段一旦出现在日志里必须打码 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'apiKey',
  'token',
  'secret',
  'pwd',
  'pwdHash',
  'totpSecret',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'privateJwk',
];

export function loggerOptions(): Record<string, unknown> {
  const cfg = loadConfig();
  const pretty = !cfg.isProd;
  return {
    level: cfg.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}
