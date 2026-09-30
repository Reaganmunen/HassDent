// Money maths is done in integer cents so 0.1 + 0.2 never bites us.
const toCents = (v) => Math.round(Number(v || 0) * 100);
const fromCents = (c) => Number((c / 100).toFixed(2));   // number: for writing into NUMERIC columns
const formatCents = (c) => (c / 100).toFixed(2);          // string: for values returned to the API (matches NUMERIC output)

/** VAT contained in a tax-inclusive amount. */
const taxInside = (inclusiveCents, ratePercent) =>
  Math.round((inclusiveCents * Number(ratePercent)) / (100 + Number(ratePercent)));

module.exports = { toCents, fromCents, formatCents, taxInside };
