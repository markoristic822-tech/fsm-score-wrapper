"use strict";

// Includes the spellings used by both the inbound adapter and Excel headers.
const TECHNOLOGY_KEYWORDS =
  /(^|[^A-Z0-9])(FTTH|FWA|MESH|DTH|CLOUD&SYZEFIXIS|CLOUD&SYZEFXIS)([^A-Z0-9]|$)/;

function buildSkillMatrixKey(skills) {
  return [...new Set(skills.map((skill) => String(skill).trim()).filter(Boolean))]
    .sort()
    .join("|");
}

const clean = (value) => String(value ?? "").trim();
const isPostalCode = (value) => /^\d{5}$/.test(clean(value));

function resolveAllocationRouting(skills, serviceCall = {}, skillColumnMap = {}, technology = "", workOrder) {
  // Existing FSM callers can keep sending only serviceCallId. New callers pass
  // the original Siebel model; its address selects the area, never an FSM UDF.
  if (workOrder == null) {
    return { ...resolveMatrixRouting(skills, serviceCall, skillColumnMap, technology), strategy: "POSTAL_CODE" };
  }
  const postalCode = clean(workOrder.addressInfo?.postalCode);
  const areaSkills = skills.filter((skill) => !isPostalCode(skill));
  if (postalCode) {
    if (!isPostalCode(postalCode)) {
      return { mode: null, matrixKey: null, initiator: null, strategy: "POSTAL_CODE", postalCode, reason: "POSTAL_CODE_UNAVAILABLE" };
    }
    return {
      ...resolveMatrixRouting([...areaSkills, postalCode], serviceCall, skillColumnMap, technology),
      strategy: "POSTAL_CODE", postalCode
    };
  }
  const oteSiteId = clean(workOrder.externalSystemInfo?.oteSiteId).toUpperCase();
  const oteSite = clean(workOrder.externalSystemInfo?.oteSite);
  if (oteSiteId) {
    return {
      ...resolveMatrixRouting(areaSkills, serviceCall, skillColumnMap, technology, oteSiteId),
      strategy: "OTE_SITE", oteSiteId, oteSite
    };
  }
  // No Region assignment exists in this application. Keep manual dispatch.
  return { mode: null, matrixKey: null, initiator: null, strategy: "NONE", reason: "POSTAL_CODE_UNAVAILABLE" };
}

function resolveMatrixRouting(skills, serviceCall, skillColumnMap, technology, oteSiteId = "") {
  const areaCodes = oteSiteId ? [oteSiteId] : [...new Set(skills.map(clean))].filter(isPostalCode);
  const areaKey = oteSiteId ? `OTE_SITE|${oteSiteId}` : areaCodes[0];
  const normalizedTechnology = String(technology).trim().toUpperCase().replace(/\s*&\s*/g, "&");
  const technologyMatches = [...new Set(
    [...normalizedTechnology.matchAll(/(?:^|[^A-Z0-9])(FTTH|FWA|MESH|DTH|CLOUD&SYZEFIXIS|CLOUD&SYZEFXIS)(?=[^A-Z0-9]|$)/g)]
      .map((match) => match[1] === "CLOUD&SYZEFXIS" ? "CLOUD&SYZEFIXIS" : match[1])
  )];
  if (technologyMatches.length) {
    const routing = { mode: "TECHNOLOGY", matrixKey: null, initiator: null, technology, reason: null };
    if (technologyMatches.length > 1) return { ...routing, reason: "TECHNOLOGY_AMBIGUOUS" };
    if (areaCodes.length !== 1) return {
      ...routing, reason: areaCodes.length ? "POSTAL_CODE_AMBIGUOUS" : "POSTAL_CODE_UNAVAILABLE"
    };
    const keyword = technologyMatches[0];
    return { ...routing, matrixKey: `${areaKey}|${skillColumnMap[keyword] || keyword}` };
  }

  const hasTechnologyKeyword = skills.some((skill) =>
    TECHNOLOGY_KEYWORDS.test(
      String(skill).trim().toUpperCase().replace(/\s*&\s*/g, "&")
    )
  );

  if (hasTechnologyKeyword) {
    return {
      mode: "SKILL",
      matrixKey: (oteSiteId ? `${areaKey}|` : "") +
        buildSkillMatrixKey(skills.map((skill) => skillColumnMap[String(skill).trim()] || skill)),
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
  if (areaCodes.length !== 1) {
    return {
      ...routing,
      reason: areaCodes.length ? "POSTAL_CODE_AMBIGUOUS" : "POSTAL_CODE_UNAVAILABLE"
    };
  }

  return {
    ...routing,
    matrixKey: `${areaKey}|INITIATOR (${initiator})`
  };
}

module.exports = { resolveAllocationRouting };
