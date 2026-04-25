// Static - shared observe-only ad signal constants and scoring.
(() => {
  const REASONS = Object.freeze({
    AD_IFRAME_SIZE: "ad_iframe.size",
    AMAZON_TAM_AUCTION: "amazon_tam.auction",
    GPT_SLOT: "gpt.slot",
    IMPRESSION_BEACON: "impression_beacon",
    OMID_MEASUREMENT: "omid.measurement",
    PREBID_AUCTION: "prebid.auction",
    SPONSORED_DOM: "sponsored_dom",
    STICKY_AD: "sticky_ad",
    VIDEO_AD: "video_ad",
    VIEWABILITY_PING: "viewability_ping",
  });

  const WEIGHTS = Object.freeze({
    [REASONS.AD_IFRAME_SIZE]: 2,
    [REASONS.AMAZON_TAM_AUCTION]: 5,
    [REASONS.GPT_SLOT]: 5,
    [REASONS.IMPRESSION_BEACON]: 4,
    [REASONS.OMID_MEASUREMENT]: 4,
    [REASONS.PREBID_AUCTION]: 5,
    [REASONS.SPONSORED_DOM]: 1,
    [REASONS.STICKY_AD]: 3,
    [REASONS.VIDEO_AD]: 4,
    [REASONS.VIEWABILITY_PING]: 3,
  });

  const THRESHOLDS = Object.freeze({
    high: 10,
    likely: 7,
  });

  const CAPS = Object.freeze({
    endpoints: 50,
    origins: 100,
    reasons: 50,
    sources: 50,
  });

  const SIZES = Object.freeze([
    Object.freeze([300, 250]),
    Object.freeze([728, 90]),
    Object.freeze([320, 50]),
    Object.freeze([160, 600]),
    Object.freeze([300, 600]),
    Object.freeze([970, 250]),
  ]);

  const countFor = (reasonCounts, reason) => {
    const count = reasonCounts && reasonCounts[reason];
    return typeof count === "number" && count > 0 ? count : 0;
  };

  const hasAny = (reasonCounts, reasons) =>
    reasons.some((reason) => countFor(reasonCounts, reason) > 0);

  const scoreForReasons = (reasonCounts = {}) => {
    let score = 0;
    for (const [reason, weight] of Object.entries(WEIGHTS)) {
      if (countFor(reasonCounts, reason) > 0) score += weight;
    }
    return Math.min(100, score);
  };

  const confidenceForReasons = (reasonCounts = {}) => {
    const score = scoreForReasons(reasonCounts);
    const hasStrongApi = hasAny(reasonCounts, [
      REASONS.GPT_SLOT,
      REASONS.PREBID_AUCTION,
      REASONS.AMAZON_TAM_AUCTION,
      REASONS.VIDEO_AD,
      REASONS.OMID_MEASUREMENT,
    ]);
    const hasRenderSignal = hasAny(reasonCounts, [REASONS.AD_IFRAME_SIZE, REASONS.STICKY_AD]);
    const hasDeliverySignal = hasAny(reasonCounts, [
      REASONS.IMPRESSION_BEACON,
      REASONS.VIEWABILITY_PING,
    ]);

    if (score >= THRESHOLDS.high && hasStrongApi && hasRenderSignal && hasDeliverySignal) {
      return "high";
    }
    if (
      score >= THRESHOLDS.likely &&
      ((hasStrongApi && (hasRenderSignal || hasDeliverySignal)) ||
        (hasRenderSignal && hasDeliverySignal))
    ) {
      return "likely";
    }
    return score > 0 ? "low" : "learning";
  };

  globalThis.__static_ad_signals__ = Object.freeze({
    caps: CAPS,
    confidenceForReasons,
    reasons: REASONS,
    scoreForReasons,
    sizes: SIZES,
    thresholds: THRESHOLDS,
    weights: WEIGHTS,
  });
})();
