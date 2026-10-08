"use client";

import { Bell, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge, Button, Card } from "@/app/_components/finser-ui";
import {
  parseWelcomeAlertReceipt,
  parseWelcomeAlertSummary,
  shouldNotifyWelcome,
  WELCOME_ALERT_POLL_MS,
  WELCOME_ALERT_SOUND_COOLDOWN_MS,
  type WelcomeAlertReceipt,
  type WelcomeAlertSummary,
} from "@/lib/approval-welcome-alerts";
import styles from "./welcome-pending-alerts.module.css";

type SoundState = "off" | "locked" | "ready" | "blocked" | "unsupported";
const memoryReceipts = new Map<string, WelcomeAlertReceipt>();
const memoryPreferences = new Map<string, boolean>();

function readPreference(key: string) {
  try {
    const value = window.localStorage.getItem(key);
    if (value !== null) return value === "true";
  } catch { /* The preference remains available for this page session. */ }
  return memoryPreferences.get(key) ?? false;
}

function savePreference(key: string, enabled: boolean) {
  memoryPreferences.set(key, enabled);
  try { window.localStorage.setItem(key, String(enabled)); } catch { /* Storage may be disabled. */ }
}

function readReceipt(key: string) {
  let stored: WelcomeAlertReceipt | null = null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) stored = parseWelcomeAlertReceipt(JSON.parse(raw));
  } catch { /* A malformed or unavailable receipt falls back to memory. */ }
  const memory = memoryReceipts.get(key) ?? null;
  return stored && (!memory || stored.notifiedAt >= memory.notifiedAt) ? stored : memory;
}

function saveReceipt(key: string, receipt: WelcomeAlertReceipt) {
  memoryReceipts.set(key, receipt);
  try { window.localStorage.setItem(key, JSON.stringify(receipt)); } catch { /* Storage may be disabled. */ }
}

export default function WelcomePendingAlerts({
  actorKey,
  href = "/dashboard/aprobaciones",
}: {
  actorKey: string;
  href?: "/dashboard/aprobaciones" | "/revision-creditos";
}) {
  const panelId = useId();
  const [summary, setSummary] = useState<WelcomeAlertSummary | null>(null);
  const [panel, setPanel] = useState<"closed" | "manual" | "notice">("closed");
  const [failed, setFailed] = useState(false);
  const [authorized, setAuthorized] = useState(true);
  const [soundWanted, setSoundWanted] = useState(false);
  const [soundState, setSoundState] = useState<SoundState>("off");
  const active = useRef(false);
  const permitted = useRef(true);
  const currentSummary = useRef<WelcomeAlertSummary | null>(null);
  const enabled = useRef(false);
  const audioReady = useRef(false);
  const contextRef = useRef<AudioContext | null>(null);
  const tones = useRef(new Set<{ oscillator: OscillatorNode; gain: GainNode }>());
  const lastSoundAt = useRef<number | null>(null);
  const unsupported = useRef(false);
  const unlockPending = useRef<Promise<boolean> | null>(null);
  const preferenceKey = `finser:welcome-alerts:${encodeURIComponent(actorKey)}:sound`;
  const receiptKey = `finser:welcome-alerts:${encodeURIComponent(actorKey)}:receipt`;

  const stopTones = useCallback(() => {
    for (const tone of tones.current) {
      try { tone.oscillator.stop(); } catch { /* A completed tone is already stopped. */ }
      tone.oscillator.disconnect();
      tone.gain.disconnect();
    }
    tones.current.clear();
  }, []);

  const closeAudio = useCallback(() => {
    stopTones();
    audioReady.current = false;
    unlockPending.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    if (context) {
      context.onstatechange = null;
      if (context.state !== "closed") void context.close().catch(() => undefined);
    }
  }, [stopTones]);

  const playChime = useCallback((preview = false) => {
    const context = contextRef.current;
    const now = Date.now();
    if (!active.current || !permitted.current || !enabled.current || !audioReady.current ||
        !context || context.state !== "running" ||
        (!preview && lastSoundAt.current !== null && now - lastSoundAt.current < WELCOME_ALERT_SOUND_COOLDOWN_MS)) return false;
    try {
      for (const [index, frequency] of [587.33, 783.99].entries()) {
        const start = context.currentTime + index * 0.18;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const tone = { oscillator, gain };
        tones.current.add(tone);
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.07, start + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
          tones.current.delete(tone);
        };
        oscillator.start(start);
        oscillator.stop(start + 0.22);
      }
      lastSoundAt.current = now;
      return true;
    } catch {
      stopTones();
      audioReady.current = false;
      setSoundState("blocked");
      return false;
    }
  }, [stopTones]);

  // Creation and resume happen only inside a user pointer/keyboard/click gesture.
  const unlockAudio = useCallback((): Promise<boolean> => {
    if (!active.current || !permitted.current || !enabled.current) return Promise.resolve(false);
    if (unlockPending.current) return unlockPending.current;
    const AudioContextClass = window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      unsupported.current = true;
      setSoundState("unsupported");
      return Promise.resolve(false);
    }
    try {
      const context = contextRef.current ?? new AudioContextClass();
      contextRef.current = context;
      context.onstatechange = () => {
        if (contextRef.current !== context || !active.current || !enabled.current) return;
        audioReady.current = context.state === "running";
        setSoundState(audioReady.current ? "ready" : "locked");
      };
      const resume = context.state === "running" ? Promise.resolve() : context.resume();
      const attempt = Promise.resolve(resume).then(() => {
        if (!active.current || !permitted.current || !enabled.current || contextRef.current !== context) return false;
        audioReady.current = context.state === "running";
        setSoundState(audioReady.current ? "ready" : "blocked");
        return audioReady.current;
      }).catch(() => {
        if (active.current && contextRef.current === context) {
          audioReady.current = false;
          setSoundState("blocked");
        }
        return false;
      }).finally(() => {
        if (unlockPending.current === attempt) unlockPending.current = null;
      });
      unlockPending.current = attempt;
      return attempt;
    } catch {
      audioReady.current = false;
      setSoundState("blocked");
      return Promise.resolve(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let halted = false;
    let inFlight: AbortController | null = null;
    active.current = true;
    permitted.current = true;
    enabled.current = readPreference(preferenceKey);
    unsupported.current = false;
    currentSummary.current = null;
    lastSoundAt.current = null;
    setAuthorized(true);
    setSummary(null);
    setPanel("closed");
    setFailed(false);
    setSoundWanted(enabled.current);
    setSoundState(enabled.current ? "locked" : "off");

    const backgroundSoundReady = () => enabled.current && audioReady.current && contextRef.current?.state === "running";
    const notify = (next: WelcomeAlertSummary) => {
      if (disposed || halted || (document.visibilityState !== "visible" && !backgroundSoundReady())) return;
      const now = Date.now();
      if (!shouldNotifyWelcome(next, readReceipt(receiptKey), now)) return;
      const visible = document.visibilityState === "visible";
      if (!visible && !playChime()) return;
      saveReceipt(receiptKey, { fingerprint: next.fingerprint, notifiedAt: now });
      setPanel("notice");
      if (visible) playChime();
    };
    const coordinateNotice = async (next: WelcomeAlertSummary) => {
      if (navigator.locks?.request) {
        try {
          await navigator.locks.request(`finser:welcome-alerts:${actorKey}`, { mode: "exclusive" }, () => notify(next));
          return;
        } catch { /* Restricted browsers can still show the in-app notice. */ }
      }
      notify(next);
    };
    const refresh = async () => {
      if (disposed || halted || inFlight || (document.visibilityState !== "visible" && !backgroundSoundReady()) || navigator.onLine === false) return;
      const controller = new AbortController();
      inFlight = controller;
      try {
        const response = await fetch("/api/aprobaciones/bienvenidas-pendientes", {
          method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (disposed || controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          halted = true;
          permitted.current = false;
          enabled.current = false;
          currentSummary.current = null;
          window.clearInterval(interval);
          removeListeners();
          closeAudio();
          setAuthorized(false);
          setSummary(null);
          setPanel("closed");
          return;
        }
        if (!response.ok) throw new Error("Welcome summary unavailable");
        const next = parseWelcomeAlertSummary(await response.json());
        if (disposed || controller.signal.aborted) return;
        if (!next) throw new Error("Invalid welcome summary");
        currentSummary.current = next;
        setSummary(next);
        setFailed(false);
        if (next.attentionCount === 0) {
          stopTones();
          setPanel((current) => current === "notice" ? "closed" : current);
        } else {
          await coordinateNotice(next);
        }
      } catch {
        if (!disposed && !controller.signal.aborted) setFailed(true);
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    };
    const onResume = () => { void refresh(); };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") stopTones();
      if (document.visibilityState === "visible" || backgroundSoundReady()) void refresh();
      else inFlight?.abort();
    };
    const onGesture = () => {
      if (enabled.current && !audioReady.current && !unsupported.current) void unlockAudio();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== preferenceKey) return;
      enabled.current = readPreference(preferenceKey);
      setSoundWanted(enabled.current);
      if (!enabled.current) {
        closeAudio();
        setSoundState("off");
      } else if (!audioReady.current) setSoundState("locked");
    };
    function removeListeners() {
      window.removeEventListener("focus", onResume);
      window.removeEventListener("online", onResume);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      document.removeEventListener("visibilitychange", onVisibility);
    }
    const interval = window.setInterval(onResume, WELCOME_ALERT_POLL_MS);
    window.addEventListener("focus", onResume);
    window.addEventListener("online", onResume);
    window.addEventListener("storage", onStorage);
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();
    return () => {
      disposed = true;
      active.current = false;
      permitted.current = false;
      inFlight?.abort();
      window.clearInterval(interval);
      removeListeners();
      closeAudio();
    };
  }, [actorKey, preferenceKey, receiptKey, closeAudio, playChime, stopTones, unlockAudio]);

  function dismiss() {
    const current = currentSummary.current;
    if (current?.attentionCount) saveReceipt(receiptKey, { fingerprint: current.fingerprint, notifiedAt: Date.now() });
    stopTones();
    setPanel("closed");
  }

  async function enableSound() {
    enabled.current = true;
    savePreference(preferenceKey, true);
    setSoundWanted(true);
    if (await unlockAudio()) playChime(true);
  }

  function muteSound() {
    enabled.current = false;
    savePreference(preferenceKey, false);
    setSoundWanted(false);
    closeAudio();
    setSoundState("off");
  }

  if (!authorized) return null;
  const count = summary?.attentionCount;
  const countText = count === undefined ? (failed ? "No pudimos consultar las bienvenidas. Reintentaremos automáticamente." : "Consultando las bienvenidas pendientes…") :
    count > 0 ? `Hay ${count} ${count === 1 ? "bienvenida pendiente" : "bienvenidas pendientes"} por gestionar.` : "No hay bienvenidas por gestionar en este momento.";
  const soundHint = soundState === "unsupported" ? "Este navegador no admite sonido. Los avisos en pantalla siguen activos." :
    soundState === "blocked" ? "El navegador no pudo activar el sonido. Puedes volver a intentarlo." :
    soundWanted && soundState !== "ready" ? "Activa el sonido para esta pestaña." :
    soundState === "ready" ? "Sonido activo mientras Finser Pay está abierto." : "Puedes activar un sonido breve para los avisos.";

  return (
    <aside className={styles.alerts} aria-label="Avisos de bienvenidas">
      {panel !== "closed" ? (
        <Card className={styles.card} id={panelId}>
          <div className={styles.heading}>
            <span className={styles.bell}><Bell size={20} aria-hidden="true" /></span>
            <h2>Bienvenidas pendientes</h2>
            <Button variant="ghost" className={styles.close} aria-label="Cerrar aviso de bienvenidas" onClick={dismiss}><X size={18} aria-hidden="true" /></Button>
          </div>
          <p className={styles.message} role="status" aria-live="polite" aria-atomic="true">{countText}</p>
          {failed && summary ? <p className={styles.hint}>No pudimos actualizar el contador. Reintentaremos automáticamente.</p> : null}
          {summary && summary.pendingCount > summary.attentionCount ? <p className={styles.hint}>{summary.pendingCount} en la cola; algunas requieren una respuesta del aliado u otro paso previo.</p> : null}
          {/* A fresh navigation clears local approved/detail views and filters in the inbox. */}
          <a href={href} className={`fp-ui-button is-primary ${styles.review}`} onClick={dismiss}>Revisar pendientes</a>
          <div className={styles.sound}>
            <div className={styles.soundControls}>
              {soundState !== "ready" ? <Button variant="secondary" onClick={() => { void enableSound(); }}><Volume2 size={16} aria-hidden="true" />Activar sonido</Button> : <span className={styles.soundReady}><Volume2 size={16} aria-hidden="true" />Sonido activo</span>}
              {soundWanted ? <Button variant="ghost" onClick={muteSound}><VolumeX size={16} aria-hidden="true" />Silenciar</Button> : null}
            </div>
            <p className={styles.hint}>{soundHint}</p>
          </div>
        </Card>
      ) : null}
      <Button variant="secondary" className={styles.launcher} aria-expanded={panel !== "closed"} aria-controls={panelId}
        aria-label={`Abrir avisos de bienvenidas${count === undefined ? "" : `: ${count} por gestionar`}`}
        onClick={() => panel === "closed" ? setPanel("manual") : dismiss()}>
        <Bell size={18} aria-hidden="true" /><span>Bienvenidas</span>
        {count !== undefined ? <Badge tone={count > 0 ? "warning" : "neutral"}>{count}</Badge> : null}
      </Button>
    </aside>
  );
}


