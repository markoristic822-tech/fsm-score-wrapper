"use strict";

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

class BusinessPartnerAssignment {
  constructor({ matrix, sequences, counters, client, baseUrl, headers, getServiceCall,
    serviceCallDto = "ServiceCall.27", businessPartnerDto = "BusinessPartner.22" }) {
    Object.assign(this, { matrix, sequences, counters, client,
      baseUrl: String(baseUrl || "").replace(/\/$/, ""), headers, getServiceCall,
      serviceCallDto, businessPartnerDto });
    this.pending = new Map();
  }

  // Serialize allocation for the same row within this process. The existing BP
  // link lets repeated requests reuse the assignment without consuming a quota.
  async assign(serviceCallId, matrixKey, token) {
    const previous = this.pending.get(matrixKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.assignNow(serviceCallId, matrixKey, token));
    this.pending.set(matrixKey, operation);
    try { return await operation; }
    finally { if (this.pending.get(matrixKey) === operation) this.pending.delete(matrixKey); }
  }

  async findByName(name, token) {
    const query = `name=${JSON.stringify(name)}`;
    const url = `${this.baseUrl}/api/data/v4/BusinessPartner?dtos=${encodeURIComponent(this.businessPartnerDto)}` +
      `&query=${encodeURIComponent(query)}&pageSize=2`;
    const response = await this.client.get(url, { headers: this.headers(token) });
    const rows = response.data?.data;
    if (!Array.isArray(rows)) throw failure("BUSINESS_PARTNER_RESPONSE_INVALID", "BusinessPartner lookup returned no data array");
    return rows.map((row) => row.businessPartner || row.BusinessPartner || row)
      .filter((partner) => partner?.id && partner.name === name);
  }

  async assignNow(serviceCallId, matrixKey, token) {
    const weights = this.matrix[matrixKey];
    const sequence = this.sequences[matrixKey];
    if (!weights || !sequence?.length) throw failure("ALLOCATION_MATRIX_NOT_CONFIGURED", `No allocation for ${matrixKey}`);
    const serviceCall = await this.getServiceCall(serviceCallId, token);
    if (!serviceCall) throw failure("SERVICE_CALL_NOT_FOUND", `Service Call ${serviceCallId} was not found`);
    const existingId = serviceCall.businessPartner?.id || serviceCall.businessPartner;
    const matches = new Map();
    for (const name of Object.keys(weights)) matches.set(name, await this.findByName(name, token));

    const counterBefore = this.counters[matrixKey] || 0;
    const sequencePosition = counterBefore % sequence.length;
    const existing = [...matches].find(([, partners]) => partners.length === 1 && partners[0].id === existingId);
    const selectedContractor = existing?.[0] || sequence[sequencePosition];
    const partners = matches.get(selectedContractor);
    if (partners.length !== 1) throw failure(
      partners.length ? "BUSINESS_PARTNER_NAME_AMBIGUOUS" : "BUSINESS_PARTNER_NOT_FOUND",
      `Expected one BusinessPartner named ${selectedContractor}; found ${partners.length}`
    );
    const partner = partners[0];
    if (!existing) {
      if (serviceCall.lastChanged == null) throw failure("SERVICE_CALL_LAST_CHANGED_MISSING", "Service Call lastChanged is missing");
      const url = `${this.baseUrl}/api/data/v4/ServiceCall/${encodeURIComponent(serviceCallId)}` +
        `?dtos=${encodeURIComponent(this.serviceCallDto)}`;
      await this.client.patch(url, {
        id: serviceCallId, lastChanged: serviceCall.lastChanged, businessPartner: partner.id
      }, { headers: this.headers(token) });
      this.counters[matrixKey] = counterBefore + 1;
    }
    return {
      matrixKey, selectedContractor, preferredContractor: selectedContractor,
      businessPartner: { id: partner.id, name: partner.name },
      reused: Boolean(existing), counterBefore, counterAfter: this.counters[matrixKey] || 0,
      sequencePosition: existing ? null : sequencePosition, sequenceLength: sequence.length,
      weights, fallbackUsed: false,
      reason: existing ? "EXISTING_BUSINESS_PARTNER_ASSIGNMENT" : "QUOTA_SEQUENCE"
    };
  }
}

module.exports = { BusinessPartnerAssignment };
