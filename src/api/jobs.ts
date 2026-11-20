import { withSuffix } from "../ids.js";
import { remainingMs, type ApiClient, type ApiResponse, type CallCtx } from "./client.js";
import { abortableSleep, parseRetryAfter } from "./retry.js";
import { mapProblem, mcpError, ToolFailure, type Mode } from "../errors.js";

export const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const jobPath = (id: string) => `/v1/jobs/${id}`;

/** Hint for a job with an API output that is still running when this call has to stop waiting. */
export const getJobHint = (id: string) => `Check it later with get_job {jobId:"${id}"}. Don't resubmit: the job keeps running and writes its output.`;

/** Hint when a conversion without an API output missed this call's wait: its result is gone. */
export const NOT_KEPT_HINT =
  "Convert again with an API `output`, or ask the user to raise SUBTITLE_MCP_TIMEOUT_MS together with the client's tool timeout. Without an API `output`, a result (including `outputPath` and `outputDir`) is kept only when the conversion finishes within the call.";

export const jobNotReady = (id: string) =>
  mcpError("job-not-ready", `Stopped waiting for job ${id} at the end of this call's time limit. The job may still be running.`, getJobHint(id), { jobId: id, jobUrl: jobPath(id) });

export interface PollOptions { mode: Mode; includeDebug: boolean; headerRequestId?: string }

/**
 * Polls GET /v1/jobs/{id} (this API's exact job path, built here; never a Location header) until the job is no longer
 * running or the call's deadline (ctx.deadline) would pass. Honours Retry-After between polls. A failed job throws its mapped problem, a gone
 * record job-not-found. Returns the last record; `running` when the deadline came first. Writes nothing, replays nothing.
 */
export async function pollJob(api: ApiClient, id: string, ctx: CallCtx, o: PollOptions & { firstWaitMs?: number; wait: boolean }): Promise<{ job: any; response: ApiResponse; running: boolean }> {
  const location = jobPath(id);
  let polls = 0, waitMs = o.firstWaitMs;
  for (;;) {
    if (waitMs !== undefined) {
      // Not enough time left for the wait and one more request: stop and report the job as still running.
      if (waitMs + 1000 > remainingMs(ctx)) return { job: undefined, response: undefined as any, running: true };
      await ctx.onProgress?.(`Job ${id}: waiting for completion`);
      try { await abortableSleep(waitMs, ctx.signal); }
      catch { throw mcpError("cancelled", "Stopped waiting because the caller cancelled; the API job may still be running.", getJobHint(id), { jobId: id, jobUrl: location }); }
    }
    const response = await api.request({ method: "GET", path: location, kind: "metadata", passStatuses: [404] }, { ...ctx, requestId: withSuffix(ctx.requestId, `.p${++polls}`) });
    if (response.status === 404)
      throw mcpError("job-not-found", `Job ${id} is no longer retained.`, "The API restarted, or the record expired or was evicted; a missing record is not a failed conversion. If the call had an API output, check that location with list_files / preview_text {location}. Don't resubmit blindly.", { jobId: id, jobUrl: location });
    const job: any = response.json;
    if (job?.id !== id) throw mcpError("api-protocol-error", "The job response id does not match the requested job.", undefined, { jobId: id });
    if (job.status === "failed") {
      const status = typeof job.error?.status === "number" ? job.error.status : 500;
      throw new ToolFailure({ ...mapProblem(status, job.error, { mode: o.mode, includeDebug: o.includeDebug, endpoint: location, headerRequestId: o.headerRequestId ?? response.requestId }), jobId: id, jobUrl: location, jobStatus: "failed" });
    }
    if (job.status === "succeeded") {
      if (!job.result) throw mcpError("api-protocol-error", "The job response has no recognised terminal result.", undefined, { jobId: id });
      return { job, response, running: false };
    }
    if (job.status !== "running") throw mcpError("api-protocol-error", `Unknown job status '${String(job.status)}'.`, undefined, { jobId: id });
    if (!o.wait) return { job, response, running: true };
    waitMs = Math.max(100, (parseRetryAfter(response.headers.get("retry-after")) ?? 1) * 1000);
  }
}

/** After a 202 from a conversion POST: poll the job (never following the Location header) within the call's deadline. */
export async function finishConversion(api: ApiClient, initial: ApiResponse, ctx: CallCtx,
  options: PollOptions & {
    /** Quick conversion (no API output): the error to return when the job outlives this call, since its result can't be kept. */
    notKept?: () => ToolFailure;
  }): Promise<ApiResponse> {
  if (initial.status !== 202) return initial;
  const id = (initial.json as any)?.id ?? initial.headers.get("x-job-id");
  if (typeof id !== "string" || !JOB_ID.test(id))
    throw mcpError("api-protocol-error", "The accepted conversion has no valid job id.", "Report the requestId.");
  if (initial.headers.get("location") !== jobPath(id))
    throw mcpError("api-protocol-error", "The accepted conversion has an unexpected job Location.", "Report the requestId; no external Location was followed.", { jobId: id });
  const firstWaitMs = Math.max(100, (parseRetryAfter(initial.headers.get("retry-after")) ?? 1) * 1000);
  // Pipeline: job-not-ready with the jobId for get_job. Quick conversion: the result is gone, so a plain error.
  const expired = () => (options.notKept ? options.notKept() : jobNotReady(id));
  let r;
  try {
    r = await pollJob(api, id, ctx, { ...options, headerRequestId: initial.requestId, firstWaitMs, wait: true });
  } catch (e) {
    // A poll that ran into the deadline is the same situation as stopping between polls.
    if (e instanceof ToolFailure && e.toolError.code === "mcp-timeout" && remainingMs(ctx) <= 1000) throw expired();
    if (e instanceof ToolFailure && e.toolError.code === "cancelled" && options.notKept)
      throw mcpError("cancelled", "Stopped waiting because the caller cancelled.", "Without an API `output`, the result is not kept even if the API finishes the job.");
    throw e;
  }
  if (r.running) throw expired();
  if (r.job.result.metadataTruncated) throw mcpError("job-metadata-truncated", "Detailed job metadata exceeded the API's per-job budget.", "Use the requested sidecar for full diagnostics.", { jobId: id, jobUrl: jobPath(id) });
  return { ...r.response, json: { ...r.job.result, id }, requestId: initial.requestId ?? r.response.requestId };
}
