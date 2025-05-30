import { GlobalConfig } from '@/config/config.type';
import { CacheService } from '@/shared/cache/cache.service';
import { EmailQueue } from '@/worker/queues/email/email.type';
import { ConfigService } from '@nestjs/config';
import { magicLink, username } from 'better-auth/plugins';
import { BetterAuthOptions } from 'better-auth/types';
import { Pool } from 'pg';
import { v4 as uuid } from 'uuid';

/**
 * Better auth configuration
 * Visit https://www.better-auth.com/docs/reference/options to see full options
 */
export function getConfig({
  configService,
  cacheService,
  emailQueue,
}: {
  configService: ConfigService<GlobalConfig>;
  cacheService: CacheService;
  emailQueue: EmailQueue;
}): BetterAuthOptions {
  const appConfig = configService.getOrThrow('app', { infer: true });
  const databaseConfig = configService.getOrThrow('database', { infer: true });
  const authConfig = configService.getOrThrow('auth', { infer: true });

  return {
    appName: appConfig.name,
    secret: authConfig.authSecret,
    baseURL: appConfig.url,
    plugins: [
      username(),
      magicLink({
        disableSignUp: true,
        async sendMagicLink({ email, url }) {
          await emailQueue.add('signin-magic-link', {
            email,
            url,
          });
        },
      }),
    ],
    database: new Pool({
      database: databaseConfig.database,
      user: databaseConfig.username,
      password: databaseConfig.password,
      host: databaseConfig.host,
      port: databaseConfig.port,
      ...(typeof databaseConfig.ssl === 'object'
        ? {
            ssl: {
              rejectUnauthorized: databaseConfig.ssl?.rejectUnauthorized,
              ca: databaseConfig.ssl?.ca,
              key: databaseConfig.ssl?.key,
              cert: databaseConfig.ssl?.cert,
            },
          }
        : {}),
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: true,
    },
    session: {
      freshAge: 10,
      modelName: 'session',
    },
    user: {
      modelName: 'user',
      fields: {
        name: 'username',
        emailVerified: 'isEmailVerified',
      },
    },
    account: {
      modelName: 'account',
    },
    verification: {
      modelName: 'verification',
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await emailQueue.add('email-verification', {
          url,
          userId: user.id,
        });
      },
    },
    trustedOrigins: appConfig.corsOrigin as string[],
    socialProviders: {
      ...(authConfig.oAuth.github?.clientId &&
      authConfig.oAuth.github?.clientSecret
        ? {
            github: {
              clientId: authConfig.oAuth.github?.clientId,
              clientSecret: authConfig.oAuth.github?.clientSecret,
              mapProfileToUser(profile) {
                return {
                  email: profile.email,
                  name: profile.login,
                  username: profile.login,
                  emailVerified: true,
                  image: profile.avatar_url,
                };
              },
            },
          }
        : {}),
    },
    advanced: {
      database: {
        generateId() {
          return uuid();
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if ('displayUsername' in user) {
              delete user.displayUsername;
            }
            return { data: user };
          },
        },
      },
    },
    // Use Redis for storing sessions
    secondaryStorage: {
      get: async (key) => {
        return (
          (await cacheService.get({ key: 'AccessToken', args: [key] })) ?? null
        );
      },
      set: async (key, value, ttl) => {
        await cacheService.set(
          { key: 'AccessToken', args: [key] },
          value,
          ttl
            ? {
                ttl: ttl,
              }
            : {},
        );
      },
      delete: async (key) => {
        await cacheService.delete({ key: 'AccessToken', args: [key] });
      },
    },
  };
}
