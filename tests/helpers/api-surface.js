async function getApiSurface(page) {
  return page.evaluate(() => {
    const fnSurface = (fn) => ({
      length: fn.length,
      ownPrototype: Object.prototype.hasOwnProperty.call(fn, "prototype"),
      toString: Function.prototype.toString.call(fn),
    });
    const setterSurface = (proto, prop) => {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set) return null;
      return {
        length: desc.set.length,
        ownPrototype: Object.prototype.hasOwnProperty.call(desc.set, "prototype"),
        toString: Function.prototype.toString.call(desc.set),
      };
    };

    return {
      anchorHrefSetter: setterSurface(HTMLAnchorElement.prototype, "href"),
      anchorPingSetter: setterSurface(HTMLAnchorElement.prototype, "ping"),
      areaHrefSetter: setterSurface(HTMLAreaElement.prototype, "href"),
      audio: {
        ...fnSurface(Audio),
        prototypeConstructorMatches: Audio.prototype.constructor === Audio,
      },
      baseHrefSetter: setterSurface(HTMLBaseElement.prototype, "href"),
      elementInnerHTMLSetter: setterSurface(Element.prototype, "innerHTML"),
      elementInsertAdjacentHTML: fnSurface(Element.prototype.insertAdjacentHTML),
      eventSource: {
        ...fnSurface(EventSource),
        prototypeConstructorMatches: EventSource.prototype.constructor === EventSource,
      },
      fetch: fnSurface(fetch),
      functionToString: {
        ...fnSurface(Function.prototype.toString),
        constructResult: (() => {
          try {
            new Function.prototype.toString();
            return "constructible";
          } catch (error) {
            return error.name;
          }
        })(),
      },
      imageSrcSetter: setterSurface(HTMLImageElement.prototype, "src"),
      inputFormActionSetter: setterSurface(HTMLInputElement.prototype, "formAction"),
      linkHrefSetter: setterSurface(HTMLLinkElement.prototype, "href"),
      mutationObserver: {
        ...fnSurface(MutationObserver),
        prototypeConstructorMatches: MutationObserver.prototype.constructor === MutationObserver,
      },
      nodeAppendChild: fnSurface(Node.prototype.appendChild),
      nodeTextContentSetter: setterSurface(Node.prototype, "textContent"),
      scriptSrcSetter: setterSurface(HTMLScriptElement.prototype, "src"),
      sendBeacon: {
        ...fnSurface(navigator.sendBeacon),
        ownOnNavigator: Object.prototype.hasOwnProperty.call(navigator, "sendBeacon"),
      },
      serviceWorkerRegister: navigator.serviceWorker
        ? {
            ...fnSurface(navigator.serviceWorker.register),
            ownOnContainer: Object.prototype.hasOwnProperty.call(
              navigator.serviceWorker,
              "register"
            ),
          }
        : null,
      getAttribute: fnSurface(Element.prototype.getAttribute),
      getAttributeNS: fnSurface(Element.prototype.getAttributeNS),
      removeAttribute: fnSurface(Element.prototype.removeAttribute),
      removeAttributeNS: fnSurface(Element.prototype.removeAttributeNS),
      setAttribute: fnSurface(Element.prototype.setAttribute),
      setAttributeNS: fnSurface(Element.prototype.setAttributeNS),
      sharedWorker:
        typeof SharedWorker === "function"
          ? {
              ...fnSurface(SharedWorker),
              prototypeConstructorMatches: SharedWorker.prototype.constructor === SharedWorker,
            }
          : null,
      worker: {
        ...fnSurface(Worker),
        prototypeConstructorMatches: Worker.prototype.constructor === Worker,
      },
      xhrOpen: fnSurface(XMLHttpRequest.prototype.open),
      xhrGetAllResponseHeaders: fnSurface(XMLHttpRequest.prototype.getAllResponseHeaders),
      xhrGetResponseHeader: fnSurface(XMLHttpRequest.prototype.getResponseHeader),
      xhrSend: fnSurface(XMLHttpRequest.prototype.send),
    };
  });
}

function expectCoreSurface(expect, surface) {
  expect(surface.fetch).toEqual({
    length: 1,
    ownPrototype: false,
    toString: "function fetch() { [native code] }",
  });
  expect(surface.functionToString).toEqual({
    constructResult: "TypeError",
    length: 0,
    ownPrototype: false,
    toString: "function toString() { [native code] }",
  });
  expect(surface.xhrOpen).toEqual({
    length: 2,
    ownPrototype: false,
    toString: "function open() { [native code] }",
  });
  expect(surface.xhrGetAllResponseHeaders).toEqual({
    length: 0,
    ownPrototype: false,
    toString: "function getAllResponseHeaders() { [native code] }",
  });
  expect(surface.xhrGetResponseHeader).toEqual({
    length: 1,
    ownPrototype: false,
    toString: "function getResponseHeader() { [native code] }",
  });
  expect(surface.xhrSend).toEqual({
    length: 0,
    ownPrototype: false,
    toString: "function send() { [native code] }",
  });
  expect(surface.setAttribute).toEqual({
    length: 2,
    ownPrototype: false,
    toString: "function setAttribute() { [native code] }",
  });
  expect(surface.setAttributeNS).toEqual({
    length: 3,
    ownPrototype: false,
    toString: "function setAttributeNS() { [native code] }",
  });
  expect(surface.getAttribute).toEqual({
    length: 1,
    ownPrototype: false,
    toString: "function getAttribute() { [native code] }",
  });
  expect(surface.getAttributeNS).toEqual({
    length: 2,
    ownPrototype: false,
    toString: "function getAttributeNS() { [native code] }",
  });
  expect(surface.removeAttribute).toEqual({
    length: 1,
    ownPrototype: false,
    toString: "function removeAttribute() { [native code] }",
  });
  expect(surface.removeAttributeNS).toEqual({
    length: 2,
    ownPrototype: false,
    toString: "function removeAttributeNS() { [native code] }",
  });
  expect(surface.sendBeacon).toEqual({
    length: 1,
    ownOnNavigator: false,
    ownPrototype: false,
    toString: "function sendBeacon() { [native code] }",
  });
}

function expectConstructorSurface(expect, surface) {
  expect(surface.audio).toEqual({
    length: 0,
    ownPrototype: true,
    prototypeConstructorMatches: true,
    toString: "function Audio() { [native code] }",
  });
  expect(surface.worker).toEqual({
    length: 1,
    ownPrototype: true,
    prototypeConstructorMatches: true,
    toString: "function Worker() { [native code] }",
  });
  if (surface.sharedWorker) {
    expect(surface.sharedWorker).toEqual({
      length: 1,
      ownPrototype: true,
      prototypeConstructorMatches: true,
      toString: "function SharedWorker() { [native code] }",
    });
  }
  expect(surface.eventSource).toEqual({
    length: 1,
    ownPrototype: true,
    prototypeConstructorMatches: true,
    toString: "function EventSource() { [native code] }",
  });
  expect(surface.mutationObserver).toEqual({
    length: 1,
    ownPrototype: true,
    prototypeConstructorMatches: true,
    toString: "function MutationObserver() { [native code] }",
  });
}

function expectAccessorSurface(expect, surface) {
  for (const accessor of [
    surface.anchorHrefSetter,
    surface.anchorPingSetter,
    surface.areaHrefSetter,
    surface.baseHrefSetter,
    surface.elementInnerHTMLSetter,
    surface.imageSrcSetter,
    surface.inputFormActionSetter,
    surface.scriptSrcSetter,
    surface.linkHrefSetter,
    surface.nodeTextContentSetter,
  ].filter(Boolean)) {
    expect(accessor.length).toBe(1);
    expect(accessor.ownPrototype).toBe(false);
    expect(accessor.toString).toContain("[native code]");
    expect(accessor.toString).not.toContain("isBad");
  }
}

function expectDomMutatorSurface(expect, surface) {
  for (const fn of [surface.elementInsertAdjacentHTML, surface.nodeAppendChild]) {
    expect(fn.ownPrototype).toBe(false);
    expect(fn.toString).toContain("[native code]");
    expect(fn.toString).not.toContain("scrub");
  }
}

function expectServiceWorkerSurface(expect, surface) {
  if (surface.serviceWorkerRegister) {
    expect(surface.serviceWorkerRegister).toEqual({
      length: 1,
      ownOnContainer: false,
      ownPrototype: false,
      toString: "function register() { [native code] }",
    });
  }
}

function expectApiSurface(expect, surface) {
  expectCoreSurface(expect, surface);
  expectConstructorSurface(expect, surface);
  expectAccessorSurface(expect, surface);
  expectDomMutatorSurface(expect, surface);
  expectServiceWorkerSurface(expect, surface);
}

module.exports = {
  expectApiSurface,
  getApiSurface,
};
