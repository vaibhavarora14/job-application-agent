export type JobSalary = {
  min: number;
  max: number;
  annualMin: number;
  annualMax: number;
  currency: string;
  period: "year" | "month" | "hour";
  label: string;
  isEstimated: boolean;
  source: "employer" | "market-benchmark";
};

export type JobLocation = {
  jobId: string;
  url: string;
  company: string;
  role: string;
  label: string;
  cities: string[];
  countries: string[];
  workplace: string;
  salary?: JobSalary | null;
  employmentType?: string;
  experienceLevel?: string;
  sourceUrl: string;
  checkedAt: string;
};
export type LocationIndex = { collectedAt: string; records: JobLocation[] };

