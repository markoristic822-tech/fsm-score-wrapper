const test = require("node:test");
const assert = require("node:assert/strict");
const { BusinessPartnerAssignment } = require("../business-partner-assignment");

function fixture({ partners = [
  { id: "bp-a", name: "Contractor A", externalId: "A_DIS" },
  { id: "bp-b", name: "Contractor B", externalId: "B_DIS" }
], patchError } = {}) {
  const calls = { first: { lastChanged: 12 }, second: { lastChanged: 15 } };
  const patches = [];
  const counters = {};
  const assignment = new BusinessPartnerAssignment({
    matrix: { key: { A_DIS: 50, B_DIS: 50 } }, sequences: { key: ["A_DIS", "B_DIS"] }, counters,
    baseUrl: "https://fsm.test", headers: () => ({}), getServiceCall: async (id) => calls[id],
    client: {
      async get(url) {
        const query = new URL(url).searchParams.get("query");
        assert.ok(query.startsWith("externalId="));
        const externalId = JSON.parse(query.slice("externalId=".length));
        return { data: { data: partners.filter((p) => p.externalId === externalId).map((businessPartner) => ({ businessPartner })) } };
      },
      async patch(url, body) {
        if (patchError) throw patchError;
        patches.push(body);
        Object.assign(calls[body.id], body);
      }
    }
  });
  return { assignment, calls, patches, counters };
}

test("uses matrix percentages and persists only the BP ID with optimistic locking", async () => {
  const f = fixture();
  const a = await f.assignment.assign("first", "key", "token");
  const b = await f.assignment.assign("second", "key", "token");
  assert.equal(a.businessPartner.name, "Contractor A");
  assert.equal(a.businessPartner.externalId, "A_DIS");
  assert.equal(b.businessPartner.name, "Contractor B");
  assert.equal(b.selectedContractor, "B_DIS");
  assert.deepEqual(f.patches[0], { id: "first", lastChanged: 12, businessPartner: "bp-a" });
  assert.equal(f.counters.key, 2);
});

test("concurrent retries reuse the persisted link without consuming another quota", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.assignment.assign("first", "key", "token"), f.assignment.assign("first", "key", "token")
  ]);
  assert.equal(results[1].reused, true);
  assert.equal(f.patches.length, 1);
  assert.equal(f.counters.key, 1);
});

test("unknown and duplicate BP external IDs never select a different company or fall back to name", async () => {
  for (const [partners, code] of [
    [[], "BUSINESS_PARTNER_NOT_FOUND"],
    [[{ id: "wrong", name: "A_DIS", externalId: "OTHER" }], "BUSINESS_PARTNER_NOT_FOUND"],
    [[{ id: "one", name: "First", externalId: "A_DIS" },
      { id: "two", name: "Second", externalId: "A_DIS" }], "BUSINESS_PARTNER_EXTERNAL_ID_AMBIGUOUS"]
  ]) {
    const f = fixture({ partners });
    await assert.rejects(f.assignment.assign("first", "key", "token"), { code });
    assert.equal(f.patches.length, 0);
    assert.equal(f.counters.key, undefined);
  }
});

test("renaming a linked BP preserves its allocation and does not consume quota", async () => {
  const partner = { id: "bp-a", name: "Old display name", externalId: "A_DIS" };
  const f = fixture({ partners: [partner] });
  await f.assignment.assign("first", "key", "token");
  partner.name = "New display name";
  const result = await f.assignment.assign("first", "key", "token");
  assert.equal(result.reused, true);
  assert.equal(result.selectedContractor, "A_DIS");
  assert.equal(result.businessPartner.name, "New display name");
  assert.equal(f.patches.length, 1);
  assert.equal(f.counters.key, 1);
});

test("failed PATCH does not advance the allocation counter", async () => {
  const f = fixture({ patchError: new Error("Concurrent modification") });
  await assert.rejects(f.assignment.assign("first", "key", "token"), /Concurrent modification/);
  assert.equal(f.counters.key, undefined);
});

test("missing lastChanged does not force an update", async () => {
  const f = fixture();
  delete f.calls.first.lastChanged;
  await assert.rejects(f.assignment.assign("first", "key", "token"), { code: "SERVICE_CALL_LAST_CHANGED_MISSING" });
  assert.equal(f.patches.length, 0);
});
