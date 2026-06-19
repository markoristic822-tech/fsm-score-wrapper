const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
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
  FSM_UNIFIED_PERSON_DTO = "UnifiedPerson.13",
  FSM_SERVICE_CALL_DTO = "ServiceCall.27",
  FSM_TAG_DTO = "Tag.10"
} = process.env;

/*
 * UDF meta ID za polje PersonContractor
 * na UnifiedPerson objektu.
 */
const PERSON_CONTRACTOR_UDF_META_ID =
  "69EBF33B64E94531A4932604E1097E58";

/*
 * Matrica se generise iz matrix.xlsx u allocation-matrix.json.
 * Key je kombinacija skillova koju FSM vrati kroz Requirement/Tag DTO,
 * npr. postal code + tip posla: 10010|FWA.
 */
const ALLOCATION_MATRIX_PATH =
  process.env.ALLOCATION_MATRIX_PATH ||
  path.join(
    __dirname,
    "allocation-matrix.json"
  );

const allocationConfig =
  loadAllocationConfig(
    ALLOCATION_MATRIX_PATH
  );

const CONTRACTOR_ALLOCATION_MATRIX =
  allocationConfig.matrix;

const CONTRACTOR_CODE_ALIASES =
  allocationConfig.contractorCodeMap ||
  {};

/*
 * Sekvence se generisu iz procentualnih odnosa u matrici.
 */
const CONTRACTOR_ALLOCATION_SEQUENCES =
  buildContractorAllocationSequences(
    CONTRACTOR_ALLOCATION_MATRIX
  );

/*
 * Privremeni brojači u memoriji.
 *
 * Posle Render restarta kreću od nule.
 * Za produkciju ćemo ih kasnije prebaciti u bazu.
 */
const allocationCounters = {};

validateEnvironment();

function loadAllocationConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    console.error(
      "Allocation matrix file not found:",
      configPath
    );
    console.error(
      "Run: npm run generate:matrix"
    );
    process.exit(1);
  }

  const rawConfig =
    JSON.parse(
      fs.readFileSync(
        configPath,
        "utf8"
      )
    );

  const matrix =
    rawConfig.matrix || rawConfig;

  if (
    !matrix ||
    typeof matrix !== "object" ||
    Array.isArray(matrix)
  ) {
    console.error(
      "Allocation matrix file has invalid format:",
      configPath
    );
    process.exit(1);
  }

  console.log(
    "Allocation matrix loaded:",
    {
      path: configPath,
      entries:
        Object.keys(matrix).length,
      generatedAt:
        rawConfig.generatedAt ||
        null,
      warnings:
        rawConfig.warnings?.length ||
        0
    }
  );

  return {
    ...rawConfig,
    matrix
  };
}

function createSmoothWeightedSequence(weights) {
  const entries = Object.entries(weights)
    .map(([contractor, weight]) => ({
      contractor,
      weight: Number(weight) || 0,
      current: 0
    }))
    .filter((entry) => entry.weight > 0);

  if (entries.length === 0) {
    return [];
  }

  if (entries.length === 1) {
    return [
      entries[0].contractor
    ];
  }

  const totalWeight = entries.reduce(
    (sum, entry) =>
      sum + entry.weight,
    0
  );

  const sequenceLength = 100;
  const sequence = [];

  for (
    let index = 0;
    index < sequenceLength;
    index++
  ) {
    for (const entry of entries) {
      entry.current +=
        entry.weight;
    }

    entries.sort(
      (first, second) =>
        second.current -
        first.current
    );

    const selected = entries[0];
    sequence.push(
      selected.contractor
    );

    selected.current -=
      totalWeight;
  }

  return sequence;
}

function buildContractorAllocationSequences(matrix) {
  return Object.fromEntries(
    Object.entries(matrix).map(
      ([matrixKey, weights]) => [
        matrixKey,
        createSmoothWeightedSequence(
          weights
        )
      ]
    )
  );
}

function validateEnvironment() {
  const missing = [];

  const requiredValues = {
    FSM_BASE_URL,
    FSM_CLIENT_ID,
    FSM_CLIENT_SECRET,
    FSM_ACCOUNT_ID,
    FSM_ACCOUNT_NAME,
    FSM_COMPANY_ID,
    FSM_COMPANY_NAME,
    OPTIMIZATION_URL
  };

  for (const [key, value] of Object.entries(requiredValues)) {
    if (!value) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.error("Missing required environment values:", missing);
    process.exit(1);
  }

  console.log("Environment configuration loaded.");
  console.log({
    FSM_REQUIREMENT_DTO,
    FSM_PERSON_DTO,
    FSM_UNIFIED_PERSON_DTO,
    FSM_SERVICE_CALL_DTO,
    FSM_TAG_DTO
  });
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

function fsmServiceUrl(pathname) {
  return `${FSM_BASE_URL.replace(/\/+$/, "")}${pathname}`;
}

function fsmIdToUuid(fsmId) {
  if (!fsmId) {
    return null;
  }

  const normalized = String(fsmId)
    .trim()
    .replace(/-/g, "")
    .toLowerCase();

  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    return null;
  }

  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20)
  ].join("-");
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

async function getUnifiedPerson(resourceId, token) {
  console.log("Getting UnifiedPerson for resource:", resourceId);

  const url = dataApiUrl(
    "UnifiedPerson",
    FSM_UNIFIED_PERSON_DTO,
    `id="${resourceId}"`
  );

  const response = await axios.get(url, {
    headers: fsmHeaders(token)
  });

  return response.data;
}

async function getOrgLevelName(orgLevelId, token) {
  const orgLevelUuid = fsmIdToUuid(orgLevelId);

  if (!orgLevelUuid) {
    console.log(
      "OrgLevel ID cannot be converted to UUID:",
      orgLevelId
    );

    return null;
  }

  try {
    console.log(
      "Getting OrgLevel name:",
      orgLevelUuid
    );

    const response = await axios.get(
      fsmServiceUrl(
        `/cloud-org-level-service/api/v1/levels/${orgLevelUuid}`
      ),
      {
        headers: fsmHeaders(token)
      }
    );

    const name =
      response.data?.level?.name;

    return typeof name === "string" &&
      name.trim()
      ? name
      : null;
  } catch (error) {
    console.error(
      "Failed to load OrgLevel name:",
      orgLevelId,
      error.response?.data ||
        error.message
    );

    return null;
  }
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

      const responseData = response.data;

      const rows = Array.isArray(responseData?.data)
        ? responseData.data
        : [];

      console.log(
        "Requirement query result count:",
        rows.length
      );

      if (rows.length > 0) {
        console.log(
          "Requirement response:",
          JSON.stringify(responseData, null, 2)
        );

        return {
          response: responseData,
          queryUsed: query,
          errors
        };
      }
    } catch (error) {
      const errorData =
        error.response?.data ||
        error.message;

      errors.push({
        query,
        status: error.response?.status || null,
        data: errorData
      });

      console.log(
        "Requirement query failed:",
        query,
        JSON.stringify(errorData)
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

async function getTag(tagId, token) {
  console.log("Getting Tag:", tagId);

  const queriesToTry = [
    `id="${tagId}"`,
    `externalId="${tagId}"`,
    `name="${tagId}"`
  ];

  const errors = [];

  for (const query of queriesToTry) {
    const url = dataApiUrl(
      "Tag",
      FSM_TAG_DTO,
      query
    );

    try {
      console.log("Trying Tag query:", query);

      const response = await axios.get(url, {
        headers: fsmHeaders(token)
      });

      const responseData = response.data;

      const rows = Array.isArray(responseData?.data)
        ? responseData.data
        : [];

      console.log("Tag query result count:", rows.length);

      if (rows.length > 0) {
        console.log(
          "Tag response:",
          JSON.stringify(responseData, null, 2)
        );

        return {
          response: responseData,
          queryUsed: query,
          errors
        };
      }
    } catch (error) {
      const errorData =
        error.response?.data ||
        error.message;

      errors.push({
        query,
        status: error.response?.status || null,
        data: errorData
      });

      console.log(
        "Tag query failed:",
        query,
        JSON.stringify(errorData)
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

function getFirstItem(response) {
  if (Array.isArray(response)) {
    return response[0] || null;
  }

  if (Array.isArray(response?.data)) {
    return response.data[0] || null;
  }

  if (Array.isArray(response?.items)) {
    return response.items[0] || null;
  }

  if (Array.isArray(response?.values)) {
    return response.values[0] || null;
  }

  if (Array.isArray(response?.records)) {
    return response.records[0] || null;
  }

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
    wrapper
  );
}

function unwrapUnifiedPerson(wrapper) {
  if (!wrapper) return null;

  return (
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

function addStringIfValid(values, value) {
  if (typeof value !== "string") {
    return;
  }

  const cleaned = value.trim();

  if (cleaned) {
    values.push(cleaned);
  }
}

function normalizeContractorCode(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  const aliases = {
    ICOM: "ICOM",
    ICOM_DOO: "ICOM",

    SATPRAXIS: "SAT_PRAXIS",
    SAT_PRAXIS: "SAT_PRAXIS",
    SAT_PRAXIS_DOO: "SAT_PRAXIS"
  };

  for (
    const [name, code] of
    Object.entries(CONTRACTOR_CODE_ALIASES)
  ) {
    const normalizedName = String(name)
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_")
      .replace(/-/g, "_");

    const normalizedCode = String(code)
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_")
      .replace(/-/g, "_");

    aliases[normalizedName] =
      normalizedCode;
    aliases[normalizedCode] =
      normalizedCode;
  }

  return aliases[normalized] || normalized;
}

function normalizeMetaId(meta) {
  if (!meta) {
    return null;
  }

  if (typeof meta === "string") {
    return meta;
  }

  if (typeof meta === "object") {
    return (
      meta.id ||
      meta.refId ||
      meta.objectId ||
      meta.externalId ||
      null
    );
  }

  return null;
}

function extractPersonContractor(unifiedPersonWrapper) {
  const unifiedPerson =
    unwrapUnifiedPerson(unifiedPersonWrapper);

  if (!unifiedPerson) {
    return null;
  }

  const udfValues = unifiedPerson.udfValues;

  if (!Array.isArray(udfValues)) {
    console.log(
      "UnifiedPerson udfValues is not an array:",
      udfValues
    );

    return null;
  }

  for (const udf of udfValues) {
    if (!udf || typeof udf !== "object") {
      continue;
    }

    const metaId =
      normalizeMetaId(
        udf.meta ||
        udf.key ||
        udf.metaId ||
        udf.udfMeta
      );

    if (metaId !== PERSON_CONTRACTOR_UDF_META_ID) {
      continue;
    }

    const value =
      udf.value ??
      udf.stringValue ??
      udf.textValue ??
      udf.displayValue ??
      null;

    if (
      typeof value === "string" &&
      value.trim()
    ) {
      return normalizeContractorCode(value);
    }
  }

  return null;
}

function normalizeOrgLevel(orgLevel) {
  if (!orgLevel) {
    return null;
  }

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

  if (!person) {
    return null;
  }

  const rawOrgLevel =
    person.orgLevel ||
    person.orgLevelId ||
    person.orgLevelIds?.[0] ||
    person.orgLevels?.[0] ||
    person.organizationLevel ||
    person.organizationLevelId ||
    person.organizationLevelIds?.[0] ||
    null;

  return normalizeOrgLevel(rawOrgLevel);
}

function extractDurationFromServiceCall(serviceCall) {
  if (!serviceCall) {
    return null;
  }

  const value =
    serviceCall.durationInMinutes ||
    serviceCall.durationMinutes ||
    serviceCall.plannedDurationInMinutes ||
    serviceCall.duration ||
    null;

  const numericValue = Number(value);

  if (
    !Number.isFinite(numericValue) ||
    numericValue <= 0
  ) {
    return null;
  }

  return numericValue;
}

function extractLocationFromServiceCall(serviceCall) {
  if (!serviceCall) {
    return null;
  }

  const address = serviceCall.address || {};

  const latitude =
    serviceCall.latitude ??
    serviceCall.lat ??
    serviceCall.location?.latitude ??
    serviceCall.location?.lat ??
    address.latitude ??
    address.lat ??
    address.location?.latitude ??
    address.location?.lat ??
    address.geoLatitude ??
    null;

  const longitude =
    serviceCall.longitude ??
    serviceCall.lng ??
    serviceCall.lon ??
    serviceCall.location?.longitude ??
    serviceCall.location?.lng ??
    serviceCall.location?.lon ??
    address.longitude ??
    address.lng ??
    address.lon ??
    address.location?.longitude ??
    address.location?.lng ??
    address.location?.lon ??
    address.geoLongitude ??
    null;

  const numericLatitude = Number(latitude);
  const numericLongitude = Number(longitude);

  if (
    !Number.isFinite(numericLatitude) ||
    !Number.isFinite(numericLongitude)
  ) {
    return null;
  }

  return {
    latitude: numericLatitude,
    longitude: numericLongitude
  };
}

function extractRequirementTagIds(requirementResponse) {
  const rows = Array.isArray(requirementResponse?.data)
    ? requirementResponse.data
    : [];

  const tagIds = [];

  for (const row of rows) {
    const requirement = unwrapRequirement(row);

    if (!requirement) {
      continue;
    }

    if (requirement.inactive === true) {
      continue;
    }

    if (requirement.mandatory === false) {
      continue;
    }

    addStringIfValid(
      tagIds,
      requirement.tag
    );
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
    /*
     * externalId ima prioritet za integraciju.
     */
    addStringIfValid(
      skills,
      tag.externalId
    );

    /*
     * Ako externalId nije popunjen, koristi name.
     */
    if (skills.length === 0) {
      addStringIfValid(
        skills,
        tag.name
      );
    }

    /*
     * Poslednji fallback je interni Tag ID.
     */
    if (skills.length === 0) {
      addStringIfValid(
        skills,
        tag.id
      );
    }
  }

  if (skills.length === 0) {
    addStringIfValid(
      skills,
      fallbackTagId
    );
  }

  return [...new Set(skills)];
}

async function resolveRequirementSkills(
  requirementResponse,
  token
) {
  const tagIds =
    extractRequirementTagIds(
      requirementResponse
    );

  console.log("Requirement Tag IDs:", tagIds);

  const mandatorySkills = [];
  const tagLookups = [];

  for (const tagId of tagIds) {
    const tagLookup =
      await getTag(tagId, token);

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

    mandatorySkills.push(
      ...skillsFromTag
    );
  }

  return {
    mandatorySkills: [
      ...new Set(mandatorySkills)
    ],
    tagIds,
    tagLookups
  };
}

function buildSkillMatrixKey(skills) {
  return [
    ...new Set(
      skills
        .map((skill) => String(skill).trim())
        .filter(Boolean)
    )
  ]
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
    .plus({
      minutes: startBufferMinutes
    });

  const slots = [];

  for (
    let dayOffset = 0;
    dayOffset < daysAhead;
    dayOffset++
  ) {
    const day = now.plus({
      days: dayOffset
    });

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

    if (
      dayOffset === 0 &&
      now > dayStart
    ) {
      dayStart = now;
    }

    const remainder =
      dayStart.minute %
      slotDurationMinutes;

    if (
      remainder !== 0 ||
      dayStart.second !== 0 ||
      dayStart.millisecond !== 0
    ) {
      const minutesToAdd =
        remainder === 0
          ? slotDurationMinutes
          : slotDurationMinutes - remainder;

      dayStart = dayStart
        .plus({
          minutes: minutesToAdd
        })
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

    while (
      slotStart.plus({
        minutes: slotDurationMinutes
      }) <= dayEnd
    ) {
      const slotEnd =
        slotStart.plus({
          minutes: slotDurationMinutes
        });

      slots.push({
        start: slotStart
          .toUTC()
          .toISO(),
        end: slotEnd
          .toUTC()
          .toISO()
      });

      slotStart = slotEnd;
    }
  }

  return slots;
}

function buildOptimizationPayload(
  requestBody,
  serviceCall,
  mandatorySkills
) {
  const fallbackJob =
    requestBody.job || {};

  const durationMinutes =
    extractDurationFromServiceCall(serviceCall) ||
    Number(fallbackJob.durationMinutes) ||
    Number(fallbackJob.durationInMinutes) ||
    60;

  const location =
    extractLocationFromServiceCall(serviceCall) ||
    fallbackJob.location ||
    {
      latitude: 38.0344,
      longitude: 23.1283
    };

  const requestedOptions =
    requestBody.options || {};

  const requestedMaxResultsPerSlot =
    Number(
      requestedOptions.maxResultsPerSlot
    );

  const requestedDrivingTimeMinutes =
    Number(
      requestedOptions.defaultDrivingTimeMinutes
    );

  return {
    job: {
      durationMinutes,
      location,
      mandatorySkills
    },

    resources:
      requestBody.resources || {
        filters: {
          includeInternalPersons: true,
          includeCrowdPersons: false,
          includeMandatorySkills:
            mandatorySkills.length > 0
        }
      },

    slots: generateRollingSlots(),

    options: {
      ...requestedOptions,
        /*
         * Treba više rezultata po slotu,
         * kako bismo dobili resurse iz više contractor-a.
         */
        maxResultsPerSlot:
          Number.isFinite(
            requestedMaxResultsPerSlot
          )
            ? Math.max(
                requestedMaxResultsPerSlot,
                10
              )
            : 10,
        defaultDrivingTimeMinutes:
          Number.isFinite(
            requestedDrivingTimeMinutes
          )
            ? requestedDrivingTimeMinutes
            : 30
      },

    policy:
      requestBody.policy ||
      "DistanceAndSkills"
  };
}

function isResultInsideSlot(result) {
  if (
    !result?.start ||
    !result?.end ||
    !result?.slot?.start ||
    !result?.slot?.end
  ) {
    return false;
  }

  const resultStart =
    DateTime.fromISO(result.start, {
      setZone: true
    });

  const resultEnd =
    DateTime.fromISO(result.end, {
      setZone: true
    });

  const slotStart =
    DateTime.fromISO(result.slot.start, {
      setZone: true
    });

  const slotEnd =
    DateTime.fromISO(result.slot.end, {
      setZone: true
    });

  if (
    !resultStart.isValid ||
    !resultEnd.isValid ||
    !slotStart.isValid ||
    !slotEnd.isValid
  ) {
    return false;
  }

  return (
    resultStart.toMillis() >=
      slotStart.toMillis() &&
    resultEnd.toMillis() <=
      slotEnd.toMillis()
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

function summarizeResultsByResource(results) {
  const summary = new Map();

  for (const result of results) {
    if (!result?.resource) {
      continue;
    }

    const current =
      summary.get(result.resource) || {
        resource: result.resource,
        count: 0,
        bestScore: null,
        firstStart: null
      };

    const score = Number(result.score);

    current.count += 1;
    current.bestScore =
      Number.isFinite(score)
        ? Math.max(
            current.bestScore ?? score,
            score
          )
        : current.bestScore;
    current.firstStart =
      !current.firstStart ||
      new Date(result.start).getTime() <
        new Date(current.firstStart).getTime()
        ? result.start
        : current.firstStart;

    summary.set(
      result.resource,
      current
    );
  }

  return [...summary.values()].sort(
    (first, second) =>
      second.count - first.count
  );
}

async function enrichOptimizationResultsWithPersonData(
  validResults,
  token
) {
  const uniqueResourceIds = [
    ...new Set(
      validResults.map(
        (result) => result.resource
      )
    )
  ];

  console.log(
    "Unique resources returned by Optimization:",
    uniqueResourceIds
  );

  const personDataCache = new Map();

  for (const resourceId of uniqueResourceIds) {
    try {
      /*
       * Person koristimo za orgLevel.
       */
      const personResponse =
        await getPerson(
          resourceId,
          token
        );

      const personWrapper =
        getFirstItem(personResponse);

      const orgLevel =
        extractOrgLevel(
          personWrapper
        );

      /*
       * UnifiedPerson koristimo za PersonContractor UDF.
       */
      const unifiedPersonResponse =
        await getUnifiedPerson(
          resourceId,
          token
        );

      console.log(
        "UnifiedPerson response for contractor lookup:",
        JSON.stringify(
          unifiedPersonResponse,
          null,
          2
        )
      );

      const unifiedPersonWrapper =
        getFirstItem(
          unifiedPersonResponse
        );

      const contractor =
        extractPersonContractor(
          unifiedPersonWrapper
        );

      personDataCache.set(
        resourceId,
        {
          orgLevel,
          contractor
        }
      );

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
        "Failed to load Person/UnifiedPerson for resource:",
        resourceId,
        error.response?.data ||
          error.message
      );

      personDataCache.set(
        resourceId,
        {
          orgLevel: null,
          contractor: null
        }
      );
    }
  }

  const orgLevelNameCache = new Map();
  const uniqueOrgLevelIds = [
    ...new Set(
      [...personDataCache.values()]
        .map(
          (personData) =>
            personData.orgLevel
        )
        .filter(Boolean)
    )
  ];

  for (const orgLevelId of uniqueOrgLevelIds) {
    const orgLevelName =
      await getOrgLevelName(
        orgLevelId,
        token
      );

    orgLevelNameCache.set(
      orgLevelId,
      orgLevelName
    );
  }

  return validResults.map((result) => {
    const personData =
      personDataCache.get(
        result.resource
      ) || {};

    const orgLevel =
      personData.orgLevel ||
      null;

    return {
      ...result,
      orgLevel,
      orgLevelName:
        orgLevelNameCache.get(
          orgLevel
        ) ?? null,
      contractor:
        personData.contractor ||
        null
    };
  });
}

function groupResultsByContractor(enrichedResults) {
  const grouped = {};

  for (const result of enrichedResults) {
    if (
      !result.contractor ||
      !result.orgLevel
    ) {
      continue;
    }

    if (!grouped[result.contractor]) {
      grouped[result.contractor] = [];
    }

    grouped[result.contractor].push(
      result
    );
  }

  for (const contractor of Object.keys(grouped)) {
    grouped[contractor].sort(
      (first, second) => {
        const firstScore =
          Number(first.score) || 0;

        const secondScore =
          Number(second.score) || 0;

        /*
         * Veći score ima prioritet.
         */
        if (
          secondScore !== firstScore
        ) {
          return (
            secondScore -
            firstScore
          );
        }

        /*
         * Kod istog score-a uzimamo raniji termin.
         */
        return (
          new Date(first.start).getTime() -
          new Date(second.start).getTime()
        );
      }
    );
  }

  return grouped;
}

function selectContractorBySequence(
  matrixKey,
  availableContractors
) {
  const matrix =
    CONTRACTOR_ALLOCATION_MATRIX[
      matrixKey
    ];

  const sequence =
    CONTRACTOR_ALLOCATION_SEQUENCES[
      matrixKey
    ];

  if (!matrix || !sequence) {
    return {
      selectedContractor: null,
      preferredContractor: null,
      fallbackUsed: false,
      reason: "MATRIX_NOT_CONFIGURED",
      weights: matrix || null,
      counterBefore: null,
      counterAfter: null,
      sequencePosition: null,
      sequenceLength:
        sequence?.length || null
    };
  }

  const allowedContractors =
    Object.keys(matrix);

  const allowedContractorSet =
    new Set(allowedContractors);

  const matrixEligibleContractors =
    availableContractors.filter(
      (contractor) =>
        allowedContractorSet.has(
          contractor
        )
    );

  const rejectedByMatrixContractors =
    availableContractors.filter(
      (contractor) =>
        !allowedContractorSet.has(
          contractor
        )
    );

  const counterBefore =
    allocationCounters[matrixKey] ||
    0;

  const sequencePosition =
    counterBefore %
    sequence.length;

  const preferredContractor =
    sequence[sequencePosition];

  let selectedContractor = null;
  let fallbackUsed = false;
  let reason = null;

  if (
    matrixEligibleContractors.includes(
      preferredContractor
    )
  ) {
    selectedContractor =
      preferredContractor;

    reason =
      "QUOTA_SEQUENCE";
  } else if (
    matrixEligibleContractors.length > 0
  ) {
    /*
     * Ako preferirani contractor trenutno nema
     * validnog resursa, biramo dostupnog contractor-a
     * sa najboljim rezultatom, ali samo ako je
     * dozvoljen matricom za ovaj key.
     */
    selectedContractor =
      matrixEligibleContractors[0];

    fallbackUsed = true;

    reason =
      "QUOTA_FALLBACK_PREFERRED_CONTRACTOR_UNAVAILABLE";
  } else {
    reason =
      "NO_MATRIX_ELIGIBLE_CONTRACTOR_AVAILABLE";
  }

  /*
   * Brojač se povećava samo kada je contractor stvarno izabran.
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
    weights: matrix,
    allowedContractors,
    matrixEligibleContractors,
    rejectedByMatrixContractors,
    counterBefore,
    counterAfter:
      allocationCounters[matrixKey] ??
      counterBefore,
    sequencePosition,
    sequenceLength:
      sequence.length
  };
}

/*
 * Sortira dostupne contractore prema njihovom
 * najboljem Optimization rezultatu.
 *
 * Ovo se koristi samo za fallback.
 */
function sortAvailableContractors(
  groupedByContractor
) {
  return Object.keys(
    groupedByContractor
  ).sort((first, second) => {
    const firstBest =
      groupedByContractor[first]?.[0];

    const secondBest =
      groupedByContractor[second]?.[0];

    const firstScore =
      Number(firstBest?.score) || 0;

    const secondScore =
      Number(secondBest?.score) || 0;

    if (
      secondScore !== firstScore
    ) {
      return (
        secondScore -
        firstScore
      );
    }

    return (
      new Date(
        firstBest?.start || 0
      ).getTime() -
      new Date(
        secondBest?.start || 0
      ).getTime()
    );
  });
}

app.get("/health", (request, response) => {
  response.json({
    status: "ok",
    service: "fsm-score-wrapper",
    allocationCounters
  });
});

app.get(
  "/allocation/status",
  (request, response) => {
    response.json({
      matrix:
        CONTRACTOR_ALLOCATION_MATRIX,
      sequences:
        CONTRACTOR_ALLOCATION_SEQUENCES,
      counters:
        allocationCounters
    });
  }
);

app.post(
  "/allocation/reset",
  (request, response) => {
    const matrixKey =
      request.body?.matrixKey;

    if (matrixKey) {
      allocationCounters[matrixKey] = 0;

      return response.json({
        status: "reset",
        matrixKey,
        counter: 0
      });
    }

    for (
      const key of
      Object.keys(allocationCounters)
    ) {
      delete allocationCounters[key];
    }

    return response.json({
      status: "all counters reset",
      counters: allocationCounters
    });
  }
);

app.post(
  "/score-with-org-level",
  async (request, response) => {
    try {
      console.log(
        "Received request from FSM."
      );

      console.log(
        "Incoming body:",
        JSON.stringify(
          request.body,
          null,
          2
        )
      );

      const serviceCallId =
        request.body?.serviceCallId;

      if (!serviceCallId) {
        return response.status(400).json({
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
        return response.status(400).json({
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

      if (
        mandatorySkills.length === 0
      ) {
        return response.status(400).json({
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

      if (
        !CONTRACTOR_ALLOCATION_MATRIX[
          matrixKey
        ]
      ) {
        return response.status(400).json({
          error:
            "Contractor allocation matrix is not configured for this skill combination",
          matrixKey,
          mandatorySkills
        });
      }

      const optimizationPayload =
        buildOptimizationPayload(
          request.body,
          serviceCall,
          mandatorySkills
        );

      console.log(
        "Generated slots count:",
        optimizationPayload
          .slots.length
      );

      console.log(
        "Mandatory skills used:",
        mandatorySkills
      );

      console.log(
        "Optimization request summary:",
        JSON.stringify(
          {
            job:
              optimizationPayload.job,
            resources:
              optimizationPayload.resources,
            options:
              optimizationPayload.options,
            policy:
              optimizationPayload.policy,
            slotsCount:
              optimizationPayload
                .slots.length,
            firstSlot:
              optimizationPayload
                .slots[0] || null,
            lastSlot:
              optimizationPayload
                .slots[
                  optimizationPayload
                    .slots.length - 1
                ] || null
          },
          null,
          2
        )
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
        Array.isArray(
          scoreData.results
        )
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

      const rejectedResults =
        allResults.filter(
          (item) =>
            !isResultInsideSlot(item)
        );

      const allResourceDistribution =
        summarizeResultsByResource(
          allResults
        );

      const validResourceDistribution =
        summarizeResultsByResource(
          validResults
        );

      console.log(
        "Optimization result counts:",
        {
          total:
            allResults.length,
          valid:
            validResults.length,
          rejectedOutsideSlot:
            rejectedResults.length
        }
      );

      console.log(
        "Optimization resource distribution:",
        {
          all:
            allResourceDistribution,
          valid:
            validResourceDistribution
        }
      );

      if (
        validResults.length === 0
      ) {
        return response.status(400).json({
          error:
            "No valid optimization results completely inside their slots",
          matrixKey,
          mandatorySkillsUsed:
            mandatorySkills,
          generatedSlotsCount:
            optimizationPayload
              .slots.length,
          allResourceDistribution,
          validResourceDistribution,
          scoreData
        });
      }

      const enrichedResults =
        await enrichOptimizationResultsWithPersonData(
          validResults,
          token
        );

      const resourcesWithoutContractor =
        [
          ...new Map(
            enrichedResults
              .filter(
                (result) =>
                  !result.contractor
              )
              .map((result) => [
                result.resource,
                {
                  resource:
                    result.resource,
                  contractor:
                    result.contractor,
                  orgLevel:
                    result.orgLevel
                }
              ])
          ).values()
        ];

      if (
        resourcesWithoutContractor.length >
        0
      ) {
        console.log(
          "Resources without PersonContractor:",
          resourcesWithoutContractor
        );
      }

      const groupedByContractor =
        groupResultsByContractor(
          enrichedResults
        );

      const availableContractors =
        sortAvailableContractors(
          groupedByContractor
        );

      console.log(
        "Available contractors:",
        availableContractors
      );

      if (
        availableContractors.length === 0
      ) {
        return response.status(400).json({
          error:
            "Optimization returned resources, but no resource has both PersonContractor and orgLevel",
          matrixKey,
          mandatorySkillsUsed:
            mandatorySkills,
          resources:
            [
              ...new Map(
                enrichedResults.map(
                  (result) => [
                    result.resource,
                    {
                      resource:
                        result.resource,
                      contractor:
                        result.contractor,
                      orgLevel:
                        result.orgLevel
                    }
                  ]
                )
              ).values()
            ],
          hint:
            "PersonContractor must exist on UnifiedPerson.13 in the configured UDF meta ID."
        });
      }

      const allocation =
        selectContractorBySequence(
          matrixKey,
          availableContractors
        );

      if (
        allocation.reason ===
        "MATRIX_NOT_CONFIGURED"
      ) {
        return response.status(400).json({
          error:
            "Contractor allocation sequence is not configured",
          matrixKey,
          mandatorySkillsUsed:
            mandatorySkills,
          availableContractors
        });
      }

      if (
        !allocation.selectedContractor
      ) {
        return response.status(400).json({
          error:
            "No contractor could be selected",
          matrixKey,
          mandatorySkillsUsed:
            mandatorySkills,
          availableContractors,
          matrixEligibleContractors:
            allocation.matrixEligibleContractors,
          rejectedByMatrixContractors:
            allocation.rejectedByMatrixContractors,
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
        return response.status(400).json({
          error:
            "Selected contractor has no valid optimization result",
          selectedContractor:
            allocation.selectedContractor,
          matrixKey,
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
            orgLevelName:
              bestResult.orgLevelName ??
              null,
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
          availableContractors:
            allocation.matrixEligibleContractors,
          allAvailableContractors:
            availableContractors,
          rejectedByMatrixContractors:
            allocation.rejectedByMatrixContractors
        },

        generatedSlotsCount:
          optimizationPayload
            .slots.length,

        mandatorySkillsUsed:
          mandatorySkills,

        requirementQueryUsed:
          requirementLookup
            .queryUsed,

        requirementTagIds:
          resolvedRequirementSkills
            .tagIds,

        totalOptimizationResults:
          allResults.length,

        validResultsCount:
          validResults.length,

        rejectedOutsideSlotCount:
          rejectedResults.length,

        allResourceDistribution,

        validResourceDistribution
      };

      console.log(
        "Returning enriched response:",
        JSON.stringify(
          enrichedResponse,
          null,
          2
        )
      );

      return response.json(
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

      const responseStatus =
        error.response?.status &&
        error.response.status >= 400 &&
        error.response.status < 500
          ? error.response.status
          : 500;

      return response.status(responseStatus).json({
        error:
          "Wrapper endpoint failed",
        message:
          error.message,
        upstreamStatus:
          error.response?.status ||
          null,
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

const port = Number(PORT);

const server = app.listen(
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
