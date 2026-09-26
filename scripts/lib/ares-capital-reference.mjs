/**
 * Local reconstruction of the supplied ARES example, NOT a collections engine.
 * Inputs are already reconciled: this module does not decide payment priority,
 * accrue interest between dates, consult current policies, or write a ledger.
 * A matching screenshot does not establish ARES's internal rounding algorithm.
 */
const MAX_REFERENCE_AMOUNT = 1_000_000_000_000;

function nonNegative(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number.`);
  }
  return value;
}

function money(value, field) {
  const amount = nonNegative(value, field);
  if (amount > MAX_REFERENCE_AMOUNT || Math.round(amount * 100) / 100 !== amount) {
    throw new Error(`${field} must be within the reference limit and have at most two decimals.`);
  }
  return amount;
}

function cents(value, field) {
  return Math.round(money(value, field) * 100);
}

function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("schedule.date must be an ISO calendar date.");
  }
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("schedule.date is not a valid calendar date.");
  }
  return value;
}

/** Reconcile an explicitly supplied receipt; never infer its allocation. */
export function reconcileReferenceReceipt(input) {
  const before = cents(input.principalBefore, "principalBefore");
  const received = cents(input.received, "received");
  const extra = cents(input.extraordinaryPrincipal, "extraordinaryPrincipal");
  if (received <= 0 || extra <= 0) {
    throw new Error("A reference principal payment must contain a positive receipt and extraordinary principal.");
  }
  const ordinary = input.ordinary;
  if (!ordinary || typeof ordinary !== "object") {
    throw new Error("An explicit ordinary allocation is required.");
  }
  const ordinaryCapital = cents(ordinary.principal, "ordinary.principal");
  const ordinaryTotal = ordinaryCapital + ["interest", "surety", "insurance", "lateFee"]
    .reduce((sum, key) => sum + cents(ordinary[key], `ordinary.${key}`), 0);
  if (ordinaryTotal + extra !== received) {
    throw new Error("The receipt does not reconcile: ordinary plus extraordinary must equal received.");
  }
  const reduction = ordinaryCapital + extra;
  if (reduction > before) {
    throw new Error("The payment cannot reduce principal below zero.");
  }
  return {
    received: received / 100,
    ordinaryTotal: ordinaryTotal / 100,
    extraordinaryPrincipal: extra / 100,
    principalReduction: reduction / 100,
    principalAfter: (before - reduction) / 100,
  };
}

/**
 * Project ONLY from a reconciled principal and an explicit remaining calendar.
 * Reference convention: fixed credit installment, fixed charges per surviving
 * installment, full periodic interest, unrounded internal French calculation,
 * nearest-peso display. None of these are new production/accounting defaults.
 * priorInterestPaid is a pre-existing plan allocation, NOT new receipt money.
 */
export function projectReferenceTermReduction(input) {
  let balance = money(input.principal, "principal");
  const rate = nonNegative(input.periodicRate, "periodicRate");
  const fixedCredit = money(input.creditInstallment, "creditInstallment");
  const fixedSurety = money(input.suretyPerInstallment, "suretyPerInstallment");
  const fixedInsurance = money(input.insurancePerInstallment, "insurancePerInstallment");
  if (rate > 1 || fixedCredit <= 0) {
    throw new Error("Invalid reference periodic rate or credit installment.");
  }
  if (!Array.isArray(input.schedule) || input.schedule.length > 600) {
    throw new Error("An explicit schedule of at most 600 installments is required.");
  }
  let previousNumber = null;
  let previousDate = null;
  const schedule = input.schedule.map((entry) => {
    if (!Number.isSafeInteger(entry.number) || entry.number <= 0 ||
        (previousNumber !== null && entry.number !== previousNumber + 1)) {
      throw new Error("schedule.number must be positive and consecutive.");
    }
    const date = calendarDate(entry.date);
    if (previousDate !== null && date <= previousDate) {
      throw new Error("The schedule must preserve strictly increasing dates.");
    }
    const priorInterestPaid = money(
      entry.priorInterestPaid === undefined ? 0 : entry.priorInterestPaid,
      "priorInterestPaid"
    );
    previousNumber = entry.number;
    previousDate = date;
    return { number: entry.number, date, priorInterestPaid };
  });

  const rows = schedule.map(({ number, date, priorInterestPaid }) => {
    const openingPrincipal = balance;
    const removed = openingPrincipal === 0;
    const interest = openingPrincipal * rate;
    if (!removed && fixedCredit <= interest) {
      throw new Error("The installment cannot amortize principal (negative or zero amortization).");
    }
    const principal = removed ? 0 : Math.min(openingPrincipal, fixedCredit - interest);
    const creditInstallment = principal + interest;
    const surety = removed ? 0 : fixedSurety;
    const insurance = removed ? 0 : fixedInsurance;
    const grossInstallment = creditInstallment + surety + insurance;
    if (priorInterestPaid > interest) {
      throw new Error("Previously paid interest exceeds projected interest; reconciliation is required.");
    }
    const pending = grossInstallment - priorInterestPaid;
    balance = principal === openingPrincipal ? 0 : openingPrincipal - principal;
    return {
      number,
      date,
      openingPrincipal,
      principal,
      interest,
      surety,
      insurance,
      creditInstallment,
      grossInstallment,
      priorInterestPaid,
      pending,
      closingPrincipal: balance,
      removed,
      display: {
        principal: Math.round(principal),
        interest: Math.round(interest),
        surety: Math.round(surety),
        insurance: Math.round(insurance),
        creditInstallment: Math.round(creditInstallment),
        grossInstallment: Math.round(grossInstallment),
        pending: Math.round(pending),
      },
    };
  });
  if (balance !== 0) {
    throw new Error("The supplied schedule is insufficient; this reference cannot extend the term.");
  }
  const active = rows.filter((row) => !row.removed);
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  return {
    mode: "REFERENCE_ONLY",
    rows,
    remainingInstallments: active.length,
    lastInstallmentNumber: active.at(-1)?.number ?? null,
    totals: {
      principal: sum("principal"),
      interest: sum("interest"),
      surety: sum("surety"),
      insurance: sum("insurance"),
      gross: sum("grossInstallment"),
      pending: sum("pending"),
    },
  };
}
