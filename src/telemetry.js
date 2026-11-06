import { randomUUID } from 'node:crypto';

// NOTE: minimal client for the Application Insights ingestion API instead of the
// `applicationinsights` SDK, which pulls the whole OpenTelemetry tree. No retry or
// offline queue: a failed batch is dropped. Switch to the SDK if loss starts to matter.
const settings = Object.fromEntries((process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || '')
  .split(';').filter(Boolean).map((part) => part.split(/=(.*)/s, 2)));
const endpoint = settings.InstrumentationKey && settings.IngestionEndpoint
  ? new URL('v2.1/track', settings.IngestionEndpoint.replace(/\/?$/, '/'))
  : null;
const FLUSH_MS = 15_000;
const MAX_BATCH = 500;
let queue = [];

const timer = endpoint ? setInterval(flush, FLUSH_MS) : null;
timer?.unref();

export const telemetryEnabled = Boolean(endpoint);

// Never pass room codes, tokens, names, file names, or message content.
export function trackEvent(name, measurements = {}, properties = {}, clientIp) {
  push('Event', clientIp, { baseType: 'EventData', baseData: { ver: 2, name, properties, measurements } });
}

export function trackRequest({ method, path, status, durationMs, clientIp }) {
  const name = `${method} ${path}`;
  push('Request', clientIp, {
    baseType: 'RequestData',
    baseData: {
      ver: 2,
      id: randomUUID(),
      name,
      url: path,
      duration: formatDuration(durationMs),
      responseCode: String(status),
      success: status < 500,
    },
  }, name);
}

export async function flush() {
  if (!endpoint || queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Telemetry must never affect a room.
  }
}

export function stopTelemetry() {
  clearInterval(timer);
  return flush();
}

function push(type, clientIp, data, operationName) {
  if (!endpoint || queue.length >= MAX_BATCH) return;
  const tags = { 'ai.cloud.role': 'qsnd' };
  // Ingestion derives country/city from this IP and stores it masked as 0.0.0.0.
  if (clientIp) tags['ai.location.ip'] = clientIp;
  if (operationName) tags['ai.operation.name'] = operationName;
  queue.push({
    name: `Microsoft.ApplicationInsights.${type}`,
    time: new Date().toISOString(),
    iKey: settings.InstrumentationKey,
    tags,
    data,
  });
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms));
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  const days = Math.floor(total / 86_400_000);
  return `${days}.${pad(Math.floor(total / 3_600_000) % 24)}:${pad(Math.floor(total / 60_000) % 60)}:`
    + `${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}`;
}
