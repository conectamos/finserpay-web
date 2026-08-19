const MAX_TEXT_LENGTH = 1_000;
const MAX_SHORT_TEXT_LENGTH = 160;
const MAX_CODES = 32;
const MAX_SECTORS = 16;
const MAX_EVOLUTION_PERIODS = 24;
const MAX_PAYMENT_PERIODS = 36;
const MAX_ALERTS = 32;
const MAX_SUGGESTIONS = 16;
const MAX_SUGGESTION_ITEMS = 16;

const FORBIDDEN_PROVIDER_KEY = /^(?:access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret|password|passwd|cookie|set-cookie|api[_-]?key|secret|token)$/i;
const PAYMENT_BEHAVIOR_CODES = new Set([
  "N",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "C",
  "D",
  "-",
  " ",
]);

type UnknownRecord = Record<string, unknown>;

export type DataCreditoAdminProviderCode = {
  clave: string | null;
  valor: string | null;
};

export type DataCreditoAdminProviderIdentity = {
  conInformacion: boolean | null;
  nombreCompleto: string | null;
  primerNombre: string | null;
  segundoNombre: string | null;
  primerApellido: string | null;
  segundoApellido: string | null;
  tipoDocumento: string | null;
  numeroDocumento: string | null;
  estadoDocumento: string | null;
  rangoEdad: string | null;
};

export type DataCreditoAdminBalanceEvolutionItem = {
  trimestre: string | null;
  saldoTotal: string | null;
  cuotaTotal: string | null;
};

export type DataCreditoAdminRevolvingEvolutionItem = {
  trimestre: string | null;
  saldoTotal: string | null;
  cupoTotal: string | null;
  porcentajeDeuda: string | null;
};

export type DataCreditoAdminPaymentBehaviorItem = {
  anioMes: string | null;
  comportamiento: string | null;
};

export type DataCreditoAdminProviderIndicators = {
  creditosVigentes: string | null;
  creditosCerrados: string | null;
  totalPrincipal: string | null;
  totalCodeudorOtros: string | null;
  valorInicial: string | null;
  saldoActual: string | null;
  valorCuota: string | null;
  saldoMora: string | null;
  porcentajeDeuda: string | null;
};

export type DataCreditoAdminProviderSector = DataCreditoAdminProviderIndicators & {
  sector: string | null;
};

export type DataCreditoAdminProviderAlert = {
  alerta: string | null;
  colocacion: string | null;
  modificacion: string | null;
};

export type DataCreditoAdminProviderSuggestionItem = {
  descripcion: string | null;
};

export type DataCreditoAdminProviderSuggestion = {
  titulo: string | null;
  sugerencia: DataCreditoAdminProviderSuggestionItem[];
};

export type DataCreditoSanitizedProviderPayload = {
  status: string | null;
  content: {
    infoTransaccion: {
      fechaConsulta: string | null;
      horaConsulta: string | null;
      tipoIdDigitado: string | null;
      numeroIdDigitado: string | null;
      apellidoDigitado: string | null;
      codigosRespuesta: DataCreditoAdminProviderCode[];
    } | null;
    respuesta: {
      validacion: {
        conInformacion: boolean | null;
        datosBasicos: DataCreditoAdminProviderIdentity | null;
      } | null;
      comportamientoCrediticio: {
        conInformacion: boolean | null;
        evolucionSaldoCuotaPN: {
          conInformacion: boolean | null;
          trimestres: DataCreditoAdminBalanceEvolutionItem[];
        } | null;
        evolucionRoPN: {
          conInformacion: boolean | null;
          trimestres: DataCreditoAdminRevolvingEvolutionItem[];
        } | null;
        comportamientoPago: {
          conInformacion: boolean | null;
          vectorComportamiento: DataCreditoAdminPaymentBehaviorItem[];
        } | null;
        indicadoresValores: {
          conInformacion: boolean | null;
          indicadores: DataCreditoAdminProviderIndicators;
          sectores: DataCreditoAdminProviderSector[];
        } | null;
      } | null;
      informacionRiesgo: {
        conInformacion: boolean | null;
        score: string | null;
        txtProbabilidad: string | null;
        viabilidad: string | null;
        ratingRecaudos: string | null;
        txtRecaudos: string | null;
        montoSugerido: string | null;
        alertas: DataCreditoAdminProviderAlert[];
      } | null;
      endeudamiento: {
        conInformacion: boolean | null;
        ingreso: string | null;
        porcentajeCuotaVsIngreso: string | null;
      } | null;
      sugerencias: {
        conInformacion: boolean | null;
        vectorSugerencias: DataCreditoAdminProviderSuggestion[];
      } | null;
    } | null;
  } | null;
};

export type DataCreditoAdminIdentitySummary = {
  queriedDocumentType: string | null;
  queriedDocumentNumber: string | null;
  queriedSurname: string | null;
  documentType: string | null;
  documentNumber: string | null;
  fullName: string | null;
  firstName: string | null;
  secondName: string | null;
  firstSurname: string | null;
  secondSurname: string | null;
  documentStatus: string | null;
  ageRange: string | null;
};

export type DataCreditoAdminNumericIndicators = {
  activeCredits: number | null;
  closedCredits: number | null;
  principalCredits: number | null;
  coDebtorOrOtherCredits: number | null;
  initialAmount: number | null;
  currentBalance: number | null;
  installmentAmount: number | null;
  delinquentBalance: number | null;
  debtPercentage: number | null;
};

export type DataCreditoAdminSectorSummary = DataCreditoAdminNumericIndicators & {
  sector: string;
  isTelcos: boolean;
};

export type DataCreditoAdminRiskSummary = {
  identity: DataCreditoAdminIdentitySummary | null;
  risk: {
    hasInformation: boolean | null;
    score: number | null;
    probabilityText: string | null;
    viability: string | null;
    collectionsRating: string | null;
    collectionsText: string | null;
    suggestedAmount: number | null;
    alerts: Array<{
      description: string | null;
      placedAt: string | null;
      updatedAt: string | null;
    }>;
  } | null;
  totals: DataCreditoAdminNumericIndicators | null;
  sectors: DataCreditoAdminSectorSummary[];
  balanceEvolution: Array<{
    period: string | null;
    totalBalance: number | null;
    totalInstallment: number | null;
  }>;
  revolvingEvolution: Array<{
    period: string | null;
    totalBalance: number | null;
    totalLimit: number | null;
    debtPercentage: number | null;
  }>;
  paymentHistory: Array<{
    period: string | null;
    code: string | null;
  }>;
  indebtedness: {
    income: number | null;
    installmentToIncomePercentage: number | null;
  } | null;
  suggestions: Array<{
    title: string | null;
    descriptions: string[];
  }>;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function allowedValue(record: UnknownRecord | null, key: string) {
  if (!record || FORBIDDEN_PROVIDER_KEY.test(key)) return undefined;
  return record[key];
}

function boundedText(value: unknown, maximumLength = MAX_SHORT_TEXT_LENGTH) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function providerBoolean(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = boundedText(value, 8)?.toLowerCase();
  if (["true", "1", "si", "sí", "yes"].includes(normalized || "")) return true;
  if (["false", "0", "no"].includes(normalized || "")) return false;
  return null;
}

function boundedArray(value: unknown, maximumLength: number) {
  return Array.isArray(value) ? value.slice(0, maximumLength) : [];
}

function providerNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      ? value
      : null;
  }
  const raw = boundedText(value, 64);
  if (!raw || !/^-?\d+(?:[.,]\d+)?$/.test(raw)) return null;
  const parsed = Number(raw.replace(",", "."));
  return Number.isFinite(parsed) && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER
    ? parsed
    : null;
}

function providerScore(value: unknown) {
  const score = providerNumber(value);
  return Number.isInteger(score) && score! >= 0 && score! <= 950 ? score : null;
}

function sanitizeIndicators(record: UnknownRecord | null): DataCreditoAdminProviderIndicators {
  return {
    creditosVigentes: boundedText(allowedValue(record, "creditosVigentes"), 64),
    creditosCerrados: boundedText(allowedValue(record, "creditosCerrados"), 64),
    totalPrincipal: boundedText(allowedValue(record, "totalPrincipal"), 64),
    totalCodeudorOtros: boundedText(allowedValue(record, "totalCodeudorOtros"), 64),
    valorInicial: boundedText(allowedValue(record, "valorInicial"), 64),
    saldoActual: boundedText(allowedValue(record, "saldoActual"), 64),
    valorCuota: boundedText(allowedValue(record, "valorCuota"), 64),
    saldoMora: boundedText(allowedValue(record, "saldoMora"), 64),
    porcentajeDeuda: boundedText(allowedValue(record, "porcentajeDeuda"), 64),
  };
}

function numericIndicators(
  indicators: DataCreditoAdminProviderIndicators
): DataCreditoAdminNumericIndicators {
  return {
    activeCredits: providerNumber(indicators.creditosVigentes),
    closedCredits: providerNumber(indicators.creditosCerrados),
    principalCredits: providerNumber(indicators.totalPrincipal),
    coDebtorOrOtherCredits: providerNumber(indicators.totalCodeudorOtros),
    initialAmount: providerNumber(indicators.valorInicial),
    currentBalance: providerNumber(indicators.saldoActual),
    installmentAmount: providerNumber(indicators.valorCuota),
    delinquentBalance: providerNumber(indicators.saldoMora),
    debtPercentage: providerNumber(indicators.porcentajeDeuda),
  };
}

function hasIdentityValue(identity: DataCreditoAdminIdentitySummary) {
  return Object.values(identity).some((value) => value !== null);
}

/**
 * Rebuilds the provider response from a strict allowlist. Unknown properties,
 * including credentials or HTTP headers accidentally attached by a caller,
 * are never copied to the returned value.
 */
export function sanitizeDataCreditoProviderPayload(
  payload: unknown
): DataCreditoSanitizedProviderPayload | null {
  const root = asRecord(payload);
  if (!root) return null;

  const content = asRecord(allowedValue(root, "content"));
  if (!content) {
    return {
      status: boundedText(allowedValue(root, "status"), 64),
      content: null,
    };
  }

  const transaction = asRecord(allowedValue(content, "infoTransaccion"));
  const answer = asRecord(allowedValue(content, "respuesta"));
  const validation = asRecord(allowedValue(answer, "validacion"));
  const basics = asRecord(allowedValue(validation, "datosBasicos"));
  const creditBehavior = asRecord(allowedValue(answer, "comportamientoCrediticio"));
  const balanceEvolution = asRecord(
    allowedValue(creditBehavior, "evolucionSaldoCuotaPN")
  );
  const revolvingEvolution = asRecord(allowedValue(creditBehavior, "evolucionRoPN"));
  const paymentBehavior = asRecord(allowedValue(creditBehavior, "comportamientoPago"));
  const indicators = asRecord(allowedValue(creditBehavior, "indicadoresValores"));
  const risk = asRecord(allowedValue(answer, "informacionRiesgo"));
  const debt = asRecord(allowedValue(answer, "endeudamiento"));
  const suggestions = asRecord(allowedValue(answer, "sugerencias"));

  return {
    status: boundedText(allowedValue(root, "status"), 64),
    content: {
      infoTransaccion: transaction
        ? {
            fechaConsulta: boundedText(allowedValue(transaction, "fechaConsulta"), 32),
            horaConsulta: boundedText(allowedValue(transaction, "horaConsulta"), 32),
            tipoIdDigitado: boundedText(allowedValue(transaction, "tipoIdDigitado"), 32),
            numeroIdDigitado: boundedText(
              allowedValue(transaction, "numeroIdDigitado"),
              32
            ),
            apellidoDigitado: boundedText(
              allowedValue(transaction, "apellidoDigitado"),
              MAX_SHORT_TEXT_LENGTH
            ),
            codigosRespuesta: boundedArray(
              allowedValue(transaction, "codigosRespuesta"),
              MAX_CODES
            ).map((item) => {
              const code = asRecord(item);
              return {
                clave: boundedText(allowedValue(code, "clave"), 32),
                valor: boundedText(allowedValue(code, "valor"), 64),
              };
            }),
          }
        : null,
      respuesta: answer
        ? {
            validacion: validation
              ? {
                  conInformacion: providerBoolean(
                    allowedValue(validation, "conInformacion")
                  ),
                  datosBasicos: basics
                    ? {
                        conInformacion: providerBoolean(
                          allowedValue(basics, "conInformacion")
                        ),
                        nombreCompleto: boundedText(
                          allowedValue(basics, "nombreCompleto"),
                          MAX_SHORT_TEXT_LENGTH
                        ),
                        primerNombre: boundedText(
                          allowedValue(basics, "primerNombre"),
                          MAX_SHORT_TEXT_LENGTH
                        ),
                        segundoNombre: boundedText(
                          allowedValue(basics, "segundoNombre"),
                          MAX_SHORT_TEXT_LENGTH
                        ),
                        primerApellido: boundedText(
                          allowedValue(basics, "primerApellido"),
                          MAX_SHORT_TEXT_LENGTH
                        ),
                        segundoApellido: boundedText(
                          allowedValue(basics, "segundoApellido"),
                          MAX_SHORT_TEXT_LENGTH
                        ),
                        tipoDocumento: boundedText(
                          allowedValue(basics, "tipoDocumento"),
                          64
                        ),
                        numeroDocumento: boundedText(
                          allowedValue(basics, "numeroDocumento"),
                          32
                        ),
                        estadoDocumento: boundedText(
                          allowedValue(basics, "estadoDocumento"),
                          64
                        ),
                        rangoEdad: boundedText(allowedValue(basics, "rangoEdad"), 32),
                      }
                    : null,
                }
              : null,
            comportamientoCrediticio: creditBehavior
              ? {
                  conInformacion: providerBoolean(
                    allowedValue(creditBehavior, "conInformacion")
                  ),
                  evolucionSaldoCuotaPN: balanceEvolution
                    ? {
                        conInformacion: providerBoolean(
                          allowedValue(balanceEvolution, "conInformacion")
                        ),
                        trimestres: boundedArray(
                          allowedValue(balanceEvolution, "trimestres"),
                          MAX_EVOLUTION_PERIODS
                        ).map((item) => {
                          const row = asRecord(item);
                          return {
                            trimestre: boundedText(allowedValue(row, "trimestre"), 32),
                            saldoTotal: boundedText(allowedValue(row, "saldoTotal"), 64),
                            cuotaTotal: boundedText(allowedValue(row, "cuotaTotal"), 64),
                          };
                        }),
                      }
                    : null,
                  evolucionRoPN: revolvingEvolution
                    ? {
                        conInformacion: providerBoolean(
                          allowedValue(revolvingEvolution, "conInformacion")
                        ),
                        trimestres: boundedArray(
                          allowedValue(revolvingEvolution, "trimestres"),
                          MAX_EVOLUTION_PERIODS
                        ).map((item) => {
                          const row = asRecord(item);
                          return {
                            trimestre: boundedText(allowedValue(row, "trimestre"), 32),
                            saldoTotal: boundedText(allowedValue(row, "saldoTotal"), 64),
                            cupoTotal: boundedText(allowedValue(row, "cupoTotal"), 64),
                            porcentajeDeuda: boundedText(
                              allowedValue(row, "porcentajeDeuda"),
                              64
                            ),
                          };
                        }),
                      }
                    : null,
                  comportamientoPago: paymentBehavior
                    ? {
                        conInformacion: providerBoolean(
                          allowedValue(paymentBehavior, "conInformacion")
                        ),
                        vectorComportamiento: boundedArray(
                          allowedValue(paymentBehavior, "vectorComportamiento"),
                          MAX_PAYMENT_PERIODS
                        ).map((item) => {
                          const row = asRecord(item);
                          const rawCode = boundedText(
                            allowedValue(row, "comportamiento"),
                            4
                          );
                          const code = rawCode === null ? null : rawCode.toUpperCase();
                          return {
                            anioMes: boundedText(allowedValue(row, "anioMes"), 32),
                            comportamiento:
                              code && PAYMENT_BEHAVIOR_CODES.has(code) ? code : null,
                          };
                        }),
                      }
                    : null,
                  indicadoresValores: indicators
                    ? {
                        conInformacion: providerBoolean(
                          allowedValue(indicators, "conInformacion")
                        ),
                        indicadores: sanitizeIndicators(indicators),
                        sectores: boundedArray(
                          allowedValue(indicators, "sectores"),
                          MAX_SECTORS
                        ).map((item) => {
                          const row = asRecord(item);
                          return {
                            sector: boundedText(allowedValue(row, "sector"), 96),
                            ...sanitizeIndicators(row),
                          };
                        }),
                      }
                    : null,
                }
              : null,
            informacionRiesgo: risk
              ? {
                  conInformacion: providerBoolean(
                    allowedValue(risk, "conInformacion")
                  ),
                  score: boundedText(allowedValue(risk, "score"), 16),
                  txtProbabilidad: boundedText(
                    allowedValue(risk, "txtProbabilidad"),
                    MAX_TEXT_LENGTH
                  ),
                  viabilidad: boundedText(allowedValue(risk, "viabilidad"), 32),
                  ratingRecaudos: boundedText(
                    allowedValue(risk, "ratingRecaudos"),
                    16
                  ),
                  txtRecaudos: boundedText(
                    allowedValue(risk, "txtRecaudos"),
                    MAX_TEXT_LENGTH
                  ),
                  montoSugerido: boundedText(allowedValue(risk, "montoSugerido"), 64),
                  alertas: boundedArray(allowedValue(risk, "alertas"), MAX_ALERTS).map(
                    (item) => {
                      const alert = asRecord(item);
                      return {
                        alerta: boundedText(
                          allowedValue(alert, "alerta"),
                          MAX_TEXT_LENGTH
                        ),
                        colocacion: boundedText(allowedValue(alert, "colocacion"), 32),
                        modificacion: boundedText(
                          allowedValue(alert, "modificacion"),
                          32
                        ),
                      };
                    }
                  ),
                }
              : null,
            endeudamiento: debt
              ? {
                  conInformacion: providerBoolean(allowedValue(debt, "conInformacion")),
                  ingreso: boundedText(allowedValue(debt, "ingreso"), 64),
                  porcentajeCuotaVsIngreso: boundedText(
                    allowedValue(debt, "porcentajeCuotaVsIngreso"),
                    64
                  ),
                }
              : null,
            sugerencias: suggestions
              ? {
                  conInformacion: providerBoolean(
                    allowedValue(suggestions, "conInformacion")
                  ),
                  vectorSugerencias: boundedArray(
                    allowedValue(suggestions, "vectorSugerencias"),
                    MAX_SUGGESTIONS
                  ).map((item) => {
                    const suggestion = asRecord(item);
                    return {
                      titulo: boundedText(
                        allowedValue(suggestion, "titulo"),
                        MAX_TEXT_LENGTH
                      ),
                      sugerencia: boundedArray(
                        allowedValue(suggestion, "sugerencia"),
                        MAX_SUGGESTION_ITEMS
                      ).map((detail) => {
                        const detailRecord = asRecord(detail);
                        return {
                          descripcion: boundedText(
                            allowedValue(detailRecord, "descripcion"),
                            MAX_TEXT_LENGTH
                          ),
                        };
                      }),
                    };
                  }),
                }
              : null,
          }
        : null,
    },
  };
}

export function buildDataCreditoAdminRiskSummary(
  payload: unknown
): DataCreditoAdminRiskSummary | null {
  const sanitized = sanitizeDataCreditoProviderPayload(payload);
  const content = sanitized?.content;
  const answer = content?.respuesta;
  if (!sanitized || !content || !answer) return null;

  const transaction = content.infoTransaccion;
  const basics = answer.validacion?.datosBasicos;
  const identity: DataCreditoAdminIdentitySummary = {
    queriedDocumentType: transaction?.tipoIdDigitado || null,
    queriedDocumentNumber: transaction?.numeroIdDigitado || null,
    queriedSurname: transaction?.apellidoDigitado || null,
    documentType: basics?.tipoDocumento || null,
    documentNumber: basics?.numeroDocumento || null,
    fullName: basics?.nombreCompleto || null,
    firstName: basics?.primerNombre || null,
    secondName: basics?.segundoNombre || null,
    firstSurname: basics?.primerApellido || null,
    secondSurname: basics?.segundoApellido || null,
    documentStatus: basics?.estadoDocumento || null,
    ageRange: basics?.rangoEdad || null,
  };
  const indicatorSection = answer.comportamientoCrediticio?.indicadoresValores;
  const sectors = (indicatorSection?.sectores || []).flatMap((sector) => {
    if (!sector.sector) return [];
    return [
      {
        sector: sector.sector,
        isTelcos: sector.sector.toLowerCase() === "sector telcos",
        ...numericIndicators(sector),
      },
    ];
  });
  const risk = answer.informacionRiesgo;

  return {
    identity: hasIdentityValue(identity) ? identity : null,
    risk: risk
      ? {
          hasInformation: risk.conInformacion,
          score: providerScore(risk.score),
          probabilityText: risk.txtProbabilidad,
          viability: risk.viabilidad,
          collectionsRating: risk.ratingRecaudos,
          collectionsText: risk.txtRecaudos,
          suggestedAmount: providerNumber(risk.montoSugerido),
          alerts: risk.alertas.map((alert) => ({
            description: alert.alerta,
            placedAt: alert.colocacion,
            updatedAt: alert.modificacion,
          })),
        }
      : null,
    totals: indicatorSection
      ? numericIndicators(indicatorSection.indicadores)
      : null,
    sectors,
    balanceEvolution: (
      answer.comportamientoCrediticio?.evolucionSaldoCuotaPN?.trimestres || []
    ).map((item) => ({
      period: item.trimestre,
      totalBalance: providerNumber(item.saldoTotal),
      totalInstallment: providerNumber(item.cuotaTotal),
    })),
    revolvingEvolution: (
      answer.comportamientoCrediticio?.evolucionRoPN?.trimestres || []
    ).map((item) => ({
      period: item.trimestre,
      totalBalance: providerNumber(item.saldoTotal),
      totalLimit: providerNumber(item.cupoTotal),
      debtPercentage: providerNumber(item.porcentajeDeuda),
    })),
    paymentHistory: (
      answer.comportamientoCrediticio?.comportamientoPago
        ?.vectorComportamiento || []
    ).map((item) => ({
      period: item.anioMes,
      code: item.comportamiento,
    })),
    indebtedness: answer.endeudamiento
      ? {
          income: providerNumber(answer.endeudamiento.ingreso),
          installmentToIncomePercentage: providerNumber(
            answer.endeudamiento.porcentajeCuotaVsIngreso
          ),
        }
      : null,
    suggestions: (answer.sugerencias?.vectorSugerencias || []).map(
      (suggestion) => ({
        title: suggestion.titulo,
        descriptions: suggestion.sugerencia.flatMap((item) =>
          item.descripcion ? [item.descripcion] : []
        ),
      })
    ),
  };
}
