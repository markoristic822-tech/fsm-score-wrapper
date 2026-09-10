"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// Exercise the registered route with isolated FSM/Optimization boundaries.
// No server port, credentials or live service is used.
async function score(externalId, skills, options = {}) {
  const root = path.resolve(__dirname, "..");
  const routes = new Map();
  const optimizationRequests = [];
  const bpUpdates = [];
  const app = {
    set() {}, use() {}, get() {},
    post(route, handler) { routes.set(route, handler); },
    listen() { return { on() {} }; }
  };
  const express = Object.assign(() => app, { json: () => () => {} });
  const localRequire = createRequire(path.join(root, "server.js"));
  const axios = {
    async get(url) {
      assert.ok(url.includes('/BusinessPartner?'));
      return { data: { data: [{ businessPartner: { id: 'bp-1', name: 'DIMOU_L_DIS' } }] } };
    },
    async patch(url, payload) {
      assert.ok(url.includes('/ServiceCall/sc-1?'));
      bpUpdates.push(payload);
      return { data: {} };
    },
    async post(url, payload) {
      assert.equal(url, "https://optimization.test");
      assert.equal(bpUpdates.length, 1);
      optimizationRequests.push(payload);
      if (options.noResults) return { data: { results: [] } };
      const slot = payload.slots[0];
      return { data: { results: [{
        resource: "person-1", start: slot.start, end: slot.end, slot, score: 100
      }] } };
    }
  };
  const env = Object.fromEntries([
    "FSM_BASE_URL", "FSM_CLIENT_ID", "FSM_CLIENT_SECRET", "FSM_ACCOUNT_ID",
    "FSM_ACCOUNT_NAME", "FSM_COMPANY_ID", "FSM_COMPANY_NAME"
  ].map((key) => [key, "test"]));
  env.OPTIMIZATION_URL = "https://optimization.test";
  const context = vm.createContext({
    require(name) {
      if (name === "express") return express;
      if (name === "axios") return axios;
      if (name === "dotenv") return { config() {} };
      return localRequire(name);
    },
    __dirname: root,
    console: { log() {}, error() {} },
    process: { env, on() {}, exit() { throw new Error("Unexpected exit"); } },
    fixture: { externalId, skills, contractor: options.contractor || "DIMOU_L_DIS" }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);
  vm.runInContext(`
    getFsmToken = async () => "test-token";
    getServiceCall = async () => ({ id: "sc-1", externalId: fixture.externalId, lastChanged: 123 });
    getFirstItem = (value) => value;
    unwrapServiceCall = (value) => value;
    getRequirementsForServiceCall = async () => ({ response: {}, queryUsed: "test" });
    resolveRequirementSkills = async () => ({
      mandatorySkills: fixture.skills, tagIds: [], tagLookups: []
    });
    getUnifiedPerson = async () => ({ unifiedPerson: {
      orgLevel: "must-not-be-used",
      udfValues: [{ meta: PERSON_CONTRACTOR_UDF_META_ID, value: fixture.contractor }]
    } });
  `, context);
  let result;
  await routes.get("/score-with-org-level")(
    { body: { serviceCallId: "sc-1" }, headers: {} },
    { json(value) { result = JSON.parse(JSON.stringify(value)); return result; } }
  );
  return { result, optimizationRequests, bpUpdates };
}

test("postal-only orders reach Optimization and contractor selection using initiator weights", async () => {
  for (const [externalId, initiator] of [["TAS000004497994", "REMEDY"], ["PS123", "PASPORT"]]) {
    const { result, optimizationRequests, bpUpdates } = await score(externalId, ["19442"]);
    assert.equal(result.allocation.matrixKey, `19442|INITIATOR (${initiator})`);
    assert.equal(result.allocation.selectedContractor, "DIMOU_L_DIS");
    assert.equal(result.allocation.enrichmentFallbackUsed, false);
    assert.deepEqual(result.allocation.weights, { DIMOU_L_DIS: 100 });
    assert.equal(result.results[0].resource, "person-1");
    assert.equal(result.results[0].orgLevel, null);
    assert.equal(result.results[0].actSubContractorName, "DIMOU_L_DIS");
    assert.deepEqual(JSON.parse(JSON.stringify(bpUpdates[0])), { id: "sc-1", lastChanged: 123, businessPartner: "bp-1" });
    assert.deepEqual(optimizationRequests[0].job.mandatorySkills, ["19442"]);
  }
});

test("technology orders still use their technology allocation row", async () => {
  const { result } = await score("TAS123", ["19442", "FTTH"]);
  assert.equal(result.allocation.matrixKey, "19442|FTTH");
  assert.equal(result.allocation.selectedContractor, "DIMOU_L_DIS");
});

test("unknown initiators return manual dispatch before Optimization", async () => {
  const { result, optimizationRequests } = await score("OTHER123", ["19442"]);
  assert.equal(result.fallbackReason, "SERVICE_CALL_INITIATOR_UNKNOWN");
  assert.equal(result.manualDispatchRequired, true);
  assert.equal(optimizationRequests.length, 0);
});

test("BP remains linked when no technician or slot is available", async () => {
  const { result, bpUpdates } = await score("TAS123", ["19442"], { noResults: true });
  assert.equal(bpUpdates.length, 1);
  assert.equal(result.fallbackReason, "NO_VALID_OPTIMIZATION_RESULT");
  assert.equal(result.fallbackDetails.assignment.businessPartner.name, "DIMOU_L_DIS");
  assert.equal(result.results[0].actSubContractorName, "DIMOU_L_DIS");
  assert.equal(result.businessPartnerAssignment.businessPartner.id, "bp-1");
});

test("a resource from a different subcontractor cannot replace the matrix assignment", async () => {
  const { result, bpUpdates } = await score("TAS123", ["19442"], { contractor: "OTHER_DIS" });
  assert.equal(bpUpdates.length, 1);
  assert.equal(result.fallbackReason, "NO_RESOURCE_FOR_SELECTED_SUBCONTRACTOR");
  assert.equal(result.fallbackDetails.assignment.selectedContractor, "DIMOU_L_DIS");
  assert.equal(result.results[0].resource, null);
});
