import assert from "node:assert/strict";
import test from "node:test";
import { createCreditProcessStatusPoller } from "../lib/credit-process-status-polling.ts";

function fixture({ localPending = false, serverStates = [true, false] } = {}) {
  const timers = new Map();
  const snapshots = [];
  let timerId = 0;
  let reads = 0;
  let readable = true;
  const poller = createCreditProcessStatusPoller({
    binding: { draftId: 3433 },
    canRead: () => readable,
    isPending: () => localPending,
    read: async () => ({ ok: true, draftId: 3433,
      pending: serverStates[Math.min(reads++, serverStates.length - 1)] }),
    // Intentionally do not update localPending here: React has not committed
    // the newly discovered dispatch by the time the request's finally runs.
    onSnapshot: snapshot => snapshots.push(snapshot),
    onConnection: () => {},
    schedule: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    cancel: id => timers.delete(id),
  });
  return { poller, timers, snapshots, reads: () => reads,
    setLocalPending: value => { localPending = value; },
    setReadable: value => { readable = value; },
    tick: async () => {
      const next = timers.entries().next().value;
      if (!next) return;
      timers.delete(next[0]); next[1]();
      await Promise.resolve(); await Promise.resolve();
    },
  };
}

test("un envío pendiente descubierto por el servidor continúa consultándose antes del siguiente render", async () => {
  const f = fixture();
  await f.poller.start();
  assert.equal(f.reads(), 1);
  assert.equal(f.snapshots[0].pending, true);
  assert.equal(f.timers.size, 1, "el estimado local false no oculta el intento pendiente del servidor");
  await f.tick();
  assert.equal(f.reads(), 2);
  assert.equal(f.snapshots[1].pending, false);
  assert.equal(f.timers.size, 0, "la confirmación final detiene las consultas aunque no haya otro render");
  f.poller.dispose();
});

test("un estado final del servidor detiene las consultas aunque la pantalla todavía estime pendiente", async () => {
  const f = fixture({ localPending: true, serverStates: [false] });
  await f.poller.start();
  assert.equal(f.reads(), 1);
  assert.equal(f.timers.size, 0);
  f.poller.dispose();
});

test("la finalización local después de conocer el pendiente detiene una respuesta anterior que aún diga pendiente", async () => {
  const f = fixture({ serverStates: [true] });
  await f.poller.start();
  f.setLocalPending(true);
  await f.tick();
  assert.equal(f.reads(), 2);
  f.setLocalPending(false);
  await f.tick();
  assert.equal(f.reads(), 3);
  assert.equal(f.timers.size, 0, "una finalización local explícita conserva su prioridad sobre el pendiente anterior");
  f.poller.dispose();
});

test("el pendiente del servidor no mantiene consultas al ocultar o abandonar la solicitud", async () => {
  const hidden = fixture({ serverStates: [true] });
  await hidden.poller.start();
  hidden.setReadable(false);
  await hidden.tick();
  assert.equal(hidden.reads(), 1, "un temporizador no consulta una pantalla que dejó de poder leerse");
  assert.equal(hidden.timers.size, 0);
  hidden.poller.dispose();

  const left = fixture({ serverStates: [true] });
  await left.poller.start();
  left.poller.dispose();
  await left.tick();
  assert.equal(left.reads(), 1);
  assert.equal(left.timers.size, 0);
});


test("una consulta explícita descubre un nuevo envío después de finalizar una validación anterior", async () => {
  const f = fixture({ localPending: true, serverStates: [false, true] });
  await f.poller.start();
  assert.equal(f.timers.size, 0);
  f.setLocalPending(false);
  await f.poller.retry();
  assert.equal(f.reads(), 2);
  assert.equal(f.timers.size, 1, "la validación anterior no oculta el nuevo envío descubierto antes del render");
  f.setLocalPending(true);
  await f.tick();
  f.setLocalPending(false);
  await f.tick();
  assert.equal(f.timers.size, 0, "un temporizador anterior no reabre el ciclo ya finalizado localmente");
  f.poller.dispose();
});
