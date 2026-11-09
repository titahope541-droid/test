(() => {
  const currentUrl = new URL(window.location.href);
  if (currentUrl.pathname === "/.netlify/functions/server") {
    const routedPath = currentUrl.searchParams.get("__route");
    if (routedPath === "/articles" || /^\/articles\/[a-z0-9-]+$/i.test(routedPath || "")) {
      currentUrl.searchParams.delete("__route");
      window.history.replaceState({}, "", routedPath + currentUrl.search + currentUrl.hash);
    }
  }

  function getArticleRoute(href) {
    let url;
    try {
      url = new URL(href, window.location.href);
    } catch (error) {
      return null;
    }

    if (url.origin !== window.location.origin) return null;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/articles.html" || path === "/article.html") {
      return { path: "/articles", search: url.search, hash: url.hash };
    }
    if (path === "/articles" || /^\/articles\/[a-z0-9-]+$/i.test(path)) {
      return { path, search: url.search, hash: url.hash };
    }
    return null;
  }

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest("a[href]");
    if (!anchor || (anchor.target && anchor.target !== "_self" && anchor.target !== "_blank") || anchor.hasAttribute("download")) return;
    const route = getArticleRoute(anchor.href);
    if (!route) return;

    event.preventDefault();
    const target = new URL("/.netlify/functions/server", window.location.origin);
    target.searchParams.set("__route", route.path);
    new URLSearchParams(route.search).forEach((value, key) => {
      target.searchParams.append(key, value);
    });
    target.hash = route.hash;
    if (anchor.target === "_blank") {
      window.open(target.toString(), "_blank", "noopener,noreferrer");
    } else {
      window.location.assign(target.toString());
    }
  });
})();
