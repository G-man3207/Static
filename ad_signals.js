// Static - shared observe-only ad signal constants and correlated scoring.
(() => {
  const CONFIDENCE = Object.freeze({
    HIGH: "high",
    LEARNING: "learning",
    LIKELY: "likely",
    LOW: "low",
  });

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

  const GROUPS = Object.freeze({
    adApi: Object.freeze([
      REASONS.AMAZON_TAM_AUCTION,
      REASONS.GPT_SLOT,
      REASONS.OMID_MEASUREMENT,
      REASONS.PREBID_AUCTION,
      REASONS.VIDEO_AD,
    ]),
    delivery: Object.freeze([REASONS.IMPRESSION_BEACON, REASONS.VIEWABILITY_PING]),
    render: Object.freeze([REASONS.AD_IFRAME_SIZE, REASONS.STICKY_AD]),
    weakDom: Object.freeze([REASONS.SPONSORED_DOM]),
  });

  const WEIGHTS = Object.freeze({
    [REASONS.AD_IFRAME_SIZE]: 20,
    [REASONS.AMAZON_TAM_AUCTION]: 35,
    [REASONS.GPT_SLOT]: 35,
    [REASONS.IMPRESSION_BEACON]: 25,
    [REASONS.OMID_MEASUREMENT]: 30,
    [REASONS.PREBID_AUCTION]: 35,
    [REASONS.SPONSORED_DOM]: 8,
    [REASONS.STICKY_AD]: 18,
    [REASONS.VIDEO_AD]: 30,
    [REASONS.VIEWABILITY_PING]: 20,
  });

  const THRESHOLDS = Object.freeze({
    high: 80,
    likely: 50,
  });

  const SCORE_LIMITS = Object.freeze({
    partialCorrelation: THRESHOLDS.high - 1,
    singleSignal: THRESHOLDS.likely - 1,
    weakOnly: THRESHOLDS.likely - 1,
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

  const matchingReasons = (reasonCounts, reasons) =>
    reasons.filter((reason) => countFor(reasonCounts, reason) > 0);

  const uniqueReasonsFor = (reasonCounts) =>
    Object.keys(reasonCounts || {}).filter((reason) => countFor(reasonCounts, reason) > 0);

  const baseScoreForReasons = (reasonCounts = {}) => {
    let score = 0;
    for (const [reason, weight] of Object.entries(WEIGHTS)) {
      if (countFor(reasonCounts, reason) > 0) score += weight;
    }
    return Math.min(100, score);
  };

  const evidenceForReasons = (reasonCounts = {}) => {
    const adApi = matchingReasons(reasonCounts, GROUPS.adApi);
    const delivery = matchingReasons(reasonCounts, GROUPS.delivery);
    const render = matchingReasons(reasonCounts, GROUPS.render);
    const weakDom = matchingReasons(reasonCounts, GROUPS.weakDom);
    const reasonKinds = uniqueReasonsFor(reasonCounts);
    return {
      adApi,
      delivery,
      hasAny: reasonKinds.length > 0,
      reasonKinds,
      render,
      weakDom,
    };
  };

  const scoreTokensForEvidence = (evidence) => {
    const tokens = [];
    for (const groupName of ["adApi", "render", "delivery", "weakDom"]) {
      for (const reason of evidence[groupName]) tokens.push(`${groupName}:${reason}`);
    }
    return tokens;
  };

  const correlationForEvidence = (evidence) => {
    const hasAdApi = evidence.adApi.length > 0;
    const hasDelivery = evidence.delivery.length > 0;
    const hasRender = evidence.render.length > 0;
    const hasSponsoredDom = evidence.weakDom.includes(REASONS.SPONSORED_DOM);
    const hasViewability = evidence.delivery.includes(REASONS.VIEWABILITY_PING);

    return {
      full: hasAdApi && hasRender && hasDelivery,
      partial:
        (hasAdApi && (hasRender || hasDelivery)) ||
        (hasSponsoredDom && hasDelivery && (hasRender || hasViewability)),
    };
  };

  const cappedScoreFor = ({ correlation, evidence, score, scoreTokens }) => {
    let cappedScore = score;
    if (correlation.full) {
      cappedScore += 10;
      scoreTokens.push("correlation:ad_api+render+delivery");
    } else if (correlation.partial) {
      cappedScore += 5;
      scoreTokens.push("correlation:partial");
    }

    if (!correlation.full) {
      const cap = correlation.partial ? SCORE_LIMITS.partialCorrelation : SCORE_LIMITS.weakOnly;
      cappedScore = Math.min(cappedScore, cap);
      scoreTokens.push(correlation.partial ? "cap:partial_correlation" : "cap:weak_signals");
    }
    if (evidence.reasonKinds.length === 1) {
      cappedScore = Math.min(cappedScore, SCORE_LIMITS.singleSignal);
      scoreTokens.push("cap:single_signal");
    }
    return Math.max(0, Math.min(100, Math.round(cappedScore)));
  };

  const classifyReasons = (reasonCounts = {}) => {
    const evidence = evidenceForReasons(reasonCounts);
    if (!evidence.hasAny) {
      return Object.freeze({
        confidence: CONFIDENCE.LEARNING,
        score: 0,
        scoreReasons: Object.freeze([]),
      });
    }

    const correlation = correlationForEvidence(evidence);
    const scoreTokens = scoreTokensForEvidence(evidence);
    const score = cappedScoreFor({
      correlation,
      evidence,
      score: baseScoreForReasons(reasonCounts),
      scoreTokens,
    });
    let confidence = CONFIDENCE.LOW;
    if (correlation.full && score >= THRESHOLDS.high) {
      confidence = CONFIDENCE.HIGH;
    } else if (correlation.partial && score >= THRESHOLDS.likely) {
      confidence = CONFIDENCE.LIKELY;
    }

    return Object.freeze({
      confidence,
      score,
      scoreReasons: Object.freeze(scoreTokens.slice(0, 16)),
    });
  };

  const scoreForReasons = (reasonCounts = {}) => classifyReasons(reasonCounts).score;

  const confidenceForReasons = (reasonCounts = {}) => classifyReasons(reasonCounts).confidence;

  globalThis.__static_ad_signals__ = Object.freeze({
    caps: CAPS,
    classifyReasons,
    confidence: CONFIDENCE,
    confidenceForReasons,
    groups: GROUPS,
    scoreLimits: SCORE_LIMITS,
    reasons: REASONS,
    scoreForReasons,
    sizes: SIZES,
    thresholds: THRESHOLDS,
    weights: WEIGHTS,
  });
})();
