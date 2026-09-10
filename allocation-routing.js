"use strict";

// Includes the spellings used by both the inbound adapter and Excel headers.
const TECHNOLOGY_KEYWORDS =
  /(^|[^A-Z0-9])(FTTH|FWA|MESH|DTH|CLOUD&SYZEFIXIS|CLOUD&SYZEFXIS)([^A-Z0-9]|$)/;

function buildSkillMatrixKey(skills) {
  return [...new Set(skills.map((skill) => String(skill).trim()).filter(Boolean))]
    .sort()
    .join("|");
}

function resolveAllocationRouting(skills, serviceCall = {}) {
  const hasTechnologyKeyword = skills.some((skill) =>
    TECHNOLOGY_KEYWORDS.test(
      String(skill).trim().toUpperCase().replace(/\s*&\s*/g, "&")
    )
  );

  if (hasTechnologyKeyword) {
    return {
      mode: "SKILL",
      matrixKey: buildSkillMatrixKey(skills),
      initiator: null,
      reason: null
    };
  }

  const externalId = String(serviceCall.externalId || "").trim().toUpperCase();
  const initiator = externalId.startsWith("PS")
    ? "PASPORT"
    : externalId.startsWith("TAS")
      ? "REMEDY"
      : null;

  const routing = { mode: "INITIATOR", matrixKey: null, initiator, reason: null };
  if (!initiator) {
    return { ...routing, reason: "SERVICE_CALL_INITIATOR_UNKNOWN" };
  }

  // Postal code remains the area requirement. The initiator is only a matrix
  // column, never an extra mandatory skill sent to Optimization.
  const postalCodes = [...new Set(skills.map((skill) => String(skill).trim()))]
    .filter((skill) => /^\d{5}$/.test(skill));
  if (postalCodes.length !== 1) {
    return {
      ...routing,
      reason: postalCodes.length ? "POSTAL_CODE_AMBIGUOUS" : "POSTAL_CODE_UNAVAILABLE"
    };
  }

  return {
    ...routing,
    matrixKey: `${postalCodes[0]}|INITIATOR (${initiator})`
  };
}

module.exports = { resolveAllocationRouting };
