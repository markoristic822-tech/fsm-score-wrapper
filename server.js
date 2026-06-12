const express = require("express");
const axios = require("axios");
const { DateTime } = require("luxon");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "10mb" }));

const {
  PORT = 3000,
  FSM_BASE_URL,
  FSM_CLIENT_ID,
  FSM_CLIENT_SECRET,
  FSM_ACCOUNT_ID,
  FSM_ACCOUNT_NAME,
  FSM_COMPANY_ID,
  FSM_COMPANY_NAME,
  OPTIMIZATION_URL,
  FSM_REQUIREMENT_DTO = "Requirement.10",
  FSM_PERSON_DTO = "Person.25",
  FSM_SERVICE_CALL_DTO = "ServiceCall.27",
  FSM_TAG_DTO = "Tag.10"
} = process.env;

/*
 * Matrica zavisi isključivo od kombinacije mandatory skillova.
 *
 * Ključ se pravi tako što se skillovi:
 * - uklone duplikati
 * - sortiraju
 * - spoje znakom |
 *
 * Primer:
 * ["10173", "10010"] => "10010|10173"
 */
const CONTRACTOR_ALLOCATION_MATRIX = {
  "10010": {
    ICOM: 70,
    SAT_PRAXIS: 30
  }

  /*
   * Kasnije možeš dodati:
   *
   * "10010|10173": {
   *   ICOM: 60,
   *   SAT_PRAXIS: 40
   * }
   */
};

/*
 * Ravnomerno raspoređena sekvenca za odnos 70:30.
 *
 * U svakih 10 dodela:
 * ICOM dobija 7
 * SAT_PRAXIS dobija 3
 */
const CONTRACTOR_ALLOCATION_SEQUENCES = {
  "10010": [
    "ICOM",
    "ICOM",
    "SAT_PRAXIS",
    "ICOM",
    "ICOM",
    "SAT_PRAXIS",
    "ICOM",
    "ICOM",
    "SAT_PRAXIS",
    "ICOM"
  ]
};

/*
 * Privremeni brojači u memoriji.
 *
 * Posle Render restarta vraćaju se na nulu.
 * Za produkciju ćemo ih prebaciti u PostgreSQL.
 */
const allocationCounters = {};

if (
  !FSM_BASE_URL ||
  !FSM_CLIENT_ID ||
  !FSM_CLIENT_SECRET ||
  !FSM_ACCOUNT_ID ||
  !FSM_ACCOUNT_NAME ||
  !FSM_COMPANY_ID ||
  !FSM_COMPANY_NAME ||
  !OPTIMIZATION_URL
) {
  console.error("Missing required environment values.");

  console.error({
    FSM_BASE_URL: !!FSM_BASE_URL,
    FSM_CLIENT_ID: !!FSM_CLIENT_ID,
    FSM_CLIENT_SECRET: !!FSM_CLIENT_SECRET,
    FSM_ACCOUNT_ID: !!FSM_ACCOUNT_ID,
    FSM_ACCOUNT_NAME: !!FSM_ACCOUNT_NAME,
    FSM_COMPANY_ID: !!FSM_COMPANY_ID,
    FSM_COMPANY_NAME: !!FSM_COMPANY_NAME,
    OPTIMIZATION_URL: !!OPTIMIZATION_URL,
    FSM_REQUIREMENT_DTO,
    FSM_PERSON_DTO,
    FSM_SERVICE_CALL_DTO,
    FSM_TAG_DTO
  });

  process.exit(1);
}

function fsmHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Client-Version": "1.0",
    "X-Client-ID": FSM_CLIENT_ID,
    "x-account-id": FSM_ACCOUNT_ID,
    "x-account-name": FSM_ACCOUNT_NAME,
    "x-company-id": FSM_COMPANY_ID,
    "x-company-name": FSM_COMPANY_NAME
  };
}

function dataApiUrl(dtoName, dtoVersion, query) {
  return (
    `${FSM_BASE_URL}/api/data/v4/${dtoName}` +
    `?dtos=${encodeURIComponent(dtoVersion)}` +
    `&query=${encodeURIComponent(query)}`
  );
}

function buildSkillMatrixKey(skills) {
  return [...new Set(skills.map((skill) => String(skill).trim()))]
    .filter(Boolean)
    .sort()
    .join("|");
}

function generateRollingSlots() {
  const timezone = "Europe/Athens";
  const daysAhead = 7;

  const workingDayStartHour = 8;
  const workingDayEndHour = 18;

  const startBufferMinutes = 5;
  const slotDurationMinutes = 30;

  const now = DateTime.now()
    .setZone(timezone)
    .plus({ minutes: startBufferMinutes });

  const slots = [];

  for (let dayOffset = 0; dayOffset < daysAhead; dayOffset++) {
    const day = now.plus({ days: dayOffset });

    let dayStart = day.set({
      hour: workingDayStartHour,
      minute: 0,
      second: 0,
      millisecond: 0
    });

    const dayEnd = day.set({
      hour: workingDayEndHour,
      minute: 0,
      second: 0,
      millisecond: 0
    });

    if (dayOffset === 0 && now > dayStart) {
      dayStart = now;
    }

    if (
      dayStart.second !== 0 ||
      dayStart.millisecond !== 0 ||
      dayStart.minute % slotDurationMinutes !== 0
    ) {
      const minutesToAdd =
        slotDurationMinutes - (dayStart.minute % slotDurationMinutes);

      dayStart = dayStart
        .plus({ minutes: minutesToAdd })
        .set({
          second: 0,
          millisecond: 0
        });
    } else {
      dayStart = dayStart.set({
        second: 0,
        millisecond: 0
      });
    }

    let slotStart = dayStart;

    while (slotStart.plus({ minutes: slotDurationMinutes }) <= dayEnd) {
      const slotEnd = slotStart.plus({
        minutes: slotDurationMinutes
      });

      slots.push({
        start: slotStart.toUTC().toISO(),
        end: slotEnd.toUTC().toISO()
      });

      slotStart = slotEnd;
    }
  }

  return slots;
}

async function getFsmToken() {
  console.log("Getting FSM token...");

  const response = await axios.post(
    `${FSM_BASE_URL}/api/oauth2/v1/token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: FSM_CLIENT_ID,
      client_secret: FSM_CLIENT_SECRET
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return response.data.access_token;
}

async function getServiceCall(serviceCallId, token) {
  console.log("Getting ServiceCall:", serviceCallId);

  const url = dataApiUrl(
    "ServiceCall",
    FSM_SERVICE_CALL_DTO,
    `id="${serviceCallId}"`
  );

  const response = await axios.get(url, {
    headers: fsmHeaders(token)
  });

  return response.data;
}

async function getPerson(resourceId, token) {
  console.log("Getting Person for resource:", resourceId);

  const url = dataApiUrl(
    "Person",
    FSM_PERSON_DTO,
    `id="${resourceId}"`
  );

  const response = await axios.get(url, {
    headers: fsmHeaders(token)
  });

  return response.data;
}

async function getTag(tagId, token) {
  console.log("Getting Tag:", tagId);

  const queriesToTry = [
    `id="${tagId}"`,
    `externalId="${tagId}"`,
    `name="${tagId}"`
  ];

  const errors = [];

  for (const query of queriesToTry) {
    const url = dataApiUrl("Tag", FSM_TAG_DTO, query);

    try {
      console.log("Trying Tag query:", query);

      const response = await axios.get(url, {
        headers: fsmHeaders(token)
      });

      const data = response.data;
      const rows = Array.isArray(data?.data) ? data.data : [];

      console.log("Tag query result count:", rows.length);

      if (rows.length > 0) {
        console.log(
          "Tag response:",
          JSON.stringify(data, null, 2)
        );

        return {
          response: data,
          queryUsed: query,
          errors
        };
      }
    } catch (error) {
      const status = error.response?.status || null;
      const data = error.response?.data || error.message;

      errors.push({
        query,
        status,
        data
      });

      console.log(
        "Tag query failed:",
        query,
        status,
        JSON.stringify(data)
      );
    }
  }

  return {
    response: {
      data: []
    },
    queryUsed: null,
    errors
  };
}

async function getRequirementsForServiceCall(serviceCallId, token) {
  console.log(
    "Getting Requirements for ServiceCall:",
    serviceCallId
  );

  const queriesToTry = [
    `object.objectId="${serviceCallId}"`,
    `object.objectId="${serviceCallId}" AND object.objectType="SERVICECALL"`,
    `object.objectId="${serviceCallId}" and object.objectType="SERVICECALL"`
  ];

  const errors = [];
  const emptyResponses = [];

  for (const query of queriesToTry) {
    const url = dataApiUrl(
      "Requirement",
      FSM_REQUIREMENT_DTO,
      query
    );

    try {
      console.log("Trying Requirement query:", query);

      const response = await axios.get(url, {
        headers: fsmHeaders(token)
      });

      const data = response.data;
      const rows = Array.isArray(data?.data) ? data.data : [];

      console.log(
        "Requirement query result count:",
        rows.length
      );

      if (rows.length > 0) {
        console.log(
          "Requirement response:",
          JSON.stringify(data, null, 2)
        );

        return {
          response: data,
          queryUsed: query,
          errors,
          emptyResponses
        };
      }

      emptyResponses.push({
        query,
        response: data
      });
    } catch (error) {
      const status = error.response?.status || null;
      const data = error.response?.data || error.message;

      errors.push({
        query,
        status,
        data
      });

      console.log(
        "Requirement query failed:",
        query,
        status,
        JSON.stringify(data)
      );
    }
  }

  return {
    response: {
      data: []
    },
    queryUsed: null,
    errors,
    emptyResponses
  };
}

function getFirstItem(response) {
  if (Array.isArray(response)) return response[0];
  if (Array.isArray(response?.data)) return response.data[0];
  if (Array.isArray(response?.items)) return response.items[0];
  if (Array.isArray(response?.values)) return response.values[0];
  if (Array.isArray(response?.records)) return response.records[0];

  return null;
}

function unwrapServiceCall(wrapper) {
  if (!wrapper) return null;

  return (
    wrapper.serviceCall ||
    wrapper.ServiceCall ||
    wrapper
  );
}

function unwrapPerson(wrapper) {
  if (!wrapper) return null;

  return (
    wrapper.person ||
    wrapper.Person ||
    wrapper.unifiedPerson ||
    wrapper.UnifiedPerson ||
    wrapper
  );
}

function unwrapRequirement(wrapper) {
  if (!wrapper) return null;

  return (
    wrapper.requirement ||
    wrapper.Requirement ||
    wrapper
  );
}

function unwrapTag(wrapper) {
  if (!wrapper) return null;

  return (
    wrapper.tag ||
    wrapper.Tag ||
    wrapper
  );
}

function normalizeOrgLevel(orgLevel) {
  if (!orgLevel) return null;

  if (typeof orgLevel === "string") {
    return orgLevel;
  }

  if (typeof orgLevel === "object") {
    return (
      orgLevel.id ||
      orgLevel.objectId ||
      orgLevel.externalId ||
      null
    );
  }

  return null;
}

function extractOrgLevel(personWrapper) {
  const person = unwrapPerson(personWrapper);

  if (!person) return null;

  const rawOrgLevel =
    person.orgLevelIds?.[0] ||
    person.orgLevel ||
    person.orgLevelId ||
    person.orgLevels?.[0] ||
    person.organizationLevel ||
    person.organizationLevelId ||
    person.organizationLevelIds?.[0] ||
    person.organizationalLevel ||
    person.organization;

  return normalizeOrgLevel(rawOrgLevel);
}

/*
 * Pokušava da pročita custom PersonContractor vrednost.
 *
 * Proverava:
 * - direktna polja na Person DTO-u
 * - udfValues kao niz
 * - udfValues kao objekat
 *
 * Kada dobijemo tačan Person response, možemo ovu funkciju
 * dodatno precizirati.
 */
function extractPersonContractor(personWrapper) {
  const person = unwrapPerson(personWrapper);

  if (!person) return null;

  const directValue =
    person.personContractor ||
    person.PersonContractor ||
    person.contractor ||
    person.contractorCode ||
    person.contractorName ||
    null;

  if (typeof directValue === "string" && directValue.trim()) {
    return normalizeContractorCode(directValue);
  }

  const udfValues = person.udfValues;

  if (Array.isArray(udfValues)) {
    for (const udf of udfValues) {
      if (!udf || typeof udf !== "object") {
        continue;
      }

      const fieldName = String(
        udf.name ||
        udf.key ||
        udf.code ||
        udf.meta ||
        udf.metaName ||
        udf.fieldName ||
        udf.udfName ||
        ""
      ).toLowerCase();

      if (
        fieldName === "personcontractor" ||
        fieldName === "person_contractor" ||
        fieldName === "contractor"
      ) {
        const value =
          udf.value ||
          udf.stringValue ||
          udf.textValue ||
          udf.displayValue ||
          null;

        if (typeof value === "string" && value.trim()) {
          return normalizeContractorCode(value);
        }
      }
    }
  }

  if (udfValues && typeof udfValues === "object" && !Array.isArray(udfValues)) {
    const possibleValue =
      udfValues.PersonContractor ||
      udfValues.personContractor ||
      udfValues.person_contractor ||
      udfValues.contractor ||
      null;

    if (
      typeof possibleValue === "string" &&
      possibleValue.trim()
    ) {
      return normalizeContractorCode(possibleValue);
    }
  }

  return null;
}

function normalizeContractorCode(value) {
  const normalized = String(value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  const aliases = {
    "SATPRAXIS": "SAT_PRAXIS",
    "SAT_PRAXIS": "SAT_PRAXIS",
    "SAT_PRAXIS_DOO": "SAT_PRAXIS",
    "ICOM": "ICOM",
    "ICOM_DOO": "ICOM"
  };

  return aliases[normalized] || normalized;
}

function extractDurationFromServiceCall(serviceCall) {
  if (!serviceCall) return null;

  return (
    serviceCall.durationInMinutes ||
    serviceCall.durationMinutes ||
    serviceCall.duration ||
    serviceCall.plannedDurationInMinutes ||
    null
  );
}

function extractLocationFromServiceCall(serviceCall) {
  if (!serviceCall) return null;

  const address = serviceCall.address || {};

  const latitude =
    serviceCall.latitude ||
    serviceCall.lat ||
    serviceCall.location?.latitude ||
    serviceCall.location?.lat ||
    address.latitude ||
    address.lat ||
    address.location?.latitude ||
    address.location?.lat ||
    address.geoLatitude ||
    null;

  const longitude =
    serviceCall.longitude ||
    serviceCall.lng ||
    serviceCall.lon ||
    serviceCall.location?.longitude ||
    serviceCall.location?.lng ||
    serviceCall.location?.lon ||
    address.longitude ||
    address.lng ||
    address.lon ||
    address.location?.longitude ||
    address.location?.lng ||
    address.location?.lon ||
    address.geoLongitude ||
    null;

  if (
    latitude === null ||
    latitude === undefined ||
    longitude === null ||
    longitude === undefined
  ) {
    return null;
  }

  return {
    latitude: Number(latitude),
    longitude: Number(longitude)
  };
}

function addStringIfValid(values, value) {
  if (typeof value !== "string") return;

  const cleaned = value.trim();

  if (!cleaned) return;

  values.push(cleaned);
}

function extractRequirementTagIds(requirementResponse) {
  const rows = Array.isArray(requirementResponse?.data)
    ? requirementResponse.data
    : [];

  const tagIds = [];

  for (const row of rows) {
    const requirement = unwrapRequirement(row);

    if (!requirement) continue;

    if (requirement.mandatory === false) {
      continue;
    }

    addStringIfValid(tagIds, requirement.tag);
  }

  return [...new Set(tagIds)];
}

function extractSkillsFromTagResponse(
  tagResponse,
  fallbackTagId
) {
  const tagWrapper = getFirstItem(tagResponse);
  const tag = unwrapTag(tagWrapper);

  const skills = [];

  if (tag) {
    addStringIfValid(skills, tag.externalId);
    addStringIfValid(skills, tag.name);

    if (skills.length === 0) {
      addStringIfValid(skills, tag.id);
    }
  }

  if (skills.length === 0) {
    addStringIfValid(skills, fallbackTagId);
  }

  return [...new Set(skills)];
}

async function resolveRequirementSkills(
  requirementResponse,
  token
) {
  const tagIds = extractRequirementTagIds(
    requirementResponse
  );

  console.log("Requirement Tag IDs:", tagIds);

  const resolvedSkills = [];
  const tagLookups = [];

  for (const tagId of tagIds) {
    const tagLookup = await getTag(tagId, token);

    const skillsFromTag =
      extractSkillsFromTagResponse(
        tagLookup.response,
        tagId
      );

    tagLookups.push({
      tagId,
      success: skillsFromTag.length > 0,
      queryUsed: tagLookup.queryUsed,
      skillsFromTag
    });

    resolvedSkills.push(...skillsFromTag);
  }

  return {
    mandatorySkills: [...new Set(resolvedSkills)],
    tagIds,
    tagLookups
  };
}

function buildOptimizationPayload(
  reqBody,
  serviceCall,
  mandatorySkills
) {
  const fallbackJob = reqBody.job || {};

  const durationMinutes =
    extractDurationFromServiceCall(serviceCall) ||
    fallbackJob.durationMinutes ||
    fallbackJob.durationInMinutes ||
    60;

  const location =
    extractLocationFromServiceCall(serviceCall) ||
    fallbackJob.location ||
    {
      latitude: 38.0344,
      longitude: 23.1283
    };

  return {
    job: {
      durationMinutes,
      location,
      mandatorySkills
    },
    resources: reqBody.resources || {
      filters: {
        includeInternalPersons: true,
        includeCrowdPersons: false,
        includeMandatorySkills:
          mandatorySkills.length > 0
      }
    },
    slots: generateRollingSlots(),
    options: reqBody.options || {
      /*
       * Treba da vratimo više resursa da bismo mogli
       * da proverimo različite contractore.
       */
      maxResultsPerSlot: 10,
      defaultDrivingTimeMinutes: 30
    },
    policy:
      reqBody.policy ||
      "DistanceAndSkills"
  };
}

function isResultInsideSlot(result) {
  if (
    !result ||
    !result.start ||
    !result.end ||
    !result.slot?.start ||
    !result.slot?.end
  ) {
    return false;
  }

  const resultStart = DateTime.fromISO(
    result.start,
    { setZone: true }
  );

  const resultEnd = DateTime.fromISO(
    result.end,
    { setZone: true }
  );

  const slotStart = DateTime.fromISO(
    result.slot.start,
    { setZone: true }
  );

  const slotEnd = DateTime.fromISO(
    result.slot.end,
    { setZone: true }
  );

  if (
    !resultStart.isValid ||
    !resultEnd.isValid ||
    !slotStart.isValid ||
    !slotEnd.isValid
  ) {
    return false;
  }

  return (
    resultStart.toMillis() >= slotStart.toMillis() &&
    resultEnd.toMillis() <= slotEnd.toMillis()
  );
}

function normalizeOptimizationResult(result) {
  return {
    slot: result.slot || null,
    resource: result.resource,
    start: result.start,
    end: result.end,
    trip: result.trip || null,
    score: result.score ?? null
  };
}

function selectContractorBySequence(
  matrixKey,
  availableContractors
) {
  const sequence =
    CONTRACTOR_ALLOCATION_SEQUENCES[matrixKey];

  const weights =
    CONTRACTOR_ALLOCATION_MATRIX[matrixKey];

  if (!sequence || !weights) {
    return {
      selectedContractor: null,
      preferredContractor: null,
      fallbackUsed: false,
      reason: "MATRIX_NOT_CONFIGURED",
      counterBefore: null,
      counterAfter: null,
      sequencePosition: null,
      weights: null
    };
  }

  const counterBefore =
    allocationCounters[matrixKey] || 0;

  const sequencePosition =
    counterBefore % sequence.length;

  const preferredContractor =
    sequence[sequencePosition];

  let selectedContractor = null;
  let fallbackUsed = false;
  let reason = null;

  if (
    availableContractors.includes(
      preferredContractor
    )
  ) {
    selectedContractor =
      preferredContractor;

    reason = "QUOTA_SEQUENCE";
  } else if (availableContractors.length > 0) {
    selectedContractor =
      availableContractors[0];

    fallbackUsed = true;
    reason =
      "QUOTA_FALLBACK_PREFERRED_CONTRACTOR_UNAVAILABLE";
  }

  /*
   * Brojač povećavamo samo ako smo stvarno izabrali contractor-a.
   */
  if (selectedContractor) {
    allocationCounters[matrixKey] =
      counterBefore + 1;
  }

  return {
    selectedContractor,
    preferredContractor,
    fallbackUsed,
    reason,
    counterBefore,
    counterAfter:
      allocationCounters[matrixKey] ??
      counterBefore,
    sequencePosition,
    sequenceLength:
      sequence.length,
    weights
  };
}

async function enrichOptimizationResultsWithPerson(
  validResults,
  token
) {
  /*
   * Optimization često vraća istog resource-a
   * za više različitih slotova.
   *
   * Zato Person dohvatamo samo jednom po resource ID-u.
   */
  const uniqueResourceIds = [
    ...new Set(
      validResults.map(
        (result) => result.resource
      )
    )
  ];

  const personCache = new Map();

  for (const resourceId of uniqueResourceIds) {
    try {
      const personResponse =
        await getPerson(resourceId, token);

      const personWrapper =
        getFirstItem(personResponse);

      const contractor =
        extractPersonContractor(
          personWrapper
        );

      const orgLevel =
        extractOrgLevel(
          personWrapper
        );

      personCache.set(resourceId, {
        personWrapper,
        contractor,
        orgLevel
      });

      console.log(
        "Resource contractor mapping:",
        {
          resourceId,
          contractor,
          orgLevel
        }
      );
    } catch (error) {
      console.error(
        "Failed to load Person for resource:",
        resourceId,
        error.response?.data ||
          error.message
      );

      personCache.set(resourceId, {
        personWrapper: null,
        contractor: null,
        orgLevel: null
      });
    }
  }

  return validResults.map((result) => {
    const personData =
      personCache.get(result.resource) || {};

    return {
      ...result,
      contractor:
        personData.contractor || null,
      orgLevel:
        personData.orgLevel || null
    };
  });
}

function groupResultsByContractor(
  enrichedResults
) {
  const grouped = {};

  for (const result of enrichedResults) {
    if (!result.contractor) {
      continue;
    }

    if (!grouped[result.contractor]) {
      grouped[result.contractor] = [];
    }

    grouped[result.contractor].push(result);
  }

  /*
   * Sortiramo rezultate svakog contractor-a po:
   * 1. najvećem score-u
   * 2. najranijem startu
   */
  for (const contractor of Object.keys(grouped)) {
    grouped[contractor].sort((a, b) => {
      const scoreA =
        Number(a.score) || 0;

      const scoreB =
        Number(b.score) || 0;

      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }

      return (
        new Date(a.start).getTime() -
        new Date(b.start).getTime()
      );
    });
  }

  return grouped;
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "fsm-score-wrapper",
    allocationCounters
  });
});

/*
 * Test endpoint za reset brojača.
 * Koristi samo tokom testiranja.
 */
app.post("/allocation/reset", (req, res) => {
  const matrixKey =
    req.body?.matrixKey;

  if (matrixKey) {
    allocationCounters[matrixKey] = 0;

    return res.json({
      status: "reset",
      matrixKey,
      counter: 0
    });
  }

  for (const key of Object.keys(allocationCounters)) {
    delete allocationCounters[key];
  }

  return res.json({
    status: "all counters reset",
    allocationCounters
  });
});

app.get("/allocation/status", (req, res) => {
  res.json({
    matrix:
      CONTRACTOR_ALLOCATION_MATRIX,
    sequences:
      CONTRACTOR_ALLOCATION_SEQUENCES,
    counters:
      allocationCounters
  });
});

app.post(
  "/score-with-org-level",
  async (req, res) => {
    try {
      console.log("Received request from FSM.");
      console.log(
        "Incoming body:",
        JSON.stringify(req.body, null, 2)
      );

      const serviceCallId =
        req.body.serviceCallId;

      if (!serviceCallId) {
        return res.status(400).json({
          error:
            "serviceCallId is required"
        });
      }

      const token =
        await getFsmToken();

      const serviceCallResponse =
        await getServiceCall(
          serviceCallId,
          token
        );

      const serviceCallWrapper =
        getFirstItem(
          serviceCallResponse
        );

      const serviceCall =
        unwrapServiceCall(
          serviceCallWrapper
        );

      if (!serviceCall) {
        return res.status(400).json({
          error:
            "ServiceCall not found",
          serviceCallId
        });
      }

      const requirementLookup =
        await getRequirementsForServiceCall(
          serviceCallId,
          token
        );

      const resolvedRequirementSkills =
        await resolveRequirementSkills(
          requirementLookup.response,
          token
        );

      const mandatorySkills =
        resolvedRequirementSkills
          .mandatorySkills;

      if (mandatorySkills.length === 0) {
        return res.status(400).json({
          error:
            "No mandatory skills resolved from Requirement and Tag DTO",
          serviceCallId,
          requirementQueryUsed:
            requirementLookup.queryUsed,
          requirementTagIds:
            resolvedRequirementSkills.tagIds,
          tagLookups:
            resolvedRequirementSkills.tagLookups
        });
      }

      const matrixKey =
        buildSkillMatrixKey(
          mandatorySkills
        );

      console.log(
        "Contractor matrix key:",
        matrixKey
      );

      const optimizationPayload =
        buildOptimizationPayload(
          req.body,
          serviceCall,
          mandatorySkills
        );

      console.log(
        "Generated slots count:",
        optimizationPayload.slots.length
      );

      console.log(
        "Mandatory skills used:",
        mandatorySkills
      );

      const scoreResponse =
        await axios.post(
          OPTIMIZATION_URL,
          optimizationPayload,
          {
            headers:
              fsmHeaders(token)
          }
        );

      const scoreData =
        scoreResponse.data;

      const allResults =
        Array.isArray(scoreData.results)
          ? scoreData.results.filter(
              (item) =>
                item &&
                item.resource &&
                item.start &&
                item.end
            )
          : [];

      const validResults =
        allResults.filter(
          isResultInsideSlot
        );

      if (validResults.length === 0) {
        return res.status(400).json({
          error:
            "No valid optimization results completely inside their slots",
          matrixKey,
          mandatorySkillsUsed:
            mandatorySkills,
          generatedSlotsCount:
            optimizationPayload.slots.length,
          scoreData
        });
      }

      const enrichedResults =
        await enrichOptimizationResultsWithPerson(
          validResults,
          token
        );

      const resultsWithContractor =
        enrichedResults.filter(
          (result) =>
            result.contractor &&
            result.orgLevel
        );

      if (
        resultsWithContractor.length === 0
      ) {
        return res.status(400).json({
          error:
            "Optimization returned resources, but PersonContractor or orgLevel was not found",
          matrixKey,
          mandatorySkillsUsed:
            mandatorySkills,
          resources:
            enrichedResults.map(
              (result) => ({
                resource:
                  result.resource,
                contractor:
                  result.contractor,
                orgLevel:
                  result.orgLevel
              })
            ),
          hint:
            "Check Person DTO response and the exact PersonContractor field/UDF path."
        });
      }

      const groupedByContractor =
        groupResultsByContractor(
          resultsWithContractor
        );

      const availableContractors =
        Object.keys(
          groupedByContractor
        );

      console.log(
        "Available contractors:",
        availableContractors
      );

      const allocation =
        selectContractorBySequence(
          matrixKey,
          availableContractors
        );

      /*
       * Ako nema matrice za kombinaciju skillova,
       * za sada vraćamo grešku.
       */
      if (
        allocation.reason ===
        "MATRIX_NOT_CONFIGURED"
      ) {
        return res.status(400).json({
          error:
            "Contractor allocation matrix is not configured for this skill combination",
          matrixKey,
          mandatorySkillsUsed:
            mandatorySkills,
          availableContractors
        });
      }

      if (
        !allocation.selectedContractor
      ) {
        return res.status(400).json({
          error:
            "No contractor could be selected",
          matrixKey,
          mandatorySkillsUsed:
            mandatorySkills,
          availableContractors,
          allocation
        });
      }

      const selectedContractorResults =
        groupedByContractor[
          allocation.selectedContractor
        ] || [];

      const bestResult =
        selectedContractorResults[0];

      if (!bestResult) {
        return res.status(400).json({
          error:
            "Selected contractor has no optimization result",
          matrixKey,
          selectedContractor:
            allocation.selectedContractor,
          availableContractors,
          allocation
        });
      }

      const alternatives =
        selectedContractorResults
          .slice(1, 6)
          .map((item) => ({
            ...normalizeOptimizationResult(
              item
            ),
            contractor:
              item.contractor,
            orgLevel:
              item.orgLevel
          }));

      const enrichedResponse = {
        results: [
          {
            ...normalizeOptimizationResult(
              bestResult
            ),
            orgLevel:
              bestResult.orgLevel,
            contractor:
              bestResult.contractor,
            requiredSkills:
              mandatorySkills,
            selectionReason:
              allocation.reason
          }
        ],

        alternatives,

        allocation: {
          matrixKey,
          weights:
            allocation.weights,
          sequencePosition:
            allocation.sequencePosition,
          sequenceLength:
            allocation.sequenceLength,
          preferredContractor:
            allocation.preferredContractor,
          selectedContractor:
            allocation.selectedContractor,
          fallbackUsed:
            allocation.fallbackUsed,
          counterBefore:
            allocation.counterBefore,
          counterAfter:
            allocation.counterAfter,
          availableContractors
        },

        generatedSlotsCount:
          optimizationPayload.slots.length,

        mandatorySkillsUsed:
          mandatorySkills,

        requirementQueryUsed:
          requirementLookup.queryUsed,

        requirementTagIds:
          resolvedRequirementSkills.tagIds,

        validResultsCount:
          validResults.length
      };

      console.log(
        "Returning enriched response:",
        JSON.stringify(
          enrichedResponse,
          null,
          2
        )
      );

      return res.json(
        enrichedResponse
      );
    } catch (error) {
      console.error(
        "Wrapper endpoint failed:",
        error.message
      );

      if (error.response) {
        console.error(
          "Response status:",
          error.response.status
        );

        console.error(
          "Response data:",
          JSON.stringify(
            error.response.data,
            null,
            2
          )
        );
      }

      return res.status(500).json({
        error:
          "Wrapper endpoint failed",
        message:
          error.message,
        response:
          error.response?.data ||
          null
      });
    }
  }
);

const host =
  process.env.HOST ||
  "0.0.0.0";

const port =
  Number(PORT);

const server =
  app.listen(
    port,
    host,
    () => {
      console.log(
        `FSM score wrapper running on ${host}:${port}`
      );

      console.log(
        "Health check: /health"
      );
    }
  );

server.on(
  "error",
  (error) => {
    console.error(
      "Server failed to start:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "Unhandled rejection:",
      reason
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);