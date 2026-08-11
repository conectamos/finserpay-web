export {
  getDataCreditoPublicConfig,
  isDataCreditoQueryEnabled,
} from "./config";
export {
  createDataCreditoClient,
  DataCreditoError,
  queryDataCreditoNaturalPerson,
} from "./client";
export type { DataCreditoNaturalPersonQuery } from "./client";
export type { DataCreditoQueryResult } from "./response";
