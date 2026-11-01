// magpie 网关中间件 · 空转的这一个
//
// magpie 只把 package.json 里 "magpie.middleware" 指到的文件当成网关中间件，
// 插件行才会挂「中间件」标签。宠物插件的正体是「页面 + 宿主进程」：watcher
// 读 magpie 的用量 API 喂引擎，3571 上跑页面服务，这些都不在网关里。
//
// 所以这里是明确的不改请求：钩子返回 undefined，magpie 按原样发出去。
// moejs 里没有 fetch、定时器、Node API，只能相对路径 import；别在这里加依赖。

export function onRequest() {
  // 一个字段都不动
  return undefined;
}
