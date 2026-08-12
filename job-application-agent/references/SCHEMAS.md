# Data schemas

## Profile input

Send one JSON object to `profile set --stdin`.

```json
{
  "name": "Candidate Name",
  "email": "candidate@example.com",
  "phone": "+1 555 0100",
  "location": "City, Region, Country",
  "workAuthorization": "Exact countries or arrangements",
  "linkedin": "https://linkedin.com/in/example",
  "github": "https://github.com/example",
  "portfolio": "https://example.com",
  "availability": "30 days",
  "currentCompensation": "Optional exact value and currency",
  "targetCompensation": "Optional minimum and currency",
  "roleFamilies": ["product engineer", "backend engineer"],
  "seniority": ["senior", "staff"],
  "skills": ["TypeScript", "Python", "React"],
  "targetLocations": ["India", "Remote"],
  "excludedLocations": [],
  "workModes": ["remote", "hybrid"],
  "industries": ["AI", "developer tools"],
  "excludedCompanies": [],
  "submissionMode": "review-each"
}
```

Required fields are `name`, `email`, `phone`, `location`, `workAuthorization`, `roleFamilies`, `seniority`, `targetLocations`, `workModes`, and `submissionMode`.

## Job-scoring input

Eligibility is a human-verified classification. Include a numeric annual `salaryMinimum` only when the posting states a comparable figure.

```json
{
  "title": "Senior Product Engineer",
  "company": "Example",
  "description": "Posting text",
  "source": "greenhouse",
  "url": "https://job-boards.greenhouse.io/example/jobs/123",
  "remote": true,
  "locations": ["Remote", "India"],
  "eligibility": "eligible",
  "salaryMinimum": 100000,
  "salaryCurrency": "USD"
}
```

Allowed sources: `linkedin`, `greenhouse`, `lever`, `ashby`, `workable`, `company`, `email`, and `other`.

## Duplicate check input

```json
{
  "id": "example-senior-product-engineer-2026-01-15",
  "url": "https://jobs.example.com/roles/123"
}
```

## Confirmed submission input

Only add after visible success confirmation.

```json
{
  "id": "example-senior-product-engineer-2026-01-15",
  "company": "Example",
  "role": "Senior Product Engineer",
  "url": "https://jobs.example.com/roles/123",
  "source": "company",
  "score": 84,
  "status": "submitted",
  "submittedAt": "2026-01-15T10:00:00.000Z",
  "approval": "STANDING AUTHORIZATION",
  "answers": {
    "Resume": "Canonical resume.pdf"
  }
}
```

Use approval `APPROVE SUBMIT` for a per-application approval or `STANDING AUTHORIZATION` when the current request authorized routine batch submission.

## Outcome input

```json
{
  "id": "example-senior-product-engineer-2026-01-15",
  "status": "interview",
  "occurredAt": "2026-01-20T09:00:00.000Z",
  "note": "Recruiter screen requested"
}
```

Allowed outcomes: `interview`, `rejected`, `offer`, and `withdrawn`.
