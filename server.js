const express = require("express");
const axios = require("axios");
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
  OPTIMIZATION_URL
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
    OPTIMIZATION_URL: !!OPTIMIZATION_URL
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

    // Za današnji dan ne šaljemo slotove u prošlosti
    if (i === 0 && now > dayStart) {
      dayStart = now;
    }

    // Zaokruži na sledeći 30-minutni interval
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

async function getPerson(resourceId, token) {
  console.log("Getting Person for resource:", resourceId);

  const url =
    `${FSM_BASE_URL}/api/data/v4/Person` +
    `?dtos=Person.25&query=id%3D%22${resourceId}%22`;

  const response = await axios.get(url, {
    headers: fsmHeaders(token)
  });

  return response.data;
}

async function getServiceCall(serviceCallId, token) {
  console.log("Getting ServiceCall:", serviceCallId);

  const url =
    `${FSM_BASE_URL}/api/data/v4/ServiceCall` +
    `?dtos=ServiceCall.27&query=id%3D%22${serviceCallId}%22`;

  const response = await axios.get(url, {
    headers: fsmHeaders(token)
  });

  return response.data;
}

function getFirstItem(response) {
  if (Array.isArray(response)) return response[0];
  if (Array.isArray(response.data)) return response.data[0];
  if (Array.isArray(response.items)) return response.items[0];
  if (Array.isArray(response.values)) return response.values[0];
  if (Array.isArray(response.records)) return response.records[0];
  return null;
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
  const person =
    personWrapper.person ||
    personWrapper.unifiedPerson ||
    personWrapper;

  const rawOrgLevel =
    person.orgLevel ||
    person.orgLevelId ||
    person.orgLevelIds?.[0] ||
    person.orgLevels?.[0] ||
    person.organizationLevel ||
    person.organizationLevelId ||
    person.organizationLevelIds?.[0] ||
    person.organizationalLevel ||
    person.organization ||
    person.regions?.[0];

  return normalizeOrgLevel(rawOrgLevel);
}

function unwrapServiceCall(serviceCallWrapper) {
  if (!serviceCallWrapper) return null;

  return (
    serviceCallWrapper.serviceCall ||
    serviceCallWrapper.ServiceCall ||
    serviceCallWrapper
  );
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

function extractMandatorySkillsFromServiceCall(serviceCall) {
  if (!serviceCall) return [];

  const possibleRequirements = [
    serviceCall.requirements,
    serviceCall.mandatorySkills,
    serviceCall.skills,
    serviceCall.requiredSkills
  ];

  const requirements = possibleRequirements.find((item) => Array.isArray(item)) || [];

  const skills = [];

  for (const requirement of requirements) {
    const skill = requirement.skill || requirement;

    if (typeof skill === "string") {
      skills.push(skill);
      continue;
    }

    if (skill && typeof skill === "object") {
      if (skill.code) skills.push(skill.code);
      if (skill.name) skills.push(skill.name);
      if (skill.externalId) skills.push(skill.externalId);
      if (skill.id) skills.push(skill.id);
    }

    if (requirement && typeof requirement === "object") {
      if (requirement.code) skills.push(requirement.code);
      if (requirement.name) skills.push(requirement.name);
      if (requirement.externalId) skills.push(requirement.externalId);
      if (requirement.id) skills.push(requirement.id);
    }
  }

  return [...new Set(skills.filter(Boolean))];
}

function buildOptimizationPayload(reqBody, serviceCall) {
  const durationFromServiceCall = extractDurationFromServiceCall(serviceCall);
  const locationFromServiceCall = extractLocationFromServiceCall(serviceCall);
  const mandatorySkillsFromServiceCall = extractMandatorySkillsFromServiceCall(serviceCall);

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
    mandatorySkillsFromServiceCall.length > 0
      ? mandatorySkillsFromServiceCall
      : fallbackJob.mandatorySkills || [];

  const optimizationPayload = {
    job: {
      durationMinutes,
      location,
      mandatorySkills
    },
    resources: reqBody.resources || {
      filters: {
        includeInternalPersons: true,
        includeCrowdPersons: false,
        includeMandatorySkills: true
      }
    },
    slots: generateRollingSlots(),
    options: reqBody.options || {
      maxResultsPerSlot: 5,
      defaultDrivingTimeMinutes: 30
    },
    policy: reqBody.policy || "DistanceAndSkills"
  };

  return optimizationPayload;
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

    let serviceCall = null;
    let serviceCallResponse = null;

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
    }

    const optimizationPayload = buildOptimizationPayload(req.body, serviceCall);

    console.log("Generated dynamic 7-day slot:", JSON.stringify(optimizationPayload.slots, null, 2));
    console.log("Optimization payload:", JSON.stringify(optimizationPayload, null, 2));

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
      ? scoreData.results.filter((item) => item && item.resource && item.start && item.end)
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
          orgLevel
        }
      ],
      alternatives,
      generatedSlotsCount: optimizationPayload.slots.length
    };

    console.log("Returning enriched response:", JSON.stringify(enrichedResponse, null, 2));

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