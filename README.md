# Subcontractor allocation and Service Call customer

The allocation source is `Assignment Flows 7_5 (3).xlsx`. The checked-in
`matrix.xlsx` contains its **POSTAL CODE FLOW** and **OTE SITE FLOW** sheets,
which the existing `xlsx` generator selects by trimmed sheet name, independent
of worksheet order. `allocation-matrix.json` is the runtime input. Postal entries
retain their original keys and percentages. OTE entries use
`OTE_SITE|<PasPortCode>|<column>` in the same matrix and allocation mechanism.
COUNTY-MUNICIPALITY FLOW is not implemented; there is no Region fallback.

Regenerate with `npm run generate:matrix`. To retain the original source filename:

```
node scripts/generate-allocation-matrix.js matrix.xlsx allocation-matrix.json "Assignment Flows 7_5 (3).xlsx"
```

## Selection

- When the request includes the original Siebel `workOrder`, a nonblank
  `addressInfo.postalCode` selects the postal flow. OTE never overrides it,
  including when the postal code is invalid or has no configured allocation.
- Only when the incoming postal code is missing/null/blank,
  `externalSystemInfo.oteSiteId` selects the OTE flow. It matches **PasPortCode**
  in **OTE SITE FLOW**; **CONTRACTOR** supplies the subcontractor BP name.
  **OTE_NAME** / `oteSite` is descriptive, never a lookup key. The remaining
  columns are POSTAL, REGION, INITIATOR (PASPORT), INITIATOR (REMEDY), FWA, FTTH,
  MESH, CLOUD & SYZEFXIS, Subcontractor DTH/SBB, CONTRACTORS and ΣΧΟΛΙΑ.
- OTE identifiers are trimmed strings, matched case-insensitively. Text and
  Excel-formatted leading zeros are retained: `0001`, `OTE-001` and `ATH-05`
  remain distinct identifiers. The source workbook stores numeric **19** with
  General formatting, so it is **not** a match for incoming `019`; canonical
  codes must agree between Excel and Siebel. No numeric coercion or name-based
  fallback is applied.
- Missing both area identifiers, unknown OTE rows and invalid percentage cells
  retain manual dispatch. No Region assignment or cross-area fallback is added.
- The Service Call UDF `DIS_SC_TECHNOLOGY` (from SOAP `technicalInfo.technology`)
  takes precedence when it contains one recognized technology keyword. For
  example, `FTTH-GPON` with MESH and FTTH requirements at `10443` selects
  `10443|FTTH` and `SAT_PRAXIS_DIS`. Conflicting technology keywords return manual
  dispatch; a metadata lookup failure is not silently ignored. The keyword uses
  token boundaries, so `FTTH-GPON` matches FTTH, but `NOTFTTH` does not.
- If technology is empty or unrecognized, requirements select the postal code + technology column. Inbound
  `DTH` maps to `Subcontractor DTH/SBB`; `CLOUD&SYZEFIXIS` maps to
  `CLOUD & SYZEFXIS`. Multiple technology requirements retain the combined-key
  behavior; there is no implicit priority between them.
- Without a technology keyword in either the technology UDF or requirements, `PS...` uses `INITIATOR (PASPORT)` and `TAS...`
  uses `INITIATOR (REMEDY)`. The selected area is either the postal code or OTE ID;
  OTE initiator allocation does not require a postal or technology skill.
- Percentages now allocate **SUB_CONTRACTOR** values directly, rather than grouping
  them under the parent CONTRACTORS name. For `19442` and `TAS...`, the selection
  is `DIMOU_L_DIS` at 100%.

## Original Work Order input

`POST /score-with-org-level` accepts the existing Siebel model alongside
`serviceCallId`, for example:

```json
{
  "serviceCallId": "<FSM Service Call ID>",
  "workOrder": {
    "addressInfo": { "postalCode": null },
    "externalSystemInfo": { "oteSiteId": "19", "oteSite": "OTE description" },
    "technicalInfo": { "technology": "FTTH-GPON" }
  }
}
```

With this model, area and technology come directly from the incoming Siebel
values; the wrapper does not read their FSM UDFs back for assignment. It still
uses FSM requirements unchanged for Optimization, and the existing Service Call
read provides its externalId, current BP link and lastChanged.

For the SOAP path, the adapter registers this small context with
`POST /assignment/context` **before creating the Service Call**:

```json
{
  "externalId": "<Siebel orderNumber>",
  "workOrder": {
    "addressInfo": { "postalCode": "" },
    "externalSystemInfo": { "oteSiteId": "19", "oteSite": "OTE description" },
    "technicalInfo": { "technology": "FTTH-GPON" }
  }
}
```

The endpoint requires `X-Assignment-Context-Key`, matching the score service's
`ASSIGNMENT_CONTEXT_KEY`. It acknowledges `{ "accepted": true, "externalId": ... }`.
The existing FSM callback continues to send only `serviceCallId`; the wrapper
uses the Service Call's externalId to find the original context, without reading
OTE UDFs. `Assignment context source:` distinguishes SOAP_CONTEXT, DIRECT_REQUEST
and LEGACY. Only requests without a postal code and with an OTE ID need this
handoff. Legacy postal requests retain their previous behavior.

Context is kept in memory for 30 minutes on the **single score instance**, like
the existing allocation counters. Identical retries are accepted; conflicting
context returns 409, and capacity exhaustion returns 503 without evicting active
orders. Up to 10,000 contexts are retained. A restart loses this context; a delayed
callback after expiry cannot use OTE and follows the existing manual-dispatch
behavior. Shared durable storage would be needed before scaling this service
to multiple instances. No contact or equipment fields are stored in the context.

Deploy the score service first with `ASSIGNMENT_CONTEXT_KEY` set. Configure the
SOAP service with the same key and `ASSIGNMENT_CONTEXT_URL` pointing to the score
service's `/assignment/context`, then deploy it. A failed or unconfigured handoff
aborts the SOAP creation before Equipment/Service Call writes. Postal requests
and requests missing both area identifiers do not call this endpoint.

## Business Partner binding

Before Optimization, the wrapper looks up `BusinessPartner.name` using the exact
SUB_CONTRACTOR value (for example, `DIMOU_L_DIS`, not the directory display name
`DIMOU L.&CO`). It PATCHes `ServiceCall.businessPartner` to the matching FSM ID.
The current `lastChanged` protects the update from concurrent edits; `forceUpdate`
is not used. See the [SAP Data API example](https://help.sap.com/docs/SAP_FIELD_SERVICE_MANAGEMENT/fsm_api_quick_start_guide/api-example-data-api.html).

Missing/duplicate matching BPs, invalid matrix cells and failed PATCHes produce
manual-dispatch responses. No BP is created and no alternative company name is
inferred. The Service Call link is retained when no technician or slot is available.
A repeated request reuses an existing BP link that belongs to the same matrix row.
Counters advance only after a successful new link. Requests for the same matrix
key are serialized within this process; counters remain in memory and reset after
restart, so multiple instances do not share a global allocation quota.

`FSM_BUSINESS_PARTNER_DTO` can override the default `BusinessPartner.22` version.
The API client needs permission to read BusinessPartner and update ServiceCall.

## Resource selection and response

Org Level is no longer looked up or used. Its legacy response fields remain null.
Optimization still applies the original required skills and availability rules.
Technology precedence changes only the matrix column; it does not remove other
required skills such as MESH from Optimization or from the Service Call.
The resource's `PersonContractor` UDF must resolve to the selected SUB_CONTRACTOR
code. Without a matching resource, the wrapper returns manual dispatch instead of
assigning a technician from a different subcontractor.

The response includes `businessPartnerAssignment`; `results[0]` includes
`actSubContractorName` and the BP ID after successful linking, including responses
that require manual resource assignment. These response fields do not directly
write an Activity UDF. The actual persisted change is `ServiceCall.businessPartner`.
The existing `/score-with-org-level` route name remains compatible with callers.

Logs: `Contractor allocation routing:`, `Service Call Business Partner assignment:`
and `Service Call Business Partner assignment failed:`. `Assignment lookup
strategy:` records POSTAL_CODE / OTE_SITE / NONE and the area key. OTE matches
log the matrix key, BP ID and subcontractor; unknown rows and the absence of a
Region fallback are logged explicitly. The incoming body log includes only the
Service Call ID and whether Work Order context is present.

## Source data issues

Two PASPORT keys are blocked because their percentage cells contain text:

- Row 105: `10223|INITIATOR (PASPORT)` contains `ICOM_EUVOIA_DIS`.
- Row 692: `16450|INITIATOR (PASPORT)` contains `TIL_KARYS_STABELOU_DIS`.

As in the previous generator, numeric totals other than 100 are normalized and
reported in `warnings`: `18202|FTTH` totals 300 for one subcontractor;
`57000|FWA` totals 200 across two subcontractors and becomes 50/50.

Run `npm test`. Tests cover source import, initiator/technology routing, BP lookup,
optimistic updates, quota reuse, postal priority, null/empty/blank postal codes,
OTE IDs and percentage validation, missing areas/unknown OTE manual dispatch,
and the HTTP handler with mocked external APIs. No live tasks are created.
