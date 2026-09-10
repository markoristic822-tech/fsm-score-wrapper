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
    matrixKey: "19442|INITIATOR (REMEDY)"
  });
  assert.deepEqual(matrix[routing.matrixKey], { DIMOU_L_DIS: 100 });
  assert.deepEqual(skills, ["19442"]);
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
