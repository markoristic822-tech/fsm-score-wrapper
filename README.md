# Subcontractor allocation and Service Call customer

The allocation source is `Assignment Flows 7_5 (3).xlsx`. The checked-in
`matrix.xlsx` contains its **POSTAL CODE FLOW** sheet, which the generator selects
by name. `allocation-matrix.json` is the runtime input. OTE SITE FLOW and
COUNTY-MUNICIPALITY FLOW are not part of this postal-code route.

Regenerate with `npm run generate:matrix`. To retain the original source filename:

```
node scripts/generate-allocation-matrix.js matrix.xlsx allocation-matrix.json "Assignment Flows 7_5 (3).xlsx"
```

## Selection

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
  uses `INITIATOR (REMEDY)`. A five-digit postal requirement is still needed.
- Percentages now allocate **SUB_CONTRACTOR** values directly, rather than grouping
  them under the parent CONTRACTORS name. For `19442` and `TAS...`, the selection
  is `DIMOU_L_DIS` at 100%.

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
and `Service Call Business Partner assignment failed:`.

## Source data issues

Two PASPORT keys are blocked because their percentage cells contain text:

- Row 105: `10223|INITIATOR (PASPORT)` contains `ICOM_EUVOIA_DIS`.
- Row 692: `16450|INITIATOR (PASPORT)` contains `TIL_KARYS_STABELOU_DIS`.

As in the previous generator, numeric totals other than 100 are normalized and
reported in `warnings`: `18202|FTTH` totals 300 for one subcontractor;
`57000|FWA` totals 200 across two subcontractors and becomes 50/50.

Run `npm test`. Tests cover source import, initiator/technology routing, BP lookup,
optimistic updates, quota reuse, and the HTTP handler with mocked external APIs.
