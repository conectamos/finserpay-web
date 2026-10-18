import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8");
test("the final production image packages the Cuotavencida predeploy installer and its schema dependency", () => {
  const dockerfile = read("Dockerfile");
  const runner = dockerfile.slice(dockerfile.lastIndexOf(" AS runner"));
  const predeploy = read("scripts/railway-predeploy.mjs");
  const installer = "ensure-cuotavencida-whatsapp-schema.mjs";
  assert.ok(predeploy.includes(`await import("./${installer}")`));
  const entry = read("scripts/" + installer);
  const imports = [...entry.matchAll(/from\s+["']\.\/([^"']+\.mjs)["']/g)].map(match => match[1]);
  assert.ok(imports.length > 0, "The installer must package its relative schema dependency");
  for (const name of [installer, ...imports]) {
    assert.ok(runner.includes(`/app/scripts/${name}`), `${name} must be copied into the final runtime image`);
    assert.ok(read("scripts/" + name).length > 0);
  }
});
