import { toErrorDetails } from "./errors.js";

const LOG_PREFIX = "[InstagramSaver]";

export function logInfo(event, context = {}) {
  console.info(`${LOG_PREFIX} ${event}`, context);
}

export function logWarn(event, context = {}) {
  console.warn(`${LOG_PREFIX} ${event}`, context);
}

export function logError(event, err, context = {}) {
  try {
    console.error(`${LOG_PREFIX} ${event}`, {
      ...context,
      error: toErrorDetails(err)
    });
  } catch (loggingError) {
    console.error(`${LOG_PREFIX} ${event}`, {
      message: String(err?.message || err || "Unknown error"),
      loggingError: String(loggingError?.message || loggingError || "Logging failed")
    });
  }
}
