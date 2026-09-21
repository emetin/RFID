import { randomUUID } from "node:crypto";

async function customerRequest({ apiUrl, token, path, body, idempotencyKey, fetchImpl }) {
  const response = await fetchImpl(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify(body)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || value.error || `HTTP ${response.status}`);
  return value;
}

export async function runEncodingCycle({
  apiUrl,
  token,
  stationId,
  writer,
  leaseSeconds = 120,
  fetchImpl = fetch,
  operationId = randomUUID()
}) {
  if (!writer?.writeAndVerify) throw new Error("writer.writeAndVerify is required");
  const claimed = await customerRequest({
    apiUrl, token, fetchImpl,
    path: "/v1/customer/encoding/jobs/claim",
    idempotencyKey: `${operationId}:claim`,
    body: { stationId, leaseSeconds }
  });
  if (!claimed.job) return { status: "idle" };
  const job = claimed.job;
  let finish;
  try {
    const verification = await writer.writeAndVerify({
      epc: job.epc,
      jobId: job.jobId,
      batchId: job.batchId
    });
    finish = {
      jobId: job.jobId,
      stationId,
      leaseToken: job.leaseToken,
      observedEpc: verification.observedEpc,
      previousEpc: verification.previousEpc ?? null,
      tid: verification.tid ?? null
    };
  } catch (error) {
    finish = {
      jobId: job.jobId,
      stationId,
      leaseToken: job.leaseToken,
      errorCode: error.code ?? "writer_error",
      errorMessage: String(error.message ?? error)
    };
  }
  const result = await customerRequest({
    apiUrl, token, fetchImpl,
    path: "/v1/customer/encoding/jobs/finish",
    idempotencyKey: `${operationId}:finish:${job.jobId}`,
    body: finish
  });
  return { status: result.verified ? "verified" : "failed", job, result };
}

export async function runEncodingWorker({ maxJobs = Infinity, onResult, ...options }) {
  const results = [];
  while (results.length < maxJobs) {
    const result = await runEncodingCycle(options);
    if (result.status === "idle") break;
    results.push(result);
    await onResult?.(result);
  }
  return {
    processed: results.length,
    verified: results.filter((item) => item.status === "verified").length,
    failed: results.filter((item) => item.status === "failed").length,
    results
  };
}
