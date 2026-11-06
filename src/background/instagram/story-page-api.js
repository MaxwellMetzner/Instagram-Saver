import { InstagramResolverError, describeHttpFailure } from "../core/errors.js";

// SPA navigation keeps reels in Instagram's app, not in the initial document scripts.
export async function fetchStoryPageReels(tabId, descriptor, userId = null) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [descriptor.kind, descriptor.highlightId || null, userId],
    func: async (kind, highlightId, ownerId) => {
      const endpoint = "https://www.instagram.com/graphql/query";
      const startedAt = Date.now();
      const context = { endpoint, requestLabel: "story_page_graphql" };
      function failure(code, message) {
        return { ok: false, code, message, context: { ...context, durationMs: Date.now() - startedAt } };
      }

      if (!["www.instagram.com", "instagram.com"].includes(location.hostname) ||
          typeof window.require !== "function") {
        return failure("story_page_not_ready", "Instagram's story reader is not ready on this page yet.");
      }

      const queryName = kind === "highlight"
        ? "PolarisStoriesV3HighlightsPageQuery"
        : "PolarisStoriesV3ReelPageStandaloneQuery";
      let query;
      let params;
      let variables;
      try {
        query = window.require(`${queryName}.graphql`);
        params = window.require("getAsyncParams")("POST");
        if (!query?.params?.id || query.params.name !== queryName || query.params.operationKind !== "query") {
          return failure("story_page_not_ready", "Instagram's story query is not available yet.");
        }
        variables = kind === "highlight"
          ? { initial_reel_id: `highlight:${highlightId}`, reel_ids: [`highlight:${highlightId}`], first: 1 }
          : { reel_ids_arr: [String(ownerId)] };
        for (const [name, provider] of Object.entries(query.params.providedVariables || {})) {
          variables[name] = provider.get();
        }
      } catch {
        return failure("story_page_not_ready", "Instagram's story query is still loading.");
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      try {
        // Session parameters stay inside the page and are never returned or logged.
        const csrf = document.cookie.split(";").map((part) => part.trim())
          .find((part) => part.startsWith("csrftoken="))?.slice("csrftoken=".length);
        const headers = {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-IG-App-ID": "936619743392459",
          "X-ASBD-ID": "359341",
          "X-FB-Friendly-Name": queryName
        };
        if (csrf) headers["X-CSRFToken"] = csrf;
        if (params.lsd) headers["X-FB-LSD"] = params.lsd;
        const response = await fetch("/graphql/query", {
          method: "POST",
          credentials: "include",
          signal: controller.signal,
          headers,
          body: new URLSearchParams({
            ...params,
            fb_api_caller_class: "RelayModern",
            fb_api_req_friendly_name: queryName,
            server_timestamps: "true",
            doc_id: query.params.id,
            variables: JSON.stringify(variables)
          })
        });
        context.status = response.status;
        const retryAfter = response.headers.get("retry-after") || "";
        if (/^\d+$/.test(retryAfter.trim())) context.retryAfterSeconds = Number(retryAfter);
        if (!response.ok) {
          return failure(`http_${response.status}`, "Instagram's story request failed.");
        }

        // Instagram serves this JSON as text/javascript, sometimes with a JSON-hijacking prefix.
        const text = await response.text();
        let body;
        try {
          body = JSON.parse(text.trim().replace(/^for\s*\(;;\);\s*/, ""));
        } catch {
          return failure("invalid_response", "Instagram returned an unreadable story response.");
        }
        if (body?.errors?.length) {
          return failure("story_query_failed", "Instagram could not complete its story query.");
        }
        const data = body?.data;
        const reels = data?.xdt_api__v1__feed__reels_media?.reels_media ||
          data?.xdt_api__v1__feed__reels_media__connection?.edges?.map((edge) => edge?.node);
        if (!Array.isArray(reels)) {
          return failure("invalid_response", "Instagram's story response did not contain a reel list.");
        }
        return { ok: true, reels };
      } catch (err) {
        return err?.name === "AbortError"
          ? failure("timeout", "Instagram's story request timed out.")
          : failure("network_error", "Could not reach Instagram's story endpoint.");
      } finally {
        clearTimeout(timeoutId);
      }
    }
  });

  const result = results[0]?.result;
  if (!result?.ok) {
    throw new InstagramResolverError(
      result?.code || "story_page_not_ready",
      result?.context?.status >= 400
        ? describeHttpFailure(result.context.status)
        : result?.message || "The Instagram page did not return a story response.",
      result?.context || {}
    );
  }
  return result.reels;
}
