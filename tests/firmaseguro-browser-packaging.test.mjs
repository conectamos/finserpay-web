import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("private browser image contains only Playwright and its proxy, without app or database artifacts", () => {
  const source = readFileSync(new URL("../Dockerfile.firmaseguro-browser", import.meta.url), "utf8");
  const runner = source.split(/FROM .* AS runner\r?\n/)[1];
  assert.ok(runner);
  const copies = runner.split(/\r?\n/).filter(line => line.startsWith("COPY "));
  assert.deepEqual(copies, [
    "COPY --from=deps /app/node_modules/playwright ./node_modules/playwright",
    "COPY --from=deps /app/node_modules/playwright-core ./node_modules/playwright-core",
    "COPY scripts/firmaseguro-browser-worker.mjs ./scripts/firmaseguro-browser-worker.mjs",
  ]);
  assert.match(source, /npm ci --omit=dev --ignore-scripts/);
  assert.match(runner, /USER node/);
  assert.match(runner, /ENV PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
  assert.match(runner, /install --with-deps --only-shell chromium/);
  assert.doesNotMatch(runner, /\.env|DATABASE_URL|FIRMASEGURO_PASSWORD|\.next|prisma|server\.js/);
});
