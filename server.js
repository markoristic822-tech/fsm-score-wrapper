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

  SLOT_TIMEZONE = "Europe/Athens",
  SLOT_DAYS_AHEAD = "5",
  SLOT_WORKING_DAY_START = "08:00",
  SLOT_WORKING_DAY_END = "18:00",
  SLOT_START_BUFFER_MINUTES = "15"
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

function generateRollingSlots({
  timezone = SLOT_TIMEZONE,
  daysAhead = Number(SLOT_DAYS_AHEAD),
  workingDayStart = SLOT_WORKING_DAY_START,
  workingDayEnd = SLOT_WORKING_DAY_END,
  startBufferMinutes = Number(SLOT_START_BUFFER_MINUTES)
} = {}) {
  const now = DateTime.now()
    .setZone(timezone)
    .plus({ minutes: startBufferMinutes });

  const [startHour, startMinute] = workingDayStart.split(":").map(Number);
  const [endHour, endMinute] = workingDayEnd.split(":").map(Number);

  const slots = [];

  for (let i = 0; i < daysAhead; i++) {
    const day = now.plus({ days: i });

    let slotStart = day.set({
      hour: startHour,
      minute: startMinute,
      second: 0,
      millisecond: 0
    });

    const slotEnd = day.set({
      hour: endHour,
      minute: endMinute,
      second: 0,
      millisecond: 0
    });

    // Za današnji dan nikad ne šaljemo slot u prošlosti
    if (i === 0 && now > slotStart) {
      slotStart = now;
    }

    if (slotStart < slotEnd) {
      slots.push({
        start: slotStart.toUTC().toISO(),
        end: slotEnd.toUTC().toISO()
      });
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

    const generatedSlots = generateRollingSlots();

    const optimizationPayload = {
      ...req.body,
      slots: generatedSlots
    };

    console.log("Generated slots:", JSON.stringify(generatedSlots, null, 2));
    console.log("Calling optimization endpoint...");
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

    const firstResult = scoreData.results?.[0];

    if (!firstResult || !firstResult.resource) {
      return res.status(400).json({
        error: "Optimization response does not contain results[0].resource",
        generatedSlots,
        scoreData
      });
    }

    const resourceId = firstResult.resource;

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

    const enrichedResponse = {
      ...scoreData,
      generatedSlots,
      results: scoreData.results.map((item, index) => {
        if (index === 0) {
          return {
            ...item,
            orgLevel
          };
        }

        return item;
      })
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
  console.log(`Health check: /health`);
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