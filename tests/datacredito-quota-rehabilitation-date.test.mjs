import assert from "node:assert/strict";
import test from "node:test";
import { formatQuotaRehabilitationDate } from "../lib/datacredito/quota-rehabilitation-date.ts";

test("formats the backend reset timestamp as a human date in Bogota", () => {
  assert.equal(
    formatQuotaRehabilitationDate("2026-09-12T05:00:00.000Z"),
    "12 de septiembre de 2026"
  );
  assert.equal(
    formatQuotaRehabilitationDate("2026-09-12T04:59:59.999Z"),
    "11 de septiembre de 2026"
  );
});

test("keeps year and month boundaries in the Colombia time zone", () => {
  for (const [timestamp, label] of [
    ["2027-01-01T04:59:59.999Z", "31 de diciembre de 2026"],
    ["2027-01-01T05:00:00.000Z", "1 de enero de 2027"],
    ["2026-10-01T04:59:59.999Z", "30 de septiembre de 2026"],
    ["2026-10-01T05:00:00.000Z", "1 de octubre de 2026"],
    ["2028-02-29T05:00:00.000Z", "29 de febrero de 2028"],
    ["2028-03-01T04:59:59.999Z", "29 de febrero de 2028"],
  ]) assert.equal(formatQuotaRehabilitationDate(timestamp), label);
});

test("rejects missing, ambiguous and impossible reset dates instead of inventing a rehabilitation day", () => {
  for (const timestamp of [
    "", "  ", "not-a-date", "2026-09-12", "2026-09-12T00:00:00",
    "2026-02-29T05:00:00.000Z", "2026-02-30T05:00:00.000Z",
    "2026-13-01T05:00:00.000Z", "2026-09-12T25:00:00.000Z",
  ]) assert.equal(formatQuotaRehabilitationDate(timestamp), null, timestamp);
});

test("an incorrect client clock cannot change the server-provided date", (context) => {
  const clock = context.mock.method(Date, "now", () => Date.parse("1990-01-01T00:00:00.000Z"));
  const resetTimestamp = "2026-09-12T05:00:00.000Z";
  assert.equal(formatQuotaRehabilitationDate(resetTimestamp), "12 de septiembre de 2026");
  clock.mock.mockImplementation(() => Date.parse("2099-12-31T23:59:59.000Z"));
  assert.equal(formatQuotaRehabilitationDate(resetTimestamp), "12 de septiembre de 2026");
  assert.equal(clock.mock.callCount(), 0, "Formatting must not consult Date.now");
});
