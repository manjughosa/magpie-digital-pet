// 带路页：把 magpie 页面框架导航到插件的本地服务。
// 页面 CSP 是 connect-src 'none'，唯一能做的联网动作就是跳转自己，
// 所以这里不能探测服务在不在，直接盲跳固定端口（page-chat 同款做法）。
(async () => {
  const DEFAULT_PORT = 3571;
  let port = DEFAULT_PORT;

  try {
    const o = await window.magpie?.options?.get?.();
    if (o && Number.isFinite(Number(o.port)) && Number(o.port) > 0) port = Number(o.port);
  } catch { /* 没有 options 就用默认端口 */ }

  const q = new URLSearchParams();
  try {
    const t = await window.magpie?.ready; // { dark, lang, tokens }
    if (t && typeof t.dark === "boolean") q.set("theme", t.dark ? "dark" : "light");
    if (t && typeof t.lang === "string") q.set("lang", t.lang);
  } catch { /* 没有 bridge 就不带参数 */ }

  location.replace("http://127.0.0.1:" + port + "/?" + q.toString());
})();
