import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { installDianaExtensionRequestSchema } from "../scripts/diana-extension-request-schema.mjs";

test("the standalone preparation module is importable without credentials and never activates automation", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", "const m=await import('./scripts/ensure-diana-extension-request-schema.mjs');if(typeof m.ensureDianaExtensionRequestSchema!=='function')process.exit(2)"],
    { cwd: new URL("..", import.meta.url), env: { ...process.env, DATABASE_URL: "" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
});

test("schema changes hold a transaction advisory lock and roll back a failed DDL before another deployment can proceed", async () => {
  const calls = [];
  await assert.rejects(installDianaExtensionRequestSchema({ query: async sql => {
    calls.push(sql); if (sql.startsWith('CREATE TABLE IF NOT EXISTS "DianaExtensionRequest"')) throw new Error("offline DDL failure");
    return { rows: [] };
  } }), /offline DDL failure/);
  assert.equal(calls[0], "BEGIN"); assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.equal(calls.at(-1), "ROLLBACK"); assert.equal(calls.includes("COMMIT"), false);
});
