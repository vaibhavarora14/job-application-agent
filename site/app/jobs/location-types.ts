export type JobPayRange = {
  min: number;
  max: number;
  currency: string;
  period: "year" | "month" | "week" | "day" | "hour" | string;
  /** What the figure covers; only "base" is published as JSON-LD baseSalary. */
  kind?: "base" | "ote" | "total";
  /** Location or tier title the employer gave this range (e.g. "US Zone 1"); null when unstated. */
  location: string | null;
  /** e.g. "$135K–$300K USD" or "€110.5K–€181.5K". */
  label: string;
};

export type JobSalary = {
  min: number;
  max: number;
  annualMin: number;
  annualMax: number;
  currency: string;
  period: "year" | "month" | "hour" | string;
  /** Kind of the span (first listed range); OTE/total labels carry an "OTE"/"total comp" suffix. */
  kind?: "base" | "ote" | "total";
  /** Full span in the first listed currency, e.g. "$135K–$300K USD". */
  label: string;
  /** Every employer-stated range, in source order (older snapshots may omit it). */
  ranges?: JobPayRange[];
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

