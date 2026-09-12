'use strict';
// 面板的 Service Worker：离线时回退到最近一次成功抓到的数据。
const CACHE = 'cls-dash-v2';
const SHELL = ['/', '/public/manifest.webmanifest', '/public/icon-192.png', '/public/icon-512.png'];
const API = /^\/api\/(rows|pools|status)/;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  let u;
  try { u = new URL(req.url); } catch (err) { return; }
  if (u.origin !== self.location.origin) return;

  // 数据接口：网络优先；失败（比如电脑睡了）回退缓存
  if (API.test(u.pathname)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          const cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || Response.error(); });
      })
    );
    return;
  }

  // 页面外壳：缓存优先，后台更新
  if (u.pathname === '/' || u.pathname.indexOf('/public/') === 0) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        const net = fetch(req).then(function (res) {
          if (res && res.ok) {
            const cp = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, cp); });
          }
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      })
    );
  }
});

