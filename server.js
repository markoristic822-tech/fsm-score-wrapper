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
  const person =
    personWrapper.person ||
    personWrapper.unifiedPerson ||
    personWrapper;

  const rawOrgLevel =
    person.orgLevel ||
    person.orgLevelId ||
    person.organizationLevel ||
    person.organizationLevelId ||
    person.organizationalLevel ||
    person.organization ||
    person.orgLevels?.[0] ||
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

    console.log("Calling optimization endpoint...");

    const scoreResponse = await axios.post(
      OPTIMIZATION_URL,
      req.body,
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