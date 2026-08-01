// ==UserScript==
// @name         TestExample Cassia Response Mock
// @namespace    local.testexample.checkout
// @version      1.1.0
// @description  将 checkout_capabilities 响应改写为 cassia
// @match        *://claude.ai/*
// @match        *://*.claude.ai/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// ==/UserScript==

(function () {
  "use strict";

  const TARGET_HOST = "claude.ai";

  const TARGET_PATH =
    /^\/api\/organizations\/[^/]+\/subscription\/checkout_capabilities\/?$/;

  const MOCK_DATA = {
    checkout_flow: "cassia"
  };

  const MOCK_BODY = JSON.stringify(MOCK_DATA);
  const MOCK_LENGTH =
    new TextEncoder().encode(MOCK_BODY).byteLength;

  function getTargetUrl(input, method = "GET") {
    try {
      let rawUrl;

      if (typeof input === "string" || input instanceof URL) {
        rawUrl = String(input);
      } else if (input && typeof input.url === "string") {
        rawUrl = input.url;
      } else {
        return null;
      }

      const url = new URL(rawUrl, location.href);

      if (String(method).toUpperCase() !== "GET") {
        return null;
      }

      const hostMatched =
        url.hostname === TARGET_HOST ||
        url.hostname.endsWith("." + TARGET_HOST);

      if (!hostMatched) {
        return null;
      }

      if (!TARGET_PATH.test(url.pathname)) {
        return null;
      }

      return url;
    } catch (error) {
      console.error("[Cassia Mock] URL 解析失败：", error);
      return null;
    }
  }

  function createMockResponse(originalResponse) {
    const headers = new Headers(originalResponse.headers);

    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("etag");
    headers.delete("content-md5");

    headers.set(
      "content-type",
      "application/json; charset=utf-8"
    );
    headers.set("content-length", String(MOCK_LENGTH));
    headers.set("cache-control", "no-store");

    const response = new Response(MOCK_BODY, {
      status: 200,
      statusText: "OK",
      headers
    });

    try {
      Object.defineProperties(response, {
        url: {
          value: originalResponse.url,
          configurable: true
        },
        redirected: {
          value: originalResponse.redirected,
          configurable: true
        },
        type: {
          value: originalResponse.type,
          configurable: true
        }
      });
    } catch (_) {
    }

    return response;
  }

  const nativeFetch = window.fetch;

  window.fetch = async function (input, init) {
    const method =
      init?.method ||
      (input instanceof Request ? input.method : "GET");

    const targetUrl = getTargetUrl(input, method);

    const originalResponse =
      await nativeFetch.apply(this, arguments);

    if (!targetUrl) {
      return originalResponse;
    }

    console.warn(
      "[Cassia Mock] Fetch 响应已改写：",
      targetUrl.href,
      MOCK_DATA
    );

    return createMockResponse(originalResponse);
  };

  const XhrPrototype = XMLHttpRequest.prototype;
  const xhrInfo = new WeakMap();
  const loggedXhrs = new WeakSet();

  const nativeOpen = XhrPrototype.open;
  const nativeSend = XhrPrototype.send;
  const nativeGetResponseHeader =
    XhrPrototype.getResponseHeader;
  const nativeGetAllResponseHeaders =
    XhrPrototype.getAllResponseHeaders;

  XhrPrototype.open = function (method, url) {
    let absoluteUrl;

    try {
      absoluteUrl = new URL(
        String(url),
        location.href
      ).href;
    } catch (_) {
      absoluteUrl = String(url);
    }

    xhrInfo.set(this, {
      method: String(method || "GET").toUpperCase(),
      url: absoluteUrl
    });

    return nativeOpen.apply(this, arguments);
  };

  function getMatchedXhr(xhr) {
    const info = xhrInfo.get(xhr);

    if (
      !info ||
      xhr.readyState !== XMLHttpRequest.DONE
    ) {
      return null;
    }

    return getTargetUrl(info.url, info.method);
  }

  function replaceXhrGetter(propertyName, replacement) {
    const descriptor =
      Object.getOwnPropertyDescriptor(
        XhrPrototype,
        propertyName
      );

    if (
      !descriptor ||
      typeof descriptor.get !== "function" ||
      descriptor.configurable === false
    ) {
      console.warn(
        `[Cassia Mock] 无法接管 XHR.${propertyName}`
      );
      return;
    }

    const nativeGetter = descriptor.get;

    Object.defineProperty(XhrPrototype, propertyName, {
      ...descriptor,

      get: function () {
        if (!getMatchedXhr(this)) {
          return nativeGetter.call(this);
        }

        return replacement.call(this, nativeGetter);
      }
    });
  }

  replaceXhrGetter(
    "responseText",
    function (nativeGetter) {
      if (
        this.responseType !== "" &&
        this.responseType !== "text"
      ) {
        return nativeGetter.call(this);
      }

      return MOCK_BODY;
    }
  );

  replaceXhrGetter(
    "response",
    function (nativeGetter) {
      if (this.responseType === "json") {
        return {
          checkout_flow: "cassia"
        };
      }

      if (
        this.responseType === "" ||
        this.responseType === "text"
      ) {
        return MOCK_BODY;
      }

      return nativeGetter.call(this);
    }
  );

  replaceXhrGetter("status", function () {
    return 200;
  });

  replaceXhrGetter("statusText", function () {
    return "OK";
  });

  XhrPrototype.getResponseHeader = function (name) {
    if (!getMatchedXhr(this)) {
      return nativeGetResponseHeader.apply(
        this,
        arguments
      );
    }

    switch (String(name).toLowerCase()) {
      case "content-type":
        return "application/json; charset=utf-8";

      case "content-length":
        return String(MOCK_LENGTH);

      case "cache-control":
        return "no-store";

      case "content-encoding":
      case "etag":
      case "content-md5":
        return null;

      default:
        return nativeGetResponseHeader.apply(
          this,
          arguments
        );
    }
  };

  XhrPrototype.getAllResponseHeaders = function () {
    const originalHeaders =
      nativeGetAllResponseHeaders.apply(this, arguments);

    if (!getMatchedXhr(this)) {
      return originalHeaders;
    }

    const headers = String(originalHeaders || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .filter(function (line) {
        const name = line
          .split(":", 1)[0]
          .trim()
          .toLowerCase();

        return ![
          "content-type",
          "content-length",
          "content-encoding",
          "cache-control",
          "etag",
          "content-md5"
        ].includes(name);
      });

    headers.push(
      "content-type: application/json; charset=utf-8",
      `content-length: ${MOCK_LENGTH}`,
      "cache-control: no-store"
    );

    return headers.join("\r\n") + "\r\n";
  };

  XhrPrototype.send = function () {
    this.addEventListener(
      "readystatechange",
      function () {
        const targetUrl = getMatchedXhr(this);

        if (targetUrl && !loggedXhrs.has(this)) {
          loggedXhrs.add(this);

          console.warn(
            "[Cassia Mock] XHR 响应已改写：",
            targetUrl.href,
            MOCK_DATA
          );
        }
      }
    );

    return nativeSend.apply(this, arguments);
  };

  function showStatusBadge() {
    if (!document.documentElement) {
      document.addEventListener(
        "DOMContentLoaded",
        showStatusBadge,
        { once: true }
      );
      return;
    }

    if (document.getElementById("cassia-mock-badge")) {
      return;
    }

    const badge = document.createElement("div");
    badge.id = "cassia-mock-badge";
    badge.textContent = "Cassia Mock ON";

    Object.assign(badge.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "2147483647",
      padding: "7px 11px",
      color: "#ffffff",
      background: "#167c3a",
      borderRadius: "6px",
      fontSize: "12px",
      fontFamily: "sans-serif",
      boxShadow: "0 2px 8px rgba(0,0,0,.3)"
    });

    document.documentElement.appendChild(badge);
  }

  window.__cassiaMockInstalled = true;

  console.info(
    "[Cassia Mock] 脚本已加载：",
    location.href
  );

  showStatusBadge();
})();
