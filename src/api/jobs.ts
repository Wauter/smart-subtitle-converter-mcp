import { withSuffix } from "../ids.js";
import type { ApiClient, ApiResponse, CallCtx } from "./client.js";
import { abortableSleep, parseRetryAfter } from "./retry.js";
import { mapProblem, mcpError, ToolFailure, type Mode } from "../errors.js";

/** Poll only this API's exact job path; never follow an arbitrary Location with bearer credentials. */
export async function finishConversion(api: ApiClient, initial: ApiResponse, ctx: CallCtx,
  options: { timeoutMs: number; mode: Mode; includeDebug: boolean }, started: number): Promise<ApiResponse> {
  if (initial.status !== 202) return initial;
  const id = (initial.json as any)?.id ?? initial.headers.get("x-job-id");
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw mcpError("api-protocol-error", "The accepted conversion has no valid job id.", "Report the requestId.");
  const location = `/v1/jobs/${id}`;
  if (initial.headers.get("location") !== location)
    throw mcpError("api-protocol-error", "The accepted conversion has an unexpected job Location.", "Report the requestId; no external Location was followed.", { jobId: id });
  const remaining = options.timeoutMs - (Date.now() - started);
  const timeout = () => mcpError("job-not-ready", `Stopped polling job ${id} after the tool's wait budget. The job may still be running.`, `Inspect ${location}; work may still finish and write output. Do not blindly resubmit writes.`, { jobId: id, jobUrl: location });
  if (remaining <= 0) throw timeout();
  const deadline = AbortSignal.timeout(remaining);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
  let response = initial, polls = 0;
  try {
    for (;;) {
      await ctx.onProgress?.(`Conversion job ${id}: waiting for completion`);
      const wait = Math.max(100, (parseRetryAfter(response.headers.get("retry-after")) ?? 1) * 1000);
      await abortableSleep(wait, signal);
      response = await api.request({ method: "GET", path: location, kind: "metadata", passStatuses: [404] }, { ...ctx, signal, requestId: withSuffix(ctx.requestId, `.p${++polls}`) });
      if (response.status === 404) throw mcpError("job-not-found", `Job ${id} is no longer retained.`, "The API may have restarted or evicted/expired the record. A missing record is not a failed conversion.", { jobId: id, jobUrl: location });
      const job: any = response.json;
      if (job?.id !== id) throw mcpError("api-protocol-error", "The job response id does not match the accepted conversion.", undefined, { jobId: id });
      if (job.status === "running") continue;
      if (job.status === "failed") {
        const status = typeof job.error?.status === "number" ? job.error.status : 500;
        throw new ToolFailure({ ...mapProblem(status, job.error, { mode: options.mode, includeDebug: options.includeDebug, endpoint: location, headerRequestId: initial.requestId }), jobId: id, jobUrl: location });
      }
      if (job.status !== "succeeded" || !job.result) throw mcpError("api-protocol-error", "The job response has no recognised terminal result.", undefined, { jobId: id });
      if (job.result.metadataTruncated) throw mcpError("job-metadata-truncated", "Detailed job metadata exceeded the API's per-job budget.", "Use the requested sidecar for full diagnostics.", { jobId: id, jobUrl: location });
      return { ...response, json: { ...job.result, id }, requestId: initial.requestId ?? response.requestId };
    }
  } catch (e) {
    if (deadline.aborted && !ctx.signal?.aborted) throw timeout();
    if (ctx.signal?.aborted) throw mcpError("cancelled", "Stopped polling because the caller cancelled; the API job may still be running.", `Inspect ${location}.`, { jobId: id, jobUrl: location });
    throw e;
  }
}
