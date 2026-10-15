import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { expireStaleBargains } from './modules/bargains/bargains.service.js';

app.listen(env.PORT, () => {
  logger.info(`API running on http://localhost:${env.PORT}`);
});

// Close bargains whose time ran out. They are also closed on read, so users never see stale states.
setInterval(() => {
  expireStaleBargains().catch((err) => logger.error(err, 'expireStaleBargains failed'));
}, 60 * 1000).unref();