export type JobSalary = {
  min: number;
  max: number;
  annualMin: number;
  annualMax: number;
  currency: string;
  period: "year" | "month" | "hour" | string;
  label: string;
  isEstimated: boolean;
  source: "employer" | "market-benchmark" | string;
};

export type JobLocation = {
  jobId: string;
  url: string;
  company: string;
  role: string;
  label: string;
  cities: string[];
  countries: string[];
  countryCodes?: string[];
  places?: { locality?: string; region?: string; country: string }[];
  workplace: string;
  salary?: (JobSalary & { basis?: "ats" | "text" }) | null;
  employmentType?: string | null;
  experienceLevel?: string | null;
  department?: string | null;
  team?: string | null;
  postedAt?: string | null;
  sourceUrl: string;
  checkedAt: string;
};
export type LocationIndex = { collectedAt: string; records: JobLocation[] };

