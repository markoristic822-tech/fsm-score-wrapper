"use strict";

const { timingSafeEqual } = require("node:crypto");
const clean = (value) => String(value ?? "").trim();
const failure = (status, message) => Object.assign(new Error(message), { status });

// Same single-process deployment as the allocation counters. Keep retries for
// 30 minutes; never evict an active order to accept another one.
class AssignmentContext {
  constructor({ ttlMs = 30 * 60 * 1000, maxEntries = 10000, now = Date.now } = {}) {
    Object.assign(this, { ttlMs, maxEntries, now });
    this.entries = new Map();
  }

  register(externalId, workOrder) {
    const key = clean(externalId);
    if (!key || key.length > 256 || !workOrder || typeof workOrder !== "object") {
      throw failure(400, "externalId and workOrder are required");
    }
    const context = {
      addressInfo: { postalCode: clean(workOrder.addressInfo?.postalCode) },
      externalSystemInfo: {
        oteSiteId: clean(workOrder.externalSystemInfo?.oteSiteId),
        oteSite: clean(workOrder.externalSystemInfo?.oteSite)
      },
      technicalInfo: { technology: clean(workOrder.technicalInfo?.technology) }
    };
    if (context.addressInfo.postalCode || !context.externalSystemInfo.oteSiteId) {
      throw failure(400, "OTE context requires an OTE Site ID and no postal code");
    }
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
    const existing = this.entries.get(key);
    if (existing && JSON.stringify(existing.workOrder) !== JSON.stringify(context)) {
      throw failure(409, "Different assignment context already exists for this externalId");
    }
    if (!existing && this.entries.size >= this.maxEntries) {
      throw failure(503, "Assignment context capacity reached");
    }
    this.entries.set(key, { workOrder: context, expiresAt: now + this.ttlMs });
    return key;
  }

  read(externalId) {
    const key = clean(externalId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return structuredClone(entry.workOrder);
  }
}

function registerAssignmentContextRoute(app, contexts, secret) {
  app.post("/assignment/context", (request, response) => {
    if (!secret) return response.status(503).json({ error: "Assignment context key is not configured" });
    const actual = Buffer.from(String(request.headers["x-assignment-context-key"] || ""));
    const expected = Buffer.from(secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return response.status(401).json({ error: "Invalid assignment context key" });
    }
    try {
      const externalId = contexts.register(request.body?.externalId, request.body?.workOrder);
      console.log("Assignment context received:", { externalId });
      return response.json({ accepted: true, externalId });
    } catch (error) {
      return response.status(error.status || 500).json({ error: error.message });
    }
  });
}

module.exports = { AssignmentContext, registerAssignmentContextRoute };
