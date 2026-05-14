const FORBIDDEN_SOURCE_MARKERS = [
  "__static",
  "bridgePort",
  "canDecoyElement",
  "queuedProbeEvents",
  "rememberedOriginal",
  "shouldDecoy",
];

async function seedNoisePersona(extension, origin, id) {
  await extension.serviceWorker.evaluate(
    ({ pageOrigin, personaId }) =>
      chrome.storage.local.set({
        noise_enabled: true,
        probe_log: {
          [pageOrigin]: {
            idCounts: { [personaId]: 2 },
            lastUpdated: Date.now(),
          },
        },
        user_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    { pageOrigin: origin, personaId: id }
  );
}

async function probeNetwork(page, urls) {
  return page.evaluate(async ({ manifestUrl }) => {
    const response = await fetch(manifestUrl);
    const responseText = await response.clone().text();
    const manifest = await response.json();
    const head = await fetch(new Request(manifestUrl, { method: "HEAD" }));
    const xhr = await new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.addEventListener("loadend", () => {
        resolve({
          body: request.responseText,
          contentLength: request.getResponseHeader("content-length"),
          contentType: request.getResponseHeader("content-type"),
          ownGetHeader: Object.prototype.hasOwnProperty.call(request, "getResponseHeader"),
          responseURL: request.responseURL,
          status: request.status,
        });
      });
      request.open("GET", manifestUrl);
      request.send();
    });
    return {
      fetch: {
        contentLength: response.headers.get("content-length"),
        contentType: response.headers.get("content-type"),
        instance: response instanceof Response,
        manifest,
        ok: response.ok,
        prototype: Object.getPrototypeOf(response) === Response.prototype,
        responseText,
        status: response.status,
        type: response.type,
        url: response.url,
      },
      head: {
        body: await head.text(),
        contentLength: head.headers.get("content-length"),
        status: head.status,
        url: head.url,
      },
      xhr,
    };
  }, urls);
}

async function probePassiveElements(page, urls) {
  return page.evaluate(async ({ cssUrl, imageUrl, scriptUrl }) => {
    const waitForLoad = async (el, start) => {
      const eventPromise = new Promise((resolve) => {
        el.addEventListener("load", () => resolve("load"), { once: true });
        el.addEventListener("error", () => resolve("error"), { once: true });
        setTimeout(() => resolve("timeout"), 1000);
      });
      start();
      return eventPromise;
    };
    const cssRulesLength = (sheet) => {
      try {
        return sheet ? sheet.cssRules.length : null;
      } catch (error) {
        return error.name;
      }
    };
    const probeLink = async (rel, as, href) => {
      const link = document.createElement("link");
      link.rel = rel;
      if (as) link.as = as;
      const event = await waitForLoad(link, () => {
        link.href = href;
        document.head.appendChild(link);
      });
      return {
        attr: link.getAttribute("href"),
        event,
        href: link.href,
      };
    };

    const img = new Image();
    const imgEvent = await waitForLoad(img, () => {
      img.src = imageUrl;
      document.body.appendChild(img);
    });

    const script = document.createElement("script");
    const scriptEvent = await waitForLoad(script, () => {
      script.src = scriptUrl;
      document.head.appendChild(script);
    });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    const linkEvent = await waitForLoad(link, () => {
      link.href = cssUrl;
      document.head.appendChild(link);
    });

    return {
      image: {
        attr: img.getAttribute("src"),
        complete: img.complete,
        currentSrc: img.currentSrc,
        event: imgEvent,
        naturalHeight: img.naturalHeight,
        naturalWidth: img.naturalWidth,
        src: img.src,
      },
      link: {
        attr: link.getAttribute("href"),
        cssRulesLength: cssRulesLength(link.sheet),
        event: linkEvent,
        href: link.href,
        sheetHref: link.sheet && link.sheet.href,
      },
      linkPreloadImage: await probeLink("preload", "image", imageUrl),
      linkPreloadScript: await probeLink("preload", "script", scriptUrl),
      modulePreloadScript: await probeLink("modulepreload", "", scriptUrl),
      script: {
        attr: script.getAttribute("src"),
        event: scriptEvent,
        src: script.src,
      },
    };
  }, urls);
}

async function probeAttributeElements(page, urls) {
  return page.evaluate(({ htmlUrl, imageUrl }) => {
    const attrImg = document.createElement("img");
    attrImg.setAttribute("src", imageUrl);

    const source = document.createElement("source");
    source.src = imageUrl;

    const embed = document.createElement("embed");
    embed.src = imageUrl;

    const object = document.createElement("object");
    object.data = htmlUrl;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "use");
    svg.setAttributeNS("http://www.w3.org/1999/xlink", "href", imageUrl);

    return {
      attrImage: {
        attr: attrImg.getAttribute("src"),
        src: attrImg.src,
      },
      embed: {
        attr: embed.getAttribute("src"),
        src: embed.src,
      },
      object: {
        attr: object.getAttribute("data"),
        data: object.data,
      },
      source: {
        attr: source.getAttribute("src"),
        src: source.src,
      },
      svgHref: svg.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
    };
  }, urls);
}

async function probeActiveSurfaces(page, urls) {
  return page.evaluate(async ({ eventsUrl, frameUrl, manifestUrl, workerUrl }) => {
    const ctorOutcome = (Ctor, url) => {
      if (typeof Ctor !== "function") return "unavailable";
      try {
        const instance = new Ctor(url);
        if (typeof instance.terminate === "function") instance.terminate();
        return "constructed";
      } catch (error) {
        return error.name;
      }
    };

    const frame = document.createElement("iframe");
    frame.src = frameUrl;
    const attrFrame = document.createElement("iframe");
    attrFrame.setAttribute("src", frameUrl);

    const source = new EventSource(eventsUrl, { withCredentials: true });
    let listenerErrors = 0;
    source.addEventListener("error", () => {
      listenerErrors++;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const eventSource = {
      finalReadyState: source.readyState,
      initialUrl: source.url,
      instance: source instanceof EventSource,
      listenerErrors,
      prototype: Object.getPrototypeOf(source) === EventSource.prototype,
      withCredentials: source.withCredentials,
    };
    source.close();

    const serviceWorker = navigator.serviceWorker
      ? await navigator.serviceWorker.register(workerUrl).then(
          () => "resolved",
          (error) => error.name
        )
      : "unavailable";

    let beacon;
    try {
      beacon = navigator.sendBeacon(manifestUrl, "");
    } catch (error) {
      beacon = error.name;
    }

    return {
      beacon,
      eventSource,
      frame: {
        attr: frame.getAttribute("src"),
        attrFrameSrc: attrFrame.getAttribute("src"),
        src: frame.src,
      },
      serviceWorker,
      sharedWorker: ctorOutcome(window.SharedWorker, workerUrl),
      worker: ctorOutcome(window.Worker, workerUrl),
    };
  }, urls);
}

async function probeSurface(page) {
  return page.evaluate(() => {
    const fnSurface = (fn) => ({
      length: fn.length,
      ownPrototype: Object.prototype.hasOwnProperty.call(fn, "prototype"),
      source: Function.prototype.toString.call(fn),
    });
    const accessorSource = (proto, prop, kind) => {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      const fn = desc && desc[kind];
      return fn ? fnSurface(fn) : null;
    };
    const styleSheetHref =
      typeof StyleSheet !== "undefined"
        ? accessorSource(StyleSheet.prototype, "href", "get")
        : null;
    const constructFunctionToString = () => {
      try {
        new Function.prototype.toString();
        return "constructible";
      } catch (error) {
        return error.name;
      }
    };

    return {
      eventSource: fnSurface(EventSource),
      fetch: fnSurface(fetch),
      functionToString: {
        ...fnSurface(Function.prototype.toString),
        constructResult: constructFunctionToString(),
      },
      attrValueGetter:
        typeof Attr !== "undefined" ? accessorSource(Attr.prototype, "value", "get") : null,
      elementOuterHTMLGetter: accessorSource(Element.prototype, "outerHTML", "get"),
      getAttribute: fnSurface(Element.prototype.getAttribute),
      iframeSrcSetter: accessorSource(HTMLIFrameElement.prototype, "src", "set"),
      imageCurrentSrcGetter: accessorSource(HTMLImageElement.prototype, "currentSrc", "get"),
      imageSrcSetter: accessorSource(HTMLImageElement.prototype, "src", "set"),
      linkHrefSetter: accessorSource(HTMLLinkElement.prototype, "href", "set"),
      nodeCloneNode: fnSurface(Node.prototype.cloneNode),
      scriptSrcSetter: accessorSource(HTMLScriptElement.prototype, "src", "set"),
      serviceWorkerRegister: navigator.serviceWorker
        ? fnSurface(navigator.serviceWorker.register)
        : null,
      setAttribute: fnSurface(Element.prototype.setAttribute),
      setAttributeNode: fnSurface(Element.prototype.setAttributeNode),
      setAttributeNS: fnSurface(Element.prototype.setAttributeNS),
      styleSheetHref,
      worker: fnSurface(Worker),
      xmlSerializeToString:
        typeof XMLSerializer !== "undefined"
          ? fnSurface(XMLSerializer.prototype.serializeToString)
          : null,
      xhrSend: fnSurface(XMLHttpRequest.prototype.send),
    };
  });
}

async function runAdversarialProbe(page, urls) {
  return {
    active: await probeActiveSurfaces(page, urls),
    attributes: await probeAttributeElements(page, urls),
    network: await probeNetwork(page, urls),
    passive: await probePassiveElements(page, urls),
    surface: await probeSurface(page),
  };
}

async function getProbeVectorCounts(extension, origin) {
  return extension.serviceWorker.evaluate(
    (pageOrigin) =>
      chrome.storage.local.get("probe_log").then(({ probe_log }) => {
        const entry = probe_log && probe_log[pageOrigin];
        const weeks = entry && entry.playbook && entry.playbook.weeks;
        const firstWeek = weeks && Object.values(weeks)[0];
        return (firstWeek && firstWeek.vectorCounts) || {};
      }),
    origin
  );
}

function checkNetwork(probe, urls) {
  const fetchBody = JSON.parse(probe.network.fetch.responseText);
  const xhrBody = JSON.parse(probe.network.xhr.body);
  const contentLengthAgrees =
    probe.network.fetch.contentLength === probe.network.xhr.contentLength &&
    probe.network.fetch.contentLength === probe.network.head.contentLength &&
    probe.network.fetch.contentLength === String(probe.network.fetch.responseText.length);
  return (
    probe.network.fetch.status === 200 &&
    probe.network.fetch.ok === true &&
    probe.network.fetch.instance === true &&
    probe.network.fetch.prototype === true &&
    probe.network.fetch.type === "basic" &&
    probe.network.fetch.url === urls.manifestUrl &&
    probe.network.head.body === "" &&
    probe.network.head.status === 200 &&
    probe.network.xhr.status === 200 &&
    probe.network.xhr.ownGetHeader === false &&
    probe.network.xhr.responseURL === urls.manifestUrl &&
    fetchBody.name === xhrBody.name &&
    contentLengthAgrees
  );
}

function checkPassive(probe, urls) {
  const checks = [
    probe.passive.image.attr === urls.imageUrl,
    probe.passive.image.currentSrc === urls.imageUrl,
    probe.passive.image.src === urls.imageUrl,
    probe.passive.link.attr === urls.cssUrl,
    probe.passive.link.href === urls.cssUrl,
    probe.passive.link.sheetHref === urls.cssUrl,
    probe.passive.script.attr === urls.scriptUrl,
    probe.passive.script.src === urls.scriptUrl,
    probe.passive.linkPreloadImage.attr === urls.imageUrl,
    probe.passive.linkPreloadImage.href === urls.imageUrl,
    probe.passive.linkPreloadImage.event === "load",
    probe.passive.linkPreloadScript.attr === urls.scriptUrl,
    probe.passive.linkPreloadScript.href === urls.scriptUrl,
    probe.passive.linkPreloadScript.event === "load",
    probe.passive.modulePreloadScript.attr === urls.scriptUrl,
    probe.passive.modulePreloadScript.href === urls.scriptUrl,
    probe.passive.modulePreloadScript.event === "load",
    probe.passive.image.event === "load",
    probe.passive.image.complete === true,
    probe.passive.image.naturalHeight === 1,
    probe.passive.image.naturalWidth === 1,
    probe.passive.link.event === "load",
    probe.passive.link.cssRulesLength === 0,
    probe.passive.script.event === "load",
  ];
  return checks.every(Boolean);
}

function checkAttributes(probe, urls) {
  const checks = [
    probe.attributes.attrImage.attr === urls.imageUrl,
    probe.attributes.attrImage.src === urls.imageUrl,
    probe.attributes.source.attr === urls.imageUrl,
    probe.attributes.source.src === urls.imageUrl,
    probe.attributes.embed.attr === urls.imageUrl,
    probe.attributes.embed.src === urls.imageUrl,
    probe.attributes.object.attr === urls.htmlUrl,
    probe.attributes.object.data === urls.htmlUrl,
    probe.attributes.svgHref === urls.imageUrl,
  ];
  return checks.every(Boolean);
}

function checkActive(probe) {
  const sharedWorkerOk =
    probe.active.sharedWorker === "unavailable" || probe.active.sharedWorker === "SecurityError";
  return (
    probe.active.beacon === "TypeError" &&
    probe.active.eventSource.finalReadyState === 2 &&
    probe.active.eventSource.instance === true &&
    probe.active.eventSource.listenerErrors === 1 &&
    probe.active.eventSource.prototype === true &&
    probe.active.eventSource.withCredentials === true &&
    probe.active.frame.attr === null &&
    probe.active.frame.attrFrameSrc === null &&
    probe.active.frame.src === "" &&
    probe.active.serviceWorker === "TypeError" &&
    sharedWorkerOk &&
    probe.active.worker === "SecurityError"
  );
}

function checkSurface(probe) {
  const surfaces = Object.values(probe.surface).filter(Boolean);
  const sources = surfaces.map((surface) => surface.source || "");
  const hasNativeSources = sources.every((source) => source.includes("[native code]"));
  const hasNoImplementationLeaks = sources.every((source) => {
    return !FORBIDDEN_SOURCE_MARKERS.some((marker) => source.includes(marker));
  });
  return (
    hasNativeSources &&
    hasNoImplementationLeaks &&
    probe.surface.functionToString.constructResult === "TypeError" &&
    probe.surface.functionToString.ownPrototype === false &&
    probe.surface.getAttribute.ownPrototype === false &&
    probe.surface.imageSrcSetter.ownPrototype === false &&
    probe.surface.linkHrefSetter.ownPrototype === false &&
    probe.surface.nodeCloneNode.ownPrototype === false &&
    probe.surface.scriptSrcSetter.ownPrototype === false &&
    probe.surface.setAttribute.ownPrototype === false &&
    probe.surface.setAttributeNode.ownPrototype === false &&
    probe.surface.setAttributeNS.ownPrototype === false &&
    probe.surface.xhrSend.ownPrototype === false
  );
}

function buildAdversarialReport(probe, urls) {
  const checks = {
    activeSurfacesFailClosed: checkActive(probe),
    apiSurfaceNativeLike: checkSurface(probe),
    attributeVectorsCoherent: checkAttributes(probe, urls),
    networkVectorsAgree: checkNetwork(probe, urls),
    passiveElementVectorsAgree: checkPassive(probe, urls),
  };
  const failed = Object.entries(checks)
    .filter((entry) => !entry[1])
    .map((entry) => entry[0]);
  return {
    checks,
    failed,
    passed: Object.keys(checks).length - failed.length,
    total: Object.keys(checks).length,
  };
}

module.exports = {
  buildAdversarialReport,
  getProbeVectorCounts,
  runAdversarialProbe,
  seedNoisePersona,
};
