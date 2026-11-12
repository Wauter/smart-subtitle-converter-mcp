import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Call, Deps } from "../context.js";
import { JOB_ID, pollJob } from "../api/jobs.js";
import { ToolFailure } from "../errors.js";
import { toInt } from "../api/coerce.js";
import { ConvertOutput, meta, parseApiOutput } from "./convert.js";
import { defineTool, mapDetected, mapWarnings, Warning } from "./common.js";

export const GetJobOutput = {
  jobId: z.string().describe("The job id"),
  status: z.enum(["running", "succeeded"]).describe("running, or succeeded (a failed job comes back as an error result with the conversion's error and error.jobStatus \"failed\")"),
  createdAt: z.string().optional().describe("When the API accepted the job"),
  finishedAt: z.string().optional().describe("When the job finished"),
  input: z.string().optional().describe("The job's API input location, if it had one (query and credentials removed)"),
  output: z.string().optional().describe("The job's API output location, if it had one (query and credentials removed)"),
  outputs: ConvertOutput.outputs.optional().describe("Succeeded: the outputs as convert_subtitle reports them (metadata only, no file content)"),
  detected: ConvertOutput.detected.optional(),
  stats: ConvertOutput.stats.optional(),
  warnings: z.array(Warning).describe("Succeeded: everything the conversion lost, changed or assumed; report these to the user"),
  metadataTruncated: z.boolean().optional().describe("true when the API kept only a summary because the detailed metadata was too large"),
  hint: z.string().describe("What to do next"),
  requestId: z.string().optional().describe("API request id, for support"),
  attempts: z.number().int().describe("Most tries any single API request needed"),
};

export function describeGetJob(): string {
  return "Check a conversion job by its `jobId` (from convert_subtitle or a job-not-ready error) and get its result metadata: status, outputs (with the API output location), detected format, stats and warnings. " +
    "`wait` (default true) polls until the job finishes or this call's time limit is reached; `wait: false` checks once. " +
    "It only reads: it never resubmits or writes files, and stopping it doesn't cancel the job. " +
    "The API keeps job metadata, not files: read a stored output with preview_text {jobId, which:\"output\"}; a job without an API `output` can't return its file, so convert again with one. " +
    "A failed job returns the conversion's error with `jobStatus:\"failed\"`; follow its hint and convert again. job-not-found means the record expired or the API restarted, not that the conversion failed.";
}

export function registerGetJobTool(server: McpServer, deps: Deps): void {
  defineTool(server, deps, {
    name: "get_job",
    warningArray: true,
    title: "Get conversion job",
    description: describeGetJob(),
    shape: {
      jobId: z.string().regex(JOB_ID).describe("Job id from convert_subtitle (`jobId`) or from a job-not-ready error (`error.jobId`)"),
      wait: z.boolean().default(true).describe("true (default): wait for the job to finish, up to this call's time limit; false: check once"),
    },
    output: GetJobOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (a: any, call) => getJob(deps, a, call),
  });
}

export async function getJob(deps: Deps, a: { jobId: string; wait?: boolean }, call: Call) {
  const id = a.jobId;
  let polled;
  try {
    polled = await pollJob(deps.api, id, call, { mode: deps.cfg.mode, includeDebug: deps.cfg.includeDebug, wait: a.wait !== false });
  } catch (e) {
    if (e instanceof ToolFailure && e.toolError.jobStatus === "failed")
      e.toolError.hint = `${e.toolError.hint ? e.toolError.hint + " " : ""}The job failed; calling get_job again returns the same error. Fix the input as described and convert again.`;
    throw e;
  }
  const { job, response, running } = polled;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const base: Record<string, unknown> = {
    jobId: id,
    ...(str(job?.createdAt) ? { createdAt: job.createdAt } : {}),
    ...(str(job?.finishedAt) ? { finishedAt: job.finishedAt } : {}),
    ...(str(job?.input) ? { input: job.input } : {}),
    ...(str(job?.output) ? { output: job.output } : {}),
  };
  const tail = { ...(response?.requestId ? { requestId: response.requestId } : {}), attempts: call.stats.attempts };
  if (running) {
    return { structured: { ...base, status: "running", warnings: [], hint: `Still running. Call get_job {jobId:"${id}"} again later. Don't resubmit the conversion: the job keeps running and may still write its output.`, ...tail }, blocks: [] };
  }
  const r: any = job.result;
  const outputs = Array.isArray(r.outputs) ? r.outputs.map((o: any) => meta(parseApiOutput(o))) : undefined;
  const stored = !!base.output || outputs?.some((o: any) => o.output);
  let hint = "Report the warnings to the user. ";
  if (stored && job.outputReplayable === false) hint += "The output went to a presigned HTTPS location, which can't be read back through the API.";
  else if (stored) hint += `Read the converted text with preview_text {jobId:"${id}", which:"output"}.`;
  else hint += "This job had no output location, so the API kept only this metadata, not the converted file, and the file can't be recovered. Convert again with an API `output` location, which is kept even when a job outlives the call (outputPath/outputDir only help when the conversion finishes within the call).";
  if (r.metadataTruncated) hint = "The detailed metadata was too large for the API's per-job limit, so only a summary is kept. " + hint;
  const stats = r.stats ? Object.fromEntries(Object.entries({ paragraphsIn: toInt(r.stats.paragraphsIn), paragraphsOut: toInt(r.stats.paragraphsOut), elapsedMs: toInt(r.stats.elapsedMs), queueWaitMs: toInt(r.stats.queueWaitMs) }).filter(([, v]) => v !== undefined)) : undefined;
  return {
    structured: {
      ...base, status: "succeeded",
      ...(outputs ? { outputs } : {}),
      ...(r.detected ? { detected: mapDetected(r.detected) } : {}),
      ...(stats ? { stats } : {}),
      warnings: mapWarnings(r.warnings),
      ...(r.metadataTruncated ? { metadataTruncated: true } : {}),
      hint, ...tail,
    },
    blocks: [],
  };
}
