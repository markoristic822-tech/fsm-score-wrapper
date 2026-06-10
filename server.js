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
  FSM_SKILL_DTO = "Skill.10"
} = process.env;

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
  console.error("Missing required .env values.");
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
    FSM_SKILL_DTO
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

function generateRollingSlots() {
  const timezone = "Europe/Athens";
  const daysAhead = 7;
  const workingDayStart = "08:00";
  const workingDayEnd = "18:00";
  const startBufferMinutes = 5;
  const slotDurationMinutes = 30;
  const slotStepMinutes = 30;

  const now = DateTime.now()
    .setZone(timezone)
    .plus({ minutes: startBufferMinutes });

  const [startHour, startMinute] = workingDayStart.split(":").map(Number);
  const [endHour, endMinute] = workingDayEnd.split(":").map(Number);

  const slots = [];

  for (let i = 0; i < daysAhead; i++) {
    const day = now.plus({ days: i });

    let dayStart = day.set({
      hour: startHour,
      minute: startMinute,
      second: 0,
      millisecond: 0
    });

    const dayEnd = day.set({
      hour: endHour,
      minute: endMinute,
      second: 0,
      millisecond: 0
    });

    if (i === 0 && now > dayStart) {
      dayStart = now;
    }

    const minute = dayStart.minute;

    if (minute > 0 && minute <= 30) {
      dayStart = dayStart.set({
        minute: 30,
        second: 0,
        millisecond: 0
      });
    } else if (minute > 30) {
      dayStart = dayStart.plus({ hours: 1 }).set({
        minute: 0,
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
      const slotEnd = slotStart.plus({ minutes: slotDurationMinutes });

      slots.push({
        start: slotStart.toUTC().toISO(),
        end: slotEnd.toUTC().toISO()
      });

      slotStart = slotStart.plus({ minutes: slotStepMinutes });
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

async function getSkill(skillId, token) {
  console.log("Getting Skill:", skillId);

  const queriesToTry = [
    `id="${skillId}"`,
    `externalId="${skillId}"`,
    `code="${skillId}"`,
    `name="${skillId}"`
  ];

  const errors = [];

  for (const query of queriesToTry) {
    const url = dataApiUrl("Skill", FSM_SKILL_DTO, query);

    try {
      console.log("Trying Skill query:", query);

      const response = await axios.get(url, {
        headers: fsmHeaders(token)
      });

      const data = response.data;
      const rows = Array.isArray(data?.data) ? data.data : [];

      console.log("Skill query result count:", rows.length);
      console.log("Skill response:", JSON.stringify(data, null, 2));

      if (rows.length > 0) {
        return {
          response: data,
          queryUsed: query
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
        "Skill query failed:",
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
  console.log("Getting Requirements for ServiceCall:", serviceCallId);

  const queriesToTry = [
    `object.objectId="${serviceCallId}"`,
    `object.objectId="${serviceCallId}" AND object.objectType="SERVICECALL"`,
    `object.objectId="${serviceCallId}" and object.objectType="SERVICECALL"`
  ];

  const errors = [];
  const emptyResponses = [];

  for (const query of queriesToTry) {
    const url = dataApiUrl("Requirement", FSM_REQUIREMENT_DTO, query);

    try {
      console.log("Trying Requirement query:", query);

      const response = await axios.get(url, {
        headers: fsmHeaders(token)
      });

      const data = response.data;
      const rows = Array.isArray(data?.data) ? data.data : [];

      console.log("Requirement query result count:", rows.length);
      console.log("Requirement response:", JSON.stringify(data, null, 2));

      if (rows.length > 0) {
        return {
          response: data,
          queryUsed: query
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

function unwrapServiceCall(serviceCallWrapper) {
  if (!serviceCallWrapper) return null;

  return (
    serviceCallWrapper.serviceCall ||
    serviceCallWrapper.ServiceCall ||
    serviceCallWrapper
  );
}

function unwrapPerson(personWrapper) {
  if (!personWrapper) return null;

  return (
    personWrapper.person ||
    personWrapper.Person ||
    personWrapper.unifiedPerson ||
    personWrapper.UnifiedPerson ||
    personWrapper
  );
}

function unwrapRequirement(requirementWrapper) {
  if (!requirementWrapper) return null;

  return (
    requirementWrapper.requirement ||
    requirementWrapper.Requirement ||
    requirementWrapper
  );
}

function unwrapSkill(skillWrapper) {
  if (!skillWrapper) return null;

  return (
    skillWrapper.skill ||
    skillWrapper.Skill ||
    skillWrapper.tag ||
    skillWrapper.Tag ||
    skillWrapper
  );
}

function normalizeOrgLevel(orgLevel) {
  if (!orgLevel) return null;

  if (typeof orgLevel === "string") {
    return orgLevel;
  }

  if (typeof orgLevel === "object") {
    return orgLevel.id || orgLevel.objectId || orgLevel.externalId || null;
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

  if (!latitude || !longitude) {
    return null;
  }

  return {
    latitude: Number(latitude),
    longitude: Number(longitude)
  };
}

function addSkillIfValid(skills, value) {
  if (!value) return;

  if (typeof value !== "string") return;

  const cleaned = value.trim();

  if (!cleaned) return;

  skills.push(cleaned);
}

function extractRequirementSkillIds(requirementResponse) {
  const rows = Array.isArray(requirementResponse?.data)
    ? requirementResponse.data
    : [];

  const skillIds = [];

  for (const row of rows) {
    const requirement = unwrapRequirement(row);

    if (!requirement) continue;

    if (requirement.mandatory === false) {
      continue;
    }

    // Kod tebe Requirement.tag pokazuje na Skill DTO
    addSkillIfValid(skillIds, requirement.tag);

    if (requirement.skill && typeof requirement.skill === "string") {
      addSkillIfValid(skillIds, requirement.skill);
    }

    if (requirement.skill && typeof requirement.skill === "object") {
      addSkillIfValid(skillIds, requirement.skill.id);
      addSkillIfValid(skillIds, requirement.skill.refId);
      addSkillIfValid(skillIds, requirement.skill.code);
      addSkillIfValid(skillIds, requirement.skill.name);
      addSkillIfValid(skillIds, requirement.skill.externalId);
    }

    addSkillIfValid(skillIds, requirement.skillId);
    addSkillIfValid(skillIds, requirement.skillCode);
    addSkillIfValid(skillIds, requirement.skillName);
    addSkillIfValid(skillIds, requirement.mandatorySkillId);
    addSkillIfValid(skillIds, requirement.requiredSkillId);
  }

  return [...new Set(skillIds.filter(Boolean))];
}

function extractSkillsFromSkillResponse(skillResponse, fallbackSkillId) {
  const skillWrapper = getFirstItem(skillResponse);
  const skill = unwrapSkill(skillWrapper);

  const skills = [];

  if (skill) {
    addSkillIfValid(skills, skill.code);
    addSkillIfValid(skills, skill.name);
    addSkillIfValid(skills, skill.externalId);
    addSkillIfValid(skills, skill.refId);

    // id koristimo samo ako nema boljeg identifikatora
    if (skills.length === 0) {
      addSkillIfValid(skills, skill.id);
    }
  }

  if (skills.length === 0) {
    addSkillIfValid(skills, fallbackSkillId);
  }

  return [...new Set(skills.filter(Boolean))];
}

async function resolveRequirementSkills(requirementResponse, token) {
  const skillIds = extractRequirementSkillIds(requirementResponse);

  console.log("Requirement Skill IDs:", skillIds);

  const resolvedSkills = [];
  const skillLookups = [];

  for (const skillId of skillIds) {
    try {
      const skillLookup = await getSkill(skillId, token);

      const skillsFromSkill = extractSkillsFromSkillResponse(
        skillLookup.response,
        skillId
      );

      skillLookups.push({
        skillId,
        success: true,
        queryUsed: skillLookup.queryUsed,
        skillsFromSkill,
        skillResponse: skillLookup.response
      });

      resolvedSkills.push(...skillsFromSkill);
    } catch (error) {
      const status = error.response?.status || null;
      const data = error.response?.data || error.message;

      console.log(
        "Skill lookup failed:",
        skillId,
        status,
        JSON.stringify(data)
      );

      skillLookups.push({
        skillId,
        success: false,
        status,
        error: data
      });

      resolvedSkills.push(skillId);
    }
  }

  return {
    mandatorySkills: [...new Set(resolvedSkills.filter(Boolean))],
    skillIds,
    skillLookups
  };
}

function extractPersonSkills(personWrapper) {
  const person = unwrapPerson(personWrapper);

  if (!person) return [];

  const skills = [];

  const skillCollections = [
    person.skills,
    person.mandatorySkills,
    person.requiredSkills
  ];

  for (const collection of skillCollections) {
    if (!Array.isArray(collection)) continue;

    for (const item of collection) {
      if (typeof item === "string") {
        addSkillIfValid(skills, item);
        continue;
      }

      if (item && typeof item === "object") {
        addSkillIfValid(skills, item.code);
        addSkillIfValid(skills, item.name);
        addSkillIfValid(skills, item.externalId);
        addSkillIfValid(skills, item.id);
        addSkillIfValid(skills, item.refId);

        if (item.skill && typeof item.skill === "object") {
          addSkillIfValid(skills, item.skill.code);
          addSkillIfValid(skills, item.skill.name);
          addSkillIfValid(skills, item.skill.externalId);
          addSkillIfValid(skills, item.skill.id);
          addSkillIfValid(skills, item.skill.refId);
        }

        if (typeof item.skill === "string") {
          addSkillIfValid(skills, item.skill);
        }
      }
    }
  }

  return [...new Set(skills.filter(Boolean))];
}

function compareSkills(requiredSkills, personSkills) {
  const personSet = new Set(personSkills.map((item) => String(item).toLowerCase()));

  const matched = [];
  const missing = [];

  for (const skill of requiredSkills) {
    if (personSet.has(String(skill).toLowerCase())) {
      matched.push(skill);
    } else {
      missing.push(skill);
    }
  }

  return {
    matched,
    missing,
    allMatched: missing.length === 0
  };
}

function buildOptimizationPayload(reqBody, serviceCall, mandatorySkillsFromRequirements) {
  const durationFromServiceCall = extractDurationFromServiceCall(serviceCall);
  const locationFromServiceCall = extractLocationFromServiceCall(serviceCall);

  const fallbackJob = reqBody.job || {};

  const durationMinutes =
    durationFromServiceCall ||
    fallbackJob.durationMinutes ||
    fallbackJob.durationInMinutes ||
    60;

  const location =
    locationFromServiceCall ||
    fallbackJob.location ||
    {
      latitude: 38.0344,
      longitude: 23.1283
    };

  const mandatorySkills =
    mandatorySkillsFromRequirements.length > 0
      ? mandatorySkillsFromRequirements
      : fallbackJob.mandatorySkills || [];

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
        includeMandatorySkills: mandatorySkills.length > 0
      }
    },
    slots: generateRollingSlots(),
    options: reqBody.options || {
      maxResultsPerSlot: 5,
      defaultDrivingTimeMinutes: 30
    },
    policy: reqBody.policy || "DistanceAndSkills"
  };
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "fsm-score-wrapper"
  });
});

app.post("/score-with-org-level", async (req, res) => {
  try {
    console.log("Received request from FSM.");
    console.log("Incoming body:", JSON.stringify(req.body, null, 2));

    const token = await getFsmToken();

    if (!req.body.serviceCallId && !req.body.job) {
      return res.status(400).json({
        error: "Missing serviceCallId or fallback job payload"
      });
    }

    let serviceCall = null;
    let serviceCallResponse = null;
    let requirementLookup = null;
    let resolvedRequirementSkills = {
      mandatorySkills: [],
      skillIds: [],
      skillLookups: []
    };

    if (req.body.serviceCallId) {
      serviceCallResponse = await getServiceCall(req.body.serviceCallId, token);

      console.log("ServiceCall response:", JSON.stringify(serviceCallResponse, null, 2));

      const serviceCallWrapper = getFirstItem(serviceCallResponse);
      serviceCall = unwrapServiceCall(serviceCallWrapper);

      if (!serviceCall) {
        return res.status(400).json({
          error: "ServiceCall not found",
          serviceCallId: req.body.serviceCallId,
          serviceCallResponse
        });
      }

      requirementLookup = await getRequirementsForServiceCall(
        req.body.serviceCallId,
        token
      );

      resolvedRequirementSkills = await resolveRequirementSkills(
        requirementLookup.response,
        token
      );

      console.log("Requirement query used:", requirementLookup.queryUsed);
      console.log("Requirement Skill IDs:", resolvedRequirementSkills.skillIds);
      console.log(
        "Mandatory skills resolved from Skill DTO:",
        resolvedRequirementSkills.mandatorySkills
      );

      if (resolvedRequirementSkills.mandatorySkills.length === 0) {
        return res.status(400).json({
          error: "No mandatory skills resolved from Requirement / Skill DTO",
          serviceCallId: req.body.serviceCallId,
          requirementQueryUsed: requirementLookup.queryUsed,
          requirementResponse: requirementLookup.response,
          skillLookups: resolvedRequirementSkills.skillLookups,
          hint:
            "Requirement exists, but Requirement.tag could not be resolved through Skill DTO."
        });
      }
    }

    const optimizationPayload = buildOptimizationPayload(
      req.body,
      serviceCall,
      resolvedRequirementSkills.mandatorySkills
    );

    console.log(
      "Generated 30-minute rolling slots count:",
      optimizationPayload.slots.length
    );

    console.log(
      "Mandatory skills used:",
      optimizationPayload.job.mandatorySkills
    );

    console.log(
      "Optimization payload:",
      JSON.stringify(optimizationPayload, null, 2)
    );

    const scoreResponse = await axios.post(
      OPTIMIZATION_URL,
      optimizationPayload,
      {
        headers: fsmHeaders(token)
      }
    );

    const scoreData = scoreResponse.data;

    console.log("Optimization response:", JSON.stringify(scoreData, null, 2));

    const availableResults = Array.isArray(scoreData.results)
      ? scoreData.results.filter(
          (item) => item && item.resource && item.start && item.end
        )
      : [];

    const bestResult = availableResults[0];

    if (!bestResult) {
      return res.status(400).json({
        error: "No available optimization result found",
        optimizationPayload,
        scoreData
      });
    }

    const resourceId = bestResult.resource;

    const personResponse = await getPerson(resourceId, token);

    console.log("Person response:", JSON.stringify(personResponse, null, 2));

    const personWrapper = getFirstItem(personResponse);

    if (!personWrapper) {
      return res.status(400).json({
        error: "Person not found",
        resourceId,
        personResponse
      });
    }

    const orgLevel = extractOrgLevel(personWrapper);

    if (!orgLevel) {
      return res.status(400).json({
        error: "Org level not found on Person",
        resourceId,
        person: personWrapper
      });
    }

    const personSkills = extractPersonSkills(personWrapper);
    const skillMatch = compareSkills(
      optimizationPayload.job.mandatorySkills,
      personSkills
    );

    const alternatives = availableResults
      .slice(1, 6)
      .map((item) => ({
        slot: item.slot || null,
        resource: item.resource,
        start: item.start,
        end: item.end,
        trip: item.trip || null,
        score: item.score || null
      }));

    const enrichedResponse = {
      results: [
        {
          ...bestResult,
          orgLevel,
          requiredSkills: optimizationPayload.job.mandatorySkills,
          personSkills,
          skillMatch
        }
      ],
      alternatives,
      generatedSlotsCount: optimizationPayload.slots.length,
      mandatorySkillsUsed: optimizationPayload.job.mandatorySkills,
      requirementQueryUsed: requirementLookup?.queryUsed || null,
      requirementSkillIds: resolvedRequirementSkills.skillIds,
      skillLookups: resolvedRequirementSkills.skillLookups
    };

    console.log(
      "Returning enriched response:",
      JSON.stringify(enrichedResponse, null, 2)
    );

    return res.json(enrichedResponse);
  } catch (error) {
    console.error("Wrapper endpoint failed:", error.message);

    if (error.response) {
      console.error("Response status:", error.response.status);
      console.error("Response data:", JSON.stringify(error.response.data, null, 2));
    }

    return res.status(500).json({
      error: "Wrapper endpoint failed",
      message: error.message,
      response: error.response?.data || null
    });
  }
});

const host = process.env.HOST || "0.0.0.0";
const port = Number(PORT);

const server = app.listen(port, host, () => {
  console.log(`FSM score wrapper running on ${host}:${port}`);
  console.log("Health check: /health");
});

server.on("error", (error) => {
  console.error("Server failed to start:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});