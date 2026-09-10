"use strict";

const EXTERNAL_ID = "DIS_SC_TECHNOLOGY";
const normalizeId = (value) => String(value || "").replace(/-/g, "").toUpperCase();

class ServiceCallTechnology {
  constructor(loadMetadata) {
    this.loadMetadata = loadMetadata;
    this.metadataId = null;
  }

  async read(serviceCall, token) {
    const values = Array.isArray(serviceCall.udfValues) ? serviceCall.udfValues : [];
    if (!values.length) return "";
    const reference = (value) => value.udfMeta || value.meta || value.metaId || value.key;
    let matches = values.filter((value) => reference(value)?.externalId === EXTERNAL_ID);
    if (!matches.length) {
      if (!this.metadataId) {
        const metadata = await this.loadMetadata(token);
        const candidates = metadata.filter((meta) => meta.externalId === EXTERNAL_ID && meta.id);
        if (candidates.length !== 1) throw new Error(`Expected one ${EXTERNAL_ID} UdfMeta; found ${candidates.length}`);
        this.metadataId = normalizeId(candidates[0].id);
      }
      matches = values.filter((value) => {
        const ref = reference(value);
        return normalizeId(typeof ref === "object" ? ref?.id : ref) === this.metadataId;
      });
    }
    const technologies = [...new Set(matches.map((value) => String(value.value ?? "").trim()).filter(Boolean))];
    if (technologies.length > 1) throw new Error("Conflicting DIS_SC_TECHNOLOGY values on Service Call");
    return technologies[0] || "";
  }
}

module.exports = { ServiceCallTechnology };
