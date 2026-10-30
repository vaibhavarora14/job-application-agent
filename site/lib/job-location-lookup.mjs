// Directory location records for one job, by jobId.
//
// This file is what Node (tests, scripts) runs: it imports the whole
// data/job-locations.json. The Worker build replaces it (vite.config.ts,
// jobLocationShards) with a module that splits the records into small shards by
// jobId and imports only the requested shard, so a cold /jobs/<slug> render does not
// evaluate the ~700 KB file. Both versions return the same record for every jobId.
import locations from '../data/job-locations.json' with { type: 'json' };
import { locationRecordsByJobId } from './job-locations.mjs';

/**
 * @param {string} jobId
 * @returns {Promise<object | undefined>}
 */
export async function locationRecordFor(jobId) {
  return locationRecordsByJobId(locations).get(jobId);
}

/** The whole index (closed-role pages score similar open roles across all of it). */
export async function allJobLocations() {
  return locations;
}
