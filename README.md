# Contractor allocation

The wrapper reads `allocation-matrix.json`, generated from `matrix.xlsx`.

When Service Call requirement skills contain a technology keyword (`FTTH`, `FWA`,
`MESH`, `CLOUD&SYZEFIXIS`, or `DTH`), the existing sorted skill matrix key is used.
The Excel spellings `CLOUD & SYZEFXIS` and `Subcontractor DTH/SBB` also count as
technology keywords. This change does not translate skill names to Excel column
names or change how multiple technology skills are combined.

When no technology keyword is present, allocation uses the postal code skill and
the initiator inferred from `ServiceCall.externalId`:

- `PS...` selects `<postalCode>|INITIATOR (PASPORT)`.
- `TAS...` selects `<postalCode>|INITIATOR (REMEDY)`.

For example, `TAS000004497994` with skill `19442` uses
`19442|INITIATOR (REMEDY)` and the percentages already configured in that row.
The initiator is not added to Optimization's mandatory skills. Existing resource
availability, skill filtering, weighted allocation and result fallbacks remain
in effect. Postal codes are expected as five-digit requirement skills.

Unknown initiators, missing/ambiguous postal codes and missing matrix rows return
the manual dispatch response. A missing technology matrix row does not switch to
initiator allocation. Requests without any requirement skills retain the existing
`MANDATORY_SKILLS_UNAVAILABLE` response.

Search logs for `Contractor allocation routing:` to see the Service Call external
ID, routing mode, initiator, matrix key and any routing failure reason.

Run `npm test` for routing regression tests.
