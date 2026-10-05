"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { AssignmentContext, registerAssignmentContextRoute } = require("../assignment-context");

const workOrder = {
  addressInfo: { postalCode: " " },
  externalSystemInfo: { oteSiteId: " 019 ", oteSite: " Description " },
  technicalInfo: { technology: " FTTH-GPON " },
  accountContactInfo: { contactPhone: "must not be stored" }
};

test("context preserves only assignment fields and cannot be mixed across orders or mutated by a caller", () => {
  const store = new AssignmentContext();
  store.register(" PS1 ", workOrder);
  assert.equal(store.read("PS2"), undefined);
  const context = store.read("PS1");
  assert.deepEqual(context, {
    addressInfo: { postalCode: "" }, externalSystemInfo: { oteSiteId: "019", oteSite: "Description" },
    technicalInfo: { technology: "FTTH-GPON" }
  });
  context.externalSystemInfo.oteSiteId = "other";
  assert.equal(store.read("PS1").externalSystemInfo.oteSiteId, "019");
});

test("retries reuse the context; conflicting context cannot overwrite an in-flight order", () => {
  const store = new AssignmentContext();
  store.register("PS1", workOrder);
  assert.equal(store.register("PS1", workOrder), "PS1");
  assert.throws(() => store.register("PS1", { externalSystemInfo: { oteSiteId: "126" } }), { status: 409 });
  assert.equal(store.read("PS1").externalSystemInfo.oteSiteId, "019");
});

test("expiry cleans stale contexts and capacity never evicts an active order", () => {
  let now = 100;
  const store = new AssignmentContext({ ttlMs: 100, maxEntries: 1, now: () => now });
  store.register("PS1", workOrder);
  assert.throws(() => store.register("PS2", workOrder), { status: 503 });
  now = 200;
  store.register("PS2", workOrder);
  assert.equal(store.read("PS1"), undefined);
  now = 300;
  assert.equal(store.read("PS2"), undefined);
});

test("context endpoint requires its shared key before accepting any data", () => {
  for (const [secret, supplied, expectedStatus] of [[undefined, "test-key", 503], ["test-key", "wrong", 401], ["test-key", "", 401], ["test-key", "test-key", 200]]) {
    const store = new AssignmentContext();
    let handler;
    registerAssignmentContextRoute({ post(route, callback) { assert.equal(route, "/assignment/context"); handler = callback; } }, store, secret);
    let status = 200;
    let body;
    const response = { status(code) { status = code; return this; }, json(value) { body = value; } };
    handler({ headers: { "x-assignment-context-key": supplied }, body: { externalId: "PS1", workOrder } }, response);
    assert.equal(status, expectedStatus);
    assert.equal(Boolean(store.read("PS1")), expectedStatus === 200);
    if (expectedStatus === 200) assert.deepEqual(body, { accepted: true, externalId: "PS1" });
  }
});

test("empty IDs, missing Work Orders and non-OTE contexts are rejected", () => {
  const store = new AssignmentContext();
  for (const [id, value] of [["", workOrder], ["PS1", undefined], ["PS1", {}], ["PS1", { ...workOrder, addressInfo: { postalCode: "19442" } }]]) {
    assert.throws(() => store.register(id, value), { status: 400 });
  }
});
