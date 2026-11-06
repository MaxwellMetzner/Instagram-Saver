import {
  InstagramResolverError,
  describeHttpFailure,
  isRateLimitError,
  toErrorDetails
} from "../core/errors.js";
import { logInfo, logWarn } from "../core/logger.js";

export const INSTAGRAM_GRAPHQL_DOC_ID = "8845758582119845";

export const INSTAGRAM_WEB_API_BASE_URL = "https://www.instagram.com/api/v1";

export function getInstagramApiHeaders(refererUrl) {
  return {
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "359341",
    Origin: "https://www.instagram.com",
    Referer: refererUrl || "https://www.instagram.com/",
    Accept: "*/*"
  };
}

export function getRequestEndpoint(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || "");
  }
}

function summarizeResponseShape(body) {
  if (Array.isArray(body)) {
    return `array(${body.length})`;
  }

  if (!body || typeof body !== "object") {
    return typeof body;
  }

  return Object.keys(body).slice(0, 12).join(",") || "object";
}

export async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const requestLabel = options.requestLabel || null;

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      credentials: options.credentials || "include"
    });

    const contentType = response.headers.get("content-type") || "";
    const retryAfterValue = response.headers.get("retry-after") || "";
    const retryAfterSeconds = /^\d+$/.test(retryAfterValue.trim())
      ? Number(retryAfterValue.trim())
      : null;
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new InstagramResolverError(
        `http_${response.status}`,
        describeHttpFailure(response.status),
        {
          status: response.status,
          url,
          endpoint: getRequestEndpoint(url),
          requestLabel,
          durationMs: Date.now() - startedAt,
          responseShape: summarizeResponseShape(body),
          response: body,
          retryAfterSeconds
        }
      );
    }

    if (typeof body === "string") {
      throw new InstagramResolverError("invalid_response", "Instagram returned a non-JSON response.", {
        url,
        endpoint: getRequestEndpoint(url),
        requestLabel,
        durationMs: Date.now() - startedAt,
        response: body
      });
    }

    logInfo("instagram_request_succeeded", {
      requestLabel,
      endpoint: getRequestEndpoint(url),
      status: response.status,
      durationMs: Date.now() - startedAt,
      responseShape: summarizeResponseShape(body)
    });
    return body;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new InstagramResolverError("timeout", "Instagram request timed out.", {
        url,
        endpoint: getRequestEndpoint(url),
        requestLabel,
        timeoutMs,
        durationMs: Date.now() - startedAt
      });
    }

    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function ensureInstagramSession(tabUrl, pk) {
  if (!pk) return;

  try {
    await fetchJsonWithTimeout(
      `${INSTAGRAM_WEB_API_BASE_URL}/web/get_ruling_for_content/?content_type=MEDIA&target_id=${encodeURIComponent(pk)}`,
      {
        headers: getInstagramApiHeaders(tabUrl)
      },
      8000
    );
  } catch (err) {
    if (isRateLimitError(err)) {
      throw err;
    }

    logWarn("session_bootstrap_failed", {
      tabUrl,
      pk,
      error: toErrorDetails(err)
    });
  }
}

export async function fetchTextWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      credentials: options.credentials || "include"
    });

    const body = await response.text();
    if (!response.ok) {
      throw new InstagramResolverError(
        `http_${response.status}`,
        describeHttpFailure(response.status),
        {
          status: response.status,
          url,
          response: body
        }
      );
    }

    return body;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new InstagramResolverError("timeout", "Instagram request timed out.", { url, timeoutMs });
    }

    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
