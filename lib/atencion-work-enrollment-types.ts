export const attentionEnrollmentChecks = [
  {key:"activationLock",label:"Confirmo BLOQUEO ACTIVACIÓN"},
  {key:"abm",label:"Confirmo ABM"},
  {key:"deviceLock",label:"Confirmo BLOQUEO DISPOSITIVO"},
  {key:"deviceUnlock",label:"Confirmo DESBLOQUEO DISPOSITIVO"},
] as const;
export type AttentionEnrollmentCheckKey = typeof attentionEnrollmentChecks[number]["key"];
export type AttentionEnrollmentChecks = Record<AttentionEnrollmentCheckKey,true>;
export type AttentionEnrollmentReview = {id:string;analystName:string;approvedAt:string};
export type AttentionEnrollmentStatus = {
  available:boolean;version:number;document:string|null;imei:string|null;caseToken:string|null;
  status:"ready"|"approved"|"unavailable";reason:string|null;review:AttentionEnrollmentReview|null;
};
