import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // bindings extras só para o ambiente de teste — não vão pro wrangler.toml.
          // ADMIN_PASSWORD sobrescreve o secret real só durante os testes.
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_PASSWORD: "senha-de-teste",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
