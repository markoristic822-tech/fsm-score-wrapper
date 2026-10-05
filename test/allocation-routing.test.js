"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAllocationRouting } = require("../allocation-routing");
const { matrix } = require("../allocation-matrix.json");

test("the client's postal-only TAS order uses the Remedy percentages", () => {
  const skills = ["19442"];
  const routing = resolveAllocationRouting(skills, { externalId: "TAS000004497994" });
  assert.deepEqual(routing, {
    mode: "INITIATOR", initiator: "REMEDY", reason: null,
    matrixKey: "19442|INITIATOR (REMEDY)", strategy: "POSTAL_CODE"
  });
  assert.deepEqual(matrix[routing.matrixKey], { DIMOU_L_DIS: 100 });
  assert.deepEqual(skills, ["19442"]);
});

test("incoming postal code takes priority even if an OTE matrix entry exists", () => {
  const workOrder = { addressInfo: { postalCode: " 15125 " }, externalSystemInfo: { oteSiteId: "19" } };
  const routing = resolveAllocationRouting(["15125", "FTTH"], {}, {}, "", workOrder);
  assert.equal(routing.strategy, "POSTAL_CODE");
  assert.equal(routing.matrixKey, "15125|FTTH");
});

test("missing, null, empty and blank postal codes select OTE by ID", () => {
  for (const postalCode of [undefined, null, "", "   "]) {
    const workOrder = { addressInfo: { postalCode }, externalSystemInfo: { oteSiteId: " ote-001 ", oteSite: "Descriptive name" } };
    const routing = resolveAllocationRouting(["FTTH"], {}, {}, "", workOrder);
    assert.equal(routing.strategy, "OTE_SITE");
    assert.equal(routing.matrixKey, "OTE_SITE|OTE-001|FTTH");
    assert.equal(routing.oteSite, "Descriptive name");
  }
});

test("OTE reuses technology precedence and PS/TAS initiator percentages", () => {
  const workOrder = { externalSystemInfo: { oteSiteId: "19" } };
  assert.equal(resolveAllocationRouting(["FTTH", "MESH"], {}, {}, "FTTH-GPON", workOrder).matrixKey,
    "OTE_SITE|19|FTTH");
  assert.equal(resolveAllocationRouting([], { externalId: "PS123" }, {}, "", workOrder).matrixKey,
    "OTE_SITE|19|INITIATOR (PASPORT)");
  assert.equal(resolveAllocationRouting(["LLU"], { externalId: "TAS123" }, {}, "", workOrder).matrixKey,
    "OTE_SITE|19|INITIATOR (REMEDY)");
  assert.equal(resolveAllocationRouting(["FTTH", "MESH"], {}, {}, "", workOrder).matrixKey,
    "OTE_SITE|19|FTTH|MESH");
});

test("OTE IDs retain leading zeros, letters and separators; names never become lookup keys", () => {
  for (const id of ["0001", "OTE-001", "ATH-05"]) {
    const routing = resolveAllocationRouting(["FTTH"], {}, {}, "", {
      externalSystemInfo: { oteSiteId: id, oteSite: "19" }
    });
    assert.equal(routing.matrixKey, `OTE_SITE|${id}|FTTH`);
  }
  for (const oteSiteId of [undefined, null, "", "   "]) {
    const routing = resolveAllocationRouting(["FTTH"], {}, {}, "", {
      externalSystemInfo: { oteSiteId, oteSite: "19" }
    });
    assert.equal(routing.strategy, "NONE");
    assert.equal(routing.reason, "POSTAL_CODE_UNAVAILABLE");
    assert.equal(routing.matrixKey, null);
  }
});

test("unknown or invalid postal code never falls through to a configured OTE row", () => {
  for (const postalCode of ["00000", "bad-postal", "OTE_SITE|19|FTTH"]) {
    const routing = resolveAllocationRouting(["FTTH"], {}, {}, "", {
      addressInfo: { postalCode }, externalSystemInfo: { oteSiteId: "19" }
    });
    assert.equal(routing.strategy, "POSTAL_CODE");
    assert.equal(matrix[routing.matrixKey], undefined);
  }
});

test("unknown OTE code stays unconfigured without borrowing a postal, name or region entry", () => {
  const routing = resolveAllocationRouting(["FTTH", "19442"], {}, {}, "", {
    addressInfo: { postalCode: null, prefecture: "ATTICA" },
    externalSystemInfo: { oteSiteId: "UNKNOWN-SITE", oteSite: "126" }
  });
  assert.equal(routing.strategy, "OTE_SITE");
  assert.equal(routing.matrixKey, "OTE_SITE|UNKNOWN-SITE|FTTH");
  assert.equal(matrix[routing.matrixKey], undefined);
});

test("PS prefix selects PaSPort, ignoring case and surrounding whitespace", () => {
  const routing = resolveAllocationRouting(["19442"], { externalId: " ps123 " });
  assert.equal(routing.matrixKey, "19442|INITIATOR (PASPORT)");
  assert.ok(matrix[routing.matrixKey]);
});

test("unrecognized keywords do not become part of the initiator matrix key", () => {
  const routing = resolveAllocationRouting(["LLU", "Residential", "19442", "19442"], {
    externalId: "TAS123"
  });
  assert.equal(routing.matrixKey, "19442|INITIATOR (REMEDY)");
});

test("technology skills retain the existing matrix key, regardless of prefix", () => {
  for (const skill of ["FTTH", "FWA", "MESH", "DTH", "CLOUD&SYZEFIXIS",
    "CLOUD & SYZEFXIS", "Subcontractor DTH/SBB"]) {
    const routing = resolveAllocationRouting([skill, "19442", skill], { externalId: "OTHER123" });
    assert.equal(routing.mode, "SKILL", skill);
    assert.equal(routing.matrixKey, ["19442", skill].sort().join("|"));
    assert.equal(routing.reason, null);
  }
});

test("missing technology matrix row does not trigger initiator fallback", () => {
  const routing = resolveAllocationRouting(["FTTH", "MESH", "19442"], { externalId: "TAS123" });
  assert.equal(routing.matrixKey, "19442|FTTH|MESH");
  assert.equal(routing.mode, "SKILL");
});

test("unknown or missing prefix does not guess an initiator", () => {
  for (const externalId of [undefined, "", "OTHER123", "123TAS"]) {
    const routing = resolveAllocationRouting(["19442"], { externalId });
    assert.equal(routing.reason, "SERVICE_CALL_INITIATOR_UNKNOWN");
    assert.equal(routing.matrixKey, null);
  }
});

test("missing or ambiguous postal code returns a manual dispatch reason", () => {
  for (const skills of [[], ["LLU"], ["19442", "10010"]]) {
    const routing = resolveAllocationRouting(skills, { externalId: "TAS123" });
    assert.equal(routing.matrixKey, null);
    assert.equal(routing.reason, skills.length === 2 ? "POSTAL_CODE_AMBIGUOUS" : "POSTAL_CODE_UNAVAILABLE");
  }
});

test("unknown postal area remains unconfigured instead of borrowing another area's weights", () => {
  const routing = resolveAllocationRouting(["00000"], { externalId: "TAS123" });
  assert.equal(routing.matrixKey, "00000|INITIATOR (REMEDY)");
  assert.equal(matrix[routing.matrixKey], undefined);
});
