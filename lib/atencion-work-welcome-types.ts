import type { ApprovalDetail } from "@/app/dashboard/aprobaciones/approval-client";
import type { WelcomeVoiceCallView } from "./credit-welcome-voice-http";

export const attentionWelcomeOutcomes = {
  HUMAN_CONTACT: "Bienvenida realizada",
  NO_ANSWER: "No contestó",
  OPT_OUT: "No autoriza la llamada o grabación",
  UNCERTAIN: "Resultado por confirmar",
} as const;
export type AttentionWelcomeOutcome = keyof typeof attentionWelcomeOutcomes;
export type AttentionWelcomeRecordingDetail = Pick<ApprovalDetail, "id" | "clienteTelefono" | "callRecording" | "review">;
export type AttentionWelcomeView = {
  ok: true; detail: AttentionWelcomeRecordingDetail; workVersion: number;
  callMode: "human" | "dapta" | "undecided"; contextHash: string;
  voiceItems: WelcomeVoiceCallView[];
};
