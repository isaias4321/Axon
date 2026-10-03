import "dotenv/config";

import { buildApp } from "./app.js";
import { loadEnv } from "./config.js";
import { createLogger } from "./lib/logger.js";

async function main() {
  const env = loadEnv();
  const logger = createLogger(env);
  const app = await buildApp(env, logger);

  try {
    await app.listen({
      port: env.PORT,
      host: env.HOST,
    });

    logger.info(
      {
        port: env.PORT,
        docs: `http://localhost:${env.PORT}/docs`,
      },
      "Axon no ar"
    );
  } catch (error) {
    logger.error(
      { err: error },
      "Falha ao iniciar o servidor"
    );

    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(
    "Erro fatal ao iniciar o servidor:",
    error
  );

  process.exit(1);
});

