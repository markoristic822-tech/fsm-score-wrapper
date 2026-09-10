const test = require("node:test");
const assert = require("node:assert/strict");
const { ServiceCallTechnology } = require("../service-call-technology");
const { resolveAllocationRouting } = require("../allocation-routing");
const config = require("../allocation-matrix.json");

test("FTTH-GPON takes precedence over Mesh process requirements for the client example", () => {
  const skills = ["MESH", "FTTH", "10443"];
  const routing = resolveAllocationRouting(skills, { externalId: "PS11982837" }, config.skillColumnMap, "FTTH-GPON");
  assert.equal(routing.mode, "TECHNOLOGY");
  assert.equal(routing.matrixKey, "10443|FTTH");
  assert.deepEqual(config.matrix[routing.matrixKey], { SAT_PRAXIS_DIS: 100 });
  assert.deepEqual(skills, ["MESH", "FTTH", "10443"]);
});

test("technology precedence depends on the value, not FTTH being in the skills", () => {
  const routing = resolveAllocationRouting(["FTTH", "MESH", "10443"], {}, config.skillColumnMap, "mesh");
  assert.equal(routing.matrixKey, "10443|MESH");
  assert.deepEqual(config.matrix[routing.matrixKey], { PSP_ATH_DIS: 100 });
});

test("missing or unrecognized technology preserves the existing fallback", () => {
  for (const technology of ["", "ADSL", "NOTFTTH"]) {
    const routing = resolveAllocationRouting(["19442"], { externalId: "TAS123" }, {}, technology);
    assert.equal(routing.matrixKey, "19442|INITIATOR (REMEDY)");
  }
});

test("ambiguous technology and missing postal code do not choose arbitrary matrix rows", () => {
  assert.equal(resolveAllocationRouting(["10443"], {}, {}, "FTTH / FWA").reason, "TECHNOLOGY_AMBIGUOUS");
  assert.equal(resolveAllocationRouting(["MESH"], {}, {}, "FTTH-GPON").reason, "POSTAL_CODE_UNAVAILABLE");
  assert.equal(resolveAllocationRouting(["10443", "19442"], {}, {}, "FTTH-GPON").reason, "POSTAL_CODE_AMBIGUOUS");
});

test("resolves UUID metadata references and caches only the metadata ID", async () => {
  let lookups = 0;
  const resolver = new ServiceCallTechnology(async () => {
    lookups++;
    return [{ id: "AABB", externalId: "DIS_SC_TECHNOLOGY" }];
  });
  assert.equal(await resolver.read({ udfValues: [{ meta: "aa-bb", value: "FTTH-GPON" }] }), "FTTH-GPON");
  assert.equal(await resolver.read({ udfValues: [{ udfMeta: { id: "AABB" }, value: "FWA" }] }), "FWA");
  assert.equal(lookups, 1);
});

test("no UDFs or explicit technology metadata avoid a remote metadata lookup", async () => {
  const resolver = new ServiceCallTechnology(async () => { throw new Error("Unexpected lookup"); });
  assert.equal(await resolver.read({}), "");
  assert.equal(await resolver.read({ udfValues: [{ meta: { externalId: "DIS_SC_TECHNOLOGY" }, value: "FTTH-GPON" }] }), "FTTH-GPON");
});

test("lookup errors do not cause a silent switch to a different contractor", async () => {
  const resolver = new ServiceCallTechnology(async () => []);
  await assert.rejects(resolver.read({ udfValues: [{ meta: "AABB", value: "FTTH-GPON" }] }), /Expected one/);
});
