async function getApiSurface(page) {
  return page.evaluate(() => {
    const fnSurface = (fn) => ({
      length: fn.length,
      ownPrototype: Object.prototype.hasOwnProperty.call(fn, "prototype"),
      toString: Function.prototype.toString.call(fn),
    });
    const setterSurface = (proto, prop) => {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      return {
        length: desc.set.length,
        ownPrototype: Object.prototype.hasOwnProperty.call(desc.set, "prototype"),
        toString: Function.prototype.toString.call(desc.set),
      };
    };

    return {
      eventSource: {
        ...fnSurface(EventSource),
        prototypeConstructorMatches: EventSource.prototype.constructor === EventSource,
      },
      fetch: fnSurface(fetch),
      imageSrcSetter: setterSurface(HTMLImageElement.prototype, "src"),
      linkHrefSetter: setterSurface(HTMLLinkElement.prototype, "href"),
      mutationObserver: {
        ...fnSurface(MutationObserver),
        prototypeConstructorMatches: MutationObserver.prototype.constructor === MutationObserver,
      },
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
      xhrSend: fnSurface(XMLHttpRequest.prototype.send),
    };
  });
}

function expectApiSurface(expect, surface) {
  expect(surface.fetch).toEqual({
    length: 1,
    ownPrototype: false,
    toString: "function fetch() { [native code] }",
  });
  expect(surface.xhrOpen).toEqual({
    length: 2,
    ownPrototype: false,
    toString: "function open() { [native code] }",
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
  expect(surface.sendBeacon).toEqual({
    length: 1,
    ownOnNavigator: false,
    ownPrototype: false,
    toString: "function sendBeacon() { [native code] }",
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
  for (const accessor of [
    surface.imageSrcSetter,
    surface.scriptSrcSetter,
    surface.linkHrefSetter,
  ]) {
    expect(accessor.length).toBe(1);
    expect(accessor.ownPrototype).toBe(false);
    expect(accessor.toString).toContain("[native code]");
    expect(accessor.toString).not.toContain("isBad");
  }
  if (surface.serviceWorkerRegister) {
    expect(surface.serviceWorkerRegister).toEqual({
      length: 1,
      ownOnContainer: false,
      ownPrototype: false,
      toString: "function register() { [native code] }",
    });
  }
}

module.exports = {
  expectApiSurface,
  getApiSurface,
};
