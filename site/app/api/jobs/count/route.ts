import { loadJobsBoard } from "../../../../lib/load-jobs-board.mjs";
import { countMatchingJobs, parseBoardQuery } from "../../../../lib/jobs-board-query.mjs";

/** Match count for the /jobs filter sheet ("Show N roles"). Same rules as the page. */
export async function GET(request: Request) {
  const query = parseBoardQuery(new URL(request.url).searchParams);
  const board = await loadJobsBoard();
  if (board.failed) {
    return Response.json({ error: "jobs_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const count = countMatchingJobs(board.open, query, board.now ?? Date.now());
  return Response.json(
    { count },
    { headers: { "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=900" } },
  );
}
