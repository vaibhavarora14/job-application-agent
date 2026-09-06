export type JobLocation = {
  jobId: string;
  url: string;
  company: string;
  role: string;
  label: string;
  cities: string[];
  countries: string[];
  workplace: string;
  sourceUrl: string;
  checkedAt: string;
};
export type LocationIndex = { collectedAt: string; records: JobLocation[] };
