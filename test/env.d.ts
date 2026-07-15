/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env as AppEnv } from "../src/util";

// Normalmente gerado por `wrangler types`. Como não roda instalação aqui,
// declaramos manualmente o binding real (Env) + o binding extra só de teste
// (TEST_MIGRATIONS, ver vitest.config.ts) no namespace global Cloudflare.Env
// usado por `env` em "cloudflare:test".
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}

export {};
