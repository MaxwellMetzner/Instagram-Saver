export class InstagramResolverError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "InstagramResolverError";
    this.code = code;
    this.context = context;
  }
}

export function toErrorDetails(err) {
  if (!err) {
    return { message: "Unknown error" };
  }

  if (err instanceof InstagramResolverError) {
    return {
      message: err.message,
      code: err.code,
      context: err.context
    };
  }

  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack
    };
  }

  return {
    message: String(err)
  };
}

export function describeHttpFailure(status) {
  if (status === 401 || status === 403) {
    return "Instagram requires a logged-in session or denied access to this content.";
  }

  if (status === 404) {
    return "Instagram did not return this content. It may be unavailable or deleted.";
  }

  if (status === 429) {
    return "Instagram rate-limited the request. Wait a bit and try again.";
  }

  return `Instagram request failed with HTTP ${status}.`;
}

export function isRateLimitError(err) {
  const details = toErrorDetails(err);
  return details.code === "http_429" || Number(details.context?.status || 0) === 429;
}

export function getErrorPresentation(err) {
  const details = toErrorDetails(err);
  const code = details.code || "unknown";
  const defaults = {
    title: "Download failed",
    suggestion: "Try again, or reload the page if Instagram just changed state."
  };

  const presentationByCode = {
    unsupported_url: {
      title: "Unsupported page",
      suggestion: "Open an Instagram post, reel, story, highlight, profile, or saved-posts page first."
    },
    invalid_shortcode: {
      title: "Missing post identifier",
      suggestion: "Reload the page and make sure the URL points to a single post or reel."
    },
    user_lookup_failed: {
      title: "Story user lookup failed",
      suggestion: "Make sure the story owner still exists and is visible in your current session."
    },
    story_unavailable: {
      title: "Story unavailable",
      suggestion: "The story may have expired, been hidden, or require an account with access."
    },
    story_load_failed: {
      title: "Couldn't load the full story",
      suggestion: "Wait for the story viewer to finish loading, then press Refresh. If this continues, reload Instagram and check that you are still signed in."
    },
    story_not_found: {
      title: "Story item missing",
      suggestion: "The specific story frame may no longer be available."
    },
    post_unavailable: {
      title: "Post unavailable",
      suggestion: "Make sure the post is visible while logged in with this browser profile."
    },
    profile_unavailable: {
      title: "Profile unavailable",
      suggestion: "Make sure the profile exists and is visible in your current Instagram session."
    },
    profile_empty: {
      title: "No profile posts returned",
      suggestion: "Instagram returned the profile, but not any posts from the current page."
    },
    profile_posts_unavailable: {
      title: "Profile posts could not be resolved",
      suggestion: "The profile loaded, but the recent posts could not be converted into downloadable media."
    },
    profile_filter_empty: {
      title: "Media filter matched nothing",
      suggestion: "Change \"Include\" under Bulk & profile downloads in settings, or open a different profile."
    },
    saved_posts_empty: {
      title: "No saved posts returned",
      suggestion: "Make sure the saved page is available to your logged-in account."
    },
    saved_posts_unavailable: {
      title: "Saved posts could not be resolved",
      suggestion: "The saved page loaded, but its posts could not be converted into downloadable media."
    },
    no_media: {
      title: "No downloadable media found",
      suggestion: "Instagram returned metadata, but not a direct media URL for this page."
    },
    timeout: {
      title: "Instagram timed out",
      suggestion: "Wait a few seconds and try again."
    },
    download_failed: {
      title: "Browser download failed",
      suggestion: "Check your browser download settings or filesystem permissions."
    },
    content_script_unavailable: {
      title: "Page UI unavailable",
      suggestion: "Reload the Instagram tab and try again."
    },
    current_item_unknown: {
      title: "Couldn't find the item on screen",
      suggestion: "Pause on the story frame you want (hold it or click pause), then try again — or download everything instead."
    },
    bulk_download_running: {
      title: "Bulk download in progress",
      suggestion: "Pause the bulk download first, then choose Start over."
    },
    http_401: {
      title: "Login required",
      suggestion: "Open Instagram in this browser and confirm you are logged in."
    },
    http_403: {
      title: "Access denied",
      suggestion: "Instagram denied access to this content for the current session."
    },
    http_404: {
      title: "Content not found",
      suggestion: "The page may have been deleted or the URL may no longer be valid."
    },
    http_429: {
      title: "Rate limited",
      suggestion: "Wait a little before trying again. Instagram is throttling requests."
    }
  };

  const isInstagramServerError = Number(details.context?.status || 0) >= 500 &&
    Number(details.context?.status || 0) < 600;
  const resolved = presentationByCode[code] || (isInstagramServerError
    ? {
      title: "Instagram server error",
      suggestion: "Instagram returned a temporary server error. Wait a few minutes before trying again."
    }
    : defaults);
  return {
    code,
    title: resolved.title,
    message: details.message || defaults.title,
    suggestion: resolved.suggestion,
    context: details.context || null,
    diagnostics: Array.isArray(details.context?.diagnostics) ? details.context.diagnostics : []
  };
}
