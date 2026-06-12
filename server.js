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

/**
 * Pravi slotove od 30 minuta:
 * 08:00–18:00 po Athens vremenu,
 * za danas i narednih 6 dana.
 */
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

    /*
     * Za današnji dan počinjemo tek posle trenutnog vremena.
     */
    if (dayOffset === 0 && now > dayStart) {
      dayStart = now;
    }

    /*
     * Zaokruživanje na sledećih punih 30 minuta.
     *
     * 10:07 -> 10:30
     * 10:30 -> 10:30
     * 10:44 -> 11:00
     */
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

    /*
     * Uzimamo samo mandatory requirements.
     */
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
    /*
     * Optimization je uspešno radio sa externalId/name,
     * npr. "10010".
     */
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
      maxResultsPerSlot: 5,
      defaultDrivingTimeMinutes: 30
    },
    policy:
      reqBody.policy ||
      "DistanceAndSkills"
  };
}

/**
 * Proverava da li se Optimization rezultat nalazi
 * potpuno unutar slota koji mu pripada.
 */
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

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "fsm-score-wrapper"
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

      const serviceCallId = req.body.serviceCallId;

      if (!serviceCallId) {
        return res.status(400).json({
          error: "serviceCallId is required"
        });
      }

      const token = await getFsmToken();

      const serviceCallResponse =
        await getServiceCall(
          serviceCallId,
          token
        );

      const serviceCallWrapper =
        getFirstItem(serviceCallResponse);

      const serviceCall =
        unwrapServiceCall(serviceCallWrapper);

      if (!serviceCall) {
        return res.status(400).json({
          error: "ServiceCall not found",
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

      if (
        resolvedRequirementSkills
          .mandatorySkills.length === 0
      ) {
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

      const optimizationPayload =
        buildOptimizationPayload(
          req.body,
          serviceCall,
          resolvedRequirementSkills.mandatorySkills
        );

      console.log(
        "Generated slots count:",
        optimizationPayload.slots.length
      );

      console.log(
        "Mandatory skills used:",
        optimizationPayload.job.mandatorySkills
      );

      console.log(
        "Optimization summary:",
        JSON.stringify(
          {
            job: optimizationPayload.job,
            resources:
              optimizationPayload.resources,
            options:
              optimizationPayload.options,
            policy:
              optimizationPayload.policy,
            slotsCount:
              optimizationPayload.slots.length,
            firstSlot:
              optimizationPayload.slots[0] ||
              null,
            lastSlot:
              optimizationPayload.slots[
                optimizationPayload.slots.length - 1
              ] || null
          },
          null,
          2
        )
      );

      const scoreResponse = await axios.post(
        OPTIMIZATION_URL,
        optimizationPayload,
        {
          headers: fsmHeaders(token)
        }
      );

      const scoreData = scoreResponse.data;

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
        allResults.filter(isResultInsideSlot);

      const rejectedResults =
        allResults
          .filter(
            (result) =>
              !isResultInsideSlot(result)
          )
          .map(normalizeOptimizationResult);

      console.log(
        "Optimization result counts:",
        {
          total: allResults.length,
          validInsideSlot:
            validResults.length,
          rejectedOutsideSlot:
            rejectedResults.length
        }
      );

      if (rejectedResults.length > 0) {
        console.log(
          "Rejected results outside slot:",
          JSON.stringify(
            rejectedResults.slice(0, 10),
            null,
            2
          )
        );
      }

      const bestResult = validResults[0];

      if (!bestResult) {
        return res.status(400).json({
          error:
            "Optimization returned results, but none are completely inside their 30-minute slot",
          mandatorySkillsUsed:
            optimizationPayload.job
              .mandatorySkills,
          generatedSlotsCount:
            optimizationPayload.slots.length,
          totalOptimizationResults:
            allResults.length,
          rejectedResults:
            rejectedResults.slice(0, 10),
          scoreData
        });
      }

      const resourceId =
        bestResult.resource;

      const personResponse =
        await getPerson(resourceId, token);

      const personWrapper =
        getFirstItem(personResponse);

      if (!personWrapper) {
        return res.status(400).json({
          error: "Person not found",
          resourceId
        });
      }

      const orgLevel =
        extractOrgLevel(personWrapper);

      if (!orgLevel) {
        return res.status(400).json({
          error:
            "Org level not found on Person",
          resourceId,
          person: personWrapper
        });
      }

      const alternatives =
        validResults
          .slice(1, 6)
          .map(normalizeOptimizationResult);

      const enrichedResponse = {
        results: [
          {
            ...normalizeOptimizationResult(
              bestResult
            ),
            orgLevel,
            requiredSkills:
              optimizationPayload.job
                .mandatorySkills
          }
        ],
        alternatives,
        generatedSlotsCount:
          optimizationPayload.slots.length,
        mandatorySkillsUsed:
          optimizationPayload.job
            .mandatorySkills,
        requirementQueryUsed:
          requirementLookup.queryUsed,
        requirementTagIds:
          resolvedRequirementSkills.tagIds,
        validResultsCount:
          validResults.length,
        rejectedOutsideSlotCount:
          rejectedResults.length
      };

      console.log(
        "Returning enriched response:",
        JSON.stringify(
          enrichedResponse,
          null,
          2
        )
      );

      return res.json(enrichedResponse);
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
        error: "Wrapper endpoint failed",
        message: error.message,
        response:
          error.response?.data || null
      });
    }
  }
);

const host =
  process.env.HOST || "0.0.0.0";

const port = Number(PORT);

const server = app.listen(
  port,
  host,
  () => {
    console.log(
      `FSM score wrapper running on ${host}:${port}`
    );

    console.log("Health check: /health");
  }
);

server.on("error", (error) => {
  console.error(
    "Server failed to start:",
    error
  );
});

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