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
  const logs = [];
  const reads = [];
  const app = {
    set() {}, use() {}, get() {},
    post(route, handler) { routes.set(route, handler); },
    listen() { return { on() {} }; }
  };
  const express = Object.assign(() => app, { json: () => () => {} });
  const localRequire = createRequire(path.join(root, "server.js"));
  const axios = {
    async get(url) {
      reads.push(url);
      if (url.includes('/UdfMeta?')) {
        if (options.metadataError) throw new Error("Metadata unavailable");
        return { data: { data: [{ udfMeta: { id: "technology-meta", externalId: "DIS_SC_TECHNOLOGY" } }] } };
      }
      assert.ok(url.includes('/BusinessPartner?'));
      return { data: { data: [{ businessPartner: { id: 'bp-1', name: options.businessPartnerName || 'DIMOU_L_DIS' } }] } };
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
  env.ASSIGNMENT_CONTEXT_KEY = "test-context-key";
  const context = vm.createContext({
    require(name) {
      if (name === "express") return express;
      if (name === "axios") return axios;
      if (name === "dotenv") return { config() {} };
      return localRequire(name);
    },
    __dirname: root,
    console: { log(...args) { logs.push(args); }, error(...args) { logs.push(args); } },
    process: { env, on() {}, exit() { throw new Error("Unexpected exit"); } },
    fixture: { externalId, skills, contractor: options.contractor || "DIMOU_L_DIS", udfValues: options.udfValues || [] }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), context);
  vm.runInContext(`
    getFsmToken = async () => "test-token";
    getServiceCall = async () => ({ id: "sc-1", externalId: fixture.externalId, lastChanged: 123, udfValues: fixture.udfValues });
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
  if (options.registeredWorkOrder) {
    let accepted;
    routes.get("/assignment/context")({
      body: { externalId: options.contextExternalId || externalId, workOrder: options.registeredWorkOrder },
      headers: { "x-assignment-context-key": "test-context-key" }
    }, {
      status(code) { assert.equal(code, 200); return this; },
      json(value) { accepted = value; }
    });
    assert.equal(accepted.accepted, true);
  }
  let result;
  await routes.get("/score-with-org-level")(
    { body: { serviceCallId: "sc-1", ...(options.workOrder === undefined ? {} : { workOrder: options.workOrder }) }, headers: {} },
    { json(value) { result = JSON.parse(JSON.stringify(value)); return result; } }
  );
  return { result, optimizationRequests, bpUpdates, logs, reads };
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

test("FTTH technology with MESH process selects SAT PRAXIS through the real route", async () => {
  const { result, optimizationRequests } = await score("PS11982837", ["MESH", "FTTH", "10443"], {
    udfValues: [{ meta: "technology-meta", value: "FTTH-GPON" }],
    businessPartnerName: "SAT_PRAXIS_DIS", contractor: "SAT_PRAXIS_DIS"
  });
  assert.equal(result.allocation.matrixKey, "10443|FTTH");
  assert.equal(result.businessPartnerAssignment.businessPartner.name, "SAT_PRAXIS_DIS");
  assert.deepEqual(optimizationRequests[0].job.mandatorySkills, ["MESH", "FTTH", "10443"]);
});

test("failed technology lookup does not assign a BP using a fallback row", async () => {
  const { result, bpUpdates, optimizationRequests } = await score("PS11982837", ["MESH", "FTTH", "10443"], {
    udfValues: [{ meta: "technology-meta", value: "FTTH-GPON" }], metadataError: true
  });
  assert.equal(result.fallbackReason, "SERVICE_CALL_TECHNOLOGY_LOOKUP_FAILED");
  assert.equal(bpUpdates.length, 0);
  assert.equal(optimizationRequests.length, 0);
});

test("postal flow wins over OTE and an unknown postal never falls through", async () => {
  const workOrder = { addressInfo: { postalCode: "19442" }, externalSystemInfo: { oteSiteId: "19" } };
  const { result } = await score("TAS123", ["19442"], { workOrder });
  assert.equal(result.allocation.matrixKey, "19442|INITIATOR (REMEDY)");
  assert.equal(result.businessPartnerAssignment.lookupStrategy, "POSTAL_CODE");
  workOrder.addressInfo.postalCode = "00000";
  const missing = await score("TAS123", ["19442"], { workOrder });
  assert.equal(missing.result.fallbackReason, "ALLOCATION_MATRIX_NOT_CONFIGURED");
  assert.equal(missing.bpUpdates.length, 0);
});

test("missing, empty and blank postal uses OTE matrix, links BP, and keeps Optimization skills", async () => {
  for (const postalCode of [null, "", "   "]) {
    const { result, optimizationRequests, reads, logs } = await score("PS123", ["MESH", "FTTH"], {
      workOrder: {
        addressInfo: { postalCode }, externalSystemInfo: { oteSiteId: "19", oteSite: "OTE description" },
        technicalInfo: { technology: "FTTH-GPON" }
      },
      // Original input must win, with no UDF metadata read even when FSM disagrees.
      udfValues: [{ meta: "technology-meta", value: "MESH" }], metadataError: true,
      businessPartnerName: "SAT_PRAXIS_DIS", contractor: "SAT_PRAXIS_DIS"
    });
    assert.equal(result.allocation.matrixKey, "OTE_SITE|19|FTTH");
    assert.equal(result.businessPartnerAssignment.lookupStrategy, "OTE_SITE");
    assert.equal(result.results[0].actSubContractorName, "SAT_PRAXIS_DIS");
    assert.deepEqual(optimizationRequests[0].job.mandatorySkills, ["MESH", "FTTH"]);
    assert.equal(reads.filter((url) => url.includes("/UdfMeta?")).length, 0);
    assert.ok(logs.some(([message, details]) => message === "OTE Site matrix match found:" && details.businessPartner === "bp-1"));
  }
});

test("OTE initiator allocation works with no postal or technology skill", async () => {
  for (const externalId of ["TAS123", "PS123"]) {
    const { result, bpUpdates } = await score(externalId, [], {
      workOrder: { externalSystemInfo: { oteSiteId: "126" } }
    });
    assert.equal(result.manualDispatchRequired, undefined);
    assert.equal(result.businessPartnerAssignment.lookupStrategy, "OTE_SITE");
    assert.equal(result.businessPartnerAssignment.businessPartner.name, "DIMOU_L_DIS");
    assert.equal(bpUpdates.length, 1);
  }
});

test("no Region implementation: missing IDs and unknown OTE retain manual dispatch without BP writes", async () => {
  for (const oteSiteId of [null, "", "   ", "UNKNOWN-SITE"]) {
    const { result, bpUpdates, optimizationRequests, logs } = await score("TAS123", ["LLU"], {
      workOrder: {
        addressInfo: { postalCode: null, prefecture: "ATTICA" },
        externalSystemInfo: { oteSiteId, oteSite: "126" }
      }
    });
    assert.equal(result.manualDispatchRequired, true);
    assert.equal(result.fallbackReason, oteSiteId === "UNKNOWN-SITE" ? "ALLOCATION_MATRIX_NOT_CONFIGURED" : "POSTAL_CODE_UNAVAILABLE");
    assert.equal(bpUpdates.length, 0);
    assert.equal(optimizationRequests.length, 0);
    assert.ok(logs.some(([message]) => String(message).includes(oteSiteId === "UNKNOWN-SITE"
      ? "No usable OTE Site matrix entry found" : "No Region fallback is configured")));
  }
});

test("legacy callers do not use Service Call OTE UDFs as assignment input", async () => {
  const { result, bpUpdates } = await score("TAS123", ["LLU"], {
    udfValues: [{ meta: { externalId: "DIS_SC_OTE_SITE_ID" }, value: "126" }]
  });
  assert.equal(result.fallbackReason, "POSTAL_CODE_UNAVAILABLE");
  assert.equal(bpUpdates.length, 0);
});

test("SOAP context registered before creation routes an unchanged FSM callback using the original OTE data", async () => {
  const { result, reads, logs } = await score("PS123", ["MESH", "FTTH"], {
    registeredWorkOrder: {
      addressInfo: { postalCode: "" }, externalSystemInfo: { oteSiteId: "19" },
      technicalInfo: { technology: "FTTH-GPON" }
    },
    udfValues: [{ meta: "technology-meta", value: "MESH" }], metadataError: true,
    businessPartnerName: "SAT_PRAXIS_DIS", contractor: "SAT_PRAXIS_DIS"
  });
  assert.equal(result.allocation.matrixKey, "OTE_SITE|19|FTTH");
  assert.equal(result.businessPartnerAssignment.lookupStrategy, "OTE_SITE");
  assert.equal(reads.filter((url) => url.includes("/UdfMeta?")).length, 0);
  assert.ok(logs.some(([message, details]) => message === "Assignment context source:" && details.source === "SOAP_CONTEXT"));
});

test("a context registered for another externalId cannot affect assignment", async () => {
  const { result, bpUpdates } = await score("PS123", ["LLU"], {
    contextExternalId: "PSOTHER", registeredWorkOrder: { externalSystemInfo: { oteSiteId: "126" } }
  });
  assert.equal(result.fallbackReason, "POSTAL_CODE_UNAVAILABLE");
  assert.equal(bpUpdates.length, 0);
});
