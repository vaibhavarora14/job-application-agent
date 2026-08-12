# Data schemas

## Profile input

Send one JSON object to `profile set --stdin`. Send an object containing only intentional overrides to `profile migrate --stdin`; migration preserves existing identity fields, maps legacy `salaryPreference` to `targetCompensation`, adds current defaults, validates the complete result, and writes it atomically.

```json
{
  "name": "Candidate Name",
  "email": "candidate@example.com",
  "phone": "+91 90000 00000",
  "location": "Bengaluru, India",
  "workAuthorization": "Exact countries or arrangements",
  "linkedin": "https://linkedin.com/in/example",
  "github": "https://github.com/example",
  "portfolio": "https://example.com",
  "availability": "30 days",
  "currentCompensation": "Optional exact value and currency",
  "targetCompensation": "Optional legacy-compatible free text",
  "compensationFloor": { "amount": 9000000, "currency": "INR", "period": "year" },
  "roleFamilies": ["product-engineering", "full-stack", "ai-ml"],
  "seniority": ["senior", "staff"],
  "skills": ["TypeScript", "Python", "React", "Node.js", "PostgreSQL", "MCP", "AI agents"],
  "targetLocations": ["India", "Remote", "Worldwide"],
  "excludedLocations": [],
  "workModes": ["remote"],
  "industries": ["AI", "developer tools"],
  "excludedCompanies": [],
  "submissionMode": "routine-auto",
  "yearsExperience": 10,
  "autoSubmitMinScore": 80,
  "manualReviewMinScore": 70,
  "minMustHaveCoverage": 70
}
```

Required fields are `name`, `email`, `phone`, `location`, `workAuthorization`, `roleFamilies`, `seniority`, `targetLocations`, `workModes`, `submissionMode`, `yearsExperience`, `autoSubmitMinScore`, `manualReviewMinScore`, and `minMustHaveCoverage`.

`compensationFloor` is optional and must use a three-letter currency code and `period: "year"`. Compare a job salary only when its basis and currency are directly comparable.

## Job assessment input

Treat `mustHaves[].evidence` as private resume analysis. It is used locally and is not included in telemetry.

```json
{
  "title": "Senior Product Engineer",
  "company": "Example",
  "description": "Posting text",
  "source": "greenhouse",
  "url": "https://job-boards.greenhouse.io/example/jobs/123",
  "postingStatus": "active",
  "eligibility": "eligible",
  "roleFamily": "product-engineering",
  "seniority": "senior",
  "experienceMin": 7,
  "experienceMax": 12,
  "workMode": "remote",
  "remote": true,
  "locations": ["Remote", "India"],
  "salaryMaximum": 12000000,
  "salaryCurrency": "INR",
  "mustHaves": [
    { "requirement": "TypeScript", "status": "met", "evidence": "Resume-backed example" },
    { "requirement": "Distributed systems", "status": "partial", "evidence": "Related platform work, not exact claim" },
    { "requirement": "GraphQL", "status": "missing" }
  ]
}
```

Allowed sources: `linkedin`, `greenhouse`, `lever`, `ashby`, `workable`, `comeet`, `workday`, `rippling`, `smartrecruiters`, `google-form`, `company`, `email`, and `other`.

Allowed posting statuses: `active`, `closed`, `unclear`. Allowed eligibility: `eligible`, `unclear`, `ineligible`. Allowed seniority: `junior`, `mid`, `senior`, `staff`, `principal`, `lead`, `manager`, `director`, `founding`, `unspecified`. Allowed work modes: `remote`, `hybrid`, `onsite`, `unspecified`. Must-have statuses: `met`, `partial`, `missing`, `unclear`.

Assessment output retains `review`, `ask`, `skip`, and `exclude`, and adds `autoEligible`, `mustHaveCoverage`, and structured `gates`. `review` does not itself authorize submission.

## Duplicate check input

Include as many identifiers as are known.

```json
{
  "id": "example-senior-product-engineer-2026-01-15",
  "company": "Example",
  "role": "Senior Product Engineer",
  "url": "https://jobs.example.com/roles/123?utm_source=board",
  "employerJobId": "greenhouse:123"
}
```

The check removes fragments and non-job query parameters while retaining recognized job or requisition identifiers. Matching ledger ID, canonical URL, or same-company employer job ID is a hard duplicate. Same company and role without a shared job ID is a possible duplicate.

## Confirmed submission input

Add only after visible success confirmation.

```json
{
  "id": "example-senior-product-engineer-2026-01-15",
  "company": "Example",
  "role": "Senior Product Engineer",
  "url": "https://jobs.example.com/roles/123",
  "employerJobId": "greenhouse:123",
  "source": "company",
  "score": 84,
  "status": "submitted",
  "submittedAt": "2026-01-15T10:00:00.000Z",
  "approval": "STANDING AUTHORIZATION",
  "duplicateOverride": "NEW REQUISITION CONFIRMED",
  "answers": { "Resume": "Canonical resume.pdf" },
  "telemetry": {
    "durationBucket": "5-15m",
    "fieldsFilled": 14,
    "shortAnswerCount": 2,
    "resumeUploaded": true
  }
}
```

Use `duplicateOverride` only for a verified distinct requisition after a possible-duplicate warning. It and `telemetry` are transient and are not written to the application ledger. Use approval `APPROVE SUBMIT` for per-application approval or `STANDING AUTHORIZATION` when the current request authorizes routine batch submission.

## Outcome input

```json
{
  "id": "example-senior-product-engineer-2026-01-15",
  "status": "rejected",
  "occurredAt": "2026-01-20T09:00:00.000Z",
  "note": "Optional private note",
  "interviewQuality": "weak",
  "failurePoint": "constraints",
  "reasons": [
    { "category": "eligibility", "evidence": "explicit" }
  ]
}
```

Allowed outcomes: `interview`, `rejected`, `offer`, `withdrawn`.

Optional interview quality values: `promising`, `viable`, `weak`, `dead`. Optional failure points: `role-scope`, `company-problem`, `constraints`, `interviewer`, `process`, `unknown`. A failure point requires an interview quality. Free-form notes remain private and are never included in telemetry.

Allowed reason categories: `eligibility`, `closed-stale`, `level-compensation`, `must-have-gap`, `generic-resume-screen`, `interview-stage`, `unknown`. Evidence is `explicit` or `inferred`. An identical event is idempotent. Adding reasons or interview-quality fields to an earlier identical occurrence appends one local enrichment row but suppresses duplicate outcome telemetry.

## Review acknowledgement input

Generate `ledger review` first. Acknowledge only after the candidate has reviewed it.

```json
{
  "reviewedAt": "2026-01-21T09:00:00.000Z"
}
```

The acknowledgement stores the current canonical unique-submission and mature-application counts in append-only `reviews.ndjson`.

`ledger review` also returns `interviewLearningSegments`. Each row combines the canonical application's source and ten-point fit-score band with the latest recorded interview quality and failure point, plus a count. This supports evidence-based targeting reviews without exposing private notes or automatically changing score weights.
